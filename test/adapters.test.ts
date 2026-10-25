import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { materialize, cleanup, runScan, terminalOf, jsonOf, golden, Mat } from "./helpers/fixtures";
import { CAN_SYMLINK, posix } from "./helpers/tmp";
import { AgentId, Report, LoadMode } from "../src/model";
import { makeCounter } from "../src/tokens/counter";

afterAll(cleanup);

const agent = (r: Report, id: AgentId) => r.agents.find((a) => a.id === id);
const rel = (m: Mat, p: string) => path.posix.relative(posix(m.root), posix(p));
const itemsOf = (r: Report, id: AgentId, mode?: LoadMode) => (agent(r, id)?.items ?? []).filter((i) => !mode || i.loadMode === mode);
const paths = (m: Mat, r: Report, id: AgentId, mode?: LoadMode) => itemsOf(r, id, mode).map((i) => rel(m, i.path));

describe("claude-code adapter", () => {
  it("realistic: always/conditional/deferred split, @imports counted, AGENTS.md excluded, MCP unmeasured", () => {
    const m = materialize("realistic");
    const r = runScan(m);
    const cc = agent(r, "claude-code")!;
    expect(cc.detected).toBe(true);
    const always = paths(m, r, "claude-code", "always");
    expect(always).toContain("project/CLAUDE.md");
    expect(always).toContain("home/.claude/CLAUDE.md");
    expect(always).not.toContain("project/AGENTS.md");
    const claudeMd = itemsOf(r, "claude-code", "always").find((i) => posix(i.path).endsWith("project/CLAUDE.md"))!;
    expect(claudeMd.detail).toMatch(/@import/);
    expect(claudeMd.confidence).toBe("documented");
    expect(r.excluded.some((e) => e.agent === "claude-code" && posix(e.path).endsWith("project/AGENTS.md"))).toBe(true);
    expect(r.findings.some((f) => f.id === "F7")).toBe(true);
    // path-scoped rule is conditional, unscoped rule is always
    expect(itemsOf(r, "claude-code", "conditional").some((i) => i.kind === "rule")).toBe(true);
    expect(itemsOf(r, "claude-code", "always").some((i) => i.kind === "rule")).toBe(true);
    // skills: listing always, body deferred
    expect(itemsOf(r, "claude-code", "always").some((i) => i.kind === "skills-listing")).toBe(true);
    expect(itemsOf(r, "claude-code", "deferred").some((i) => i.kind === "skill-body")).toBe(true);
    // MCP servers: found, unmeasured (never 0)
    const mcp = itemsOf(r, "claude-code").filter((i) => i.kind === "mcp-server");
    expect(mcp.length).toBe(4);
    for (const i of mcp) {
      expect(i.tokens).toBeNull();
      expect(i.unmeasuredReason).toBeTruthy();
    }
    expect(cc.totals.always.unmeasuredItems).toBe(4);
    expect(cc.grade?.provisional).toBe(true);
  });

  it("claude-agents-and-claude: CLAUDE.md wins, AGENTS.md not counted for Claude", () => {
    const m = materialize("claude-agents-and-claude");
    const r = runScan(m);
    expect(paths(m, r, "claude-code", "always")).toEqual(["project/CLAUDE.md"]);
    expect(r.findings.map((f) => f.id)).toContain("F7");
  });

  it("claude-agents-md-only: AGENTS.md used as fallback with a version note", () => {
    const m = materialize("claude-agents-md-only");
    const r = runScan(m);
    expect(paths(m, r, "claude-code", "always")).toEqual(["project/AGENTS.md"]);
    expect(itemsOf(r, "claude-code")[0].notes.join(" ")).toMatch(/2\.1\.277/);
  });

  it("claude-memory-over-200: only first 200 lines of MEMORY.md count, F8 raised, derivation flagged assumed", () => {
    const m = materialize("claude-memory-over-200");
    const r = runScan(m);
    const mem = itemsOf(r, "claude-code", "always").find((i) => i.kind === "memory")!;
    expect(mem).toBeTruthy();
    expect(mem.notes.join(" ")).toMatch(/only first 200 of \d+ lines/);
    expect(r.findings.some((f) => f.id === "F8")).toBe(true);
    const file = fs.readdirSync(path.join(m.home, ".claude", "projects"))[0];
    const full = fs.readFileSync(path.join(m.home, ".claude", "projects", file, "memory", "MEMORY.md"), "utf8");
    expect(full.split("\n").length).toBeGreaterThan(200);
    const fullTokens = Math.round(makeCounter("auto").count(full.replace(/\r\n/g, "\n")) * 1.5);
    const first200 = Math.round(makeCounter("auto").count(full.split("\n").slice(0, 200).join("\n")) * 1.5);
    expect(mem.tokens!.est).toBeLessThan(fullTokens);
    expect(Math.abs(mem.tokens!.est - first200)).toBeLessThan(first200 * 0.02);
  });

  it("claude-mcp-toolsearch-off: servers unmeasured and the schema-upfront assumption is stated", () => {
    const m = materialize("claude-mcp-toolsearch-off");
    const r = runScan(m);
    const mcp = itemsOf(r, "claude-code").filter((i) => i.kind === "mcp-server");
    expect(mcp.length).toBe(2);
    expect(mcp.every((i) => i.tokens === null && i.loadMode === "always")).toBe(true);
    expect(mcp[0].notes.join(" ")).toMatch(/ENABLE_TOOL_SEARCH=false/);
  });

  it("mcp-catalog: measured only when a catalog entry exists; fixture-labelled data; others stay unmeasured", () => {
    const m = materialize("mcp-catalog");
    const without = runScan(m);
    expect(itemsOf(without, "claude-code").filter((i) => i.kind === "mcp-server").every((i) => i.tokens === null)).toBe(true);
    const r = runScan(m, { catalogPath: path.join(m.root, "catalog.json") });
    const mcp = itemsOf(r, "claude-code").filter((i) => i.kind === "mcp-server");
    const measured = mcp.filter((i) => i.tokens !== null);
    const unmeasured = mcp.filter((i) => i.tokens === null);
    expect(measured.length).toBeGreaterThanOrEqual(1);
    expect(unmeasured.map((i) => i.label).join(" ")).toMatch(/mystery/);
    expect(measured.some((i) => i.notes.join(" ").includes("FIXTURE DATA") || i.confidence === "assumed")).toBe(true);
    expect(agent(r, "claude-code")!.totals.always.unmeasuredItems).toBe(unmeasured.length);
  });

  it("monorepo-ancestors: ancestors load at launch, descendants are conditional", () => {
    const m = materialize("monorepo-ancestors");
    const cwd = path.join(m.project, "apps", "web");
    const r = runScan(m, { cwd });
    const always = paths(m, r, "claude-code", "always");
    expect(always).toEqual(
      expect.arrayContaining([
        "project/CLAUDE.md",
        "project/apps/CLAUDE.md",
        "project/apps/web/.claude/CLAUDE.md",
        "project/apps/web/CLAUDE.local.md",
      ]),
    );
    expect(paths(m, r, "claude-code", "conditional")).toEqual(["project/apps/web/src/CLAUDE.md"]);
    // launched from the repo root, all nested files are conditional
    const r2 = runScan(m);
    expect(paths(m, r2, "claude-code", "always")).toEqual(["project/CLAUDE.md"]);
    expect(paths(m, r2, "claude-code", "conditional").length).toBe(4);
  });
});

describe("cursor adapter", () => {
  it("realistic: rule modes, ignored .md, AGENTS.md always, user rules not on disk", () => {
    const m = materialize("realistic");
    const r = runScan(m);
    const cu = agent(r, "cursor")!;
    expect(cu.detected).toBe(true);
    const by = (mode: LoadMode) => itemsOf(r, "cursor", mode);
    expect(by("always").some((i) => i.kind === "rule" && /alwaysApply/.test(i.notes.join(" ")))).toBe(true);
    expect(by("always").some((i) => i.kind === "rule-description")).toBe(true);
    expect(by("deferred").some((i) => i.kind === "rule-body")).toBe(true);
    expect(by("conditional").some((i) => i.kind === "rule")).toBe(true);
    expect(by("on-demand").some((i) => i.kind === "rule")).toBe(true);
    expect(by("always").some((i) => i.path.endsWith("AGENTS.md"))).toBe(true);
    expect(r.excluded.some((e) => e.agent === "cursor" && e.path.endsWith("ignored.md"))).toBe(true);
    expect(r.findings.some((f) => f.id === "F11" && f.agent === "cursor")).toBe(true);
    expect(cu.profile.id).toBe("cursor-mixed");
    expect(cu.unmeasuredBanner.join(" ")).toMatch(/User Rules/);
  });
});

describe("codex adapter", () => {
  it("codex-32k-truncate: concatenation cap truncates, F12 raised, nested files excluded", () => {
    const m = materialize("codex-32k-truncate");
    const r = runScan(m, { agents: ["codex"] });
    const it0 = itemsOf(r, "codex", "always")[0];
    expect(it0.notes.join(" ")).toMatch(/32768\/\d+ bytes/);
    expect(r.findings.some((f) => f.id === "F12")).toBe(true);
    expect(r.excluded.some((e) => e.agent === "codex" && /sub\/AGENTS\.md$/.test(posix(e.path)))).toBe(true);
    // tokens measured only for the loaded 32 KiB prefix
    expect(it0.chars).toBeLessThanOrEqual(32768);
  });

  it("codex-chain-override: one file per directory, override beats AGENTS.md, fallback names honoured", () => {
    const m = materialize("codex-chain-override");
    const cwd = path.join(m.project, "services", "api", "handlers");
    const r = runScan(m, { cwd, agents: ["codex"] });
    const got = paths(m, r, "codex", "always");
    expect(got).toContain("project/services/api/AGENTS.override.md");
    expect(got).not.toContain("project/services/api/AGENTS.md");
    expect(got).toContain("project/services/api/handlers/TEAM_GUIDE.md");
    expect(got).toContain("home/.codex/AGENTS.override.md");
    expect(r.excluded.some((e) => posix(e.path).endsWith("services/api/AGENTS.md") && /shadowed/.test(e.reason))).toBe(true);
  });
});

describe("detection and edge fixtures", () => {
  it("empty-machine: no agents, nothing reported as zero", () => {
    const m = materialize("empty-machine");
    const r = runScan(m);
    expect(r.agents).toHaveLength(0);
    expect(terminalOf(r, m)).toMatch(/Nothing was measured/);
  });

  it("repo-only: agents only present in the repo are collapsed and not in the headline", () => {
    const m = materialize("repo-only");
    const r = runScan(m);
    expect(r.agents.length).toBeGreaterThan(0);
    expect(r.agents.every((a) => a.presentInRepoOnly)).toBe(true);
    const t = terminalOf(r, m);
    expect(t).not.toMatch(/Before your first message/);
    expect(t).toMatch(/excluded from headline and card/);
    // forced selection brings them back
    const forced = runScan(m, { agents: ["claude-code"] });
    expect(agent(forced, "claude-code")!.presentInRepoOnly).toBe(false);
    expect(agent(forced, "claude-code")!.totals.always.est).toBeGreaterThan(0);
  });

  it.skipIf(!CAN_SYMLINK)("symlink-escape: symlink leaving the project is skipped and its target is never read", () => {
    const m = materialize("symlink-escape");
    const r = runScan(m);
    expect(r.warnings.join(" ")).toMatch(/symlink points outside/);
    const it0 = itemsOf(r, "claude-code").find((i) => i.path.endsWith("CLAUDE.md"))!;
    expect(it0.tokens).toBeNull(); // exists but not measured: unmeasured, never 0
    expect(agent(r, "claude-code")!.totals.always.est).toBe(0);
    expect(agent(r, "claude-code")!.totals.always.unmeasuredItems).toBe(1);
    expect(terminalOf(r, m) + jsonOf(r, m)).not.toContain("OUTSIDE-CANARY");
  });

  it("binary-garbage: binary file skipped with a warning", () => {
    const m = materialize("binary-garbage");
    const r = runScan(m);
    expect(r.warnings.join(" ")).toMatch(/binary content/);
    const it0 = itemsOf(r, "claude-code").find((i) => i.path.endsWith("CLAUDE.md"))!;
    expect(it0.tokens).toBeNull();
    expect(it0.unmeasuredReason).toMatch(/binary/);
    expect(agent(r, "claude-code")!.grade).toBeNull(); // nothing measured -> no grade
  });

  it("crlf-unicode: CRLF/BOM/emoji/RTL content is counted and rendered safely", () => {
    const m = materialize("crlf-unicode");
    const r = runScan(m);
    const it0 = itemsOf(r, "claude-code", "always")[0];
    expect(it0.tokens!.est).toBeGreaterThan(0);
    expect(it0.chars).toBeGreaterThan(0);
    const out = terminalOf(r, m);
    expect(out).not.toMatch(/[\u202e\u2066\u2069\r]/);
  });
});

describe("goldens (fixture HOME + project; deterministic)", () => {
  const cases: Array<[string, { cwdRel?: string; agents?: AgentId[]; catalog?: boolean }]> = [
    ["realistic", {}],
    ["claude-agents-and-claude", {}],
    ["claude-agents-md-only", {}],
    ["claude-memory-over-200", {}],
    ["claude-mcp-toolsearch-off", {}],
    ["mcp-catalog", { catalog: true }],
    ["codex-chain-override", { cwdRel: "services/api/handlers", agents: ["codex"] }],
    ["codex-32k-truncate", { agents: ["codex"] }],
    ["monorepo-ancestors", { cwdRel: "apps/web" }],
    ["empty-machine", {}],
    ["repo-only", {}],
    ["symlink-escape", {}],
    ["crlf-unicode", {}],
    ["binary-garbage", {}],
    ["privacy-canary", {}],
    ["plugin-heavy", { agents: ["cursor"] }],
  ];
  for (const [name, o] of cases) {
    it.skipIf(name === "symlink-escape" && !CAN_SYMLINK)(`${name}: terminal + json match goldens`, () => {
      const m = materialize(name);
      const r = runScan(m, {
        ...(o.cwdRel ? { cwd: path.join(m.project, o.cwdRel) } : {}),
        ...(o.agents ? { agents: o.agents } : {}),
        ...(o.catalog ? { catalogPath: path.join(m.root, "catalog.json") } : {}),
      });
      const t = golden(`${name}.terminal.txt`, terminalOf(r, m, true));
      expect(t.ok, t.message).toBe(true);
      const j = golden(`${name}.json`, jsonOf(r, m, false));
      expect(j.ok, j.message).toBe(true);
    });
  }
});

describe("determinism", () => {
  it("two scans of the same fixture are identical", () => {
    const m = materialize("realistic");
    expect(jsonOf(runScan(m), m)).toBe(jsonOf(runScan(m), m));
  });
  it("heuristic tokenizer: still works and is labelled", () => {
    const m = materialize("realistic");
    const r = runScan(m, { tokenizer: "heuristic" });
    expect(r.scan.tokenizer.method).toBe("heuristic");
    expect(agent(r, "codex")!.profile.band).toBe("±35%");
  });
});
