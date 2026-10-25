/**
 * Markdown report: a shareable summary to paste into a GitHub issue / PR / README / Slack, or to save as a file.
 *
 * Privacy by construction (same contract as the share card): no file paths, no file contents, no findings text, no warnings text.
 * Only these things reach the output: generic labels ("rule file 2"), counts, numbers, the version and a date, and the NAMES of
 * plugins / MCP servers / skill folders (replaced by "plugin 1" / "MCP server 1" with `anonymize`). Every name goes through
 * mdCode(): control characters and bidi marks are stripped, secrets are scrubbed, the name is placed in an inline code span (so
 * Markdown, HTML, links, @mentions and #123 references inside it are inert) and pipes are escaped for tables.
 * The text prehello writes itself is ASCII only, so it survives any console code page or redirect.
 */
import { AgentReport, Report } from "../model";
import { AT_LEAST, assertHeadline, buildHeadline, pickCardAgent } from "./card";
import { cardTiles } from "../analyze/savings";
import { kinds } from "./terminal";
import { fmtPct, fmtTok, fmtWindow, sanitize } from "../util/fmt";

export interface MarkdownOpts {
  /** Replace plugin / MCP server / skill-folder names with "plugin 1" / "MCP server 1" ... */
  anonymize: boolean;
  /** A short paste-in-a-PR-comment version: headline, one line per agent, the cut list. No tables. */
  compact: boolean;
  headline: "cut" | "total";
}

const MAX_NAME = 60;
const ZERO_WIDTH = /[\u200b-\u200f\u2028\u2029\u2060\ufeff]/g;

/** A user-controlled name as an inline code span. Never throws, never returns an empty span, safe inside a table cell when `table`. */
export function mdCode(name: string, table = false): string {
  let t = sanitize(name.replace(/[\r\n\t\v\f]+/g, " "), 400).replace(ZERO_WIDTH, "").replace(/\s+/g, " ").trim();
  if (t.length > MAX_NAME) t = t.slice(0, MAX_NAME - 3) + "...";
  if (!t) t = "(unnamed)";
  if (table) t = t.replace(/\|/g, "\\|");
  const longest = Math.max(0, ...(t.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(longest + 1);
  const pad = /^`|`$/.test(t) ? " " : "";
  return `${fence}${pad}${t}${pad}${fence}`;
}

/** One-line note (a count, no paths) when fixture folders holding agent files were skipped; null otherwise. */
export function fixtureNote(r: Report): string | null {
  const n = r.scan.fixturesSkipped;
  return n ? `Skipped ${n} fixture folder${n > 1 ? "s" : ""} with agent files (use --include-fixtures to count them).` : null;
}

const ascii = (s: string) => s.replace(/±/g, "+/-").replace(/−/g, "-");
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

function alwaysSentence(a: AgentReport, window: number): string {
  const t = a.totals.always;
  if (!t.measuredItems) return t.unmeasuredItems ? `${plural(t.unmeasuredItems, "always-loaded item")} could not be measured: token cost unknown (not zero).` : "nothing that loads up front was found (this is not a score of 0; the agent still has its own system prompt and tools).";
  const lb = a.lowerBound ? `${AT_LEAST} ` : "";
  const pct = (t.est / window) * 100;
  const share = pct < 0.1 ? (a.lowerBound ? "under 0.1% so far" : "under 0.1%") : `${a.lowerBound ? AT_LEAST + " " : "about "}${fmtPct(pct)}`;
  return `${lb}~${fmtTok(t.est)} tokens always on, ${share} of a ${fmtWindow(window)} window (range ~${fmtTok(t.low)}-${fmtTok(t.high)}).`;
}

function gradeLine(a: AgentReport): string | undefined {
  const g = a.grade;
  if (!g) return a.gradeNote ? `Context Grade: none (${ascii(sanitize(a.gradeNote, 200)).replace(/^no grade: /, "")}).` : undefined;
  const why = g.provisional ? ` (provisional${g.cappedAt ? `, capped at ${g.cappedAt}` : ""}: some always-loaded items are unmeasured${a.totals.always.unmeasuredItems ? "" : " or the scan hit its budget"})` : "";
  return `Context Grade: **${g.letter}**${why}. A heuristic, not a standard.`;
}

function unmeasuredList(a: AgentReport, o: MarkdownOpts): string {
  const names = a.mcpServers.filter((m) => !m.measured).map((m) => m.name);
  if (!names.length) return "";
  if (o.anonymize) return ` (${plural(names.length, "MCP server")}, names hidden)`;
  return ` (${names.slice(0, 6).map((n) => mdCode(n)).join(", ")}${names.length > 6 ? `, +${names.length - 6} more` : ""})`;
}

function agentSection(r: Report, a: AgentReport, o: MarkdownOpts): string[] {
  const out: string[] = [`### ${a.name}`, ""];
  const lead = alwaysSentence(a, r.scan.window);
  out.push(lead.charAt(0).toUpperCase() + lead.slice(1));
  const gl = gradeLine(a);
  if (gl) out.push("", gl);
  const t = a.totals.always;
  const tiles = cardTiles(a.items, o.anonymize);
  const unmeasuredServers = a.mcpServers.filter((m) => !m.measured);

  if (tiles.length || unmeasuredServers.length) {
    out.push("", "| What loads before hello | ~Tokens | Share of measured |", "|---|--:|--:|");
    const total = tiles.reduce((s, x) => s + x.tokens, 0) || 1;
    const MAX = 10;
    for (const x of tiles.slice(0, MAX)) out.push(`| ${x.named ? mdCode(x.label, true) : x.label} | ~${fmtTok(x.tokens)} | ${fmtPct((x.tokens / total) * 100)} |`);
    if (tiles.length > MAX) {
      const rest = tiles.slice(MAX).reduce((s, x) => s + x.tokens, 0);
      out.push(`| ${tiles.length - MAX} smaller groups | ~${fmtTok(rest)} | ${fmtPct((rest / total) * 100)} |`);
    }
    unmeasuredServers.slice(0, 8).forEach((m, i) => out.push(`| ${o.anonymize ? `unmeasured MCP server ${i + 1}` : `MCP server ${mdCode(m.name, true)}`} | not measured | - |`));
    if (unmeasuredServers.length > 8) out.push(`| ${unmeasuredServers.length - 8} more unmeasured MCP servers | not measured | - |`);
    if (a.lowerBound) out.push("", `The total is a lower bound: items marked "not measured" are not counted, and are never shown as 0.`);
  }

  if (a.savings) {
    const sv = a.savings;
    out.push("", `**What to cut** (estimates, not a promise): removing the top ${sv.n === 1 ? "group" : sv.n + " groups"} would save ~${fmtTok(sv.topTokens)} tokens (${fmtPct(sv.pctOfWindow)} of a ${fmtWindow(r.scan.window)} window).`, "");
    const byCut = new Map(tiles.filter((x) => x.cut !== undefined).map((x) => [x.cut!, x]));
    sv.top.forEach((c, i) => {
      const x = byCut.get(i);
      const label = x ? (x.named ? mdCode(x.label) : x.label) : "group";
      const cnt = c.kind === "skills" && c.count > 1 && c.label.startsWith("plugin ") ? `, ${c.count} skills` : "";
      out.push(`${i + 1}. ${label}: ~${fmtTok(c.tokens)} (${fmtPct((c.tokens / (t.est || 1)) * 100)} of always-on${cnt})`);
    });
  }

  const c = a.coverage;
  const totalAlways = c.alwaysMeasuredItems + c.alwaysUnmeasuredItems;
  if (!totalAlways) return [...out, ""];
  out.push("", "**Measured vs not measured** (always-on items)", "");
  {
    out.push(`- Measured ${c.alwaysMeasuredItems} of ${totalAlways}${c.alwaysFraction !== null ? ` (${Math.round(c.alwaysFraction * 100)}%)` : ""}${c.alwaysMeasuredItems ? `: ${kinds(c.measuredKinds)}` : ""}`);
    if (c.alwaysUnmeasuredItems) out.push(`- NOT measured: ${kinds(c.unmeasuredKinds)}${c.unmeasuredKinds["mcp-server"] ? unmeasuredList(a, o) : ""}. No token count; never shown as 0.`);
  }
  const other = (["deferred", "conditional", "on-demand"] as const).filter((m) => a.totals[m].measuredItems);
  if (other.length) out.push(`- Not always on: ${other.map((m) => `${m} ~${fmtTok(a.totals[m].est)}`).join(", ")} (loaded only when triggered or invoked)`);
  const nf = r.findings.filter((f) => f.agent === a.id).length;
  if (nf) out.push(`- ${plural(nf, "finding")} (duplicates, over-long or ignored files): details name files, so they are left out of this report. Run prehello locally to see them.`);
  out.push("");
  return out;
}

/** The headline sentence of the report (top agent), with the same guards as the card. */
function headlineOf(r: Report, o: MarkdownOpts): { agent: AgentReport; hero: string; sub: string; id: string } | null {
  const agent = pickCardAgent(r);
  if (!agent) return null;
  const h = buildHeadline(agent, r.scan.window, o.headline) ?? buildHeadline(agent, r.scan.window, "total");
  if (!h) return null;
  assertHeadline(h, agent, r.scan.window);
  return { agent, hero: h.hero, sub: h.sub, id: h.id };
}

function footer(r: Report, shown: AgentReport[]): string {
  const unvalidated = shown.some((a) => a.profile.id.startsWith("claude") || a.profile.id === "cursor-mixed" || a.profile.id === "heuristic");
  const bands = [...new Set(shown.filter((a) => a.totals.always.measuredItems).map((a) => `${a.name} ${ascii(a.profile.band)}`))];
  return `_Generated by prehello ${r.tool.version} on ${r.generatedAt.slice(0, 10)}. Local-only scan: no paths or file contents are included. All token counts are estimates (${r.scan.tokenizer.method === "bpe-o200k" ? "o200k BPE with per-agent scaling priors" : "chars/3.5 heuristic"}${bands.length ? "; band " + bands.join(", ") : ""}${unvalidated ? ", unvalidated" : ""}), not exact for any model. Window ${fmtWindow(r.scan.window)}.${r.partial ? " PARTIAL scan: every total is a lower bound." : ""}_`;
}

export function renderMarkdown(r: Report, o: MarkdownOpts): string {
  const shown = r.agents.filter((a) => !a.presentInRepoOnly);
  const out: string[] = ["## prehello report: what your coding agent loads before you say hello", ""];
  const repoOnly = r.agents.filter((a) => a.presentInRepoOnly).map((a) => a.name);

  if (!shown.length) {
    out.push("No coding agent was detected on this machine, so nothing was measured. This is not a score of 0.", "");
    if (repoOnly.length) out.push(`Agent files for ${repoOnly.join(" and ")} exist in the repo, but the agent is not installed here, so they are not counted.`, "");
    out.push(footer(r, shown));
    return out.join("\n") + "\n";
  }

  const head = headlineOf(r, o);
  if (head) {
    // cut headline: "top 3 of 6 groups: cut them, save ~13.2k (estimate)" -> "Claude Code: top 3 of 6 groups - cut them, save ~13.2k (estimate)."
    const sub = head.sub.replace(/ · /g, ", ");
    const parts = sub.split(", ");
    const line = head.id === "cut-list" ? `${head.agent.name}: ${sub.replace(": ", " - ")}` : (sub.includes(" window") ? `${sub.charAt(0).toUpperCase()}${sub.slice(1, sub.indexOf(" window") + 7)} (${parts.slice(-2).join(", ")})` : `${sub.charAt(0).toUpperCase()}${sub.slice(1)}`);
    out.push(`**${head.hero.charAt(0).toUpperCase()}${head.hero.slice(1)}**`, "", `${line}.`, "");
  } else out.push("Nothing measurable loads before hello for the detected agents. This is not a score of 0: absence of data is never shown as 0.", "");

  if (o.compact) {
    for (const a of shown) {
      const t = a.totals.always;
      const g = a.grade ? `, grade ${a.grade.letter}${a.grade.provisional ? " (provisional)" : ""}` : "";
      out.push(`- **${a.name}**: ${t.measuredItems ? `${a.lowerBound ? AT_LEAST + " " : ""}~${fmtTok(t.est)} tokens always on (${a.lowerBound ? AT_LEAST + " " : ""}${fmtPct((t.est / r.scan.window) * 100)} of ${fmtWindow(r.scan.window)})` : t.unmeasuredItems ? "tokens unmeasured (not zero)" : "nothing found up front"}${g}`);
    }
    const cut = pickCardAgent(r)?.savings;
    const top = pickCardAgent(r);
    if (cut && top) {
      const tiles = cardTiles(top.items, o.anonymize).filter((x) => x.cut !== undefined && x.cut < cut.n);
      out.push("", `Cut first (${top.name}, estimates): ${tiles.map((x) => `${x.named ? mdCode(x.label) : x.label} ~${fmtTok(x.tokens)}`).join(", ")}`);
    }
    const fxc = fixtureNote(r);
    if (fxc) out.push("", fxc);
    out.push("", footer(r, shown));
    return out.join("\n") + "\n";
  }

  for (const a of shown) out.push(...agentSection(r, a, o));
  if (repoOnly.length) out.push(`Agent files for ${repoOnly.join(" and ")} exist in the repo, but the agent is not installed here, so they are not counted.`, "");
  const shared = r.findings.filter((f) => f.agent === "all").length;
  if (shared) out.push(`${plural(shared, "finding")} apply to more than one agent (duplicate or conflicting files); details name files, so they are left out of this report.`, "");
  if (r.warnings.length || r.partial) out.push(`**Partial results:** some sources could not be read or were skipped (or the scan hit its budget), so every total is a lower bound. Run prehello locally for details.`, "");
  const fx = fixtureNote(r);
  if (fx) out.push(fx, "");
  out.push(footer(r, shown));
  return out.join("\n") + "\n";
}
