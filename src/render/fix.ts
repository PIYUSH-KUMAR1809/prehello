import { Report } from "../model";
import { fmtInt, sanitize } from "../util/fmt";

/** Dry-run plan. This function only formats text; there is no code path in 0.1 that modifies user files. */
export function renderFix(r: Report): string {
  const lines: string[] = [];
  const items = r.findings.filter((f) => f.fix);
  const total = items.reduce((s, f) => s + (f.savingsTokens ?? 0), 0);
  lines.push(`Fix plan (dry run): ${items.length} suggestion${items.length === 1 ? "" : "s"}${total ? `, ~${fmtInt(total)} always-on tokens could be saved (estimate)` : ""} · 0 files changed`);
  lines.push("");
  items.forEach((f, i) => {
    lines.push(` ${i + 1}. [${f.id}] ${sanitize(f.message, 200)}`);
    lines.push(`    suggestion: ${sanitize(f.fix ?? "", 240)}`);
    lines.push(`    savings: ${f.savingsTokens ? "~" + fmtInt(f.savingsTokens) + " tokens (estimate)" : "none measurable (clarity/correctness)"} · confidence: ${f.confidence}`);
  });
  if (!items.length) lines.push(" Nothing to suggest from the rules implemented in 0.1 (F1, F2, F4, F5, F7, F8, F9).");
  lines.push("");
  lines.push("Nothing was modified. prehello 0.1 has no --apply or --patch: changes are yours to make. Content-level rewrites are never auto-applied.");
  return lines.join("\n") + "\n";
}
