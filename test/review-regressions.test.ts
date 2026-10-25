import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { runCli } from "./helpers/run-cli";
import { fmtTok, sanitize } from "../src/util/fmt";
import { mkTmp } from "./helpers/tmp";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function tree(files: Record<string, string>) {
  const base = mkTmp("prehello-rv-");
  dirs.push(base);
  const home = path.join(base, "home");
  const project = path.join(base, "project");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(project, ".git"));
  for (const [rel, text] of Object.entries(files)) {
    const f = path.join(base, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  return { base, home, project };
}

const KEY = "sk-ant-api03-REVIEWCANARY0123456789ABCDEFGH";

describe("review regression: secret-shaped NAMES must never be displayed", () => {
  it("scrubs before truncating (a cut-off key must not leak its prefix)", () => {
    expect(sanitize("x".repeat(100) + KEY, 120)).not.toMatch(/sk-ant|REVIEWCANARY/);
    expect(sanitize(KEY)).not.toContain("REVIEWCANARY");
  });
  it("skill `name:` and MCP server keys do not reach terminal, --json or --fix output", () => {
    const t = tree({
      "project/CLAUDE.md": "# hi\n",
      [`home/.claude/skills/s/SKILL.md`]: `---\nname: leak-${KEY}\ndescription: d\n---\nbody\n`,
      "home/.claude.json": JSON.stringify({ mcpServers: { [`srv-${KEY}`]: { command: "npx", args: ["x"] } } }),
    });
    for (const args of [["--verbose"], ["--json"], ["--fix"], ["--verbose", "--agent", "claude-code,cursor,codex"]]) {
      const r = runCli(args, { home: t.home, cwd: t.project });
      expect(r.stdout + r.stderr, args.join(" ")).not.toMatch(/REVIEWCANARY|sk-ant-api03/);
    }
  });
});

describe("review regression: disable-model-invocation accepts every documented boolean spelling", () => {
  it("yes/on/1/true hide the skill from the listing; no/off/0 keep it", () => {
    const mk = (v: string) => `---\nname: s\ndescription: a test skill description long enough to count\ndisable-model-invocation: ${v}\n---\nbody\n`;
    const listed = (v: string) => {
      const t = tree({ "project/CLAUDE.md": "# x\n", "home/.claude/skills/s/SKILL.md": mk(v) });
      const r = runCli(["--json", "--agent", "claude-code"], { home: t.home, cwd: t.project });
      return /"label": "Skills listing/.test(r.stdout) || /Skills listing \(1 user/.test(r.stdout);
    };
    for (const v of ["true", "yes", "on", "1", "YES", "On"]) expect(listed(v), v).toBe(false);
    for (const v of ["false", "no", "off", "0"]) expect(listed(v), v).toBe(true);
  });
});

describe("review regression: big token numbers", () => {
  it("never prints millions as thousands", () => {
    expect(fmtTok(53_397_000)).toBe("53.4M");
    expect(fmtTok(1_000_000)).toBe("1M");
    expect(fmtTok(999_600)).toBe("1M");
    expect(fmtTok(150_000)).toBe("150k");
    expect(fmtTok(99_949)).toBe("99.9k");
  });
});

describe("review regression: .claude/AGENTS.md", () => {
  it("is loaded by Claude Code when no CLAUDE.md exists (docs: every AGENTS.md and .claude/AGENTS.md up the tree)", () => {
    const t = tree({ "project/.claude/AGENTS.md": "dot-claude agents instructions for the project\n" });
    const r = runCli(["--json", "--agent", "claude-code"], { home: t.home, cwd: t.project });
    expect(r.stdout).toContain(".claude/AGENTS.md");
    expect(r.stdout).not.toMatch(/nothing that loads up front/);
  });
  it("is ignored (with a finding) when a CLAUDE.md exists", () => {
    const t = tree({ "project/.claude/AGENTS.md": "x agents\n", "project/CLAUDE.md": "# c\n" });
    const r = runCli(["--agent", "claude-code"], { home: t.home, cwd: t.project });
    expect(r.stdout).toMatch(/ignores .*AGENTS\.md/);
  });
});
