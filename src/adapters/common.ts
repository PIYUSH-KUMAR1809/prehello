import fs from "node:fs";
import path from "node:path";
import { Ctx, lineCount, readFailWhy } from "../context";
import { AgentId, Confidence, Item, ItemKind, LoadMode, Scope } from "../model";
import { stripHtmlComments } from "../text/comments";
import { expandImports } from "../text/imports";
import { isInside, realpathOrSelf } from "../fs-safe";
import { loadCatalog, lookup, CatalogEntry } from "../mcp/catalog";
import { McpServerDef } from "../mcp/configs";

export interface InstrOpts {
  agent: AgentId;
  scope: Scope;
  loadMode: LoadMode;
  kind?: ItemKind;
  label: string;
  cardLabel: string;
  jail?: string;
  stripComments: boolean;
  imports: boolean;
  confidence: Confidence;
  evidence: { docUrl: string; verifiedAt: string };
  guidelineLines?: number;
  notes?: string[];
  group?: string;
  groupLabel?: string;
  /** Pre-process the text (e.g. strip frontmatter, truncate). Return processed text and extra notes. */
  transform?: (raw: string) => { text: string; notes?: string[] };
  /** Skip analysis (F1/F9/F2) for this doc. */
  noAnalyze?: boolean;
}

/** Read one instruction-like file and turn it into an Item. Returns null if missing/unreadable/empty. */
export function loadInstruction(ctx: Ctx, filePath: string, o: InstrOpts): Item | null {
  const r = ctx.read(filePath, o.jail ? { jail: o.jail } : {});
  if (!r.ok) {
    // The file exists but could not be measured: surface it as UNMEASURED so totals become lower bounds (never silently dropped).
    if (r.reason === "missing" || r.reason === "not-file") return null;
    const why = r.reason === "budget" ? "not read: scan budget reached" : readFailWhy(r.reason, "not read");
    return ctx.makeItem({
      agent: o.agent, path: filePath, kind: o.kind ?? "instructions", scope: o.scope, loadMode: o.loadMode, raw: null,
      unmeasuredReason: why, confidence: o.confidence, evidence: o.evidence, notes: [...(o.notes ?? [])],
      cardLabel: o.cardLabel, label: o.label, group: o.group, groupLabel: o.groupLabel,
    });
  }
  let text = r.text;
  const notes = [...(o.notes ?? [])];
  if (o.transform) {
    const t = o.transform(text);
    text = t.text;
    notes.push(...(t.notes ?? []));
  }
  const afterTransform = text;
  if (o.stripComments) text = stripHtmlComments(text);
  let detail: string | undefined;
  if (o.imports) {
    const roots = [realpathOrSelf(ctx.home), realpathOrSelf(ctx.gitRoot ?? ctx.cwd), realpathOrSelf(path.dirname(filePath))];
    const res = expandImports(text, filePath, ctx.home, (real) => roots.some((root) => isInside(real, root)), { stripComments: o.stripComments, read: (t) => ctx.read(t, { quiet: true }) });
    text = res.text;
    if (res.imported) detail = `(+${res.imported} @import${res.imported > 1 ? "s" : ""})`;
    if (res.skipped.length) notes.push(`${res.skipped.length} @import(s) not followed (${[...new Set(res.skipped.map((s) => s.reason))].join(", ")})`);
  }
  if (!text.trim()) return null;
  const key = `${r.realPath}|${o.stripComments ? 1 : 0}${o.imports ? 1 : 0}|${o.transform ? text.length : ""}`;
  const raw = ctx.count(key, text);
  if (!o.noAnalyze) ctx.analyzeDoc(o.agent, filePath, r.text, afterTransform, raw, o.guidelineLines);
  return ctx.makeItem({
    agent: o.agent,
    path: filePath,
    kind: o.kind ?? "instructions",
    scope: o.scope,
    loadMode: o.loadMode,
    raw,
    chars: text.length,
    lines: lineCount(r.text),
    confidence: o.confidence,
    evidence: o.evidence,
    notes,
    cardLabel: o.cardLabel,
    label: o.label,
    detail,
    group: o.group,
    groupLabel: o.groupLabel,
  });
}

/** Recursively list files with an extension under dir (bounded, no symlink following). */
export function listFilesRec(dir: string, ext: string[], limit = 500, maxDepth = 5): string[] {
  const out: string[] = [];
  const visit = (d: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) {
        // allow symlinked files (resolved by jail in the reader) but not symlinked dirs
        if (ext.some((x) => e.name.endsWith(x))) out.push(p);
      } else if (e.isDirectory() && depth < maxDepth) visit(p, depth + 1);
      else if (e.isFile() && ext.some((x) => e.name.endsWith(x))) out.push(p);
    }
  };
  visit(dir, 0);
  return out;
}

export interface McpBuild {
  agent: AgentId;
  def: McpServerDef;
  source: string; // config path
  scope: Scope;
  /** "split" = names always + schemas deferred (tool search), "full" = everything always. */
  mode: "split" | "full";
  evidence: { docUrl: string; verifiedAt: string };
  notes: string[];
  index: number;
}

let catalogCache: { key: string; entries: CatalogEntry[]; warnings: string[] } | undefined;
export function catalogFor(ctx: Ctx): CatalogEntry[] {
  const key = `${ctx.opts.noBundledCatalog ? "nb" : "b"}|${ctx.opts.catalogPath ?? ""}`;
  if (!catalogCache || catalogCache.key !== key) {
    const c = loadCatalog(ctx.opts.catalogPath, ctx.opts.noBundledCatalog);
    catalogCache = { key, ...c };
  }
  catalogCache.warnings.forEach((w) => ctx.warn(w));
  return catalogCache.entries;
}

/** Turn one configured MCP server into 1–2 items. Unmeasured servers are NEVER zero. */
export function mcpItems(ctx: Ctx, b: McpBuild): Item[] {
  const items = mcpItemsInner(ctx, b);
  for (const it of items) it.server = { name: b.def.name, transport: b.def.transport };
  return items;
}

function mcpItemsInner(ctx: Ctx, b: McpBuild): Item[] {
  const entry = lookup(catalogFor(ctx), b.def);
  const base = {
    agent: b.agent,
    path: b.source,
    kind: "mcp-server" as ItemKind,
    scope: b.scope,
    evidence: b.evidence,
    cardLabel: "MCP server",
    group: "mcp",
    groupLabel: "MCP servers",
  };
  if (!entry) {
    return [
      ctx.makeItem({
        ...base,
        loadMode: "always",
        raw: null,
        unmeasuredReason: "no local tool-list cache or catalog entry; run is static (no server was started)",
        confidence: "assumed",
        notes: [...b.notes, `transport: ${b.def.transport}`],
        label: `MCP server "${b.def.name}"`,
      }),
    ];
  }
  const tag = `catalog: measured ${entry.measuredAt}${entry.version ? ` v${entry.version}` : ""}, ${entry.tools} tools; your version may differ`;
  if (b.mode === "split") {
    return [
      ctx.makeItem({ ...base, loadMode: "always", raw: entry.nameTokens, confidence: "assumed", notes: [...b.notes, tag, "tool names only (tool search)"], label: `MCP "${b.def.name}" (tool names)` }),
      ctx.makeItem({ ...base, loadMode: "deferred", raw: entry.schemaTokens, confidence: "assumed", notes: [...b.notes, tag, "schemas fetched on demand (tool search)"], label: `MCP "${b.def.name}" (schemas)` }),
    ];
  }
  return [
    ctx.makeItem({ ...base, loadMode: "always", raw: entry.nameTokens + entry.schemaTokens, confidence: "assumed", notes: [...b.notes, tag], label: `MCP "${b.def.name}" (${entry.tools} tools)` }),
  ];
}
