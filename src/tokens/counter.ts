export type Method = "bpe-o200k" | "heuristic";

export interface Counter {
  method: Method;
  note: string;
  /** Raw (family-neutral) token count: o200k BPE tokens, or heuristic units. */
  count(text: string): number;
}

function heuristicCount(text: string): number {
  if (!text) return 0;
  const jsonish = (text.match(/[{}\[\]":,]/g) || []).length / text.length > 0.08;
  return Math.ceil(text.length / (jsonish ? 3.0 : 3.5));
}

export function makeCounter(requested: "auto" | "heuristic"): Counter {
  if (requested === "auto") {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const enc = require("gpt-tokenizer/encoding/o200k_base") as { encode: (s: string, o?: unknown) => number[] };
      // Verify it works (and that special-token text such as "<|endoftext|>" cannot throw).
      enc.encode("hello", { disallowedSpecial: new Set() });
      return {
        method: "bpe-o200k",
        note: "o200k BPE (gpt-tokenizer, bundled) with per-family scaling",
        count(text: string): number {
          if (!text) return 0;
          try {
            return enc.encode(text, { disallowedSpecial: new Set() }).length;
          } catch {
            return heuristicCount(text);
          }
        },
      };
    } catch {
      /* fall through to heuristic */
    }
  }
  return {
    method: "heuristic",
    note: requested === "auto" ? "BPE tokenizer unavailable; fell back to chars/3.5 heuristic" : "chars/3.5 (prose) or chars/3.0 (JSON/code) heuristic",
    count: heuristicCount,
  };
}
