import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter, asList } from "../src/text/frontmatter";
import { stripHtmlComments, splitFences } from "../src/text/comments";
import { expandImports } from "../src/text/imports";
import { makeCounter } from "../src/tokens/counter";
import { profileFor } from "../src/tokens/families";
import { squarify } from "../src/render/treemap";
import { fmtTok, fmtInt, fmtPct, parseWindow, sanitize, wrap, xmlEscape } from "../src/util/fmt";
import { findSecretLines, scrubSecrets, displayPath } from "../src/redact";
import { mkTmp } from "./helpers/tmp";

describe("frontmatter", () => {
  it("parses scalars, lists, booleans and block scalars", () => {
    const f = parseFrontmatter('---\ndescription: "Hello: world"\nalwaysApply: false\nglobs: ["src/**/*.ts", "*.md"]\npaths:\n  - a/**\n  - b/**\nnote: |\n  line1\n  line2\n---\nBODY\n');
    expect(f.hasFrontmatter).toBe(true);
    expect(f.data.description).toBe("Hello: world");
    expect(f.data.alwaysApply).toBe(false);
    expect(asList(f.data.globs)).toEqual(["src/**/*.ts", "*.md"]);
    expect(asList(f.data.paths)).toEqual(["a/**", "b/**"]);
    expect(f.data.note).toBe("line1\nline2");
    expect(f.body).toBe("BODY\n");
  });
  it("treats comma separated globs as a list", () => {
    expect(asList("a/**, b/**")).toEqual(["a/**", "b/**"]);
  });
  it("handles CRLF and absence of frontmatter", () => {
    expect(parseFrontmatter("---\r\nk: v\r\n---\r\nB").data.k).toBe("v");
    expect(parseFrontmatter("no front matter").hasFrontmatter).toBe(false);
    expect(parseFrontmatter("---\nunterminated\n").hasFrontmatter).toBe(false);
  });
});

describe("html comments", () => {
  it("strips comments outside fences only", () => {
    const t = "a <!-- gone --> b\n```\n<!-- kept -->\n```\nc <!--\nmulti\nline--> d";
    const s = stripHtmlComments(t);
    expect(s).not.toContain("gone");
    expect(s).not.toContain("multi");
    expect(s).toContain("<!-- kept -->");
    expect(s).toContain("a  b");
  });
  it("splits ~~~ and ``` fences", () => {
    const segs = splitFences("x\n~~~\ncode\n~~~\ny");
    expect(segs.map((s) => s.code)).toEqual([false, true, false]);
  });
});

describe("@import expansion", () => {
  const mk = () => {
    const d = mkTmp("prehello-imp-");
    return d;
  };
  const w = (f: string, t: string) => {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, t);
  };
  it("expands nested imports, ignores code spans, fences, emails and mentions", () => {
    const d = mk();
    w(path.join(d, "a.md"), "top @b.md and `@code.md` and me@example.com and @someone\n```\n@fenced.md\n```\n");
    w(path.join(d, "b.md"), "B text @sub/c.md");
    w(path.join(d, "sub", "c.md"), "C text");
    w(path.join(d, "code.md"), "SHOULD NOT LOAD");
    w(path.join(d, "fenced.md"), "SHOULD NOT LOAD");
    const r = expandImports(fs.readFileSync(path.join(d, "a.md"), "utf8"), path.join(d, "a.md"), d, () => true, { stripComments: true });
    expect(r.imported).toBe(2);
    expect(r.text).toContain("B text");
    expect(r.text).toContain("C text");
    expect(r.text).not.toContain("SHOULD NOT LOAD");
    fs.rmSync(d, { recursive: true, force: true });
  });
  it("is cycle-safe and depth-limited to 4 hops", () => {
    const d = mk();
    w(path.join(d, "a.md"), "@b.md");
    w(path.join(d, "b.md"), "@a.md @c.md");
    w(path.join(d, "c.md"), "@d.md");
    w(path.join(d, "d.md"), "@e.md");
    w(path.join(d, "e.md"), "@f.md");
    w(path.join(d, "f.md"), "@g.md");
    w(path.join(d, "g.md"), "END");
    const r = expandImports("@b.md", path.join(d, "a.md"), d, () => true, { stripComments: true });
    expect(r.imported).toBeLessThanOrEqual(5);
    expect(r.skipped.some((s) => s.reason === "depth>4")).toBe(true);
    expect(r.text).not.toContain("END");
    fs.rmSync(d, { recursive: true, force: true });
  });
  it("refuses imports outside the allowed roots", () => {
    const d = mk();
    w(path.join(d, "a.md"), "@../outside.md");
    w(path.join(path.dirname(d), "outside.md"), "OUTSIDE");
    const r = expandImports("@../outside.md", path.join(d, "a.md"), d, (p) => p.startsWith(d + path.sep), { stripComments: true });
    expect(r.text).not.toContain("OUTSIDE");
    expect(r.skipped[0]?.reason).toBe("outside allowed roots");
    fs.rmSync(d, { recursive: true, force: true });
    fs.rmSync(path.join(path.dirname(d), "outside.md"), { force: true });
  });
});

describe("token counting and bands", () => {
  const c = makeCounter("auto");
  it("uses the bundled o200k BPE", () => {
    expect(c.method).toBe("bpe-o200k");
    expect(c.count("")).toBe(0);
    expect(c.count("hello world")).toBe(2);
  });
  it("never throws on special-token text", () => {
    expect(c.count("<|endoftext|> <|im_start|>")).toBeGreaterThan(0);
  });
  it("heuristic counter is chars/3.5 for prose", () => {
    const h = makeCounter("heuristic");
    expect(h.count("a".repeat(350))).toBe(100);
  });
  it("profiles: bands bracket the estimate and unvalidated flags are honest", () => {
    for (const agent of ["claude-code", "cursor", "codex"] as const) {
      const p = profileFor(agent, "bpe-o200k", "current");
      const e = p.apply(1000);
      expect(e.low).toBeLessThanOrEqual(e.est);
      expect(e.high).toBeGreaterThanOrEqual(e.est);
    }
    expect(profileFor("claude-code", "bpe-o200k", "current").unvalidated).toBe(true);
    expect(profileFor("cursor", "bpe-o200k", "current").unvalidated).toBe(true);
    expect(profileFor("codex", "bpe-o200k", "current").apply(1000)).toEqual({ est: 1000, low: 970, high: 1030 });
    expect(profileFor("claude-code", "bpe-o200k", "current").apply(1000)).toEqual({ est: 1500, low: 1200, high: 1800 });
    expect(profileFor("claude-code", "bpe-o200k", "legacy").apply(1000).est).toBe(1200);
    expect(profileFor("claude-code", "heuristic", "current").band).toBe("±35%");
  });
});

describe("treemap", () => {
  it("tiles the area exactly with no overlaps", () => {
    const vals = [50, 30, 10, 5, 3, 2];
    const rects = squarify(vals, 10, 20, 400, 200);
    expect(rects).toHaveLength(vals.length);
    const area = rects.reduce((a, r) => a + r.w * r.h, 0);
    expect(area).toBeCloseTo(400 * 200, 3);
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(10 - 1e-6);
      expect(r.y).toBeGreaterThanOrEqual(20 - 1e-6);
      expect(r.x + r.w).toBeLessThanOrEqual(410 + 1e-6);
      expect(r.y + r.h).toBeLessThanOrEqual(220 + 1e-6);
    }
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        expect(ox > 1e-6 && oy > 1e-6).toBe(false);
      }
    // area proportional to value
    for (const r of rects) expect((r.w * r.h) / (400 * 200)).toBeCloseTo(vals[r.i] / 100, 3);
  });
  it("handles degenerate input", () => {
    expect(squarify([], 0, 0, 10, 10)).toEqual([]);
    expect(squarify([1], 0, 0, 10, 10)).toHaveLength(1);
    expect(squarify([1, 1], 0, 0, 0, 10)).toEqual([]);
  });
});

describe("formatting", () => {
  it("formats tokens, percentages, windows", () => {
    expect(fmtTok(950)).toBe("950");
    expect(fmtTok(12_400)).toMatch(/12\.4k|12k/);
    expect(fmtInt(1234567)).toBe("1,234,567");
    expect(fmtPct(0)).toBe("0%");
    expect(fmtPct(0.01)).toBe("< 0.1%");
    expect(parseWindow("200k")).toBe(200_000);
    expect(parseWindow("1m")).toBe(1_000_000);
    expect(parseWindow("128000")).toBe(128_000);
    expect(parseWindow("abc")).toBeNull();
    expect(parseWindow("0")).toBeNull();
  });
  it("sanitises control and bidi characters; escapes XML", () => {
    const s = sanitize("a\u001b[31mred\u202Eevil\n", 100);
    expect(s).not.toMatch(/[\u001b\u202E\n]/);
    expect(xmlEscape('<a href="x">&</a>')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });
  it("wraps without exceeding width (except for long words)", () => {
    const lines = wrap("one two three four five six seven eight nine ten", 20, "> ", "  ");
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(20);
    expect(lines[0].startsWith("> ")).toBe(true);
  });
});

describe("redaction", () => {
  it("flags secret-looking lines by number without returning content", () => {
    const text = "fine\nAPI_KEY=sk-abcdefghijklmnopqrstuvwxyz123456\nok\nghp_abcdefghijklmnopqrstuvwxyz0123456789\n-----BEGIN PRIVATE KEY-----\n";
    expect(findSecretLines(text)).toEqual([2, 4, 5]);
  });
  it("scrubs secrets from strings", () => {
    expect(scrubSecrets("token ghp_abcdefghijklmnopqrstuvwxyz0123456789 here")).not.toContain("ghp_abcdef");
  });
  it("displays ./ and ~/ paths and never the absolute home", () => {
    const c = { cwd: "/home/u/proj", home: "/home/u" };
    expect(displayPath("/home/u/proj/CLAUDE.md", c)).toBe("./CLAUDE.md");
    expect(displayPath("/home/u/.claude/CLAUDE.md", c)).toBe("~/.claude/CLAUDE.md");
    expect(displayPath("/etc/x/CLAUDE.md", c)).not.toContain("/home/u");
  });
});
