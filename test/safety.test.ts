import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { materialize, cleanup, treeHash } from "./helpers/fixtures";
import { runCli, ROOT } from "./helpers/run-cli";
import { mkTmp, CAN_SYMLINK } from "./helpers/tmp";

afterAll(cleanup);

const SCENARIOS = ["realistic", "monorepo-ancestors", "codex-32k-truncate", "symlink-escape", "binary-garbage", "privacy-canary", "claude-memory-over-200", "mcp-catalog", "empty-machine", "repo-only"];

describe("read-only proof", () => {
  for (const name of SCENARIOS.filter((n) => n !== "symlink-escape" || CAN_SYMLINK)) {
    it(`${name}: no filesystem write API is called; tree hash unchanged (terminal, --json, --fix, --verbose)`, () => {
      const m = materialize(name);
      const before = treeHash(m.root);
      for (const args of [[m.project], [m.project, "--json"], [m.project, "--fix"], [m.project, "--verbose", "--agent", "claude-code,cursor,codex"]]) {
        const res = runCli([...args, "--ceiling", m.root, "--managed-dir", path.join(m.root, "none")], { home: m.home, cwd: m.project });
        expect(res.guardLog, `guard violations for ${args.join(" ")}: ${res.stderr}`).toBe("");
        expect([0, 3]).toContain(res.status);
        expect(res.stderr).toBe("");
      }
      expect(treeHash(m.root)).toBe(before);
    });
  }

  it("the guard itself works: it blocks writes, reads pass (sanity check of the proof)", () => {
    const d = mkTmp("prehello-guardsanity-");
    const log = path.join(d, "log");
    fs.writeFileSync(log, "");
    // the temp dir goes into the child script as a JSON string literal: a raw Windows path (C:\Users\...) is a syntax error there
    const D = JSON.stringify(d);
    const code = `
      const fs=require('fs'), path=require('path');
      const D=${D}, at=(n)=>path.join(D,n);
      const out=[];
      for (const f of [()=>fs.writeFileSync(at('x'),'1'), ()=>fs.mkdirSync(at('y')), ()=>fs.openSync(at('z'),'w'), ()=>fs.rmSync(at('log')), ()=>fs.promises.writeFile(at('p'),'1')]) { try { f(); out.push('NOT-BLOCKED'); } catch(e){ out.push('blocked'); } }
      fs.readFileSync(at('log'),'utf8'); fs.readdirSync(D);
      console.log(out.join(','));`;
    const res = spawnSync(process.execPath, ["-r", path.join(__dirname, "helpers", "guard.cjs"), "-e", code], { env: { PREHELLO_GUARD_LOG: log, PATH: "" }, encoding: "utf8" });
    expect(res.stdout.trim()).toBe("blocked,blocked,blocked,blocked,blocked");
    expect(fs.readFileSync(log, "utf8").trim().split("\n").length).toBe(5);
    expect(fs.existsSync(path.join(d, "x"))).toBe(false);
    fs.rmSync(d, { recursive: true, force: true });
  });

  it("only explicitly requested outputs are written (--json=file, --card=file) and nothing else", () => {
    const m = materialize("realistic");
    const out = mkTmp("prehello-out-");
    const jsonFile = path.join(out, "r.json");
    const card = path.join(out, "c.svg");
    const res = runCli([m.project, `--json=${jsonFile}`, `--card=${card}`, "--ceiling", m.root, "--managed-dir", path.join(m.root, "none")], { home: m.home, cwd: m.project, allowWrite: [jsonFile, card] });
    expect(res.guardLog).toBe("");
    expect(fs.readdirSync(out).sort()).toEqual(["c.svg", "r.json"]);
    fs.rmSync(out, { recursive: true, force: true });
  });

  it("refuses to overwrite a file it scanned", () => {
    const m = materialize("realistic");
    const target = path.join(m.project, "CLAUDE.md");
    const before = fs.readFileSync(target, "utf8");
    const res = runCli([m.project, `--card=${target}`, "--ceiling", m.root], { home: m.home, cwd: m.project, allowWrite: [target], guard: true });
    expect(res.status).not.toBe(0);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
  });

  it("--card only accepts .svg and .png names (cannot be used to clobber arbitrary files)", () => {
    const m = materialize("realistic");
    const res = runCli([m.project, `--card=${path.join(m.project, "CLAUDE.md.bak")}`, "--ceiling", m.root], { home: m.home, cwd: m.project });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/must end in \.svg or \.png/);
  });
});

describe("no-network proof", () => {
  it("runtime: network, dns, http(s), spawn and fetch are all blocked by the guard and never attempted", () => {
    const m = materialize("realistic");
    const res = runCli([m.project, "--json", "--ceiling", m.root], { home: m.home, cwd: m.project });
    expect(res.guardLog).toBe("");
    expect(res.status).toBe(0);
  });

  it("the network guard itself works (sanity check of the proof)", () => {
    const d = mkTmp("prehello-netsanity-");
    const log = path.join(d, "log");
    fs.writeFileSync(log, "");
    const code = `
      const out=[];
      const t=(f)=>{ try{ f(); out.push('NOT-BLOCKED'); }catch(e){ out.push('blocked'); } };
      t(()=>require('net').connect(80,'127.0.0.1'));
      t(()=>require('http').get('http://127.0.0.1/'));
      t(()=>require('https').request('https://example.com/'));
      t(()=>require('dns').lookup('example.com',()=>{}));
      t(()=>require('child_process').execSync('true'));
      t(()=>fetch('http://127.0.0.1/'));
      console.log(out.join(','));`;
    const res = spawnSync(process.execPath, ["-r", path.join(__dirname, "helpers", "guard.cjs"), "-e", code], { env: { PREHELLO_GUARD_LOG: log, PATH: "" }, encoding: "utf8" });
    expect(res.stdout.trim()).toBe("blocked,blocked,blocked,blocked,blocked,blocked");
    fs.rmSync(d, { recursive: true, force: true });
  });

  it("kernel-level: runs inside an empty network namespace when the platform allows it", () => {
    const probe = spawnSync("unshare", ["-rn", "true"], { encoding: "utf8" });
    if (probe.status !== 0) return; // user namespaces unavailable: covered by the guard-based tests
    const m = materialize("realistic");
    const res = runCli([m.project, "--json", "--ceiling", m.root], { home: m.home, cwd: m.project, guard: false, prefix: ["unshare", "-rn"], env: { PATH: "/usr/bin:/bin" } });
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout).agents.length).toBeGreaterThan(0);
  });

  it("static: src/ never imports network, spawn or worker modules and never uses fetch/XHR/WebSocket", () => {
    const banned = /(from\s+["'](node:)?(net|http|https|http2|dns|dgram|tls|child_process|worker_threads|cluster|inspector|vm)["'])|(require\(\s*["'](node:)?(net|http|https|http2|dns|dgram|tls|child_process|worker_threads|cluster|inspector|vm)["']\s*\))|\bfetch\s*\(|XMLHttpRequest|WebSocket|\bEventSource\b|navigator\.sendBeacon/;
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".ts") ? [path.join(d, e.name)] : []));
    const offenders = walk(path.join(ROOT, "src")).filter((f) => banned.test(fs.readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n")));
    expect(offenders).toEqual([]);
  });

  it("static: only src/safe-write.ts (the explicit --json=/--card= outputs, via symlink-safe open) uses filesystem write APIs", () => {
    const writers = /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdirSync|mkdir|rmSync|rm|rmdirSync|unlinkSync|unlink|renameSync|rename|copyFileSync|copyFile|symlinkSync|chmodSync|truncateSync|ftruncateSync|writeSync|utimesSync)\s*\(|\bO_(WRONLY|RDWR|CREAT|APPEND|TRUNC)\b/;
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".ts") ? [path.join(d, e.name)] : []));
    const offenders = walk(path.join(ROOT, "src")).filter((f) => writers.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(ROOT, f).split(path.sep).join("/"));
    expect(offenders).toEqual(["src/safe-write.ts"]);
  });

  it("package.json: no install scripts, at most 5 runtime dependencies, bin is prehello", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    for (const k of ["preinstall", "install", "postinstall", "prepare", "prepublish"]) expect(pkg.scripts?.[k]).toBeUndefined();
    expect(Object.keys(pkg.dependencies ?? {}).length).toBeLessThanOrEqual(5);
    expect(pkg.bin).toEqual({ prehello: "dist/cli.js" });
    expect(pkg.license).toBe("MIT");
    // PNG export: exactly one optional dependency (pure WebAssembly, no native binary), and the shipped fonts are in the package
    expect(Object.keys(pkg.optionalDependencies ?? {})).toEqual(["@resvg/resvg-wasm"]);
    expect(pkg.files).toContain("assets");
    for (const f of ["Inter-Regular.subset.ttf", "Inter-SemiBold.subset.ttf", "Inter-ExtraBold.subset.ttf", "OFL.txt"]) expect(fs.existsSync(path.join(ROOT, "assets", "fonts", f))).toBe(true);
    expect(pkg.engines.node).toMatch(/18/);
  });
});

describe("resource limits", () => {
  it("a 4 MiB+ context file is skipped (partial result, exit 3), not read into the report", () => {
    const m = materialize("empty-machine");
    fs.mkdirSync(path.join(m.home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(m.project, "CLAUDE.md"), "x ".repeat(2_300_000));
    const res = runCli([m.project, "--ceiling", m.root, "--agent", "claude-code"], { home: m.home, cwd: m.project });
    expect(res.status).toBe(3);
    expect(res.stdout).toMatch(/larger than 4 MiB/);
    expect(res.guardLog).toBe("");
  });

  it.skipIf(!CAN_SYMLINK)("a symlink loop and a directory with thousands of entries do not hang the scan", () => {
    const m = materialize("empty-machine");
    fs.symlinkSync(".", path.join(m.project, "loop"));
    const big = path.join(m.project, "packages");
    fs.mkdirSync(big);
    for (let i = 0; i < 6000; i++) fs.mkdirSync(path.join(big, "p" + i));
    fs.writeFileSync(path.join(m.project, "CLAUDE.md"), "hello\n");
    const t0 = Date.now();
    const res = runCli([m.project, "--ceiling", m.root, "--agent", "claude-code"], { home: m.home, cwd: m.project });
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect([0, 3]).toContain(res.status);
    expect(res.stdout).toMatch(/CLAUDE\.md/);
  });
});
