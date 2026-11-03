import path from "node:path";
import { Ctx } from "../context";
import { Item, LoadMode, Scope } from "../model";
import { evidenceFor } from "../spec";
import { isDir, isFile, isInside, listDir, onPath } from "../fs-safe";
import { asString, parseFrontmatter } from "../text/frontmatter";
import { listFilesRec, loadInstruction, mcpItems } from "./common";
import { AdapterResult, Detection } from "./types";
import { McpServerDef, parseMcpMap } from "../mcp/configs";

const AGENT = "github-copilot" as const;
const ev = (doc: string) => evidenceFor(AGENT, doc);

function copilotHome(ctx: Ctx): string {
  return ctx.opts.env.COPILOT_HOME || path.join(ctx.home, ".copilot");
}

/** VS Code's user profile folder (where the user-level mcp.json lives). */
function vscodeUserDir(ctx: Ctx): string {
  const plat = ctx.opts.platform ?? process.platform;
  if (plat === "darwin") return path.join(ctx.home, "Library", "Application Support", "Code", "User");
  if (plat === "win32") return path.join(ctx.opts.env.APPDATA || path.join(ctx.home, "AppData", "Roaming"), "Code", "User");
  return path.join(ctx.opts.env.XDG_CONFIG_HOME || path.join(ctx.home, ".config"), "Code", "User");
}

function hasCopilotExtension(ctx: Ctx): boolean {
  return listDir(path.join(ctx.home, ".vscode", "extensions")).some((e) => e.isDirectory() && /^github\.copilot(-chat)?-\d/i.test(e.name));
}

export function detectCopilot(ctx: Ctx): Detection {
  const by: string[] = [];
  if (isDir(copilotHome(ctx))) by.push("config dir");
  if (onPath("copilot", ctx.opts.env.PATH ?? ctx.opts.env.Path, { platform: ctx.opts.platform, pathExt: ctx.opts.env.PATHEXT })) by.push("binary on PATH");
  if (hasCopilotExtension(ctx)) by.push("VS Code Copilot extension");
  const repo: string[] = [];
  const root = ctx.gitRoot ?? ctx.cwd;
  for (const rel of [".github/copilot-instructions.md", ".github/instructions", ".github/prompts", ".vscode/mcp.json", ".github/mcp.json"]) {
    const p = path.join(root, ...rel.split("/"));
    if (isFile(p) || isDir(p)) repo.push(p);
  }
  return { detectedBy: by, repoFiles: repo };
}

const ALWAYS_NAMES: Array<{ rel: string; imports: boolean; card: string }> = [
  { rel: ".github/copilot-instructions.md", imports: true, card: "copilot-instructions.md" },
  { rel: "AGENTS.md", imports: true, card: "AGENTS.md" },
  { rel: "CLAUDE.md", imports: true, card: "CLAUDE.md" },
  { rel: ".claude/CLAUDE.md", imports: true, card: "CLAUDE.md" },
  { rel: "GEMINI.md", imports: false, card: "GEMINI.md" },
];

export function discoverCopilot(ctx: Ctx): AdapterResult {
  const items: Item[] = [];
  const home = copilotHome(ctx);
  const root = ctx.gitRoot ?? ctx.cwd;
  const seenText = new Map<string, string>(); // trimmed content -> first path (Copilot CLI removes identical copies)
  /** true (and recorded as excluded) when the file's content was already counted. Checked before loading so a duplicate is not analysed twice. */
  const isDup = (f: string, jail?: string): boolean => {
    const r = ctx.read(f, jail ? { jail, quiet: true } : { quiet: true });
    if (!r.ok) return false;
    const k = r.text.replace(/\r\n?/g, "\n").trim();
    if (!k) return false;
    const first = seenText.get(k);
    if (first !== undefined) {
      ctx.exclude(AGENT, f, `identical to ${ctx.display(first)} (Copilot CLI removes duplicate copies)`);
      return true;
    }
    seenText.set(k, f);
    return false;
  };
  // User-level always-on instructions
  const userInstr = path.join(home, "copilot-instructions.md");
  const ui = isDup(userInstr) ? null : loadInstruction(ctx, userInstr, {
    agent: AGENT, scope: "user", loadMode: "always", label: "~/.copilot/copilot-instructions.md", cardLabel: "user copilot-instructions.md",
    stripComments: false, imports: true, importRoots: [home], importRelativeOnly: true, confidence: "documented", evidence: ev("cliInstructions"),
  });
  const uiKept = ui;
  if (uiKept) items.push(uiKept);

  // Repository chain: repo root -> cwd (the "standard locations"; VS Code itself reads the root files)
  const chain = ctx.ancestorDirs().filter((d) => isInside(d, root));
  for (const dir of chain) {
    const jail = ctx.jailFor(dir);
    for (const n of ALWAYS_NAMES) {
      const f = path.join(dir, ...n.rel.split("/"));
      if (!isFile(f)) continue;
      const cliOnly = n.rel.includes("CLAUDE") || n.rel === "GEMINI.md";
      const notes: string[] = [];
      if (dir !== root) notes.push("intermediate/working directory file: read by Copilot CLI (documented); VS Code reads repository-root files");
      if (n.rel === "GEMINI.md") notes.push("read by Copilot CLI (documented); not listed for VS Code");
      else if (cliOnly) notes.push("read by Copilot CLI (documented); VS Code only with chat.useClaudeMdFile (setting not read)");
      if (n.rel === "AGENTS.md" && dir === root) notes.push("VS Code: chat.useAgentsMdFile, on by default (setting not read)");
      if (!n.imports) notes.push("@file references are not expanded in GEMINI.md by Copilot CLI (documented)");
      if (isDup(f, jail)) continue;
      const it = loadInstruction(ctx, f, {
        agent: AGENT, scope: dir === ctx.cwd ? "project" : "ancestor", loadMode: "always", label: ctx.display(f), cardLabel: n.card, jail,
        stripComments: false, imports: n.imports, importRoots: [root], importRelativeOnly: true,
        confidence: "documented", evidence: ev(n.rel === ".github/copilot-instructions.md" ? "repoInstructions" : "cliInstructions"), notes,
      });
      const kept = it;
      if (kept) items.push(kept);
    }
  }

  // Nested agent files below cwd: Copilot CLI picks them up for files it works on there -> conditional
  for (const hit of ctx.walk().hits) {
    if (hit.dir === ctx.cwd || !isInside(hit.dir, ctx.cwd)) continue;
    for (const name of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]) {
      if (!hit.names.includes(name)) continue;
      const f = path.join(hit.dir, name);
      if (isDup(f, ctx.jailFor(hit.dir))) continue;
      const it = loadInstruction(ctx, f, {
        agent: AGENT, scope: "nested", loadMode: "conditional", label: ctx.display(f), cardLabel: `nested ${name}`, jail: ctx.jailFor(hit.dir),
        stripComments: false, imports: name !== "GEMINI.md", importRoots: [root], importRelativeOnly: true, confidence: "documented", evidence: ev("cliInstructions"),
        notes: ["applies when Copilot works on files in that directory"],
      });
      const kept = it;
      if (kept) items.push(kept);
    }
  }

  // Path-specific *.instructions.md (repo root and cwd .github/instructions, not intermediate dirs; user ~/.copilot/instructions)
  const instrDirs: Array<[string, Scope, string | undefined]> = [[path.join(root, ".github", "instructions"), "project", ctx.jailFor(root)]];
  if (ctx.cwd !== root) instrDirs.push([path.join(ctx.cwd, ".github", "instructions"), "project", ctx.jailFor(ctx.cwd)]);
  instrDirs.push([path.join(home, "instructions"), "user", undefined]);
  for (const [dir, scope, jail] of instrDirs) {
    if (!isDir(dir)) continue;
    for (const f of listFilesRec(dir, [".instructions.md"], 500, 8)) {
      const r = ctx.read(f, jail ? { jail } : {});
      if (!r.ok) {
        items.push(...[loadInstruction(ctx, f, { agent: AGENT, scope, loadMode: "conditional", label: ctx.display(f), cardLabel: "instructions file", jail, stripComments: false, imports: false, confidence: "documented", evidence: ev("pathInstructions") })].filter((x): x is Item => !!x));
        continue;
      }
      const fm = parseFrontmatter(r.text);
      const applyTo = asString(fm.data.applyTo)?.trim();
      const desc = asString(fm.data.description)?.trim();
      let mode: LoadMode;
      const notes: string[] = [];
      if (applyTo) {
        mode = "conditional";
        const pats = applyTo.split(",").map((s) => s.trim()).filter(Boolean);
        notes.push(`applyTo: ${pats.length} pattern${pats.length > 1 ? "s" : ""}; attached when Copilot creates or changes a matching file`);
        if (pats.some((p) => p === "**" || p === "**/*")) notes.push("applyTo matches every file, so in practice it loads on nearly every edit");
      } else if (desc) {
        mode = "deferred";
        notes.push("no applyTo: VS Code may load it on demand when its description matches the task (documented)");
      } else {
        ctx.exclude(AGENT, f, "no applyTo and no description: only used when attached manually");
        continue;
      }
      const ex = asString(fm.data.excludeAgent);
      if (ex) notes.push(`excludeAgent: ${ex}`);
      const it = loadInstruction(ctx, f, {
        agent: AGENT, scope, loadMode: mode, label: ctx.display(f), cardLabel: "instructions file", jail, stripComments: false, imports: false,
        confidence: "documented", evidence: ev("pathInstructions"), notes, group: `instr#${mode}`, groupLabel: mode === "conditional" ? "path-specific instructions (applyTo)" : "instructions loaded by description",
        transform: (raw) => ({ text: parseFrontmatter(raw).body }), noAnalyze: true,
      });
      if (it) items.push(it);
    }
  }

  // Prompt files: slash commands, loaded only when invoked
  const promptDir = path.join(root, ".github", "prompts");
  if (isDir(promptDir)) {
    for (const f of listFilesRec(promptDir, [".prompt.md"], 500, 8)) {
      const it = loadInstruction(ctx, f, {
        agent: AGENT, scope: "project", loadMode: "on-demand", label: ctx.display(f), cardLabel: "prompt file", jail: ctx.jailFor(root), stripComments: false, imports: false,
        confidence: "documented", evidence: ev("promptFiles"), notes: ["prompt file: loaded only when you run it as a /command"], group: "prompts", groupLabel: "prompt files (/commands)",
        transform: (raw) => ({ text: parseFrontmatter(raw).body }), noAnalyze: true,
      });
      if (it) items.push(it);
    }
  }

  // MCP. Precedence (closest wins): .mcp.json/.github/mcp.json cwd -> root, then ~/.copilot/mcp-config.json; VS Code files after.
  const seenServer = new Set<string>();
  const addServers = (file: string, scope: Scope, defs: McpServerDef[], notes: string[], doc: string) => {
    for (const def of defs) {
      if (def.disabled || seenServer.has(def.name)) continue;
      seenServer.add(def.name);
      items.push(...mcpItems(ctx, { agent: AGENT, def, source: file, scope, mode: "full", evidence: ev(doc), notes: ["Copilot MCP tool schemas modelled as loaded up front (unverified)", ...notes], index: items.length }));
    }
  };
  const readMap = (file: string, jail?: string): unknown => {
    if (!isFile(file)) return undefined;
    const r = ctx.read(file, jail ? { jail } : {});
    if (!r.ok) return undefined;
    try {
      return JSON.parse(r.text);
    } catch {
      ctx.warn(`${ctx.display(file)}: could not parse as JSON (comments are not supported here), skipped`);
      return undefined;
    }
  };
  const asMap = (j: unknown, key: string): unknown => (j && typeof j === "object" && key in (j as object) ? (j as Record<string, unknown>)[key] : j);
  for (const dir of [...chain].reverse()) {
    for (const rel of [".mcp.json", ".github/mcp.json"]) {
      if (rel === ".github/mcp.json" && dir !== root) continue;
      const f = path.join(dir, ...rel.split("/"));
      const j = readMap(f, ctx.jailFor(dir));
      if (j !== undefined) addServers(f, "project", parseMcpMap(asMap(j, "mcpServers"), (m) => ctx.warn(m)), ["project MCP config: loaded only after you trust the folder (assumed trusted)"], "cliMcp");
    }
  }
  const userCfg = path.join(home, "mcp-config.json");
  const uj = readMap(userCfg);
  if (uj !== undefined) addServers(userCfg, "user", parseMcpMap(asMap(uj, "mcpServers"), (m) => ctx.warn(m)), [], "cliMcp");
  for (const [f, scope] of [[path.join(root, ".vscode", "mcp.json"), "project"], [path.join(vscodeUserDir(ctx), "mcp.json"), "user"]] as const) {
    const j = readMap(f, scope === "project" ? ctx.jailFor(root) : undefined) as { servers?: unknown } | undefined;
    if (j !== undefined) addServers(f, scope, parseMcpMap(j.servers, (m) => ctx.warn(m)), ["VS Code format (top-level \"servers\"): used by VS Code, not read by Copilot CLI (documented)"], "vscodeMcp");
  }

  return {
    items,
    unmeasuredBanner: [
      "built-in system prompt and tools (incl. the built-in GitHub MCP server)",
      "organization / enterprise instructions",
      "VS Code settings (instruction files toggles, settings-based instructions) are not read; defaults assumed",
      "skills and custom agents (not modelled yet)",
    ],
  };
}
