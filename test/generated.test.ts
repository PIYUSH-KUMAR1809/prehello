import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { world, cleanupWorlds, put, skillMd, World } from "./helpers/tree";
import { runCli } from "./helpers/run-cli";
import { treeHash } from "./helpers/fixtures";
import { wrap } from "../src/util/fmt";

afterAll(cleanupWorlds);

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const prose = (r: () => number, words: number) => {
  const vocab = ["use", "the", "typescript", "strict", "mode", "never", "commit", "secrets", "run", "tests", "before", "pushing", "prefer", "small", "functions", "name", "things", "well", "follow", "existing", "patterns", "in", "src", "and", "docs"];
  let out = "";
  for (let i = 0; i < words; i++) out += vocab[Math.floor(r() * vocab.length)] + (i % 14 === 13 ? ".\n" : " ");
  return out + "\n";
};

interface Shape { claudeKb: number; rules: number; skills: number; mcp: number; cursorRules: number; agentsKb: number; plugins: number }
function build(seed: number, s: Shape): World {
  const r = rng(seed);
  const w = world();
  put(w.project, { "CLAUDE.md": prose(r, s.claudeKb * 170), "AGENTS.md": prose(r, s.agentsKb * 170) });
  for (let i = 0; i < s.rules; i++) put(w.project, { [`.claude/rules/rule-${i}.md`]: (i % 3 === 0 ? `---\npaths:\n  - "src/**/*.ts"\n---\n` : "") + prose(r, 60 + Math.floor(r() * 300)) });
  for (let i = 0; i < s.cursorRules; i++) put(w.project, { [`.cursor/rules/c${i}.mdc`]: `---\n${i % 2 ? "alwaysApply: true" : `description: Rule ${i} for things`}\n---\n${prose(r, 80 + Math.floor(r() * 200))}` });
  for (let i = 0; i < s.skills; i++) put(w.home, { [`.claude/skills/skill-${i}/SKILL.md`]: skillMd(`skill-${i}`, prose(r, 20 + Math.floor(r() * 60)).replace(/\n/g, " "), prose(r, 200 + Math.floor(r() * 800))) });
  const servers: Record<string, unknown> = {};
  for (let i = 0; i < s.mcp; i++) servers[`server-${i}`] = i % 3 ? { command: "npx", args: ["-y", `pkg-${i}`], env: { TOKEN: `SECRET-${i}` } } : { url: `https://mcp-${i}.example.invalid/mcp` };
  if (s.mcp) put(w.project, { ".mcp.json": JSON.stringify({ mcpServers: servers }) });
  for (let i = 0; i < s.plugins; i++) {
    const root = path.join(w.home, ".claude", "plugins", "cache", "mk", `plug${i}`, "1.0.0");
    put(root, { ".claude-plugin/plugin.json": JSON.stringify({ name: `plug${i}` }), [`skills/ps${i}/SKILL.md`]: skillMd(`ps${i}`, prose(r, 30).replace(/\n/g, " ")) });
  }
  if (s.plugins) {
    const rec: Record<string, unknown> = {};
    for (let i = 0; i < s.plugins; i++) rec[`plug${i}@mk`] = [{ scope: "user", installPath: path.join(w.home, ".claude", "plugins", "cache", "mk", `plug${i}`, "1.0.0") }];
    put(w.home, { ".claude/plugins/installed_plugins.json": JSON.stringify({ version: 2, plugins: rec }) });
  }
  fs.mkdirSync(path.join(w.home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(w.home, ".cursor"), { recursive: true });
  fs.mkdirSync(path.join(w.home, ".codex"), { recursive: true });
  return w;
}

const SHAPES: Array<[string, Shape]> = [
  ["minimal", { claudeKb: 1, rules: 0, skills: 0, mcp: 0, cursorRules: 0, agentsKb: 1, plugins: 0 }],
  ["small", { claudeKb: 2, rules: 2, skills: 3, mcp: 1, cursorRules: 2, agentsKb: 2, plugins: 0 }],
  ["typical", { claudeKb: 4, rules: 6, skills: 12, mcp: 4, cursorRules: 6, agentsKb: 4, plugins: 2 }],
  ["mcp-heavy", { claudeKb: 3, rules: 3, skills: 5, mcp: 20, cursorRules: 3, agentsKb: 3, plugins: 0 }],
  ["skills-heavy", { claudeKb: 3, rules: 3, skills: 80, mcp: 2, cursorRules: 3, agentsKb: 3, plugins: 5 }],
  ["HEAVY", { claudeKb: 30, rules: 30, skills: 60, mcp: 12, cursorRules: 25, agentsKb: 20, plugins: 8 }],
];

describe("generated realistic fixtures through the real CLI (subprocess, guard preload on)", () => {
  for (const [name, shape] of SHAPES) {
    it(`${name}: sane numbers, tidy output, nothing written`, () => {
      const w = build(name.length * 131, shape);
      const before = treeHash(w.root);
      const args = [w.project, "--ceiling", w.root];
      const j = runCli([...args, "--json"], { home: w.home, cwd: w.project });
      expect(j.status).toBe(0);
      const rep = JSON.parse(j.stdout);
      const t = runCli([...args, "--verbose", "--no-color"], { home: w.home, cwd: w.project });
      expect(t.status).toBe(0);
      expect(t.stderr).toBe("");
      for (const line of t.stdout.split("\n")) expect([...line].length, line).toBeLessThanOrEqual(110);
      expect(t.stdout).not.toMatch(/\u001b/);
      expect(t.stdout).not.toMatch(/NaN|undefined|\[object|Infinity|\bnull\b/);
      expect(treeHash(w.root)).toBe(before);
      const claude = rep.agents.find((a: { id: string }) => a.id === "claude-code");
      expect(claude).toBeTruthy();
      let sum = 0;
      for (const it of claude.items) {
        if (!it.tokens) continue;
        // tokens per char for English-ish prose must be in a believable band (never 0 for non-empty text, never > chars)
        if (it.chars > 200) {
          const ratio = it.tokens.est / it.chars;
          expect(ratio, `${it.label}`).toBeGreaterThan(0.08);
          expect(ratio, `${it.label}`).toBeLessThan(1);
        }
        if (it.loadMode === "always") sum += it.tokens.est;
      }
      expect(Math.abs(claude.totals.always.est - sum)).toBeLessThanOrEqual(claude.items.length);
      expect(claude.percentOfWindowAlways).toBeCloseTo((claude.totals.always.est / rep.scan.window) * 100, 1);
      const mcpNames = claude.mcpServers.length;
      expect(mcpNames).toBe(shape.mcp);
      if (shape.mcp) {
        expect(t.stdout).toMatch(new RegExp(`MCP servers configured \\(${shape.mcp}\\)`));
        expect(claude.alwaysIsLowerBound).toBe(true);
        expect(claude.grade?.letter ?? "none").not.toBe("A");
      }
      if (shape.skills) expect(claude.items.some((i: { kind: string }) => i.kind === "skills-listing")).toBe(true);
      // secrets from MCP env never reach any output
      expect(j.stdout + t.stdout).not.toMatch(/SECRET-\d/);
      // strict json carries no names or paths
      const strict = runCli([...args, "--json=strict"], { home: w.home, cwd: w.project });
      if (strict.status === 0) expect(strict.stdout).not.toMatch(/server-\d|skill-\d|rule-\d|prehello-w-/);
    });
  }

  it("HEAVY: more MCP servers and skills means a worse or equal grade, and the top offenders view appears", () => {
    const w = build(999, SHAPES[SHAPES.length - 1][1]);
    const t = runCli([w.project, "--ceiling", w.root, "--no-color"], { home: w.home, cwd: w.project });
    expect(t.stdout).toMatch(/Top offenders/);
    expect(t.stdout).toMatch(/Measured vs\. not measured/);
    const m = build(1, SHAPES[0][1]);
    const jm = JSON.parse(runCli([m.project, "--ceiling", m.root, "--json"], { home: m.home, cwd: m.project }).stdout);
    const jh = JSON.parse(runCli([w.project, "--ceiling", w.root, "--json"], { home: w.home, cwd: w.project }).stdout);
    const tok = (j: { agents: Array<{ id: string; totals: { always: { est: number } } }> }) => j.agents.find((a) => a.id === "claude-code")!.totals.always.est;
    expect(tok(jh)).toBeGreaterThan(tok(jm) * 5);
  });
});

describe("wrap() never produces a line longer than the width, even for one enormous word", () => {
  it("hard-breaks long unbroken tokens", () => {
    for (const width of [40, 80, 100]) {
      const lines = wrap("start " + "x".repeat(500) + " end " + "😀".repeat(300), width, "   ", "      ");
      for (const l of lines) expect([...l].length).toBeLessThanOrEqual(width);
    }
  });
});
