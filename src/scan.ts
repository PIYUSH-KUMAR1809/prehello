import { realpathOrSelf } from "./fs-safe";
import { Ctx, ScanOptions } from "./context";
import { cmp } from "./util/fmt";
import { makeCounter } from "./tokens/counter";
import { AGENT_NAMES, ALL_AGENTS, AgentId, AgentReport, Report, SCHEMA_VERSION } from "./model";
import { detectClaude, discoverClaude } from "./adapters/claude-code";
import { detectCursor, discoverCursor } from "./adapters/cursor";
import { detectCodex, discoverCodex } from "./adapters/codex";
import { sumTotals } from "./analyze/totals";
import { crossFindings, rankFindings } from "./analyze/findings";
import { gradeAgent } from "./analyze/grade";
import { savingsOf } from "./analyze/savings";
import { coverageOf, mcpServersOf, offendersOf } from "./analyze/summary";
import { Detection, AdapterResult } from "./adapters/types";

export const VERSION = "0.1.0";

const ADAPTERS: Record<AgentId, { detect: (c: Ctx) => Detection; discover: (c: Ctx) => AdapterResult }> = {
  "claude-code": { detect: detectClaude, discover: discoverClaude },
  cursor: { detect: detectCursor, discover: discoverCursor },
  codex: { detect: detectCodex, discover: discoverCodex },
};

export const NOT_MEASURABLE = [
  "the agent's built-in system prompt and built-in tool definitions",
  "server-side / org rules, Cursor User & Team Rules, claude.ai connectors",
  "MCP servers whose tools are only known at runtime (no server is started by default)",
  "files outside the scanned locations; anything the agent injects dynamically (hooks, memory/RAG plugins)",
];

export function scan(input: ScanOptions & { noGrade?: boolean }): Report {
  // Canonicalise once: on case-insensitive filesystems (macOS APFS default, Windows) `~/Projects/Foo` and
  // `~/projects/foo` are the same directory, and every containment / ceiling / duplicate check below compares strings.
  const opts = { ...input, cwd: realpathOrSelf(input.cwd), home: realpathOrSelf(input.home), ceiling: input.ceiling ? realpathOrSelf(input.ceiling) : undefined };
  const counter = makeCounter(opts.tokenizer);
  const ctx = new Ctx(opts, counter);
  const forced = opts.agents && opts.agents.length ? opts.agents : undefined;
  const agents: AgentReport[] = [];

  for (const id of ALL_AGENTS) {
    if (forced && !forced.includes(id)) continue;
    const ad = ADAPTERS[id];
    const det = ad.detect(ctx);
    const inUse = !!forced || det.detectedBy.length > 0;
    const repoOnly = !inUse && det.repoFiles.length > 0;
    if (!inUse && !repoOnly) continue;
    const res = ad.discover(ctx);
    const rank = { always: 0, conditional: 1, deferred: 2, "on-demand": 3, unknown: 4 } as const;
    const items = [...res.items].sort((a, b) => rank[a.loadMode] - rank[b.loadMode] || (b.tokens?.est ?? -1) - (a.tokens?.est ?? -1) || cmp(a.label, b.label));
    const totals = sumTotals(items);
    const prof = ctx.profile(id);
    agents.push({
      id,
      name: AGENT_NAMES[id],
      detected: inUse,
      detectedBy: forced ? ["--agent"] : det.detectedBy,
      presentInRepoOnly: repoOnly,
      profile: { id: prof.id, label: prof.label, band: prof.band },
      items,
      totals,
      percentOfWindowAlways: totals.always.measuredItems ? (totals.always.est / opts.window) * 100 : null,
      unmeasuredBanner: res.unmeasuredBanner,
      grade: null,
      lowerBound: totals.always.unmeasuredItems > 0 || !!ctx.budgetHit,
      savings: totals.always.measuredItems ? savingsOf(items, totals.always.est, opts.window) : null,
      coverage: coverageOf(id, items),
      offenders: offendersOf(id, items),
      mcpServers: mcpServersOf(items),
    });
  }

  const budgetNote = ctx.budgetSummary();
  if (budgetNote) {
    ctx.warn(budgetNote);
    for (const a of agents) a.lowerBound = true;
  }
  crossFindings(ctx, agents);
  const visible = new Set(agents.filter((a) => !a.presentInRepoOnly).map((a) => a.id));
  const findings = rankFindings(ctx.findings.filter((f) => f.agent === "all" || visible.has(f.agent)));
  if (!opts.noGrade) {
    for (const a of agents) {
      if (a.presentInRepoOnly) continue;
      if (a.totals.always.measuredItems > 0) a.grade = gradeAgent(a, findings, opts.window);
      else a.gradeNote = a.totals.always.unmeasuredItems > 0 ? "no grade: everything that loads up front is unmeasured" : "no grade: nothing that loads up front was found";
    }
  }

  const epoch = opts.env.SOURCE_DATE_EPOCH;
  const when = epoch && /^\d+$/.test(epoch) ? new Date(parseInt(epoch, 10) * 1000) : opts.now;
  return {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: "prehello", version: VERSION },
    generatedAt: when.toISOString(),
    scan: { cwd: opts.cwd, window: opts.window, tokenizer: { method: counter.method, note: counter.note }, claudeProfile: opts.claudeProfile, ...(ctx.fixturesSkipped > 0 ? { fixturesSkipped: ctx.fixturesSkipped } : {}) },
    agents,
    excluded: ctx.excluded.filter((e) => e.agent === "all" || visible.has(e.agent)),
    findings,
    warnings: [...ctx.warnings],
    notMeasurable: NOT_MEASURABLE,
    ...(ctx.budgetHit ? { partial: { reason: ctx.budgetHit, filesNotRead: ctx.budgetSkipped } } : {}),
  };
}
