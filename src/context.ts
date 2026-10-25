import path from "node:path";
import { AgentId, Excluded, Finding, Item, ItemKind, LoadMode, Confidence, Scope } from "./model";
import { Counter } from "./tokens/counter";
import { Profile, profileFor } from "./tokens/families";
import { readTextSafe, ReadResult, findGitRoot, walkForFiles, WalkHit, realpathOrSelf, isInside, isFile, isDir, DEFAULT_MAX_SCAN_BYTES, DEFAULT_MAX_SCAN_MS, MAX_WALK_ENTRIES } from "./fs-safe";
import { findSecretLines, displayPath } from "./redact";
import { sanitize } from "./util/fmt";

export interface ScanOptions {
  cwd: string;
  home: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  ceiling?: string; // stop ancestor walks here (tests / monorepos)
  managedDir?: string; // override for managed Claude Code dir (tests)
  /** Re-root machine-wide locations (/Applications, /etc, /Library/...) under this directory. Hermetic tests; also lets you inspect a mounted disk image. */
  systemRoot?: string;
  /** Text the user pasted for rules that live inside an app (e.g. Cursor "User Rules"). Counted, never printed or stored. */
  pastedUserRules?: string;
  window: number;
  tokenizer: "auto" | "heuristic";
  claudeProfile: "current" | "legacy";
  agents?: AgentId[]; // explicit selection => forced "in use"
  catalogPath?: string; // user-supplied MCP weights
  noBundledCatalog?: boolean; // ignore the measured weights shipped in spec/mcp-weights.json
  now: Date;
  /** Whole-scan budget: total bytes read (deterministic) and wall-clock ms (safety net, not deterministic). Defaults: 64 MiB, 20 s. */
  maxScanBytes?: number;
  maxScanMs?: number;
  /** Injectable clock for tests. */
  clock?: () => number;
}

export type WalkResult = { hits: WalkHit[]; truncated: boolean; timedOut: boolean; entries: number; notAProject: boolean };

/** Human wording for a failed read; `verb` is "skipped" (rules, skills) or "not read" (instruction files). */
export function readFailWhy(reason: string, verb: string): string {
  switch (reason) {
    case "too-large": return `larger than 4 MiB (Claude Code's own limit for startup files), ${verb}`;
    case "binary": return `binary content, ${verb}`;
    case "utf16": return `saved as UTF-16 (Windows PowerShell "> file" does this); coding agents read UTF-8, so it is ${verb}. Re-save it as UTF-8`;
    case "symlink-escape": return `symlink points outside the project, ${verb === "skipped" ? "skipped" : "not followed"}`;
    case "not-file": return `not a regular file, ${verb}`;
    case "budget": return `${verb}: scan budget reached`;
    default: return reason === "unreadable" ? `unreadable, ${verb}` : `${reason}, ${verb}`;
  }
}

interface DocInfo {
  path: string;
  tokens: number;
  shingles: Set<number>;
  agents: Set<AgentId>;
}

/** Names (files) and "dir/" entries looked for in every directory of the bounded project walk. */
export const WALK_CANDIDATES = [
  "CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md", "AGENTS.md", "AGENTS.override.md",
  ".cursor/rules/", ".cursor/skills/", ".agents/skills/", ".claude/skills/",
];

export class Ctx {
  readonly warnings: string[] = [];
  readonly excluded: Excluded[] = [];
  readonly findings: Finding[] = [];
  readonly docs = new Map<string, DocInfo>(); // realpath -> info (for F2)
  readonly gitRoot: string | undefined;
  private seq = 0;
  private readCache = new Map<string, ReadResult>();
  private findingKeys = new Set<string>();
  private countCache = new Map<string, number>();
  private walkCache: WalkResult | undefined;
  private readonly t0: number;
  private bytesRead = 0;
  /** Set when a whole-scan budget (bytes or time) stopped reading; totals are then lower bounds. */
  budgetHit: "bytes" | "time" | undefined;
  budgetSkipped = 0;

  constructor(
    readonly opts: ScanOptions,
    readonly counter: Counter,
  ) {
    this.gitRoot = findGitRoot(opts.cwd, opts.ceiling);
    this.t0 = (opts.clock ?? Date.now)();
  }

  get maxScanBytes(): number {
    return this.opts.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES;
  }
  get maxScanMs(): number {
    return this.opts.maxScanMs ?? DEFAULT_MAX_SCAN_MS;
  }

  timeUp(): boolean {
    if (this.budgetHit === "time") return true;
    if ((this.opts.clock ?? Date.now)() - this.t0 > this.maxScanMs) {
      this.budgetHit = this.budgetHit ?? "time";
      return true;
    }
    return false;
  }

  /** Is cwd a project folder (as opposed to a home directory, a drive root or a downloads folder)? .git, or an agent file at its top level. Never true for the home folder. */
  isProjectDir(): boolean {
    if (this.cwd === this.home) return false;
    if (this.gitRoot && this.gitRoot !== this.home) return true;
    const top = ["CLAUDE.md", "AGENTS.md", "CLAUDE.local.md", ".cursorrules", ".mcp.json"];
    if (top.some((f) => isFile(path.join(this.cwd, f)))) return true;
    return [".claude", ".cursor", ".codex", ".agents"].some((d) => isDir(path.join(this.cwd, d)));
  }

  get cwd(): string {
    return this.opts.cwd;
  }
  get home(): string {
    return this.opts.home;
  }

  profile(agent: AgentId): Profile {
    return profileFor(agent, this.counter.method, this.opts.claudeProfile);
  }

  display(p: string): string {
    return displayPath(p, { cwd: this.cwd, home: this.home });
  }

  warn(msg: string): void {
    if (!this.warnings.includes(msg)) this.warnings.push(msg);
  }

  exclude(agent: AgentId | "all", p: string, reason: string): void {
    this.excluded.push({ agent, path: p, reason });
  }

  /** A machine-wide absolute location, re-rooted under --system-root when given. */
  sys(abs: string): string {
    const root = this.opts.systemRoot;
    if (!root) return abs;
    const rel = abs.replace(/^[A-Za-z]:/, "").replace(/\\/g, "/").replace(/^\/+/, "");
    return path.join(root, ...rel.split("/"));
  }

  /** Directories from filesystem root (or ceiling) down to cwd, root-first. */
  ancestorDirs(): string[] {
    const dirs: string[] = [];
    let dir = this.cwd;
    for (;;) {
      dirs.unshift(dir);
      if (this.opts.ceiling && dir === this.opts.ceiling) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return dirs;
  }

  /** jail for project-tree files: the git root if the file is inside it, else its own directory. */
  jailFor(dir: string): string {
    return this.gitRoot && isInside(dir, this.gitRoot) ? this.gitRoot : dir;
  }

  walk(): WalkResult {
    if (!this.walkCache) {
      const w = walkForFiles(this.cwd, WALK_CANDIDATES, { timeUp: () => this.timeUp() });
      const notAProject = !this.isProjectDir();
      if ((w.truncated || w.timedOut) && notAProject) {
        // Walking a home folder, a drive root or ~/Downloads: whatever CLAUDE.md/AGENTS.md files happen to sit in the first
        // 5,000 entries are random, not "your project". Reporting them would print junk token totals, so drop them.
        this.walkCache = { ...w, hits: [], notAProject };
        this.warn(`${this.display(this.cwd) === "." ? "this folder" : this.display(this.cwd)} does not look like a project (no .git, no agent files at its top level) and holds more than ${MAX_WALK_ENTRIES} entries, so nested agent files were NOT scanned (they would be arbitrary). Run prehello on a project folder: prehello ~/code/my-project`);
      } else {
        this.walkCache = { ...w, notAProject };
        if (w.truncated) this.warn(`project walk stopped at ${MAX_WALK_ENTRIES} entries; nested files deeper in the tree may be missed`);
        if (w.timedOut) this.warn("project walk stopped at the time budget; nested files may be missed");
      }
    }
    return this.walkCache;
  }

  /** Cached, defensive read. Missing = silent; other failures become warnings (-> exit code 3). */
  read(p: string, opts: { jail?: string; maxBytes?: number; quiet?: boolean } = {}): ReadResult {
    const key = `${p}|${opts.jail ?? ""}|${opts.maxBytes ?? ""}`;
    let r = this.readCache.get(key);
    if (!r) {
      if (this.timeUp() || this.bytesRead >= this.maxScanBytes) {
        // Budget spent: stop touching the disk. Missing files stay silent, everything else counts as skipped.
        if (this.bytesRead >= this.maxScanBytes) this.budgetHit = this.budgetHit ?? "bytes";
        r = readTextSafe(p, { ...opts, budgetBytes: 0 });
        if (!r.ok && r.reason === "budget") this.budgetSkipped++;
      } else {
        r = readTextSafe(p, { ...opts, budgetBytes: this.maxScanBytes - this.bytesRead });
        if (r.ok) this.bytesRead += r.bytes;
        else if (r.reason === "budget") {
          this.budgetHit = this.budgetHit ?? "bytes";
          this.budgetSkipped++;
        }
      }
      this.readCache.set(key, r);
      if (!r.ok && !opts.quiet && r.reason !== "missing" && r.reason !== "budget") this.warn(`${this.display(p)}: ${readFailWhy(r.reason, "skipped")}`);
    }
    return r;
  }

  /** Called once at the end of a scan: one summary warning when a whole-scan budget cut the scan short. */
  budgetSummary(): string | undefined {
    if (!this.budgetHit) return undefined;
    const what = this.budgetHit === "time" ? `${Math.round(this.maxScanMs / 1000)} s time budget` : `${Math.round(this.maxScanBytes / 1048576)} MiB read budget`;
    return `scan stopped at its ${what}${this.budgetSkipped ? `; ${this.budgetSkipped} file${this.budgetSkipped > 1 ? "s were" : " was"} not read` : ""}. Results are PARTIAL: totals are lower bounds. Scan a smaller folder, or raise the budget with --scan-budget-mb / --scan-budget-ms.`;
  }

  readJson(p: string): unknown | undefined {
    const r = this.read(p, { maxBytes: 64 * 1024 * 1024 });
    if (!r.ok) return undefined;
    try {
      return JSON.parse(r.text);
    } catch {
      this.warn(`${this.display(p)}: could not parse as JSON, skipped`);
      return undefined;
    }
  }

  count(key: string, text: string): number {
    let n = this.countCache.get(key);
    if (n === undefined) {
      n = this.counter.count(text);
      this.countCache.set(key, n);
    }
    return n;
  }

  addFinding(f: Finding, dedupeKey?: string): void {
    const k = dedupeKey ?? `${f.id}|${f.agent}|${f.paths.join(",")}|${f.message}`;
    if (this.findingKeys.has(k)) return;
    this.findingKeys.add(k);
    this.findings.push(f);
  }

  makeItem(a: {
    agent: AgentId;
    path: string;
    kind: ItemKind;
    scope: Scope;
    loadMode: LoadMode;
    raw: number | null; // raw token count, null => unmeasured
    unmeasuredReason?: string;
    chars?: number;
    lines?: number;
    confidence: Confidence;
    evidence: { docUrl: string; verifiedAt: string };
    notes?: string[];
    cardLabel: string;
    label: string;
    detail?: string;
    group?: string;
    groupLabel?: string;
  }): Item {
    const prof = this.profile(a.agent);
    return {
      id: `${a.agent}:${++this.seq}`,
      agent: a.agent,
      path: a.path,
      kind: a.kind,
      scope: a.scope,
      loadMode: a.loadMode,
      tokens: a.raw === null ? null : prof.apply(a.raw),
      ...(a.raw === null ? { unmeasuredReason: a.unmeasuredReason ?? "not measurable" } : {}),
      chars: a.chars ?? 0,
      lines: a.lines ?? 0,
      confidence: a.confidence,
      evidence: a.evidence,
      notes: a.notes ?? [],
      cardLabel: a.cardLabel,
      label: sanitize(a.label, 100),
      ...(a.detail ? { detail: a.detail } : {}),
      ...(a.group ? { group: a.group, groupLabel: a.groupLabel ?? a.group } : {}),
    };
  }

  /** Per-document analysis shared by all agents: secrets (F9), guideline length (F1), shingles for duplicates (F2). */
  analyzeDoc(agent: AgentId, filePath: string, rawText: string, processed: string, rawTokens: number, guidelineLines?: number): void {
    const real = realpathOrSelf(filePath);
    const lines = lineCount(rawText);
    const secretLines = findSecretLines(rawText);
    if (secretLines.length) {
      this.addFinding(
        {
          id: "F9",
          severity: "warn",
          agent: "all",
          message: `Possible secret on line${secretLines.length > 1 ? "s" : ""} ${secretLines.slice(0, 5).join(", ")}${secretLines.length > 5 ? ", …" : ""} of ${this.display(filePath)} (value not shown)`,
          paths: [filePath],
          confidence: "medium",
          data: { lines: secretLines.slice(0, 50) },
          fix: "Remove the secret from the instruction file and rotate it; agents send this file to a model provider.",
        },
        `F9|${real}`,
      );
    }
    if (guidelineLines && lines > guidelineLines) {
      this.addFinding({
        id: "F1",
        severity: "info",
        agent,
        message: `${this.display(filePath)} is ${lines} lines (documented guideline: under ${guidelineLines}); longer files can reduce adherence`,
        paths: [filePath],
        confidence: "medium",
        data: { fileLines: lines, guidelineLines },
        fix: "Split into scoped rules or move reference material out of the always-loaded file.",
      });
    }
    let info = this.docs.get(real);
    if (!info) {
      info = { path: filePath, tokens: rawTokens, shingles: shingles(processed), agents: new Set() };
      this.docs.set(real, info);
    }
    info.agents.add(agent);
  }
}

export function lineCount(text: string): number {
  if (!text) return 0;
  return text.replace(/\n$/, "").split("\n").length;
}

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function shingles(text: string, k = 5): Set<number> {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const out = new Set<number>();
  if (words.length < k) {
    if (words.length) out.add(fnv(words.join(" ")));
    return out;
  }
  for (let i = 0; i + k <= words.length; i++) out.add(fnv(words.slice(i, i + k).join(" ")));
  return out;
}

export function jaccard(a: Set<number>, b: Set<number>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [s, l] = a.size < b.size ? [a, b] : [b, a];
  for (const x of s) if (l.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
