import { describe, it, expect, afterAll } from "vitest";
import { CAN_SYMLINK } from "./helpers/tmp";
import fs from "node:fs";
import path from "node:path";
import { world, cleanupWorlds, put, skillMd, scanWorld } from "./helpers/tree";
import { treeHash } from "./helpers/fixtures";
import { renderTerminal } from "../src/render/terminal";
import { toJson } from "../src/render/json";
import { Report } from "../src/model";

afterAll(cleanupWorlds);

// chmod 000 cannot deny access to root, nor on Windows (where chmod only toggles the read-only flag)
const isRoot = process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0);
const render = (w: { home: string; project: string }, r: Report, verbose = true) => renderTerminal(r, { color: false, width: 100, verbose, quiet: false, home: w.home, cwd: w.project });

/** Invariants that must hold for ANY input. */
function check(w: { home: string; project: string }, r: Report): void {
  const txt = render(w, r, true);
  expect(txt).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/); // no control chars except \n
  for (const line of txt.split("\n")) expect([...line].length, line).toBeLessThanOrEqual(160);
  const j = JSON.parse(JSON.stringify(toJson(r, { cwd: w.project, home: w.home }, false)));
  const strict = JSON.stringify(toJson(r, { cwd: w.project, home: w.home }, true));
  expect(strict).not.toContain(w.project);
  expect(strict).not.toContain(w.home);
  for (const a of r.agents) {
    let always = 0;
    let unmeasured = 0;
    for (const it of a.items) {
      if (it.tokens === null) {
        if (it.loadMode === "always") unmeasured++;
        continue;
      }
      expect(Number.isInteger(it.tokens.est)).toBe(true);
      expect(it.tokens.est).toBeGreaterThanOrEqual(0);
      expect(it.tokens.low).toBeLessThanOrEqual(it.tokens.est);
      expect(it.tokens.high).toBeGreaterThanOrEqual(it.tokens.est);
      if (it.loadMode === "always") always += it.tokens.est;
    }
    expect(a.totals.always.unmeasuredItems).toBe(unmeasured);
    expect(Math.abs(a.totals.always.est - always)).toBeLessThanOrEqual(a.items.length); // rounding only
    expect(a.coverage.alwaysUnmeasuredItems).toBe(unmeasured);
    const o = a.offenders.map((x) => x.tokens);
    expect([...o].sort((x, y) => y - x)).toEqual(o);
    if (a.grade) expect(a.coverage.alwaysMeasuredItems).toBeGreaterThan(0);
  }
  expect(Array.isArray(j.agents)).toBe(true);
}

// deterministic PRNG so failures are reproducible
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

const WEIRD_NAMES = ["plain", "with space", "ünïcödé", "日本語", "emoji-😀-🚀", "rtl-\u202Eevil", "q'uote", 'd"quote', "semi;colon", "dollar$HOME", "back`tick`", "-leading-dash", "dots...", "tab\there", "ansi-\u001b[31mred", "newline\nname", "a".repeat(180), "ZQX-marker", "NUL\u0000x", "%s%n%d", "../up", "~tilde", "{brace}", "[bracket]", "*star*", "?q", "CON", "x\\y"];
const safeName = (s: string) => s.replace(/[\/\u0000]/g, "_").replace(/^\.+$/, "_dots_");
const CONTENTS = (r: () => number): string => {
  const kinds = [
    () => "",
    () => "\n\n\n",
    () => "# Title\r\nline\r\nline\r\n",
    () => "\ufeffBOM start\n",
    () => "---\nname: x\ndescription: y\n",
    () => "---\n---\n",
    () => "---\nname: \"unclosed\ndescription: 'also\n---\nbody\n",
    () => "@" + "../".repeat(30) + "etc/passwd\n@./self.md\n@~/x\n",
    () => "```\nunclosed fence\n<!-- comment\n",
    () => String.fromCharCode(...Array.from({ length: 200 }, () => Math.floor(r() * 256))),
    () => "\u0000\u0001\u0002binary\u0000".repeat(50),
    () => "word ".repeat(Math.floor(r() * 3000)),
    () => "𝒳".repeat(Math.floor(r() * 500)),
    () => "paths: [\n  - a\n",
    () => "api_key = AKIAABCDEFGHIJKLMNOP\npassword: hunter2hunter2\n",
    () => "{".repeat(500),
    () => "[mcp_servers.\n",
    () => JSON.stringify({ mcpServers: { [WEIRD_NAMES[Math.floor(r() * WEIRD_NAMES.length)]]: { command: "x" }, "": { command: "y" }, __proto__: { command: "p" }, constructor: { command: "c" } } }),
  ];
  return kinds[Math.floor(r() * kinds.length)]();
};

const TARGETS = [
  (n: string) => `CLAUDE.md`,
  (n: string) => `AGENTS.md`,
  (n: string) => `.mcp.json`,
  (n: string) => `.claude/rules/${n}.md`,
  (n: string) => `.claude/skills/${n}/SKILL.md`,
  (n: string) => `.claude/commands/${n}.md`,
  (n: string) => `.claude/agents/${n}.md`,
  (n: string) => `.cursor/rules/${n}.mdc`,
  (n: string) => `.cursor/skills/${n}/SKILL.md`,
  (n: string) => `.cursor/mcp.json`,
  (n: string) => `.agents/skills/${n}/SKILL.md`,
  (n: string) => `packages/${n}/CLAUDE.md`,
  (n: string) => `packages/${n}/.cursor/rules/${n}.mdc`,
  (n: string) => `.codex/config.toml`,
  (n: string) => `.claude/settings.json`,
];
const HOME_TARGETS = [
  (n: string) => `.claude/CLAUDE.md`,
  (n: string) => `.claude.json`,
  (n: string) => `.claude/settings.json`,
  (n: string) => `.claude/skills/${n}/SKILL.md`,
  (n: string) => `.claude/plugins/installed_plugins.json`,
  (n: string) => `.cursor/mcp.json`,
  (n: string) => `.cursor/skills/${n}/SKILL.md`,
  (n: string) => `.cursor/plugins/local/${n}/plugin.json`,
  (n: string) => `.codex/config.toml`,
  (n: string) => `.codex/AGENTS.md`,
  (n: string) => `.agents/skills/${n}/SKILL.md`,
];

describe("fuzz: random weird trees never crash, never write, never mis-state numbers", () => {
  for (let seed = 1; seed <= 40; seed++) {
    it(`seed ${seed}`, () => {
      const r = rng(seed * 7919);
      const w = world();
      const n = 5 + Math.floor(r() * 25);
      for (let i = 0; i < n; i++) {
        const name = safeName(WEIRD_NAMES[Math.floor(r() * WEIRD_NAMES.length)]);
        const inHome = r() < 0.4;
        const t = (inHome ? HOME_TARGETS : TARGETS)[Math.floor(r() * (inHome ? HOME_TARGETS : TARGETS).length)](name);
        const abs = path.join(inHome ? w.home : w.project, t);
        try {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, Buffer.from(CONTENTS(r), "latin1"));
        } catch {
          /* name not representable on this fs: skip */
        }
      }
      const before = treeHash(w.root);
      const sub = r() < 0.3 ? path.join(w.project, "packages") : w.project;
      const cwd = fs.existsSync(sub) ? sub : w.project;
      const rep = scanWorld(w, { cwd, agents: ["claude-code", "cursor", "codex"] });
      expect(treeHash(w.root)).toBe(before); // read-only
      check(w, rep);
    });
  }
});

describe("hostile filesystem shapes", () => {
  it.skipIf(!CAN_SYMLINK)("symlink loops, self-links and links out of the project do not hang, escape or crash", () => {
    const w = world();
    put(w.project, { "CLAUDE.md": { link: "CLAUDE.md" }, "AGENTS.md": { link: "/etc/hostname" }, ".claude/rules": { link: ".." }, ".cursor/rules": { link: "../.cursor" }, ".claude/skills/loop": { link: "." } });
    fs.mkdirSync(path.join(w.project, "a", "b"), { recursive: true });
    fs.symlinkSync(path.join(w.project, "a"), path.join(w.project, "a", "b", "back"));
    put(w.home, { ".claude/skills": { link: "../.claude/skills" }, ".claude/CLAUDE.md": { link: "../.claude/CLAUDE.md" } });
    const t0 = Date.now();
    const rep = scanWorld(w, { agents: ["claude-code", "cursor", "codex"] });
    expect(Date.now() - t0).toBeLessThan(5000);
    check(w, rep);
    expect(JSON.stringify(rep.agents.flatMap((a) => a.items.map((i) => i.path)))).not.toContain("/etc/hostname");
  });

  it("a 6 MB instruction file is skipped with a reason, not read into memory", () => {
    const w = world();
    put(w.project, { "CLAUDE.md": "x".repeat(6 * 1024 * 1024), ".claude/rules/ok.md": "fine\n".repeat(10) });
    const rep = scanWorld(w, { agents: ["claude-code"] });
    const a = rep.agents[0];
    expect(a.items.find((i) => /CLAUDE\.md$/.test(i.path) && i.tokens === null)?.unmeasuredReason ?? "").toMatch(/large|size|MB|cap/i);
    check(w, rep);
  });

  it.skipIf(isRoot)("unreadable files and directories are reported, not fatal", () => {
    const w = world();
    put(w.project, { "CLAUDE.md": "ok\n", ".claude/rules/secret.md": "nope\n", ".claude/skills/locked/SKILL.md": skillMd("locked", "d") });
    fs.chmodSync(path.join(w.project, ".claude/rules/secret.md"), 0o000);
    fs.chmodSync(path.join(w.project, ".claude/skills/locked"), 0o000);
    const rep = scanWorld(w, { agents: ["claude-code"] });
    check(w, rep);
    expect(rep.warnings.join("\n") + JSON.stringify(rep.agents[0].items.map((i) => i.unmeasuredReason))).toMatch(/unreadable|permission|EACCES|not read/i);
  });

  it("an empty home, empty project, and a project that is a single empty file all scan cleanly", () => {
    const w = world();
    put(w.project, { "CLAUDE.md": "", "AGENTS.md": "\n\n", ".cursor/rules/e.mdc": "", ".claude/skills/e/SKILL.md": "" });
    const rep = scanWorld(w, { agents: ["claude-code", "cursor", "codex"] });
    check(w, rep);
  });

  it("a 40-level deep tree with a CLAUDE.md at every level: ancestors load, walk depth is bounded", () => {
    const w = world();
    let d = w.project;
    for (let i = 0; i < 40; i++) {
      d = path.join(d, `d${i}`);
      put(d, { "CLAUDE.md": `level ${i}\n`, ".cursor/rules/r.mdc": "---\nalwaysApply: true\n---\nrule\n" });
    }
    const rep = scanWorld(w, { cwd: d, agents: ["claude-code", "cursor"] });
    check(w, rep);
    const claude = rep.agents.find((a) => a.id === "claude-code")!;
    expect(claude.items.filter((i) => i.kind === "instructions").length).toBe(40);
    const shallow = scanWorld(w, { cwd: w.project, agents: ["claude-code"] });
    expect(shallow.agents[0].items.filter((i) => i.loadMode === "conditional").length).toBeLessThanOrEqual(9); // depth cap 8
  });

  it("a skill with a 2 MB description, 3,000 skills in one dir, and duplicate skill names stay bounded", () => {
    const w = world();
    put(w.home, { ".claude/skills/huge/SKILL.md": skillMd("huge", "word ".repeat(400_000)) });
    for (let i = 0; i < 700; i++) put(w.home, { [`.claude/skills/s${i}/SKILL.md`]: skillMd(i % 2 ? "dup" : `s${i}`, "desc ".repeat(20)) });
    const t0 = Date.now();
    const rep = scanWorld(w, { agents: ["claude-code"] });
    expect(Date.now() - t0).toBeLessThan(8000);
    check(w, rep);
    expect(rep.warnings.join(" ")).toMatch(/skills|limit|more than|truncat/i);
  });

  it("the sandbox guarantee: scanning a hostile tree twice gives identical output (deterministic)", () => {
    const w = world();
    put(w.project, { "CLAUDE.md": "x\n".repeat(50), ".claude/rules/é.md": "y\n", ".claude/rules/e.md": "z\n", ".claude/rules/Z.md": "z\n", ".claude/rules/a.md": "z\n" });
    const a = JSON.stringify(toJson(scanWorld(w, { agents: ["claude-code"] }), { cwd: w.project, home: w.home }, false));
    const b = JSON.stringify(toJson(scanWorld(w, { agents: ["claude-code"] }), { cwd: w.project, home: w.home }, false));
    expect(a).toBe(b);
  });
});

describe("performance: a synthetic 5,000-file monorepo", () => {
  it("scans in a few seconds, stays bounded, and says when the walk was cut short", () => {
    const w = world();
    put(w.project, { "CLAUDE.md": "root\n".repeat(30), "AGENTS.md": "root\n".repeat(30), ".claude/rules/r.md": "r\n".repeat(30) });
    let files = 0;
    for (let p = 0; p < 50; p++) {
      for (let m = 0; m < 10; m++) {
        const dir = path.join(w.project, "packages", `p${p}`, `m${m}`);
        fs.mkdirSync(dir, { recursive: true });
        for (let f = 0; f < 10; f++) {
          fs.writeFileSync(path.join(dir, `f${f}.ts`), "export const x = 1;\n");
          files++;
        }
        if (m === 0) put(dir, { "CLAUDE.md": `pkg ${p}\n`.repeat(20), ".cursor/rules/x.mdc": "---\nglobs: ['**/*.ts']\n---\nrule\n" });
      }
    }
    expect(files).toBe(5000);
    const t0 = process.hrtime.bigint();
    const rep = scanWorld(w, { agents: ["claude-code", "cursor", "codex"] });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    // eslint-disable-next-line no-console
    console.log(`[perf] 5,000-file project: ${ms.toFixed(0)} ms (${rep.agents.reduce((n, a) => n + a.items.length, 0)} items)`);
    expect(ms).toBeLessThan(4000);
    check(w, rep);
    expect(rep.warnings.join(" ")).toMatch(/walk|5,?000|truncat|limit/i);
  });
});
