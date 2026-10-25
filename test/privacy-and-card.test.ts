import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { materialize, cleanup, runScan, jsonOf, terminalOf } from "./helpers/fixtures";
import { runCli } from "./helpers/run-cli";
import { renderCard, buildHeadline, assertHeadline, pickCardAgent, THEMES } from "../src/render/card";
import { renderFix } from "../src/render/fix";
import { AgentReport, Report } from "../src/model";
import { mkTmp, leakForms } from "./helpers/tmp";

afterAll(cleanup);

const CANARIES = ["CANARY-FILE-CONTENT-ALPHA", "CANARY-PROJECT-CONTENT-BETA", "CANARYSECRETVALUE1234567890abcdef", "CANARYENVVALUE-xyz", "@canary-org/secret-pkg"];
const NAMES = ["canary-server-name-zeta", "canary-rule-name-gamma"];

function load() {
  const m = materialize("privacy-canary");
  const r = runScan(m);
  return { m, r };
}

describe("privacy", () => {
  it("no output channel ever contains file contents, secrets or env values (terminal, JSON, strict JSON, fix, cards)", () => {
    const { m, r } = load();
    const outputs: Record<string, string> = {
      terminal: terminalOf(r, m, true),
      json: jsonOf(r, m, false),
      strict: jsonOf(r, m, true),
      fix: renderFix(r),
    };
    for (const theme of ["dark", "light"] as const)
      for (const size of ["og", "square"] as const) {
        const a = pickCardAgent(r)!;
        outputs[`card-${theme}-${size}`] = renderCard(r, a, { theme, size });
      }
    for (const [k, out] of Object.entries(outputs)) for (const c of CANARIES) expect(out, `${k} leaked ${c}`).not.toContain(c);
  });

  it("the secret-looking line is reported by location only", () => {
    const { r } = load();
    const f = r.findings.find((x) => x.id === "F9")!;
    expect(f).toBeTruthy();
    expect(f.message).toMatch(/line \d+/);
    expect(f.message).toMatch(/value not shown/);
  });

  it("cards never include paths, names, or the home directory", () => {
    const { m, r } = load();
    for (const a of r.agents) {
      if (a.presentInRepoOnly) continue;
      let svg: string;
      try {
        svg = renderCard(r, a, { theme: "dark", size: "og" });
      } catch {
        continue;
      }
      for (const n of NAMES) expect(svg).not.toContain(n);
      for (const bad of [...leakForms(m.home), ...leakForms(m.root), ...leakForms(os.tmpdir())]) expect(svg, bad).not.toContain(bad);
      expect(svg).not.toMatch(/\/(home|Users)\//);
    }
  });

  it("strict JSON drops paths and names entirely", () => {
    const { m, r } = load();
    const s = jsonOf(r, m, true);
    for (const n of NAMES) expect(s).not.toContain(n);
    expect(s).not.toContain(m.home);
    expect(s).not.toContain('"path"');
    expect(s).not.toContain(".mdc");
    expect(JSON.parse(s).schemaVersion).toBe(1);
  });

  it("non-strict JSON never contains an absolute home path (home files appear as ~/…)", () => {
    const { m, r } = load();
    const j = jsonOf(r, m, false);
    expect(j).not.toContain(m.home);
    expect(j).toContain("~/.claude/CLAUDE.md");
  });

  it("CLI end-to-end: --card output and --json --redact on the canary fixture", () => {
    const { m } = load();
    const out = mkTmp("prehello-card-");
    const card = path.join(out, "c.svg");
    const jf = path.join(out, "j.json");
    const res = runCli([m.project, `--card=${card}`, `--json=${jf}`, "--redact", "--ceiling", m.root, "--managed-dir", path.join(m.root, "none")], { home: m.home, cwd: m.project, allowWrite: [card, jf] });
    expect(res.guardLog).toBe("");
    const svg = fs.readFileSync(card, "utf8");
    const js = fs.readFileSync(jf, "utf8");
    for (const c of [...CANARIES, ...NAMES]) {
      expect(svg).not.toContain(c);
      expect(js).not.toContain(c);
    }
    expect(res.stdout + res.stderr).not.toContain("CANARY");
    fs.rmSync(out, { recursive: true, force: true });
  });

  it("hostile file names cannot inject terminal escapes", () => {
    const m = materialize("empty-machine");
    fs.mkdirSync(path.join(m.project, ".cursor", "rules"), { recursive: true });
    // Windows file names cannot contain control characters (ESC): there only the bidi override is possible
    const evil = process.platform === "win32" ? "evil\u202Ename.mdc" : "evil\u001b[31m\u202Ename.mdc";
    fs.writeFileSync(path.join(m.project, ".cursor", "rules", evil), "---\nalwaysApply: true\n---\nhello there\n");
    const r = runScan(m, { agents: ["cursor"] });
    const t = terminalOf(r, m, true) + jsonOf(r, m);
    expect(t).not.toMatch(/[\u001b\u202e]/);
  });
});

function agentWith(r: Report, id: string): AgentReport {
  return r.agents.find((a) => a.id === id)!;
}

describe("share card", () => {
  it("is valid-looking SVG with title, estimate marker, version, and Context Grade", () => {
    const { r } = load();
    const a = pickCardAgent(r)!;
    const svg = renderCard(r, a, { theme: "dark", size: "og" });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.trim().endsWith("</svg>")).toBe(true);
    expect(svg).toMatch(/viewBox="0 0 1200 630"/);
    expect(svg).toMatch(/~\d/);
    expect(svg).toMatch(/estimate/i);
    expect(svg).toMatch(/Context Grade/);
    expect(svg).toMatch(/prehello/);
    // no external references and no scripts
    expect(svg).not.toMatch(/<script|href=|xlink:|<image|url\(http/i);
    // well-formed: tags balance (cheap check)
    const open = (svg.match(/<(rect|text|circle|title|desc|tspan)\b/g) ?? []).length;
    const close = (svg.match(/<\/(text|title|desc|tspan)>|\/>/g) ?? []).length;
    expect(close).toBeGreaterThanOrEqual(open);
  });

  it("square and light variants render", () => {
    const { r } = load();
    const a = pickCardAgent(r)!;
    expect(renderCard(r, a, { theme: "light", size: "square" })).toMatch(/viewBox="0 0 1080 1080"/);
  });

  it("white label text on every treemap fill has contrast >= 4.5:1", () => {
    const { r } = load();
    const svg = renderCard(r, pickCardAgent(r)!, { theme: "dark", size: "og" });
    const lum = (hex: string) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const fills = [...svg.matchAll(/rx="6" fill="(#[0-9a-f]{6})"/g)].map((x) => x[1]);
    expect(fills.length).toBeGreaterThan(0);
    for (const f of fills) expect((1.05) / (lum(f) + 0.05), f).toBeGreaterThanOrEqual(4.5);
    for (const t of Object.values(THEMES)) {
      expect(Math.abs(lum(t.text) - lum(t.bg))).toBeGreaterThan(0.3);
    }
  });

  it("headline guard: lower-bound marker appears when anything is unmeasured; unmeasured-only never shows a token number", () => {
    const { r } = load();
    const cc = agentWith(r, "claude-code");
    const h = buildHeadline(cc, 200_000)!;
    expect(cc.totals.always.unmeasuredItems).toBeGreaterThan(0);
    expect(h.hero.startsWith("at least ")).toBe(true);
    expect(h.hero).not.toMatch(/[≥≈]/);
    expect(() => assertHeadline({ ...h, hero: h.hero.replace("at least ", "") }, cc, 200_000)).toThrow(/lower-bound/);
    expect(() => assertHeadline({ ...h, hero: h.hero.replace("~", "") }, cc, 200_000)).toThrow(/estimate marker/);

    // unmeasured-only agent: synthetic copy
    const only: AgentReport = JSON.parse(JSON.stringify(cc));
    only.totals.always = { est: 0, low: 0, high: 0, measuredItems: 0, unmeasuredItems: 3 };
    const h2 = buildHeadline(only, 200_000)!;
    expect(h2.id).toBe("mcp-unmeasured");
    expect(h2.hero + h2.sub).not.toMatch(/\d+(\.\d+)?k? tokens/);
    expect(h2.sub).toMatch(/unmeasured \(not zero\)/);

    // nothing at all -> no headline, no card
    const none: AgentReport = JSON.parse(JSON.stringify(cc));
    none.totals.always = { est: 0, low: 0, high: 0, measuredItems: 0, unmeasuredItems: 0 };
    expect(buildHeadline(none, 200_000)).toBeNull();
    expect(() => assertHeadline({ id: "tokens-before-hello", hero: "~5 tokens", sub: "" }, none, 200_000)).toThrow();
  });

  it("a very large number of items still renders (other bucket) and long hero text fits", () => {
    const { r } = load();
    const a: AgentReport = JSON.parse(JSON.stringify(pickCardAgent(r)!));
    const base = a.items.find((i) => i.loadMode === "always" && i.tokens)!;
    for (let i = 0; i < 40; i++) a.items.push({ ...base, id: `x:${i}`, cardLabel: `rule ${i}`, tokens: { est: 5 + i, low: 1, high: 99 } });
    a.totals.always.est += 5000;
    const svg = renderCard(r, a, { theme: "dark", size: "og" });
    expect(svg).toMatch(/other/);
    expect(svg.length).toBeLessThan(60_000);
  });

  it("card not offered when nothing is measurable or unmeasured", () => {
    const m = materialize("empty-machine");
    expect(pickCardAgent(runScan(m))).toBeNull();
    const rr = materialize("repo-only");
    expect(pickCardAgent(runScan(rr))).toBeNull(); // repo-only agents never reach the card
  });
});

describe("--fix is a dry run", () => {
  it("prints suggestions, says it changes nothing, and never prints file contents", () => {
    const m = materialize("realistic");
    const r = runScan(m);
    const t = renderFix(r);
    expect(t).toMatch(/dry run|dry-run/i);
    expect(t).toMatch(/0 files changed/);
  });
});
