import path from "node:path";
import { Ctx, WALK_CANDIDATES } from "../context";
import { Item, Scope } from "../model";
import { evidenceFor, loadSpec } from "../spec";
import { isDir, isFile, isInside, listDir, onPath } from "../fs-safe";
import { loadInstruction, mcpItems } from "./common";
import { AdapterResult, Detection } from "./types";
import { McpServerDef, parseMcpMap } from "../mcp/configs";
import { discoverSkills, skillItems, SkillRec } from "./skills";

const AGENT = "gemini-cli" as const;
const ev = (doc: string) => evidenceFor(AGENT, doc);

function geminiHome(ctx: Ctx): string {
  return path.join(ctx.home, ".gemini");
}

export function detectGemini(ctx: Ctx): Detection {
  const by: string[] = [];
  if (isDir(geminiHome(ctx))) by.push("config dir");
  if (onPath("gemini", ctx.opts.env.PATH ?? ctx.opts.env.Path, { platform: ctx.opts.platform, pathExt: ctx.opts.env.PATHEXT })) by.push("binary on PATH");
  const repo: string[] = [];
  for (const rel of ["GEMINI.md", ".gemini"]) {
    const p = path.join(ctx.cwd, rel);
    if (isFile(p) || isDir(p)) repo.push(p);
  }
  return { detectedBy: by, repoFiles: repo };
}

type Settings = Record<string, unknown>;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** settings.json may carry // comments in the wild; only strict JSON is parsed here (a failure is a warning, never a guess). */
function readSettings(ctx: Ctx, file: string, jail?: string): Settings | undefined {
  if (!isFile(file)) return undefined;
  const r = ctx.read(file, jail ? { jail } : {});
  if (!r.ok) return undefined;
  try {
    const j = JSON.parse(r.text) as unknown;
    return isObj(j) ? j : undefined;
  } catch {
    ctx.warn(`${ctx.display(file)}: could not parse as JSON, skipped`);
    return undefined;
  }
}

function names(v: unknown): string[] | undefined {
  const list = typeof v === "string" ? [v] : Array.isArray(v) ? v : undefined;
  if (!list) return undefined;
  const ok = list.filter((x): x is string => typeof x === "string" && x.length > 0 && !/[\\/]/.test(x) && x !== "." && x !== "..");
  return ok.length ? [...new Set(ok)] : undefined;
}

export function discoverGemini(ctx: Ctx): AdapterResult {
  const caps = loadSpec(AGENT).caps;
  const items: Item[] = [];
  const banner = ["built-in system prompt and tools", "the directory tree Gemini CLI adds to the first request (context.includeDirectoryTree)", "saved memories and auto memory"];
  const home = geminiHome(ctx);
  const userSettingsFile = path.join(home, "settings.json");
  const wsSettingsFile = path.join(ctx.cwd, ".gemini", "settings.json");
  const user = readSettings(ctx, userSettingsFile) ?? {};
  const ws = ctx.cwd === ctx.home ? {} : (readSettings(ctx, wsSettingsFile, ctx.jailFor(ctx.cwd)) ?? {});
  const ctxOf = (s: Settings) => (isObj(s.context) ? s.context : {});
  // Workspace settings override user settings (documented).
  const pick = (k: string): unknown => (ctxOf(ws)[k] !== undefined ? ctxOf(ws)[k] : ctxOf(user)[k]);
  const fileNames = names(pick("fileName")) ?? names(ws.contextFileName) ?? names(user.contextFileName) ?? ["GEMINI.md"];
  const markersRaw = pick("memoryBoundaryMarkers");
  const markers = Array.isArray(markersRaw) ? markersRaw.filter((x): x is string => typeof x === "string" && x.length > 0) : [".git"];
  const customNames = !(fileNames.length === 1 && fileNames[0] === "GEMINI.md");
  const nameNote = customNames ? [`context.fileName: ${fileNames.join(", ")}`] : [];
  const importOpts = { imports: true, importMaxDepth: caps.importMaxDepth, stripComments: false } as const;

  // 1. Global context files
  for (const n of fileNames) {
    const f = path.join(home, n);
    const it = loadInstruction(ctx, f, { agent: AGENT, scope: "user", loadMode: "always", label: `~/.gemini/${n}`, cardLabel: `global ${n}`, ...importOpts, confidence: "documented", evidence: ev("geminiMd"), notes: nameNote });
    if (it) items.push(it);
  }

  // 2. cwd and parents, up to the first directory holding a boundary marker (default .git), never the home folder itself
  const up: string[] = [];
  for (let d = ctx.cwd; ; ) {
    if (d === ctx.home) break;
    up.push(d);
    if (!markers.length) break; // an empty list disables parent traversal (documented)
    if (markers.some((m) => isFile(path.join(d, m)) || isDir(path.join(d, m)))) break;
    if (ctx.opts.ceiling && d === ctx.opts.ceiling) break;
    const p = path.dirname(d);
    if (p === d) break;
    d = p;
  }
  // Files above the boundary are not part of this project's context: say so instead of dropping them silently.
  const top = up[up.length - 1];
  const exists = (p: string) => isFile(p) || isDir(p);
  if (top && markers.some((m) => exists(path.join(top, m)))) {
    for (let d = top; ; ) {
      if (ctx.opts.ceiling && d === ctx.opts.ceiling) break;
      const p = path.dirname(d);
      if (p === d || p === ctx.home) break;
      d = p;
      for (const n of fileNames) if (isFile(path.join(d, n))) ctx.exclude(AGENT, path.join(d, n), `above the project root (${markers.join(", ")} boundary): Gemini CLI stops there`);
    }
  }
  for (const dir of up.reverse()) {
    for (const n of fileNames) {
      const f = path.join(dir, n);
      if (!isFile(f)) continue;
      const it = loadInstruction(ctx, f, {
        agent: AGENT, scope: dir === ctx.cwd ? "project" : "ancestor", loadMode: "always", label: ctx.display(f), cardLabel: n, jail: ctx.jailFor(dir),
        ...importOpts, confidence: "documented", evidence: ev("geminiMd"), notes: nameNote,
      });
      if (it) items.push(it);
    }
  }

  // 3. Below cwd: just-in-time (loaded when a tool touches that directory). The project walk knows a fixed set of names.
  const walkable = fileNames.filter((n) => WALK_CANDIDATES.includes(n));
  let nNested = 0;
  for (const hit of walkable.length ? ctx.walk().hits : []) {
    if (hit.dir === ctx.cwd || !isInside(hit.dir, ctx.cwd)) continue;
    for (const n of walkable) {
      if (!hit.names.includes(n)) continue;
      if (++nNested > caps.discoveryMaxDirs) break;
      const f = path.join(hit.dir, n);
      const it = loadInstruction(ctx, f, {
        agent: AGENT, scope: "nested", loadMode: "conditional", label: ctx.display(f), cardLabel: `nested ${n}`, jail: ctx.jailFor(hit.dir), ...importOpts,
        confidence: "documented", evidence: ev("geminiMd"),
        notes: ["just-in-time: loaded when a tool accesses that directory (docs/cli/gemini-md.md); older docs describe an eager scan of up to 200 subdirectories, which would make it always-on"],
      });
      if (it) items.push(it);
    }
  }
  const unwalked = fileNames.filter((n) => !walkable.includes(n));
  if (unwalked.length) banner.push(`context files named ${unwalked.join(", ")} below the working directory (not walked)`);

  // 4. Extensions (~/.gemini/extensions/<name>/gemini-extension.json): context file + MCP servers
  const extServers: Array<{ file: string; def: McpServerDef }> = [];
  const extRoot = path.join(home, "extensions");
  const exts = listDir(extRoot).filter((e) => e.isDirectory() && !e.name.startsWith("."));
  for (const e of exts) {
    const dir = path.join(extRoot, e.name);
    const manifestFile = path.join(dir, "gemini-extension.json");
    const m = readSettings(ctx, manifestFile, dir);
    if (!m) continue;
    const note = "installed extension; per-workspace enable/disable state is not read (assumed enabled)";
    const ctxNames = names(m.contextFileName) ?? (isFile(path.join(dir, "GEMINI.md")) ? ["GEMINI.md"] : []);
    for (const n of ctxNames) {
      const f = path.join(dir, n);
      const it = loadInstruction(ctx, f, { agent: AGENT, scope: "plugin", loadMode: "always", label: `extension ${e.name}: ${n}`, cardLabel: "extension context", jail: dir, ...importOpts, confidence: "documented", evidence: ev("extensions"), notes: [note] });
      if (it) items.push(it);
    }
    for (const def of parseMcpMap(m.mcpServers, (w) => ctx.warn(w))) extServers.push({ file: manifestFile, def });
  }

  // 5. MCP: workspace settings override user settings; settings override extensions on a name clash (documented)
  const seen = new Set<string>();
  const add = (file: string, scope: Scope, def: McpServerDef, doc: string, extra: string[]) => {
    if (def.disabled || seen.has(def.name)) return;
    seen.add(def.name);
    items.push(...mcpItems(ctx, { agent: AGENT, def, source: file, scope, mode: "full", evidence: ev(doc), notes: ["Gemini CLI connects to each server and registers all discovered tools; schemas modelled as loaded up front (assumed)", ...extra], index: items.length }));
  };
  for (const def of parseMcpMap(ws.mcpServers, (w) => ctx.warn(w))) add(wsSettingsFile, "project", def, "mcp", ["workspace settings (.gemini/settings.json)"]);
  for (const def of parseMcpMap(user.mcpServers, (w) => ctx.warn(w))) add(userSettingsFile, "user", def, "mcp", []);
  for (const x of extServers) add(x.file, "plugin", x.def, "extensions", ["from an extension"]);

  // 6. Skills: name + description listed up front, body on activation (documented). .agents/skills wins over .gemini/skills in a tier.
  const seenSkill = new Set<string>();
  const line = (r: SkillRec) => `- ${r.name}: ${r.desc}`;
  const emit = (dir: string, scope: Scope, tag: string, jail?: string) => {
    const recs = discoverSkills(ctx, dir, jail ? { jail } : {}).filter((r) => {
      if (seenSkill.has(r.name)) {
        ctx.exclude(AGENT, r.file, "a skill with the same name in a higher-precedence location wins");
        return false;
      }
      seenSkill.add(r.name);
      return true;
    });
    if (!recs.length) return;
    items.push(...skillItems(ctx, { agent: AGENT, dir, scope, tag, recs, lineFor: line, listingMode: "always", confidence: "documented", evidence: ev("skills"), notes: ["name + description are injected at session start (documented); exact wording of the listing is assumed"] }));
  };
  if (ctx.cwd !== ctx.home) {
    emit(path.join(ctx.cwd, ".agents", "skills"), "project", "workspace", ctx.jailFor(ctx.cwd));
    emit(path.join(ctx.cwd, ".gemini", "skills"), "project", "workspace .gemini", ctx.jailFor(ctx.cwd));
  }
  emit(path.join(ctx.home, ".agents", "skills"), "user", "user");
  emit(path.join(home, "skills"), "user", "user .gemini");
  if (exts.some((e) => isDir(path.join(extRoot, e.name, "skills")))) banner.push("skills bundled in extensions");
  banner.push("built-in skills");

  return { items, unmeasuredBanner: banner };
}
