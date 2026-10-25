import path from "node:path";
import { Ctx } from "../context";
import { AgentId, Confidence, Item, Scope } from "../model";
import { listDir, isDir } from "../fs-safe";
import { asList, asString, FmValue, parseFrontmatter } from "../text/frontmatter";
import { cmp } from "../util/fmt";

/** One discovered SKILL.md (or command .md). Holds text only transiently; nothing here is ever printed. */
export interface SkillRec {
  name: string;
  file: string;
  realPath: string;
  desc: string;
  when: string;
  body: string;
  fm: Record<string, FmValue>;
  /** frontmatter `paths:` / `globs:` (Cursor: path-scoped skill; Claude: path-scoped) */
  scopedTo: string[];
  disableModelInvocation: boolean;
  /** Plugin (or other named source) this skill came from; lets the report say which plugin the listing cost belongs to. */
  source?: string;
}

export const MAX_SKILLS_PER_DIR = 400;

function firstLine(body: string): string {
  for (const l of body.split("\n")) {
    const t = l.trim().replace(/^#+\s*/, "");
    if (t) return t;
  }
  return "";
}

export function toRec(name: string, file: string, realPath: string, text: string): SkillRec {
  const fm = parseFrontmatter(text);
  const desc = asString(fm.data.description).trim() || firstLine(fm.body);
  const dmi = fm.data["disable-model-invocation"];
  return {
    name: (asString(fm.data.name).trim() || name).slice(0, 200),
    file,
    realPath,
    desc,
    when: asString(fm.data.when_to_use).trim(),
    body: fm.body,
    fm: fm.data,
    scopedTo: [...asList(fm.data.paths), ...asList(fm.data.globs)],
    disableModelInvocation: dmi === true || (typeof dmi === "string" && /^(true|yes|on|1)$/i.test(dmi.trim())), // Claude Code docs: booleans accept yes/no/on/off/1/0
  };
}

export interface DiscoverOpts {
  jail?: string;
  /** Cursor discovers SKILL.md recursively; Claude Code and Codex look one level down. */
  recursive?: boolean;
  maxDepth?: number;
}

/** Find <dir>/<name>/SKILL.md (and, if recursive, deeper). Hidden directories (.trash, .system, …) are skipped. */
export function discoverSkills(ctx: Ctx, dir: string, o: DiscoverOpts = {}): SkillRec[] {
  const out: SkillRec[] = [];
  const maxDepth = o.maxDepth ?? 4;
  const visit = (d: string, depth: number) => {
    for (const e of listDir(d)) {
      if (out.length >= MAX_SKILLS_PER_DIR) {
        ctx.warn(`${ctx.display(dir)}: more than ${MAX_SKILLS_PER_DIR} skills; only the first ${MAX_SKILLS_PER_DIR} were counted, so skill totals here are a lower bound`);
        return;
      }
      if (e.name.startsWith(".")) continue;
      const p = path.join(d, e.name);
      const isD = e.isDirectory() || (e.isSymbolicLink() && isDir(p));
      if (!isD) continue;
      const f = path.join(p, "SKILL.md");
      const r = ctx.read(f, o.jail ? { jail: o.jail } : {});
      if (r.ok) out.push(toRec(e.name, f, r.realPath, r.text));
      else if (o.recursive && depth < maxDepth && e.isDirectory()) visit(p, depth + 1);
    }
  };
  visit(dir, 0);
  return out.sort((a, b) => cmp(a.file, b.file));
}

export interface SkillItemsSpec {
  agent: AgentId;
  dir: string;
  scope: Scope;
  /** Short plural label fragment, e.g. "user", "project", "plugin foo". */
  tag: string;
  recs: SkillRec[];
  /** The text the agent would list for this skill, or null if it is NOT in the listing (hidden from the model). */
  lineFor: (r: SkillRec) => string | null;
  /** Listing load mode: "always" normally; "conditional" for path-scoped / nested skills. */
  listingMode: "always" | "conditional";
  confidence: Confidence;
  evidence: { docUrl: string; verifiedAt: string };
  notes: string[];
  group?: string;
  cardLabel?: string;
}

/**
 * Turn a set of skills into: a listing item (name+description, loads up front), a body item (loads when the skill
 * is used) and an on-demand item for skills the model cannot see (disable-model-invocation / overrides).
 */
export function skillItems(ctx: Ctx, s: SkillItemsSpec): Item[] {
  const listed: Array<{ r: SkillRec; line: string }> = [];
  const hidden: SkillRec[] = [];
  for (const r of s.recs) {
    const line = s.lineFor(r);
    if (line === null) hidden.push(r);
    else listed.push({ r, line });
  }
  const items: Item[] = [];
  const noun = (k: number) => `skill${k === 1 ? "" : "s"}`;
  const fromTag = s.tag.startsWith("from ");
  const phrase = (k: number) => (fromTag ? `${k} ${noun(k)} ${s.tag}` : `${k} ${s.tag} ${noun(k)}`);
  const bodyPhrase = (k: number) => (fromTag ? `${k} ${noun(k)} ${s.tag}` : `${k} ${s.tag}`);
  const base = { agent: s.agent, path: s.dir, scope: s.scope, evidence: s.evidence, confidence: s.confidence };
  if (listed.length) {
    const text = listed.map((l) => l.line).join("\n") + "\n";
    const raw = ctx.count(`skills-l|${s.agent}|${s.dir}|${text.length}`, text);
    const prof = ctx.profile(s.agent);
    const perAll = listed.map((l) => ({ label: sanitizeLabel(l.r.name), source: l.r.source, tokens: prof.apply(ctx.counter.count(l.line + "\n")).est }));
    const per = [...perAll].sort((a, b) => b.tokens - a.tokens || cmp(a.label, b.label)).slice(0, 8).map(({ label, tokens }) => ({ label, tokens }));
    const it = ctx.makeItem({
      ...base,
      kind: "skills-listing",
      loadMode: s.listingMode,
      raw,
      chars: text.length,
      label: `Skills listing (${phrase(listed.length)})`,
      cardLabel: s.cardLabel ?? "skills listing",
      notes: s.notes,
      group: s.group,
    });
    it.breakdown = per;
    // "What to cut" parts: one per plugin (or, without a plugin, the whole group), scaled so they add up to the item's estimate.
    if (it.tokens) {
      const groups = new Map<string, { tokens: number; count: number }>();
      for (const x of perAll) {
        const key = x.source ? `plugin ${sanitizeLabel(x.source)}` : phrase(listed.length);
        const g = groups.get(key) ?? { tokens: 0, count: 0 };
        g.tokens += x.tokens;
        g.count++;
        groups.set(key, g);
      }
      const sum = [...groups.values()].reduce((a, g) => a + g.tokens, 0);
      const k = sum > 0 ? it.tokens.est / sum : 1;
      it.parts = [...groups.entries()]
        .map(([name, g]) => ({ name, tokens: Math.round(g.tokens * k), count: g.count }))
        .filter((x) => x.tokens > 0)
        .sort((a, b) => b.tokens - a.tokens || cmp(a.name, b.name));
    }
    items.push(it);
  }
  const bodyOf = (rs: SkillRec[]) => rs.map((r) => r.body).join("\n") + "\n";
  const visible = listed.map((l) => l.r);
  if (visible.length) {
    const text = bodyOf(visible);
    items.push(
      ctx.makeItem({
        ...base,
        kind: "skill-body",
        loadMode: "deferred",
        raw: ctx.count(`skills-b|${s.agent}|${s.dir}|${text.length}`, text),
        chars: text.length,
        label: `Skill bodies (${bodyPhrase(visible.length)})`,
        cardLabel: "skill bodies",
        notes: ["loaded only when a skill is used; supporting files in the skill folder are not counted"],
      }),
    );
  }
  if (hidden.length) {
    const text = bodyOf(hidden);
    items.push(
      ctx.makeItem({
        ...base,
        kind: "skill-body",
        loadMode: "on-demand",
        raw: ctx.count(`skills-h|${s.agent}|${s.dir}|${text.length}`, text),
        chars: text.length,
        label: `Skills hidden from the model (${bodyPhrase(hidden.length)}, manual invoke only)`,
        cardLabel: "manual-only skills",
        notes: ["not in the listing; the body loads only if you invoke the skill yourself"],
      }),
    );
  }
  return items;
}

function sanitizeLabel(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?").slice(0, 60);
}

