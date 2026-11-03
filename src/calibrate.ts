/**
 * `prehello calibrate`: compare prehello's estimate with a Claude Code `/context` reading the user pasted. Offline: the text is
 * parsed locally and nothing is sent anywhere. A file is written only with --save.
 */
import path from "node:path";
import { AgentReport, Item, Report } from "./model";
import { claudeCalibration } from "./tokens/families";
import { fmtTok, sanitize, shortenLabel } from "./util/fmt";

export interface ContextNumber {
  value: number;
  /** Half-width of the display rounding ("2.8k" = 2,750–2,849, so 50). */
  pm: number;
  raw: string;
}

export interface ContextRow {
  label: string;
  tokens: ContextNumber;
  /** File path when the row names one (memory files). */
  path?: string;
}

export interface ContextReading {
  model?: string;
  used?: ContextNumber;
  total?: ContextNumber;
  /** Category rows, keyed by normalised name ("memory files", "mcp tools (deferred)", ...). */
  categories: Map<string, ContextNumber>;
  /** Detail sections ("memory files", "skills", "custom agents", "mcp tools") -> rows. */
  details: Map<string, ContextRow[]>;
  /** The MCP detail header said "(loaded on-demand)" / deferred. */
  mcpOnDemand: boolean;
  recognised: number;
  ignored: number;
}

export class ContextParseError extends Error {}

const NUM = String.raw`(\d[\d,]*(?:\.\d+)?)\s*([kKmM]?)`;

export function parseNumber(num: string, suffix: string): ContextNumber {
  const n = parseFloat(num.replace(/,/g, ""));
  const mult = suffix.toLowerCase() === "k" ? 1000 : suffix.toLowerCase() === "m" ? 1_000_000 : 1;
  const decimals = num.includes(".") ? num.split(".")[1].length : 0;
  const pm = (mult === 1 && decimals === 0 ? 0.5 : 0.5 * Math.pow(10, -decimals)) * mult;
  return { value: Math.round(n * mult), pm: mult === 1 && decimals === 0 ? 0.5 : pm, raw: `${num}${suffix}` };
}

const KNOWN = ["system prompt", "system tools", "system tools (deferred)", "mcp tools", "mcp tools (deferred)", "custom agents", "memory files", "skills", "messages", "free space", "autocompact buffer"];
const SECTIONS: Array<[RegExp, string]> = [
  [/^mcp tools\b/i, "mcp tools"],
  [/^custom agents\b/i, "custom agents"],
  [/^memory files\b/i, "memory files"],
  [/^skills\b/i, "skills"],
  [/^system tools\b/i, "system tools"],
  [/^plugins?\b/i, "plugins"],
];

/** Parse the text of Claude Code's `/context` (any of the layouts seen 2025-2026). Unknown lines are ignored and counted. */
export function parseContext(text: string): ContextReading {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\r\n?/g, "\n");
  const r: ContextReading = { categories: new Map(), details: new Map(), mcpOnDemand: false, recognised: 0, ignored: 0 };
  let section: string | undefined;
  const header = new RegExp(String.raw`([\w.\-\[\]]+)\s+·\s+${NUM}\s*/\s*${NUM}\s+tokens\s*\(`, "i");
  const usedOnly = new RegExp(String.raw`^\s*${NUM}\s*/\s*${NUM}\s+tokens\s*\(`, "i");
  const cat = new RegExp(String.raw`([A-Za-z][A-Za-z ]*?(?:\s*\((?:deferred)\))?):\s+${NUM}\s*(?:tokens)?\s*\(\s*\d+(?:\.\d+)?%\s*\)`, "g");
  const row = new RegExp(String.raw`^\s*[└├│]?[─\s]*└?\s*(.+?):\s+${NUM}\s+tokens\s*$`);
  const summary = new RegExp(String.raw`^\s*└\s+\d[\d,]*\s+\w+\s+·\s+${NUM}\s+tokens`);
  for (const line0 of clean.split("\n")) {
    const line = line0.replace(/[⛁⛀⛶⛝⛃]/g, " ").replace(/^\s*(?:❯|>)?\s*(?:⎿)?\s*/, "");
    if (!line.trim()) continue;
    const h = header.exec(line);
    if (h) {
      r.model = h[1];
      r.used = parseNumber(h[2], h[3]);
      r.total = parseNumber(h[4], h[5]);
      r.recognised++;
      continue;
    }
    const u = usedOnly.exec(line);
    if (u) {
      r.used = parseNumber(u[1], u[2]);
      r.total = parseNumber(u[3], u[4]);
      r.recognised++;
      continue;
    }
    if (/^\s*claude-[\w.\-\[\]]+\s*$/i.test(line)) {
      r.model = line.trim();
      r.recognised++;
      continue;
    }
    let anyCat = false;
    for (const m of line.matchAll(cat)) {
      const name = m[1].trim().toLowerCase().replace(/\s+/g, " ");
      if (!KNOWN.includes(name) && !/^[a-z ]+( \(deferred\))?$/.test(name)) continue;
      r.categories.set(name, parseNumber(m[2], m[3]));
      anyCat = true;
    }
    if (anyCat) {
      r.recognised++;
      section = undefined;
      continue;
    }
    const sec = line.trim();
    const sm = SECTIONS.find(([re]) => re.test(sec) && /·|\/\w/.test(sec));
    if (sm) {
      section = sm[1];
      if (section === "mcp tools" && /on-demand|deferred/i.test(sec)) r.mcpOnDemand = true;
      if (!r.details.has(section)) r.details.set(section, []);
      r.recognised++;
      continue;
    }
    if (section && summary.test(line)) {
      r.recognised++;
      continue;
    }
    const rw = section ? row.exec(line) : null;
    if (rw && section) {
      const label = rw[1].replace(/^[└├│─\s]+/, "").trim();
      const pm = /\(([^()]*[\/\\][^()]*)\)\s*$/.exec(label);
      const p = pm ? pm[1] : /[\/\\]/.test(label) ? label : undefined;
      r.details.get(section)!.push({ label, tokens: parseNumber(rw[2], rw[3]), ...(p ? { path: p } : {}) });
      r.recognised++;
      continue;
    }
    if (section && /^\s*(User|Project|Local|Managed|Plugin|Built-in|Enterprise)\b[^:]*$/i.test(line)) {
      r.recognised++;
      continue;
    }
    r.ignored++;
  }
  if (!r.categories.size) {
    throw new ContextParseError(
      "no /context category rows found (expected lines like 'Memory files: 3.2k tokens (1.6%)'). Paste the whole output of /context (or /context all) from Claude Code",
    );
  }
  return r;
}

export type CalCategory = "memory files" | "skills" | "custom agents" | "mcp tools";
const COMPARED: Array<{ cat: CalCategory; kinds: Item["kind"][] }> = [
  { cat: "memory files", kinds: ["instructions", "rule", "memory"] },
  { cat: "skills", kinds: ["skills-listing"] },
  { cat: "custom agents", kinds: ["subagents"] },
  { cat: "mcp tools", kinds: ["mcp-server"] },
];

export interface CalRow {
  category: string;
  actual: number | null;
  actualPm: number;
  est: number | null;
  low: number | null;
  high: number | null;
  /** (est - actual) / actual, percent; null when either side is missing or actual is 0. */
  errorPct: number | null;
  inBand: boolean | null;
  unmeasuredItems: number;
  note?: string;
}

export interface Calibration {
  model?: string;
  rows: CalRow[];
  files: CalRow[];
  total: CalRow;
  notEstimated: Array<{ category: string; actual: number }>;
  /** Implied Claude/o200k ratio for markdown-like content (memory files + skills + agents), when measurable. */
  impliedMarkdownRatio: number | null;
  ignoredLines: number;
}

function mk(category: string, actual: ContextNumber | undefined, est: { est: number; low: number; high: number } | null, unmeasured: number, note?: string): CalRow {
  const a = actual?.value ?? null;
  const err = a !== null && a > 0 && est ? ((est.est - a) / a) * 100 : null;
  const inBand = a !== null && est ? est.low <= a + (actual?.pm ?? 0) && est.high >= a - (actual?.pm ?? 0) : null;
  return { category, actual: a, actualPm: actual?.pm ?? 0, est: est?.est ?? null, low: est?.low ?? null, high: est?.high ?? null, errorPct: err, inBand, unmeasuredItems: unmeasured, ...(note ? { note } : {}) };
}

function sumItems(items: Item[]): { est: number; low: number; high: number } | null {
  const m = items.filter((i) => i.tokens);
  if (!m.length) return null;
  return m.reduce((s, i) => ({ est: s.est + i.tokens!.est, low: s.low + i.tokens!.low, high: s.high + i.tokens!.high }), { est: 0, low: 0, high: 0 });
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

export function compare(reading: ContextReading, a: AgentReport, home: string): Calibration {
  const always = a.items.filter((i) => i.loadMode === "always");
  const rows: CalRow[] = [];
  const used = { est: 0, low: 0, high: 0, actual: 0, pm: 0, any: false };
  for (const c of COMPARED) {
    let items = always.filter((i) => c.kinds.includes(i.kind));
    let actual = reading.categories.get(c.cat);
    let note: string | undefined;
    if (c.cat === "mcp tools") {
      if (reading.mcpOnDemand || (!actual && reading.categories.has("mcp tools (deferred)"))) note = "Claude Code loads these tool schemas on demand (tool search); only the always-on part is compared";
      if (!actual && items.length === 0) continue;
    }
    if (!actual && !items.length) continue;
    const est = sumItems(items);
    const unmeasured = items.filter((i) => !i.tokens).length;
    if (unmeasured) note = `${unmeasured} item(s) unmeasured by prehello: its number is a lower bound`;
    if (!actual) actual = { value: 0, pm: 0, raw: "absent" };
    const row = mk(c.cat, actual, est ?? { est: 0, low: 0, high: 0 }, unmeasured, note ?? (reading.categories.has(c.cat) ? undefined : "/context shows no such row (treated as 0)"));
    rows.push(row);
    if (est) {
      used.est += est.est;
      used.low += est.low;
      used.high += est.high;
    }
    used.actual += actual.value;
    used.pm += actual.pm;
    used.any = true;
    items = [];
  }
  const total = mk("compared total", used.any ? { value: used.actual, pm: used.pm, raw: "" } : undefined, used.any ? used : null, rows.reduce((s, r) => s + r.unmeasuredItems, 0));

  // per memory file, matched by path
  const files: CalRow[] = [];
  const memItems = always.filter((i) => ["instructions", "rule", "memory"].includes(i.kind) && i.tokens);
  for (const fr of reading.details.get("memory files") ?? []) {
    if (!fr.path) continue;
    const p = norm(fr.path.startsWith("~") ? path.join(home, fr.path.slice(1)) : fr.path);
    const hit = memItems.find((i) => norm(i.path) === p) ?? memItems.find((i) => p.endsWith("/" + norm(path.basename(i.path))) && norm(i.path).endsWith(p.split("/").slice(-2).join("/")));
    if (hit) files.push(mk(fr.path, fr.tokens, hit.tokens!, 0));
    else files.push(mk(fr.path, fr.tokens, null, 0, "prehello did not find this file"));
  }

  const notEstimated: Calibration["notEstimated"] = [];
  for (const k of ["system prompt", "system tools", "messages"]) {
    const v = reading.categories.get(k);
    if (v) notEstimated.push({ category: k, actual: v.value });
  }

  // implied ratio on markdown-like content: actual / raw o200k, where raw = est / factor
  const f = claudeCalibration().byKind.markdown.factor * (a.profile.id === "claude-legacy" ? claudeCalibration().legacyRatio.value : 1);
  const md = rows.filter((r) => r.category !== "mcp tools" && r.est && r.actual && r.unmeasuredItems === 0);
  const mdEst = md.reduce((s, r) => s + (r.est ?? 0), 0);
  const mdAct = md.reduce((s, r) => s + (r.actual ?? 0), 0);
  const impliedMarkdownRatio = mdEst > 0 && mdAct > 0 ? Math.round(((mdAct * f) / mdEst) * 1000) / 1000 : null;
  return { model: reading.model, rows, files, total, notEstimated, impliedMarkdownRatio, ignoredLines: reading.ignored };
}

const pctStr = (x: number | null) => (x === null ? "n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`);
const cell = (n: number | null) => (n === null ? "-" : fmtTok(n));

/** A memory-file label the reader can recognise: relative to the scanned folder when inside it, and never cut at the file name. */
function fileLabel(p: string, cwd: string): string {
  const variants = (x: string) => [x, x.replace(/^\/private(?=\/)/, ""), `/private${x}`];
  for (const base of variants(cwd)) {
    for (const cand of variants(p)) {
      const rel = path.relative(base, cand);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return shortenLabel(sanitize(rel, 1000), 70);
    }
  }
  return shortenLabel(sanitize(p, 1000), 70);
}

export function renderCalibration(c: Calibration, r: Report): string {
  const out: string[] = [];
  out.push(`prehello ${r.tool.version} calibrate · Claude Code${c.model ? ` · /context model ${sanitize(c.model, 60)}` : ""}`);
  out.push("Compares prehello's always-on estimate with your /context reading (offline; nothing is sent anywhere).", "");
  const head = ["category", "/context", "prehello (low-high)", "error", "in band"];
  const lines = [...c.rows, c.total].map((x) => [x.category, cell(x.actual), x.est === null ? "-" : `${fmtTok(x.est)} (${fmtTok(x.low!)}-${fmtTok(x.high!)})`, pctStr(x.errorPct), x.inBand === null ? "-" : x.inBand ? "yes" : "NO"]);
  const w = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const fmtRow = (l: string[]) => "  " + l.map((s, i) => (i === 0 ? s.padEnd(w[i]) : s.padStart(w[i]))).join("  ");
  out.push(fmtRow(head));
  for (const l of lines) out.push(fmtRow(l));
  for (const x of c.rows) if (x.note) out.push(`  note (${x.category}): ${x.note}`);
  if (c.files.length) {
    out.push("", "Memory files, one by one:");
    for (const f of c.files) out.push(`  ${fileLabel(f.category, r.scan.cwd)}: /context ${cell(f.actual)}, prehello ${cell(f.est)}, error ${pctStr(f.errorPct)}${f.note ? ` (${f.note})` : ""}`);
  }
  if (c.notEstimated.length) out.push("", `Not estimated by prehello (built into Claude Code): ${c.notEstimated.map((n) => `${n.category} ${fmtTok(n.actual)}`).join(", ")}.`);
  if (c.total.errorPct !== null && Math.abs(c.total.errorPct) > 50) out.push("", "The numbers are far apart. Run /context in a fresh Claude Code session started in the folder prehello scans (pass that folder as [path]), and paste its whole output.");
  if (c.impliedMarkdownRatio !== null && c.impliedMarkdownRatio > 0.5 && c.impliedMarkdownRatio < 3) out.push(`Implied Claude/o200k ratio for text here: ${c.impliedMarkdownRatio} (prehello uses ${claudeCalibration().byKind.markdown.factor}; includes listing wrappers).`);
  out.push("/context rounds its numbers (2.8k = 2,750-2,849); 'in band' allows for that.");
  if (c.ignoredLines) out.push(`${c.ignoredLines} line(s) of the pasted text were not recognised and ignored.`);
  out.push("Share it: prehello calibrate --file ctx.txt --save calibration.json, then attach the file to an issue (no paths or names in it).");
  return out.join("\n") + "\n";
}

/** Redacted record: no paths, no names. */
export function calibrationJson(c: Calibration, r: Report, a: AgentReport, redact: boolean): object {
  return {
    tool: { name: "prehello", version: r.tool.version },
    kind: "calibration",
    generatedAt: r.generatedAt,
    agent: a.id,
    profile: a.profile.id,
    model: c.model ?? null,
    calibration: { measuredAt: claudeCalibration().measuredAt, markdownFactor: claudeCalibration().byKind.markdown.factor, jsonFactor: claudeCalibration().byKind.json.factor },
    rows: c.rows,
    total: c.total,
    files: redact ? c.files.map(({ category: _c, ...rest }, i) => ({ category: `memory file ${i + 1}`, ...rest })) : c.files,
    notEstimated: c.notEstimated,
    impliedMarkdownRatio: c.impliedMarkdownRatio,
    ignoredLines: c.ignoredLines,
  };
}
