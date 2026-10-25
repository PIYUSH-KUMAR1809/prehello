import { AgentReport, Report } from "../model";
import { fmtPct, fmtTok, fmtWindow, xmlEscape } from "../util/fmt";
import { squarify } from "./treemap";
import { cardTiles } from "../analyze/savings";
import { scrubSecrets } from "../util/secrets";

export interface CardOpts {
  theme: "dark" | "light";
  size: "og" | "square";
  /**
   * "cut" (default): lead with the cost of skills/plugins/MCP and what removing the top groups saves; falls back to the total
   * headline when there is no meaningful saving. "total": always lead with the always-on total.
   */
  headline?: "total" | "cut";
  /** Replace plugin and MCP server names on the treemap with "plugin 1" / "MCP server 1". Default false: the tiles use the cut-list group names. */
  anonymize?: boolean;
  /** font-family attribute for every text element. Default CARD_FONT (system stack); the PNG path passes the shipped font. */
  fontFamily?: string;
  /** Width of an average character in em, used for fitting text. Default CHAR_EM (wide, safe for any fallback font). */
  charEm?: number;
}

/** A saving smaller than this (estimated tokens) is noise, not a headline. Same threshold as the cut list itself. */
export const MIN_CUT_HEADLINE_TOKENS = 500;

export interface Headline {
  id: "tokens-before-hello" | "cut-list" | "mcp-unmeasured" | "nothing";
  hero: string;
  sub: string;
}

/** Wording of the lower-bound marker. Words, not a glyph: "≥" is missing from several fallback fonts used by SVG renderers. */
export const AT_LEAST = "at least";

/**
 * Headline templates. Each one is selected by data and re-validated by assertHeadline():
 * no claim is rendered unless it is true for the scanned data (plan §10.1 guard).
 */
export function buildHeadline(a: AgentReport, window: number, variant: "total" | "cut" = "cut"): Headline | null {
  const t = a.totals.always;
  const lower = a.lowerBound ? `${AT_LEAST} ` : "";
  // The cut headline needs measured always-on data AND a saving that is worth saying out loud; otherwise the total headline is used.
  if (variant === "cut" && a.savings && t.measuredItems > 0 && a.savings.topTokens >= MIN_CUT_HEADLINE_TOKENS) {
    const sv = a.savings;
    const what = sv.top.some((c) => c.kind === "mcp") ? "Skills, plugins & MCP" : "Skills & plugins";
    return {
      id: "cut-list",
      hero: `${what} cost ${lower}~${fmtTok(sv.groupsTokens)} tokens before hello`,
      sub: `${sv.n === sv.groupsCount ? `all ${sv.n} group${sv.n > 1 ? "s" : ""}` : `top ${sv.n} of ${sv.groupsCount} groups`}: cut ${sv.n > 1 ? "them" : "it"}, save ~${fmtTok(sv.topTokens)} (estimate)`,
    };
  }
  if (t.measuredItems > 0 && t.est > 0) {
    const pct = (t.est / window) * 100;
    return {
      id: "tokens-before-hello",
      hero: `${lower}~${fmtTok(t.est)} tokens load before hello`,
      sub: `${pct < 0.1 ? (a.lowerBound ? "under 0.1% so far" : "under 0.1%") : (a.lowerBound ? AT_LEAST + " " : "about ") + fmtPct(pct)} of a ${fmtWindow(window)} window · ${a.name} · estimate`,
    };
  }
  if (t.unmeasuredItems > 0) {
    const n = t.unmeasuredItems;
    // only claim "MCP servers" when every unmeasured always-on item really is one (an unreadable CLAUDE.md is not a server)
    const un = a.items.filter((i) => i.loadMode === "always" && i.tokens === null);
    const mcpOnly = un.length > 0 && un.every((i) => i.kind === "mcp-server");
    return { id: "mcp-unmeasured", hero: mcpOnly ? `${n} MCP server${n > 1 ? "s" : ""} load before hello` : `${n} always-loaded item${n > 1 ? "s" : ""} could not be measured`, sub: `${a.name} · token cost unmeasured (not zero)` };
  }
  return null;
}

export function assertHeadline(h: Headline, a: AgentReport, window: number): void {
  const t = a.totals.always;
  if (h.id === "tokens-before-hello") {
    if (!(t.measuredItems > 0 && t.est > 0)) throw new Error("headline guard: tokens claim without measured always-on data");
    if (a.lowerBound && !h.hero.startsWith(AT_LEAST)) throw new Error("headline guard: lower-bound marker missing");
    if (!h.hero.includes("~")) throw new Error("headline guard: estimate marker missing");
    if (/%/.test(h.hero)) throw new Error("headline guard: unexpected percentage in hero");
  } else if (h.id === "cut-list") {
    if (!a.savings || !(t.measuredItems > 0)) throw new Error("headline guard: cut-list claim without savings data");
    if (a.savings.topTokens < MIN_CUT_HEADLINE_TOKENS) throw new Error("headline guard: cut-list claim below the minimum saving");
    if (!h.hero.includes("~") || !/estimate/.test(h.sub)) throw new Error("headline guard: estimate marker missing");
    if (a.lowerBound && !/ cost at least /.test(h.hero)) throw new Error("headline guard: lower-bound marker missing");
  } else if (h.id === "mcp-unmeasured") {
    if (t.measuredItems > 0 || t.unmeasuredItems === 0) throw new Error("headline guard: mcp claim without unmeasured-only data");
    if (/\d+(\.\d+)?k? tokens/.test(h.hero + h.sub)) throw new Error("headline guard: token number for unmeasured data");
  }
  void window;
}

export function pickCardAgent(r: Report, want?: string): AgentReport | null {
  const shown = r.agents.filter((a) => !a.presentInRepoOnly);
  if (want) return shown.find((a) => a.id === want) ?? null;
  const withData = shown.filter((a) => buildHeadline(a, r.scan.window));
  withData.sort((a, b) => b.totals.always.est - a.totals.always.est || b.totals.always.unmeasuredItems - a.totals.always.unmeasuredItems);
  return withData[0] ?? null;
}

const FILLS = ["#1f6feb", "#8250df", "#1a7f37", "#9a6700", "#bf3989", "#0a7a8a", "#bc4c00"];
const OTHER_FILL = "#57606a";
export const THEMES = {
  dark: { bg: "#0d1117", text: "#e6edf3", muted: "#9da7b3", chip: "#21262d", border: "#30363d" },
  light: { bg: "#ffffff", text: "#1f2328", muted: "#4b5563", chip: "#eef1f4", border: "#d0d7de" },
};

function fit(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return maxChars <= 3 ? text.slice(0, Math.max(0, maxChars)) : text.slice(0, maxChars - 3) + "...";
}

/**
 * Font stack with sane fallbacks: SVG renderers (browsers, rsvg, Inkscape, link-preview bots) differ in which of these exist,
 * and `system-ui` is unknown to some of them. It always ends in the generic `sans-serif`, and every width estimate below assumes
 * a wide face (DejaVu Sans is ~0.62 em per character) so text still fits when the fallback is the widest one.
 */
export const CARD_FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Liberation Sans', 'DejaVu Sans', sans-serif";
const DEFAULT_CHAR_EM = 0.62;

/** Greedy wrap of a tile label at spaces and after hyphens; the last allowed line ends in "..." when text is left over. Never returns an empty list. */
export function wrapLabel(label: string, maxChars: number, maxLines: number): string[] {
  const toks = label.split(/(?<=-)|\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  const rest: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const joined = cur ? (cur.endsWith("-") ? cur + t : `${cur} ${t}`) : t;
    if (!cur || joined.length <= maxChars) cur = joined;
    else {
      lines.push(cur);
      cur = t;
    }
    if (lines.length === maxLines) {
      rest.push(...toks.slice(i));
      cur = "";
      break;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) lines.length = maxLines;
  const out = lines.map((l) => (l.length > maxChars ? fit(l, maxChars) : l));
  if (rest.length > 0) out[out.length - 1] = fit(out[out.length - 1] + "...", maxChars);
  return out.length ? out : [fit(label, maxChars)];
}

/** Greedy wrap on " · " boundaries so a footer never runs off the card. */
function wrapSegments(segments: string[], maxChars: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const seg of segments) {
    const next = cur ? `${cur} · ${seg}` : seg;
    if (cur && next.length > maxChars) {
      lines.push(cur);
      cur = seg;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines.map((l) => fit(l, maxChars));
}

/** No paths or file contents by construction: only cut-list group names (plugin / MCP server names; anonymisable), generic labels (cardLabel), counts, the version and a date reach the SVG. */
export function renderCard(r: Report, a: AgentReport, o: CardOpts): string {
  const CHAR_EM = o.charEm ?? DEFAULT_CHAR_EM;
  const maxCharsFor = (px: number, fontSize: number) => Math.max(1, Math.floor(px / (fontSize * CHAR_EM)));
  const head = buildHeadline(a, r.scan.window, o.headline ?? "cut") ?? buildHeadline(a, r.scan.window, "total");
  if (!head) throw new Error("nothing measurable to put on a card");
  assertHeadline(head, a, r.scan.window);
  const th = THEMES[o.theme];
  const og = o.size === "og";
  const W = og ? 1200 : 1080;
  const H = og ? 630 : 1080;
  const pad = og ? 48 : 56;
  const innerW = W - pad * 2;
  const font = o.fontFamily ?? CARD_FONT;
  const heroMax = og ? 64 : 72;
  let heroLines = [head.hero];
  let heroSize = Math.min(heroMax, Math.floor(innerW / (head.hero.length * CHAR_EM)));
  // Square cards have the room for a two-line hero: split it at the space nearest the middle when one line would be small.
  if (!og && heroSize < 52 && head.hero.includes(" ")) {
    const mid = head.hero.length / 2;
    const cut = [...head.hero.matchAll(/ /g)].map((m) => m.index!).sort((x, y) => Math.abs(x - mid) - Math.abs(y - mid))[0];
    heroLines = [head.hero.slice(0, cut), head.hero.slice(cut + 1)];
    heroSize = Math.min(heroMax, Math.floor(innerW / (Math.max(...heroLines.map((l) => l.length)) * CHAR_EM)));
  }
  const heroLineH = Math.round(heroSize * 1.12);
  const heroY = og ? 168 : heroLines.length > 1 ? 196 : 214;
  const subSize = og ? 26 : 30;
  const subY = heroY + (heroLines.length - 1) * heroLineH + (og ? 46 : 52);
  const showStrip = !!a.savings && head.id !== "cut-list";
  const tmY = subY + (og ? 36 : 56);
  // footer: wrap on segment boundaries, anchored to the bottom edge
  const unvalidated = a.profile.id.startsWith("claude") || a.profile.id === "cursor-mixed" || a.profile.id === "heuristic";
  const footSize = og ? 17 : 20;
  const footLines = wrapSegments(
    ["prehello", "local-only scan", `estimate band: ${a.profile.band}${unvalidated ? " (unvalidated)" : ""}`, `window ${fmtWindow(r.scan.window)}`, ...(r.partial ? ["PARTIAL scan"] : [])],
    maxCharsFor(innerW, footSize),
  );
  const footLineH = footSize + 6;
  const footTop = H - (og ? 30 : 44) - (footLines.length - 1) * footLineH;
  // Layout flows upward from the footer so a wrapped (2-3 line) footer can never collide with the chips or the treemap.
  const chipH = 38;
  const limit = footTop - footSize - (og ? 14 : 24);
  const stripBlock = showStrip ? (og ? 40 : 52) : 0;
  const tmH = Math.max(og ? 120 : 200, Math.min(og ? 400 : 640, limit - chipH - (og ? 22 : 30) - stripBlock - tmY));
  const stripY = tmY + tmH + (og ? 30 : 42);
  const chipsY = tmY + tmH + (og ? 22 : 30) + stripBlock;

  // Treemap: the same groups as "what to cut" (plugin posthog, 18 Cursor-managed skills, ...) plus the always-on items that are not removable
  // (rules, instruction files). Small tiles are merged into "other" so every visible tile is big enough to read.
  const tiles = cardTiles(a.items, !!o.anonymize);
  const tilesTotal = tiles.reduce((s, t) => s + t.tokens, 0);
  const MAX_TILES = og ? 7 : 8;
  const MIN_SHARE = 0.04;
  const shown = tiles.filter((t, k) => k < MAX_TILES && t.tokens / tilesTotal >= MIN_SHARE);
  const restTiles = tiles.filter((t) => !shown.includes(t));
  if (restTiles.length === 1 && restTiles[0].tokens / tilesTotal >= MIN_SHARE) shown.push(restTiles.pop()!);
  const rest = restTiles.reduce((s, t) => s + t.tokens, 0);
  const cells = shown.map((t, k) => ({ label: t.named ? scrubSecrets(t.label) : t.label, v: t.tokens, fill: FILLS[k % FILLS.length] }));
  if (rest > 0) cells.push({ label: restTiles.length > 1 ? `other (${restTiles.length} smaller)` : "other", v: rest, fill: OTHER_FILL });
  const rects = squarify(cells.map((c) => c.v), pad, tmY, innerW, tmH);
  const totalCells = cells.reduce((s, c) => s + c.v, 0);

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d">`);
  parts.push(`<title id="t">${xmlEscape(head.hero)}</title><desc id="d">${xmlEscape(head.sub)}. Generated by prehello ${xmlEscape(r.tool.version)}. Token counts are estimates.</desc>`);
  parts.push(`<rect width="${W}" height="${H}" fill="${th.bg}"/>`);
  parts.push(`<text x="${pad}" y="${pad + 20}" font-family="${font}" font-size="28" font-weight="700" fill="${th.text}">prehello <tspan font-weight="400" fill="${th.muted}" font-size="20">v${xmlEscape(r.tool.version)} · ${xmlEscape(r.generatedAt.slice(0, 10))}</tspan></text>`);
  if (a.grade) {
    const gx = W - pad - 36;
    const gy = pad + 14;
    parts.push(`<circle cx="${gx}" cy="${gy}" r="34" fill="none" stroke="${th.muted}" stroke-width="3"/>`);
    parts.push(`<text x="${gx}" y="${gy + 16}" text-anchor="middle" font-family="${font}" font-size="46" font-weight="800" fill="${th.text}">${xmlEscape(a.grade.letter)}</text>`);
    parts.push(`<text x="${W - pad}" y="${gy + 54}" text-anchor="end" font-family="${font}" font-size="14" fill="${th.muted}">Context Grade${a.grade.provisional ? " (provisional)" : ""}</text>`);
  }
  heroLines.forEach((line, k) => parts.push(`<text x="${pad}" y="${heroY + k * heroLineH}" font-family="${font}" font-size="${heroSize}" font-weight="800" fill="${th.text}">${xmlEscape(line)}</text>`));
  parts.push(`<text x="${pad}" y="${subY}" font-family="${font}" font-size="${subSize}" fill="${th.muted}">${xmlEscape(fit(head.sub, maxCharsFor(innerW, subSize)))}</text>`);
  rects.forEach((rc) => {
    const c = cells[rc.i];
    const g = 3;
    const rx = rc.x + g / 2,
      ry = rc.y + g / 2,
      rw = Math.max(0, rc.w - g),
      rh = Math.max(0, rc.h - g);
    parts.push(`<rect x="${rx.toFixed(1)}" y="${ry.toFixed(1)}" width="${rw.toFixed(1)}" height="${rh.toFixed(1)}" rx="6" fill="${c.fill}"/>`);
    // label size follows cell size: big cells get a big label, token count and share; small cells get the number only
    const big = rw >= 240 && rh >= 110;
    const mid = rw >= 120 && rh >= 64;
    const lf0 = big ? 26 : mid ? 20 : 15;
    if (rw >= 64 && rh >= 34) {
      const avail = rw - 18;
      // shrink the label to fit before wrapping or truncating it (never below 11 px)
      let lf = Math.max(11, Math.min(lf0, Math.floor(avail / (Math.max(1, c.label.length) * CHAR_EM))));
      let lines = [c.label];
      if (c.label.length * lf * CHAR_EM > avail) {
        // still too wide at the smallest size: wrap onto up to 3 lines at spaces and hyphens, ellipsis only if it still does not fit
        lf = Math.min(lf0, 14);
        const withSub = Math.floor((rh - 14 - (13 + 8)) / (lf + 3));
        const maxLines = Math.min(3, withSub >= 1 ? withSub : Math.max(1, Math.floor((rh - 8) / (lf + 3))));
        lines = wrapLabel(c.label, maxCharsFor(avail, lf), maxLines);
      }
      const lineH = lf + 3;
      const tf = Math.max(13, lf - 4);
      lines.forEach((ln, k) => parts.push(`<text x="${(rx + 10).toFixed(1)}" y="${(ry + lf + 6 + k * lineH).toFixed(1)}" font-family="${font}" font-size="${lf}" font-weight="600" fill="#ffffff">${xmlEscape(ln)}</text>`));
      const subY = ry + lf + 6 + (lines.length - 1) * lineH + tf + 6;
      if (lines.length === 1 ? rh >= lf + tf + 22 : subY <= ry + rh - 6) {
        const pct = totalCells ? ` · ${fmtPct((c.v / totalCells) * 100)}` : "";
        const ty = lines.length === 1 ? ry + lf + tf + 12 : subY;
        parts.push(`<text x="${(rx + 10).toFixed(1)}" y="${ty.toFixed(1)}" font-family="${font}" font-size="${tf}" fill="#ffffff">${xmlEscape(fit(`~${fmtTok(c.v)}${big ? pct : ""}`, maxCharsFor(avail, tf)))}</text>`);
      }
    } else if (rw >= 24 && rh >= 90) {
      // a tall, narrow tile: the name and size read bottom-to-top instead of being dropped
      const tx = rx + rw / 2 + 4.5;
      const ty = ry + rh - 10;
      parts.push(`<text transform="rotate(-90 ${tx.toFixed(1)} ${ty.toFixed(1)})" x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" font-family="${font}" font-size="13" font-weight="600" fill="#ffffff">${xmlEscape(fit(`${c.label} · ~${fmtTok(c.v)}`, maxCharsFor(rh - 20, 13)))}</text>`);
    } else if (rw >= 40 && rh >= 22) {
      parts.push(`<text x="${(rx + 6).toFixed(1)}" y="${(ry + rh / 2 + 5).toFixed(1)}" font-family="${font}" font-size="13" fill="#ffffff">${xmlEscape(fit(`~${fmtTok(c.v)}`, maxCharsFor(rw - 8, 13)))}</text>`);
    }
  });
  if (showStrip && a.savings) {
    const sv = a.savings;
    const kindWord = sv.top.every((c) => c.kind === "mcp") ? "MCP server" : sv.top.some((c) => c.kind === "mcp") ? "skill/plugin/MCP group" : "skill/plugin group";
    const line = `Cut the top ${sv.n} ${kindWord}${sv.n > 1 ? "s" : ""}: save ~${fmtTok(sv.topTokens)} tokens (estimate)`;
    const ss = og ? 22 : 24;
    parts.push(`<text x="${pad}" y="${stripY}" font-family="${font}" font-size="${ss}" font-weight="700" fill="${th.text}">${xmlEscape(fit(line, maxCharsFor(innerW, ss)))}</text>`);
  }
  // chips (only for data that exists)
  const chips: string[] = [];
  // the cut headline does not show the total itself, so the total always appears as the first chip
  if (head.id === "cut-list") chips.push(`always-on ${a.lowerBound ? AT_LEAST + " " : ""}~${fmtTok(a.totals.always.est)} · ${fmtPct((a.totals.always.est / r.scan.window) * 100)} of ${fmtWindow(r.scan.window)}`);
  const mode = (m: "deferred" | "conditional" | "on-demand") => a.totals[m];
  for (const m of ["deferred", "conditional", "on-demand"] as const) if (mode(m).measuredItems) chips.push(`${m} ~${fmtTok(mode(m).est)}`);
  const unm = a.totals.always.unmeasuredItems + a.totals.deferred.unmeasuredItems;
  if (unm) chips.push(`unmeasured: ${unm} item${unm > 1 ? "s" : ""}`);
  if (a.id === "cursor") chips.push("unmeasured: User Rules");
  if (r.partial) chips.unshift("partial scan");
  let cx = pad;
  const chipSize = 18;
  for (const chip of chips) {
    const cw = chip.length * chipSize * CHAR_EM + 28;
    if (cx + cw > W - pad) break;
    parts.push(`<rect x="${cx}" y="${chipsY}" width="${cw.toFixed(0)}" height="${chipH}" rx="19" fill="${th.chip}" stroke="${th.border}"/>`);
    parts.push(`<text x="${(cx + 14).toFixed(0)}" y="${chipsY + 25}" font-family="${font}" font-size="${chipSize}" fill="${th.text}">${xmlEscape(chip)}</text>`);
    cx += cw + 12;
  }
  footLines.forEach((l, k) => parts.push(`<text x="${pad}" y="${footTop + k * footLineH}" font-family="${font}" font-size="${footSize}" fill="${th.muted}">${xmlEscape(l)}</text>`));
  parts.push(`</svg>`);
  return parts.join("\n") + "\n";
}
