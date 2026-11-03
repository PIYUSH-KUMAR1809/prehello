#!/usr/bin/env node
// Measure the Claude/o200k token ratio on real files, to refresh spec/calibration.json. Dev-only (not shipped).
//
//   node scripts/calibrate-anthropic.mjs --dry-run FILE...            o200k counts only, no network
//   ANTHROPIC_API_KEY=... node scripts/calibrate-anthropic.mjs [--model claude-opus-5] FILE...
//                                                                     exact counts from POST /v1/messages/count_tokens (free)
//   node scripts/calibrate-anthropic.mjs --claude-cli FILE...         differential via `claude -p` (uses your Claude Code login;
//                                                                     each file costs one short request on your plan)
//
// Files ending in .json/.yaml/.yml/.toml are counted as "json", everything else as "markdown". Prints per-file ratios,
// the token-weighted ratio per kind, and a JSON block to paste into spec/calibration.json (byKind.<kind>.points).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { encode } from "gpt-tokenizer/encoding/o200k_base";

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const flag = (n) => { const i = args.indexOf(n); if (i < 0) return false; args.splice(i, 1); return true; };
const model = opt("--model") ?? "claude-opus-5";
const dry = flag("--dry-run");
const cli = flag("--claude-cli");
const files = args;
if (!files.length) {
  console.error("usage: node scripts/calibrate-anthropic.mjs [--dry-run | --claude-cli] [--model id] FILE...");
  process.exit(2);
}
const key = process.env.ANTHROPIC_API_KEY;
if (!dry && !cli && !key) {
  console.error("set ANTHROPIC_API_KEY (count_tokens is free), or pass --claude-cli or --dry-run");
  process.exit(2);
}
const kindOf = (f) => (/\.(json|ya?ml|toml)$/i.test(f) ? "json" : "markdown");

async function apiCount(text) {
  const res = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: text }] }),
  });
  if (!res.ok) throw new Error(`count_tokens ${res.status}: ${await res.text()}`);
  return (await res.json()).input_tokens;
}
function cliCount(text) {
  const out = JSON.parse(execFileSync("claude", ["-p", "--output-format", "json", "--model", model, "Reply with OK."], { input: text, encoding: "utf8", maxBuffer: 64 << 20 }));
  const u = out.usage ?? {};
  return (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
}
const count = async (t) => (cli ? cliCount(t) : apiCount(t));

let base = 0;
if (!dry) base = await count("x"); // fixed per-request overhead (message wrapper, or Claude Code's system prompt for --claude-cli)
const rows = [];
for (const f of files) {
  const text = fs.readFileSync(f, "utf8");
  const o200k = encode(text).length;
  const claude = dry ? null : (await count(text)) - base + encode("x").length;
  rows.push({ file: path.basename(f), kind: kindOf(f), o200k, claude, ratio: claude ? +(claude / o200k).toFixed(3) : null });
  console.log(`${path.basename(f).padEnd(40)} ${kindOf(f).padEnd(9)} o200k ${String(o200k).padStart(7)}  claude ${String(claude ?? "-").padStart(7)}  ratio ${rows.at(-1).ratio ?? "-"}`);
}
if (dry) process.exit(0);
const today = new Date().toISOString().slice(0, 10);
const points = {};
for (const k of ["markdown", "json"]) {
  const r = rows.filter((x) => x.kind === k && x.o200k > 0);
  if (!r.length) continue;
  const o = r.reduce((s, x) => s + x.o200k, 0), c = r.reduce((s, x) => s + x.claude, 0);
  points[k] = { ratio: +(c / o).toFixed(3), files: r.length, o200k: o, claude: c, model, method: cli ? "claude -p differential" : "count_tokens", measuredAt: today };
  console.log(`\n${k}: ${r.length} file(s), weighted ratio ${points[k].ratio}`);
}
console.log("\nPaste into spec/calibration.json -> claude.byKind.<kind>.points:\n" + JSON.stringify(points, null, 2));
