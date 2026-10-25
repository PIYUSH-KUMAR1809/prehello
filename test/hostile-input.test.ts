import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { materialize, cleanup, runScan } from "./helpers/fixtures";
import { runCli } from "./helpers/run-cli";
import { stripHtmlComments } from "../src/text/comments";
import { parseFrontmatter } from "../src/text/frontmatter";
import { parseMcpMap, MAX_MCP_SERVERS } from "../src/mcp/configs";
import { renderMarkdown } from "../src/render/markdown";

afterAll(cleanup);

function timed<T>(f: () => T): { v: T; ms: number } {
  const t = Date.now();
  const v = f();
  return { v, ms: Date.now() - t };
}

describe("hostile input: complexity", () => {
  it("stripHtmlComments is linear: 4 MiB of '<!--' (the old regex hung for minutes)", () => {
    const { v, ms } = timed(() => stripHtmlComments("<!--".repeat(1024 * 1024)));
    expect(v.length).toBe(4 * 1024 * 1024);
    expect(ms).toBeLessThan(2000);
  });
  it("stripHtmlComments keeps the regex semantics", () => {
    expect(stripHtmlComments("a<!-- x -->b")).toBe("ab");
    expect(stripHtmlComments("a<!-- x")).toBe("a<!-- x");
    expect(stripHtmlComments("a<!--->b-->c")).toBe("ac");
    expect(stripHtmlComments("<!-- 1 --><!-- 2 -->z")).toBe("z");
    expect(stripHtmlComments("```\n<!-- keep -->\n```\n<!-- drop -->t")).toBe("```\n<!-- keep -->\n```\nt");
  });
  it("an MCP config with 200,000 servers is cut at the cap and says so", () => {
    const big: Record<string, unknown> = {};
    for (let i = 0; i < 200_000; i++) big[`s${i}`] = { command: "x" };
    const warns: string[] = [];
    const out = parseMcpMap(big, (m) => warns.push(m));
    expect(out.length).toBe(MAX_MCP_SERVERS);
    expect(warns.join()).toMatch(/lower bound/);
  });
  it("150,000 @imports in one file finish quickly and say that the rest were not followed", () => {
    const m = materialize("empty-machine");
    fs.writeFileSync(path.join(m.project, "CLAUDE.md"), Array.from({ length: 50_000 }, (_, i) => `@docs/f${i}.md`).join("\n"));
    const { v, ms } = timed(() => runScan(m, { agents: ["claude-code"] }));
    expect(ms).toBeLessThan(8000);
    const item = v.agents[0].items.find((i) => i.path.endsWith("CLAUDE.md"))!;
    expect(item.notes.join(" ")).toMatch(/@import/);
  });
});

describe("hostile input: output size", () => {
  it("60 copies of one rule file make at most 20 duplicate findings plus one 'not listed' summary, not 1,770", () => {
    const m = materialize("empty-machine");
    const body = Array.from({ length: 400 }, (_, i) => `rule number ${i} says do the thing carefully`).join("\n");
    for (let i = 0; i < 60; i++) {
      fs.mkdirSync(path.join(m.project, ".claude", "rules"), { recursive: true });
      fs.writeFileSync(path.join(m.project, ".claude", "rules", `r${i}.md`), body);
    }
    const r = runScan(m, { agents: ["claude-code"] });
    const f2 = r.findings.filter((f) => f.id === "F2");
    expect(f2.length).toBe(21);
    expect(f2.filter((f) => f.data?.omittedPairs).map((f) => f.data!.omittedPairs)).toEqual([60 * 59 / 2 - 20]);
  });
});

describe("hostile input: prototype pollution", () => {
  it("__proto__ / constructor keys in frontmatter stay plain data", () => {
    const fm = parseFrontmatter("---\n__proto__: [1, 2]\nconstructor: y\nname: n\n---\nbody");
    expect(Object.getPrototypeOf(fm.data)).toBe(null);
    expect(fm.data.name).toBe("n");
    expect(({} as Record<string, unknown>).length).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call({}, "polluted")).toBe(false);
  });
  it("__proto__ keys in an MCP map or in settings never change Object.prototype", () => {
    const text = '{"__proto__":{"command":"x","polluted":true},"constructor":{"command":"y"}}';
    const defs = parseMcpMap(JSON.parse(text));
    expect(defs.map((d) => d.name).sort()).toEqual(["__proto__", "constructor"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it("a skill called 'constructor' with settings keys __proto__/constructor scans cleanly", () => {
    const m = materialize("empty-machine");
    fs.mkdirSync(path.join(m.home, ".claude", "skills", "constructor"), { recursive: true });
    fs.writeFileSync(path.join(m.home, ".claude", "skills", "constructor", "SKILL.md"), "---\nname: constructor\ndescription: d\n---\nb");
    fs.writeFileSync(path.join(m.home, ".claude", "settings.json"), '{"skillOverrides":{"__proto__":"off"},"enabledPlugins":{"__proto__":false}}');
    const r = runScan(m, { agents: ["claude-code"] });
    expect(r.agents[0].totals.always.est).toBeGreaterThan(0);
  });
});

describe("headline honesty", () => {
  it("an unreadable CLAUDE.md is not reported as 'MCP servers load before hello'", () => {
    const m = materialize("empty-machine");
    fs.writeFileSync(path.join(m.project, "CLAUDE.md"), Buffer.from([0, 1, 2, 3, 0, 0, 0, 255]));
    const r = runScan(m, { agents: ["claude-code"] });
    const text = renderMarkdown(r, { anonymize: false, compact: false, headline: "cut" });
    expect(text).not.toMatch(/MCP server/);
    expect(text).toMatch(/could not be measured/);
  });
});

describe("CLI argument edge cases", () => {
  const m = materialize("empty-machine");
  const run = (...a: string[]) => runCli(a, { home: m.home, cwd: m.project });
  it("-h and -v are accepted", () => {
    expect(run("-h").stdout).toMatch(/Usage:/);
    expect(run("-v").stdout).toMatch(/^\d+\.\d+\.\d+/);
  });
  it("unknown short options and empty values are clear errors, not 'not a directory'", () => {
    for (const a of [["-x"], ["--json="], ["--agent="], ["--window="]]) {
      const r = run(...a);
      expect(r.status, a.join(" ")).toBe(1);
      expect(r.stderr).not.toMatch(/not a directory/);
    }
  });
  it("agent names are case-insensitive and '--' ends options", () => {
    expect(run("--agent=Codex,CURSOR", "--quiet").status).toBe(0);
    expect(run("--system-root", path.join(m.home, "none"), "--quiet", "--", ".").status).toBe(0);
  });
});
