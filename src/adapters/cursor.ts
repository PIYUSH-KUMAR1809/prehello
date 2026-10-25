import path from "node:path";
import { Ctx } from "../context";
import { Confidence, Item, LoadMode, Scope } from "../model";
import { evidenceFor, loadSpec } from "../spec";
import { isDir, isFile, listDir, onPath } from "../fs-safe";
import { asList, asString, parseFrontmatter } from "../text/frontmatter";
import { listFilesRec, loadInstruction, mcpItems } from "./common";
import { AdapterResult, Detection } from "./types";
import { parseMcpMap } from "../mcp/configs";
import { discoverSkills, skillItems, SkillRec } from "./skills";
import { cmp } from "../util/fmt";

const AGENT = "cursor" as const;
const ev = (doc: string) => evidenceFor(AGENT, doc);

export function detectCursor(ctx: Ctx): Detection {
  const by: string[] = [];
  if (isDir(path.join(ctx.home, ".cursor"))) by.push("~/.cursor");
  if (onPath("cursor", ctx.opts.env.PATH ?? ctx.opts.env.Path, { platform: ctx.opts.platform, pathExt: ctx.opts.env.PATHEXT })) by.push("binary on PATH");
  if (ctx.opts.platform === "darwin" && (isDir(ctx.sys("/Applications/Cursor.app")) || isDir(path.join(ctx.home, "Applications", "Cursor.app")))) by.push("Cursor.app");
  if (ctx.opts.platform === "win32") {
    // the per-user installer puts Cursor in %LOCALAPPDATA%\Programs\cursor; the system installer in %ProgramFiles%\cursor
    const local = ctx.opts.env.LOCALAPPDATA || path.join(ctx.home, "AppData", "Local");
    const pf = ctx.opts.env.ProgramFiles || "C:\\Program Files";
    if (isFile(path.join(local, "Programs", "cursor", "Cursor.exe")) || isFile(ctx.sys(path.win32.join(pf, "cursor", "Cursor.exe")))) by.push("Cursor.exe");
  }
  if (ctx.opts.pastedUserRules?.trim()) by.push("--paste-user-rules");
  const repo: string[] = [];
  for (const f of [".cursor", ".cursorrules"]) if (isDir(path.join(ctx.cwd, f)) || isFile(path.join(ctx.cwd, f))) repo.push(path.join(ctx.cwd, f));
  if (isFile(path.join(ctx.cwd, "AGENTS.md"))) repo.push(path.join(ctx.cwd, "AGENTS.md"));
  return { detectedBy: by, repoFiles: repo };
}

function truthy(v: unknown): boolean {
  return v === true || (typeof v === "string" && v.trim().toLowerCase() === "true");
}

interface RuleOpts {
  scope: Scope;
  jail?: string;
  /** group name prefix, e.g. ".cursor/rules" */
  gl: string;
  /** nested rules apply only in a subtree: everything that would load up front becomes conditional */
  conditional?: boolean;
  confidence?: Confidence;
  note?: string;
}

/** One .mdc rule file -> items, following the four documented Cursor rule modes. */
function ruleFile(ctx: Ctx, f: string, o: RuleOpts, guideline: number): Item[] {
  const items: Item[] = [];
  const r = ctx.read(f, o.jail ? { jail: o.jail } : {});
  if (!r.ok) return items;
  const fm = parseFrontmatter(r.text);
  const always = truthy(fm.data.alwaysApply);
  const globs = asList(fm.data.globs);
  const desc = asString(fm.data.description).trim();
  const common = { agent: AGENT, path: f, kind: "rule" as const, scope: o.scope, evidence: ev("rules"), cardLabel: o.conditional ? "nested rule file" : "rule file" };
  const bodyRaw = ctx.count(`cursor-body|${r.realPath}`, fm.body);
  if (!fm.body.trim() && !desc) return items;
  const up: LoadMode = o.conditional ? "conditional" : "always";
  const conf = (c: Confidence): Confidence => o.confidence ?? c;
  const extra = o.note ? [o.note] : [];
  let mode: string;
  if (always) {
    mode = "always";
    items.push(ctx.makeItem({ ...common, loadMode: up, raw: bodyRaw, chars: fm.body.length, lines: fm.body.split("\n").length, confidence: conf("documented"), label: ctx.display(f), groupLabel: `${o.gl} (alwaysApply)`, notes: ["alwaysApply: true", ...extra], group: `${o.gl}#always` }));
  } else if (globs.length) {
    mode = "conditional";
    items.push(ctx.makeItem({ ...common, loadMode: "conditional", raw: bodyRaw, chars: fm.body.length, confidence: conf("documented"), label: ctx.display(f), groupLabel: `${o.gl} (glob-scoped)`, notes: [`globs: ${globs.length} pattern${globs.length > 1 ? "s" : ""}`, ...extra], group: `${o.gl}#glob` }));
  } else if (desc) {
    mode = "description";
    const draw = ctx.count(`cursor-desc|${r.realPath}`, desc);
    items.push(
      ctx.makeItem({ ...common, loadMode: up, kind: "rule-description", raw: draw, chars: desc.length, confidence: "assumed", label: ctx.display(f) + " (description)", groupLabel: `${o.gl} descriptions (agent-requested)`, notes: ["description is visible so the agent can decide to fetch the rule; exact injection unverified", ...extra], group: `${o.gl}#desc` }),
      ctx.makeItem({ ...common, loadMode: "deferred", kind: "rule-body", raw: bodyRaw, chars: fm.body.length, confidence: "assumed", label: ctx.display(f) + " (body)", groupLabel: `${o.gl} bodies (agent-requested)`, notes: ["fetched only if the agent decides it is relevant", ...extra], group: `${o.gl}#body` }),
    );
  } else {
    mode = "manual";
    items.push(ctx.makeItem({ ...common, loadMode: "on-demand", raw: bodyRaw, chars: fm.body.length, confidence: conf("documented"), label: ctx.display(f), groupLabel: `${o.gl} (manual @-mention)`, notes: ["no alwaysApply/globs/description: only via @-mention", ...extra], group: `${o.gl}#manual` }));
  }
  ctx.analyzeDoc(AGENT, f, r.text, fm.body, bodyRaw, mode === "always" && !o.conditional ? guideline : undefined);
  return items;
}

function rulesIn(ctx: Ctx, dir: string, o: RuleOpts, guideline: number, allowMd: boolean): Item[] {
  const items: Item[] = [];
  for (const f of listFilesRec(dir, [".mdc", ".md"])) {
    if (f.endsWith(".md") && !allowMd) {
      ctx.exclude(AGENT, f, "plain .md in .cursor/rules is ignored by Cursor (only .mdc is loaded)");
      ctx.addFinding({ id: "F11", severity: "warn", agent: AGENT, message: `${ctx.display(f)} is ignored by Cursor: only .mdc files in .cursor/rules are loaded`, paths: [f], confidence: "high", fix: "Rename it to .mdc (and add frontmatter) if you intend Cursor to use it." });
      continue;
    }
    items.push(...ruleFile(ctx, f, o, guideline));
  }
  return items;
}

const SKILLS_DOC = "skills";

/** Cursor skill locations. Native dirs + compat dirs are documented; ~/.cursor/skills-cursor was OBSERVED on a real Mac, not documented. */
function skillRoots(ctx: Ctx): Array<{ dir: string; scope: Scope; tag: string; project: boolean; confidence: Confidence; note?: string }> {
  const h = ctx.home;
  const c = ctx.cwd;
  const compat = "also read by Cursor for compatibility (documented)";
  return [
    { dir: path.join(c, ".cursor", "skills"), scope: "project", tag: "project", project: true, confidence: "documented" },
    { dir: path.join(c, ".agents", "skills"), scope: "project", tag: "project (.agents)", project: true, confidence: "documented" },
    { dir: path.join(c, ".claude", "skills"), scope: "project", tag: "project (.claude)", project: true, confidence: "documented", note: compat },
    { dir: path.join(c, ".codex", "skills"), scope: "project", tag: "project (.codex)", project: true, confidence: "documented", note: compat },
    { dir: path.join(h, ".cursor", "skills"), scope: "user", tag: "user", project: false, confidence: "documented" },
    { dir: path.join(h, ".agents", "skills"), scope: "user", tag: "user (.agents)", project: false, confidence: "documented" },
    { dir: path.join(h, ".claude", "skills"), scope: "user", tag: "user (.claude)", project: false, confidence: "documented", note: compat },
    { dir: path.join(h, ".codex", "skills"), scope: "user", tag: "user (.codex)", project: false, confidence: "documented", note: compat },
    { dir: path.join(h, ".cursor", "skills-cursor"), scope: "builtin", tag: "Cursor-managed", project: false, confidence: "assumed", note: "~/.cursor/skills-cursor is not in Cursor's docs; it was observed on a real install and is assumed to hold Cursor's own built-in skills, listed like any other skill (listing format unverified)" },
  ];
}

interface PluginRef {
  name: string;
  root: string;
  origin: "local" | "cache";
}

/** Plugin roots under ~/.cursor/plugins/{local,cache}. The on-disk layout is NOT documented: any directory holding a manifest counts. */
function findCursorPlugins(ctx: Ctx): PluginRef[] {
  const base = path.join(ctx.home, ".cursor", "plugins");
  const found: PluginRef[] = [];
  const hasManifest = (d: string) => isFile(path.join(d, ".cursor-plugin", "plugin.json")) || isFile(path.join(d, "plugin.json"));
  const visit = (d: string, depth: number, origin: "local" | "cache") => {
    if (found.length >= 200) return;
    if (hasManifest(d)) {
      const mf = isFile(path.join(d, ".cursor-plugin", "plugin.json")) ? path.join(d, ".cursor-plugin", "plugin.json") : path.join(d, "plugin.json");
      const j = ctx.readJson(mf) as { name?: unknown } | undefined;
      const name = j && typeof j.name === "string" && j.name.trim() ? j.name.trim().slice(0, 80) : path.basename(d);
      found.push({ name, root: d, origin });
      return;
    }
    if (depth <= 0) return;
    for (const e of listDir(d)) {
      if (e.name.startsWith(".")) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory() || (e.isSymbolicLink() && isDir(p))) visit(p, depth - 1, origin);
    }
  };
  visit(path.join(base, "local"), 2, "local");
  visit(path.join(base, "cache"), 5, "cache");
  // same plugin name in several cached versions: keep the last path in sorted order (usually the newest version)
  const byName = new Map<string, PluginRef>();
  for (const p of found.sort((a, b) => cmp(a.root, b.root))) byName.set(p.name, p);
  return [...byName.values()];
}

export function discoverCursor(ctx: Ctx): AdapterResult {
  const caps = loadSpec(AGENT).caps;
  const items: Item[] = [];
  const jail = ctx.jailFor(ctx.cwd);
  const banner: string[] = ["User Rules and Team Rules (stored in Cursor, not on disk; paste them with --paste-user-rules to count them)", "built-in system prompt and tools"];

  // Rules: .mdc only; plain .md is ignored by Cursor
  items.push(...rulesIn(ctx, path.join(ctx.cwd, ".cursor", "rules"), { scope: "project", jail, gl: ".cursor/rules" }, caps.ruleGuidelineLines, false));

  // Legacy .cursorrules (assumed always)
  const legacy = path.join(ctx.cwd, ".cursorrules");
  const lit = loadInstruction(ctx, legacy, { agent: AGENT, scope: "project", loadMode: "always", label: ".cursorrules (legacy)", cardLabel: ".cursorrules", jail, stripComments: false, imports: false, confidence: "assumed", evidence: ev("rules"), notes: ["legacy format; still read as an always-on rule (unverified)"] });
  if (lit) items.push(lit);

  // AGENTS.md: root always, nested conditional
  const rootAgents = path.join(ctx.cwd, "AGENTS.md");
  const rit = loadInstruction(ctx, rootAgents, { agent: AGENT, scope: "project", loadMode: "always", label: "AGENTS.md", cardLabel: "AGENTS.md", jail, stripComments: false, imports: false, confidence: "documented", evidence: ev("rules") });
  if (rit) items.push(rit);
  const nestedDirs: Array<{ dir: string; names: string[] }> = [];
  for (const hit of ctx.walk().hits) {
    nestedDirs.push(hit);
    if (!hit.names.includes("AGENTS.md")) continue;
    const nf = path.join(hit.dir, "AGENTS.md");
    const it = loadInstruction(ctx, nf, { agent: AGENT, scope: "nested", loadMode: "conditional", label: ctx.display(nf), cardLabel: "nested AGENTS.md", jail: ctx.jailFor(hit.dir), stripComments: false, imports: false, confidence: "documented", evidence: ev("rules"), notes: ["nested AGENTS.md applies when working in that directory"] });
    if (it) items.push(it);
  }

  // Nested .cursor/rules in subdirectories. Sources conflict on whether Cursor loads these (docs describe project-root rules only;
  // forum reports say subdirectory rules apply), so they are labelled "assumed" and counted as conditional.
  for (const hit of nestedDirs) {
    if (!hit.names.includes(".cursor/rules/")) continue;
    items.push(...rulesIn(ctx, path.join(hit.dir, ".cursor", "rules"), { scope: "nested", jail: ctx.jailFor(hit.dir), gl: "nested .cursor/rules", conditional: true, confidence: "assumed", note: "nested .cursor/rules: whether Cursor loads subdirectory rules is not stated in its docs (assumed conditional)" }, caps.ruleGuidelineLines, false));
  }

  // Skills. Listing (name+description) is assumed to load up front, bodies on demand; listing format/cost is UNVERIFIED for Cursor.
  const seenSkill = new Set<string>();
  const cursorSkillNotes = (extra?: string) => ["Cursor lists each skill's name + description (exact injection format and token cost unverified; counted as name: description)", ...(extra ? [extra] : [])];
  const emitSkills = (recs: SkillRec[], dir: string, scope: Scope, tag: string, confidence: Confidence, note?: string, forceConditional = false) => {
    const fresh = recs.filter((r) => !seenSkill.has(r.realPath));
    for (const r of fresh) seenSkill.add(r.realPath);
    const unscoped = fresh.filter((r) => r.scopedTo.length === 0);
    const scoped = fresh.filter((r) => r.scopedTo.length > 0);
    const spec = { agent: AGENT, dir, scope, confidence, evidence: ev(SKILLS_DOC), lineFor: (r: SkillRec) => (r.disableModelInvocation ? null : `${r.name}: ${r.desc}`) };
    if (unscoped.length) items.push(...skillItems(ctx, { ...spec, tag, recs: unscoped, listingMode: forceConditional ? "conditional" : "always", notes: cursorSkillNotes(note) }));
    if (scoped.length) items.push(...skillItems(ctx, { ...spec, tag: `${tag}, path-scoped`, recs: scoped, listingMode: "conditional", notes: cursorSkillNotes("skills with paths/globs frontmatter are surfaced only when matching files are in play (documented)") }));
  };
  for (const root of skillRoots(ctx)) {
    const recs = discoverSkills(ctx, root.dir, { recursive: true, ...(root.project ? { jail } : {}) });
    emitSkills(recs, root.dir, root.scope, root.tag, root.confidence, root.note);
  }
  for (const hit of nestedDirs) {
    for (const rel of [".cursor/skills/", ".agents/skills/"]) {
      if (!hit.names.includes(rel)) continue;
      const dir = path.join(hit.dir, ...rel.split("/").filter(Boolean));
      emitSkills(discoverSkills(ctx, dir, { recursive: true, jail: ctx.jailFor(hit.dir) }), dir, "nested", "nested", "documented", "nested skill directories are scoped to their subtree (documented)", true);
    }
  }

  // Plugins (skills / rules / mcp.json). Install state is not on a documented path: anything found in plugins/local or plugins/cache counts.
  const plugins = findCursorPlugins(ctx);
  const pluginNote = "plugin found under ~/.cursor/plugins; Cursor's on-disk plugin layout and install state are undocumented, so it may not be enabled (assumed)";
  let pluginOtherComponents = 0;
  const pluginSkillRecs: SkillRec[] = [];
  for (const pl of plugins) {
    const recs = discoverSkills(ctx, path.join(pl.root, "skills"), { recursive: true });
    for (const r of recs) r.source = pl.name;
    pluginSkillRecs.push(...recs);
    items.push(...rulesIn(ctx, path.join(pl.root, "rules"), { scope: "plugin", gl: `plugin ${pl.name} rules`, confidence: "assumed", note: pluginNote }, caps.ruleGuidelineLines, true));
    const mcpFile = path.join(pl.root, "mcp.json");
    const j = ctx.readJson(mcpFile) as { mcpServers?: unknown } | undefined;
    if (j) {
      for (const def of parseMcpMap(j.mcpServers ?? j, (m) => ctx.warn(m))) {
        if (def.disabled) continue;
        items.push(...mcpItems(ctx, { agent: AGENT, def, source: mcpFile, scope: "plugin", mode: "split", evidence: ev("mcpLazy"), notes: [pluginNote, "Cursor keeps only tool names in static context (documented)"], index: items.length }));
      }
    }
    if (["agents", "commands", "hooks"].some((d) => isDir(path.join(pl.root, d)))) pluginOtherComponents++;
  }
  if (pluginSkillRecs.length) emitSkills(pluginSkillRecs, path.join(ctx.home, ".cursor", "plugins"), "plugin", `from ${plugins.length} plugin${plugins.length > 1 ? "s" : ""}`, "assumed", pluginNote);
  if (plugins.length) banner.push(`plugin install state (${plugins.length} plugin${plugins.length > 1 ? "s" : ""} found under ~/.cursor/plugins${isDir(path.join(ctx.home, ".cursor", "plugins", "marketplaces")) ? "; marketplace clones ignored" : ""})`);
  if (pluginOtherComponents) banner.push(`plugin agents/commands/hooks (${pluginOtherComponents} plugin${pluginOtherComponents > 1 ? "s" : ""})`);

  // MCP: ~/.cursor/mcp.json and .cursor/mcp.json. Cursor keeps only tool NAMES in static context and fetches descriptions on demand (documented, Jan 2026).
  for (const [file, scope] of [[path.join(ctx.home, ".cursor", "mcp.json"), "user"], [path.join(ctx.cwd, ".cursor", "mcp.json"), "project"]] as const) {
    const j = ctx.readJson(file) as { mcpServers?: unknown } | undefined;
    if (!j) continue;
    for (const def of parseMcpMap(j.mcpServers, (m) => ctx.warn(m))) {
      if (def.disabled) continue;
      items.push(...mcpItems(ctx, { agent: AGENT, def, source: file, scope, mode: "split", evidence: ev("mcpLazy"), notes: ["Cursor keeps only tool names in static context; descriptions are fetched on demand (documented in Cursor's 'Dynamic context discovery' post). Name count is unmeasured without a catalog entry."], index: items.length }));
    }
  }

  // Pasted User Rules (they live inside the app, not on disk)
  if (ctx.opts.pastedUserRules !== undefined && ctx.opts.pastedUserRules.trim()) {
    const text = ctx.opts.pastedUserRules;
    items.push(
      ctx.makeItem({ agent: AGENT, path: path.join(ctx.home, ".cursor", "(pasted user rules)"), kind: "user-rules", scope: "user", loadMode: "always", raw: ctx.count(`pasted|${text.length}`, text), chars: text.length, lines: text.split("\n").length, confidence: "assumed", evidence: ev("rules"), cardLabel: "User Rules (pasted)", label: "User Rules (pasted via --paste-user-rules)", notes: ["text you pasted; assumed to be sent on every request (Cursor docs describe User Rules as always applied; exact injection unverified)"] }),
    );
    const i = banner.findIndex((b) => b.startsWith("User Rules"));
    if (i >= 0) banner[i] = "Team Rules (stored in Cursor, not on disk)";
  }
  return { items, unmeasuredBanner: banner };
}
