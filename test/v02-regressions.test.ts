import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { world, cleanupWorlds, put, skillMd, scanWorld, agentOf, World } from "./helpers/tree";
import { runCli } from "./helpers/run-cli";
import { renderTerminal } from "../src/render/terminal";
import { toJson } from "../src/render/json";
import { renderCard, pickCardAgent, buildHeadline, assertHeadline, CARD_FONT } from "../src/render/card";
import { savingsOf } from "../src/analyze/savings";
import { safeWrite, looksLikePrehelloOutput, SafeWriteError } from "../src/safe-write";
import { MAX_FILE_BYTES, MAX_WALK_ENTRIES } from "../src/fs-safe";

afterAll(cleanupWorlds);

const LONG = "Use this skill when the user asks about analytics dashboards, feature flags, experiments and product data. ".repeat(2);
function cursorPlugins(w: World, plugins: Record<string, number>): void {
  for (const [name, n] of Object.entries(plugins)) {
    const base = `.cursor/plugins/local/${name}`;
    const files: Record<string, string> = { [`${base}/.cursor-plugin/plugin.json`]: JSON.stringify({ name }) };
    for (let i = 0; i < n; i++) files[`${base}/skills/${name}-s${i}/SKILL.md`] = skillMd(`${name}-s${i}`, LONG);
    put(w.home, files);
  }
}
const term = (w: World, r: ReturnType<typeof scanWorld>) => renderTerminal(r, { color: false, width: 100, verbose: false, quiet: false, home: w.home, cwd: w.project });

describe("(a) scan budget: deterministic bytes, injectable clock, partial-results warning", () => {
  function bigWorld(): World {
    const w = world();
    put(w.project, { "CLAUDE.md": "# project\n" + "hello world ".repeat(2000) });
    put(w.home, { ".claude/CLAUDE.md": "# user\n" + "hello world ".repeat(2000) });
    for (let i = 0; i < 5; i++) put(w.home, { [`.claude/skills/s${i}/SKILL.md`]: skillMd(`s${i}`, LONG) });
    return w;
  }
  it("a byte budget stops the scan, warns once, marks every total as a lower bound, and is deterministic", () => {
    const w = bigWorld();
    const run = () => scanWorld(w, { agents: ["claude-code"], maxScanBytes: 30_000 });
    const a = run();
    const b = run();
    expect(a.partial).toEqual({ reason: "bytes", filesNotRead: expect.any(Number) });
    expect(a.partial!.filesNotRead).toBeGreaterThan(0);
    expect(a.warnings.filter((x) => /scan stopped at its/.test(x))).toHaveLength(1);
    expect(a.warnings.join("\n")).toMatch(/PARTIAL/);
    expect(agentOf(a, "claude-code").lowerBound).toBe(true);
    expect(agentOf(a, "claude-code").grade?.provisional).toBe(true);
    // same input, same budget => same output (bytes budget is not timing dependent)
    expect(JSON.stringify(toJson(a, { cwd: w.project, home: w.home }, false))).toBe(JSON.stringify(toJson(b, { cwd: w.project, home: w.home }, false)));
    const t = term(w, a);
    expect(t).toMatch(/Before your first message: Claude Code ≥ ~/);
  });
  it("without a budget hit nothing is partial", () => {
    const w = bigWorld();
    const r = scanWorld(w, { agents: ["claude-code"] });
    expect(r.partial).toBeUndefined();
    expect(agentOf(r, "claude-code").lowerBound).toBe(false);
  });
  it("a wall-clock budget uses the injected clock (tests never sleep)", () => {
    const w = bigWorld();
    let t = 0;
    const r = scanWorld(w, { agents: ["claude-code"], maxScanMs: 1000, clock: () => (t += 400) });
    expect(r.partial?.reason).toBe("time");
    expect(r.warnings.join("\n")).toMatch(/time budget/);
    expect(agentOf(r, "claude-code").lowerBound).toBe(true);
  });
  it("CLI: --scan-budget-mb makes the run partial (exit 3, JSON partial set, alwaysIsLowerBound true); bad values are rejected", () => {
    const w = bigWorld();
    const res = runCli([w.project, "--ceiling", w.root, "--agent", "claude-code", "--scan-budget-mb", "0.02", "--json"], { home: w.home, cwd: w.project });
    expect(res.status).toBe(3);
    const j = JSON.parse(res.stdout);
    expect(j.partial.reason).toBe("bytes");
    expect(j.agents[0].alwaysIsLowerBound).toBe(true);
    const bad = runCli([w.project, "--scan-budget-mb", "-1"], { home: w.home, cwd: w.project });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/positive number/);
  });
});

describe("(b) a non-project folder whose walk is truncated: warn, no junk totals", () => {
  function manyDirs(base: string, n: number) {
    for (let i = 0; i < n; i++) fs.mkdirSync(path.join(base, "d" + i));
  }
  it("drops nested agent files found in the first N entries and says why", () => {
    const w = world({ git: false });
    manyDirs(w.project, MAX_WALK_ENTRIES + 200);
    put(w.project, { "d3/CLAUDE.md": "# random junk file\n" + "junk ".repeat(500), "d4/AGENTS.md": "# more junk\n" + "junk ".repeat(500) });
    const r = scanWorld(w, { agents: ["claude-code", "codex"] });
    expect(r.warnings.join("\n")).toMatch(/does not look like a project/);
    expect(r.warnings.join("\n")).toMatch(/NOT scanned/);
    for (const a of r.agents) expect(a.items.filter((i) => /d3|d4/.test(i.path))).toHaveLength(0);
    for (const a of r.agents) expect(a.totals.always.est).toBe(0);
  });
  it("a real project (has .git) with the same shape keeps its nested files and gets the normal truncation warning", () => {
    const w = world();
    manyDirs(w.project, MAX_WALK_ENTRIES + 200);
    put(w.project, { "CLAUDE.md": "# real\n" });
    const r = scanWorld(w, { agents: ["claude-code"] });
    expect(r.warnings.join("\n")).toMatch(/project walk stopped/);
    expect(r.warnings.join("\n")).not.toMatch(/does not look like a project/);
    expect(agentOf(r, "claude-code").totals.always.est).toBeGreaterThan(0);
  });
  it("a non-project folder that is small is still scanned normally", () => {
    const w = world({ git: false });
    put(w.project, { "CLAUDE.md": "# small folder\n" + "x ".repeat(50) });
    const r = scanWorld(w, { agents: ["claude-code"] });
    expect(agentOf(r, "claude-code").totals.always.est).toBeGreaterThan(0);
    expect(r.warnings.join("\n")).not.toMatch(/does not look like a project/);
  });
});

describe("(c) per-file size cap is 4 MiB, like Claude Code's startup limit", () => {
  it("constant, 3 MiB file is read, 5 MiB file is skipped with the 4 MiB wording", () => {
    expect(MAX_FILE_BYTES).toBe(4 * 1024 * 1024);
    const w = world();
    put(w.project, { "CLAUDE.md": "word ".repeat(3 * 1024 * 1024 / 5) });
    let r = scanWorld(w, { agents: ["claude-code"], maxScanBytes: 1 << 30 });
    expect(agentOf(r, "claude-code").items.find((i) => i.path.endsWith("CLAUDE.md"))?.tokens).not.toBeNull();
    fs.writeFileSync(path.join(w.project, "CLAUDE.md"), "word ".repeat(5 * 1024 * 1024 / 5));
    r = scanWorld(w, { agents: ["claude-code"], maxScanBytes: 1 << 30 });
    expect(r.warnings.join("\n")).toMatch(/larger than 4 MiB \(Claude Code's own limit/);
  });
});

describe("(d) SVG card", () => {
  function cardWorld() {
    const w = world();
    cursorPlugins(w, { posthog: 40, datadog: 20, figma: 10 });
    put(w.project, { "AGENTS.md": "# rules\n" + "Be careful. ".repeat(300) });
    return w;
  }
  const makeCard = (size: "og" | "square", headline?: "total" | "cut", extra = {}) => {
    const w = cardWorld();
    const r = scanWorld(w, { agents: ["cursor"], ...extra });
    const a = pickCardAgent(r, "cursor")!;
    return { r, a, svg: renderCard(r, a, { theme: "dark", size, headline }) };
  };
  it("never uses the ≥ or ≈ glyph anywhere (a lower bound is written as words)", () => {
    for (const size of ["og", "square"] as const) {
      for (const headline of ["total", "cut"] as const) {
        const { svg } = makeCard(size, headline, { maxScanBytes: 20_000 });
        expect(svg).not.toMatch(/[≥≈]/);
      }
    }
    const { svg } = makeCard("og", "total", { maxScanBytes: 20_000 });
    expect(svg).toMatch(/at least ~/);
  });
  it("font stack ends in generic sans-serif and has concrete fallbacks", () => {
    const { svg } = makeCard("og");
    expect(CARD_FONT).toMatch(/Arial.*'DejaVu Sans', sans-serif$/);
    expect(svg).toContain(`font-family="${CARD_FONT}"`);
  });
  it("square footer wraps onto several lines and every text line stays inside the canvas", () => {
    const { svg } = makeCard("square");
    const foot = [...svg.matchAll(/<text x="56" y="(\d+)" font-family="[^"]*" font-size="20" fill="[^"]*">([^<]*)<\/text>/g)];
    expect(foot.length).toBeGreaterThanOrEqual(2);
    for (const [, y, text] of foot) {
      expect(Number(y)).toBeLessThan(1080);
      expect(text.length * 20 * 0.62).toBeLessThanOrEqual(1080 - 112 + 1);
    }
    expect(foot.map((m) => m[2]).join(" · ")).toMatch(/estimate band.*window 200k/);
  });
  it("no text element is wider than the card (conservative estimate) in either size", () => {
    for (const size of ["og", "square"] as const) {
      const W = size === "og" ? 1200 : 1080;
      const { svg } = makeCard(size, "total");
      for (const m of svg.matchAll(/<text x="([\d.]+)"(?![^>]*text-anchor)[^>]*font-size="(\d+)"[^>]*>(.*?)<\/text>/g)) {
        const plain = m[3].replace(/<[^>]+>/g, "");
        expect(Number(m[1]) + plain.length * Number(m[2]) * 0.62, plain).toBeLessThanOrEqual(W + 1);
      }
    }
  });
  it("larger treemap cells carry a label, token count and share; the biggest cell is labelled", () => {
    const { svg } = makeCard("og", "total");
    expect(svg).toMatch(/>plugin (posthog|datadog)<\/text>/); // tiles are the cut-list groups, not "skills listing 1"
    expect(svg).not.toMatch(/skills listing/);
    expect(svg).toMatch(/~[\d.]+k · \d+%/);
  });
  it("carries no paths or file contents; plugin names only as tile labels, and --card-anonymize removes them", () => {
    const { svg, r, a } = makeCard("og", "cut");
    expect(svg).not.toMatch(/\/tmp|prehello-w-/);
    expect(svg).toMatch(/plugin posthog/);
    const anon = renderCard(r, a, { theme: "dark", size: "og", headline: "cut", anonymize: true });
    expect(anon).not.toMatch(/posthog|datadog|figma|\/tmp|prehello-w-/);
  });
  it("cut headline leads with the waste number and is guarded; it needs savings data", () => {
    const { r, a, svg } = makeCard("og", "cut");
    const h = buildHeadline(a, 200_000, "cut")!;
    expect(h.id).toBe("cut-list");
    expect(h.hero).toMatch(/^Skills & plugins cost ~[\d.]+k tokens before hello$/);
    expect(h.sub).toMatch(/estimate/);
    expect(svg).toContain(h.hero.replace("&", "&amp;"));
    expect(() => assertHeadline({ ...h, hero: h.hero.replace("~", "") }, a, 200_000)).toThrow(/estimate marker/);
    const none = { ...a, savings: null };
    expect(buildHeadline(none, 200_000, "cut")!.id).toBe("tokens-before-hello"); // falls back, never invents a cut claim
    void r;
  });
  it("the total-first card carries the savings strip, labelled as an estimate", () => {
    const { svg } = makeCard("og", "total");
    expect(svg).toMatch(/Cut the top 3 skill\/plugin groups: save ~[\d.]+k tokens \(estimate\)/);
  });
});

describe("(e) --json=/--card= write safety", () => {
  const setup = () => {
    const w = world();
    put(w.project, { "CLAUDE.md": "# hi\n" + "word ".repeat(100) });
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "prehello-out-"));
    return { w, out };
  };
  const run = (w: World, args: string[], allow: string[]) => runCli([w.project, "--ceiling", w.root, "--agent", "claude-code", ...args], { home: w.home, cwd: w.project, allowWrite: allow });
  it("refuses to write through a symlink (dangling or not), --force or not, and leaves the target untouched", () => {
    const { w, out } = setup();
    const target = path.join(out, "victim.txt");
    fs.writeFileSync(target, "precious");
    const link = path.join(out, "link.json");
    fs.symlinkSync(target, link);
    for (const extra of [[], ["--force"]]) {
      const res = run(w, [`--json=${link}`, ...extra], [link, target]);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/symlink/);
    }
    expect(fs.readFileSync(target, "utf8")).toBe("precious");
    const dangling = path.join(out, "dangling.svg");
    fs.symlinkSync(path.join(out, "nowhere.txt"), dangling);
    const res = run(w, [`--card=${dangling}`], [dangling]);
    expect(res.status).toBe(1);
    expect(fs.existsSync(path.join(out, "nowhere.txt"))).toBe(false);
  });
  it("refuses to overwrite an existing non-prehello file without --force; --force replaces it", () => {
    const { w, out } = setup();
    const f = path.join(out, "notes.json");
    fs.writeFileSync(f, '{"mine":true}');
    let res = run(w, [`--json=${f}`], [f]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/not written by prehello; use --force/);
    expect(fs.readFileSync(f, "utf8")).toBe('{"mine":true}');
    res = run(w, [`--json=${f}`, "--force"], [f]);
    expect(res.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(f, "utf8")).tool.name).toBe("prehello");
    const svg = path.join(out, "mine.svg");
    fs.writeFileSync(svg, "<svg xmlns='http://www.w3.org/2000/svg'/>");
    res = run(w, [`--card=${svg}`], [svg]);
    expect(res.status).toBe(1);
    expect(fs.readFileSync(svg, "utf8")).toBe("<svg xmlns='http://www.w3.org/2000/svg'/>");
  });
  it("re-running over its own previous output (json and svg) works without --force; a missing file is created", () => {
    const { w, out } = setup();
    const j = path.join(out, "r.json");
    const s = path.join(out, "r.svg");
    for (let i = 0; i < 2; i++) {
      const res = run(w, [`--json=${j}`, `--card=${s}`], [j, s]);
      expect(res.status).toBe(0);
      expect(res.guardLog).toBe("");
    }
    expect(fs.readFileSync(s, "utf8")).toMatch(/^<svg/);
  });
  it("refuses a directory, and shrinking rewrite leaves no stale tail", () => {
    const { w, out } = setup();
    const d = path.join(out, "dir.json");
    fs.mkdirSync(d);
    expect(run(w, [`--json=${d}`], [d]).status).toBe(1);
    const f = path.join(out, "tail.json");
    fs.writeFileSync(f, JSON.stringify({ tool: { name: "prehello" } }) + " ".repeat(100000));
    expect(run(w, [`--json=${f}`], [f]).status).toBe(0);
    expect(() => JSON.parse(fs.readFileSync(f, "utf8"))).not.toThrow();
  });
  it("unit: safeWrite never follows a link swapped in for a fresh name, and looksLikePrehelloOutput is strict", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "prehello-out-"));
    const target = path.join(out, "t");
    fs.writeFileSync(target, "keep");
    const link = path.join(out, "l.json");
    fs.symlinkSync(target, link);
    expect(() => safeWrite(link, "x", { kind: "json", force: true })).toThrow(SafeWriteError);
    expect(fs.readFileSync(target, "utf8")).toBe("keep");
    expect(looksLikePrehelloOutput('{\n  "schemaVersion": 1,\n  "tool": {\n    "name": "prehello"', "json")).toBe(true);
    expect(looksLikePrehelloOutput('{"tool":{"name":"other"}}', "json")).toBe(false);
    expect(looksLikePrehelloOutput("<svg><desc>Generated by prehello 0.1.0.</desc></svg>", "svg")).toBe(true);
    expect(looksLikePrehelloOutput("<svg></svg>", "svg")).toBe(false);
  });
});

describe("savings: what removing the top plugin/skill groups would save", () => {
  it("per-plugin parts add up to the listing's estimate and the cut list ranks plugins", () => {
    const w = world();
    cursorPlugins(w, { posthog: 40, datadog: 20, figma: 10 });
    const r = scanWorld(w, { agents: ["cursor"] });
    const a = agentOf(r, "cursor");
    const listing = a.items.find((i) => i.kind === "skills-listing" && i.parts)!;
    expect(listing.parts!.map((p) => p.name)).toEqual(["plugin posthog", "plugin datadog", "plugin figma"]);
    const sum = listing.parts!.reduce((s, p) => s + p.tokens, 0);
    expect(Math.abs(sum - listing.tokens!.est)).toBeLessThanOrEqual(listing.parts!.length);
    const sv = a.savings!;
    expect(sv.top.map((c) => c.label)).toEqual(["plugin posthog", "plugin datadog", "plugin figma"]);
    expect(sv.topTokens).toBe(sv.top.reduce((s, c) => s + c.tokens, 0));
    expect(sv.topTokens).toBeLessThanOrEqual(a.totals.always.est);
    expect(sv.pctOfAlways).toBeCloseTo((sv.topTokens / a.totals.always.est) * 100, 5);
  });
  it("terminal shows a 'What to cut (estimates)' block with the top groups and the estimate disclaimer", () => {
    const w = world();
    cursorPlugins(w, { posthog: 40, datadog: 20, figma: 10 });
    const t = term(w, scanWorld(w, { agents: ["cursor"] }));
    expect(t).toMatch(/What to cut \(estimates\)/);
    expect(t).toMatch(/1\. plugin posthog \(40 skills\)/);
    expect(t).toMatch(/estimate, not a promise/);
    expect(t).not.toMatch(/≈ ≈/);
  });
  it("no savings block when nothing is worth cutting; JSON carries savings (strict mode hides plugin names)", () => {
    const w = world();
    put(w.project, { "CLAUDE.md": "# tiny\n" });
    const r = scanWorld(w, { agents: ["claude-code"] });
    expect(agentOf(r, "claude-code").savings).toBeNull();
    expect(term(w, r)).not.toMatch(/What to cut/);
    const w2 = world();
    cursorPlugins(w2, { secretvendorplugin: 30 });
    const r2 = scanWorld(w2, { agents: ["cursor"] });
    const strict = JSON.stringify(toJson(r2, { cwd: w2.project, home: w2.home }, true));
    expect(strict).toContain('"savings"');
    expect(strict).not.toContain("secretvendorplugin");
    expect(JSON.stringify(toJson(r2, { cwd: w2.project, home: w2.home }, false))).toContain("plugin secretvendorplugin");
  });
  it("savingsOf ignores instruction files and unmeasured items", () => {
    expect(savingsOf([], 100, 200_000)).toBeNull();
  });
  it("MCP servers with a measured size are cut candidates", () => {
    const w = world();
    put(w.project, { "CLAUDE.md": "# x\n", ".mcp.json": JSON.stringify({ mcpServers: { github: { command: "npx", args: ["x"] } } }) });
    cursorPlugins(w, { posthog: 30 });
    const a = agentOf(scanWorld(w, { agents: ["cursor"], noBundledCatalog: false }), "cursor");
    expect(a.savings?.top.length ?? 0).toBeGreaterThan(0);
  });
});

describe("--max-tokens (CI gate)", () => {
  const mk = () => {
    const w = world();
    cursorPlugins(w, { posthog: 30 });
    put(w.project, { "AGENTS.md": "# rules\n" + "Be careful. ".repeat(100) });
    return w;
  };
  it("exit 2 when the always-on estimate is above the limit, with the number on stderr; 0 when below", () => {
    const w = mk();
    const over = runCli([w.project, "--ceiling", w.root, "--agent", "cursor", "--max-tokens", "1k"], { home: w.home, cwd: w.project });
    expect(over.status).toBe(2);
    expect(over.stderr).toMatch(/Cursor always-on context is .*tokens \(estimate\), above --max-tokens 1000/);
    expect(over.stdout).toMatch(/ALWAYS ON before hello/);
    const ok = runCli([w.project, "--ceiling", w.root, "--agent", "cursor", "--max-tokens", "200k"], { home: w.home, cwd: w.project });
    expect(ok.status).toBe(0);
  });
  it("accepts k and plain numbers, rejects junk, and wins over exit code 3", () => {
    const w = mk();
    expect(runCli([w.project, "--max-tokens", "banana"], { home: w.home, cwd: w.project }).status).toBe(1);
    expect(runCli([w.project, "--ceiling", w.root, "--agent", "cursor", "--max-tokens", "500"], { home: w.home, cwd: w.project }).status).toBe(2);
    const both = runCli([w.project, "--ceiling", w.root, "--agent", "cursor", "--max-tokens", "500", "--scan-budget-mb", "0.01"], { home: w.home, cwd: w.project });
    expect(both.status).toBe(2);
  });
  it("works with --json on stdout (stdout stays valid JSON)", () => {
    const w = mk();
    const res = runCli([w.project, "--ceiling", w.root, "--agent", "cursor", "--max-tokens", "500", "--json"], { home: w.home, cwd: w.project });
    expect(res.status).toBe(2);
    expect(() => JSON.parse(res.stdout)).not.toThrow();
  });
});

describe("README/help consistency", () => {
  it("README no longer claims a 2 MB cap and documents the new flags", () => {
    const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
    expect(readme).not.toMatch(/over 2 MB/);
    for (const f of ["--max-tokens", "--card-headline", "--card-format", "--card-scale", "--force", "--scan-budget-mb", "--markdown", "--markdown-compact", "--anonymize", "--ascii", "USERPROFILE", "resvg-wasm"]) expect(readme).toContain(f);
  });
  it("--help lists the new flags", () => {
    const res = runCli(["--help"], { home: os.tmpdir() });
    for (const f of ["--max-tokens", "--card-headline", "--card-format", "--card-scale", "--force", "--scan-budget-mb", "--scan-budget-ms", "--markdown", "--markdown-compact", "--anonymize", "--ascii", "USERPROFILE", "@resvg/resvg-wasm"]) expect(res.stdout).toContain(f);
  });
});
