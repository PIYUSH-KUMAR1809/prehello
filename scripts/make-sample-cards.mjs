// Dev-only helper (not part of the package): builds synthetic "heavy" worlds in a temp dir and renders PNG/SVG cards from them,
// so card layouts can be eyeballed, and regenerates the README sample cards. All content is invented.
// Usage: node scripts/make-sample-cards.mjs <outDir> [--gallery]   (run `npm run build` first)
//   <outDir>/sample-card-fixture.{svg,png}, sample-card-fixture-square-light.png  from test/fixtures/plugin-heavy
//   <outDir>/sample-card-cursor.png                                              from a Cursor world shaped like a real Mac scan
//   <outDir>/sample-card-heavy.png                                               from a synthetic heavy Claude Code world
//   --gallery: also every theme/size/headline combination of the heavy world under <outDir>/gallery/, plus a Cursor world shaped like a
//              real Mac (one big plugin, one small plugin, a folder of Cursor-managed skills) under <outDir>/gallery/cursor-*.png
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.resolve(process.argv[2] ?? "sample-cards");
fs.mkdirSync(out, { recursive: true });
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "prehello-sample-")));
const put = (base, rel, text) => {
  const p = path.join(base, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const words = "use strict typescript tests before pushing prefer small functions name things well follow existing patterns docs api review migrate cache".split(" ");
const prose = (n) => Array.from({ length: n }, () => words[Math.floor(rnd() * words.length)]).join(" ") + ".\n";
const skill = (name, d, b) => `---\nname: ${name}\ndescription: ${d}\n---\n${b}\n`;

// ---- heavy Claude Code world: big CLAUDE.md, rules, own skills, 6 plugins, 8 MCP servers (unmeasured => lower bound) ----
const home = path.join(tmp, "home");
const proj = path.join(tmp, "proj");
fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
fs.mkdirSync(proj, { recursive: true });
put(proj, "CLAUDE.md", prose(2600));
put(home, ".claude/CLAUDE.md", prose(900));
for (let i = 0; i < 14; i++) put(proj, `.claude/rules/rule-${i}.md`, prose(150 + Math.floor(rnd() * 400)));
for (let i = 0; i < 35; i++) put(home, `.claude/skills/own-${i}/SKILL.md`, skill(`own-${i}`, prose(30), prose(300)));
const rec = {};
const plugs = ["design", "infra", "data", "ml", "sec", "docs"];
plugs.forEach((pl, k) => {
  const root = path.join(home, ".claude/plugins/cache/mk", pl, "1.0.0");
  put(root, ".claude-plugin/plugin.json", JSON.stringify({ name: pl }));
  for (let i = 0; i < 12 + k * 4; i++) put(root, `skills/${pl}-${i}/SKILL.md`, skill(`${pl}-${i}`, prose(40 + Math.floor(rnd() * 30)), prose(400)));
  rec[`${pl}@mk`] = [{ scope: "user", installPath: root }];
});
put(home, ".claude/plugins/installed_plugins.json", JSON.stringify({ version: 2, plugins: rec }));
const servers = {};
for (let i = 0; i < 8; i++) servers[`srv-${i}`] = { command: "npx", args: ["-y", `pkg-${i}`] };
put(proj, ".mcp.json", JSON.stringify({ mcpServers: servers }));

const run = (proj, home, root, agent, file, extra) => {
  const args = [path.join(ROOT, "dist", "cli.js"), proj, "--agent", agent, "--ceiling", root, "--managed-dir", path.join(root, "none"), "--system-root", path.join(root, "none"), "--no-bundled-catalog", `--card=${file}`, "--force", "--quiet", ...extra];
  const r = spawnSync(process.execPath, args, { env: { HOME: home, PATH: "" }, encoding: "utf8" });
  process.stdout.write(`${file} exit=${r.status}\n${r.stderr}`);
};
// README samples
const fx = path.join(tmp, "fixture");
fs.cpSync(path.join(ROOT, "test", "fixtures", "plugin-heavy"), fx, { recursive: true });
for (const f of [path.join(out, "sample-card-fixture.svg"), path.join(out, "sample-card-fixture.png")]) run(path.join(fx, "project"), path.join(fx, "home"), fx, "cursor", f, []);
run(path.join(fx, "project"), path.join(fx, "home"), fx, "cursor", path.join(out, "sample-card-fixture-square-light.png"), ["--card-size", "square", "--card-theme", "light"]);
run(proj, home, tmp, "claude-code", path.join(out, "sample-card-heavy.png"), []);
// ---- Cursor world shaped like a real Mac scan: one big plugin, one small one, 18 Cursor-managed skills, an AGENTS.md ----
const cw = path.join(tmp, "cursor-world");
fs.mkdirSync(path.join(cw, "home"), { recursive: true });
fs.mkdirSync(path.join(cw, "proj"), { recursive: true });
const longDesc = "Use this skill when working with analytics, dashboards, experiments, feature flags, funnels, retention and cohorts in a product team.";
for (const [pl, n] of [["analytics-kit", 73], ["design-kit", 14], ["cloud-kit", 6]]) {
  const root = path.join(cw, "home", ".cursor/plugins/cache/mk", pl, "abc123");
  put(root, ".cursor-plugin/plugin.json", JSON.stringify({ name: pl }));
  for (let i = 0; i < n; i++) put(root, `skills/${pl}-${i}/SKILL.md`, skill(`${pl}-${i}`, longDesc, prose(200)));
}
for (let i = 0; i < 18; i++) put(path.join(cw, "home"), `.cursor/skills-cursor/managed-${i}/SKILL.md`, skill(`managed-${i}`, longDesc.slice(0, 70), prose(100)));
put(path.join(cw, "proj"), "AGENTS.md", prose(500));
run(path.join(cw, "proj"), path.join(cw, "home"), cw, "cursor", path.join(out, "sample-card-cursor.png"), []);
if (!process.argv.includes("--gallery")) {
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}
fs.mkdirSync(path.join(out, "gallery"), { recursive: true });
const base = ["--agent", "claude-code", "--ceiling", tmp, "--managed-dir", path.join(tmp, "none"), "--system-root", path.join(tmp, "none"), "--no-bundled-catalog"];
for (const theme of ["dark", "light"]) {
  for (const size of ["og", "square"]) {
    for (const head of ["cut", "total"]) {
      const file = path.join(out, "gallery", `heavy-${head}-${theme}-${size}.png`);
      const r = spawnSync(process.execPath, [path.join(ROOT, "dist", "cli.js"), proj, ...base, `--card=${file}`, "--card-theme", theme, "--card-size", size, "--card-headline", head, "--force", "--quiet"], { env: { HOME: home, PATH: "" }, encoding: "utf8" });
      process.stdout.write(`${file} exit=${r.status}\n${r.stderr}`);
    }
  }
}

for (const theme of ["dark", "light"]) {
  for (const size of ["og", "square"]) {
    const file = path.join(out, "gallery", `cursor-${theme}-${size}.png`);
    const r = spawnSync(process.execPath, [path.join(ROOT, "dist", "cli.js"), path.join(cw, "proj"), "--agent", "cursor", "--ceiling", cw, "--managed-dir", path.join(cw, "none"), "--system-root", path.join(cw, "none"), "--no-bundled-catalog", `--card=${file}`, "--card-theme", theme, "--card-size", size, "--force", "--quiet"], { env: { HOME: path.join(cw, "home"), PATH: "" }, encoding: "utf8" });
    process.stdout.write(`${file} exit=${r.status}\n${r.stderr}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
