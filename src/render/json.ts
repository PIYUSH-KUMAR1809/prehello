import { AgentReport, Item, Report } from "../model";
import { displayPath, scrubSecrets } from "../redact";

export interface JsonCtx {
  cwd: string;
  home: string;
}

function numberedLabels(agent: AgentReport, only?: Item[]): Map<string, string> {
  const list = only ?? agent.items;
  // privacy-safe labels: cardLabel, numbered when repeated ("MCP server 2")
  const totals = new Map<string, number>();
  for (const it of list) totals.set(it.cardLabel, (totals.get(it.cardLabel) ?? 0) + 1);
  const seen = new Map<string, number>();
  const out = new Map<string, string>();
  for (const it of list) {
    const n = (seen.get(it.cardLabel) ?? 0) + 1;
    seen.set(it.cardLabel, n);
    out.set(it.id, (totals.get(it.cardLabel) ?? 1) > 1 ? `${it.cardLabel} ${n}` : it.cardLabel);
  }
  return out;
}

/** Serialise the Report. NEVER includes file contents. `strict` drops paths/names entirely (use before sharing). */
/** Defence in depth: user-controlled names (skill `name:`, MCP server keys, …) must never carry a secret-shaped string into JSON. */
function scrubDeep<T>(v: T): T {
  if (typeof v === "string") return scrubSecrets(v) as unknown as T;
  if (Array.isArray(v)) return v.map(scrubDeep) as unknown as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [scrubSecrets(k), scrubDeep(x)])) as T;
  return v;
}

export function toJson(r: Report, c: JsonCtx, strict: boolean): unknown {
  return scrubDeep(toJsonRaw(r, c, strict));
}

function toJsonRaw(r: Report, c: JsonCtx, strict: boolean): unknown {
  const dp = (p: string) => displayPath(p, c);
  return {
    schemaVersion: r.schemaVersion,
    tool: r.tool,
    generatedAt: r.generatedAt,
    redacted: strict ? "strict" : "paths-shortened (~ and ./ prefixes); server and file names kept",
    scan: { ...r.scan, cwd: strict ? "project" : dp(r.scan.cwd) },
    agents: r.agents.map((a) => {
      const labels = numberedLabels(a);
      return {
        id: a.id,
        name: a.name,
        detected: a.detected,
        detectedBy: a.detectedBy,
        presentInRepoOnly: a.presentInRepoOnly,
        profile: a.profile,
        totals: a.totals,
        percentOfWindowAlways: a.percentOfWindowAlways,
        alwaysIsLowerBound: a.lowerBound,
        savings: a.savings
          ? {
              ...a.savings,
              top: a.savings.top.map((c, i) => (strict ? { label: `group ${i + 1}`, kind: c.kind, tokens: c.tokens, count: c.count } : c)),
              note: "estimate: what removing these groups would save; not a promise",
            }
          : null,
        grade: a.grade,
        ...(a.gradeNote ? { gradeNote: a.gradeNote } : {}),
        coverage: a.coverage,
        installedButNothingFound: a.items.length === 0 && !a.presentInRepoOnly,
        offenders: a.offenders.map((x) => (strict ? { kind: x.kind, loadMode: x.loadMode, tokens: x.tokens } : { label: x.label, path: dp(x.path), kind: x.kind, loadMode: x.loadMode, tokens: x.tokens, ...(x.note ? { note: x.note } : {}) })),
        mcpServers: a.mcpServers.map((m, i) => (strict ? { n: i + 1, transport: m.transport, scope: m.scope, measured: m.measured } : { name: m.name, source: dp(m.source), scope: m.scope, transport: m.transport, measured: m.measured })),
        unmeasuredBanner: a.unmeasuredBanner,
        items: a.items.map((it: Item) => ({
          id: it.id,
          kind: it.kind,
          scope: it.scope,
          loadMode: it.loadMode,
          label: strict ? labels.get(it.id) : it.label,
          ...(strict ? {} : { path: dp(it.path) }),
          tokens: it.tokens,
          unmeasured: it.tokens === null,
          ...(it.unmeasuredReason ? { unmeasuredReason: it.unmeasuredReason } : {}),
          chars: it.chars,
          lines: it.lines,
          ...(it.breakdown && !strict ? { breakdown: it.breakdown } : {}),
          ...(it.parts && !strict ? { parts: it.parts } : {}),
          confidence: it.confidence,
          evidence: it.evidence,
          notes: strict ? it.notes.filter((n) => !/["'`\/\\@]/.test(n) && !/\bplugin\b/i.test(n)) : it.notes,
        })),
      };
    }),
    excluded: strict ? r.excluded.map((e) => ({ agent: e.agent, reason: e.reason.replace(/"[^"]*"/g, '"…"') })) : r.excluded.map((e) => ({ agent: e.agent, path: dp(e.path), reason: e.reason })),
    findings: r.findings.map((f) =>
      strict
        ? { id: f.id, severity: f.severity, agent: f.agent, savingsTokens: f.savingsTokens, confidence: f.confidence, fileCount: f.paths.length }
        : { id: f.id, severity: f.severity, agent: f.agent, message: f.message, paths: f.paths.map(dp), savingsTokens: f.savingsTokens, confidence: f.confidence, fix: f.fix },
    ),
    warnings: strict ? r.warnings.length : r.warnings,
    notMeasurable: r.notMeasurable,
    partial: r.partial ?? null,
  };
}

export { numberedLabels };
