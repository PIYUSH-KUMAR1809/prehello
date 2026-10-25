import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { golden } from "./helpers/fixtures";
import { world, cleanupWorlds, put, scanWorld, skillMd, World } from "./helpers/tree";
import { runCli } from "./helpers/run-cli";
import { renderCard, pickCardAgent } from "../src/render/card";
import { cardTiles, cutCandidates } from "../src/analyze/savings";
import { fmtTok } from "../src/util/fmt";
import type { AgentReport, Item, Report } from "../src/model";

afterAll(cleanupWorlds);

const DESC = "Use this skill when working with analytics, dashboards, experiments and feature flags in a product team.";
const longDesc = (n: number) => DESC + " extra".repeat(n);

/** The shape of the bug report: Cursor, one big plugin, one small plugin, a folder of Cursor-managed skills, an AGENTS.md. */
function macLikeCursor(): World {
  const w = world();
  for (const [name, n] of [["posthog", 73], ["figma", 14]] as const) {
    const root = path.join(w.home, ".cursor", "plugins", "cache", "mk", name, "abc123");
    put(root, { ".cursor-plugin/plugin.json": JSON.stringify({ name }) });
    for (let i = 0; i < n; i++) put(root, { [`skills/${name}-${i}/SKILL.md`]: skillMd(`${name}-${i}`, longDesc(name === "posthog" ? 8 : 4)) });
  }
  for (let i = 0; i < 18; i++) put(w.home, { [`.cursor/skills-cursor/managed-${i}/SKILL.md`]: skillMd(`managed-${i}`, longDesc(2)) });
  put(w.project, { "AGENTS.md": "# rules\n" + "Prefer small functions. ".repeat(60) });
  return w;
}

const agentOf = (r: Report, id: string): AgentReport => r.agents.find((a) => a.id === id)!;
const tilesOf = (a: AgentReport, anon = false) => cardTiles(a.items, anon);

/** Parse the treemap tiles (rx="6" rects) and the bold label lines that follow each one. `label` is the lines joined by a space. */
interface Tile { x: number; y: number; w: number; h: number; lines: string[]; label: string | null; size: number | null }
function treemap(svg: string): Tile[] {
  const out: Tile[] = [];
  const re = /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="6" fill="[^"]*"\/>((?:\n<text x="[\d.]+" y="[\d.]+" font-family="[^"]*" font-size="\d+" font-weight="600" fill="#ffffff">[^<]*<\/text>)*)/g;
  for (const m of svg.matchAll(re)) {
    const ls = [...m[5].matchAll(/font-size="(\d+)" font-weight="600" fill="#ffffff">([^<]*)</g)];
    const lines = ls.map((x) => x[2].replace(/&amp;/g, "&"));
    out.push({ x: +m[1], y: +m[2], w: +m[3], h: +m[4], lines, label: lines.length ? lines.join(" ") : null, size: ls.length ? +ls[0][1] : null });
  }
  return out;
}

describe("card treemap uses the same groups as 'what to cut' (Cursor, the reported bug)", () => {
  it("tiles are 'plugin posthog', 'plugin figma', '18 Cursor-managed skills' and never 'skills listing N'", () => {
    const w = macLikeCursor();
    const r = scanWorld(w, { agents: ["cursor"] });
    const a = agentOf(r, "cursor");
    const labels = tilesOf(a).map((t) => t.label);
    expect(labels).toContain("plugin posthog");
    expect(labels).toContain("plugin figma");
    expect(labels).toContain("18 Cursor-managed skills");
    expect(labels.join("|")).not.toMatch(/skills listing/);
    const svg = renderCard(r, pickCardAgent(r, "cursor")!, { theme: "dark", size: "og" });
    const shown = treemap(svg).map((t) => t.label);
    expect(shown).toContain("plugin posthog");
    expect(svg).not.toMatch(/skills listing/);
    // the biggest tile is the biggest cut group, and its share is not the whole listing
    const cut = cutCandidates(a.items);
    expect(cut[0].label).toBe("plugin posthog");
    expect(tilesOf(a)[0]).toMatchObject({ label: "plugin posthog", tokens: cut[0].tokens });
  });

  it("every cut group appears with exactly the cut-list token number (tile == 'what to cut' row)", () => {
    const r = scanWorld(macLikeCursor(), { agents: ["cursor"] });
    const a = agentOf(r, "cursor");
    const tiles = tilesOf(a);
    for (const c of cutCandidates(a.items)) {
      const t = tiles.find((x) => x.label === c.label);
      expect(t, c.label).toBeTruthy();
      expect(t!.tokens).toBe(c.tokens);
    }
    // and the same numbers are what the headline sums
    expect(a.savings!.groupsTokens).toBe(cutCandidates(a.items).reduce((s, c) => s + c.tokens, 0));
  });

  it("headline, tiles and the always-on chip agree: groups <= always-on, tiles add up to always-on (+-rounding), chip text = always-on", () => {
    const r = scanWorld(macLikeCursor(), { agents: ["cursor"] });
    const a = agentOf(r, "cursor");
    const sv = a.savings!;
    expect(sv.groupsTokens).toBeLessThanOrEqual(a.totals.always.est);
    const tileSum = tilesOf(a).reduce((s, t) => s + t.tokens, 0);
    expect(Math.abs(tileSum - a.totals.always.est)).toBeLessThanOrEqual(cutCandidates(a.items).length); // per-group rounding only
    const svg = renderCard(r, a, { theme: "dark", size: "og" });
    expect(svg).toContain(`always-on ~${fmtTok(a.totals.always.est)} · `);
    expect(svg).toContain(`Skills &amp; plugins cost ~${fmtTok(sv.groupsTokens)} tokens before hello`);
    expect(Number.parseFloat(fmtTok(sv.groupsTokens))).toBeLessThanOrEqual(Number.parseFloat(fmtTok(a.totals.always.est)));
  });

  it("lower-bound: with an unmeasured always-on item the hero and the chip both say 'at least'", () => {
    const w = macLikeCursor();
    put(w.project, { ".cursor/mcp.json": JSON.stringify({ mcpServers: { mystery: { command: "npx", args: ["-y", "mystery-pkg"] } } }) });
    const r = scanWorld(w, { agents: ["cursor"] });
    const a = agentOf(r, "cursor");
    expect(a.lowerBound).toBe(true);
    const svg = renderCard(r, a, { theme: "dark", size: "og" });
    expect(svg).toMatch(/cost at least ~[\d.]+k tokens before hello/);
    expect(svg).toMatch(/always-on at least ~[\d.]+k/);
    expect(svg).not.toContain("mystery"); // unmeasured server: no tile, no name
  });

  it("anonymize replaces plugin names, keeps generic group names", () => {
    const r = scanWorld(macLikeCursor(), { agents: ["cursor"] });
    const a = agentOf(r, "cursor");
    const labels = tilesOf(a, true).map((t) => t.label);
    expect(labels).toContain("plugin 1");
    expect(labels).toContain("plugin 2");
    expect(labels).toContain("18 Cursor-managed skills");
    const svg = renderCard(r, pickCardAgent(r, "cursor")!, { theme: "light", size: "square", anonymize: true });
    expect(svg).not.toMatch(/posthog|figma/);
  });
});

describe("golden cards (Cursor world shaped like the bug report)", () => {
  for (const [name, o] of [["og-dark", { theme: "dark", size: "og" }], ["square-light", { theme: "light", size: "square" }], ["og-dark-anonymized", { theme: "dark", size: "og", anonymize: true }]] as const) {
    it(name, () => {
      const r = scanWorld(macLikeCursor(), { agents: ["cursor"] });
      const g = golden(`card-cursor-groups-${name}.svg`, renderCard(r, pickCardAgent(r, "cursor")!, o));
      expect(g.ok, g.message).toBe(true);
    });
  }
});

describe("treemap layout: readable labels, small tiles merged, nothing overflows", () => {
  function manyPlugins(): World {
    const w = world();
    const sizes: Record<string, number> = { "huge-plugin-with-a-very-long-descriptive-name-that-must-be-truncated": 60, big: 30, mid: 15, small: 8, tiny1: 1, tiny2: 1, tiny3: 1, tiny4: 1, tiny5: 1, tiny6: 1, tiny7: 1, tiny8: 1 };
    for (const [name, n] of Object.entries(sizes)) {
      const root = path.join(w.home, ".cursor", "plugins", "cache", "mk", name, "abc123");
      put(root, { ".cursor-plugin/plugin.json": JSON.stringify({ name }) });
      for (let i = 0; i < n; i++) put(root, { [`skills/${name}-${i}/SKILL.md`]: skillMd(`${name}-${i}`, DESC) });
    }
    put(w.project, { "AGENTS.md": "# rules\n" + "Prefer small functions. ".repeat(200) });
    return w;
  }

  it("small groups are merged into one 'other (N smaller)' tile; at most 8 named tiles + other", () => {
    const r = scanWorld(manyPlugins(), { agents: ["cursor"] });
    const a = agentOf(r, "cursor");
    for (const size of ["og", "square"] as const) {
      const tiles = treemap(renderCard(r, a, { theme: "dark", size }));
      expect(tiles.length).toBeLessThanOrEqual(9);
      const other = tiles.filter((t) => /^other/.test(t.label ?? ""));
      expect(other.length).toBe(1);
      expect(other[0].label).toMatch(/^other/);
      expect(tiles.filter((t) => /tiny/.test(t.label ?? "")).length).toBe(0);
    }
  });

  it("every tile stays inside the treemap area, every label fits its tile (wide-font estimate), no tile is unlabelled below the readable size", () => {
    const r = scanWorld(manyPlugins(), { agents: ["cursor"] });
    const a = agentOf(r, "cursor");
    for (const size of ["og", "square"] as const) {
      const W = size === "og" ? 1200 : 1080;
      const svg = renderCard(r, a, { theme: "dark", size });
      const tiles = treemap(svg);
      expect(tiles.length).toBeGreaterThan(3);
      for (const t of tiles) {
        expect(t.x).toBeGreaterThanOrEqual(0);
        expect(t.x + t.w).toBeLessThanOrEqual(W);
        if (t.label !== null) {
          expect(t.size!).toBeGreaterThanOrEqual(11);
          for (const ln of t.lines) expect(10 + ln.replace(/&(apos|quot|lt|gt);/g, "x").length * t.size! * 0.62, `${ln} @${t.size}`).toBeLessThanOrEqual(t.w + 1);
          expect(t.lines.length * (t.size! + 3) + 6, t.label).toBeLessThanOrEqual(t.h + 1);
        }
      }
      // the two biggest tiles are always labelled
      expect(tiles.slice(0, 2).every((t) => t.label !== null)).toBe(true);
      // the long plugin name is truncated, not overflowing and not dropped
      expect(svg).toMatch(/>plugin huge-plugin-with[^<]*</);
      expect(tiles.find((t) => /^plugin huge/.test(t.label ?? ""))!.label!.length).toBeLessThan("plugin huge-plugin-with-a-very-long-descriptive-name-that-must-be-truncated".length);
    }
  });

  const D2 = "Use this skill when working with analytics, dashboards, experiments, feature flags, funnels, retention and cohorts in a product team.";
  it("a tall, narrow tile keeps its name (rotated) instead of being dropped", () => {
    const w = world();
    for (const [name, n] of [["analytics-kit", 73], ["design-kit", 14], ["cloud-kit", 6]] as const) {
      const root = path.join(w.home, ".cursor", "plugins", "cache", "mk", name, "abc123");
      put(root, { ".cursor-plugin/plugin.json": JSON.stringify({ name }) });
      for (let i = 0; i < n; i++) put(root, { [`skills/${name}-${i}/SKILL.md`]: skillMd(`${name}-${i}`, D2) });
    }
    for (let i = 0; i < 18; i++) put(w.home, { [`.cursor/skills-cursor/managed-${i}/SKILL.md`]: skillMd(`managed-${i}`, D2.slice(0, 70)) });
    put(w.project, { "AGENTS.md": "# rules\n" + "Prefer small functions. ".repeat(260) });
    const r = scanWorld(w, { agents: ["cursor"] });
    const svg = renderCard(r, agentOf(r, "cursor"), { theme: "dark", size: "og" });
    const narrow = treemap(svg).filter((t) => t.label === null && t.w >= 24 && t.h >= 90);
    const rotated = [...svg.matchAll(/<text transform="rotate\(-90 [\d. ]+\)"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(rotated.length).toBe(narrow.length);
    for (const t of rotated) expect(t).toMatch(/^plugin cloud-kit · ~[\d.]+k?$/);
    expect(rotated.length).toBe(1);
  });
  it("tile areas follow token counts (the biggest group has the biggest area)", () => {
    const r = scanWorld(manyPlugins(), { agents: ["cursor"] });
    const tiles = treemap(renderCard(r, agentOf(r, "cursor"), { theme: "dark", size: "og" }));
    const areas = tiles.map((t) => t.w * t.h);
    expect(areas[0]).toBe(Math.max(...areas));
    expect(tiles[0].label).toMatch(/^plugin huge/);
  });

  it("a card with only one group and one rule file still renders a sensible treemap", () => {
    const w = world();
    const root = path.join(w.home, ".cursor", "plugins", "cache", "mk", "solo", "abc");
    put(root, { ".cursor-plugin/plugin.json": JSON.stringify({ name: "solo" }) });
    for (let i = 0; i < 30; i++) put(root, { [`skills/s${i}/SKILL.md`]: skillMd(`s${i}`, DESC) });
    const r = scanWorld(w, { agents: ["cursor"] });
    const tiles = treemap(renderCard(r, agentOf(r, "cursor"), { theme: "dark", size: "square" }));
    expect(tiles.map((t) => t.label)).toEqual(["plugin solo"]);
  });
});

describe("the same groups on the other agents", () => {
  it("claude-code: plugin groups, user skills and rule files; no 'skills listing N'", () => {
    const w = world();
    const rec: Record<string, unknown> = {};
    for (const [name, n] of [["design", 30], ["infra", 12]] as const) {
      const root = path.join(w.home, ".claude/plugins/cache/mk", name, "1.0.0");
      put(root, { ".claude-plugin/plugin.json": JSON.stringify({ name }) });
      for (let i = 0; i < n; i++) put(root, { [`skills/${name}-${i}/SKILL.md`]: skillMd(`${name}-${i}`, DESC) });
      rec[`${name}@mk`] = [{ scope: "user", installPath: root }];
    }
    put(w.home, { ".claude/plugins/installed_plugins.json": JSON.stringify({ version: 2, plugins: rec }) });
    for (let i = 0; i < 20; i++) put(w.home, { [`.claude/skills/own-${i}/SKILL.md`]: skillMd(`own-${i}`, DESC) });
    put(w.project, { "CLAUDE.md": "# rules\n" + "Prefer small functions. ".repeat(100) });
    const r = scanWorld(w, { agents: ["claude-code"] });
    const a = agentOf(r, "claude-code");
    const labels = tilesOf(a).map((t) => t.label);
    expect(labels).toEqual(expect.arrayContaining(["plugin design", "plugin infra", "20 user skills"]));
    expect(labels).toContain("CLAUDE.md");
    const svg = renderCard(r, a, { theme: "dark", size: "og" });
    expect(svg).not.toMatch(/skills listing/);
    expect(treemap(svg).map((t) => t.label)).toContain("plugin design");
    expect(a.savings!.groupsTokens).toBeLessThanOrEqual(a.totals.always.est);
  });

  it("codex: user skills group plus AGENTS.md; a path-like source tag never reaches a tile label", () => {
    const w = world();
    for (let i = 0; i < 25; i++) put(w.home, { [`.agents/skills/c-${i}/SKILL.md`]: skillMd(`c-${i}`, DESC) });
    for (let i = 0; i < 10; i++) put(w.home, { [`.codex/skills/legacy-${i}/SKILL.md`]: skillMd(`legacy-${i}`, DESC) });
    put(w.project, { "AGENTS.md": "# rules\n" + "Prefer small functions. ".repeat(100) });
    const r = scanWorld(w, { agents: ["codex"] });
    const a = agentOf(r, "codex");
    const labels = tilesOf(a).map((t) => t.label);
    expect(labels.join("|")).not.toMatch(/skills listing|[\\/~]/);
    expect(labels.some((l) => /^25 user skills$/.test(l))).toBe(true);
    const svg = renderCard(r, a, { theme: "dark", size: "og" });
    expect(svg).not.toMatch(/skills listing/);
    expect(svg).not.toMatch(/\.codex|~\//);
  });
});

describe("cardTiles unit", () => {
  const it0 = (o: Partial<Item>): Item => ({ id: "x", agent: "cursor", path: "/p", kind: "rule", scope: "project", loadMode: "always", cardLabel: "rule file", label: "r", tokens: { est: 100, low: 90, high: 110 }, chars: 1, lines: 1, confidence: "documented", evidence: { docUrl: "", verifiedAt: "" }, notes: [], ...o }) as Item;

  it("merges repeated generic labels (rule file x2), keeps one tile per group, ignores unmeasured and non-always items", () => {
    const tiles = cardTiles([
      it0({ id: "1", tokens: { est: 300, low: 1, high: 1 } }),
      it0({ id: "2", tokens: { est: 200, low: 1, high: 1 } }),
      it0({ id: "3", tokens: null }),
      it0({ id: "4", loadMode: "conditional" }),
      it0({ id: "5", kind: "skills-listing", label: "Skills listing (4 user skills)", tokens: { est: 50, low: 1, high: 1 } }),
    ]);
    expect(tiles.map((t) => [t.label, t.tokens])).toEqual([["rule file x2", 500], ["4 user skills", 50]]);
  });

  it("identical group names stay distinguishable", () => {
    const parts = [{ name: "plugin dup", tokens: 600, count: 2 }, { name: "plugin dup", tokens: 500, count: 2 }];
    const tiles = cardTiles([it0({ kind: "skills-listing", tokens: { est: 1100, low: 1, high: 1 }, parts, label: "Skills listing (x)" })]);
    expect(tiles.map((t) => t.label)).toEqual(["plugin dup (1)", "plugin dup (2)"]);
  });

  it("MCP servers with a measured size are named tiles and anonymised as 'MCP server N'", () => {
    const items = [it0({ id: "m", kind: "mcp-server", cardLabel: "MCP server", server: { name: "github", transport: "stdio" } as Item["server"], tokens: { est: 4000, low: 1, high: 1 } })];
    expect(cardTiles(items)[0]).toMatchObject({ label: "MCP server github", kind: "mcp", named: true });
    expect(cardTiles(items, true)[0]).toMatchObject({ label: "MCP server 1", named: false });
  });
});

describe("CLI", () => {
  const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "prehello-cg-")));
  it("--card-anonymize is wired; without it plugin names are on the card", () => {
    const w = macLikeCursor();
    const out = tmp();
    const a = path.join(out, "a.svg");
    const b = path.join(out, "b.svg");
    const base = [w.project, "--agent", "cursor", "--ceiling", w.root, "--managed-dir", path.join(w.root, "none"), "--no-bundled-catalog"];
    expect(runCli([...base, `--card=${a}`], { home: w.home, cwd: w.project, allowWrite: [a] }).status).toBe(0);
    expect(runCli([...base, `--card=${b}`, "--card-anonymize"], { home: w.home, cwd: w.project, allowWrite: [b] }).status).toBe(0);
    expect(fs.readFileSync(a, "utf8")).toContain(">plugin posthog<");
    expect(fs.readFileSync(b, "utf8")).not.toMatch(/posthog|figma/);
    expect(fs.readFileSync(b, "utf8")).toContain(">plugin 1<");
    const c = path.join(out, "c.svg");
    expect(runCli([...base, "--redact", `--card=${c}`], { home: w.home, cwd: w.project, allowWrite: [c] }).status).toBe(0);
    expect(fs.readFileSync(c, "utf8")).not.toMatch(/posthog|figma/); // --redact implies anonymised card labels
    fs.rmSync(out, { recursive: true, force: true });
  });
  it("'--card file.png'' (space) fails fast with a hint to use --card=file.png, before any report", () => {
    const w = macLikeCursor();
    const res = runCli(["--agent", "cursor", "--card", "nope.png", "--ceiling", w.root], { home: w.home, cwd: w.project });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/--card=nope\.png/);
    expect(res.stdout).toBe("");
  });
});
