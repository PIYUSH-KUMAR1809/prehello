import { Ctx, jaccard } from "../context";
import { AgentId, AgentReport, AGENT_NAMES, Finding } from "../model";
import { cmp } from "../util/fmt";

const MAX_DUP_DOCS = 300;
const MAX_DUP_PAIRS = 20;

/** Cross-document findings (F2 duplicates) and MCP lower-bound notes (F5). */
export function crossFindings(ctx: Ctx, agents: AgentReport[]): void {
  // Bounded on purpose: comparing every pair is quadratic, and 200 copies of one rule file are 19,900 "duplicate" pairs.
  // Compare the biggest MAX_DUP_DOCS files, list the MAX_DUP_PAIRS most similar pairs, and say how many were left out.
  const all = [...ctx.docs.values()].filter((d) => d.tokens >= 200 && d.shingles.size > 0).sort((x, y) => y.tokens - x.tokens || cmp(x.path, y.path));
  const docs = all.slice(0, MAX_DUP_DOCS);
  if (all.length > docs.length) ctx.warn(`duplicate check compared only the ${MAX_DUP_DOCS} largest of ${all.length} context files`);
  const pairs: Array<{ a: (typeof docs)[number]; b: (typeof docs)[number]; sim: number; common: AgentId[]; savings?: number }> = [];
  for (let i = 0; i < docs.length; i++) {
    for (let j = i + 1; j < docs.length; j++) {
      const a = docs[i];
      const b = docs[j];
      const sim = jaccard(a.shingles, b.shingles);
      if (sim < 0.6) continue;
      const common = [...a.agents].filter((x) => b.agents.has(x));
      let savings: number | undefined;
      if (common.length) {
        const smaller = Math.min(a.tokens, b.tokens);
        savings = Math.round(ctx.profile(common[0]).apply(smaller).est * sim);
      }
      pairs.push({ a, b, sim, common, savings });
    }
  }
  pairs.sort((x, y) => y.sim - x.sim || (y.savings ?? 0) - (x.savings ?? 0) || cmp(x.a.path, y.a.path) || cmp(x.b.path, y.b.path));
  for (const { a, b, sim, common, savings } of pairs.slice(0, MAX_DUP_PAIRS)) {
    ctx.addFinding({
      id: "F2",
      severity: "warn",
      agent: common[0] ?? "all",
      message: `${ctx.display(a.path)} and ${ctx.display(b.path)} are ~${Math.round(sim * 100)}% duplicate text${common.length ? "" : " (loaded by different agents)"}`,
      paths: [a.path, b.path],
      savingsTokens: savings,
      confidence: sim >= 0.9 ? "high" : "medium",
      data: { similarityPct: Math.round(sim * 100) },
      fix: common.length
        ? "Keep one copy. Claude Code @imports do not reduce cost, so delete the duplicate rather than importing it."
        : "Different agents read these files, so do not delete either. To stop them drifting apart, make one the source of truth (for example, a CLAUDE.md that contains just `@AGENTS.md`, or a symlink). This saves no tokens.",
    });
  }
  if (pairs.length > MAX_DUP_PAIRS) {
    ctx.addFinding({
      id: "F2",
      severity: "info",
      agent: "all",
      message: `${pairs.length - MAX_DUP_PAIRS} more near-duplicate pairs are not listed (the ${MAX_DUP_PAIRS} most similar are shown)`,
      paths: [],
      confidence: "high",
      data: { omittedPairs: pairs.length - MAX_DUP_PAIRS },
    });
  }
  for (const ag of agents) {
    const n = ag.totals.always.unmeasuredItems;
    const unm = ag.items.filter((i) => i.loadMode === "always" && i.tokens === null);
    const what = unm.every((i) => i.kind === "mcp-server") ? "MCP servers" : unm.some((i) => i.kind === "mcp-server") ? "MCP servers and unreadable files" : "files that could not be read";
    if (n > 0 && !ag.presentInRepoOnly) {
      ctx.addFinding({
        id: "F5",
        severity: "info",
        agent: ag.id,
        message: `${AGENT_NAMES[ag.id]}: ${n} always-loaded item${n > 1 ? "s are" : " is"} unmeasured (${what}); the always-on total is a lower bound ("at least")`,
        paths: [],
        confidence: "needs-your-call",
        fix: unm.some((i) => i.kind === "mcp-server") ? "If a server is unused, disable or remove it in the agent's own settings. prehello never edits MCP configs." : undefined,
      });
    }
  }
}

export function rankFindings(fs: Finding[]): Finding[] {
  const sev = { warn: 0, info: 1 } as const;
  return [...fs].sort((a, b) => (b.savingsTokens ?? 0) - (a.savingsTokens ?? 0) || sev[a.severity] - sev[b.severity] || cmp(a.id, b.id) || cmp(a.message, b.message));
}
