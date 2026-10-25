import { AgentReport, Finding, Grade } from "../model";

export const RUBRIC = [
  "Start at 100 points per agent. Rubric uses only documented guidelines; it is a heuristic, not an industry standard.",
  "Always-on tokens as a share of the window (estimate): ≥20% −45 · ≥10% −30 · ≥5% −15 · ≥2% −5",
  "Each always-on instruction file over its documented guideline (Claude Code 200 lines, Cursor rules 500 lines): −5, max −15",
  "Each place content is silently truncated (Codex 32 KiB cap, MEMORY.md 200 lines/25 KB, skill description cap): −5, max −15",
  "Each file the agent ignores (e.g. AGENTS.md under CLAUDE.md precedence, .md in .cursor/rules): −3, max −9",
  "Each near-duplicate file pair (≥60% shared text): −5, max −10",
  "Letters: A ≥ 90 · B ≥ 80 · C ≥ 70 · D ≥ 60 · F below",
  "Unmeasured always-loaded items (e.g. MCP servers) are NOT scored (we don't punish what we can't see). The grade is marked provisional, and an A is capped at B, because a top grade cannot be certified for a setup we could only partly see.",
  "No grade at all is printed when nothing that loads up front was measured.",
];

export function gradeAgent(ag: AgentReport, findings: Finding[], window: number): Grade {
  const reasons: string[] = [];
  let score = 100;
  const always = ag.totals.always.est;
  const share = (always / window) * 100;
  const shareCost = share >= 20 ? 45 : share >= 10 ? 30 : share >= 5 ? 15 : share >= 2 ? 5 : 0;
  if (shareCost) {
    score -= shareCost;
    reasons.push(`always-on is ~${share.toFixed(1)}% of the window (−${shareCost})`);
  }
  const mine = findings.filter((f) => f.agent === ag.id || f.agent === "all");
  const count = (pred: (f: Finding) => boolean) => mine.filter(pred).length;
  const long = count((f) => f.id === "F1");
  const trunc = count((f) => f.id === "F4" || f.id === "F8" || f.id === "F12");
  const ignored = count((f) => f.id === "F7" || f.id === "F11");
  const dup = count((f) => f.id === "F2" && !f.data?.omittedPairs);
  const apply = (n: number, per: number, max: number, why: string) => {
    if (!n) return;
    const c = Math.min(max, n * per);
    score -= c;
    reasons.push(`${n} ${why} (−${c})`);
  };
  apply(long, 5, 15, "file(s) over the documented length guideline");
  apply(trunc, 5, 15, "silent truncation(s)");
  apply(ignored, 3, 9, "ignored file(s)");
  apply(dup, 5, 10, "duplicate pair(s)");
  score = Math.max(0, score);
  let letter = score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";
  const unm = ag.totals.always.unmeasuredItems;
  const partial = ag.lowerBound && unm === 0; // the scan budget cut the scan short
  let cappedAt: string | undefined;
  if (ag.lowerBound && letter === "A") {
    // An "A" would claim a clean bill of health for a setup we could only partly see.
    letter = "B";
    cappedAt = "B";
    reasons.push(partial ? "capped at B: the scan stopped at its budget, so a top grade cannot be certified" : `capped at B: ${unm} always-loaded item${unm > 1 ? "s" : ""} could not be measured, so a top grade cannot be certified`);
  }
  return { letter, score, provisional: ag.lowerBound, ...(cappedAt ? { cappedAt } : {}), reasons };
}
