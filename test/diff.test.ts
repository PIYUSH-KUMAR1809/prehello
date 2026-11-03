import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { diffSnapshots, parseSnapshot, renderDiffMarkdown, renderDiffTerminal, signedTok, badgeJson, DiffInputError, DIFF_MARKER, Snapshot } from "../src/diff";
import { looksLikePrehelloOutput, MD_MARKER_PREFIX } from "../src/safe-write";
import { runCli } from "./helpers/run-cli";
import { mkTmp } from "./helpers/tmp";

const t = (est: number) => ({ est, low: est, high: est, measuredItems: 1, unmeasuredItems: 0 });
const snap = (agents: Array<{ id: string; always: number; items: Array<[string, number]> }>, version = "0.1.0"): Snapshot => ({
  schemaVersion: 1,
  tool: { name: "prehello", version },
  scan: { tokenizer: { method: "bpe-o200k" } },
  agents: agents.map((a) => ({
    id: a.id,
    name: a.id === "claude-code" ? "Claude Code" : a.id,
    detected: true,
    totals: { always: t(a.always), deferred: t(0) },
    items: a.items.map(([p, n]) => ({ kind: "instructions", loadMode: "always", path: p, tokens: { est: n, low: n, high: n } })),
  })),
});

describe("diffSnapshots", () => {
  it("per-agent delta, added/removed/changed items, sorted by size", () => {
    const d = diffSnapshots(
      snap([{ id: "claude-code", always: 1000, items: [["./CLAUDE.md", 900], ["./old.md", 100]] }]),
      snap([{ id: "claude-code", always: 2300, items: [["./CLAUDE.md", 2000], ["./new.md", 300]] }]),
    );
    const a = d.agents[0];
    expect(a.delta).toBe(1300);
    expect(a.deltaPct).toBe(130);
    expect(a.changes.map((c) => [c.label, c.delta])).toEqual([["./CLAUDE.md", 1100], ["./new.md", 300], ["./old.md", -100]]);
    expect(renderDiffTerminal(d)).toContain("Claude Code: +1.3k tokens before hello (~1k → ~2.3k, +130%)");
  });
  it("new and vanished agents; unchanged items are not listed", () => {
    const d = diffSnapshots(snap([{ id: "cursor", always: 50, items: [["./a", 50]] }]), snap([{ id: "claude-code", always: 10, items: [["./b", 10]] }]));
    const txt = renderDiffTerminal(d);
    expect(txt).toMatch(/Claude Code: new, ~10 tokens/);
    expect(txt).toMatch(/cursor: no longer detected \(was ~50/);
    const same = diffSnapshots(snap([{ id: "cursor", always: 50, items: [["./a", 50]] }]), snap([{ id: "cursor", always: 50, items: [["./a", 50]] }]));
    expect(same.agents[0].changes).toEqual([]);
    expect(renderDiffMarkdown(same)).toMatch(/No change in always-on context/);
  });
  it("caps the item list at 10 and says how many more", () => {
    const items: Array<[string, number]> = Array.from({ length: 14 }, (_, i) => [`./f${i}.md`, i + 1]);
    const d = diffSnapshots(snap([{ id: "cursor", always: 0, items: [] }]), snap([{ id: "cursor", always: 105, items }]));
    expect(d.agents[0].changes.length).toBe(10);
    expect(d.agents[0].moreChanges).toBe(4);
    expect(renderDiffMarkdown(d)).toMatch(/… 4 more/);
  });
  it("Markdown: sticky marker first, hostile names stay inert", () => {
    const evil = "./x|y`<img src=x onerror=1>@org/team #12 ](http://evil)";
    const d = diffSnapshots(snap([{ id: "cursor", always: 0, items: [] }]), snap([{ id: "cursor", always: 5, items: [[evil, 5]] }]));
    const md = renderDiffMarkdown(d, { threshold: 1 });
    expect(md.startsWith(DIFF_MARKER)).toBe(true);
    expect(DIFF_MARKER.startsWith(MD_MARKER_PREFIX)).toBe(true);
    const row = md.split("\n").find((l) => l.includes("onerror"))!;
    expect(row).toMatch(/``.*x\\\|y`<img.*``/); // inside a code span, pipe escaped
    expect(md).toMatch(/Over the limit/);
  });
  it("notes version and tokenizer differences", () => {
    const b = snap([{ id: "cursor", always: 1, items: [] }], "0.1.0");
    const h = snap([{ id: "cursor", always: 1, items: [] }], "1.0.0");
    h.scan = { tokenizer: { method: "heuristic" } };
    const n = diffSnapshots(b, h).notes.join(" ");
    expect(n).toMatch(/different tokenizers/);
    expect(n).toMatch(/different prehello versions/);
  });
  it("signedTok and parse errors", () => {
    expect(signedTok(0)).toBe("±0");
    expect(signedTok(1234)).toBe("+1.2k");
    expect(signedTok(-40)).toBe("−40");
    expect(() => parseSnapshot("nope", "a.json")).toThrow(DiffInputError);
    expect(() => parseSnapshot('{"tool":{"name":"other"}}', "a.json")).toThrow(/not a prehello report/);
  });
});

describe("badge", () => {
  it("is a shields endpoint object that safeWrite recognises as ours", () => {
    const b = JSON.stringify(badgeJson("Cursor", 5200, false));
    expect(JSON.parse(b)).toEqual({ schemaVersion: 1, label: "context before hello", message: "~5.2k tokens (Cursor)", color: "green" });
    expect(looksLikePrehelloOutput(b, "badge")).toBe(true);
    expect(looksLikePrehelloOutput('{"schemaVersion":1,"label":"build"}', "badge")).toBe(false);
    expect((badgeJson("x", null, false) as { color: string }).color).toBe("lightgrey");
    expect((badgeJson("x", 70000, true) as { message: string }).message).toMatch(/^≥70k/);
  });
});

describe("CLI: --save, --badge, diff", () => {
  const world = () => {
    const home = mkTmp("prehello-diff-home-");
    const proj = mkTmp("prehello-diff-proj-");
    fs.mkdirSync(path.join(proj, ".git"));
    fs.writeFileSync(path.join(proj, "CLAUDE.md"), "Use pnpm.\n");
    return { home, proj };
  };
  it("save, change, save, diff: terminal, markdown file, json, fail-above exit 2", () => {
    const { home, proj } = world();
    const b = path.join(home, "b.json"), h = path.join(home, "h.json"), md = path.join(home, "c.md"), badge = path.join(home, "badge.json");
    const w = [b, h, md, badge];
    let r = runCli([proj, "--agent", "claude-code", "--quiet", "--save", b, "--badge", badge], { home, allowWrite: w });
    expect(r.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(badge, "utf8")).label).toBe("context before hello");
    // second badge write over our own file works without --force
    expect(runCli([proj, "--agent", "claude-code", "--quiet", "--badge", badge], { home, allowWrite: w }).status).toBe(0);
    fs.writeFileSync(path.join(proj, "CLAUDE.md"), "Use pnpm.\n" + "Keep functions small and test everything you change.\n".repeat(100));
    expect(runCli([proj, "--agent", "claude-code", "--quiet", "--save", h], { home, allowWrite: w }).status).toBe(0);
    r = runCli(["diff", b, h], { home });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Claude Code: \+1\.\dk tokens before hello/);
    r = runCli(["diff", b, h, "--markdown=" + md, "--fail-above", "1k"], { home, allowWrite: w });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/above --fail-above 1k/);
    expect(fs.readFileSync(md, "utf8").startsWith(DIFF_MARKER)).toBe(true);
    // rewriting our own Markdown is allowed
    expect(runCli(["diff", b, h, "--markdown=" + md], { home, allowWrite: w }).status).toBe(0);
    r = runCli(["diff", b, h, "--json", "--fail-above", "5k"], { home });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).overThreshold).toEqual([]);
  });
  it("errors", () => {
    const { home, proj } = world();
    const junk = path.join(home, "junk.json");
    fs.writeFileSync(junk, '{"a":1}');
    expect(runCli(["diff", junk], { home }).stderr).toMatch(/usage: prehello diff/);
    expect(runCli(["diff", junk, junk], { home }).stderr).toMatch(/not a prehello report/);
    expect(runCli(["diff", junk, path.join(home, "missing.json")], { home }).stderr).toMatch(/cannot read|not a prehello/);
    expect(runCli(["diff", junk, junk, "--fail-above", "lots"], { home }).stderr).toMatch(/token count/);
    expect(runCli([proj, "--fail-above", "1k"], { home }).stderr).toMatch(/belongs to 'prehello diff'/);
    // --save refuses to overwrite a file that is not prehello output
    const other = path.join(home, "notes.json");
    fs.writeFileSync(other, '{"mine":true}');
    const r = runCli([proj, "--quiet", "--save", other], { home, allowWrite: [other] });
    expect(r.status).toBe(1);
    expect(fs.readFileSync(other, "utf8")).toBe('{"mine":true}');
  });
});

describe("badge on a machine with no agent installed (CI)", () => {
  it("uses the repository's biggest agent", () => {
    const home = mkTmp("prehello-badge-home-");
    const proj = mkTmp("prehello-badge-proj-");
    fs.mkdirSync(path.join(proj, ".git"));
    fs.writeFileSync(path.join(proj, "AGENTS.md"), "Rules for agents.\n".repeat(20));
    const badge = path.join(home, "badge.json");
    expect(runCli([proj, "--quiet", "--badge", badge], { home, allowWrite: [badge] }).status).toBe(0);
    expect(JSON.parse(fs.readFileSync(badge, "utf8")).message).toMatch(/^~\d+ tokens \(/);
  });
});
