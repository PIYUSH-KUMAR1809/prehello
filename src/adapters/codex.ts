import path from "node:path";
import { Ctx } from "../context";
import { Item } from "../model";
import { evidenceFor, loadSpec } from "../spec";
import { isDir, isFile, onPath, isInside } from "../fs-safe";
import { loadInstruction, mcpItems } from "./common";
import { AdapterResult, Detection } from "./types";
import { parseCodexToml } from "../mcp/configs";
import { discoverSkills, skillItems, SkillRec } from "./skills";
import { realpathOrSelf } from "../fs-safe";

const AGENT = "codex" as const;
const ev = (doc: string) => evidenceFor(AGENT, doc);

function codexHome(ctx: Ctx): string {
  return ctx.opts.env.CODEX_HOME || path.join(ctx.home, ".codex");
}

export function detectCodex(ctx: Ctx): Detection {
  const by: string[] = [];
  if (isDir(codexHome(ctx))) by.push("config dir");
  if (onPath("codex", ctx.opts.env.PATH ?? ctx.opts.env.Path, { platform: ctx.opts.platform, pathExt: ctx.opts.env.PATHEXT })) by.push("binary on PATH");
  const repo: string[] = [];
  if (isFile(path.join(ctx.cwd, "AGENTS.md"))) repo.push(path.join(ctx.cwd, "AGENTS.md"));
  if (isFile(path.join(ctx.cwd, "AGENTS.override.md"))) repo.push(path.join(ctx.cwd, "AGENTS.override.md"));
  if (isDir(path.join(ctx.cwd, ".codex"))) repo.push(path.join(ctx.cwd, ".codex"));
  return { detectedBy: by, repoFiles: repo };
}

export function discoverCodex(ctx: Ctx): AdapterResult {
  const caps = loadSpec(AGENT).caps;
  const items: Item[] = [];
  const home = codexHome(ctx);
  const cfgPath = path.join(home, "config.toml");
  let cfg: Record<string, unknown> = {};
  let servers = [] as ReturnType<typeof parseCodexToml>["servers"];
  const cfgText = ctx.read(cfgPath, { maxBytes: 5 * 1024 * 1024 });
  if (cfgText.ok) {
    try {
      const p = parseCodexToml(cfgText.text, (m) => ctx.warn(m));
      cfg = p.config;
      servers = p.servers;
    } catch {
      ctx.warn(`${ctx.display(cfgPath)}: could not parse as TOML, skipped`);
    }
  }
  const maxBytes = typeof cfg.project_doc_max_bytes === "number" && cfg.project_doc_max_bytes >= 0 ? cfg.project_doc_max_bytes : caps.projectDocMaxBytesDefault;
  const fallbackNames = (Array.isArray(cfg.project_doc_fallback_filenames) ? cfg.project_doc_fallback_filenames : []).filter(
    (x): x is string => typeof x === "string" && x.length > 0 && !/[\\/]/.test(x) && x !== "." && x !== "..",
  );

  // Global: AGENTS.override.md else AGENTS.md (first non-empty)
  for (const name of ["AGENTS.override.md", "AGENTS.md"]) {
    const f = path.join(home, name);
    const it = loadInstruction(ctx, f, { agent: AGENT, scope: "user", loadMode: "always", label: `~/.codex/${name}`, cardLabel: "global AGENTS.md", stripComments: false, imports: false, confidence: "documented", evidence: ev("agentsMd") });
    if (it) {
      items.push(it);
      const shadowed = path.join(home, "AGENTS.md");
      if (name === "AGENTS.override.md" && isFile(shadowed)) ctx.exclude(AGENT, shadowed, "shadowed by AGENTS.override.md in the same directory (Codex reads only one)");
      break;
    }
  }

  // Project chain: git root (or cwd) -> cwd; one file per dir: override -> AGENTS.md -> fallbacks
  const root = ctx.gitRoot ?? ctx.cwd;
  const chain = ctx.ancestorDirs().filter((d) => isInside(d, root));
  let remaining = maxBytes;
  for (const dir of chain) {
    const names = ["AGENTS.override.md", "AGENTS.md", ...fallbackNames];
    for (const name of names) {
      const f = path.join(dir, name);
      if (!isFile(f)) continue;
      const jail = ctx.jailFor(dir);
      const probe = ctx.read(f, { jail });
      if (!probe.ok || !probe.text.trim()) continue;
      if (remaining <= 0) {
        ctx.exclude(AGENT, f, `beyond project_doc_max_bytes (${maxBytes} B): Codex stops reading AGENTS.md files here`);
        break;
      }
      const bytes = Buffer.byteLength(probe.text);
      const it = loadInstruction(ctx, f, {
        agent: AGENT,
        scope: dir === ctx.cwd ? "project" : "ancestor",
        loadMode: "always",
        label: ctx.display(f),
        cardLabel: name === "AGENTS.md" ? "AGENTS.md" : name,
        jail,
        stripComments: false,
        imports: false,
        confidence: "documented",
        evidence: ev("agentsMd"),
        transform: (raw) => {
          if (bytes <= remaining) return { text: raw };
          const t = Buffer.from(raw).subarray(0, remaining).toString("utf8");
          ctx.addFinding({ id: "F12", severity: "warn", agent: AGENT, message: `${ctx.display(f)} is truncated by Codex at project_doc_max_bytes (${maxBytes} B): only the first ${remaining} of ${bytes} bytes load`, paths: [f], confidence: "high", fix: "Shorten the AGENTS.md chain or raise project_doc_max_bytes in ~/.codex/config.toml." });
          return { text: t, notes: [`truncated at project_doc_max_bytes: ${remaining}/${bytes} bytes loaded`] };
        },
      });
      if (it) {
        items.push(it);
        remaining -= Math.min(bytes, remaining) + 2; // 2 bytes ~ separator between concatenated files
        for (const other of names.slice(names.indexOf(name) + 1)) {
          const of = path.join(dir, other);
          if (isFile(of)) ctx.exclude(AGENT, of, `shadowed by ${name} in the same directory (Codex reads at most one file per directory)`);
        }
      }
      break; // max one file per directory
    }
  }

  // nested AGENTS.md below cwd: Codex walks root -> cwd only
  for (const hit of ctx.walk().hits) {
    if (hit.names.includes("AGENTS.md")) ctx.exclude(AGENT, path.join(hit.dir, "AGENTS.md"), "below the launch directory (Codex reads AGENTS.md root→cwd only)");
  }

  // MCP: global config.toml; project .codex/config.toml (trusted projects; assumed)
  for (const def of servers) {
    if (def.disabled) continue;
    items.push(...mcpItems(ctx, { agent: AGENT, def, source: cfgPath, scope: "user", mode: "full", evidence: ev("mcp"), notes: ["Codex MCP schema loading modelled as upfront (unverified)"], index: items.length }));
  }
  const projCfg = path.join(ctx.cwd, ".codex", "config.toml");
  const pr = ctx.read(projCfg, { jail: ctx.jailFor(ctx.cwd) });
  if (pr.ok) {
    try {
      for (const def of parseCodexToml(pr.text, (m) => ctx.warn(m)).servers) {
        if (def.disabled) continue;
        items.push(...mcpItems(ctx, { agent: AGENT, def, source: projCfg, scope: "project", mode: "full", evidence: ev("mcp"), notes: ["project .codex/config.toml: only loaded for trusted projects (assumed)"], index: items.length }));
      }
    } catch {
      ctx.warn(`${ctx.display(projCfg)}: could not parse as TOML, skipped`);
    }
  }

  // Skills. Documented: Codex scans .agents/skills from the working directory up to the repo root, plus ~/.agents/skills and /etc/codex/skills.
  // The listing sent to the model is name + description + file path (documented); bodies load when a skill is used.
  const disabled = new Set<string>();
  const sc = (cfg.skills as { config?: unknown } | undefined)?.config;
  if (Array.isArray(sc)) {
    for (const e of sc) {
      const x = e as { path?: unknown; enabled?: unknown };
      if (x && typeof x.path === "string" && x.enabled === false) {
        const p = x.path.replace(/^~(?=[\\/]|$)/, ctx.home);
        disabled.add(realpathOrSelf(path.basename(p) === "SKILL.md" ? path.dirname(p) : p));
      }
    }
  }
  const seenSkill = new Set<string>();
  const codexLine = (r: SkillRec) => `- ${r.name}: ${r.desc} (file: ${r.file})`;
  const emit = (dir: string, scope: Item["scope"], tag: string, jail: string | undefined, confidence: "documented" | "assumed", note?: string) => {
    const recs = discoverSkills(ctx, dir, jail ? { jail } : {}).filter((r) => {
      if (seenSkill.has(r.realPath)) return false;
      seenSkill.add(r.realPath);
      if (disabled.has(realpathOrSelf(path.dirname(r.file)))) {
        ctx.exclude(AGENT, r.file, "disabled in config.toml ([[skills.config]] enabled = false)");
        return false;
      }
      return true;
    });
    if (!recs.length) return;
    const its = skillItems(ctx, { agent: AGENT, dir, scope, tag, recs, lineFor: codexLine, listingMode: "always", confidence, evidence: ev("skills"), notes: ["name + description + file path are listed up front (documented); the body loads when the skill is used", ...(note ? [note] : [])] });
    items.push(...its);
    const l = its.find((i) => i.kind === "skills-listing");
    const budget = 0.02 * ctx.opts.window;
    if (l?.tokens && l.tokens.est > budget) {
      ctx.addFinding({ id: "F13", severity: "info", agent: AGENT, message: `${tag} skills listing (~${l.tokens.est} tokens) exceeds ≈2% of a ${ctx.opts.window / 1000}k window (~${Math.round(budget)}); Codex shortens descriptions to fit its skills budget (documented), so actual cost is lower but descriptions are lost`, paths: [dir], confidence: "low", fix: "Remove skills you do not use, or disable them with [[skills.config]] enabled = false." });
    }
  };
  for (const dir of [...chain].reverse()) emit(path.join(dir, ".agents", "skills"), dir === ctx.cwd ? "project" : "ancestor", dir === ctx.cwd ? "project" : "ancestor", ctx.jailFor(dir), "documented");
  emit(path.join(ctx.home, ".agents", "skills"), "user", "user", undefined, "documented");
  emit(ctx.sys("/etc/codex/skills"), "managed", "admin (/etc/codex/skills)", undefined, "documented");
  emit(path.join(home, "skills"), "user", "legacy ~/.codex", undefined, "assumed", "~/.codex/skills is read by Cursor and was the older Codex location; current Codex docs list ~/.agents/skills, so whether Codex still loads it is unverified");
  return { items, unmeasuredBanner: ["built-in system prompt and tools", "Codex bundled system skills (~/.codex/skills/.system, hidden dirs are skipped)", "server-side / org instructions"] };
}
