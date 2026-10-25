export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  i: number; // index into the input values
}

/** Squarified treemap (Bruls et al.). Input values must be > 0; output order follows descending value. */
export function squarify(values: number[], x: number, y: number, w: number, h: number): Rect[] {
  const total = values.reduce((a, b) => a + b, 0);
  const out: Rect[] = [];
  if (total <= 0 || w <= 0 || h <= 0) return out;
  const scale = (w * h) / total;
  let rem = values.map((v, i) => ({ a: v * scale, i })).sort((p, q) => q.a - p.a);
  let cx = x,
    cy = y,
    cw = w,
    ch = h;
  const worst = (row: { a: number }[], side: number) => {
    const s = row.reduce((t, r) => t + r.a, 0);
    const mx = Math.max(...row.map((r) => r.a));
    const mn = Math.min(...row.map((r) => r.a));
    return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
  };
  while (rem.length) {
    const side = Math.min(cw, ch);
    let row = [rem[0]];
    let k = 1;
    while (k < rem.length) {
      const cand = [...row, rem[k]];
      if (worst(cand, side) <= worst(row, side)) {
        row = cand;
        k++;
      } else break;
    }
    const s = row.reduce((t, r) => t + r.a, 0);
    if (cw >= ch) {
      const colW = s / ch;
      let yy = cy;
      for (const r of row) {
        const hh = r.a / colW;
        out.push({ x: cx, y: yy, w: colW, h: hh, i: r.i });
        yy += hh;
      }
      cx += colW;
      cw -= colW;
    } else {
      const rowH = s / cw;
      let xx = cx;
      for (const r of row) {
        const ww = r.a / rowH;
        out.push({ x: xx, y: cy, w: ww, h: rowH, i: r.i });
        xx += ww;
      }
      cy += rowH;
      ch -= rowH;
    }
    rem = rem.slice(row.length);
  }
  return out;
}
