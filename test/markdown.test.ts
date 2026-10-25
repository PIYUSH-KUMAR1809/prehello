import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { materialize, cleanup, runScan, golden, Mat } from "./helpers/fixtures";
import { runCli } from "./helpers/run-cli";
import { renderMarkdown, mdCode, MarkdownOpts } from "../src/render/markdown";
import { Report } from "../src/model";

afterAll(cleanup);

const CANARIES = ["CANARY-FILE-CONTENT-ALPHA", "CANARY-PROJECT-CONTENT-BETA", "CANARYSECRETVALUE1234567890abcdef", "CANARYENVVALUE-xyz", "@canary-org/secret-pkg"];
const NAMES = ["canary-server-name-zeta", "canary-rule-name-gamma"];
const BASE: MarkdownOpts = { anonymize: false, compact: false, headline: "cut" };

function md(fixture: string, o: Partial<MarkdownOpts> = {}, scanOpts: Parameters<typeof runScan>[1] = {}): { m: Mat; r: Report; text: string } {
  const m = materialize(fixture);
  const r = runScan(m, scanOpts);
  return { m, r, text: renderMarkdown(r, { ...BASE, ...o }) };
}

function checkGolden(name: string, text: string) {
  const g = golden(name, text);
  expect(g.ok, g.message).toBe(true);
}

describe("markdown goldens", () => {
  const cases: [string, string, Partial<MarkdownOpts>][] = [
    ["plugin-heavy", "markdown-plugin-heavy.md", {}],
    ["plugin-heavy", "markdown-plugin-heavy-compact.md", { compact: true }],
    ["plugin-heavy", "markdown-plugin-heavy-anonymized.md", { anonymize: true }],
    ["plugin-heavy", "markdown-plugin-heavy-total.md", { headline: "total" }],
    ["realistic", "markdown-realistic.md", {}],
    ["empty-machine", "markdown-empty-machine.md", {}],
    ["mcp-catalog", "markdown-mcp-catalog.md", {}],
    ["privacy-canary", "markdown-privacy-canary-anonymized.md", { anonymize: true }],
  ];
  for (const [fx, file, o] of cases)
    it(`${fx} -> ${file}`, () => {
      const { m, text } = md(fx, o);
      // goldens are machine independent: no temp dir, home or slug in them
      expect(text).not.toContain(m.root);
      checkGolden(file, text);
    });
});

describe("markdown honest numbers", () => {
  it("lower bounds say 'at least', unmeasured items say 'not measured' and are never 0, the grade is provisional", () => {
    const { text } = md("realistic");
    expect(text).toMatch(/\*\*At least ~[\d.]+k? tokens load before hello\*\*/);
    expect(text).toMatch(/MCP server `github` \| not measured \|/);
    expect(text).toMatch(/provisional, capped at B/);
    expect(text).toMatch(/lower bound/);
    expect(text).not.toMatch(/MCP server `github` \| ~?0 /);
    expect(text).toMatch(/estimates/);
    expect(text).toMatch(/prehello \d+\.\d+\.\d+/);
  });
  it("an empty machine is 'nothing found', never a score of 0", () => {
    const { text } = md("empty-machine");
    expect(text).toMatch(/not a score of 0|nothing measurable|No coding agent was detected/i);
    expect(text).not.toMatch(/\b0 tokens\b/);
  });
  it("percentages under 0.1% never read 'at least < 0.1%'", () => {
    const { text } = md("mcp-catalog");
    expect(text).not.toMatch(/(at least|about) </);
    expect(text).toMatch(/under 0\.1% so far/);
  });
});

describe("markdown privacy", () => {
  for (const [label, o] of [["plain", {}], ["anonymized", { anonymize: true }], ["compact", { compact: true }], ["total", { headline: "total" as const }]] as const)
    it(`canary fixture, ${label}: no contents, secrets, env values, paths or home`, () => {
      const { m, text } = md("privacy-canary", o);
      for (const c of CANARIES) expect(text).not.toContain(c);
      for (const s of [m.home, m.root, os.tmpdir(), "/home/", "/Users/", "CLAUDE.md:"]) expect(text, s).not.toContain(s);
      expect(text).not.toMatch(/[A-Za-z]:\\/);
      if (o && "anonymize" in o) for (const n of NAMES) expect(text).not.toContain(n);
    });
  it("anonymised output has no real names anywhere (plugin-heavy)", () => {
    const { text } = md("plugin-heavy", { anonymize: true });
    expect(text).not.toMatch(/analytics-kit|design-kit|cloud-kit/);
    expect(text).toContain("plugin 1");
  });
  it("findings and warnings text never appears (it names files)", () => {
    const { r, text } = md("privacy-canary");
    expect(r.findings.length).toBeGreaterThan(0);
    for (const f of r.findings) expect(text).not.toContain(f.message);
  });
  it("the output is plain ASCII even though the terminal report uses glyphs", () => {
    for (const fx of ["realistic", "plugin-heavy", "crlf-unicode"]) expect(md(fx).text, fx).toMatch(/^[\x20-\x7e\n]*$/);
  });
});

describe("markdown escaping", () => {
  it("mdCode: pipes, backticks, links, HTML, mentions, control and bidi characters are inert", () => {
    expect(mdCode("a|b", true)).toBe("`a\\|b`");
    expect(mdCode("a|b")).toBe("`a|b`");
    expect(mdCode("x`y")).toBe("``x`y``");
    expect(mdCode("`edge`")).toBe("`` `edge` ``");
    expect(mdCode("a``b`c")).toBe("```a``b`c```");
    expect(mdCode("](http://evil)")).toBe("`](http://evil)`");
    expect(mdCode("<img src=x onerror=alert(1)>")).toBe("`<img src=x onerror=alert(1)>`");
    expect(mdCode("evil\u001b[31m\u202Ename\u200b")).not.toMatch(/[\u001b\u202e\u200b]/);
    expect(mdCode("")).toBe("`(unnamed)`");
    expect(mdCode("a\nb\r\nc")).toBe("`a b c`");
    expect(mdCode("x".repeat(500)).length).toBeLessThan(70);
  });
  it("mdCode never lets a secret through", () => {
    expect(mdCode("sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef")).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
  });
  it("end to end: hostile MCP server names appear only inside code spans and cannot break the table", () => {
    const m = materialize("empty-machine");
    const hostile = ["a|b|c", "x`y``z", "](http://evil.example)", "<img src=x onerror=alert(1)>", "@everyone #123", "[click](javascript:alert(1))", "evil\u202Ename", "</td><td>"];
    const servers: Record<string, unknown> = {};
    for (const h of hostile) servers[h] = { command: "node" };
    fs.writeFileSync(path.join(m.project, ".mcp.json"), JSON.stringify({ mcpServers: servers }));
    fs.writeFileSync(path.join(m.project, "CLAUDE.md"), "# project\nhello\n");
    const r = runScan(m, { agents: ["claude-code"] });
    for (const o of [BASE, { ...BASE, compact: true }]) {
      const text = renderMarkdown(r, o);
      // remove every code span (our fences are balanced); nothing hostile may remain outside
      const outside = text.replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, "");
      for (const bad of ["evil.example", "onerror", "javascript:", "@everyone", "#123", "</td>", "\u202e"]) expect(outside, bad).not.toContain(bad);
      // every table row has the same number of unescaped column separators
      const rows = text.split("\n").filter((l) => l.startsWith("|"));
      const cols = (l: string) => l.replace(/\\\|/g, "").replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, (s) => s.replace(/\|/g, "")).split("|").length;
      for (const row of rows) expect(cols(row), row).toBe(cols(rows[0]));
    }
  });
});

describe("markdown CLI", () => {
  const args = (m: Mat, extra: string[]) => [m.project, "--ceiling", m.root, "--managed-dir", path.join(m.root, "none"), "--no-bundled-catalog", ...extra];

  it("--markdown goes to stdout, replaces the terminal report, and touches nothing", () => {
    const m = materialize("plugin-heavy");
    const res = runCli(args(m, ["--markdown"]), { home: m.home, cwd: m.project });
    expect(res.status).toBe(0);
    expect(res.guardLog).toBe("");
    expect(res.stdout.startsWith("## prehello report")).toBe(true);
    expect(res.stdout).not.toMatch(/ALWAYS ON/);
    expect(res.stdout).not.toContain("<!-- prehello");
    expect(res.stdout).not.toContain(m.root);
  });
  it("--markdown-compact implies --markdown", () => {
    const m = materialize("plugin-heavy");
    const res = runCli(args(m, ["--markdown-compact"]), { home: m.home, cwd: m.project });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/^- \*\*Cursor\*\*/m);
    expect(res.stdout).not.toMatch(/^\|/m);
  });
  it("--redact and --card-anonymize hide plugin / MCP names", () => {
    const m = materialize("plugin-heavy");
    for (const flag of ["--redact", "--card-anonymize", "--anonymize"]) {
      const res = runCli(args(m, ["--markdown", flag]), { home: m.home, cwd: m.project });
      expect(res.status, flag).toBe(0);
      expect(res.stdout, flag).not.toMatch(/analytics-kit|design-kit|cloud-kit/);
    }
    const c = materialize("privacy-canary");
    const res = runCli(args(c, ["--markdown", "--redact"]), { home: c.home, cwd: c.project });
    for (const s of [...CANARIES, ...NAMES]) expect(res.stdout + res.stderr).not.toContain(s);
  });
  it("--agent and --window are respected", () => {
    const m = materialize("realistic");
    const a = runCli(args(m, ["--markdown", "--agent", "codex", "--window", "100k"]), { home: m.home, cwd: m.project });
    expect(a.status).toBe(0);
    expect(a.stdout).toContain("### Codex");
    expect(a.stdout).not.toContain("### Claude Code");
    expect(a.stdout).toContain("100k");
  });
  it("--max-tokens keeps its exit code with --markdown; the markdown is still printed", () => {
    const m = materialize("plugin-heavy");
    const res = runCli(args(m, ["--markdown", "--max-tokens", "100"]), { home: m.home, cwd: m.project });
    expect(res.status).toBe(2);
    expect(res.stdout.startsWith("## prehello report")).toBe(true);
    expect(res.stderr).toMatch(/--max-tokens/);
    expect(runCli(args(m, ["--markdown", "--max-tokens", "1m"]), { home: m.home, cwd: m.project }).status).toBe(0);
  });
  it("conflicts: --json and --fix cannot share stdout with --markdown; bad file extension is refused", () => {
    const m = materialize("plugin-heavy");
    expect(runCli(args(m, ["--markdown", "--json"]), { home: m.home, cwd: m.project }).status).toBe(1);
    expect(runCli(args(m, ["--markdown", "--fix"]), { home: m.home, cwd: m.project }).status).toBe(1);
    const bad = runCli(args(m, ["--markdown=report.txt"]), { home: m.home, cwd: m.project });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/\.md or \.markdown/);
  });
  it("--json=<file> --markdown (stdout) work together: stdout is only markdown", () => {
    const m = materialize("plugin-heavy");
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "prehello-mdj-"));
    const jf = path.join(out, "j.json");
    const res = runCli(args(m, ["--markdown", `--json=${jf}`]), { home: m.home, cwd: m.project, allowWrite: [jf] });
    expect(res.status).toBe(0);
    expect(res.stdout.startsWith("## prehello report")).toBe(true);
    expect(JSON.parse(fs.readFileSync(jf, "utf8")).schemaVersion).toBe(1);
    fs.rmSync(out, { recursive: true, force: true });
  });
  it("--json stdout purity is untouched by the markdown feature", () => {
    const m = materialize("plugin-heavy");
    const res = runCli(args(m, ["--json"]), { home: m.home, cwd: m.project });
    expect(res.status).toBe(0);
    expect(() => JSON.parse(res.stdout)).not.toThrow();
  });
  it("--markdown=<file>: the terminal report still prints, the file has the marker and the same body", () => {
    const m = materialize("plugin-heavy");
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "prehello-mdf-"));
    const f = path.join(out, "report.md");
    const res = runCli(args(m, [`--markdown=${f}`]), { home: m.home, cwd: m.project, allowWrite: [f] });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/ALWAYS ON/);
    const body = fs.readFileSync(f, "utf8");
    expect(body.startsWith("<!-- generated by prehello ")).toBe(true);
    expect(body).toContain("## prehello report");
    expect(res.stdout).toContain("Markdown report written");
    expect(res.stdout).toContain("add --card-anonymize");
    // re-running replaces our own file; a foreign file is refused without --force
    expect(runCli(args(m, [`--markdown=${f}`]), { home: m.home, cwd: m.project, allowWrite: [f] }).status).toBe(0);
    const foreign = path.join(out, "mine.md");
    fs.writeFileSync(foreign, "# my notes\n");
    const refused = runCli(args(m, [`--markdown=${foreign}`]), { home: m.home, cwd: m.project, allowWrite: [foreign] });
    expect(refused.status).toBe(1);
    expect(fs.readFileSync(foreign, "utf8")).toBe("# my notes\n");
    expect(runCli(args(m, [`--markdown=${foreign}`, "--force"]), { home: m.home, cwd: m.project, allowWrite: [foreign] }).status).toBe(0);
    expect(fs.readFileSync(foreign, "utf8")).toContain("## prehello report");
    fs.rmSync(out, { recursive: true, force: true });
  });
  it("--markdown=<file> never follows a symlink and never overwrites a scanned context file", () => {
    const m = materialize("plugin-heavy");
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "prehello-mds-"));
    const victim = path.join(out, "victim.md");
    fs.writeFileSync(victim, "precious\n");
    const link = path.join(out, "link.md");
    try {
      fs.symlinkSync(victim, link);
    } catch {
      fs.rmSync(out, { recursive: true, force: true });
      return; // symlinks need privileges on Windows
    }
    const res = runCli(args(m, [`--markdown=${link}`, "--force"]), { home: m.home, cwd: m.project, allowWrite: [link] });
    expect(res.status).toBe(1);
    expect(fs.readFileSync(victim, "utf8")).toBe("precious\n");
    const agents = path.join(m.project, "AGENTS.md");
    const before = fs.readFileSync(agents, "utf8");
    const res2 = runCli(args(m, [`--markdown=${agents}`, "--force"]), { home: m.home, cwd: m.project, allowWrite: [agents] });
    expect(res2.status).toBe(1);
    expect(fs.readFileSync(agents, "utf8")).toBe(before);
    fs.rmSync(out, { recursive: true, force: true });
  });
  it("without a permitted write the guard sees nothing: --markdown to stdout writes no file", () => {
    const m = materialize("realistic");
    const res = runCli(args(m, ["--markdown"]), { home: m.home, cwd: m.project });
    expect(res.guardLog).toBe("");
  });
});

describe("markdown: an all-unmeasured setup", () => {
  it("says the cost is unmeasured, never 0, with a sane sentence", () => {
    const m = materialize("empty-machine");
    fs.writeFileSync(path.join(m.project, ".mcp.json"), JSON.stringify({ mcpServers: { alpha: { command: "x" }, beta: { command: "y" } } }));
    const r = runScan(m, { agents: ["claude-code"] });
    const text = renderMarkdown(r, BASE);
    expect(text).toMatch(/\*\*2 MCP servers load before hello\*\*/);
    expect(text).toMatch(/\nClaude Code, token cost unmeasured \(not zero\)\.\n/);
    expect(text).toMatch(/could not be measured: token cost unknown \(not zero\)/);
    expect(text).not.toMatch(/~0\b/);
    const anon = renderMarkdown(r, { ...BASE, anonymize: true });
    expect(anon).not.toMatch(/alpha|beta/);
    checkGolden("markdown-all-unmeasured.md", text);
  });
});
