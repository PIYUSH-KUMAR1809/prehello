#!/usr/bin/env node
/**
 * Install smoke test, the same on Linux, macOS and Windows:
 *   node scripts/smoke-install.mjs
 * 1. npm pack, install the tarball into a clean project WITHOUT the optional PNG engine -> prehello runs, --markdown works,
 *    --card=x.png prints the install options and exits 1 (never a stack trace), --card=x.svg works;
 * 2. install the optional PNG engine into that project                                -> --card=x.png writes a real PNG.
 * Needs network (npm registry) for the three runtime dependencies. Exits non-zero on the first failed check.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// native realpath: on Windows only it expands 8.3 short names (RUNNER~1), which the "no paths in the output" checks compare against
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "prehello-smoke-")));
const win = process.platform === "win32";
let failed = 0;
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : detail ? "\n" + detail : ""}`);
  if (!ok) failed++;
};
const run = (cmd, args, cwd, env = {}) => spawnSync(cmd, args, { cwd, encoding: "utf8", shell: win, env: { ...process.env, ...env } });

const pack = run("npm", ["pack", "--pack-destination", tmp, "--json"], root);
if (pack.status !== 0) throw new Error("npm pack failed: " + pack.stderr);
const tgz = path.join(tmp, JSON.parse(pack.stdout)[0].filename);
const proj = path.join(tmp, "app");
fs.mkdirSync(path.join(proj, "work"), { recursive: true });
fs.writeFileSync(path.join(proj, "package.json"), '{"name":"smoke","version":"1.0.0"}');
fs.writeFileSync(path.join(proj, "work", "CLAUDE.md"), "# Smoke\nUse tabs.\n".repeat(20));
const home = path.join(tmp, "home");
fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
const bin = path.join(proj, "node_modules", ".bin", win ? "prehello.cmd" : "prehello");
const env = { HOME: home, USERPROFILE: home, NO_COLOR: "1" };
const cli = (args) => run(win ? `"${bin}"` : bin, [...args, "--cwd", path.join(proj, "work"), "--ceiling", proj], proj, env);

let r = run("npm", ["install", tgz, "--omit=optional", "--no-audit", "--no-fund"], proj);
check(r.status === 0, "npm install <tarball> --omit=optional", r.stderr);
// Newer npm versions (the ones on GitHub's macOS and Ubuntu runners) still install optionalDependencies of a tarball given on the
// command line even with --omit=optional. What this script needs is the scenario "the engine is not there", so make that true:
// remove it if npm installed it, and say so. The engine is installed again explicitly in step 2.
const engineDir = path.join(proj, "node_modules", "@resvg");
if (fs.existsSync(engineDir)) {
  console.log("note  npm installed the optional PNG engine despite --omit=optional; removing node_modules/@resvg to simulate its absence");
  fs.rmSync(engineDir, { recursive: true, force: true });
}
check(!fs.existsSync(engineDir), "optional PNG engine is absent");

r = cli(["--version"]);
check(r.status === 0 && /\d+\.\d+\.\d+/.test(r.stdout), "--version", r.stdout + r.stderr);
r = cli(["--markdown"]);
check(r.status === 0 && r.stdout.startsWith("## prehello report") && !r.stdout.includes(proj), "--markdown to stdout, no paths", r.stdout + r.stderr);
r = cli(["--sarif"]);
let sarifOk = false;
try {
  const j = JSON.parse(r.stdout);
  sarifOk = j.version === "2.1.0" && j.runs?.[0]?.tool?.driver?.name === "prehello" && !r.stdout.includes(proj);
} catch {}
check(r.status === 0 && sarifOk, "--sarif to stdout is a SARIF 2.1.0 log, no paths", r.stdout.slice(0, 300) + r.stderr);
r = cli(["--card=" + path.join(proj, "x.png")]);
check(r.status === 1 && /@resvg\/resvg-wasm/.test(r.stderr) && /npm install/.test(r.stderr) && /card\.svg/.test(r.stderr), "PNG without the engine: message + install options + exit 1", r.stdout + r.stderr);
check(!/\n\s+at\s.*:\d+:\d+/.test(r.stderr), "no stack trace");
check(!fs.existsSync(path.join(proj, "x.png")), "no half-written PNG");
check(/ALWAYS ON|Before your first message/.test(r.stdout), "the normal report is still printed");
r = cli(["--card=" + path.join(proj, "x.svg")]);
check(r.status === 0 && fs.existsSync(path.join(proj, "x.svg")), "SVG card needs no engine", r.stdout + r.stderr);

r = run("npm", ["install", "@resvg/resvg-wasm", "--no-audit", "--no-fund"], proj);
check(r.status === 0, "npm install @resvg/resvg-wasm", r.stderr);
r = cli(["--card=" + path.join(proj, "y.png")]);
const png = fs.existsSync(path.join(proj, "y.png")) ? fs.readFileSync(path.join(proj, "y.png")) : Buffer.alloc(0);
check(r.status === 0 && png.subarray(1, 4).toString() === "PNG", "PNG card with the engine installed", r.stdout + r.stderr);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
