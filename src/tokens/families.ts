import fs from "node:fs";
import path from "node:path";
import { TokenEst } from "../model";
import { AgentId, agentMeta } from "../agents";
import { Method } from "./counter";

/** What the counted text mostly is; Claude's tokenizer compresses JSON better than prose (spec/calibration.json). */
export type ContentKind = "markdown" | "json";

export interface Profile {
  id: string;
  label: string;
  band: string; // human text, e.g. "±15%"
  apply(raw: number, kind?: ContentKind): TokenEst;
  unvalidated: boolean;
}

interface KindCal { factor: number; band: number }
export interface Calibration {
  measuredAt: string;
  n: number;
  unvalidated: boolean;
  byKind: Record<ContentKind, KindCal>;
  legacyRatio: { value: number };
}

let calCache: Calibration | undefined;
/** Claude ratios from spec/calibration.json (published count_tokens measurements; see docs/ACCURACY.md). */
export function claudeCalibration(): Calibration {
  if (!calCache) {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "spec", "calibration.json"), "utf8")) as { claude: Calibration };
    calCache = j.claude;
  }
  return calCache;
}

function sym(raw: number, factor: number, bandPct: number): TokenEst {
  const est = Math.round(raw * factor);
  return { est, low: Math.round(est * (1 - bandPct)), high: Math.round(est * (1 + bandPct)) };
}

const pct = (x: number) => `±${Math.round(x * 100)}%`;

/**
 * Claude factors come from spec/calibration.json (published ratios, still unvalidated: n is small). Codex is o200k itself.
 * "mixed" agents (Cursor, Copilot) let the user pick the model, so they span GPT-like to Claude-like. Gemini has no measured ratio.
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
  const family = agentMeta(agent).tokenFamily;
  if (family === "openai") {
    return { id: "openai-o200k", label: "o200k BPE (OpenAI-family)", band: "±3%", apply: (raw) => sym(raw, 1.0, 0.03), unvalidated: false };
  }
  const cal = claudeCalibration();
  const scale = claude === "current" ? 1 : cal.legacyRatio.value;
  const f = (k: ContentKind) => Math.round(cal.byKind[k].factor * scale * 1000) / 1000;
  const b = (k: ContentKind) => cal.byKind[k].band;
  const claudeProfile: Profile = {
    id: `claude-${claude}`,
    label: `o200k × ${f("markdown")} (text) / × ${f("json")} (JSON), Claude-${claude} ratios from published count_tokens measurements`,
    band: pct(b("markdown")),
    apply: (raw, kind = "markdown") => sym(raw, f(kind), b(kind)),
    unvalidated: cal.unvalidated,
  };
  if (family === "claude") return claudeProfile;
  if (family === "gemini") {
    // No published Gemini-vs-o200k ratio was found (docs/ACCURACY.md), so prehello does not invent one: the estimate is the
    // raw o200k count and the band is the same GPT-like-to-Claude-like spread used for "model unknown". NOT a Gemini measurement.
    return {
      id: "gemini-unvalidated",
      label: `o200k × 1.0; no measured Gemini ratio, band borrowed from the GPT-like (×1.0) to Claude-like (×${f("markdown")}) spread`,
      band: `wide, unvalidated: −3% to +${Math.round((f("markdown") * (1 + b("markdown")) - 1) * 100)}%`,
      apply: (raw, kind = "markdown") => ({ est: Math.round(raw), low: Math.round(raw * 0.97), high: Math.round(raw * f(kind) * (1 + b(kind))) }),
      unvalidated: true,
    };
  }
  // mixed (Cursor, GitHub Copilot: the model is user-selectable and not discoverable from disk): span GPT-like (×1.0, −3%) to Claude-like (×f, +band); est = midpoint.
  return {
    id: agent === "cursor" ? "cursor-mixed" : "mixed",
    label: `o200k; model unknown, so midpoint of GPT-like (×1.0) and Claude-like (×${f("markdown")}) ratios`,
    band: `wide: GPT-like −3% to Claude-like +${Math.round(b("markdown") * 100)}%`,
    apply: (raw, kind = "markdown") => {
      const lo = Math.round(raw * 0.97);
      const hi = Math.round(raw * f(kind) * (1 + b(kind)));
      return { est: Math.round((raw * (1 + f(kind))) / 2), low: lo, high: hi };
    },
    unvalidated: true,
  };
}
