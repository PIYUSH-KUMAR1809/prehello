import { CutCandidate, Item, Savings } from "../model";
import { cmp } from "../util/fmt";

/** Default number of groups in the "what to cut" line. */
export const DEFAULT_CUT_N = 3;
/** Below this the cut list is noise, not advice. */
const MIN_SAVINGS_TOKENS = 500;

/**
 * Things a person can actually remove and that cost tokens before the first message: a plugin's skills, a skills folder,
 * an MCP server with a measured size. Instruction files and rules are NOT candidates (they are your own words; use the findings for those).
 */
export function cutCandidates(items: Item[]): CutCandidate[] {
  return cutCandidatesWithSource(items).map(({ source: _source, ...c }) => c);
}

/** Same list, same order as cutCandidates(), plus the item each group came from (for renderers that need its scope / file). */
export function cutCandidatesWithSource(items: Item[]): Array<CutCandidate & { source: Item }> {
  const out: Array<CutCandidate & { source: Item }> = [];
  for (const it of items) {
    if (it.loadMode !== "always" || !it.tokens || it.tokens.est <= 0) continue;
    if (it.kind === "skills-listing" && it.parts?.length) {
      for (const p of it.parts) out.push({ label: p.name, kind: "skills", tokens: p.tokens, count: p.count, source: it });
    } else if (it.kind === "skills-listing") {
      out.push({ label: it.label.replace(/^Skills listing \((.*)\)$/, "$1"), kind: "skills", tokens: it.tokens.est, count: 1, source: it });
    } else if (it.kind === "mcp-server" && it.server) {
      out.push({ label: `MCP server ${it.server.name}`, kind: "mcp", tokens: it.tokens.est, count: 1, source: it });
    }
  }
  return out.sort((a, b) => b.tokens - a.tokens || cmp(a.label, b.label));
}

/** What removing the top `n` groups would save (estimate). Null when there is nothing meaningful to say. */
export function savingsOf(items: Item[], alwaysEst: number, window: number, n = DEFAULT_CUT_N): Savings | null {
  const cands = cutCandidates(items);
  if (!cands.length || alwaysEst <= 0) return null;
  const top = cands.slice(0, n);
  const topTokens = top.reduce((s, c) => s + c.tokens, 0);
  if (topTokens < MIN_SAVINGS_TOKENS) return null;
  const groupsTokens = cands.reduce((s, c) => s + c.tokens, 0);
  return {
    n: top.length,
    top,
    topTokens,
    groupsTokens,
    groupsCount: cands.length,
    pctOfAlways: (topTokens / alwaysEst) * 100,
    pctOfGroups: groupsTokens ? (topTokens / groupsTokens) * 100 : 0,
    pctOfWindow: (topTokens / window) * 100,
  };
}

/** One tile of the card treemap: a cut-list group, or an always-on item that is not removable (rules, instruction files). */
export interface CardTile {
  label: string;
  tokens: number;
  /** "group" tiles are exactly the groups of the "what to cut" list (same labels, same token numbers). */
  kind: "group" | "mcp" | "item";
  /** True when the label carries a name the user chose or installed (plugin, MCP server); --card-anonymize replaces those. */
  named: boolean;
  /** Index into cutCandidates() for "group" and "mcp" tiles: the tile IS that cut-list entry (same numbers, same anonymised name). */
  cut?: number;
}

/** A tile label must never read like a path: drop any word that looks like one ("3 legacy ~/.codex skills" -> "3 legacy skills"). */
function pathFree(label: string): string {
  const words = label.split(/\s+/).filter((w) => w && !/[\\/~]/.test(w));
  return words.join(" ") || "skills";
}

/**
 * Always-on tiles for the card treemap. Skills listings and MCP servers are expanded into the SAME groups as the cut list
 * (cutCandidates), so the card matches its headline; everything else keeps its generic card label ("rule file 2").
 * Sorted by size. `anonymize` replaces plugin and MCP server names with "plugin 2" / "MCP server 1".
 */
export function cardTiles(items: Item[], anonymize = false): CardTile[] {
  const out: CardTile[] = [];
  cutCandidates(items).forEach((c, k) => {
    const named = c.kind === "mcp" || /^plugin /.test(c.label);
    out.push({ label: named ? c.label : pathFree(c.label), tokens: c.tokens, kind: c.kind === "mcp" ? "mcp" : "group", named, cut: k });
  });
  // Always-on items that are not removable groups: repeated generic labels collapse into one tile ("rule file x14"), not 14 slivers.
  const plain = items.filter((i) => i.loadMode === "always" && i.tokens && i.tokens.est > 0 && i.kind !== "mcp-server" && i.kind !== "skills-listing");
  const byLabel = new Map<string, { n: number; tokens: number }>();
  for (const it of plain) {
    const g = byLabel.get(it.cardLabel) ?? { n: 0, tokens: 0 };
    g.n++;
    g.tokens += it.tokens!.est;
    byLabel.set(it.cardLabel, g);
  }
  for (const [label, g] of byLabel) out.push({ label: g.n > 1 ? `${label} x${g.n}` : label, tokens: g.tokens, kind: "item", named: false });
  out.sort((a, b) => b.tokens - a.tokens || cmp(a.label, b.label));
  if (anonymize) {
    let plugins = 0;
    let servers = 0;
    for (const t of out) {
      if (!t.named) continue;
      t.label = t.kind === "mcp" ? `MCP server ${++servers}` : `plugin ${++plugins}`;
      t.named = false;
    }
  }
  // identical labels (two "3 user skills" groups, two servers with the same name) must stay distinguishable
  const dup = new Map<string, number>();
  for (const t of out) dup.set(t.label, (dup.get(t.label) ?? 0) + 1);
  const idx = new Map<string, number>();
  for (const t of out) {
    if ((dup.get(t.label) ?? 1) > 1) {
      const k = (idx.get(t.label) ?? 0) + 1;
      idx.set(t.label, k);
      t.label = `${t.label} (${k})`;
    }
  }
  return out;
}
