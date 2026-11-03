import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseContext, parseNumber, ContextParseError } from "../src/calibrate";
import { runCli } from "./helpers/run-cli";
import { mkTmp } from "./helpers/tmp";

const FIX = path.join(__dirname, "fixtures", "context-output");
const read = (f: string) => fs.readFileSync(path.join(FIX, f), "utf8");

describe("parseNumber", () => {
  it("expands k/m and keeps the display rounding", () => {
    expect(parseNumber("2.8", "k")).toEqual({ value: 2800, pm: 50, raw: "2.8k" });
    expect(parseNumber("123", "k").pm).toBe(500);
    expect(parseNumber("623", "")).toEqual({ value: 623, pm: 0.5, raw: "623" });
    expect(parseNumber("1", "m").value).toBe(1_000_000);
    expect(parseNumber("1,234", "").value).toBe(1234);
  });
});

describe("parseContext on real captures", () => {
  it("grid layout with per-item rows (discussion #108)", () => {
    const r = parseContext(read("grid-2025-12.txt"));
    expect(r.model).toBe("claude-opus-4-5-20251101");
    expect(r.used?.value).toBe(32000);
    expect(r.categories.get("memory files")?.value).toBe(7300);
    expect(r.categories.get("custom agents")?.value).toBe(623);
    expect(r.categories.get("free space")?.value).toBe(123000);
    expect(r.details.get("custom agents")?.length).toBe(32);
    const mem = r.details.get("memory files")!;
    expect(mem.length).toBe(13);
    expect(mem[0].path).toBe("~/.dotfiles/claude/rules/claim-verification.md");
    // per-item rows add up to the category within its rounding
    expect(Math.abs(mem.reduce((s, x) => s + x.tokens.value, 0) - 7300)).toBeLessThan(150);
    expect(r.mcpOnDemand).toBe(false);
  });
  it("newer summary layout with on-demand MCP (wmedia.es)", () => {
    const r = parseContext(read("summary-2026.txt"));
    expect(r.model).toBe("claude-opus-5[1m]");
    expect(r.total?.value).toBe(1_000_000);
    expect(r.categories.get("skills")?.value).toBe(6200);
    expect(r.categories.get("free space")?.value).toBe(860700);
    expect(r.mcpOnDemand).toBe(true);
  });
  it("legend only (anthropics/claude-code#17567)", () => {
    const r = parseContext(read("minimal-2026-01.txt"));
    expect(r.categories.get("memory files")?.value).toBe(484);
    expect(r.ignored).toBe(0);
  });
  it("tolerates CRLF, ANSI colour and the deferred rows", () => {
    const r = parseContext("\u001b[1mclaude-sonnet-4-5 · 50k/200k tokens (25%)\u001b[0m\r\n⛁ MCP tools (deferred): 12.1k tokens (6.0%)\r\n⛁ Memory files: 1.0k tokens (0.5%)\r\n");
    expect(r.categories.get("mcp tools (deferred)")?.value).toBe(12100);
    expect(r.categories.get("memory files")?.value).toBe(1000);
  });
  it("refuses text that is not /context output", () => {
    expect(() => parseContext("hello world\nnothing here")).toThrow(ContextParseError);
  });
});

describe("prehello calibrate (CLI)", () => {
  const setup = () => {
    const home = mkTmp("prehello-cal-home-");
    const proj = mkTmp("prehello-cal-proj-");
    fs.mkdirSync(path.join(proj, ".git"));
    fs.writeFileSync(path.join(proj, "CLAUDE.md"), "# Project\n\n" + "Use pnpm. Run the tests before every commit and keep functions small.\n".repeat(40));
    fs.mkdirSync(path.join(home, ".claude"));
    fs.writeFileSync(path.join(home, ".claude", "CLAUDE.md"), "Be terse.\n");
    const ctx = path.join(home, "ctx.txt");
    fs.writeFileSync(ctx, `claude-opus-4-5 · 20k/200k tokens (10%)\n⛁ System prompt: 2.7k tokens (1.4%)\n⛁ Memory files: 900 tokens (0.5%)\n⛁ Messages: 10 tokens (0.0%)\n\nMemory files · /memory\n└ ~/.claude/CLAUDE.md: 4 tokens\n└ ${path.join(proj, "CLAUDE.md")}: 896 tokens\n`);
    return { home, proj, ctx };
  };
  it("prints a comparison table, per file and built-in rows", () => {
    const { home, proj, ctx } = setup();
    const r = runCli(["calibrate", proj, "--file", ctx], { home });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/memory files\s+900\s+\d/);
    expect(r.stdout).toMatch(/compared total/);
    expect(r.stdout).toContain("Not estimated by prehello (built into Claude Code): system prompt 2.7k");
    expect(r.stdout).toMatch(/CLAUDE\.md: \/context 896, prehello \d+/);
    expect(r.stdout).not.toContain("prehello did not find");
  });
  it("--json and --save; the saved record has no paths", () => {
    const { home, proj, ctx } = setup();
    const out = path.join(home, "cal.json");
    const r = runCli(["calibrate", proj, "--file", ctx, "--json", "--save", out], { home, allowWrite: [out] });
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.kind).toBe("calibration");
    expect(j.rows[0].category).toBe("memory files");
    expect(typeof j.rows[0].errorPct).toBe("number");
    const saved = fs.readFileSync(out, "utf8");
    expect(saved).not.toContain(home);
    expect(saved).not.toContain(proj);
    expect(saved).not.toContain("CLAUDE.md");
    // a second --save over our own file is allowed
    expect(runCli(["calibrate", proj, "--file", ctx, "--save", out], { home, allowWrite: [out] }).status).toBe(0);
  });
  it("reads standard input with -", () => {
    const { home, proj, ctx } = setup();
    const r = runCli(["calibrate", proj, "-"], { home, input: fs.readFileSync(ctx, "utf8") });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/memory files\s+900/);
  });
  it("errors clearly", () => {
    const { home, proj, ctx } = setup();
    const bad = path.join(home, "bad.txt");
    fs.writeFileSync(bad, "not context\n");
    expect(runCli(["calibrate", proj, "--file", bad], { home }).stderr).toMatch(/no \/context category rows/);
    expect(runCli(["calibrate", proj, "--file", path.join(home, "missing.txt")], { home }).stderr).toMatch(/cannot read/);
    expect(runCli(["calibrate", proj, "--file", ctx, "--agent", "cursor"], { home }).stderr).toMatch(/Claude Code's \/context/);
    expect(runCli([proj, "--file", "x.txt"], { home }).stderr).toMatch(/belong to .prehello calibrate./);
  });
});

describe("calibrate on a mismatched reading", () => {
  it("says the numbers are far apart and hides the implied ratio", () => {
    const home = mkTmp("prehello-cal-home-");
    const proj = mkTmp("prehello-cal-proj-");
    fs.mkdirSync(path.join(proj, ".git"));
    fs.writeFileSync(path.join(proj, "CLAUDE.md"), "Use pnpm.\n");
    const r = runCli(["calibrate", proj, "--file", path.join(FIX, "minimal-2026-01.txt")], { home });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/memory files\s+484/);
    expect(r.stdout).toMatch(/far apart/);
    expect(r.stdout).not.toMatch(/Implied/);
  });
});
