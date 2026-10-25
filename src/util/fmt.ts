import { scrubSecrets } from "./secrets";

/** Remove control characters / ANSI escapes so file names from untrusted repos cannot hijack the terminal or a downstream agent. */
export function sanitize(s: string, max = 120): string {
  // eslint-disable-next-line no-control-regex
  let out = s.replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "?");
  // Scrub BEFORE truncating: a cut-off key (sk-ant-…) would no longer match and would leak its prefix.
  out = scrubSecrets(out);
  if (out.length > max) out = out.slice(0, max - 1) + "…";
  return out;
}

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** 16440 -> "16.4k", 950 -> "950". */
export function fmtTok(n: number): string {
  const r = Math.round(n);
  if (r < 1000) return String(r);
  if (r < 100000) return (r / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  if (r < 999500) return Math.round(r / 1000) + "k";
  return (r / 1_000_000).toFixed(r < 10_000_000 ? 2 : 1).replace(/\.?0+$/, "") + "M";
}

export function fmtPct(x: number): string {
  if (x < 0.1) return x === 0 ? "0%" : "< 0.1%";
  return (x < 10 ? x.toFixed(1) : String(Math.round(x))) + "%";
}

export function parseWindow(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(s.trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  const mult = m[2].toLowerCase() === "k" ? 1000 : m[2].toLowerCase() === "m" ? 1_000_000 : 1;
  const v = Math.round(n * mult);
  return v >= 1000 ? v : null;
}

export function fmtWindow(n: number): string {
  if (n >= 1_000_000 && n % 1_000_000 === 0) return n / 1_000_000 + "M";
  if (n >= 1000 && n % 1000 === 0) return n / 1000 + "k";
  return String(n);
}

export function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}

/** Greedy word wrap; first line gets `first`, continuation lines get `indent`. */
export function wrap(text: string, width: number, first = "", indent = ""): string[] {
  const room = Math.max(20, width - Math.max(first.length, indent.length) - 1);
  const words = text
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((w) => (w.length > room ? w.match(new RegExp(`[\\s\\S]{1,${room}}`, "gu")) ?? [w] : [w]));
  const lines: string[] = [];
  let cur = first;
  let empty = true;
  for (const w of words) {
    if (!empty && cur.length + 1 + w.length > width) {
      lines.push(cur);
      cur = indent + w;
    } else {
      cur += (empty ? "" : " ") + w;
    }
    empty = false;
  }
  lines.push(cur);
  return lines;
}

/** Truncate from the LEFT, keeping the end (the file name) of a path-like label. */
export function shortenLeft(s: string, max: number): string {
  if (s.length <= max) return s;
  return "…" + s.slice(s.length - (max - 1));
}

/** Shorten a row label: paths keep their tail (the file name); prose keeps its start. */
export function shortenLabel(s: string, max: number): string {
  const t = s.replace(/^\.\//, "");
  if (t.length <= max) return t;
  return /[\\/]/.test(t) && !/\s/.test(t) ? "…" + t.slice(t.length - (max - 1)) : t.slice(0, max - 1) + "…";
}

/** Locale-independent, ICU-independent string order (UTF-16 code units). Use instead of localeCompare for deterministic output. */
export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
