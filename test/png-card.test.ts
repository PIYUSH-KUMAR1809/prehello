import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { materialize, runScan, cleanup, golden } from "./helpers/fixtures";
import { world, cleanupWorlds, put, scanWorld, skillMd } from "./helpers/tree";
import { runCli, ROOT } from "./helpers/run-cli";
import { renderCard, pickCardAgent, buildHeadline, assertHeadline, MIN_CUT_HEADLINE_TOKENS } from "../src/render/card";
import { svgToPng, loadEngine, tagPng, toFontSafeText, PngUnavailableError, PNG_FONT_FAMILY, PNG_CHAR_EM, PNG_MAGIC, FONT_DIR, PNG_UNAVAILABLE_MESSAGE } from "../src/render/png";
import { looksLikePrehelloOutput } from "../src/safe-write";
import type { AgentReport } from "../src/model";

afterAll(() => {
  cleanup();
  cleanupWorlds();
});

const tmpDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "prehello-png-"))); // realpath: macOS /var -> /private/var

/** Parses a PNG into its chunks and checks every CRC. */
function chunks(buf: Buffer): Array<{ type: string; data: Buffer }> {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  expect(buf.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
  const out: Array<{ type: string; data: Buffer }> = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    expect(buf.readUInt32BE(off + 8 + len), `crc of ${type}`).toBe(crc(buf.subarray(off + 4, off + 8 + len)));
    out.push({ type, data });
    off += 12 + len;
  }
  expect(off).toBe(buf.length);
  return out;
}
const dims = (buf: Buffer) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });

/** Code points the shipped (subsetted) Inter files can draw, read from their cmap tables (format 4 and 12). */
function fontCoverage(file: string): Set<number> {
  const b = fs.readFileSync(path.join(FONT_DIR, file));
  const numTables = b.readUInt16BE(4);
  let cmapOff = -1;
  for (let i = 0; i < numTables; i++) if (b.toString("latin1", 12 + i * 16, 16 + i * 16) === "cmap") cmapOff = b.readUInt32BE(20 + i * 16);
  const n = b.readUInt16BE(cmapOff + 2);
  const covered = new Set<number>();
  for (let i = 0; i < n; i++) {
    const sub = cmapOff + b.readUInt32BE(cmapOff + 4 + i * 8 + 4);
    const fmt = b.readUInt16BE(sub);
    if (fmt === 4) {
      const segX2 = b.readUInt16BE(sub + 6);
      const ends = sub + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const ranges = deltas + segX2;
      for (let s = 0; s < segX2 / 2; s++) {
        const end = b.readUInt16BE(ends + s * 2);
        const start = b.readUInt16BE(starts + s * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          const ro = b.readUInt16BE(ranges + s * 2);
          let gid = 0;
          if (ro === 0) gid = (c + b.readUInt16BE(deltas + s * 2)) & 0xffff;
          else {
            const g = b.readUInt16BE(ranges + s * 2 + ro + (c - start) * 2);
            gid = g === 0 ? 0 : (g + b.readUInt16BE(deltas + s * 2)) & 0xffff;
          }
          if (gid !== 0) covered.add(c);
        }
      }
    } else if (fmt === 12) {
      const groups = b.readUInt32BE(sub + 12);
      for (let g = 0; g < groups; g++) {
        const s = b.readUInt32BE(sub + 16 + g * 12);
        const e = b.readUInt32BE(sub + 20 + g * 12);
        const gid0 = b.readUInt32BE(sub + 24 + g * 12);
        for (let c = s; c <= e; c++) if (gid0 + (c - s) !== 0) covered.add(c);
      }
    }
  }
  return covered;
}

function pluginWorld() {
  const w = world();
  for (const [name, n] of [["posthog", 40], ["datadog", 20], ["figma", 10]] as const) {
    const root = path.join(w.home, ".cursor", "plugins", "cache", "mk", name, "abc123");
    put(root, { ".cursor-plugin/plugin.json": JSON.stringify({ name }) });
    for (let i = 0; i < n; i++) put(root, { [`skills/${name}-${i}/SKILL.md`]: skillMd(`${name}-${i}`, "Use this skill when working with analytics, dashboards, experiments and feature flags in a product team.", "Body.\n") });
  }
  put(w.project, { "AGENTS.md": "# rules\n" + "Be careful. ".repeat(300) });
  return w;
}

describe("headline: cut is the default, with guarded fallbacks", () => {
  it("CLI default writes the cut headline; --card-headline total opts out", () => {
    const w = pluginWorld();
    const out = tmpDir();
    const a = path.join(out, "a.svg");
    const b = path.join(out, "b.svg");
    const base = ["--agent", "cursor", "--ceiling", w.root, "--managed-dir", path.join(w.root, "none"), "--no-bundled-catalog"];
    expect(runCli([w.project, ...base, `--card=${a}`], { home: w.home, cwd: w.project, allowWrite: [a] }).status).toBe(0);
    expect(runCli([w.project, ...base, `--card=${b}`, "--card-headline", "total"], { home: w.home, cwd: w.project, allowWrite: [b] }).status).toBe(0);
    expect(fs.readFileSync(a, "utf8")).toMatch(/>Skills &amp; plugins cost [^<]*~[\d.]+k tokens before hello</);
    expect(fs.readFileSync(a, "utf8")).toMatch(/\(estimate\)/);
    expect(fs.readFileSync(b, "utf8")).toMatch(/>~[\d.]+k tokens load before hello</);
    expect(fs.readFileSync(b, "utf8")).not.toMatch(/Skills &amp; plugins cost/);
  });
  it("the cut card still shows the always-on total (as a chip) so the total is never hidden", () => {
    const w = pluginWorld();
    const r = scanWorld(w, { agents: ["cursor"] });
    expect(renderCard(r, pickCardAgent(r, "cursor")!, { theme: "dark", size: "og" })).toMatch(/always-on [^<]*~[\d.]+k · [\d.]+% of 200k/);
  });
  it("falls back to the total headline below the minimum saving, with nothing measured, or without savings", () => {
    const w = pluginWorld();
    const r = scanWorld(w, { agents: ["cursor"] });
    const a = pickCardAgent(r, "cursor")!;
    expect(buildHeadline(a, 200_000)!.id).toBe("cut-list"); // default variant
    const small: AgentReport = { ...a, savings: { ...a.savings!, topTokens: MIN_CUT_HEADLINE_TOKENS - 1 } };
    expect(buildHeadline(small, 200_000)!.id).toBe("tokens-before-hello");
    expect(renderCard(r, small, { theme: "dark", size: "og" })).toMatch(/tokens load before hello/);
    expect(() => assertHeadline({ ...buildHeadline(a, 200_000)!, id: "cut-list" }, small, 200_000)).toThrow(/minimum saving/);
    const unmeasured: AgentReport = { ...a, totals: { ...a.totals, always: { ...a.totals.always, measuredItems: 0, est: 0, unmeasuredItems: 2 } } };
    expect(buildHeadline(unmeasured, 200_000)!.id).toBe("mcp-unmeasured");
    expect(buildHeadline({ ...a, savings: null }, 200_000)!.id).toBe("tokens-before-hello");
  });
  it("a project whose cut list is below the minimum gets the total headline from the default CLI", () => {
    const m = materialize("realistic");
    const out = tmpDir();
    const f = path.join(out, "c.svg");
    const res = runCli([m.project, `--card=${f}`, "--ceiling", m.root, "--managed-dir", path.join(m.root, "none")], { home: m.home, cwd: m.project, allowWrite: [f] });
    expect(res.status === 0 || res.status === 3).toBe(true);
    const title = /<title id="t">([^<]*)<\/title>/.exec(fs.readFileSync(f, "utf8"))![1];
    expect(title).toMatch(/tokens load before hello$/);
    expect(title).not.toMatch(/Skills/);
  });
});

describe("PNG card export", () => {
  const base = (w: { root: string }) => ["--agent", "cursor", "--ceiling", w.root, "--managed-dir", path.join(w.root, "none"), "--no-bundled-catalog"];

  it("writes a valid PNG: magic bytes, valid chunk CRCs, the expected pixel size, and a prehello tEXt tag", () => {
    const w = pluginWorld();
    const out = tmpDir();
    for (const [size, scale, W, H] of [["og", "2", 2400, 1260], ["og", "1", 1200, 630], ["square", "2", 2160, 2160], ["square", "1", 1080, 1080]] as const) {
      const f = path.join(out, `${size}${scale}.png`);
      const res = runCli([w.project, ...base(w), `--card=${f}`, "--card-size", size, "--card-scale", scale], { home: w.home, cwd: w.project, allowWrite: [f] });
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toMatch(/Card written to/);
      const buf = fs.readFileSync(f);
      expect(buf.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
      expect(dims(buf)).toEqual({ w: W, h: H });
      const cs = chunks(buf);
      expect(cs[0].type).toBe("IHDR");
      expect(cs.at(-1)!.type).toBe("IEND");
      expect(cs.some((c) => c.type === "IDAT")).toBe(true);
      const text = cs.filter((c) => c.type === "tEXt").map((c) => c.data.toString("latin1"));
      expect(text.some((t) => /^Software\0prehello \d/.test(t))).toBe(true);
      expect(buf.length).toBeGreaterThan(5_000);
      expect(buf.length).toBeLessThan(1_500_000);
    }
  });
  it("default scale is 2x; the dark and light themes both render and differ", () => {
    const w = pluginWorld();
    const out = tmpDir();
    const d = path.join(out, "d.png");
    const l = path.join(out, "l.png");
    runCli([w.project, ...base(w), `--card=${d}`], { home: w.home, cwd: w.project, allowWrite: [d] });
    runCli([w.project, ...base(w), `--card=${l}`, "--card-theme", "light"], { home: w.home, cwd: w.project, allowWrite: [l] });
    expect(dims(fs.readFileSync(d))).toEqual({ w: 2400, h: 1260 });
    expect(fs.readFileSync(d).equals(fs.readFileSync(l))).toBe(false);
  });
  it("--card-format png without a file name writes prehello-card.png in the working directory", () => {
    const w = pluginWorld();
    const out = tmpDir();
    const f = path.join(out, "prehello-card.png");
    const res = runCli([w.project, ...base(w), "--card", "--card-format", "png"], { home: w.home, cwd: out, allowWrite: [f] });
    expect(res.status, res.stderr).toBe(0);
    expect(fs.readFileSync(f).subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
  });
  it("--json on stdout stays pure JSON when a PNG card is also written", () => {
    const w = pluginWorld();
    const out = tmpDir();
    const f = path.join(out, "j.png");
    const res = runCli([w.project, ...base(w), "--json", `--card=${f}`], { home: w.home, cwd: w.project, allowWrite: [f] });
    expect(res.status, res.stderr).toBe(0);
    expect(() => JSON.parse(res.stdout)).not.toThrow();
    expect(res.stderr).toMatch(/Card written/);
  });
  it("flag validation: extension/format mismatch, unknown format, bad scale, other extensions, --card-format without --card", () => {
    const w = pluginWorld();
    const run = (args: string[]) => runCli([w.project, ...base(w), ...args], { home: w.home, cwd: w.project });
    expect(run(["--card=x.png", "--card-format", "svg"])).toMatchObject({ status: 1 });
    expect(run(["--card=x.png", "--card-format", "svg"]).stderr).toMatch(/does not match/);
    expect(run(["--card=x.png", "--card-format", "jpg"]).stderr).toMatch(/svg or png/);
    expect(run(["--card=x.png", "--card-scale", "3"]).stderr).toMatch(/--card-scale/);
    expect(run(["--card=x.gif"]).stderr).toMatch(/must end in \.svg or \.png/);
    expect(run(["--card-format", "png"]).stderr).toMatch(/needs --card/);
  });
  it("re-running over its own PNG works without --force; a foreign file is refused; --force overrides; symlinks are never followed", () => {
    const w = pluginWorld();
    const out = tmpDir();
    const f = path.join(out, "c.png");
    const run = (file: string, extra: string[] = []) => runCli([w.project, ...base(w), `--card=${file}`, ...extra], { home: w.home, cwd: w.project, allowWrite: [file] });
    expect(run(f).status).toBe(0);
    expect(looksLikePrehelloOutput(fs.readFileSync(f).subarray(0, 4096).toString("latin1"), "png")).toBe(true);
    expect(run(f).status).toBe(0);
    const foreign = path.join(out, "foreign.png");
    fs.writeFileSync(foreign, Buffer.concat([PNG_MAGIC, Buffer.from("not ours")]));
    const before = fs.readFileSync(foreign);
    const res = run(foreign);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/not written by prehello/);
    expect(fs.readFileSync(foreign).equals(before)).toBe(true);
    expect(run(foreign, ["--force"]).status).toBe(0);
    const target = path.join(out, "target.png");
    fs.writeFileSync(target, "x");
    const link = path.join(out, "link.png");
    fs.symlinkSync(target, link);
    expect(run(link, ["--force"]).status).toBe(1);
    expect(fs.readFileSync(target, "utf8")).toBe("x");
  });
  it("PNG card source carries no paths or file contents; plugin names appear only as tile labels and --card-anonymize removes them", () => {
    const w = pluginWorld();
    const r = scanWorld(w, { agents: ["cursor"] });
    const svg = renderCard(r, pickCardAgent(r, "cursor")!, { theme: "dark", size: "og", fontFamily: PNG_FONT_FAMILY, charEm: PNG_CHAR_EM });
    expect(svg).not.toMatch(/\/tmp|prehello-w-|Be careful/);
    expect(svg).toMatch(/>plugin (posthog|datadog|figma)</);
    const anon = renderCard(r, pickCardAgent(r, "cursor")!, { theme: "dark", size: "og", fontFamily: PNG_FONT_FAMILY, charEm: PNG_CHAR_EM, anonymize: true });
    expect(anon).not.toMatch(/posthog|datadog|figma|\/tmp|prehello-w-|Be careful/);
    expect(anon).toMatch(/>plugin \d</);
    const buf = fs.readFileSync(ROOT + "/package.json"); // sanity: ROOT is the project root
    expect(buf.length).toBeGreaterThan(0);
  });
});

describe("PNG fallback when the optional engine is missing", () => {
  it("CLI: clear message on stderr, exit 1, no file written, the report still prints, and SVG keeps working", () => {
    const w = pluginWorld();
    const out = tmpDir();
    const f = path.join(out, "c.png");
    const s = path.join(out, "c.svg");
    const base = [w.project, "--agent", "cursor", "--ceiling", w.root, "--managed-dir", path.join(w.root, "none"), "--no-bundled-catalog", "--png-engine", "none"];
    const res = runCli([...base, `--card=${f}`], { home: w.home, cwd: w.project, allowWrite: [f] });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("@resvg/resvg-wasm");
    expect(res.stderr).toContain("npm install @resvg/resvg-wasm");
    expect(res.stderr).toContain("npm install -g @resvg/resvg-wasm");
    expect(res.stderr).toContain("npx --package prehello --package @resvg/resvg-wasm -- prehello --card=card.png");
    expect(res.stderr).toContain("--card=card.svg");
    expect(res.stderr).not.toMatch(/\n\s+at .*\(.*:\d+:\d+\)|Error:|internal error/); // never a stack trace
    expect(res.stdout).toMatch(/ALWAYS ON/);
    expect(fs.existsSync(f)).toBe(false);
    const ok = runCli([...base, `--card=${s}`], { home: w.home, cwd: w.project, allowWrite: [s] });
    expect(ok.status).toBe(0);
    expect(fs.readFileSync(s, "utf8")).toMatch(/^<svg/);
  });
  it("API: loadEngine with a resolver that cannot find the package throws PngUnavailableError with the install hint", async () => {
    await expect(loadEngine(() => { throw new Error("MODULE_NOT_FOUND"); })).rejects.toThrow(PngUnavailableError);
    await expect(svgToPng("<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'/>", { scale: 1, version: "0", resolver: () => { throw new Error("nope"); } })).rejects.toThrow(/@resvg\/resvg-wasm.*not installed/);
    expect(PNG_UNAVAILABLE_MESSAGE).toMatch(/npm install -g @resvg\/resvg-wasm/);
  });
  it("--png-engine only accepts 'none'", () => {
    const w = pluginWorld();
    expect(runCli([w.project, "--png-engine", "x"], { home: w.home, cwd: w.project }).status).toBe(1);
  });
});

describe("no tofu boxes: every glyph on every card is in the shipped fonts", () => {
  const cover = ["Inter-Regular.subset.ttf", "Inter-SemiBold.subset.ttf", "Inter-ExtraBold.subset.ttf"].map(fontCoverage);
  it("the fonts cover Basic Latin, Latin-1 and the punctuation the card uses", () => {
    for (const set of cover) {
      for (const c of [...Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => 0x20 + i), 0xb7, 0xd7, 0x2212, 0x2013, 0x2026, 0x2022]) expect(set.has(c), `U+${c.toString(16)}`).toBe(true);
    }
  });
  it("every character in every card text (all scenarios, sizes, themes, headlines) is covered, and toFontSafeText changes nothing", () => {
    const scenarios: Array<[string, Record<string, unknown>]> = [["realistic", {}], ["plugin-heavy", { agents: ["cursor"] }], ["mcp-catalog", {}], ["claude-agents-and-claude", {}], ["codex-32k-truncate", { agents: ["codex"] }]];
    let seen = 0;
    for (const [name, extra] of scenarios) {
      const m = materialize(name);
      const r = runScan(m, extra);
      for (const agent of r.agents.filter((a) => !a.presentInRepoOnly)) {
        for (const size of ["og", "square"] as const) {
          for (const headline of ["cut", "total"] as const) {
            let svg: string;
            try {
              svg = renderCard(r, agent, { theme: "dark", size, headline, fontFamily: PNG_FONT_FAMILY, charEm: PNG_CHAR_EM });
            } catch {
              continue; // nothing measurable for this agent
            }
            seen++;
            const text = [...svg.matchAll(/<text[^>]*>(.*?)<\/text>/g)].map((m) => m[1].replace(/<[^>]+>/g, "")).join("");
            for (const ch of new Set(text.replace(/&amp;|&lt;|&gt;|&quot;|&apos;/g, "&"))) expect(cover.every((s) => s.has(ch.codePointAt(0)!)), `U+${ch.codePointAt(0)!.toString(16)} (${ch})`).toBe(true);
            expect(toFontSafeText(svg)).toBe(svg);
          }
        }
      }
    }
    expect(seen).toBeGreaterThan(8);
  });
  it("toFontSafeText turns an uncovered character into '?' rather than a missing-glyph box", () => {
    expect(toFontSafeText("<text>a\u4e2d\u{1f600}b·−</text>")).toBe("<text>a??b·−</text>");
  });
});

describe("PNG layout: nothing is clipped or outside the card margins (measured by the renderer)", () => {
  it("content stays inside the margins for og/square x dark/light x cut/total, on the plugin fixture and a heavy world", async () => {
    const { Resvg } = await loadEngine();
    const worlds = [pluginWorld(), (() => {
      const w = world();
      put(w.project, { "CLAUDE.md": "word ".repeat(9000), "AGENTS.md": "x ".repeat(3000) });
      for (let i = 0; i < 40; i++) put(w.project, { [`.claude/rules/r${i}.md`]: "rule text ".repeat(80 + i * 30) });
      for (let i = 0; i < 60; i++) put(w.home, { [`.claude/skills/s${i}/SKILL.md`]: skillMd(`s${i}`, "A description of what the skill does and when to use it. ".repeat(3), "b") });
      put(w.project, { ".mcp.json": JSON.stringify({ mcpServers: { a: { command: "x" }, b: { command: "y" } } }) });
      return w;
    })()];
    const fonts = ["Inter-Regular.subset.ttf", "Inter-SemiBold.subset.ttf", "Inter-ExtraBold.subset.ttf"].map((f) => new Uint8Array(fs.readFileSync(path.join(FONT_DIR, f))));
    let n = 0;
    for (const w of worlds) {
      const r = scanWorld(w, { agents: w === worlds[0] ? ["cursor"] : ["claude-code"] });
      const a = pickCardAgent(r)!;
      for (const size of ["og", "square"] as const)
        for (const theme of ["dark", "light"] as const)
          for (const headline of ["cut", "total"] as const) {
            const svg = renderCard(r, a, { theme, size, headline, fontFamily: PNG_FONT_FAMILY, charEm: PNG_CHAR_EM });
            const W = size === "og" ? 1200 : 1080;
            const H = size === "og" ? 630 : 1080;
            const pad = size === "og" ? 48 : 56;
            // drop the full-canvas background rect so the bounding box is that of the content only
            const content = svg.replace(/<rect width="\d+" height="\d+" fill="#[0-9a-f]+"\/>\n/, "");
            const bb = new Resvg(content, { font: { fontBuffers: fonts, defaultFontFamily: "Inter" } }).getBBox()!;
            expect(bb.x, `${size}/${theme}/${headline} left`).toBeGreaterThanOrEqual(pad - 2);
            expect(bb.x + bb.width, `${size}/${theme}/${headline} right`).toBeLessThanOrEqual(W - pad + 2);
            expect(bb.y, `${size}/${theme}/${headline} top`).toBeGreaterThanOrEqual(0);
            expect(bb.y + bb.height, `${size}/${theme}/${headline} bottom`).toBeLessThanOrEqual(H - 8);
            n++;
          }
    }
    expect(n).toBe(16);
  });
});

describe("tagPng", () => {
  it("inserts valid tEXt chunks right after IHDR and keeps the image decodable", async () => {
    const w = pluginWorld();
    const r = scanWorld(w, { agents: ["cursor"] });
    const svg = renderCard(r, pickCardAgent(r)!, { theme: "dark", size: "og", fontFamily: PNG_FONT_FAMILY, charEm: PNG_CHAR_EM });
    const png = await svgToPng(svg, { scale: 1, version: "9.9.9" });
    const cs = chunks(png);
    expect(cs.map((c) => c.type).slice(0, 3)).toEqual(["IHDR", "tEXt", "tEXt"]);
    expect(cs[1].data.toString("latin1")).toBe("Software\0prehello 9.9.9");
    // tagging twice still gives a structurally valid file
    expect(() => chunks(tagPng(png, "1.0.0"))).not.toThrow();
  });
});

describe("golden SVG cards (plugin-heavy fixture, fixture data)", () => {
  const cases: Array<[string, { theme: "dark" | "light"; size: "og" | "square"; headline: "cut" | "total"; png?: boolean }]> = [
    ["cut-og-dark", { theme: "dark", size: "og", headline: "cut" }],
    ["total-og-dark", { theme: "dark", size: "og", headline: "total" }],
    ["cut-square-light", { theme: "light", size: "square", headline: "cut" }],
    ["cut-og-dark-pngfont", { theme: "dark", size: "og", headline: "cut", png: true }],
    ["cut-square-dark-pngfont", { theme: "dark", size: "square", headline: "cut", png: true }],
  ];
  for (const [name, o] of cases) {
    it(name, () => {
      const m = materialize("plugin-heavy");
      const r = runScan(m, { agents: ["cursor"] });
      const svg = renderCard(r, pickCardAgent(r, "cursor")!, { theme: o.theme, size: o.size, headline: o.headline, ...(o.png ? { fontFamily: PNG_FONT_FAMILY, charEm: PNG_CHAR_EM } : {}) });
      const g = golden(`card-plugin-heavy-${name}.svg`, svg);
      expect(g.ok, g.message).toBe(true);
    });
  }
});

describe("cut headline wording", () => {
  it("does not say 'top 1 of 1 groups': a single group reads 'all 1 group: cut it'", () => {
    const w = world();
    const root = path.join(w.home, ".cursor", "plugins", "cache", "mk", "solo", "abc");
    put(root, { ".cursor-plugin/plugin.json": JSON.stringify({ name: "solo" }) });
    for (let i = 0; i < 30; i++) put(root, { [`skills/s${i}/SKILL.md`]: skillMd(`s${i}`, "Use this skill when working with analytics, dashboards, experiments and feature flags in a product team.") });
    const r = scanWorld(w, { agents: ["cursor"] });
    const a = pickCardAgent(r, "cursor")!;
    const h = buildHeadline(a, 200_000)!;
    expect(h.id).toBe("cut-list");
    expect(h.sub).toMatch(/^all 1 group: cut it, save ~[\d.]+k? \(estimate\)$/);
  });
});
