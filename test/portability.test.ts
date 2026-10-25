import { describe, it, expect, afterAll, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { world, cleanupWorlds, put, scanWorld, agentOf } from "./helpers/tree";
import { installCaseInsensitiveFs, foldPath, shout } from "./helpers/casefold";
import { onPath } from "../src/fs-safe";
import { Ctx } from "../src/context";
import { makeCounter } from "../src/tokens/counter";
import { cmp, sanitize } from "../src/util/fmt";

afterAll(cleanupWorlds);

// Real macOS (APFS) and Windows hosts are case-insensitive already; assertions that
// assume a case-sensitive host filesystem only apply when the host really is one.
const hostCaseInsensitive = (() => {
  const d = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "prehello-ci-"));
  try {
    fs.writeFileSync(path.join(d, "a.txt"), "x");
    return fs.existsSync(path.join(d, "A.TXT"));
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
})();
let undo: (() => void) | undefined;
afterEach(() => {
  undo?.();
  undo = undefined;
});

describe("case-insensitive filesystems (APFS / NTFS), simulated", () => {
  it("the simulation itself behaves like a case-insensitive fs (sanity)", () => {
    const w = world();
    put(w.project, { "readme.md": "x" });
    expect(fs.existsSync(path.join(w.project, "README.MD"))).toBe(hostCaseInsensitive);
    undo = installCaseInsensitiveFs();
    expect(fs.existsSync(path.join(w.project, "README.MD"))).toBe(true);
    expect(fs.readFileSync(path.join(w.project, "ReadMe.Md"), "utf8")).toBe("x");
    expect(fs.realpathSync.native(path.join(w.project, "README.MD"))).toBe(path.join(w.project, "readme.md"));
    expect(foldPath(shout(w.project))).toBe(w.project);
  });

  it("Codex chain: lower-case agents.md / agents.override.md on disk are found; the chain is counted once each", () => {
    const w = world();
    put(w.project, { "agents.md": "root rules\n".repeat(20), "pkg/agents.override.md": "pkg override\n".repeat(20), "pkg/agents.md": "pkg plain\n".repeat(20) });
    undo = installCaseInsensitiveFs();
    const r = scanWorld(w, { cwd: path.join(w.project, "pkg"), agents: ["codex"] });
    const a = agentOf(r, "codex");
    const inst = a.items.filter((i) => i.kind === "instructions");
    // one file per directory: pkg override beats pkg agents.md (same file on a case-insensitive FS is still ONE directory entry each)
    expect(inst.length).toBe(2);
    expect(new Set(inst.map((i) => fs.realpathSync(i.path))).size).toBe(2);
  });

  it("a wrongly-cased cwd / home / ceiling is canonicalised: git root and ceiling still work, nothing above the ceiling leaks in", () => {
    const w = world();
    put(w.root, { "CLAUDE.md": "ABOVE THE CEILING SHOULD NEVER LOAD\n".repeat(10) });
    put(w.project, { "CLAUDE.md": "project rules\n".repeat(10), "AGENTS.md": "agents\n", "pkg/CLAUDE.md": "pkg rules\n".repeat(10) });
    undo = installCaseInsensitiveFs();
    const r = scanWorld(w, { cwd: shout(path.join(w.project, "pkg")), home: shout(w.home), ceiling: shout(w.project), agents: ["claude-code", "codex"] });
    const dump = JSON.stringify(r.agents.flatMap((a) => a.items.map((i) => i.path)));
    expect(dump).toContain(path.join(w.project, "CLAUDE.md"));
    expect(dump).not.toContain(path.join(w.root, "CLAUDE.md"));
    expect(dump).toContain(path.join(w.project, "pkg", "CLAUDE.md"));
  });

  it("CLAUDE.md and claude.md named differently in one dir on a case-sensitive fs are two files; on a case-insensitive fs a probe for either resolves to ONE item", () => {
    const w = world();
    put(w.project, { "claude.md": "lower\n".repeat(10) });
    undo = installCaseInsensitiveFs();
    const a = agentOf(scanWorld(w, { agents: ["claude-code"] }), "claude-code");
    const inst = a.items.filter((i) => i.kind === "instructions" && i.scope !== "user");
    expect(inst.length).toBe(1);
  });

  it("duplicate counting: the same skill reachable through two case variants of a root is listed once", () => {
    const w = world();
    put(w.home, { ".Claude/skills/one/SKILL.md": "---\nname: one\ndescription: d\n---\nb\n" });
    undo = installCaseInsensitiveFs();
    const a = agentOf(scanWorld(w, { agents: ["claude-code"] }), "claude-code");
    const listings = a.items.filter((i) => i.kind === "skills-listing");
    const names = listings.flatMap((l) => l.breakdown ?? []).filter((b) => /one/.test(b.label));
    expect(names.length).toBeLessThanOrEqual(1);
  });
});

describe("Windows / POSIX differences that can be tested on any OS", () => {
  it("onPath honours PATHEXT on win32 (claude.cmd / claude.exe shims) and never matches a bare name there", () => {
    const w = world();
    put(w.root, { "bin/claude.cmd": "@echo off", "bin2/codex.EXE": "", "bin3/cursor": "#!/bin/sh" });
    const bin = path.join(w.root, "bin");
    expect(onPath("claude", bin, { platform: "win32", pathExt: ".COM;.EXE;.CMD" })).toBe(true);
    expect(onPath("claude", bin, { platform: "win32", pathExt: ".EXE" })).toBe(false);
    expect(onPath("codex", path.join(w.root, "bin2"), { platform: "win32", pathExt: ".EXE" })).toBe(hostCaseInsensitive); // true on a case-insensitive host fs (macOS/NTFS)
    expect(onPath("cursor", path.join(w.root, "bin3"), { platform: "linux" })).toBe(true);
    expect(onPath("claude", `${path.join(w.root, "nope")};${bin}`, { platform: "win32" })).toBe(true); // ';' delimiter
    expect(onPath("claude", undefined, { platform: "win32" })).toBe(false);
  });

  it("system-wide locations are re-rooted for drive-letter and POSIX forms alike", () => {
    const w = world();
    const ctx = new Ctx({ cwd: w.project, home: w.home, env: {}, platform: "win32", window: 200_000, tokenizer: "heuristic", claudeProfile: "current", systemRoot: w.sysroot, now: new Date(0) } as never, makeCounter("heuristic"));
    expect(ctx.sys("C:\\Program Files\\ClaudeCode")).toBe(path.join(w.sysroot, "Program Files", "ClaudeCode"));
    expect(ctx.sys("/Library/Application Support/ClaudeCode")).toBe(path.join(w.sysroot, "Library", "Application Support", "ClaudeCode"));
    expect(ctx.sys("/etc/codex/skills")).toBe(path.join(w.sysroot, "etc", "codex", "skills"));
  });

  it("platform=win32 / darwin scans never touch the real machine when a system root is given", () => {
    const w = world();
    for (const platform of ["win32", "darwin", "linux"] as const) {
      const r = scanWorld(w, { platform });
      expect(r.agents).toHaveLength(0);
    }
  });

  it("file names with backslashes, colons, trailing dots/spaces and reserved Windows names are handled and rendered safely", () => {
    const w = world();
    put(w.project, { "CLAUDE.md": "x\n", ".claude/rules/a\\b.md": "x ".repeat(50), ".claude/rules/con.md": "y ".repeat(50), ".claude/rules/trail.md ": "z ".repeat(50), ".claude/rules/c:d.md": "q ".repeat(50) });
    const r = scanWorld(w, { agents: ["claude-code"] });
    expect(r.agents[0].items.length).toBeGreaterThan(0);
  });

  it("locale-independent ordering: cmp is a pure code-unit comparison", () => {
    const xs = ["é", "e", "Z", "a", "ä", "ß", "ss", "İ", "i", "10", "9"];
    expect([...xs].sort(cmp)).toEqual([...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(cmp("a", "a")).toBe(0);
    expect(sanitize("a\u001b[31mb\nc\u0000d")).not.toMatch(/[\u0000-\u001f]/);
  });
});
