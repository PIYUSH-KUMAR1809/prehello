import { AgentId, TokenEst } from "../model";
import { Method } from "./counter";

export interface Profile {
  id: string;
  label: string;
  band: string; // human text, e.g. "±20%"
  apply(raw: number): TokenEst;
  unvalidated: boolean;
}

function sym(raw: number, factor: number, bandPct: number): TokenEst {
  const est = Math.round(raw * factor);
  return { est, low: Math.round(est * (1 - bandPct)), high: Math.round(est * (1 + bandPct)) };
}

/**
 * Priors from PRODUCT_PLAN §7.2. All Claude/heuristic factors and bands are UNVALIDATED priors until
 * calibrated against ground truth (see docs/accuracy.md). The OpenAI band is for the BPE itself.
 */
export function profileFor(agent: AgentId, method: Method, claude: "current" | "legacy"): Profile {
  if (method === "heuristic") {
    return {
      id: "heuristic",
      label: "heuristic chars/3.5 (no tokenizer)",
      band: "±35%",
      apply: (raw) => sym(raw, 1, 0.35),
      unvalidated: true,
    };
  }
  if (agent === "codex") {
    return { id: "openai-o200k", label: "o200k BPE (OpenAI-family)", band: "±3%", apply: (raw) => sym(raw, 1.0, 0.03), unvalidated: false };
  }
  const f = claude === "current" ? 1.5 : 1.2;
  const claudeProfile: Profile = {
    id: `claude-${claude}`,
    label: `o200k × ${f} (Claude-${claude} prior)`,
    band: "±20%",
    apply: (raw) => sym(raw, f, 0.2),
    unvalidated: true,
  };
  if (agent === "claude-code") return claudeProfile;
  // Cursor: model not discoverable from disk -> span GPT-like (×1.0, −3%) to Claude-like (×f, +20%); est = midpoint.
  return {
    id: "cursor-mixed",
    label: `o200k; model unknown, so midpoint of GPT-like (×1.0) and Claude-like (×${f}) priors`,
    band: "wide: GPT-like −3% to Claude-like +20%",
    apply: (raw) => {
      const lo = Math.round(raw * 0.97);
      const hi = Math.round(raw * f * 1.2);
      return { est: Math.round((raw * (1 + f)) / 2), low: lo, high: hi };
    },
    unvalidated: true,
  };
}
