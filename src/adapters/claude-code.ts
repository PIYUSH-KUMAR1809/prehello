import path from "node:path";
import { isWinAbsolute, makeGlobMatcher } from "../platform";
import { Ctx } from "../context";
import { Item } from "../model";
import { evidenceFor, loadSpec } from "../spec";
import { exists, isDir, isFile, isInside, onPath, realpathOrSelf } from "../fs-safe";
import { asList, asString, parseFrontmatter } from "../text/frontmatter";
import { loadInstruction, listFilesRec, mcpItems } from "./common";
import { discoverSkills, skillItems, SkillRec, toRec } from "./skills";
import { AdapterResult, Detection } from "./types";
import { parseMcpMap } from "../mcp/configs";
import { cmp } from "../util/fmt";

const AGENT = "claude-code" as const;
const ev = (doc: string) => evidenceFor(AGENT, doc);

function configDir(ctx: Ctx): string {
  return ctx.opts.env.CLAUDE_CONFIG_DIR || path.join(ctx.home, ".claude");
}
function userJsonPath(ctx: Ctx): string {
  return ctx.opts.env.CLAUDE_CONFIG_DIR ? path.join(ctx.opts.env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(ctx.home, ".claude.json");
}
function managedDir(ctx: Ctx): string {
  if (ctx.opts.managedDir) return ctx.opts.managedDir;
  if (ctx.opts.platform === "darwin") return ctx.sys("/Library/Application Support/ClaudeCode");
  if (ctx.opts.platform === "win32") return ctx.sys(path.win32.join(ctx.opts.env.ProgramFiles && isWinAbsolute(ctx.opts.env.ProgramFiles) ? ctx.opts.env.ProgramFiles : "C:\\Program Files", "ClaudeCode"));
  return ctx.sys("/etc/claude-code");
}

export function detectClaude(ctx: Ctx): Detection {
  const by: string[] = [];
  if (isDir(configDir(ctx))) by.push("config dir");
  if (isFile(userJsonPath(ctx))) by.push("~/.claude.json");
  if (onPath("claude", ctx.opts.env.PATH ?? ctx.opts.env.Path, { platform: ctx.opts.platform, pathExt: ctx.opts.env.PATHEXT })) by.push("binary on PATH");
  const repo: string[] = [];
  for (const d of ctx.ancestorDirs()) {
    for (const f of ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"]) if (isFile(path.join(d, f))) repo.push(path.join(d, f));
  }
  if (isDir(path.join(ctx.cwd, ".claude"))) repo.push(path.join(ctx.cwd, ".claude"));
  if (isFile(path.join(ctx.cwd, ".mcp.json"))) repo.push(path.join(ctx.cwd, ".mcp.json"));
  return { detectedBy: by, repoFiles: repo };
}

interface Settings {
  excludes: string[];
  disabledProjectMcp: string[];
  env: Record<string, string>;
  instructionFiles?: string;
  model?: string;
  autoMemoryDirectory?: string;
  skillOverrides: Record<string, string>;
  enabledPlugins: Record<string, boolean>;
  skillListingMaxDescChars?: number;
  skillListingBudgetFraction?: number;
}

function readSettings(ctx: Ctx): Settings {
  const s: Settings = { excludes: [], disabledProjectMcp: [], env: {}, skillOverrides: Object.create(null), enabledPlugins: Object.create(null) };
  const files = [path.join(configDir(ctx), "settings.json"), path.join(ctx.cwd, ".claude", "settings.json"), path.join(ctx.cwd, ".claude", "settings.local.json")];
  for (const f of files) {
    const j = ctx.readJson(f) as Record<string, unknown> | undefined;
    if (!j || typeof j !== "object") continue;
    if (Array.isArray(j.claudeMdExcludes)) s.excludes.push(...j.claudeMdExcludes.filter((x): x is string => typeof x === "string"));
    if (Array.isArray(j.disabledMcpjsonServers)) s.disabledProjectMcp.push(...j.disabledMcpjsonServers.filter((x): x is string => typeof x === "string"));
    if (j.env && typeof j.env === "object") for (const [k, v] of Object.entries(j.env as Record<string, unknown>)) if (typeof v === "string") s.env[k] = v;
    if (typeof j.model === "string") s.model = j.model;
    if (typeof j.autoMemoryDirectory === "string") s.autoMemoryDirectory = j.autoMemoryDirectory;
    if (j.skillOverrides && typeof j.skillOverrides === "object") for (const [k, v] of Object.entries(j.skillOverrides as Record<string, unknown>)) if (typeof v === "string") s.skillOverrides[k] = v;
    if (j.enabledPlugins && typeof j.enabledPlugins === "object" && !Array.isArray(j.enabledPlugins)) for (const [k, v] of Object.entries(j.enabledPlugins as Record<string, unknown>)) if (typeof v === "boolean") s.enabledPlugins[k] = v;
    if (typeof j.skillListingBudgetFraction === "number" && j.skillListingBudgetFraction > 0 && j.skillListingBudgetFraction <= 1) s.skillListingBudgetFraction = j.skillListingBudgetFraction;
    if (typeof j.skillListingMaxDescChars === "number" && j.skillListingMaxDescChars > 0) s.skillListingMaxDescChars = Math.floor(j.skillListingMaxDescChars);
    const pc = j.pluginConfigs as Record<string, { options?: { instructionFiles?: unknown } }> | undefined;
    const inst = pc?.["cc-plugin-agents-md@builtin"]?.options?.instructionFiles;
    if (typeof inst === "string") s.instructionFiles = inst;
  }
  return s;
}

interface ClaudePlugin {
  id: string;
  name: string;
  root: string;
  assumedEnabled: boolean;
}

/**
 * Installed plugins: ~/.claude/plugins/installed_plugins.json records installPath per install (documented);
 * enabledPlugins in settings says which are on (documented). The record's exact JSON shape is read defensively.
 */
function findClaudePlugins(ctx: Ctx, settings: Settings): ClaudePlugin[] {
  const pdir = ctx.opts.env.CLAUDE_CODE_PLUGIN_CACHE_DIR || path.join(configDir(ctx), "plugins");
  const rec = ctx.readJson(path.join(pdir, "installed_plugins.json")) as { plugins?: unknown } | undefined;
  if (!rec || typeof rec !== "object") return [];
  const map = (rec.plugins && typeof rec.plugins === "object" ? rec.plugins : rec) as Record<string, unknown>;
  const out: ClaudePlugin[] = [];
  const projectKeys = new Set([ctx.cwd, ctx.gitRoot].filter((x): x is string => !!x).map((x) => realpathOrSelf(x)));
  for (const [id, v] of Object.entries(map)) {
    if (out.length >= 100) break;
    if (id === "version") continue;
    if (settings.enabledPlugins[id] === false) continue;
    const entries = Array.isArray(v) ? v : [v];
    for (const e of entries) {
      if (!e || typeof e !== "object") continue;
      const x = e as { installPath?: unknown; scope?: unknown; projectPath?: unknown };
      if (typeof x.installPath !== "string" || !path.isAbsolute(x.installPath)) continue;
      if ((x.scope === "project" || x.scope === "local") && typeof x.projectPath === "string" && !projectKeys.has(realpathOrSelf(x.projectPath))) continue;
      if (!isDir(x.installPath)) {
        ctx.exclude(AGENT, x.installPath, `plugin "${id.slice(0, 60)}" is recorded in installed_plugins.json but its directory is missing`);
        continue;
      }
      const mj = ctx.readJson(path.join(x.installPath, ".claude-plugin", "plugin.json")) as { name?: unknown } | undefined;
      const name = mj && typeof mj.name === "string" && mj.name.trim() ? mj.name.trim().slice(0, 60) : id.split("@")[0].slice(0, 60);
      out.push({ id: id.slice(0, 80), name, root: x.installPath, assumedEnabled: settings.enabledPlugins[id] !== true });
      break;
    }
  }
  return out.sort((a, b) => cmp(a.id, b.id));
}

export function discoverClaude(ctx: Ctx): AdapterResult {
  const spec = loadSpec(AGENT);
  const caps = spec.caps;
  const items: Item[] = [];
  const banner: string[] = [];
  const settings = readSettings(ctx);
  const isExcluded = settings.excludes.length ? makeGlobMatcher(settings.excludes, ctx.opts.platform) : () => false;
  const seen = new Set<string>();
  const pluginMcp: ClaudePlugin[] = [];

  const add = (it: Item | null) => {
    if (it) items.push(it);
    return it;
  };
  const instr = (file: string, o: { scope: Item["scope"]; label: string; cardLabel: string; jail?: string; loadMode?: Item["loadMode"]; canExclude: boolean; notes?: string[] }): Item | null => {
    const real = realpathOrSelf(file);
    if (seen.has(real)) return null;
    if (o.canExclude && isExcluded(file)) {
      if (isFile(file)) ctx.exclude(AGENT, file, "matched claudeMdExcludes");
      return null;
    }
    const it = loadInstruction(ctx, file, {
      agent: AGENT,
      scope: o.scope,
      loadMode: o.loadMode ?? "always",
      label: o.label,
      cardLabel: o.cardLabel,
      jail: o.jail,
      stripComments: true,
      imports: true,
      confidence: "documented",
      evidence: ev("memory"),
      guidelineLines: caps.instructionFileGuidelineLines,
      notes: o.notes,
    });
    if (it) seen.add(real);
    return it;
  };

  // 1. managed, 2. user
  add(instr(path.join(managedDir(ctx), "CLAUDE.md"), { scope: "managed", label: "Managed CLAUDE.md", cardLabel: "Managed CLAUDE.md", canExclude: false }));
  add(instr(path.join(configDir(ctx), "CLAUDE.md"), { scope: "user", label: "~/.claude/CLAUDE.md", cardLabel: "User CLAUDE.md", canExclude: true }));

  // 3. project chain: CLAUDE.md / .claude/CLAUDE.md / CLAUDE.local.md in cwd and every ancestor
  let projectClaudeMd = false;
  for (const dir of ctx.ancestorDirs()) {
    const jail = ctx.jailFor(dir);
    const rel = (f: string) => ctx.display(path.join(dir, f));
    for (const [f, local] of [["CLAUDE.md", false], [path.join(".claude", "CLAUDE.md"), false], ["CLAUDE.local.md", true]] as const) {
      const full = path.join(dir, f);
      if (!isFile(full)) continue;
      const it = instr(full, {
        scope: dir === ctx.cwd ? (local ? "local" : "project") : "ancestor",
        label: rel(f),
        cardLabel: local ? "CLAUDE.local.md" : "CLAUDE.md",
        jail,
        canExclude: true,
        notes: dir === ctx.cwd ? [] : ["ancestor directory (loaded at launch, root→cwd)"],
      });
      if (it) {
        items.push(it);
        projectClaudeMd = true;
      } else if (!seen.has(realpathOrSelf(full)) && !isExcluded(full)) projectClaudeMd = true; // present but empty/unreadable still counts as "exists" for AGENTS.md precedence
    }
  }

  // 4. AGENTS.md fallback (v2.1.277+): only if no CLAUDE.md anywhere in the chain (default), or both if configured
  const both = (settings.instructionFiles ?? "").includes("and");
  for (const dir of ctx.ancestorDirs()) for (const agentsPath of [path.join(dir, "AGENTS.md"), path.join(dir, ".claude", "AGENTS.md")]) { // docs: "every AGENTS.md and .claude/AGENTS.md in your working directory and the directories above it"
    if (!isFile(agentsPath)) continue;
    if (projectClaudeMd && !both) {
      ctx.exclude(AGENT, agentsPath, "ignored by Claude Code: a CLAUDE.md exists in this directory tree (default instructionFiles = claude-md-or-agents-md)");
      ctx.addFinding({
        id: "F7",
        severity: "warn",
        agent: AGENT,
        message: `Claude Code ignores ${ctx.display(agentsPath)}: a CLAUDE.md exists in this directory tree (Cursor and Codex still load it)`,
        paths: [agentsPath],
        confidence: "high",
        fix: "Add `@AGENTS.md` to CLAUDE.md, or set the AGENTS.md plugin option instructionFiles to claude-md-and-agents-md.",
      });
      continue;
    }
    add(
      instr(agentsPath, {
        scope: dir === ctx.cwd ? "project" : "ancestor",
        label: ctx.display(agentsPath),
        cardLabel: "AGENTS.md",
        jail: ctx.jailFor(dir),
        canExclude: true,
        notes: [`AGENTS.md fallback needs Claude Code ≥ ${spec.minVersions?.agentsMdFallback}; ${both ? "both files loaded (instructionFiles setting)" : "no CLAUDE.md found"}`],
      }),
    );
  }

  // 5. nested CLAUDE.md under cwd -> conditional
  for (const hit of ctx.walk().hits) {
    for (const n of hit.names.filter((x) => x.startsWith("CLAUDE") || x === ".claude/CLAUDE.md")) {
      add(instr(path.join(hit.dir, n), { scope: "nested", label: ctx.display(path.join(hit.dir, n)), cardLabel: "nested CLAUDE.md", jail: ctx.jailFor(hit.dir), loadMode: "conditional", canExclude: true, notes: ["loaded when Claude works in this subdirectory (not in /context at start)"] }));
    }
  }

  // 6. rules
  const ruleDirs: Array<[string, Item["scope"], string]> = [
    [path.join(configDir(ctx), "rules"), "user", "~/.claude/rules"],
    [path.join(ctx.cwd, ".claude", "rules"), "project", ".claude/rules"],
  ];
  for (const [dir, scope, gl] of ruleDirs) {
    for (const f of listFilesRec(dir, [".md"])) {
      if (isExcluded(f)) {
        ctx.exclude(AGENT, f, "matched claudeMdExcludes");
        continue;
      }
      let conditional = false;
      add(
        loadInstruction(ctx, f, {
          agent: AGENT,
          scope,
          loadMode: "always",
          kind: "rule",
          label: ctx.display(f),
          cardLabel: "rule file",
          jail: scope === "project" ? ctx.jailFor(ctx.cwd) : undefined,
          stripComments: true,
          imports: true,
          confidence: "documented",
          evidence: ev("memory"),
          guidelineLines: caps.instructionFileGuidelineLines,
          group: `${gl}`,
          groupLabel: `${gl}/*.md`,
          transform: (raw) => {
            const fm = parseFrontmatter(raw);
            const paths = asList(fm.data.paths);
            conditional = paths.length > 0;
            return { text: fm.body, notes: conditional ? [`path-scoped (paths: ${paths.length} pattern${paths.length > 1 ? "s" : ""}) → conditional`] : [] };
          },
        }),
      );
      const last = items[items.length - 1];
      if (last && last.path === f && conditional) {
        last.loadMode = "conditional";
        last.group = `${gl}#conditional`;
        last.groupLabel = `${gl}/*.md (path-scoped)`;
      }
    }
  }

  // 7. auto memory
  const slugBase = ctx.gitRoot ?? ctx.cwd;
  const slug = slugBase.replace(/[^A-Za-z0-9]/g, "-");
  const memDir = settings.autoMemoryDirectory ? settings.autoMemoryDirectory.replace(/^~(?=[\\/]|$)/, ctx.home) : path.join(configDir(ctx), "projects", slug, "memory");
  const memFile = path.join(memDir, "MEMORY.md");
  if (isFile(memFile)) {
    const it = loadInstruction(ctx, memFile, {
      agent: AGENT,
      scope: "user",
      loadMode: "always",
      kind: "memory",
      label: "MEMORY.md (auto memory)",
      cardLabel: "MEMORY.md",
      stripComments: false,
      imports: false,
      confidence: "documented",
      evidence: ev("memory"),
      noAnalyze: true,
      notes: [settings.autoMemoryDirectory ? "memory dir from autoMemoryDirectory setting" : "memory dir derived from project path (derivation assumed)"],
      transform: (raw) => {
        const lines = raw.split("\n");
        const notes: string[] = [];
        let out = lines.slice(0, caps.memoryMaxLines).join("\n");
        if (lines.length > caps.memoryMaxLines) notes.push(`truncated: only first ${caps.memoryMaxLines} of ${lines.length} lines are loaded`);
        if (Buffer.byteLength(out) > caps.memoryMaxBytes) {
          out = Buffer.from(out).subarray(0, caps.memoryMaxBytes).toString("utf8");
          notes.push(`truncated at ${caps.memoryMaxBytes / 1024} KB`);
        }
        if (notes.length) {
          ctx.addFinding({ id: "F8", severity: "warn", agent: AGENT, message: `MEMORY.md exceeds the load cap (${notes.join("; ")}); the rest is silently dropped`, paths: [memFile], confidence: "high", fix: "Move detail into topic files and keep MEMORY.md as a short index." });
        }
        return { text: out, notes };
      },
    });
    add(it);
  }

  // 8. skills (listing always, body deferred), 9. subagents
  // Documented: a skill's name + description (+ when_to_use, combined cap 1,536 chars) is listed; the body loads on use.
  // disable-model-invocation / skillOverrides hide the description from the model; skillOverrides "name-only" lists the name alone.
  const cap = settings.skillListingMaxDescChars ?? caps.skillDescriptionMaxChars;
  const seenSkill = new Set<string>();
  const claudeLine = (r: SkillRec): string | null => {
    const ov = settings.skillOverrides[r.name];
    if (ov === "off" || ov === "user-invocable-only") return null;
    if (r.disableModelInvocation) return null;
    if (ov === "name-only") return `- ${r.name}`;
    const combined = [r.desc, r.when].filter(Boolean).join(" ");
    return `- ${r.name}: ${combined.length > cap ? combined.slice(0, cap) : combined}`;
  };
  const emit = (recs: SkillRec[], dir: string, scope: Item["scope"], tag: string, o: { conditional?: boolean; confidence?: "documented" | "assumed"; note?: string; kind?: "skills" | "commands" } = {}) => {
    const fresh = recs.filter((r) => !seenSkill.has(r.realPath));
    for (const r of fresh) {
      seenSkill.add(r.realPath);
      if (r.desc.length + (r.when ? r.when.length + 1 : 0) > cap && !r.disableModelInvocation) {
        ctx.addFinding({ id: "F4", severity: "warn", agent: AGENT, message: `Skill description (description + when_to_use) in ${ctx.display(r.file)} exceeds ${cap} characters; the tail is dropped from the listing`, paths: [r.file], confidence: "high", fix: `Shorten description + when_to_use to ≤ ${cap} chars combined; put the key use case first.` });
      }
    }
    if (!fresh.length) return;
    const its = skillItems(ctx, {
      agent: AGENT, dir, scope, tag, recs: fresh, lineFor: claudeLine, listingMode: o.conditional ? "conditional" : "always",
      confidence: o.confidence ?? "documented", evidence: ev("skills"),
      notes: [`name + description + when_to_use, combined cap ${cap} chars per skill`, ...(o.note ? [o.note] : [])],
    });
    items.push(...its);
    const listing = its.find((i) => i.kind === "skills-listing");
    if (listing?.tokens && !o.conditional) {
      const budget = (settings.skillListingBudgetFraction ?? caps.skillListingBudgetFractionOfWindow) * ctx.opts.window;
      const est = listing.tokens.est;
      if (est > budget) {
        ctx.addFinding({ id: "F13", severity: "info", agent: AGENT, message: `${tag} skills listing (~${est} tokens) exceeds ≈${Math.round((settings.skillListingBudgetFraction ?? caps.skillListingBudgetFractionOfWindow) * 100)}% of a ${ctx.opts.window / 1000}k window (~${Math.round(budget)}); Claude Code drops descriptions of the least-used skills to fit (documented; tokens-vs-characters unit of the budget is unclear)`, paths: [dir], confidence: "low", fix: 'Set rarely used skills to "name-only" in skillOverrides, or delete them.' });
      }
    }
  };
  const projJail = ctx.jailFor(ctx.cwd);
  emit(discoverSkills(ctx, path.join(configDir(ctx), "skills")).filter((r) => !/[\\/]synced[\\/]/.test(r.file)), path.join(configDir(ctx), "skills"), "user", "user");
  // claude.ai synced skills live in ~/.claude/skills/synced/<name>/ (documented)
  emit(discoverSkills(ctx, path.join(configDir(ctx), "skills", "synced")), path.join(configDir(ctx), "skills", "synced"), "user", "claude.ai synced");
  // project skills: cwd and every parent up to the repo root load at start (documented)
  const root = ctx.gitRoot ?? ctx.cwd;
  for (const dir of ctx.ancestorDirs().filter((d) => isInside(d, root)).reverse()) {
    const sdir = path.join(dir, ".claude", "skills");
    emit(discoverSkills(ctx, sdir, { jail: ctx.jailFor(dir) }), sdir, dir === ctx.cwd ? "project" : "ancestor", dir === ctx.cwd ? "project" : "ancestor");
  }
  // nested .claude/skills below cwd load lazily when Claude works in that subtree (documented)
  for (const hit of ctx.walk().hits) {
    if (!hit.names.includes(".claude/skills/")) continue;
    const sdir = path.join(hit.dir, ".claude", "skills");
    emit(discoverSkills(ctx, sdir, { jail: ctx.jailFor(hit.dir) }), sdir, "nested", "nested", { conditional: true, note: "nested skill directory: loaded when Claude works in this subtree (documented)" });
  }
  // custom commands are merged into skills: same listing (documented)
  for (const [dir, scope, tag, jail] of [[path.join(configDir(ctx), "commands"), "user", "user command", undefined], [path.join(ctx.cwd, ".claude", "commands"), "project", "project command", projJail]] as const) {
    const recs: SkillRec[] = [];
    for (const f of listFilesRec(dir, [".md"], 300, 3)) {
      const r = ctx.read(f, jail ? { jail } : {});
      if (r.ok) recs.push(toRec(path.basename(f, ".md"), f, r.realPath, r.text));
    }
    emit(recs, dir, scope, tag);
  }
  // plugins
  const plugins = findClaudePlugins(ctx, settings);
  // One listing per kind for ALL plugins: a listing is one block of text in the prompt, and eight one-skill lines are noise.
  const pSkills: SkillRec[] = [];
  const pCmds: SkillRec[] = [];
  for (const pl of plugins) {
    const recs = discoverSkills(ctx, path.join(pl.root, "skills"));
    for (const r of recs) r.source = pl.name;
    pSkills.push(...recs);
    for (const f of listFilesRec(path.join(pl.root, "commands"), [".md"], 200, 3)) {
      const r = ctx.read(f);
      if (r.ok) pCmds.push({ ...toRec(path.basename(f, ".md"), f, r.realPath, r.text), source: pl.name });
    }
    pluginMcp.push(pl);
  }
  if (plugins.length) {
    const guess = plugins.some((x) => x.assumedEnabled);
    const pdir = path.join(configDir(ctx), "plugins");
    const pnote = `from ${plugins.length} installed plugin${plugins.length > 1 ? "s" : ""} (installed_plugins.json${guess ? "; some are not listed in enabledPlugins and are treated as enabled" : ""})`;
    const tag = `from ${plugins.length} plugin${plugins.length > 1 ? "s" : ""}`;
    emit(pSkills, pdir, "plugin", tag, { note: pnote, confidence: guess ? "assumed" : "documented" });
    emit(pCmds, pdir, "plugin", `${tag}, command`, { note: pnote });
  }
  for (const [dir, scope, tag] of [[path.join(configDir(ctx), "agents"), "user", "user"], [path.join(ctx.cwd, ".claude", "agents"), "project", "project"]] as const) {
    const files = listFilesRec(dir, [".md"], 200, 1);
    let listing = "";
    let n = 0;
    for (const f of files) {
      const r = ctx.read(f, scope === "project" ? { jail: ctx.jailFor(ctx.cwd) } : {});
      if (!r.ok) continue;
      const fm = parseFrontmatter(r.text);
      listing += `${asString(fm.data.name) || path.basename(f, ".md")}: ${asString(fm.data.description)}\n`;
      n++;
    }
    if (n) {
      items.push(
        ctx.makeItem({ agent: AGENT, path: dir, kind: "subagents", scope, loadMode: "always", raw: ctx.count(`agents|${dir}`, listing), chars: listing.length, confidence: "assumed", evidence: ev("memory"), label: `Subagents listing (${n} ${tag})`, cardLabel: "subagents listing", notes: ["/context lists subagents; how much of each is injected is unverified (name + description assumed)"] }),
      );
    }
  }

  // 10. MCP
  const projectKeys = [...new Set([ctx.cwd, ctx.gitRoot].filter((x): x is string => !!x))];
  const toolSearchOff = (ctx.opts.env.ENABLE_TOOL_SEARCH ?? settings.env.ENABLE_TOOL_SEARCH) === "false";
  const mode = toolSearchOff ? "full" : "split";
  const modeNote = toolSearchOff ? "ENABLE_TOOL_SEARCH=false: full schemas load upfront" : "tool search assumed ON (default): names always, schemas deferred";
  const mcpSeen = new Set<string>();
  const addServers = (defs: ReturnType<typeof parseMcpMap>, source: string, scope: Item["scope"], disabled: string[]) => {
    for (const def of defs) {
      const k = `${scope}:${def.name}`;
      if (mcpSeen.has(k)) continue;
      mcpSeen.add(k);
      if (def.disabled || disabled.includes(def.name)) {
        ctx.exclude(AGENT, source, `MCP server "${def.name}" is disabled`);
        continue;
      }
      items.push(...mcpItems(ctx, { agent: AGENT, def, source, scope, mode, evidence: ev("mcp"), notes: [modeNote, ...(scope === "project" ? ["project-scope server: Claude Code asks for approval before loading"] : [])], index: items.length }));
    }
  };
  const projMcp = path.join(ctx.cwd, ".mcp.json");
  const pj = ctx.readJson(projMcp) as { mcpServers?: unknown } | undefined;
  if (pj) addServers(parseMcpMap(pj.mcpServers, (m) => ctx.warn(m)), projMcp, "project", settings.disabledProjectMcp);
  const uj = ctx.readJson(userJsonPath(ctx)) as { mcpServers?: unknown; projects?: Record<string, { mcpServers?: unknown; disabledMcpServers?: unknown }> } | undefined;
  if (uj) {
    for (const key of projectKeys) {
      const pe = uj.projects?.[key];
      if (pe) addServers(parseMcpMap(pe.mcpServers, (m) => ctx.warn(m)), userJsonPath(ctx), "local", Array.isArray(pe.disabledMcpServers) ? pe.disabledMcpServers.filter((x): x is string => typeof x === "string") : []);
    }
    addServers(parseMcpMap(uj.mcpServers, (m) => ctx.warn(m)), userJsonPath(ctx), "user", []);
  }

  // managed MCP file (name documented; location inside the managed dir assumed) and plugin-provided servers
  const mm = path.join(managedDir(ctx), "managed-mcp.json");
  const mj = ctx.readJson(mm) as { mcpServers?: unknown } | undefined;
  if (mj) addServers(parseMcpMap(mj.mcpServers, (m) => ctx.warn(m)), mm, "managed", []);
  let pluginAgents = 0;
  for (const pl of pluginMcp) {
    const f = path.join(pl.root, ".mcp.json");
    const pj2 = ctx.readJson(f) as { mcpServers?: unknown } | undefined;
    if (pj2) {
      for (const def of parseMcpMap(pj2.mcpServers ?? pj2, (m) => ctx.warn(m))) {
        if (def.disabled) continue;
        items.push(...mcpItems(ctx, { agent: AGENT, def, source: f, scope: "plugin", mode, evidence: ev("mcp"), notes: [modeNote, `provided by plugin ${pl.id}`], index: items.length }));
      }
    }
    if (isDir(path.join(pl.root, "agents"))) pluginAgents++;
  }

  banner.push("built-in system prompt and built-in tools", "claude.ai connectors (not on disk)", "hook output");
  if (pluginAgents) banner.push(`subagents and hooks provided by plugins (${pluginAgents} plugin${pluginAgents > 1 ? "s" : ""})`);
  if (exists(path.join(configDir(ctx), "plugins")) && !pluginMcp.length) banner.push("plugins directory exists but no enabled plugin install was recorded");
  return { items, unmeasuredBanner: banner };
}
