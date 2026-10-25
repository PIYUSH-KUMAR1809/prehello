import { Item, LOAD_MODES, LoadMode, Totals } from "../model";

export function sumTotals(items: Item[]): Record<LoadMode, Totals> {
  const out = {} as Record<LoadMode, Totals>;
  for (const m of LOAD_MODES) out[m] = { est: 0, low: 0, high: 0, measuredItems: 0, unmeasuredItems: 0 };
  for (const it of items) {
    const t = out[it.loadMode];
    if (!it.tokens) {
      t.unmeasuredItems++;
      continue;
    }
    t.est += it.tokens.est;
    t.low += it.tokens.low;
    t.high += it.tokens.high;
    t.measuredItems++;
  }
  return out;
}
