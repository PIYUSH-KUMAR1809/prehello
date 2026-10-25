/**
 * SARIF 2.1.0 report (--sarif): for GitHub code scanning, VS Code's SARIF viewer and other IDE / CI tools.
 *
 * Privacy by construction (same contract as the card and the Markdown report):
 *  - No file contents, no finding or warning TEXTS (those name user-level paths); every message is built here from numbers and generic words.
 *  - A physicalLocation is emitted ONLY for a file inside the scanned project folder, as a relative URI against %SRCROOT%. Never an absolute
 *    path, never a home or user-config path (~/.claude, ~/.cursor, ...), never a path that looks like it holds a secret or has control characters.
 *    User-level items (user, managed, plugin, built-in) get a logicalLocation with a generic label ("User CLAUDE.md") and no file location.
 *  - `strict` (--redact): no physical locations at all, generic labels only. `anonymize`: plugin / MCP server names become "plugin 1" / "MCP server 1".
 *  - Token numbers are ESTIMATES (`isEstimate: true`), an unmeasured item never carries a number (never 0), and a total that is a lower bound says "at least".
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { AgentReport, Finding, Report } from "../model";
import { cardTiles, cutCandidatesWithSource } from "../analyze/savings";
import { AT_LEAST } from "./card";
import { cmp, fmtPct, fmtTok, fmtWindow, sanitize } from "../util/fmt";
import { numberedLabels } from "./json";
import { realpathOrSelf } from "../fs-safe";
import { scrubSecrets } from "../redact";

export const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";
export const SRCROOT = "%SRCROOT%";

/** An always-on file is reported (PH001) from this size on, or from 1% of the window. */
export const LARGE_ITEM_TOKENS = 2000;
/** A plugin / skills folder / MCP server is reported (PH002) from this size on. */
export const HEAVY_GROUP_TOKENS = 1000;
/** Warning instead of note from this share of the window (one item or group). */
export const WARN_WINDOW_PCT = 5;
const MAX_GROUPS_PER_AGENT = 10;

export type SarifLevel = "note" | "warning";

export interface SarifOpts {
  /** plugin / MCP server names -> "plugin 1" / "MCP server 1" */
  anonymize: boolean;
  /** --redact: no file locations at all, generic labels only */
  strict: boolean;
  /** --max-tokens, for PH003 */
  maxTokens?: number;
  cwd: string;
  home: string;
}

interface RuleDef {
  id: string;
  name: string;
  level: SarifLevel;
  short: string;
  full: string;
  help: string;
  precision: "medium" | "low";
}

export const RULES: RuleDef[] = [
  {
    id: "PH001",
    name: "LargeAlwaysOnFile",
    level: "note",
    short: "A file that loads before the first message is large",
    full: "An instruction, rule or memory file that the coding agent loads into context before the first message costs a lot of tokens. The count is an estimate (o200k BPE with a per-agent scaling prior).",
    help: "Trim the file, split rarely needed material into scoped rules or skills, or move reference text out of always-loaded files. Token counts are estimates with an error band, not exact for any model.",
    precision: "medium",
  },
  {
    id: "PH002",
    name: "HeavyAlwaysOnGroup",
    level: "note",
    short: "A plugin, skills folder or MCP server costs many tokens before the first message",
    full: "The listing of a plugin's skills, a skills folder or an MCP server's tool definitions is part of the always-on context. This is what `prehello --fix` calls the cut list. The count is an estimate.",
    help: "If you do not use it, disable or remove the plugin, skills folder or MCP server in the agent's own settings. prehello never edits agent configuration. The saving is an estimate, not a promise.",
    precision: "medium",
  },
  {
    id: "PH003",
    name: "OverTokenBudget",
    level: "warning",
    short: "Always-on context is above the --max-tokens budget",
    full: "The estimated always-on token count of an agent in use is above the budget given with --max-tokens. When some always-on items could not be measured, the total is a lower bound (at least).",
    help: "Cut the biggest contributors (see PH001 and PH002), or raise the budget if the size is intentional. This result only exists when --max-tokens is given; the same condition makes prehello exit with code 2.",
    precision: "medium",
  },
  {
    id: "PH004",
    name: "UnmeasuredAlwaysOnItems",
    level: "note",
    short: "Some always-loaded items could not be measured",
    full: "Some items that load before the first message (typically MCP servers whose tools are only known at runtime) have no token count. Their cost is unknown, not zero, so every always-on total for this agent is a lower bound.",
    help: "No action is required. Treat the totals as 'at least'. You can supply measured weights with --mcp-catalog.",
    precision: "low",
  },
  {
    id: "PH005",
    name: "DuplicateContextFiles",
    level: "warning",
    short: "Two context files are near-duplicates",
    full: "Two files that agents load share most of their text (60% or more). If one agent loads both, the text is paid for twice.",
    help: "Keep one copy. Claude Code @imports do not reduce cost. If different agents read the two files, do not delete either; make one the source of truth (for example a CLAUDE.md that only contains @AGENTS.md, or a symlink).",
    precision: "medium",
  },
  {
    id: "PH006",
    name: "LongInstructionFile",
    level: "note",
    short: "An always-loaded file is longer than the documented guideline",
    full: "The file is longer than the length the agent's documentation recommends (Claude Code: 200 lines for CLAUDE.md, Cursor: 500 lines per rule). Longer files can reduce how well the agent follows them.",
    help: "Split the file into scoped rules or move reference material out of the always-loaded file.",
    precision: "medium",
  },
  {
    id: "PH007",
    name: "SilentTruncation",
    level: "warning",
    short: "Part of a context file is silently dropped by the agent",
    full: "The agent cuts this content off at a documented limit (Codex 32 KiB project docs, Claude Code MEMORY.md 200 lines / 25 KB, the skill description cap), so the tail never reaches the model.",
    help: "Shorten the file or the description, and put the important parts first.",
    precision: "medium",
  },
  {
    id: "PH008",
    name: "IgnoredContextFile",
    level: "warning",
    short: "A context file is ignored by the agent",
    full: "The agent does not load this file (for example AGENTS.md next to a CLAUDE.md for Claude Code, or a .md file in .cursor/rules for Cursor). Other agents may still read it.",
    help: "Rename or restructure the file if you intend the agent to use it, or delete it if it is stale.",
    precision: "medium",
  },
  {
    id: "PH009",
    name: "PossibleSecretInContextFile",
    level: "warning",
    short: "A context file contains something that looks like a secret",
    full: "A line of this file matches a secret pattern (cloud keys, tokens, private key headers, key=value credentials). The value is never printed or stored by prehello. Agents send context files to a model provider.",
    help: "Remove the secret from the file and rotate it. This is a pattern match and can be a false positive.",
    precision: "low",
  },
  {
    id: "PH010",
    name: "SkillsListingOverBudget",
    level: "note",
    short: "A skills listing is above the agent's listing budget",
    full: "The skills listing is estimated to be larger than the share of the window the agent reserves for it, so the agent shortens or drops descriptions of the least used skills.",
    help: "Remove skills you do not use, or switch rarely used skills to name-only where the agent supports it.",
    precision: "low",
  },
  {
    id: "PH011",
    name: "IncompleteScan",
    level: "note",
    short: "Some sources could not be read or the scan hit its budget",
    full: "Some files were unreadable, too large, binary or skipped, or the scan stopped at its byte or time budget. Every total is then a lower bound.",
    help: "Run prehello locally to see which sources were skipped, or raise --scan-budget-mb / --scan-budget-ms.",
    precision: "low",
  },
];
const RULE_INDEX = new Map(RULES.map((r, i) => [r.id, i]));

/** Finding id -> rule. F5 (unmeasured) is reported per agent as PH004 from the coverage numbers instead. */
const FINDING_RULE: Record<string, string> = { F1: "PH006", F2: "PH005", F4: "PH007", F8: "PH007", F12: "PH007", F7: "PH008", F11: "PH008", F9: "PH009", F13: "PH010" };

const ZERO_WIDTH = /[\u200b-\u200f\u2028\u2029\u2060\ufeff]/g;

/** A user-controlled name inside SARIF message text: no control / bidi characters, no secrets, `[ ] \` escaped (SARIF reads `[text](n)` as a link). */
export function sarifText(s: string, max = 80): string {
  const t = sanitize(s.replace(/[\r\n\t\v\f]+/g, " "), 400).replace(ZERO_WIDTH, "").replace(/\s+/g, " ").trim();
  const cut = t.length > max ? t.slice(0, max - 3) + "..." : t;
  return (cut || "(unnamed)").replace(/[\\[\]]/g, (c) => "\\" + c);
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

interface Loc {
  /** project-relative, forward slashes, percent-encoded */
  uri: string;
  /** the same, decoded and sanitised, for message text */
  shown: string;
  line: number;
}

interface Rec {
  rule: string;
  key: string;
  level: SarifLevel;
  agents: string[];
  loc?: Loc;
  related?: Loc;
  logical?: { name: string; fq: string };
  /** rule-specific numbers / words used to build the message and the properties bag */
  d: Record<string, unknown>;
  props: Record<string, unknown>;
  /** fingerprint seed that does not change when only the numbers change */
  fp: string;
}

function isHomeOrAncestor(cwd: string, home: string): boolean {
  const rel = path.relative(cwd, home);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function insideRel(base: string, p: string): string | null {
  const rel = path.relative(base, p);
  if (rel === "" || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return null;
  return rel;
}

/** Everything that turns SARIF input into output. Exported for tests. */
export function toSarif(r: Report, o: SarifOpts): Record<string, unknown> {
  const cwd = realpathOrSelf(o.cwd);
  const home = realpathOrSelf(o.home);
  const shown = r.agents.filter((a) => !a.presentInRepoOnly);
  const noFiles = o.strict || isHomeOrAncestor(cwd, home);
  // user-level, managed, plugin and built-in items never get a file location, even if a path looks like it is inside the project
  const userLevel = new Set<string>();
  for (const a of r.agents) for (const it of a.items) if (!["project", "local", "nested"].includes(it.scope)) userLevel.add(it.path);

  function locate(p: string, line = 1): Loc | undefined {
    if (noFiles || userLevel.has(p)) return undefined;
    const rel = insideRel(cwd, p);
    if (rel === null) return undefined;
    const real = insideRel(cwd, realpathOrSelf(p));
    if (real === null) return undefined; // a symlink pointing out of the project
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(rel) || scrubSecrets(rel) !== rel) return undefined;
    const segs = rel.split(path.sep);
    return { uri: segs.map((s) => encodeURIComponent(s)).join("/"), shown: sarifText(segs.join("/"), 120), line: Math.max(1, Math.floor(line)) };
  }

  const recs = new Map<string, Rec>();
  const add = (x: Rec): void => {
    const cur = recs.get(x.key);
    if (!cur) {
      recs.set(x.key, x);
      return;
    }
    for (const a of x.agents) if (!cur.agents.includes(a)) cur.agents.push(a);
    if (x.level === "warning") cur.level = "warning";
    // merged agents: keep the biggest numbers; per-agent numbers stay in `props.perAgent`
    const pa = (cur.props.perAgent as unknown[] | undefined) ?? [];
    cur.props.perAgent = [...pa, ...((x.props.perAgent as unknown[] | undefined) ?? [])];
  };
  const levelFor = (tokens: number, window: number): SarifLevel => ((tokens / window) * 100 >= WARN_WINDOW_PCT ? "warning" : "note");
  const W = r.scan.window;
  const est = (t: { est: number; low: number; high: number }) => ({ estimateTokens: t.est, lowTokens: t.low, highTokens: t.high, isEstimate: true as const });

  for (const a of shown) {
    const labels = numberedLabels(a);
    // PH001: big always-on single items
    for (const it of a.items) {
      if (it.loadMode !== "always" || !it.tokens || it.kind === "skills-listing" || it.kind === "mcp-server") continue;
      if (it.tokens.est < LARGE_ITEM_TOKENS && (it.tokens.est / W) * 100 < 1) continue;
      const loc = locate(it.path);
      const label = sarifText(labels.get(it.id) ?? it.cardLabel);
      add({
        rule: "PH001",
        key: loc ? `PH001|${loc.uri}` : `PH001|${a.id}|${label}`,
        level: levelFor(it.tokens.est, W),
        agents: [a.name],
        loc,
        logical: loc ? undefined : { name: label, fq: `${a.id}/${label}` },
        d: { label },
        props: { perAgent: [{ agent: a.id, kind: it.kind, scope: it.scope, loadMode: it.loadMode, ...est(it.tokens), percentOfWindow: round1((it.tokens.est / W) * 100), tokens: it.tokens.est }] },
        fp: loc ? loc.uri : `${a.id}/${label}`,
      });
    }

    // PH002: heavy removable groups (same groups, order and names as the card and the cut list)
    const cands = cutCandidatesWithSource(a.items);
    const tiles = cardTiles(a.items, o.anonymize);
    const byCut = new Map(tiles.filter((t) => t.cut !== undefined).map((t) => [t.cut!, t]));
    let emitted = 0;
    cands.forEach((c, i) => {
      if (c.tokens < HEAVY_GROUP_TOKENS || emitted >= MAX_GROUPS_PER_AGENT) return;
      emitted++;
      const t = byCut.get(i);
      const name = sarifText(t ? t.label : c.label);
      const loc = c.kind === "mcp" ? locate(c.source.path) : undefined;
      add({
        rule: "PH002",
        key: `PH002|${a.id}|${c.kind}|${name}|${loc?.uri ?? ""}`,
        level: levelFor(c.tokens, W),
        agents: [a.name],
        loc,
        logical: { name, fq: `${a.id}/${name}` },
        d: { name, kind: c.kind, count: c.count },
        props: { perAgent: [{ agent: a.id, kind: c.kind === "mcp" ? "mcp-server" : "skills", scope: c.source.scope, estimateTokens: c.tokens, isEstimate: true, skills: c.kind === "skills" ? c.count : undefined, percentOfWindow: round1((c.tokens / W) * 100), tokens: c.tokens }] },
        fp: `${a.id}/${c.kind}/${name}`,
      });
    });

    // PH003: --max-tokens
    if (o.maxTokens !== undefined && a.totals.always.est > o.maxTokens) {
      add({
        rule: "PH003",
        key: `PH003|${a.id}`,
        level: "warning",
        agents: [a.name],
        logical: { name: a.name, fq: a.id },
        d: { est: a.totals.always.est, max: o.maxTokens, lower: a.lowerBound },
        props: { perAgent: [{ agent: a.id, ...est(a.totals.always), isLowerBound: a.lowerBound, maxTokens: o.maxTokens, tokens: a.totals.always.est }] },
        fp: a.id,
      });
    }

    // PH004: unmeasured always-on items (counts and kinds only)
    const un = a.totals.always.unmeasuredItems;
    if (un > 0) {
      add({
        rule: "PH004",
        key: `PH004|${a.id}`,
        level: "note",
        agents: [a.name],
        logical: { name: a.name, fq: a.id },
        d: { n: un, kinds: a.coverage.unmeasuredKinds, est: a.totals.always.est, measured: a.totals.always.measuredItems },
        props: { perAgent: [{ agent: a.id, unmeasuredItems: un, unmeasuredKinds: a.coverage.unmeasuredKinds, measuredItems: a.totals.always.measuredItems, alwaysTokensAtLeast: a.totals.always.measuredItems ? a.totals.always.est : null, isLowerBound: true }] },
        fp: a.id,
      });
    }
  }

  // findings -> PH005..PH010 (messages rebuilt from structured data; the finding's own text names user-level paths)
  const visibleAgents = new Set(shown.map((a) => a.id));
  const nameOf = (f: Finding): string[] => (f.agent === "all" ? shown.map((a) => a.name) : [shown.find((a) => a.id === f.agent)?.name ?? String(f.agent)]);
  r.findings.forEach((f, fi) => {
    const rule = FINDING_RULE[f.id];
    if (!rule || (f.agent !== "all" && !visibleAgents.has(f.agent))) return;
    if (f.data?.omittedPairs) return; // a "N more not listed" summary has no file; the count goes into the run properties
    const lvl: SarifLevel = RULES[RULE_INDEX.get(rule)!].level;
    const agents = f.id === "F2" || f.id === "F9" ? [] : nameOf(f);
    const first = f.paths[0] ? locate(f.paths[0], f.data?.lines?.[0] ?? 1) : undefined;
    const second = f.id === "F2" && f.paths[1] ? locate(f.paths[1]) : undefined;
    const primary = first ?? second;
    const other = first && second ? second : undefined;
    const outside = f.id === "F2" ? f.paths.length - [first, second].filter(Boolean).length : 0;
    const gen = f.agent === "all" ? "agents" : agents[0];
    add({
      rule,
      key: primary ? `${rule}|${f.id}|${primary.uri}${other ? "|" + other.uri : ""}` : `${rule}|${f.id}|${f.agent}|#${fi}`,
      level: lvl,
      agents,
      loc: primary,
      related: other,
      logical: primary ? undefined : { name: f.agent === "all" ? "context files" : agents[0], fq: `${f.agent}/${f.id}` },
      d: { fid: f.id, gen, outside, ...f.data, secretLines: f.data?.lines },
      props: { findingId: f.id, confidence: f.confidence, ...(f.savingsTokens !== undefined ? { savingsTokensEstimate: f.savingsTokens, savingsIsEstimate: true } : {}), ...(f.data?.lines ? { lines: f.data.lines } : {}), ...(f.data?.similarityPct !== undefined ? { similarityPercent: f.data.similarityPct } : {}), ...(f.data?.fileLines !== undefined ? { fileLines: f.data.fileLines, guidelineLines: f.data.guidelineLines } : {}) },
      fp: `${f.id}/${primary?.uri ?? `${f.agent}#${fi}`}/${other?.uri ?? ""}`,
    });
  });

  // PH011: partial / unreadable sources
  if (r.partial || r.warnings.length) {
    add({
      rule: "PH011",
      key: "PH011",
      level: "note",
      agents: [],
      logical: { name: "scan", fq: "scan" },
      d: {},
      props: { warnings: r.warnings.length, ...(r.partial ? { budget: r.partial.reason, filesNotRead: r.partial.filesNotRead } : {}) },
      fp: "scan",
    });
  }

  const results = [...recs.values()].map((x) => finalize(x, r, o)).sort((a, b) => cmp(a.ruleId, b.ruleId) || cmp(a.sortKey, b.sortKey)).map(({ sortKey: _s, ...res }) => res);

  return {
    $schema: SARIF_SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "prehello",
            version: r.tool.version,
            semanticVersion: r.tool.version,
            shortDescription: { text: "Shows what a coding agent loads into context before the first message. Token counts are estimates." },
            rules: RULES.map((d) => ({
              id: d.id,
              name: d.name,
              shortDescription: { text: d.short },
              fullDescription: { text: d.full },
              help: { text: `${d.help}\nSee the SARIF section of the prehello README for the rule list.`, markdown: `${d.help}\n\nSee the SARIF section of the prehello README for the rule list.` },
              defaultConfiguration: { level: d.level },
              properties: { tags: ["context", "tokens", "coding-agents"], precision: d.precision },
            })),
          },
        },
        columnKind: "utf16CodeUnits",
        originalUriBaseIds: { [SRCROOT]: { description: { text: "The scanned project folder. Run prehello from the repository root so these paths match the repository." } } },
        automationDetails: { id: "prehello/" },
        invocations: [{ executionSuccessful: true, endTimeUtc: r.generatedAt, properties: { partial: !!r.partial } }],
        results,
        properties: runProps(r, shown, o, noFiles),
      },
    ],
  };
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

function runProps(r: Report, shown: AgentReport[], o: SarifOpts, noFiles: boolean): Record<string, unknown> {
  return {
    prehello: {
      note: "All token numbers are estimates (o200k BPE with per-agent scaling priors), not exact for any model. An unmeasured item has no number, never 0. A total marked isLowerBound is 'at least'.",
      tokenizer: r.scan.tokenizer.method,
      claudeProfile: r.scan.claudeProfile,
      windowTokens: r.scan.window,
      redacted: o.strict,
      namesAnonymized: o.anonymize,
      fileLocations: !noFiles,
      partial: r.partial ?? null,
      ...(r.scan.fixturesSkipped ? { fixtureFoldersSkipped: r.scan.fixturesSkipped } : {}),
      duplicatePairsNotListed: r.findings.reduce((n, f) => n + (f.data?.omittedPairs ?? 0), 0),
      agents: shown.map((a) => ({
        id: a.id,
        profile: a.profile.id,
        band: a.profile.band,
        always: { ...{ estimateTokens: a.totals.always.measuredItems ? a.totals.always.est : null, lowTokens: a.totals.always.measuredItems ? a.totals.always.low : null, highTokens: a.totals.always.measuredItems ? a.totals.always.high : null }, isEstimate: true, isLowerBound: a.lowerBound, measuredItems: a.totals.always.measuredItems, unmeasuredItems: a.totals.always.unmeasuredItems },
        percentOfWindow: a.percentOfWindowAlways === null ? null : round1(a.percentOfWindowAlways),
        grade: a.grade ? { letter: a.grade.letter, provisional: a.grade.provisional, heuristic: true } : null,
        savings: a.savings ? { topGroups: a.savings.n, estimateTokens: a.savings.topTokens, isEstimate: true } : null,
      })),
    },
  };
}

function agentList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "the agent";
  return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}

function finalize(x: Rec, r: Report, o: SarifOpts): { ruleId: string; ruleIndex: number; level: SarifLevel; message: { text: string }; locations: unknown[]; relatedLocations?: unknown[]; partialFingerprints: Record<string, string>; properties: Record<string, unknown>; sortKey: string } {
  const W = r.scan.window;
  const per = (x.props.perAgent as Array<Record<string, number>> | undefined) ?? [];
  const names = x.agents;
  const d = x.d;
  const fid = d.fid as string | undefined;
  let text = "";
  const sum = (k: string) => per.map((p) => p[k]).filter((v) => typeof v === "number");
  switch (x.rule) {
    case "PH001": {
      const parts = per.map((p, i) => `${names[i] ?? "the agent"} ~${fmtTok(p.estimateTokens)}`);
      const pct = Math.max(...sum("percentOfWindow"));
      text = `This file is always loaded before the first message (${agentList(parts)} tokens, estimate; up to ${fmtPct(pct)} of a ${fmtWindow(W)} window).${x.loc ? "" : ` Item: ${d.label}.`}`;
      break;
    }
    case "PH002": {
      const p = per[0];
      const cnt = d.kind === "skills" && (d.count as number) > 1 ? ` (${plural(d.count as number, "skill")})` : "";
      text = `"${d.name}"${cnt} adds ~${fmtTok(p.estimateTokens)} tokens before the first message in ${names[0]} (estimate; ${fmtPct((p.estimateTokens / W) * 100)} of a ${fmtWindow(W)} window). Removing it would save about that much.`;
      break;
    }
    case "PH003":
      text = `${names[0]}: always-on context is ${d.lower ? AT_LEAST + " " : ""}~${fmtTok(d.est as number)} tokens (estimate), above --max-tokens ${fmtTok(d.max as number)}.${d.lower ? " Some items are unmeasured, so the real number is higher." : ""}`;
      break;
    case "PH004": {
      const KIND_WORDS: Record<string, [string, string]> = { "mcp-server": ["MCP server", "MCP servers"], instructions: ["instruction file", "instruction files"], rule: ["rule", "rules"], memory: ["memory file", "memory files"] };
      const kinds = Object.entries(d.kinds as Record<string, number>).map(([k, n]) => `${n} ${(KIND_WORDS[k] ?? [k, k])[n === 1 ? 0 : 1]}`).join(", ");
      text = `${names[0]}: ${plural(d.n as number, "always-loaded item")} could not be measured (${kinds}). ${(d.n as number) === 1 ? "Its" : "Their"} token cost is unknown, not zero, so the always-on total${d.measured ? ` of ${AT_LEAST} ~${fmtTok(d.est as number)} tokens (estimate)` : ""} is a lower bound.`;
      break;
    }
    case "PH005": {
      const rel = x.related ? ` The other file: [${x.related.shown}](1).` : x.loc && (d.outside as number) > 0 ? " The other file is outside the project, so it is not shown." : "";
      const where = x.loc ? "This file is" : "Two context files are";
      text = `${where} about ${d.similarityPct}% the same text (estimated from shared 5-word sequences).${rel} Keep one copy, or make one the source of truth.`;
      break;
    }
    case "PH006":
      text = `This file is ${d.fileLines} lines, over the documented guideline of ${d.guidelineLines} for ${agentList(names)}; longer files can reduce adherence.`;
      break;
    case "PH007":
      text = fid === "F8" ? `MEMORY.md is over the load cap (200 lines / 25 KB) for ${agentList(names)}; the rest is silently dropped.` : fid === "F12" ? `${agentList(names)} cuts this file off at project_doc_max_bytes; only the first part is loaded.` : `A skill description is over the length cap for ${agentList(names)}; its tail is dropped from the skills listing.`;
      break;
    case "PH008":
      text = fid === "F11" ? `${agentList(names)} ignores this file: only .mdc files in .cursor/rules are loaded.` : `${agentList(names)} ignores this file: a CLAUDE.md exists in the directory tree and takes precedence. Other agents may still load it.`;
      break;
    case "PH009": {
      const ls = (d.secretLines as number[] | undefined) ?? [];
      text = `Possible secret on line${ls.length > 1 ? "s" : ""} ${ls.slice(0, 5).join(", ")}${ls.length > 5 ? ", ..." : ""} (value not shown; pattern match, may be a false positive). Agents send this file to a model provider: remove the secret and rotate it.`;
      break;
    }
    case "PH010":
      text = `The skills listing for ${agentList(names)} is estimated above its listing budget; descriptions of rarely used skills are shortened or dropped.`;
      break;
    default:
      text = `Some sources could not be read or were skipped${r.partial ? `, or the scan hit its ${r.partial.reason} budget` : ""}. Every total is a lower bound.`;
  }
  const loc = x.loc;
  const locations: unknown[] = [];
  if (loc) locations.push({ physicalLocation: { artifactLocation: { uri: loc.uri, uriBaseId: SRCROOT }, region: { startLine: loc.line } } });
  else if (x.logical) locations.push({ logicalLocations: [{ name: x.logical.name, fullyQualifiedName: x.logical.fq, kind: "module" }] });
  const props: Record<string, unknown> = { ...x.props };
  if (per.length) props.perAgent = per.map((p) => Object.fromEntries(Object.entries(p).filter(([k, v]) => v !== undefined && k !== "tokens")));
  if (names.length) props.agents = names;
  props.anonymized = o.anonymize || o.strict;
  const hash = createHash("sha256").update(`${x.rule}|${x.fp}`).digest("hex").slice(0, 32);
  const ri = RULE_INDEX.get(x.rule)!;
  const sortKey = `${loc?.uri ?? ""}|${x.logical?.fq ?? ""}|${String(1e9 - Math.max(0, ...per.map((p) => p.tokens ?? 0))).padStart(10, "0")}|${text}`;
  return {
    ruleId: x.rule,
    ruleIndex: ri,
    level: x.level,
    message: { text },
    locations,
    ...(x.related ? { relatedLocations: [{ id: 1, physicalLocation: { artifactLocation: { uri: x.related.uri, uriBaseId: SRCROOT }, region: { startLine: x.related.line } }, message: { text: "The other near-duplicate file" } }] } : {}),
    partialFingerprints: { "prehello/v1": hash },
    properties: props,
    sortKey,
  };
}

export function renderSarif(r: Report, o: SarifOpts): string {
  return JSON.stringify(toSarif(r, o), null, 2) + "\n";
}
