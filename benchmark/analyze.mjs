#!/usr/bin/env node
// Summarise benchmark/data/results.jsonl into benchmark/data/summary.json and SVG charts in benchmark/charts/.
// Usage: node benchmark/analyze.mjs   (no network; deterministic for a given results.jsonl)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { quantile } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const lines = (f) => existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const all = lines(join(HERE, "data", "results.jsonl"));
const results = all.filter((r) => !r.error);
const checked = [...new Map(lines(join(HERE, "data", "checked.jsonl")).map((c) => [c.repo, c])).values()];
const queries = lines(join(HERE, "data", "queries.jsonl"));
const BUCKETS = ["20-99", "100-499", "500-1999", "2000-9999", "10000+"];
const AGENTS = ["claude-code", "cursor", "codex", "github-copilot", "gemini-cli"];
const NAMES = { "claude-code": "Claude Code", cursor: "Cursor", codex: "Codex", "github-copilot": "GitHub Copilot", "gemini-cli": "Gemini CLI" };
const THRESHOLDS = [1000, 2000, 5000, 10000, 20000];
const pct = (n, d) => d ? Math.round((n / d) * 1000) / 10 : null;
const round = (x) => x == null ? null : Math.round(x);
const norm = (p) => (p ?? "").replace(/^\.\//, "");

function stats(values) {
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, median: round(quantile(s, 0.5)), p90: round(quantile(s, 0.9)), max: s.length ? s[s.length - 1] : null, mean: s.length ? round(s.reduce((a, b) => a + b, 0) / s.length) : null };
}

/** Which kind of source an always-on item is (for "biggest contributors"). */
function category(it) {
  const p = norm(it.path);
  if (it.kind === "mcp-server") return "MCP servers";
  if (it.kind === "skills-listing") return "Skills listing";
  if (it.kind === "subagents") return "Subagents listing";
  if (/(^|\/)\.cursor\/rules\//.test(p) || it.kind === "rule-description") return ".cursor/rules";
  if (/(^|\/)\.claude\/rules\//.test(p)) return ".claude/rules";
  if (/(^|\/)\.github\/instructions\//.test(p)) return ".github/instructions";
  if (/copilot-instructions\.md$/.test(p)) return "copilot-instructions.md";
  if (/(^|\/)(\.claude\/)?CLAUDE(\.local)?\.md$/.test(p)) return "CLAUDE.md";
  if (/(^|\/)AGENTS(\.override)?\.md$/.test(p)) return "AGENTS.md";
  if (/(^|\/)GEMINI\.md$/.test(p)) return "GEMINI.md";
  if (it.kind === "instructions" || it.kind === "memory") return "Imported files (@path)";
  return "Other";
}

const summary = { generatedFrom: "benchmark/data/results.jsonl", prehello: results[0]?.prehello ?? null, repos: results.length, errors: all.length - results.length };

// --- sample and prevalence
const qByBucket = Object.fromEntries(BUCKETS.map((b) => [b, queries.filter((q) => q.bucket === b).length]));
summary.sample = BUCKETS.map((b) => {
  const c = checked.filter((x) => x.bucket === b), usable = c.filter((x) => !x.skipped);
  const hits = c.filter((x) => x.hit).length;
  return { bucket: b, searches: qByBucket[b], checked: usable.length, skipped: c.length - usable.length, withAgentFiles: hits, prevalencePct: pct(hits, usable.length), analysed: results.filter((r) => r.bucket === b).length };
});
const totChecked = summary.sample.reduce((a, s) => a + s.checked, 0), totHits = summary.sample.reduce((a, s) => a + s.withAgentFiles, 0);
summary.prevalenceAllPct = pct(totHits, totChecked);

// --- file presence (repo root unless noted)
const has = (r, re) => r.agents.some((a) => a.items.some((i) => re.test(norm(i.path))));
const presence = {
  "CLAUDE.md (any depth)": /(^|\/)(\.claude\/)?CLAUDE\.md$/, "AGENTS.md (any depth)": /(^|\/)AGENTS\.md$/, ".cursor/rules": /(^|\/)\.cursor\/rules\//,
  ".github/copilot-instructions.md": /^\.github\/copilot-instructions\.md$/, ".github/instructions": /^\.github\/instructions\//, "GEMINI.md (any depth)": /(^|\/)GEMINI\.md$/,
  ".mcp.json": /(^|\/)\.mcp\.json$/, "skills folder (.claude, .agents, .cursor, .gemini)": /(^|\/)\.(claude|agents|cursor|gemini)\/skills(\/|$)/, ".claude/rules": /(^|\/)\.claude\/rules\//,
};
summary.presence = Object.fromEntries(Object.entries(presence).map(([k, re]) => [k, { repos: results.filter((r) => has(r, re)).length, pct: pct(results.filter((r) => has(r, re)).length, results.length) }]));
// .cursorrules is not read by prehello's Cursor adapter (legacy); run.mjs records its presence only
{ const n = results.filter((r) => r.cursorrules).length; summary.presence[".cursorrules at root (legacy, not counted)"] = { repos: n, pct: pct(n, results.length) }; }

// --- per-agent distributions of the always-on estimate
summary.perAgent = Object.fromEntries(AGENTS.map((id) => {
  const rows = results.map((r) => r.agents.find((a) => a.id === id)).filter(Boolean);
  const own = rows.filter((a) => a.ownFiles);
  const nonZero = rows.filter((a) => a.always.est > 0);
  const dist = (rs) => ({ ...stats(rs.map((a) => a.always.est)), over: Object.fromEntries(THRESHOLDS.map((t) => [t, pct(rs.filter((a) => a.always.est > t).length, rs.length)])), lowerBoundPct: pct(rs.filter((a) => a.alwaysIsLowerBound).length, rs.length) });
  return [id, { name: NAMES[id], profile: rows[0]?.profile ?? null, allRepos: dist(rows), reposWithOwnFiles: dist(own), reposWithAnyAlwaysOn: dist(nonZero), conditional: stats(rows.map((a) => a.conditional).filter((x) => x > 0)), deferred: stats(rows.map((a) => a.deferred).filter((x) => x > 0)) }];
}));

// --- biggest contributors (sum of always-on central estimates, per agent)
summary.contributors = Object.fromEntries(AGENTS.map((id) => {
  const sums = {}; let total = 0;
  for (const r of results) for (const a of r.agents) if (a.id === id) for (const it of a.items) if (it.loadMode === "always" && it.est != null) { const c = category(it); sums[c] = (sums[c] ?? 0) + it.est; total += it.est; }
  return [id, Object.fromEntries(Object.entries(sums).sort((x, y) => y[1] - x[1]).map(([k, v]) => [k, { tokens: v, sharePct: pct(v, total) }]))];
}));

// --- largest single always-on files (Claude Code view, repo-relative path category only)
const sizes = []; for (const r of results) for (const a of r.agents) for (const it of a.items) if (it.loadMode === "always" && it.kind !== "mcp-server" && it.est != null) sizes.push({ agent: a.id, est: it.est, lines: it.lines, cat: category(it) });
summary.singleFile = { overLines: Object.fromEntries([200, 500, 1000].map((n) => [n, new Set(results.filter((r) => r.agents.some((a) => a.items.some((i) => i.loadMode === "always" && i.kind !== "mcp-server" && i.lines > n))).map((r) => r.repo)).size])) };

// --- MCP
const mcpRepos = results.filter((r) => r.agents.some((a) => a.items.some((i) => i.kind === "mcp-server")));
const serverNames = {};
for (const r of mcpRepos) { const names = new Set(); for (const a of r.agents) for (const i of a.items) if (i.kind === "mcp-server") { const m = /MCP (?:server )?"([^"]+)"/.exec(i.label ?? ""); if (m) names.add(m[1].toLowerCase()); } for (const n of names) serverNames[n] = (serverNames[n] ?? 0) + 1; }
const cc = (r) => r.agents.find((a) => a.id === "claude-code");
const ccMcp = mcpRepos.map((r) => cc(r)).filter(Boolean);
summary.mcp = {
  repos: mcpRepos.length, pct: pct(mcpRepos.length, results.length),
  serversPerRepo: stats(mcpRepos.map((r) => Math.max(...r.agents.map((a) => a.mcpServers)))),
  claudeCodeMcpItemsUnmeasuredPct: pct(ccMcp.flatMap((a) => a.items.filter((i) => i.kind === "mcp-server")).filter((i) => i.unmeasured).length, ccMcp.flatMap((a) => a.items.filter((i) => i.kind === "mcp-server")).length),
  topServers: Object.entries(serverNames).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 15).map(([name, repos]) => ({ name, repos })),
};

// --- common mistakes (repos with at least one finding of that id)
// aggregate-only findings (F9) come from data/aggregate.json; results.jsonl never names those repos
const aggregate = existsSync(join(HERE, "data", "aggregate.json")) ? JSON.parse(readFileSync(join(HERE, "data", "aggregate.json"), "utf8")) : { findings: {} };
const FINDINGS = { F1: "file longer than the documented guideline", F2: "near-duplicate instruction files", F4: "skill description over the listing cap", F5: "always-on item that cannot be measured", F7: "AGENTS.md ignored by Claude Code (CLAUDE.md present)", F9: "possible secret in an agent file", F11: ".cursor/rules file Cursor ignores (.md, not .mdc)", F12: "AGENTS.md chain truncated by Codex (32 KiB)", F13: "skills listing over the agent's budget" };
summary.mistakes = Object.fromEntries(Object.entries(FINDINGS).map(([id, what]) => { const n = aggregate.findings?.[id]?.repos ?? results.filter((r) => r.findings.some((f) => f.id === id)).length; return [id, { what, repos: n, pct: pct(n, results.length) }]; }));
const bothRoot = results.filter((r) => has(r, /^(\.claude\/)?CLAUDE\.md$/) && has(r, /^AGENTS\.md$/));
const dupPair = results.filter((r) => r.findings.some((f) => f.id === "F2" && f.paths?.some((p) => /CLAUDE\.md$/.test(p)) && f.paths?.some((p) => /AGENTS\.md$/.test(p))));
summary.mistakes.claudeAndAgentsAtRoot = { what: "CLAUDE.md and AGENTS.md both at the repo root", repos: bothRoot.length, pct: pct(bothRoot.length, results.length) };
summary.mistakes.claudeAgentsNearDuplicate = { what: "a CLAUDE.md / AGENTS.md pair flagged as near-duplicate (F2)", repos: dupPair.length, pct: pct(dupPair.length, results.length) };

// --- stars vs size (Spearman rank correlation, max always-on over agents)
const rank = (xs) => { const idx = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]); const r = new Array(xs.length); for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1; i = j + 1; } return r; };
const pearson = (a, b) => { const n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n; let num = 0, da = 0, db = 0; for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return num / Math.sqrt(da * db); };
const maxAlways = (r) => Math.max(...r.agents.map((a) => a.always.est));
summary.stars = {
  spearmanStarsVsMaxAlwaysOn: Math.round(pearson(rank(results.map((r) => r.stars)), rank(results.map(maxAlways))) * 1000) / 1000,
  medianMaxAlwaysOnByBucket: Object.fromEntries(BUCKETS.map((b) => [b, stats(results.filter((r) => r.bucket === b).map(maxAlways))])),
};
summary.maxAlwaysOnAnyAgent = stats(results.map(maxAlways));
summary.exitCodes = results.reduce((m, r) => ({ ...m, [r.exit]: (m[r.exit] ?? 0) + 1 }), {});
summary.partialRuns = results.filter((r) => r.partial).length;
summary.pluginLeaderboard = "skipped: repositories do not install plugins; plugin weights need real user setups (not collected)";

writeFileSync(join(HERE, "data", "summary.json"), JSON.stringify(summary, null, 2) + "\n");

// --- charts (plain SVG, no dependencies)
mkdirSync(join(HERE, "charts"), { recursive: true });
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const svg = (w, h, body, title) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="Inter, Helvetica, Arial, sans-serif" font-size="13"><rect width="100%" height="100%" fill="#fff"/><text x="20" y="28" font-size="16" font-weight="bold">${esc(title)}</text>${body}<text x="20" y="${h - 10}" font-size="11" fill="#666">prehello benchmark, ${results.length} public repos, repo files only, estimates (see docs/BENCHMARK.md)</text></svg>\n`;
const fmt = (n) => n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);

function hbar(file, title, rows, unit = "") {
  const w = 760, rowH = 26, top = 50, left = 250, h = top + rows.length * rowH + 40, max = Math.max(...rows.map((r) => r.v), 1);
  const body = rows.map((r, i) => { const y = top + i * rowH, bw = ((w - left - 90) * r.v) / max; return `<text x="${left - 10}" y="${y + 16}" text-anchor="end">${esc(r.k)}</text><rect x="${left}" y="${y + 4}" width="${bw.toFixed(1)}" height="16" fill="#3b6fd6"/><text x="${left + bw + 6}" y="${y + 16}">${esc(r.label ?? fmt(r.v) + unit)}</text>`; }).join("");
  writeFileSync(join(HERE, "charts", file), svg(w, h, body, title));
}

// 1. median / p90 always-on per agent (repos where the agent has its own files)
{
  const rows = AGENTS.map((id) => ({ id, ...summary.perAgent[id].reposWithOwnFiles }));
  const w = 760, top = 60, left = 170, rowH = 40, h = top + rows.length * rowH + 50;
  const max = Math.max(...rows.map((r) => r.p90 ?? 0), 1);
  const x = (v) => left + ((w - left - 120) * v) / max;
  const body = `<text x="${left}" y="48" fill="#444">dark: median, light: 90th percentile (always-on tokens, central estimate)</text>` + rows.map((r, i) => { const y = top + i * rowH; return `<text x="${left - 10}" y="${y + 20}" text-anchor="end">${esc(NAMES[r.id])} (n=${r.n})</text>${r.n ? `<rect x="${left}" y="${y + 6}" width="${(x(r.p90) - left).toFixed(1)}" height="20" fill="#b9ccf2"/><rect x="${left}" y="${y + 6}" width="${(x(r.median) - left).toFixed(1)}" height="20" fill="#3b6fd6"/><text x="${x(r.p90) + 6}" y="${y + 20}">${fmt(r.median)} / ${fmt(r.p90)}</text>` : `<text x="${left}" y="${y + 20}" fill="#666">no repos</text>`}`; }).join("");
  writeFileSync(join(HERE, "charts", "always-on-by-agent.svg"), svg(w, h, body, "Always-on context per agent (repos with that agent's files)"));
}
// 2. histogram of max always-on (log bins)
{
  const bins = [[0, 250], [250, 500], [500, 1000], [1000, 2000], [2000, 5000], [5000, 10000], [10000, 20000], [20000, Infinity]];
  const vals = results.map(maxAlways);
  hbar("always-on-histogram.svg", "Repos by always-on size (largest agent per repo)", bins.map(([a, b]) => { const n = vals.filter((v) => v >= a && v < b).length; return { k: b === Infinity ? `${fmt(a)}+ tokens` : `${fmt(a)}-${fmt(b)} tokens`, v: n, label: `${n} (${pct(n, vals.length)}%)` }; }));
}
// 3. contributors for Claude Code and Cursor
for (const id of ["claude-code", "cursor", "github-copilot"]) hbar(`contributors-${id}.svg`, `${NAMES[id]}: where the always-on tokens come from (all repos)`, Object.entries(summary.contributors[id]).slice(0, 10).map(([k, v]) => ({ k, v: v.tokens, label: `${v.sharePct}%` })));
// 4. mistakes
hbar("mistakes.svg", "Share of repos with each issue", Object.values(summary.mistakes).filter((m) => m.repos > 0).sort((a, b) => b.repos - a.repos).map((m) => ({ k: m.what.length > 34 ? m.what.slice(0, 33) + "…" : m.what, v: m.repos, label: `${m.pct}% (${m.repos})` })));
// 5. stars buckets
hbar("by-stars.svg", "Median always-on size by stars bucket (largest agent per repo)", BUCKETS.map((b) => ({ k: `${b} stars (n=${summary.stars.medianMaxAlwaysOnByBucket[b].n})`, v: summary.stars.medianMaxAlwaysOnByBucket[b].median ?? 0 })), " tokens");
// 6. prevalence
hbar("prevalence.svg", "Share of sampled active repos with agent context files", summary.sample.map((s) => ({ k: `${s.bucket} stars`, v: s.prevalencePct ?? 0, label: `${s.prevalencePct}% (${s.withAgentFiles}/${s.checked})` })));

// PNG copies, rendered with prehello's own engine and bundled font (optional dependency @resvg/resvg-wasm; needs `npm run build`)
try {
  const { svgToPng } = await import("../dist/render/png.js");
  const { readdirSync } = await import("node:fs");
  for (const f of readdirSync(join(HERE, "charts")).filter((x) => x.endsWith(".svg"))) {
    writeFileSync(join(HERE, "charts", f.replace(/\.svg$/, ".png")), await svgToPng(readFileSync(join(HERE, "charts", f), "utf8"), { scale: 1, version: summary.prehello ?? "0" }));
  }
} catch (e) { console.error(`PNG charts skipped: ${e.message}`); }

console.log(JSON.stringify({ repos: summary.repos, prevalenceAllPct: summary.prevalenceAllPct, perAgent: Object.fromEntries(AGENTS.map((id) => [id, summary.perAgent[id].reposWithOwnFiles])) }, null, 1));
