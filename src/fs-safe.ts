/**
 * The ONLY module that touches the filesystem for scanning. It exposes read-only operations;
 * nothing in the scan path may call a write API (enforced by test/safety.test.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { isInsideWith } from "./platform";

/**
 * Per-file read cap. 4 MiB is Claude Code's documented limit for startup CLAUDE.md files ("Claude Code skips a file over
 * 4 MiB and loads none of it"), so for Claude Code a skipped file here is a file the agent skips too. For other agents it is
 * a generic safety cap (Codex has its own, much smaller, project_doc_max_bytes that the Codex adapter models separately).
 */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** Whole-scan budgets (a safety net against pathological trees, not a feature knob). Bytes are deterministic; the clock is not. */
export const DEFAULT_MAX_SCAN_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_SCAN_MS = 20_000;
export const MAX_WALK_ENTRIES = 5000;
export const MAX_WALK_DEPTH = 8;
const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "target", ".next", ".nuxt", ".venv", "venv", "__pycache__",
  "vendor", ".cache", "coverage", ".gradle", ".idea", ".tox", ".turbo",
]);

export type ReadFail = "missing" | "utf16" | "too-large" | "binary" | "unreadable" | "not-file" | "symlink-escape" | "budget";
export type ReadResult =
  | { ok: true; text: string; bytes: number; realPath: string }
  | { ok: false; reason: ReadFail; detail?: string };

/**
 * Canonical path. Uses the OS-native realpath where available so that on case-insensitive filesystems
 * (macOS APFS default, Windows NTFS) `claude.md` and `CLAUDE.md`, or a `/var` -> `/private/var` alias,
 * resolve to ONE path and are never counted twice.
 */
export function realpathOrSelf(p: string): string {
  try {
    return (fs.realpathSync.native ?? fs.realpathSync)(p);
  } catch {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  }
}

export function isInside(child: string, parent: string): boolean {
  return isInsideWith(path, child, parent);
}

export function exists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Sorted directory entries, or [] if unreadable. */
export function listDir(p: string): fs.Dirent[] {
  try {
    return fs.readdirSync(p, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return [];
  }
}

/**
 * Read a text file defensively. `jail`: if given, the file's real path must be inside it
 * (blocks symlinks in untrusted project trees that point at e.g. ~/.ssh).
 */
export function readTextSafe(p: string, opts: { jail?: string; maxBytes?: number; budgetBytes?: number } = {}): ReadResult {
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? { ok: false, reason: "missing" } : { ok: false, reason: "unreadable", detail: String(code) };
  }
  if (!st.isFile()) return { ok: false, reason: "not-file" };
  const real = realpathOrSelf(p);
  if (opts.jail && !isInside(real, realpathOrSelf(opts.jail))) return { ok: false, reason: "symlink-escape" };
  if (st.size > (opts.maxBytes ?? MAX_FILE_BYTES)) return { ok: false, reason: "too-large", detail: `${st.size} bytes` };
  if (opts.budgetBytes !== undefined && st.size > opts.budgetBytes) return { ok: false, reason: "budget", detail: `${st.size} bytes` };
  let buf: Buffer;
  try {
    buf = fs.readFileSync(p);
  } catch (e) {
    return { ok: false, reason: "unreadable", detail: String((e as NodeJS.ErrnoException).code) };
  }
  // Windows PowerShell 5 writes UTF-16 with a BOM for `echo x > AGENTS.md`; agents read these files as UTF-8, so say so instead of "binary".
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return { ok: false, reason: "utf16" };
  if (buf.subarray(0, 8000).includes(0)) return { ok: false, reason: "binary" };
  let text = buf.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n?/g, "\n");
  return { ok: true, text, bytes: buf.length, realPath: real };
}

export interface WalkHit {
  dir: string; // absolute
  names: string[]; // matched candidate file names/relative paths present in dir
}

export interface WalkOpts {
  timeUp?: () => boolean;
  /**
   * Directories this returns true for are not descended into (and not searched for candidates); they are reported in `skipped`.
   * `rel` is the directory's path segments below the walk root (its own name last).
   */
  skipDir?: (name: string, rel: string[]) => boolean;
  /** Also look for candidates in the root itself (default: only in directories below it). */
  includeRoot?: boolean;
  /** Entry budget (default MAX_WALK_ENTRIES). */
  maxEntries?: number;
  /** Stop as soon as one directory with a candidate is found (used to probe skipped folders cheaply). */
  stopAtFirstHit?: boolean;
}

/**
 * Bounded project walk (no symlink following, ignores build dirs, dot-dirs, ≤5k entries, depth ≤ 8).
 * Returns directories (other than root) that contain any of the candidate relative paths.
 */
export function walkForFiles(root: string, candidates: string[], opts: WalkOpts = {}): { hits: WalkHit[]; truncated: boolean; timedOut: boolean; entries: number; skipped: string[] } {
  const hits: WalkHit[] = [];
  const skipped: string[] = [];
  const maxEntries = opts.maxEntries ?? MAX_WALK_ENTRIES;
  let seen = 0;
  let truncated = false;
  let timedOut = false;
  const visit = (dir: string, depth: number, rel: string[]) => {
    if (truncated || timedOut || (opts.stopAtFirstHit && hits.length)) return;
    if (opts.timeUp?.()) {
      timedOut = true;
      return;
    }
    const entries = listDir(dir);
    seen += entries.length;
    if (seen > maxEntries) {
      truncated = true;
      return;
    }
    if (dir !== root || opts.includeRoot) {
      // a trailing "/" in a candidate means "a directory with this relative path"
      const present = candidates.filter((c) => (c.endsWith("/") ? isDir(path.join(dir, c)) : isFile(path.join(dir, c))) && !isSymlink(path.join(dir, c)));
      if (present.length) hits.push({ dir, names: present });
    }
    if (depth >= MAX_WALK_DEPTH) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (IGNORE_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      const childRel = [...rel, e.name];
      if (opts.skipDir?.(e.name, childRel)) {
        skipped.push(path.join(dir, e.name));
        continue;
      }
      visit(path.join(dir, e.name), depth + 1, childRel);
    }
  };
  visit(root, 0, []);
  return { hits, truncated, timedOut, entries: Math.min(seen, maxEntries), skipped };
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Find the nearest ancestor (inclusive) containing `.git`. */
export function findGitRoot(start: string, ceiling?: string): string | undefined {
  let dir = start;
  for (;;) {
    if (exists(path.join(dir, ".git"))) return dir;
    if (ceiling && dir === ceiling) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Is an executable named `name` on the given PATH string? (read-only stat calls)
 * On Windows the binary is `claude.exe` / `claude.cmd` (npm shims), never bare `claude`, so PATHEXT is honoured.
 */
export function onPath(name: string, pathVar: string | undefined, opts: { platform?: NodeJS.Platform; pathExt?: string } = {}): boolean {
  if (!pathVar) return false;
  const win = opts.platform === "win32";
  const delim = opts.platform ? (win ? ";" : ":") : path.delimiter;
  const exts = win ? ["", ...(opts.pathExt || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((e) => e.toLowerCase()), ".ps1"] : [""];
  for (const d of pathVar.split(delim)) {
    if (!d) continue;
    for (const e of exts) if (isFile(path.join(d, name + e))) return true;
  }
  return false;
}
