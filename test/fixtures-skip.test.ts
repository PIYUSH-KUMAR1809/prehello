import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { world, cleanupWorlds, put, skillMd, scanWorld } from "./helpers/tree";
import { mkTmp, posix } from "./helpers/tmp";
import { isFixtureSegment, makeFixtureSkipper, rootIsInsideFixtures, splitSegments } from "../src/fixtures";
import { walkForFiles } from "../src/fs-safe";
import { renderTerminal } from "../src/render/terminal";
import { renderMarkdown } from "../src/render/markdown";
import { renderSarif } from "../src/render/sarif";
import { renderCard, pickCardAgent } from "../src/render/card";
import { toJson } from "../src/render/json";
import { runCli, ROOT } from "./helpers/run-cli";
import { Report } from "../src/model";

afterAll(cleanupWorlds);

const ALL = ["claude-code", "cursor", "codex"] as const;
const AGENT_TEXT = "Nested agent instructions for this folder. ".repeat(30);
const rule = "---\nalwaysApply: true\n---\n" + "Be careful in this folder. ".repeat(30);

/** Everything a report names by path: item paths, plus files an agent saw but does not load (Codex lists nested AGENTS.md as "excluded"). */
const paths = (r: Report): string[] => [...r.agents.flatMap((a) => a.items.map((i) => posix(i.path))), ...r.excluded.map((e) => posix(e.path))];
const nestedPaths = (r: Report): string[] => paths(r).filter((p) => /\/(AGENTS|CLAUDE)\.md$|\.cursor\/|\.claude\/skills|\.agents\/skills/.test(p));
const term = (w: ReturnType<typeof world>, r: Report) => renderTerminal(r, { color: false, width: 100, verbose: true, quiet: false, home: w.home, cwd: w.project });
const md = (r: Report, compact = false) => renderMarkdown(r, { anonymize: false, compact, headline: "cut" });

/** A project with real nested files and the same kinds of files inside fixture folders. */
function sample() {
  const w = world();
  put(w.project, {
    "AGENTS.md": "Top-level project rules.\n",
    "packages/web/AGENTS.md": AGENT_TEXT,
    "packages/web/.cursor/rules/real.mdc": rule,
    "test/fixtures/a/project/AGENTS.md": AGENT_TEXT,
    "test/fixtures/a/project/CLAUDE.md": AGENT_TEXT,
    "test/fixtures/a/project/.cursor/rules/fx.mdc": rule,
    "test/fixtures/a/project/.cursor/skills/fx/SKILL.md": skillMd("fx", "Fixture skill description"),
    "test/fixtures/a/project/.claude/skills/fx2/SKILL.md": skillMd("fx2", "Fixture skill two"),
    "src/__fixtures__/b/AGENTS.md": AGENT_TEXT,
  });
  return w;
}

describe("fixture folders: the name rules", () => {
  it("clear test-data names are fixtures anywhere, case-insensitively", () => {
    for (const n of ["fixtures", "__fixtures__", "fixture", "testdata", "test-data", "__mocks__", "__snapshots__", "Fixtures", "TESTDATA"]) expect(isFixtureSegment(["src", n], 1), n).toBe(true);
  });
  it("generic names (snapshots, golden, goldens) only count under a test-ish parent", () => {
    for (const n of ["snapshots", "golden", "goldens"]) {
      expect(isFixtureSegment(["golden-root", n], 1), `${n} at the top`).toBe(false);
      expect(isFixtureSegment(["src", n], 1), `${n} under src`).toBe(false);
      for (const parent of ["test", "tests", "__tests__", "spec", "e2e", "cypress", "Test"]) expect(isFixtureSegment([parent, "x", n], 2), `${parent}/x/${n}`).toBe(true);
    }
  });
  it("ordinary folders are not fixtures", () => {
    for (const n of ["src", "packages", "test", "tests", "fixtures-lib", "my-fixtures", "docs", "spec"]) expect(isFixtureSegment(["a", n], 1), n).toBe(false);
  });
  it("root inside a fixtures folder: split on both separators", () => {
    expect(rootIsInsideFixtures("/home/me/repo/test/fixtures/proj")).toBe(true);
    expect(rootIsInsideFixtures("C:\\Users\\me\\repo\\test\\Fixtures\\proj")).toBe(true);
    expect(rootIsInsideFixtures("C:\\Users\\me\\repo\\test\\golden\\proj")).toBe(true);
    expect(rootIsInsideFixtures("/home/me/repo")).toBe(false);
    expect(rootIsInsideFixtures("C:\\Users\\me\\golden\\repo")).toBe(false);
    expect(rootIsInsideFixtures("")).toBe(false);
    expect(splitSegments("C:\\a\\b/c//d")).toEqual(["C:", "a", "b", "c", "d"]);
  });
  it("the skipper uses the root's own name as a possible test parent", () => {
    const skip = makeFixtureSkipper("/home/me/repo/test");
    expect(skip("golden", ["golden"])).toBe(true);
    expect(skip("fixtures", ["fixtures"])).toBe(true);
    expect(makeFixtureSkipper("/home/me/repo")(  "golden", ["golden"])).toBe(false);
    expect(makeFixtureSkipper("C:\\work\\repo\\tests")("snapshots", ["snapshots"])).toBe(true);
  });
});

describe("fixture folders: skipped by default, for every agent", () => {
  it("nested AGENTS.md, CLAUDE.md, .cursor/rules and skills inside fixtures never show up", () => {
    const w = sample();
    const r = scanWorld(w, { agents: [...ALL] });
    const p = nestedPaths(r);
    expect(p.some((x) => x.includes("/packages/web/AGENTS.md"))).toBe(true);
    expect(p.some((x) => x.includes("/packages/web/.cursor/rules"))).toBe(true);
    expect(paths(r).filter((x) => /fixtures/i.test(x)), "no item path may mention fixtures").toEqual([]);
    expect(JSON.stringify(r.agents.flatMap((a) => a.items.map((i) => i.label)))).not.toContain("fx");
    expect(r.scan.fixturesSkipped).toBe(2); // test/fixtures and src/__fixtures__
  });

  it("the project's own top-level files are never skipped", () => {
    const w = sample();
    const r = scanWorld(w, { agents: [...ALL] });
    expect(paths(r).some((x) => x.endsWith("/project/AGENTS.md"))).toBe(true);
  });

  it("--include-fixtures (includeFixtures) brings every one of them back, and the count disappears", () => {
    const w = sample();
    const r = scanWorld(w, { agents: [...ALL], includeFixtures: true });
    const p = paths(r).join("\n");
    expect(p).toContain("test/fixtures/a/project/AGENTS.md");
    expect(p).toContain("test/fixtures/a/project/CLAUDE.md");
    expect(p).toContain("test/fixtures/a/project/.cursor/rules");
    expect(p).toContain("src/__fixtures__/b/AGENTS.md");
    expect(r.scan.fixturesSkipped).toBeUndefined();
    const off = scanWorld(w, { agents: [...ALL] });
    for (const id of ["claude-code", "cursor"] as const) {
      const on = r.agents.find((a) => a.id === id)!;
      const no = off.agents.find((a) => a.id === id)!;
      expect(on.totals.conditional.est, id).toBeGreaterThan(no.totals.conditional.est);
    }
    // Codex does not load nested AGENTS.md; it lists them as "not loaded", and that list is skipped the same way
    expect(r.excluded.filter((e) => e.agent === "codex" && /fixtures/.test(posix(e.path))).length).toBeGreaterThan(0);
    expect(off.excluded.filter((e) => /fixtures/.test(posix(e.path)))).toEqual([]);
  });

  it("the skip changes nothing when there are no fixture folders (same report, no field)", () => {
    const w = world();
    put(w.project, { "AGENTS.md": "x\n", "packages/web/AGENTS.md": AGENT_TEXT });
    const a = scanWorld(w, { agents: [...ALL] });
    const b = scanWorld(w, { agents: [...ALL], includeFixtures: true });
    expect(JSON.stringify(a.agents)).toBe(JSON.stringify(b.agents));
    expect("fixturesSkipped" in a.scan).toBe(false);
  });

  it("fixture folders without agent files are not counted and cause no note", () => {
    const w = world();
    put(w.project, { "AGENTS.md": "x\n", "test/fixtures/data/a.json": "{}", "test/fixtures/data/deeper/b.txt": "hi", "src/__mocks__/m.ts": "export {}" });
    const r = scanWorld(w, { agents: [...ALL] });
    expect(r.scan.fixturesSkipped).toBeUndefined();
    expect(term(w, r)).not.toMatch(/fixture folder/);
    expect(md(r)).not.toMatch(/fixture folder/);
  });

  it("generic names: test/golden is skipped, a top-level golden/ is not", () => {
    const w = world();
    put(w.project, { "AGENTS.md": "x\n", "test/golden/p/AGENTS.md": AGENT_TEXT, "golden/app/AGENTS.md": AGENT_TEXT, "snapshots/s/AGENTS.md": AGENT_TEXT });
    const p = paths(scanWorld(w, { agents: ["cursor"] })).join("\n");
    expect(p).not.toContain("test/golden");
    expect(p).toContain("golden/app/AGENTS.md");
    expect(p).toContain("snapshots/s/AGENTS.md");
  });

  it("a nested fixtures folder deep inside a package is skipped too, a sibling real package is kept", () => {
    const w = world();
    put(w.project, { "AGENTS.md": "x\n", "packages/a/src/tests/fixtures/AGENTS.md": AGENT_TEXT, "packages/a/AGENTS.md": AGENT_TEXT });
    const r = scanWorld(w, { agents: ["cursor"] });
    const p = paths(r).join("\n");
    expect(p).toContain("packages/a/AGENTS.md");
    expect(p).not.toContain("tests/fixtures");
    expect(r.scan.fixturesSkipped).toBe(1);
  });
});

describe("fixture folders: real agent folders that merely have a fixture-like name are untouched", () => {
  it("a skill named fixtures and a rules sub-folder named fixtures are inside an agent folder, not walked as a tree, so they still count", () => {
    const w = world();
    put(w.project, {
      "AGENTS.md": "x\n",
      ".cursor/skills/fixtures/SKILL.md": skillMd("fixtures", "A real skill that happens to be called fixtures"),
      ".cursor/rules/fixtures/inner.mdc": rule,
    });
    const r = scanWorld(w, { agents: ["cursor"] });
    const p = paths(r).join("\n") + JSON.stringify(r.agents[0].items.map((i) => i.breakdown ?? []));
    expect(p).toContain("fixtures");
    expect(r.scan.fixturesSkipped).toBeUndefined();
  });
});

describe("fixture folders: scanning a fixture directly is never skipped", () => {
  it("the scan root inside test/fixtures: its nested files, even ones in a deeper fixtures folder, are all found", () => {
    const w = world();
    const proj = path.join(w.root, "repo", "test", "fixtures", "case1", "project");
    fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
    put(proj, { "AGENTS.md": "root\n", "sub/AGENTS.md": AGENT_TEXT, "sub/fixtures/AGENTS.md": AGENT_TEXT, "sub/.cursor/rules/r.mdc": rule });
    const r = scanWorld(w, { cwd: proj, agents: [...ALL], ceiling: proj });
    const p = paths(r).join("\n");
    expect(p).toContain("sub/AGENTS.md");
    expect(p).toContain("sub/fixtures/AGENTS.md");
    expect(p).toContain("sub/.cursor/rules");
    expect(r.scan.fixturesSkipped).toBeUndefined();
  });

  it("the scan root IS a fixtures folder", () => {
    const w = world();
    const proj = path.join(w.root, "repo", "fixtures");
    fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
    put(proj, { "sub/AGENTS.md": AGENT_TEXT, "x/__fixtures__/AGENTS.md": AGENT_TEXT });
    const r = scanWorld(w, { cwd: proj, agents: ["cursor"], ceiling: proj });
    expect(paths(r).join("\n")).toContain("x/__fixtures__/AGENTS.md");
  });

  it("the scan root next to fixtures (the repo root) does skip them", () => {
    const w = world();
    const repo = path.join(w.root, "repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    put(repo, { "test/fixtures/case1/project/AGENTS.md": AGENT_TEXT, "pkg/AGENTS.md": AGENT_TEXT });
    const r = scanWorld(w, { cwd: repo, agents: ["codex"], ceiling: repo });
    expect(paths(r).join("\n")).not.toContain("fixtures");
    expect(r.scan.fixturesSkipped).toBe(1);
  });
});

describe("fixture folders: budgets", () => {
  it("a huge fixtures folder does not eat the 5,000-entry walk budget; with --include-fixtures it does (and says so)", () => {
    const w = world();
    put(w.project, { "AGENTS.md": "x\n", "packages/a/AGENTS.md": AGENT_TEXT, "test/fixtures/hit/AGENTS.md": AGENT_TEXT });
    const big = path.join(w.project, "test", "fixtures", "many");
    fs.mkdirSync(big, { recursive: true });
    for (let i = 0; i < 5200; i++) fs.writeFileSync(path.join(big, `f${i}.txt`), "");
    const def = scanWorld(w, { agents: ["cursor"] });
    expect(def.warnings.filter((x) => /walk stopped/.test(x))).toEqual([]);
    expect(paths(def).join("\n")).toContain("packages/a/AGENTS.md");
    expect(def.scan.fixturesSkipped).toBe(1);
    const inc = scanWorld(w, { agents: ["cursor"], includeFixtures: true });
    expect(inc.warnings.some((x) => /walk stopped/.test(x))).toBe(true);
  });

  it("the probe that counts fixture folders looks past thousands of data files to find an agent file", () => {
    const w = world();
    put(w.project, { "AGENTS.md": "x\n" });
    const big = path.join(w.project, "test", "fixtures", "many");
    fs.mkdirSync(big, { recursive: true });
    for (let i = 0; i < 4000; i++) fs.writeFileSync(path.join(big, `f${i}.txt`), "");
    fs.mkdirSync(path.join(w.project, "test", "fixtures", "zz"), { recursive: true });
    fs.writeFileSync(path.join(w.project, "test", "fixtures", "zz", "AGENTS.md"), AGENT_TEXT);
    const r = scanWorld(w, { agents: ["codex"] });
    expect(r.scan.fixturesSkipped).toBe(1);
  });

  it("walkForFiles: skipDir reports skipped folders and does not descend", () => {
    const d = mkTmp("prehello-walk-");
    try {
      put(d, { "a/AGENTS.md": "x", "fixtures/b/AGENTS.md": "x", "c/fixtures/AGENTS.md": "x" });
      const w = walkForFiles(d, ["AGENTS.md"], { skipDir: (n) => n === "fixtures" });
      expect(w.hits.map((h) => posix(path.relative(d, h.dir)))).toEqual(["a"]);
      expect(w.skipped.map((s) => posix(path.relative(d, s))).sort()).toEqual(["c/fixtures", "fixtures"]);
      const p = walkForFiles(path.join(d, "fixtures"), ["AGENTS.md"], { includeRoot: true, stopAtFirstHit: true });
      expect(p.hits).toHaveLength(1);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("fixture folders: the note, in every output", () => {
  it("terminal: one line with the count, only when something was skipped; no paths", () => {
    const w = sample();
    const t = term(w, scanWorld(w, { agents: [...ALL] }));
    expect(t).toContain("Skipped 2 fixture folders with agent files (use --include-fixtures).");
    expect(t).not.toContain("test/fixtures");
    const t1 = term(w, scanWorld(w, { agents: [...ALL], includeFixtures: true }));
    expect(t1).not.toMatch(/Skipped \d+ fixture/);
    const w1 = world();
    put(w1.project, { "AGENTS.md": "x\n", "test/fixtures/p/AGENTS.md": AGENT_TEXT });
    expect(term(w1, scanWorld(w1, { agents: ["codex"] }))).toContain("Skipped 1 fixture folder with agent files (use --include-fixtures).");
  });

  it("JSON: scan.fixturesSkipped (count) is additive and absent when 0; the rest of the shape is identical", () => {
    const w = sample();
    const r = scanWorld(w, { agents: [...ALL] });
    const j = toJson(r, { cwd: w.project, home: w.home }, false) as any;
    expect(j.scan.fixturesSkipped).toBe(2);
    const strict = toJson(r, { cwd: w.project, home: w.home }, true) as any;
    expect(strict.scan.fixturesSkipped).toBe(2);
    const on = toJson(scanWorld(w, { agents: [...ALL], includeFixtures: true }), { cwd: w.project, home: w.home }, false) as any;
    expect("fixturesSkipped" in on.scan).toBe(false);
    expect(Object.keys(j).sort()).toEqual(Object.keys(on).sort());
    expect(Object.keys(j.scan).filter((k) => k !== "fixturesSkipped")).toEqual(Object.keys(on.scan));
  });

  it("Markdown (full and compact) carries the note, with no path", () => {
    const w = sample();
    const r = scanWorld(w, { agents: [...ALL] });
    for (const compact of [false, true]) {
      const t = md(r, compact);
      expect(t).toContain("Skipped 2 fixture folders with agent files (use --include-fixtures to count them).");
      expect(t).not.toContain("test/fixtures");
      expect(t).not.toContain(w.root);
    }
    expect(md(scanWorld(w, { agents: [...ALL], includeFixtures: true }))).not.toMatch(/Skipped \d+ fixture/);
  });

  it("SARIF: a run property with the count, no file location in a fixture folder", () => {
    const w = sample();
    const r = scanWorld(w, { agents: [...ALL] });
    const doc = JSON.parse(renderSarif(r, { anonymize: false, strict: false, cwd: w.project, home: w.home }));
    expect(doc.runs[0].properties.prehello.fixtureFoldersSkipped).toBe(2);
    expect(JSON.stringify(doc)).not.toContain("fixtures/");
    const doc2 = JSON.parse(renderSarif(scanWorld(w, { agents: [...ALL], includeFixtures: true }), { anonymize: false, strict: false, cwd: w.project, home: w.home }));
    expect("fixtureFoldersSkipped" in doc2.runs[0].properties.prehello).toBe(false);
  });

  it("the card still renders and never mentions fixtures", () => {
    const w = sample();
    put(w.home, { ".cursor/skills/alpha/SKILL.md": skillMd("alpha", "Does alpha things when asked") });
    const r = scanWorld(w, { agents: ["cursor"] });
    const a = pickCardAgent(r)!;
    const svg = renderCard(r, a, { theme: "dark", size: "og" });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.toLowerCase()).not.toContain("fixture");
  });

  it("the note is not a warning: the exit-code-3 'partial results' list stays empty", () => {
    const w = sample();
    expect(scanWorld(w, { agents: [...ALL] }).warnings).toEqual([]);
  });
});

describe("fixture folders: CLI", () => {
  const mk = () => {
    const w = sample();
    fs.mkdirSync(path.join(w.project, ".git"), { recursive: true });
    return w;
  };
  it("default skips and says so; --include-fixtures counts them; exit code unchanged", () => {
    const w = mk();
    const a = runCli(["--agent", "codex,cursor", "--ceiling", w.root], { home: w.home, cwd: w.project });
    expect(a.status).toBe(0);
    expect(a.stdout).toContain("Skipped 2 fixture folders with agent files (use --include-fixtures).");
    expect(a.stdout).not.toContain("test/fixtures");
    const b = runCli(["--agent", "codex,cursor", "--include-fixtures", "--ceiling", w.root], { home: w.home, cwd: w.project });
    expect(b.status).toBe(0);
    expect(b.stdout).not.toMatch(/Skipped \d+ fixture/);
    expect(b.stdout).toContain("test/fixtures/a/project/AGENTS.md");
  });
  it("--json carries the count; --markdown and --sarif work with it", () => {
    const w = mk();
    const j = runCli(["--json", "--agent", "codex", "--ceiling", w.root], { home: w.home, cwd: w.project });
    expect(JSON.parse(j.stdout).scan.fixturesSkipped).toBe(2);
    const m = runCli(["--markdown", "--agent", "codex", "--ceiling", w.root], { home: w.home, cwd: w.project });
    expect(m.stdout).toContain("Skipped 2 fixture folders");
    const s = runCli(["--sarif", "--agent", "codex", "--ceiling", w.root], { home: w.home, cwd: w.project });
    expect(JSON.parse(s.stdout).runs[0].properties.prehello.fixtureFoldersSkipped).toBe(2);
  });
  it("--include-fixtures takes no value, and is in --help", () => {
    const w = mk();
    const bad = runCli(["--include-fixtures=1"], { home: w.home, cwd: w.project });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("does not take a value");
    const h = runCli(["--help"], { home: w.home, cwd: w.project });
    expect(h.stdout).toContain("--include-fixtures");
  });
  it("prehello's own repo root: its test fixtures are skipped by default and listed with the flag", () => {
    const home = mkTmp("prehello-emptyhome-");
    try {
      const a = runCli(["--agent", "codex,cursor,claude-code", "--ceiling", ROOT], { home, cwd: ROOT });
      expect(a.stdout).not.toContain("test/fixtures");
      expect(a.stdout).toMatch(/Skipped \d+ fixture folders? with agent files/);
      const b = runCli(["--agent", "codex,cursor,claude-code", "--include-fixtures", "--ceiling", ROOT], { home, cwd: ROOT });
      expect(b.stdout).toContain("test/fixtures/");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
  it("scanning a fixture project directly (path argument) works as before", () => {
    const home = mkTmp("prehello-emptyhome-");
    try {
      const target = path.join(ROOT, "test", "fixtures", "realistic", "project");
      const a = runCli([target, "--agent", "codex,cursor,claude-code", "--ceiling", target], { home, cwd: ROOT });
      expect(a.stdout).not.toMatch(/Skipped \d+ fixture/);
      expect(a.stdout).toContain("AGENTS.md");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
