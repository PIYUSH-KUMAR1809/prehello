import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { world, cleanupWorlds, put, skillMd, scanWorld, agentOf } from "./helpers/tree";
import { renderTerminal } from "../src/render/terminal";
import { toJson } from "../src/render/json";
import { runCli } from "./helpers/run-cli";

afterAll(cleanupWorlds);

const term = (w: ReturnType<typeof world>, r: ReturnType<typeof scanWorld>, verbose = true) => renderTerminal(r, { color: false, width: 100, verbose, quiet: false, home: w.home, cwd: w.project });

describe("skills: Cursor", () => {
  it("lists skills as a listing (always) + bodies (deferred); path-scoped skills are conditional; disable-model-invocation is not listed", () => {
    const w = world();
    put(w.home, { ".cursor/skills/alpha/SKILL.md": skillMd("alpha", "Does alpha things when asked", "# body\n" + "x ".repeat(300)) });
    put(w.project, {
      ".cursor/skills/beta/SKILL.md": skillMd("beta", "Beta helper", "b\n", 'paths: ["src/**/*.ts"]\n'),
      ".cursor/skills/gamma/SKILL.md": skillMd("gamma", "Manual only", "g\n", "disable-model-invocation: true\n"),
    });
    const a = agentOf(scanWorld(w, { agents: ["cursor"] }), "cursor");
    const listing = a.items.filter((i) => i.kind === "skills-listing");
    expect(listing.some((i) => i.loadMode === "always" && i.scope === "user")).toBe(true);
    expect(listing.some((i) => i.loadMode === "conditional")).toBe(true);
    expect(a.items.some((i) => i.kind === "skill-body" && i.loadMode === "deferred")).toBe(true);
    const all = JSON.stringify(a.items);
    // gamma is manual only: its description must not be in any always-on listing
    const alwaysListing = listing.filter((i) => i.loadMode === "always");
    expect(alwaysListing.every((i) => !(i.breakdown ?? []).some((b) => b.label.includes("gamma")))).toBe(true);
    expect(all).toContain("on-demand");
  });

  it("nested .cursor/skills in a subdirectory are conditional, not always-on", () => {
    const w = world();
    put(w.project, { "packages/web/.cursor/skills/ui/SKILL.md": skillMd("ui", "UI helper") });
    const a = agentOf(scanWorld(w, { agents: ["cursor"] }), "cursor");
    const nested = a.items.filter((i) => i.scope === "nested" && i.kind === "skills-listing");
    expect(nested.length).toBe(1);
    expect(nested[0].loadMode).toBe("conditional");
    expect(a.items.filter((i) => i.loadMode === "always" && i.kind === "skills-listing")).toHaveLength(0);
  });

  it("~/.cursor/skills-cursor is labelled as an assumed, Cursor-managed location", () => {
    const w = world();
    put(w.home, { ".cursor/skills-cursor/create-rule/SKILL.md": skillMd("create-rule", "Create Cursor rules") });
    const a = agentOf(scanWorld(w), "cursor");
    const it = a.items.find((i) => i.kind === "skills-listing")!;
    expect(it.scope).toBe("builtin");
    expect(it.confidence).toBe("assumed");
    expect(it.notes.join(" ")).toMatch(/not in Cursor's docs/);
  });

  it("Cursor plugins: cache/local plugins count (assumed), marketplace clones are ignored", () => {
    const w = world();
    put(w.home, {
      ".cursor/plugins/local/my-plug/.cursor-plugin/plugin.json": JSON.stringify({ name: "my-plug" }),
      ".cursor/plugins/local/my-plug/skills/hello/SKILL.md": skillMd("hello", "Say hello"),
      ".cursor/plugins/local/my-plug/mcp.json": JSON.stringify({ mcpServers: { plugsrv: { command: "x" } } }),
      ".cursor/plugins/marketplaces/shop/plugins/other/plugin.json": JSON.stringify({ name: "other" }),
      ".cursor/plugins/marketplaces/shop/plugins/other/skills/zzz/SKILL.md": skillMd("zzz", "should be ignored"),
    });
    const a = agentOf(scanWorld(w), "cursor");
    const txt = JSON.stringify(a.items);
    expect(a.items.some((i) => i.scope === "plugin" && i.kind === "skills-listing")).toBe(true);
    expect(a.mcpServers.map((m) => m.name)).toContain("plugsrv");
    expect(txt).not.toContain("zzz");
    for (const i of a.items.filter((i) => i.scope === "plugin")) expect(i.confidence).toBe("assumed");
  });
});

describe("skills and plugins: Claude Code and Codex", () => {
  it("Claude Code: user skills list name+description; a disabled plugin is skipped; an enabled plugin's skills and MCP count", () => {
    const w = world();
    const on = path.join(w.home, ".claude", "plugins", "cache", "mk", "good", "1.0.0");
    const off = path.join(w.home, ".claude", "plugins", "cache", "mk", "bad", "1.0.0");
    put(on, { ".claude-plugin/plugin.json": JSON.stringify({ name: "good" }), "skills/g1/SKILL.md": skillMd("g1", "good skill"), ".mcp.json": JSON.stringify({ mcpServers: { goodsrv: { command: "x" } } }) });
    put(off, { ".claude-plugin/plugin.json": JSON.stringify({ name: "bad" }), "skills/b1/SKILL.md": skillMd("b1", "bad skill") });
    put(w.home, {
      ".claude/settings.json": JSON.stringify({ enabledPlugins: { "good@mk": true, "bad@mk": false } }),
      ".claude/plugins/installed_plugins.json": JSON.stringify({ version: 2, plugins: { "good@mk": [{ scope: "user", installPath: on }], "bad@mk": [{ scope: "user", installPath: off }] } }),
      ".claude/skills/mine/SKILL.md": skillMd("mine", "my own skill"),
    });
    const a = agentOf(scanWorld(w), "claude-code");
    const j = JSON.stringify(a.items);
    expect(j).toContain("g1");
    expect(j).not.toContain("b1");
    expect(a.items.some((i) => i.scope === "user" && i.kind === "skills-listing")).toBe(true);
    expect(a.mcpServers.map((m) => m.name)).toContain("goodsrv");
  });

  it("Claude Code: a recorded plugin whose directory vanished is reported as not loaded, not crashed on", () => {
    const w = world();
    put(w.home, { ".claude/plugins/installed_plugins.json": JSON.stringify({ plugins: { "gone@mk": [{ scope: "user", installPath: path.join(w.home, "nowhere") }] } }), ".claude/CLAUDE.md": "hi\n" });
    const r = scanWorld(w);
    expect(r.excluded.some((e) => /missing/.test(e.reason))).toBe(true);
  });

  it("Claude Code: malformed installed_plugins.json is ignored safely", () => {
    const w = world();
    put(w.home, { ".claude/plugins/installed_plugins.json": "{not json", ".claude/CLAUDE.md": "hi\n" });
    expect(() => scanWorld(w)).not.toThrow();
  });

  it("Codex: .agents/skills are read from cwd up to the repo root and ~/.agents/skills; [[skills.config]] enabled=false removes one", () => {
    const w = world();
    put(w.project, { ".agents/skills/root-skill/SKILL.md": skillMd("root-skill", "at the repo root"), "pkg/sub/.agents/skills/deep/SKILL.md": skillMd("deep", "deep skill"), "AGENTS.md": "hi\n" });
    put(w.home, {
      ".agents/skills/home-skill/SKILL.md": skillMd("home-skill", "in home"),
      ".agents/skills/off-skill/SKILL.md": skillMd("off-skill", "disabled one"),
      ".codex/config.toml": `[[skills.config]]\npath = ${JSON.stringify(path.join(w.home, ".agents/skills/off-skill/SKILL.md"))}\nenabled = false\n`,
    });
    const r = scanWorld(w, { cwd: path.join(w.project, "pkg", "sub") });
    const a = agentOf(r, "codex");
    const listings = a.items.filter((i) => i.kind === "skills-listing");
    expect(listings.length).toBeGreaterThanOrEqual(3);
    const dump = JSON.stringify(a.items);
    expect(dump).not.toContain("off-skill");
    expect(r.excluded.some((e) => /skills\.config/.test(e.reason))).toBe(true);
    for (const l of listings.filter((i) => i.confidence === "documented")) expect(l.loadMode).toBe("always");
  });

  it("Codex: skills outside the repo (above the git root) are NOT read", () => {
    const w = world();
    put(w.root, { ".agents/skills/above/SKILL.md": skillMd("above", "above the repo") });
    put(w.project, { "AGENTS.md": "x\n" });
    const a = agentOf(scanWorld(w), "codex");
    expect(JSON.stringify(a.items)).not.toContain("above the repo");
    expect(a.items.some((i) => i.kind === "skills-listing")).toBe(false);
  });
});

describe("MCP configuration parsing (names and counts, even when unmeasured)", () => {
  it("reads .mcp.json, ~/.claude.json, cursor mcp.json (user + project) and codex config.toml; nothing is measured", () => {
    const w = world();
    put(w.project, {
      ".mcp.json": JSON.stringify({ mcpServers: { "proj-a": { command: "x" }, "proj-b": { url: "https://x.invalid/mcp" } } }),
      ".cursor/mcp.json": JSON.stringify({ mcpServers: { "cur-proj": { command: "y" } } }),
      "CLAUDE.md": "c\n",
    });
    put(w.home, {
      ".claude.json": JSON.stringify({ mcpServers: { "claude-user": { command: "z" } } }),
      ".cursor/mcp.json": JSON.stringify({ mcpServers: { "cur-user": { command: "y", env: { TOKEN: "SECRET-TOKEN-VALUE" } } } }),
      ".codex/config.toml": `[mcp_servers.codex-one]\ncommand = "c"\n[mcp_servers.codex-two]\nurl = "https://x.invalid"\n`,
    });
    const r = scanWorld(w, { agents: ["claude-code", "cursor", "codex"] });
    const names = (id: string) => agentOf(r, id).mcpServers.map((m) => m.name).sort();
    expect(names("claude-code")).toEqual(expect.arrayContaining(["claude-user", "proj-a", "proj-b"]));
    expect(names("cursor")).toEqual(expect.arrayContaining(["cur-proj", "cur-user"]));
    expect(names("codex")).toEqual(["codex-one", "codex-two"]);
    for (const a of r.agents) for (const m of a.mcpServers) expect(m.measured).toBe(false);
    // secrets are never carried into the report, and strict output hides names
    const full = JSON.stringify(toJson(r, { cwd: w.project, home: w.home }, false));
    expect(full).not.toContain("SECRET-TOKEN-VALUE");
    const strict = JSON.stringify(toJson(r, { cwd: w.project, home: w.home }, true));
    expect(strict).not.toContain("codex-one");
    expect(strict).not.toContain("proj-a");
    expect(strict).not.toContain("x.invalid");
  });

  it("a duplicated or hostile server name cannot inject terminal escapes", () => {
    const w = world();
    put(w.project, { ".mcp.json": JSON.stringify({ mcpServers: { "evil\u001b[31mred\u001b]0;pwn\u0007": { command: "x" } } }), "CLAUDE.md": "c\n" });
    const out = term(w, scanWorld(w));
    expect(out).not.toMatch(/\u001b/);
    expect(out).not.toMatch(/\u0007/);
  });

  it("--no-bundled-catalog makes even a known package unmeasured", () => {
    const w = world();
    put(w.project, { ".mcp.json": JSON.stringify({ mcpServers: { pw: { command: "npx", args: ["-y", "@playwright/mcp"] } } }) });
    const a = agentOf(scanWorld(w, { agents: ["claude-code"], noBundledCatalog: true }), "claude-code");
    expect(a.items.filter((i) => i.kind === "mcp-server").every((i) => i.tokens === null)).toBe(true);
  });
});

describe("summaries: coverage, offenders, grade honesty", () => {
  it("coverage separates measured from unmeasured and agrees with totals", () => {
    const w = world();
    put(w.project, { "CLAUDE.md": "rules ".repeat(100), ".mcp.json": JSON.stringify({ mcpServers: { a: { command: "x" }, b: { command: "x" } } }) });
    const a = agentOf(scanWorld(w), "claude-code");
    expect(a.coverage.alwaysMeasuredItems).toBe(1);
    expect(a.coverage.alwaysUnmeasuredItems).toBe(2);
    expect(a.coverage.alwaysFraction).toBeCloseTo(1 / 3, 5);
    expect(a.coverage.unmeasuredKinds["mcp-server"]).toBe(2);
    expect(a.totals.always.unmeasuredItems).toBe(2);
  });

  it("a grade of A is never given while always-on items are unmeasured (capped at B, marked provisional)", () => {
    const w = world();
    put(w.project, { "CLAUDE.md": "tiny\n", ".mcp.json": JSON.stringify({ mcpServers: { a: { command: "x" } } }) });
    const a = agentOf(scanWorld(w, { agents: ["claude-code"] }), "claude-code");
    expect(a.grade).not.toBeNull();
    expect(a.grade?.letter).not.toBe("A");
    expect(a.grade?.provisional).toBe(true);
    expect(a.grade?.cappedAt).toBe("B");
  });

  it("when everything up front is unmeasured there is NO grade and a reason is given", () => {
    const w = world();
    put(w.project, { ".mcp.json": JSON.stringify({ mcpServers: { a: { command: "x" } } }) });
    const a = agentOf(scanWorld(w, { agents: ["claude-code"] }), "claude-code");
    expect(a.grade).toBeNull();
    expect(a.gradeNote).toMatch(/unmeasured/);
    expect(term(w, scanWorld(w, { agents: ["claude-code"] }))).not.toMatch(/Grade [A-F]/);
  });

  it("top offenders are sorted, measured-only, and name the heaviest skill inside a listing", () => {
    const w = world();
    put(w.project, { "CLAUDE.md": "a ".repeat(2000), ".claude/rules/small.md": "b ".repeat(20), ".claude/rules/mid.md": "c ".repeat(200) });
    put(w.home, { ".claude/skills/heavy/SKILL.md": skillMd("heavy", "very long description ".repeat(40)), ".claude/skills/light/SKILL.md": skillMd("light", "short") });
    const a = agentOf(scanWorld(w), "claude-code");
    const toks = a.offenders.map((o) => o.tokens);
    expect([...toks].sort((x, y) => y - x)).toEqual(toks);
    expect(a.offenders.length).toBeGreaterThan(2);
    expect(a.offenders.some((o) => /heavy/.test(o.label))).toBe(true);
    expect(a.offenders.every((o) => o.tokens > 0)).toBe(true);
  });

  it("strict JSON hides offender labels and paths", () => {
    const w = world();
    put(w.project, { "CLAUDE.md": "a ".repeat(200), ".claude/rules/zz-secret-name.md": "b ".repeat(20), ".claude/rules/yy-secret-name.md": "b ".repeat(20) });
    put(w.home, { ".claude/skills/secret-skill/SKILL.md": skillMd("secret-skill", "d") });
    const s = JSON.stringify(toJson(scanWorld(w), { cwd: w.project, home: w.home }, true));
    expect(s).not.toMatch(/secret-name|secret-skill/);
  });
});

describe("first run and detected-but-empty", () => {
  it("Cursor.app present but nothing found: says it is installed, explains where it looked, never says 'no agents' or 0", () => {
    const w = world();
    fs.mkdirSync(path.join(w.sysroot, "Applications", "Cursor.app"), { recursive: true });
    const r = scanWorld(w, { platform: "darwin" });
    expect(r.agents.map((a) => a.id)).toEqual(["cursor"]);
    const out = term(w, r, false);
    expect(out).toMatch(/Cursor is installed .* but nothing that loads before hello was found/);
    expect(out).toMatch(/NOT a score of 0/);
    expect(out).toMatch(/--paste-user-rules/);
    expect(out).not.toMatch(/No coding agents detected/);
    expect(out).not.toMatch(/\b0 tokens\b/);
    expect(JSON.parse(JSON.stringify(toJson(r, { cwd: w.project, home: w.home }, false))).agents[0].installedButNothingFound).toBe(true);
  });

  it("truly nothing: lists what was looked for and what to try", () => {
    const w = world();
    const out = term(w, scanWorld(w), false);
    expect(out).toMatch(/No coding agents detected/);
    expect(out).toMatch(/prehello looked for/);
    expect(out).toMatch(/prehello --agent claude-code/);
  });

  it("the CLI with an empty HOME and a poisoned PATH-free env behaves the same (hermetic system root)", () => {
    const w = world();
    const res = runCli([w.project, "--ceiling", w.root], { home: w.home, cwd: w.project });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/No coding agents detected/);
  });
});

describe("--paste-user-rules", () => {
  it("counts the pasted text for Cursor, shows it as an item, and never prints or exports it", () => {
    const w = world();
    const f = path.join(w.root, "rules.txt");
    fs.writeFileSync(f, "Always answer like a pirate. CANARY-PASTED-RULE-TEXT\n".repeat(30));
    const r = scanWorld(w, { pastedUserRules: fs.readFileSync(f, "utf8") });
    const a = agentOf(r, "cursor");
    const it = a.items.find((i) => i.kind === "user-rules")!;
    expect(it.loadMode).toBe("always");
    expect(it.tokens!.est).toBeGreaterThan(100);
    expect(term(w, r)).not.toMatch(/CANARY-PASTED-RULE-TEXT/);
    expect(JSON.stringify(toJson(r, { cwd: w.project, home: w.home }, false))).not.toMatch(/CANARY-PASTED-RULE-TEXT/);
  });

  it("CLI: reads a file, rejects missing/empty/directory inputs with a clear error, and ignores no flag silently", () => {
    const w = world();
    const f = path.join(w.root, "rules.txt");
    fs.writeFileSync(f, "be terse ".repeat(100));
    const ok = runCli([w.project, "--paste-user-rules", f, "--ceiling", w.root, "--json"], { home: w.home, cwd: w.project });
    expect(ok.status).toBe(0);
    const j = JSON.parse(ok.stdout);
    expect(j.agents.find((a: { id: string }) => a.id === "cursor").items.some((i: { kind: string }) => i.kind === "user-rules")).toBe(true);
    const missing = runCli([w.project, "--paste-user-rules", path.join(w.root, "nope.txt"), "--ceiling", w.root], { home: w.home, cwd: w.project });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toMatch(/paste-user-rules/);
    fs.writeFileSync(path.join(w.root, "empty.txt"), "  \n");
    const empty = runCli([w.project, "--paste-user-rules", path.join(w.root, "empty.txt"), "--ceiling", w.root], { home: w.home, cwd: w.project });
    expect(empty.status).not.toBe(0);
    const dir = runCli([w.project, "--paste-user-rules", w.root, "--ceiling", w.root], { home: w.home, cwd: w.project });
    expect(dir.status).not.toBe(0);
  });
});

describe("bundled MCP catalog (measured numbers)", () => {
  const bundled = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "spec", "mcp-weights.json"), "utf8")) as { servers: Array<{ package: string; tools: number; nameTokens: number; schemaTokens: number; measuredAt: string; version: string }> };

  it("every bundled entry is a real measurement: positive numbers, a UTC date, a version, no fixture marker", () => {
    expect(bundled.servers.length).toBeGreaterThanOrEqual(5);
    for (const s of bundled.servers) {
      expect(s.tools).toBeGreaterThan(0);
      expect(s.nameTokens).toBeGreaterThan(0);
      expect(s.schemaTokens).toBeGreaterThan(s.nameTokens);
      expect(s.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(s.version).not.toMatch(/fixture|unknown/i);
    }
  });

  it("matches `npx -y @playwright/mcp@latest` by package (version suffix ignored) and tags the measurement", () => {
    const w = world();
    put(w.project, { ".mcp.json": JSON.stringify({ mcpServers: { pw: { command: "npx", args: ["-y", "@playwright/mcp@latest"] } } }) });
    const a = agentOf(scanWorld(w, { agents: ["claude-code"], noBundledCatalog: false }), "claude-code");
    const mcp = a.items.filter((i) => i.kind === "mcp-server");
    expect(mcp.length).toBeGreaterThan(0);
    expect(mcp.every((i) => i.tokens !== null)).toBe(true);
    expect(JSON.stringify(mcp)).toContain("your version may differ");
  });

  it("an unknown server stays unmeasured (never 0)", () => {
    const w = world();
    put(w.project, { ".mcp.json": JSON.stringify({ mcpServers: { mystery: { command: "npx", args: ["-y", "some-unlisted-mcp"] } } }) });
    const a = agentOf(scanWorld(w, { agents: ["claude-code"] }), "claude-code");
    expect(a.items.filter((i) => i.kind === "mcp-server").every((i) => i.tokens === null)).toBe(true);
  });
});
