import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { materialize, cleanup } from "./helpers/fixtures";
import { runCli } from "./helpers/run-cli";

afterAll(cleanup);

const base = (m: { root: string }) => ["--ceiling", m.root, "--managed-dir", path.join(m.root, "none")];

describe("cli", () => {
  it("--version, --help, explain grade, --about-specs", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "prehello-h-"));
    expect(runCli(["--version"], { home }).stdout.trim()).toBe("0.1.0");
    const help = runCli(["--help"], { home }).stdout;
    expect(help).toMatch(/what your coding agent loads before you say hello/);
    expect(help).toMatch(/No network, no telemetry/);
    const g = runCli(["explain", "grade"], { home });
    expect(g.status).toBe(0);
    expect(g.stdout).toMatch(/heuristic|not a standard/i);
    const s = runCli(["--about-specs"], { home });
    expect(s.stdout).toMatch(/verifiedAt 2026-10-25/);
    expect(s.stdout).toMatch(/Claude Code/);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("empty home on a real (non-fixture) empty directory: exit 0, no agents, no zeros", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "prehello-empty-"));
    const proj = path.join(home, "proj");
    fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
    fs.writeFileSync(path.join(proj, ".git", "HEAD"), "ref: refs/heads/main\n");
    const res = runCli([proj, "--ceiling", home], { home, cwd: proj });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/No coding agents detected/);
    expect(res.stdout).not.toMatch(/\b0 tokens\b/);
    const j = runCli([proj, "--json", "--ceiling", home], { home, cwd: proj });
    expect(JSON.parse(j.stdout).agents).toEqual([]);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("--json is valid, versioned, and never has a bare 0 for an unmeasured item", () => {
    const m = materialize("realistic");
    const res = runCli([m.project, "--json", ...base(m)], { home: m.home, cwd: m.project });
    expect(res.status).toBe(0);
    const j = JSON.parse(res.stdout);
    expect(j.schemaVersion).toBe(1);
    expect(j.tool.name).toBe("prehello");
    for (const a of j.agents) {
      expect(a.alwaysIsLowerBound).toBe(a.totals.always.unmeasuredItems > 0);
      for (const it of a.items) {
        if (it.unmeasured) expect(it.tokens).toBeNull();
        else {
          expect(it.tokens.est).toBeGreaterThanOrEqual(0);
          expect(it.tokens.low).toBeLessThanOrEqual(it.tokens.est);
          expect(it.tokens.high).toBeGreaterThanOrEqual(it.tokens.est);
        }
        expect(["documented", "observed", "assumed"]).toContain(it.confidence);
        expect(it.evidence.docUrl).toMatch(/^https:\/\//);
      }
    }
    expect(j.notMeasurable.join(" ")).toMatch(/system prompt/);
  });

  it("--agent forces and filters; unknown agent exits 1 with a message", () => {
    const m = materialize("realistic");
    const ok = runCli([m.project, "--agent", "codex", "--json", ...base(m)], { home: m.home, cwd: m.project });
    expect(JSON.parse(ok.stdout).agents.map((a: { id: string }) => a.id)).toEqual(["codex"]);
    const bad = runCli([m.project, "--agent", "gemini", ...base(m)], { home: m.home, cwd: m.project });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/unknown agent 'gemini'/);
  });

  it("rejects out-of-scope commands and flags instead of silently ignoring them", () => {
    const m = materialize("realistic");
    for (const [args, re] of [
      [["ci"], /not part of 0\.1/],
      [["diff"], /not part of 0\.1/],
      [["--tokenizer", "exact"], /network/],
      [["--bogus"], /unknown option/],
      [["--window", "abc"], /--window/],
      [["--card-theme", "blue"], /--card-theme/],
      [[m.project + "/nope"], /not a directory/],
    ] as Array<[string[], RegExp]>) {
      const res = runCli([...args, ...(args[0].startsWith("/") ? [] : [m.project])], { home: m.home, cwd: m.project });
      expect(res.status, args.join(" ")).toBe(1);
      expect(res.stderr).toMatch(re);
    }
  });

  it("--window changes percentages; --quiet prints less; --no-grade removes the grade", () => {
    const m = materialize("realistic");
    const a = runCli([m.project, ...base(m)], { home: m.home, cwd: m.project }).stdout;
    const b = runCli([m.project, "--window", "1m", ...base(m)], { home: m.home, cwd: m.project }).stdout;
    expect(a).toMatch(/of 200k/);
    expect(b).toMatch(/of 1M/);
    const q = runCli([m.project, "--quiet", ...base(m)], { home: m.home, cwd: m.project }).stdout;
    expect(q.length).toBeLessThan(a.length);
    const ng = runCli([m.project, "--no-grade", ...base(m)], { home: m.home, cwd: m.project }).stdout;
    expect(ng).not.toMatch(/Grade [A-F]/);
    expect(a).toMatch(/Grade [A-F]/);
  });

  it("terminal output at width 80 never exceeds 100 columns and contains no ANSI when piped", () => {
    const m = materialize("realistic");
    const out = runCli([m.project, ...base(m)], { home: m.home, cwd: m.project }).stdout;
    expect(out).not.toMatch(/\u001b\[/);
    for (const line of out.split("\n")) expect([...line].length, line).toBeLessThanOrEqual(100);
  });

  it("partial results exit 3 but still print a report", () => {
    const m = materialize("binary-garbage");
    const res = runCli([m.project, ...base(m)], { home: m.home, cwd: m.project });
    expect(res.status).toBe(3);
    expect(res.stdout).toMatch(/Partial results/);
  });

  it("--card writes an SVG and --json to stdout keeps stdout pure JSON", () => {
    const m = materialize("realistic");
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "prehello-c-"));
    const card = path.join(out, "x.svg");
    const res = runCli([m.project, "--json", `--card=${card}`, "--card-theme", "light", "--card-size", "square", ...base(m)], { home: m.home, cwd: m.project, allowWrite: [card] });
    expect(() => JSON.parse(res.stdout)).not.toThrow();
    expect(res.stderr).toMatch(/Card written/);
    expect(fs.readFileSync(card, "utf8")).toMatch(/viewBox="0 0 1080 1080"/);
    fs.rmSync(out, { recursive: true, force: true });
  });

  it("works from a subdirectory of the repo (git root discovery) and with --cwd", () => {
    const m = materialize("monorepo-ancestors");
    const sub = path.join(m.project, "apps", "web");
    const a = runCli([sub, "--json", ...base(m)], { home: m.home, cwd: sub });
    const b = runCli(["--cwd", sub, "--json", ...base(m)], { home: m.home, cwd: m.root });
    expect(JSON.parse(a.stdout).agents[0].items.length).toBe(JSON.parse(b.stdout).agents[0].items.length);
    expect(JSON.parse(a.stdout).agents[0].totals.always.measuredItems).toBeGreaterThanOrEqual(3);
  });
});
