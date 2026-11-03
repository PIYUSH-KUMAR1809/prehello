#!/usr/bin/env node
// Run the built prehello (dist/cli.js of this tree) on every collected repo, with an empty HOME.
// Usage: npm run build && node benchmark/run.mjs [--concurrency 6]
// Writes benchmark/data/results.jsonl (metadata and numbers only: no file contents, no finding texts)
// and benchmark/data/sources.jsonl (repo, commit sha and repo metadata).
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pool } from "./lib.mjs";
import { ALL_AGENTS } from "../dist/agents.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "dist", "cli.js");
const ci = process.argv.indexOf("--concurrency");
const CONC = ci > 0 ? Number(process.argv[ci + 1]) : 6;
const VERSION = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8")).version;
const checked = readFileSync(join(HERE, "data", "checked.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const hits = [...new Map(checked.filter((c) => c.hit).map((c) => [c.repo, c])).values()].sort((a, b) => a.repo.localeCompare(b.repo));

function prehello(dir, extra) {
  const home = mkdtempSync(join(tmpdir(), "prehello-bench-home-"));
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, dir, "--json", "--no-color", ...extra], {
      maxBuffer: 64 * 1024 * 1024, timeout: 120_000,
      // empty HOME (and USERPROFILE / XDG) so only the repository is measured
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), LANG: "C.UTF-8" },
    }, (err, stdout) => {
      rmSync(home, { recursive: true, force: true });
      const exit = err ? (typeof err.code === "number" ? err.code : -1) : 0;
      try { resolve({ exit, json: JSON.parse(stdout) }); } catch { resolve({ exit, json: null }); }
    });
  });
}

const slim = (it) => ({ kind: it.kind, scope: it.scope, loadMode: it.loadMode, path: it.path ?? null, label: it.kind === "mcp-server" ? it.label : undefined, est: it.tokens?.est ?? null, low: it.tokens?.low ?? null, high: it.tokens?.high ?? null, lines: it.lines, unmeasured: it.unmeasured });

// findings that must never be linked to a repo in published data: only a repo count is written (data/aggregate.json)
const AGGREGATE_ONLY = new Set(["F9"]);
const aggregate = Object.fromEntries([...AGGREGATE_ONLY].map((id) => [id, new Set()]));
const out = [];
await pool(hits, CONC, async (h) => {
  const dir = join(HERE, ".cache", h.repo.replace("/", "__"));
  if (!existsSync(dir)) { out.push({ repo: h.repo, error: "missing-checkout" }); return; }
  const [forced, auto] = await Promise.all([prehello(dir, ["--agent", ALL_AGENTS.join(",")]), prehello(dir, [])]);
  if (!forced.json) { out.push({ repo: h.repo, sha: h.sha, error: `no-json (exit ${forced.exit})` }); return; }
  const own = new Set((auto.json?.agents ?? []).map((a) => a.id));
  out.push({
    repo: h.repo, sha: h.sha, bucket: h.bucket, stars: h.stars, language: h.language,
    prehello: VERSION, exit: forced.exit, partial: forced.json.partial ?? null, warnings: forced.json.warnings.length,
    agents: forced.json.agents.map((a) => ({
      id: a.id, ownFiles: own.has(a.id), profile: a.profile?.id ?? null,
      always: a.totals.always, conditional: a.totals.conditional.est, deferred: a.totals.deferred.est, onDemand: a.totals["on-demand"].est,
      alwaysIsLowerBound: a.alwaysIsLowerBound, grade: a.grade?.letter ?? null,
      mcpServers: a.mcpServers?.length ?? 0, items: a.items.map(slim),
    })),
    // ids, agents, repo-relative paths and numeric facts only; aggregate-only findings (F9) are counted, never stored per repo
    findings: forced.json.findings.filter((f) => !AGGREGATE_ONLY.has(f.id) || (aggregate[f.id].add(h.repo), false)).map((f) => ({ id: f.id, agent: f.agent, paths: f.paths, data: f.data, savings: f.savingsTokens })),
    excluded: forced.json.excluded?.length ?? 0,
    // legacy single-file Cursor rules (not read by prehello's Cursor adapter): presence only
    cursorrules: existsSync(join(dir, ".cursorrules")),
  });
  if (out.length % 50 === 0) console.error(`${out.length}/${hits.length}`);
});
out.sort((a, b) => a.repo.localeCompare(b.repo));
writeFileSync(join(HERE, "data", "results.jsonl"), out.map((o) => JSON.stringify(o)).join("\n") + "\n");
writeFileSync(join(HERE, "data", "aggregate.json"), JSON.stringify({ note: "Counts only. Findings listed here are never recorded per repo.", findings: Object.fromEntries(Object.entries(aggregate).map(([id, set]) => [id, { repos: set.size }])) }, null, 2) + "\n");
const sources = hits.map((h) => ({ repo: h.repo, sha: h.sha, url: `https://github.com/${h.repo}/tree/${h.sha}`, bucket: h.bucket, stars: h.stars, language: h.language, createdAt: h.createdAt, pushedAt: h.pushedAt, checkedAt: h.checkedAt }));
writeFileSync(join(HERE, "data", "sources.jsonl"), sources.map((o) => JSON.stringify(o)).join("\n") + "\n");
console.error(`wrote ${out.length} results (${out.filter((o) => o.error).length} errors)`);
