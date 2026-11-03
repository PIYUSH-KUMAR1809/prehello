#!/usr/bin/env node
// Collect a stratified sample of public GitHub repositories that contain agent context files.
// Usage: node benchmark/collect.mjs [--seed 2026] [--per-bucket 110] [--take-per-query 25] [--concurrency 20]
// Reads only the GitHub REST search API (unauthenticated unless GITHUB_TOKEN is set) and git over HTTPS.
// Never runs repository code: clones are shallow (depth 1), blob-less, sparse, with symlinks, hooks,
// submodules and LFS disabled; only agent context paths (plus files they @import) are checked out.
import { mkdirSync, existsSync, readFileSync, appendFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { git, SAFE_GIT, isAgentPath, isMarker, mulberry32, sleep, pool } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const SEED = Number(arg("seed", 2026));
const PER_BUCKET = Number(arg("per-bucket", 110));
const CONC = Number(arg("concurrency", 20));
const TAKE = Number(arg("take-per-query", 25));
const PUSHED_SINCE = arg("pushed-since", "2026-08-01");
const MAX_SIZE_KB = 2_000_000; // repos above ~2 GB are skipped (tree download too slow); counted in checked.jsonl
const DATA = join(HERE, "data"), CACHE = join(HERE, ".cache");
mkdirSync(DATA, { recursive: true }); mkdirSync(CACHE, { recursive: true });

// Stars buckets and the width of the random "created" window used to page through each one.
export const BUCKETS = [
  { id: "20-99", lo: 20, hi: 99, days: 4 },
  { id: "100-499", lo: 100, hi: 499, days: 20 },
  { id: "500-1999", lo: 500, hi: 1999, days: 60 },
  { id: "2000-9999", lo: 2000, hi: 9999, days: 60 },
  { id: "10000+", lo: 10000, hi: null, days: 180 },
];
const rnd = mulberry32(SEED);
const FROM = Date.parse("2010-01-01"), TO = Date.parse("2026-07-31");

const read = (f) => existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const log = (f, o) => appendFileSync(join(DATA, f), JSON.stringify(o) + "\n");
const checked = new Map(read(join(DATA, "checked.jsonl")).map((c) => [c.repo, c]));
const queries = read(join(DATA, "queries.jsonl"));

let nextSearchAt = 0;
async function search(q) {
  const wait = nextSearchAt - Date.now(); if (wait > 0) await sleep(wait);
  const headers = { "User-Agent": "prehello-benchmark", Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  for (;;) {
    nextSearchAt = Date.now() + (process.env.GITHUB_TOKEN ? 2_100 : 6_500); // 30/min auth, 10/min anon
    let r;
    try { r = await fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=100`, { headers }); }
    catch (e) { console.error(`search network error (${e.cause?.code ?? e.message}); retrying in 15 s`); await sleep(15_000); continue; }
    if (r.status === 403 || r.status === 429) {
      const reset = Number(r.headers.get("x-ratelimit-reset") ?? 0) * 1000;
      await sleep(Math.max(10_000, reset - Date.now() + 1_000)); continue;
    }
    if (!r.ok) throw new Error(`search ${r.status}: ${await r.text()}`);
    return r.json();
  }
}

function windowFor(b) {
  const span = b.days * 86400_000;
  const start = FROM + Math.floor(rnd() * (TO - FROM - span));
  const d = (t) => new Date(t).toISOString().slice(0, 10);
  return `${d(start)}..${d(start + span)}`;
}

async function check(repo, bucket) {
  const dir = join(CACHE, repo.full_name.replace("/", "__"));
  const rec = { repo: repo.full_name, bucket: bucket.id, stars: repo.stargazers_count, checkedAt: new Date().toISOString() };
  if (repo.size > MAX_SIZE_KB) return { ...rec, hit: false, skipped: "size" };
  rmSync(dir, { recursive: true, force: true });
  const url = `https://github.com/${repo.full_name}.git`;
  const c = await git([...SAFE_GIT, "clone", "--quiet", "--depth", "1", "--filter=blob:none", "--no-checkout", "--single-branch", url, dir], { timeout: 240_000 });
  if (!c.ok) { rmSync(dir, { recursive: true, force: true }); return { ...rec, hit: false, skipped: "clone-failed" }; }
  // no %(objectsize): asking for blob sizes would make the blob-less clone fetch every blob
  const ls = await git(["ls-tree", "-r", "-z", "--full-tree", "HEAD"], { cwd: dir });
  const entries = ls.out.split("\0").filter(Boolean).map((l) => { const tab = l.indexOf("\t"); return { mode: l.slice(0, l.indexOf(" ")), path: l.slice(tab + 1) }; });
  const markers = entries.filter((e) => isMarker(e.path));
  if (!markers.length) { rmSync(dir, { recursive: true, force: true }); return { ...rec, hit: false }; }
  const sha = (await git(["rev-parse", "HEAD"], { cwd: dir })).out.trim();
  const byPath = new Map(entries.map((e) => [e.path, e]));
  // regular files only (no symlinks, no submodules); files over 4 MiB are not read by prehello anyway
  const want = new Set(entries.filter((e) => isAgentPath(e.path) && e.mode.startsWith("100")).map((e) => e.path));
  const checkout = async () => {
    await git([...SAFE_GIT, "sparse-checkout", "set", "--no-cone", "--stdin"], { cwd: dir, input: [...want].map((p) => "/" + p.replace(/([*?[\]!\\])/g, "\\$1")).join("\n") + "\n" });
    return git([...SAFE_GIT, "checkout", "--quiet", "HEAD"], { cwd: dir, timeout: 240_000 });
  };
  await checkout();
  // one extra pass: files that checked-out markdown references with @path (CLAUDE.md / GEMINI.md imports)
  const extra = new Set();
  for (const p of want) {
    if (!/\.md$/i.test(p)) continue;
    let text = ""; try { text = readFileSync(join(dir, p), "utf8"); } catch { continue; }
    for (const m of text.matchAll(/(?:^|\s)@([A-Za-z0-9_.\-/]+[A-Za-z0-9_\-/])/g)) {
      const t = normalize(join(dirname(p), m[1])).replace(/^\.\//, "");
      const e = byPath.get(t);
      if (e && !t.startsWith("..") && e.mode.startsWith("100") && !want.has(t)) extra.add(t);
    }
  }
  if (extra.size) { for (const t of [...extra].slice(0, 300)) want.add(t); await checkout(); }
  return {
    ...rec, hit: true, sha, defaultBranch: repo.default_branch, language: repo.language ?? null,
    createdAt: repo.created_at, pushedAt: repo.pushed_at, sizeKb: repo.size,
    markers: [...new Set(markers.map((m) => m.path))].length, agentFiles: want.size, importedFiles: extra.size, treeEntries: entries.length,
  };
}

async function main() {
  // resume: replay the random draws of the queries already made, so a resumed run continues the same sequence
  for (const b of BUCKETS) for (const q of queries.filter((x) => x.bucket === b.id)) { windowFor(b); for (let i = 0; i < (q.eligible ?? 0) - 1; i++) rnd(); }
  const hits = (b) => [...checked.values()].filter((c) => c.bucket === b && c.hit).length;
  for (const b of BUCKETS) {
    while (hits(b.id) < PER_BUCKET) {
      const created = windowFor(b);
      const q = `stars:${b.hi ? `${b.lo}..${b.hi}` : `>=${b.lo}`} pushed:>=${PUSHED_SINCE} created:${created} fork:false archived:false`;
      const res = await search(q);
      const eligible = res.items.filter((r) => !checked.has(r.full_name) && !r.fork && !r.archived && !r.is_template);
      // take a seeded random subset per query, so no single created-date window dominates a bucket
      for (let i = eligible.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [eligible[i], eligible[j]] = [eligible[j], eligible[i]]; }
      const fresh = eligible.slice(0, TAKE);
      const qrec = { bucket: b.id, q, totalCount: res.total_count, returned: res.items.length, eligible: eligible.length, taken: fresh.length, at: new Date().toISOString() };
      queries.push(qrec); log("queries.jsonl", qrec);
      await pool(fresh, CONC, async (r) => {
        if (hits(b.id) >= PER_BUCKET) return;
        const c = await check(r, b);
        if (checked.has(c.repo)) return;
        checked.set(c.repo, c); log("checked.jsonl", c);
      });
      console.error(`[${b.id}] ${created} total=${res.total_count} fresh=${fresh.length} hits=${hits(b.id)}/${PER_BUCKET} checked=${[...checked.values()].filter((c) => c.bucket === b.id).length}`);
    }
  }
  console.error("done");
}
main().catch((e) => { console.error(e); process.exit(1); });
