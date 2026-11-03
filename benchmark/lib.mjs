// Shared helpers for the benchmark scripts. Not shipped in the npm package.
import { execFile } from "node:child_process";

/** Paths an agent may read from a repository (matched against `git ls-tree` output). */
const ROOT_DIRS = [".claude/", ".cursor/", ".github/instructions/", ".github/prompts/", ".gemini/", ".agents/", ".codex/"];
const BASENAMES = new Set(["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "AGENTS.override.md", "GEMINI.md", ".cursorrules", ".mcp.json"]);
const EXACT = new Set([".github/copilot-instructions.md", ".vscode/mcp.json", ".github/mcp.json"]);
const SKIP = /(^|\/)(node_modules|vendor|third_party|\.venv|dist|build)\//;

export function isAgentPath(p) {
  if (SKIP.test(p)) return false;
  if (EXACT.has(p)) return true;
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (BASENAMES.has(base)) return true;
  // agent folders at any depth (nested .claude/.cursor are read as conditional)
  return ROOT_DIRS.some((d) => p.startsWith(d) || p.includes("/" + d));
}

/** Files that count as "the repo has agent context" for sampling (the task's list). */
export function isMarker(p) {
  if (SKIP.test(p)) return false;
  return /(^|\/)(CLAUDE\.md|AGENTS\.md|GEMINI\.md|\.mcp\.json)$/.test(p) || p.startsWith(".cursor/rules/") || p === ".cursorrules" || p === ".github/copilot-instructions.md";
}

export function git(args, opts = {}) {
  return new Promise((resolve) => {
    const child = execFile("git", args, {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      timeout: opts.timeout ?? 180_000,
      cwd: opts.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    }, (error, stdout, stderr) => resolve({ ok: !error, out: stdout ?? "", err: (stderr ?? "") + (error ? String(error.message) : "") }));
    if (opts.input != null) { child.stdin.end(opts.input); }
  });
}

// Hardening for every clone: no symlinks materialised, no hooks, no submodules, no LFS, no file:// transport.
export const SAFE_GIT = ["-c", "core.symlinks=false", "-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never", "-c", "submodule.recurse=false", "-c", "filter.lfs.smudge=", "-c", "filter.lfs.process=", "-c", "filter.lfs.required=false"];

export function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
