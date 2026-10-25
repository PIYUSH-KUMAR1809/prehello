import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { materialize, cleanup, runScan, golden, normalize, Mat, FIXTURE_SRC } from "./helpers/fixtures";
import { runCli } from "./helpers/run-cli";
import { renderSarif, sarifText, RULES, SarifOpts } from "../src/render/sarif";
import { toJson } from "../src/render/json";
import { Report } from "../src/model";
import { mkTmp, CAN_SYMLINK, leakForms } from "./helpers/tmp";

afterAll(cleanup);

const validator = (() => {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  return ajv.compile(JSON.parse(fs.readFileSync(path.join(__dirname, "schema", "sarif-schema-2.1.0.json"), "utf8")));
})();

function schemaErrors(doc: unknown): string {
  return validator(doc) ? "" : JSON.stringify(validator.errors?.slice(0, 5));
}

const CANARIES = ["CANARY-FILE-CONTENT-ALPHA", "CANARY-PROJECT-CONTENT-BETA", "CANARYSECRETVALUE1234567890abcdef", "CANARYENVVALUE-xyz", "@canary-org/secret-pkg"];
const NAMES = ["canary-server-name-zeta", "canary-rule-name-gamma"];

const base = (m: Mat, o: Partial<SarifOpts> = {}): SarifOpts => ({ anonymize: false, strict: false, cwd: m.project, home: m.home, ...o });
function sarif(fixture: string, o: Partial<SarifOpts> = {}, scanOpts: Parameters<typeof runScan>[1] = {}): { m: Mat; r: Report; doc: any; text: string } {
  const m = materialize(fixture);
  const r = runScan(m, scanOpts);
  const text = renderSarif(r, base(m, o));
  return { m, r, doc: JSON.parse(text), text };
}
const results = (doc: any): any[] => doc.runs[0].results;
const FIXTURES = fs.readdirSync(FIXTURE_SRC).filter((f) => fs.statSync(path.join(FIXTURE_SRC, f)).isDirectory());

describe("sarif: 2.1.0 schema", () => {
  for (const fx of FIXTURES)
    for (const [label, o] of [["plain", {}], ["anonymized", { anonymize: true }], ["strict", { strict: true, anonymize: true }], ["max-tokens 50", { maxTokens: 50 }]] as const)
      it(`${fx} (${label}) validates against the OASIS schema`, () => {
        const { doc } = sarif(fx, o);
        expect(schemaErrors(doc)).toBe("");
        expect(doc.version).toBe("2.1.0");
      });
  it("hand checks of what GitHub code scanning needs: tool.driver.name, rules with ids, ruleIndex pointing at ruleId, relative uris with uriBaseId, startLine", () => {
    const { doc } = sarif("realistic", { maxTokens: 50 });
    const run = doc.runs[0];
    expect(run.tool.driver.name).toBe("prehello");
    const ids = run.tool.driver.rules.map((x: any) => x.id);
    expect(ids).toEqual(RULES.map((x) => x.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of run.tool.driver.rules) {
      expect(rule.help.text.length).toBeGreaterThan(10);
      expect(rule.shortDescription.text.length).toBeGreaterThan(5);
      expect(rule.helpUri).toBeUndefined(); // no invented URLs
    }
    for (const res of results(doc)) {
      expect(ids[res.ruleIndex]).toBe(res.ruleId);
      expect(["note", "warning"]).toContain(res.level);
      expect(res.message.text.length).toBeGreaterThan(10);
      expect(res.partialFingerprints["prehello/v1"]).toMatch(/^[0-9a-f]{32}$/);
      for (const loc of res.locations) {
        if (loc.physicalLocation) {
          expect(loc.physicalLocation.artifactLocation.uriBaseId).toBe("%SRCROOT%");
          expect(loc.physicalLocation.region.startLine).toBeGreaterThanOrEqual(1);
        } else expect(loc.logicalLocations[0].name.length).toBeGreaterThan(0);
      }
    }
  });
  it("sarifText escapes SARIF link syntax and strips control / bidi characters and secrets", () => {
    expect(sarifText("[x](1)")).toBe("\\[x\\](1)");
    expect(sarifText("a\\b")).toBe("a\\\\b");
    expect(sarifText("a\u202eb\u0007c\nd")).not.toMatch(/[\u202e\u0007\n]/);
    expect(sarifText("sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345")).not.toContain("ABCDEFGHIJ");
    expect(sarifText("")).toBe("(unnamed)");
    expect(sarifText("x".repeat(500)).length).toBeLessThanOrEqual(90);
  });
});

describe("sarif: goldens", () => {
  const cases: [string, string, Partial<SarifOpts>][] = [
    ["plugin-heavy", "sarif-plugin-heavy.sarif", { maxTokens: 4000 }],
    ["plugin-heavy", "sarif-plugin-heavy-anonymized.sarif", { anonymize: true }],
    ["realistic", "sarif-realistic.sarif", { maxTokens: 1000 }],
    ["realistic", "sarif-realistic-strict.sarif", { strict: true, anonymize: true }],
    ["codex-32k-truncate", "sarif-codex-32k-truncate.sarif", {}],
    ["claude-memory-over-200", "sarif-claude-memory-over-200.sarif", {}],
    ["privacy-canary", "sarif-privacy-canary-anonymized.sarif", { anonymize: true }],
    ["empty-machine", "sarif-empty-machine.sarif", {}],
  ];
  for (const [fx, file, o] of cases)
    it(`${fx} -> ${file}`, () => {
      const { m, text } = sarif(fx, o);
      expect(text).not.toContain(m.root);
      const g = golden(file, normalize(text, m));
      expect(g.ok, g.message).toBe(true);
    });
});

describe("sarif: locations", () => {
  it("project files get a relative physicalLocation; user-level items get a logicalLocation and never a path", () => {
    const { doc, m } = sarif("realistic", { maxTokens: 50 });
    const locs = results(doc).flatMap((r: any) => r.locations);
    const uris = locs.map((l: any) => l.physicalLocation?.artifactLocation.uri).filter(Boolean);
    expect(uris).toEqual(expect.arrayContaining(["CLAUDE.md", "AGENTS.md", ".cursor/rules/ignored.md"]));
    const all = JSON.stringify(doc);
    for (const bad of [...leakForms(m.root), ...leakForms(m.home), ...leakForms(m.project), ...leakForms(os.tmpdir()), "/home/", "/Users/", "~/", "..", "file:///"]) expect(all, bad).not.toContain(bad);
    for (const u of uris) {
      expect(u).not.toMatch(/^\/|^[A-Za-z]:|\\|%2F|\.\.\//i);
    }
  });
  it("a user-level secret (in ~/.claude) is reported without any file location", () => {
    const { doc, m } = sarif("privacy-canary", {});
    const secret = results(doc).find((r: any) => r.ruleId === "PH009");
    expect(secret).toBeTruthy();
    expect(secret.locations[0].physicalLocation).toBeUndefined();
    expect(secret.locations[0].logicalLocations[0].name).toBe("context files");
    expect(JSON.stringify(doc)).not.toContain(".claude");
    expect(JSON.stringify(doc)).not.toContain(m.root);
  });
  it("a project secret gets the file and the line (never the value)", () => {
    const m = materialize("empty-machine");
    fs.writeFileSync(path.join(m.project, "CLAUDE.md"), "# rules\nnothing here\napi_key = CANARYSECRETVALUE1234567890abcdef\n");
    const r = runScan(m, { agents: ["claude-code"] });
    const doc = JSON.parse(renderSarif(r, base(m)));
    const s = results(doc).find((x: any) => x.ruleId === "PH009");
    expect(s.locations[0].physicalLocation.artifactLocation.uri).toBe("CLAUDE.md");
    expect(s.locations[0].physicalLocation.region.startLine).toBe(3);
    expect(s.properties.lines).toEqual([3]);
    expect(JSON.stringify(doc)).not.toContain("CANARYSECRETVALUE");
    expect(schemaErrors(doc)).toBe("");
    // --redact: no locations at all
    const strict = JSON.parse(renderSarif(r, base(m, { strict: true, anonymize: true })));
    expect(JSON.stringify(strict)).not.toContain("physicalLocation");
    expect(JSON.stringify(strict)).not.toContain('"uri"');
  });
  it("odd file names: percent-encoded uri, secret-shaped or control-character names lose the location instead of leaking", () => {
    const m = materialize("empty-machine");
    const big = "word ".repeat(2500);
    fs.mkdirSync(path.join(m.project, ".cursor", "rules"), { recursive: true });
    fs.writeFileSync(path.join(m.project, ".cursor", "rules", "my rule #1 (é).mdc"), `---\nalwaysApply: true\n---\n${big}`);
    fs.writeFileSync(path.join(m.project, ".cursor", "rules", "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123.mdc"), `---\nalwaysApply: true\n---\n${big} other`);
    const r = runScan(m, { agents: ["cursor"] });
    const doc = JSON.parse(renderSarif(r, base(m)));
    const uris = results(doc).map((x: any) => x.locations[0].physicalLocation?.artifactLocation.uri).filter(Boolean);
    expect(uris).toContain(".cursor/rules/my%20rule%20%231%20(%C3%A9).mdc");
    expect(JSON.stringify(doc)).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123");
    expect(schemaErrors(doc)).toBe("");
  });
  it("when the scanned folder is the home folder (or contains it), no file locations are written", () => {
    const m = materialize("realistic");
    fs.writeFileSync(path.join(m.home, "CLAUDE.md"), "word ".repeat(3000));
    const r = runScan(m, { cwd: m.home });
    const doc = JSON.parse(renderSarif(r, { anonymize: false, strict: false, cwd: m.home, home: m.home }));
    expect(JSON.stringify(doc)).not.toContain("physicalLocation");
    expect(doc.runs[0].properties.prehello.fileLocations).toBe(false);
  });
  it.skipIf(!CAN_SYMLINK)("a symlink inside the project that points outside is not a project location", () => {
    const m = materialize("empty-machine");
    const outside = path.join(m.root, "outside.md");
    fs.writeFileSync(outside, "word ".repeat(3000));
    try {
      fs.symlinkSync(outside, path.join(m.project, "AGENTS.md"));
    } catch {
      return;
    }
    const r = runScan(m, { agents: ["codex"] });
    const doc = JSON.parse(renderSarif(r, base(m)));
    expect(JSON.stringify(doc)).not.toContain("physicalLocation");
    expect(JSON.stringify(doc)).not.toContain(m.root);
  });
});

describe("sarif: honest numbers", () => {
  it("every token number is labelled an estimate; unmeasured items never carry a number; lower bounds say so", () => {
    const { doc, r } = sarif("realistic", { maxTokens: 50 });
    for (const res of results(doc)) {
      for (const p of res.properties.perAgent ?? []) {
        if ("estimateTokens" in p) expect(p.isEstimate).toBe(true);
      }
      expect(JSON.stringify(res)).not.toMatch(/"(estimateTokens|alwaysTokensAtLeast)":\s*0[,}\s]/);
    }
    const ph3 = results(doc).filter((x: any) => x.ruleId === "PH003");
    expect(ph3.length).toBeGreaterThan(0);
    for (const x of ph3) {
      expect(x.message.text).toMatch(/at least ~/);
      expect(x.properties.perAgent[0].isLowerBound).toBe(true);
    }
    const ph4 = results(doc).filter((x: any) => x.ruleId === "PH004");
    expect(ph4.length).toBeGreaterThan(0);
    for (const x of ph4) expect(x.message.text).toMatch(/unknown, not zero/);
    const props = doc.runs[0].properties.prehello;
    for (const a of props.agents) {
      const rep = r.agents.find((y) => y.id === a.id)!;
      expect(a.always.isLowerBound).toBe(rep.lowerBound);
      expect(a.always.estimateTokens).toBe(rep.totals.always.measuredItems ? rep.totals.always.est : null);
    }
  });
  it("an all-unmeasured agent has estimateTokens null (never 0) in the run properties", () => {
    const m = materialize("empty-machine");
    fs.writeFileSync(path.join(m.project, ".mcp.json"), JSON.stringify({ mcpServers: { alpha: { command: "x" } } }));
    const r = runScan(m, { agents: ["claude-code"] });
    const doc = JSON.parse(renderSarif(r, base(m)));
    const a = doc.runs[0].properties.prehello.agents[0];
    expect(a.always.estimateTokens).toBeNull();
    expect(a.always.isLowerBound).toBe(true);
    const ph4 = results(doc).find((x: any) => x.ruleId === "PH004");
    expect(ph4.message.text).not.toMatch(/at least ~/);
    expect(ph4.properties.perAgent[0].alwaysTokensAtLeast).toBeNull();
  });
  it("numbers agree with --json for the same scan (always-on totals, per-group tokens, window)", () => {
    const { doc, r, m } = sarif("plugin-heavy", {});
    const j: any = toJson(r, { cwd: m.project, home: m.home }, false);
    for (const a of doc.runs[0].properties.prehello.agents) {
      const ja = j.agents.find((x: any) => x.id === a.id);
      expect(a.always.estimateTokens).toBe(ja.totals.always.est);
      expect(a.always.lowTokens).toBe(ja.totals.always.low);
      expect(a.always.highTokens).toBe(ja.totals.always.high);
      expect(a.savings.estimateTokens).toBe(ja.savings.topTokens);
    }
    const groups = results(doc).filter((x: any) => x.ruleId === "PH002");
    const jTop: number[] = j.agents[0].savings.top.map((c: any) => c.tokens);
    for (const g of groups) expect(jTop).toContain(g.properties.perAgent[0].estimateTokens);
    expect(doc.runs[0].properties.prehello.windowTokens).toBe(j.scan.window);
  });
  it("levels: a group at 5% of the window or more is a warning, below it a note", () => {
    const { doc } = sarif("plugin-heavy", {}, { window: 20_000 });
    const lv = results(doc).filter((x: any) => x.ruleId === "PH002").map((x: any) => x.level);
    expect(lv).toContain("warning");
    const { doc: d2 } = sarif("plugin-heavy", {}, { window: 1_000_000 });
    expect(results(d2).filter((x: any) => x.ruleId === "PH002").every((x: any) => x.level === "note")).toBe(true);
  });
  it("PH003 only exists with --max-tokens, and mirrors the CLI gate", () => {
    const { doc } = sarif("plugin-heavy", {});
    expect(results(doc).some((x: any) => x.ruleId === "PH003")).toBe(false);
    const { doc: d2 } = sarif("plugin-heavy", { maxTokens: 100 });
    expect(results(d2).some((x: any) => x.ruleId === "PH003")).toBe(true);
    const { doc: d3 } = sarif("plugin-heavy", { maxTokens: 1_000_000 });
    expect(results(d3).some((x: any) => x.ruleId === "PH003")).toBe(false);
  });
  it("output is deterministic and results are sorted", () => {
    const a = sarif("realistic", { maxTokens: 50 });
    const b = renderSarif(runScan(a.m), base(a.m, { maxTokens: 50 }));
    expect(b).toBe(a.text);
    const ids = results(a.doc).map((x: any) => x.ruleId);
    expect(ids).toEqual([...ids].sort());
  });
});

describe("sarif: privacy and escaping", () => {
  for (const [label, o] of [["plain", {}], ["anonymized", { anonymize: true }], ["strict", { strict: true, anonymize: true }]] as const)
    it(`canary fixture, ${label}: no contents, secrets, env values or home paths`, () => {
      const { text, m } = sarif("privacy-canary", o);
      for (const s of CANARIES) expect(text).not.toContain(s);
      expect(text).not.toContain(m.root);
      expect(text).not.toContain(m.home);
      if (o.anonymize) for (const s of NAMES) expect(text).not.toContain(s);
    });
  it("finding and warning texts never appear (they name user-level files)", () => {
    const { text, r } = sarif("realistic", { maxTokens: 50 });
    for (const f of r.findings) expect(text).not.toContain(f.message);
    for (const w of r.warnings) expect(text).not.toContain(w);
    expect(text).not.toContain("~/.");
  });
  it("hostile plugin / MCP server names cannot forge links, control sequences or secrets in messages", () => {
    const m = materialize("empty-machine");
    const names = ["[click](https://evil.example)", "a\u202eb\u001b[31mred", "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345", "x\\](0) \" } , \"level\": \"error\""];
    fs.writeFileSync(path.join(m.project, ".mcp.json"), JSON.stringify({ mcpServers: Object.fromEntries(names.map((n) => [n, { command: "x" }])) }));
    const r = runScan(m, { agents: ["claude-code"] });
    const text = renderSarif(r, base(m));
    const doc = JSON.parse(text);
    expect(schemaErrors(doc)).toBe("");
    expect(text).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
    expect(text).not.toMatch(/[\u202e\u001b]/);
    for (const res of results(doc)) expect(res.message.text).not.toMatch(/(^|[^\\])\[[^\]]*\]\(/);
    expect(results(doc).every((x: any) => x.level === "note" || x.level === "warning")).toBe(true);
  });
  it("anonymized: plugin names are replaced in messages, logical locations and fingerprints are stable", () => {
    const a = sarif("plugin-heavy", { anonymize: true });
    expect(a.text).not.toMatch(/analytics-kit|design-kit|cloud-kit/);
    expect(a.text).toMatch(/plugin 1/);
    const b = sarif("plugin-heavy", { anonymize: true });
    expect(results(b.doc).map((x: any) => x.partialFingerprints)).toEqual(results(a.doc).map((x: any) => x.partialFingerprints));
  });
});

describe("sarif CLI", () => {
  const args = (m: Mat, extra: string[]) => [m.project, "--ceiling", m.root, "--managed-dir", path.join(m.root, "none"), "--no-bundled-catalog", ...extra];

  it("--sarif goes to stdout as pure SARIF, replaces the terminal report, touches nothing, validates", () => {
    const m = materialize("realistic");
    const res = runCli(args(m, ["--sarif"]), { home: m.home, cwd: m.project });
    expect([0, 3]).toContain(res.status);
    expect(res.guardLog).toBe("");
    const doc = JSON.parse(res.stdout);
    expect(schemaErrors(doc)).toBe("");
    expect(res.stdout).not.toMatch(/ALWAYS ON/);
    expect(res.stdout).not.toContain(m.root);
    expect(res.stdout.endsWith("}\n")).toBe(true);
  });
  it("--max-tokens keeps its exit code with --sarif; the SARIF is still printed and has PH003", () => {
    const m = materialize("plugin-heavy");
    const res = runCli(args(m, ["--sarif", "--max-tokens", "100"]), { home: m.home, cwd: m.project });
    expect(res.status).toBe(2);
    const doc = JSON.parse(res.stdout);
    expect(results(doc).some((x: any) => x.ruleId === "PH003")).toBe(true);
    expect(res.stderr).toMatch(/--max-tokens/);
    expect(runCli(args(m, ["--sarif", "--max-tokens", "1m"]), { home: m.home, cwd: m.project }).status).toBe(0);
  });
  it("--redact and --anonymize", () => {
    const m = materialize("plugin-heavy");
    for (const flag of ["--redact", "--anonymize", "--card-anonymize"]) {
      const res = runCli(args(m, ["--sarif", flag]), { home: m.home, cwd: m.project });
      expect(res.stdout, flag).not.toMatch(/analytics-kit|design-kit|cloud-kit/);
    }
    const c = materialize("realistic");
    const res = runCli(args(c, ["--sarif", "--redact"]), { home: c.home, cwd: c.project });
    expect(res.stdout).not.toContain("physicalLocation");
    const c2 = materialize("privacy-canary");
    const r2 = runCli(args(c2, ["--sarif", "--redact"]), { home: c2.home, cwd: c2.project });
    for (const s of [...CANARIES, ...NAMES]) expect(r2.stdout + r2.stderr).not.toContain(s);
  });
  it("--agent and --window are respected", () => {
    const m = materialize("realistic");
    const res = runCli(args(m, ["--sarif", "--agent", "codex", "--window", "100k"]), { home: m.home, cwd: m.project });
    const doc = JSON.parse(res.stdout);
    expect(doc.runs[0].properties.prehello.agents.map((a: any) => a.id)).toEqual(["codex"]);
    expect(doc.runs[0].properties.prehello.windowTokens).toBe(100_000);
  });
  it("conflicts: --json, --fix and --markdown cannot share stdout with --sarif; bad extensions are refused", () => {
    const m = materialize("plugin-heavy");
    for (const other of [["--json"], ["--fix"], ["--markdown"], ["--markdown-compact"]]) {
      const res = runCli(args(m, ["--sarif", ...other]), { home: m.home, cwd: m.project });
      expect(res.status, other.join()).toBe(1);
      expect(res.stderr).toMatch(/standard output/);
      expect(res.stdout).toBe("");
    }
    for (const bad of ["--sarif=report.json", "--sarif=report.txt", "--sarif=report"]) {
      const res = runCli(args(m, [bad]), { home: m.home, cwd: m.project });
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/\.sarif or \.sarif\.json/);
    }
  });
  it("a file for each: --sarif=<file> with --json (stdout) or --markdown (stdout) works and stdout stays pure", () => {
    const m = materialize("plugin-heavy");
    const out = mkTmp("prehello-sf-");
    const sf = path.join(out, "r.sarif");
    const a = runCli(args(m, ["--json", `--sarif=${sf}`]), { home: m.home, cwd: m.project, allowWrite: [sf] });
    expect(a.status).toBe(0);
    expect(JSON.parse(a.stdout).schemaVersion).toBe(1);
    expect(a.stderr).toMatch(/SARIF report written/);
    expect(schemaErrors(JSON.parse(fs.readFileSync(sf, "utf8")))).toBe("");
    const b = runCli(args(m, ["--markdown", `--sarif=${sf}`]), { home: m.home, cwd: m.project, allowWrite: [sf] });
    expect(b.status).toBe(0);
    expect(b.stdout.startsWith("## prehello report")).toBe(true);
    fs.rmSync(out, { recursive: true, force: true });
  });
  it("--sarif=<file>: terminal report still prints; .sarif.json works; own file is replaced, foreign file is refused without --force", () => {
    const m = materialize("plugin-heavy");
    const out = mkTmp("prehello-sf-");
    const f = path.join(out, "report.sarif.json");
    const res = runCli(args(m, [`--sarif=${f}`]), { home: m.home, cwd: m.project, allowWrite: [f] });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/ALWAYS ON/);
    expect(res.stdout).toContain("SARIF report written");
    expect(JSON.parse(fs.readFileSync(f, "utf8")).version).toBe("2.1.0");
    expect(runCli(args(m, [`--sarif=${f}`]), { home: m.home, cwd: m.project, allowWrite: [f] }).status).toBe(0);
    const foreign = path.join(out, "mine.sarif");
    fs.writeFileSync(foreign, "{\"version\":\"2.1.0\",\"runs\":[]}\n");
    const refused = runCli(args(m, [`--sarif=${foreign}`]), { home: m.home, cwd: m.project, allowWrite: [foreign] });
    expect(refused.status).toBe(1);
    expect(fs.readFileSync(foreign, "utf8")).toContain('"runs":[]');
    // a prehello JSON report is not a SARIF report: do not replace it either
    const asJson = path.join(out, "j.sarif");
    fs.writeFileSync(asJson, JSON.stringify({ tool: { name: "prehello" } }));
    expect(runCli(args(m, [`--sarif=${asJson}`]), { home: m.home, cwd: m.project, allowWrite: [asJson] }).status).toBe(1);
    expect(runCli(args(m, [`--sarif=${foreign}`, "--force"]), { home: m.home, cwd: m.project, allowWrite: [foreign] }).status).toBe(0);
    expect(JSON.parse(fs.readFileSync(foreign, "utf8")).version).toBe("2.1.0");
    fs.rmSync(out, { recursive: true, force: true });
  });
  it.skipIf(!CAN_SYMLINK)("--sarif=<file> never follows a symlink and never overwrites a scanned context file", () => {
    const m = materialize("plugin-heavy");
    const out = mkTmp("prehello-ss-");
    const victim = path.join(out, "victim.sarif");
    fs.writeFileSync(victim, "precious\n");
    const link = path.join(out, "link.sarif");
    let linked = true;
    try {
      fs.symlinkSync(victim, link);
    } catch {
      linked = false;
    }
    if (linked) {
      const res = runCli(args(m, [`--sarif=${link}`, "--force"]), { home: m.home, cwd: m.project, allowWrite: [link] });
      expect(res.status).toBe(1);
      expect(fs.readFileSync(victim, "utf8")).toBe("precious\n");
    }
    // a context file can never be the target (extension check refuses it first)
    const agents = path.join(m.project, "AGENTS.md");
    const before = fs.readFileSync(agents, "utf8");
    expect(runCli(args(m, [`--sarif=${agents}`, "--force"]), { home: m.home, cwd: m.project, allowWrite: [agents] }).status).toBe(1);
    expect(fs.readFileSync(agents, "utf8")).toBe(before);
    fs.rmSync(out, { recursive: true, force: true });
  });
  it("without a permitted write the guard sees nothing: --sarif to stdout writes no file; a bad value still gives a clean error", () => {
    const m = materialize("realistic");
    expect(runCli(args(m, ["--sarif"]), { home: m.home, cwd: m.project }).guardLog).toBe("");
    const bad = runCli(args(m, ["--sarif=nosuchdir/x.sarif"]), { home: m.home, cwd: m.project, allowWrite: [path.resolve(m.project, "nosuchdir/x.sarif")] });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/SARIF report not written|could not write SARIF/);
    expect(bad.stderr).not.toMatch(/at .*\.js:\d+/);
  });
  it("--help documents --sarif", () => {
    const res = runCli(["--help"], { home: os.tmpdir() });
    expect(res.stdout).toMatch(/--sarif\[=<file>\]/);
    expect(res.stdout).toMatch(/PH001/);
  });
});
