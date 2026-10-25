import { AgentReport, Item, LoadMode, Report, Totals } from "../model";
import { fmtInt, fmtPct, fmtTok, fmtWindow, sanitize, shortenLabel, shortenLeft, wrap } from "../util/fmt";
import { displayPath } from "../redact";
import { RUBRIC } from "../analyze/grade";

export interface TermOpts {
  color: boolean;
  width: number;
  verbose: boolean;
  quiet: boolean;
  home: string;
  cwd: string;
}

const MODE_TITLES: Record<LoadMode, string> = {
  always: "ALWAYS ON before hello",
  conditional: "CONDITIONAL (path/dir triggers)",
  deferred: "DEFERRED (stub now, body on demand)",
  "on-demand": "ON-DEMAND (only if invoked)",
  unknown: "UNKNOWN LOAD BEHAVIOUR",
};

const LOOKED_FOR: Array<[string, string]> = [
  ["Claude Code", "~/.claude, ~/.claude.json, `claude` on PATH; CLAUDE.md, .claude/, .mcp.json in the project"],
  ["Cursor", "~/.cursor, Cursor.app, `cursor` on PATH; .cursor/, .cursorrules, AGENTS.md in the project"],
  ["Codex", "~/.codex, `codex` on PATH; AGENTS.md, .codex/, .agents/skills in the project"],
];

const WHERE_LOOKED: Record<string, string> = {
  "claude-code": "CLAUDE.md (project, parent folders, ~/.claude), .claude/{rules,skills,commands}, plugins, .mcp.json, ~/.claude.json",
  cursor: ".cursor/rules (incl. nested), AGENTS.md, .cursorrules, skills folders, ~/.cursor/{skills,plugins,mcp.json}, .cursor/mcp.json",
  codex: "AGENTS.md chain, ~/.codex/{AGENTS.md,config.toml}, .agents/skills, ~/.agents/skills, .codex/config.toml",
};

const AGENT_HINT: Record<string, string> = {
  cursor: "Cursor's User Rules live inside the app, not on disk. Paste them into a file and run with --paste-user-rules <file> to count them.",
};

const KIND_NOUN: Record<string, [string, string]> = {
  instructions: ["instruction file", "instruction files"],
  rule: ["rule", "rules"],
  memory: ["memory file", "memory files"],
  "skills-listing": ["skills listing", "skills listings"],
  "skill-body": ["skill body", "skill bodies"],
  subagents: ["subagents listing", "subagents listings"],
  "rule-description": ["rule description", "rule descriptions"],
  "rule-body": ["rule body", "rule bodies"],
  "mcp-server": ["MCP server entry", "MCP server entries"],
  "user-rules": ["pasted user rules", "pasted user rules"],
};
export function kinds(m: Record<string, number>): string {
  return Object.entries(m)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([k, n]) => `${n} ${(KIND_NOUN[k] ?? [k, k])[n === 1 ? 0 : 1]}`)
    .join(", ");
}

function painter(on: boolean) {
  const w = (open: number, close: number) => (s: string) => (on ? `\u001b[${open}m${s}\u001b[${close}m` : s);
  return { bold: w(1, 22), dim: w(2, 22), red: w(31, 39), yellow: w(33, 39), green: w(32, 39), cyan: w(36, 39) };
}

function bar(frac: number, width: number): string {
  const full = Math.max(0, Math.min(width, frac * width));
  const whole = Math.floor(full);
  const half = full - whole >= 0.5 ? "▌" : "";
  return "█".repeat(whole) + half;
}

function range(t: Totals): string {
  return `${fmtTok(t.low)}–${fmtTok(t.high)}`;
}

/** Summaries by agent for the one-line headline and the card agent choice. */
export function headlineAgents(r: Report): AgentReport[] {
  return r.agents.filter((a) => !a.presentInRepoOnly);
}

function aggregate(items: Item[]): Array<{ label: string; detail?: string; tokens: number | null; low: number; high: number; n: number; notes: string[]; unit: string }> {
  const rows = new Map<string, { label: string; detail?: string; tokens: number | null; low: number; high: number; n: number; notes: string[]; unit: string }>();
  for (const it of items) {
    const key = it.group && it.tokens ? `g:${it.group}` : `i:${it.id}`;
    const cur = rows.get(key);
    const t = it.tokens;
    if (!cur) {
      rows.set(key, { label: it.group && it.tokens ? it.groupLabel ?? it.group : it.label, detail: it.detail, tokens: t ? t.est : null, low: t?.low ?? 0, high: t?.high ?? 0, n: 1, notes: [...it.notes], unit: it.kind === "mcp-server" ? "servers" : "files" });
    } else {
      cur.n++;
      if (t) {
        cur.tokens = (cur.tokens ?? 0) + t.est;
        cur.low += t.low;
        cur.high += t.high;
      }
    }
  }
  return [...rows.values()].sort((a, b) => (b.tokens ?? -1) - (a.tokens ?? -1));
}

function summaryBlock(r: Report, shown: AgentReport[], W: number, p: ReturnType<typeof painter>, verbose: boolean): string[] {
  const out: string[] = [];
  if (!shown.length) return out;
  out.push(p.bold("Measured vs. not measured (always-on items)"));
  const nameW = Math.max(...shown.map((a) => a.name.length));
  for (const a of shown) {
    const c = a.coverage;
    const total = c.alwaysMeasuredItems + c.alwaysUnmeasuredItems;
    let line: string;
    if (!total) {
      const by = a.detectedBy.length ? ` (found via ${a.detectedBy.join(", ")})` : "";
      line = `nothing that loads up front was found${by}`;
    } else {
      line = `measured ${c.alwaysMeasuredItems} of ${total}${c.alwaysFraction !== null ? ` (${Math.round(c.alwaysFraction * 100)}%)` : ""}`;
      if (c.alwaysMeasuredItems) line += `: ${kinds(c.measuredKinds)}`;
    }
    out.push(...wrap(line, W, "  " + a.name.padEnd(nameW) + "  ", " ".repeat(nameW + 6)));
    if (c.alwaysUnmeasuredItems) {
      const names = a.mcpServers.filter((m) => !m.measured).map((m) => m.name);
      const parts = [kinds(c.unmeasuredKinds)];
      const nm = names.length ? ` (${names.slice(0, 4).join(", ")}${names.length > 4 ? `, +${names.length - 4} more` : ""})` : "";
      out.push(...wrap(`NOT measured: ${parts.join("")}${c.unmeasuredKinds["mcp-server"] ? nm : ""}; no token count, never shown as 0`, W, " ".repeat(nameW + 4), " ".repeat(nameW + 6)).map((l) => p.yellow(l)));
    }
  }
  const all = shown.flatMap((a) => a.offenders.map((x) => ({ ...x, name: a.name, always: a.totals.always.est })));
  all.sort((a, b) => b.tokens - a.tokens);
  const top = all.slice(0, verbose ? 10 : 5);
  if (top.length >= 3) {
    out.push("");
    out.push(p.bold("Top offenders (always on, estimates)"));
    const multi = shown.length > 1;
    const maxTok = Math.max(1, top[0].tokens);
    top.forEach((x, i) => {
      const lbl = sanitize(x.label, 200) + (multi ? `  [${x.name}]` : "");
      const share = x.always ? (x.tokens / x.always) * 100 : 0;
      out.push(`  ${String(i + 1).padStart(2)}. ${shortenLabel(lbl, 46).padEnd(46)} ${fmtInt(x.tokens).padStart(7)} ${fmtPct(share).padStart(6)}  ${p.cyan(bar(x.tokens / maxTok, 12))}`);
    });
  }
  out.push("");
  return out;
}

/**
 * "What to cut": the actionable version of the headline. Skills, plugins and MCP servers are the part of the always-on cost
 * you can remove with one click, so say how big that part is and what removing the top few would save. All estimates.
 */
function cutBlock(shown: AgentReport[], window: number, W: number, p: ReturnType<typeof painter>): string[] {
  const rows = shown.filter((a) => a.savings);
  if (!rows.length) return [];
  const out: string[] = [p.bold("What to cut (estimates)")];
  const nameW = Math.max(...rows.map((a) => a.name.length));
  for (const a of rows) {
    const sv = a.savings!;
    const always = a.totals.always.est;
    const lead = `  ${a.name.padEnd(nameW)}  `;
    const pad = " ".repeat(nameW + 4);
    out.push(...wrap(`skills, plugins and MCP servers add ~${fmtTok(sv.groupsTokens)} tokens before hello: ${fmtPct((sv.groupsTokens / always) * 100)} of the measured always-on total, in ${sv.groupsCount} group${sv.groupsCount > 1 ? "s" : ""}.`, W, lead, pad));
    out.push(...wrap(`Top ${sv.n} group${sv.n > 1 ? "s" : ""} = ${fmtPct(sv.pctOfGroups)} of that. Removing ${sv.n > 1 ? "them" : "it"} would save about ${fmtTok(sv.topTokens)} tokens (${fmtPct(sv.pctOfWindow)} of a ${fmtWindow(window)} window); estimate, not a promise.`, W, pad, pad));
    sv.top.forEach((c, i) => {
      const cnt = c.kind === "skills" && c.count > 1 && c.label.startsWith("plugin ") ? ` (${c.count} skills)` : "";
      const lbl = shortenLabel(sanitize(c.label + cnt, 200), Math.max(20, W - nameW - 30)).padEnd(Math.max(20, W - nameW - 30));
      out.push(`${pad}${String(i + 1).padStart(2)}. ${lbl} ${("~" + fmtTok(c.tokens)).padStart(7)}  ${fmtPct((c.tokens / always) * 100).padStart(5)}`);
    });
    if (a.lowerBound) out.push(p.dim(`${pad}(always-on is a lower bound: unmeasured items are not counted here)`));
  }
  out.push("");
  return out;
}

function mcpTail(servers: Array<{ measured: boolean }>): string {
  const un = servers.filter((m) => !m.measured).length;
  if (!un) return "; sizes come from prehello's measured catalog (version-specific, ballpark)";
  if (un === servers.length) return "; tool-schema size unknown (not in the catalog, no server is started)";
  return `; ${servers.length - un} sized from the measured catalog, ${un} unknown (never shown as 0)`;
}

export function renderTerminal(r: Report, o: TermOpts): string {
  const p = painter(o.color);
  const W = Math.max(64, Math.min(o.width, 100));
  const out: string[] = [];
  const dp = (x: string) => displayPath(x, { cwd: o.cwd, home: o.home });
  const win = fmtWindow(r.scan.window);
  const shown = headlineAgents(r);

  out.push(`${p.bold("prehello " + r.tool.version)} · ${dp(r.scan.cwd) === "." ? "this folder" : shortenLeft(sanitize(dp(r.scan.cwd), 400), 60)} + user config · window ${win}`);
  out.push(...wrap(`Token counts are ESTIMATES (${r.scan.tokenizer.method === "bpe-o200k" ? "o200k BPE with per-agent scaling priors" : "chars/3.5 heuristic"}), shown with ~. Not exact for any model.`, W).map((l) => p.dim(l)));
  out.push("");

  if (r.agents.length === 0) {
    out.push(`No coding agents detected on this machine, and no agent files found in ${dp(r.scan.cwd) === "." ? "this folder" : dp(r.scan.cwd)}.`);
    out.push("");
    out.push(p.bold("prehello looked for"));
    for (const [n, t] of LOOKED_FOR) out.push(...wrap(t, W, `  ${n.padEnd(12)} `, " ".repeat(15)));
    out.push("");
    out.push(p.bold("Try"));
    out.push("  prehello ~/code/my-project       scan a project folder (default: the current directory)");
    out.push("  prehello --agent claude-code     treat an agent as in use, to see what it WOULD load");
    out.push("  prehello --help                  all options");
    out.push("");
    out.push(p.dim("Nothing was measured. This is not a score of 0: absence of data is never shown as 0."));
    out.push(...tail(r, o, p, W, false, true));
    return out.join("\n") + "\n";
  }

  // one-line summary
  const sum = shown
    .map((a) => {
      const t = a.totals.always;
      if (!t.measuredItems) return t.unmeasuredItems ? `${a.name} tokens unmeasured` : `${a.name} nothing found`;
      return `${a.name} ${a.lowerBound ? "≥ " : ""}~${fmtTok(t.est)} tokens`;
    })
    .join(" · ");
  if (sum) out.push(...wrap("Before your first message: " + sum, W, "", "  ").map((l, i) => (i === 0 ? p.bold(l.slice(0, 27)) + l.slice(27) : l)));
  out.push("");
  out.push(...cutBlock(shown, r.scan.window, W, p));
  out.push(...summaryBlock(r, shown, W, p, o.verbose));
  if (o.quiet) {
    out.push(...tail(r, { ...o, verbose: false }, p, W, true));
    return out.join("\n") + "\n";
  }

  for (const a of r.agents) {
    if (a.presentInRepoOnly) {
      out.push(...wrap(`── ${a.name}: agent files exist in this repo but ${a.name} was not found on this machine; excluded from headline and card (use --agent ${a.id} to include).`, W, "", "   ").map((l) => p.dim(l)));
      out.push("");
      continue;
    }
    const grade = a.grade ? `  Grade ${a.grade.letter}${a.grade.provisional ? (a.grade.cappedAt ? " (provisional, capped)" : " (provisional)") : ""}` : "";
    const head = `── ${a.name} `;
    out.push(p.bold(head + "─".repeat(Math.max(2, W - head.length - grade.length))) + (a.grade ? p.bold(grade) : ""));
    out.push(...wrap(`estimate model: ${a.profile.label}; band ${a.profile.band}`, W, "   ", "      ").map((l) => p.dim(l)));
    for (const mode of ["always", "conditional", "deferred", "on-demand", "unknown"] as LoadMode[]) {
      const items = a.items.filter((i) => i.loadMode === mode);
      if (!items.length) continue;
      const t = a.totals[mode];
      const lower = mode === "always" ? (a.lowerBound ? "≥ " : "") : t.unmeasuredItems > 0 ? "≥ " : "";
      let line: string;
      if (!t.measuredItems) line = `${p.bold(MODE_TITLES[mode])}   unmeasured only (${t.unmeasuredItems} item${t.unmeasuredItems > 1 ? "s" : ""}) — NOT zero`;
      else {
        line = `${p.bold(MODE_TITLES[mode])}   ${lower}~${fmtTok(t.est)} tokens (${range(t)})`;
        if (mode === "always" && a.percentOfWindowAlways !== null) line += `  ≈ ${fmtPct(a.percentOfWindowAlways)} of ${win}`;
        if (t.unmeasuredItems) line += p.yellow(`  + ${t.unmeasuredItems} unmeasured`);
      }
      out.push(line);
      const rows = aggregate(items);
      const limit = o.verbose || mode !== "always" ? (mode === "always" ? 50 : 6) : 8;
      const maxTok = Math.max(1, ...rows.map((x) => x.tokens ?? 0));
      const barW = W >= 96 ? 20 : 12;
      const labelW = Math.min(Math.max(30, W - 24 - barW), Math.max(...rows.map((x) => (x.label + (x.detail ? " " + x.detail : "") + (x.n > 1 ? ` (${x.n} ${x.unit})` : "")).length), 10));
      const measuredRows = rows.filter((x) => x.tokens !== null);
      const unmeasuredRows = rows.filter((x) => x.tokens === null).slice(0, o.verbose ? 40 : 5);
      for (const row of [...measuredRows.slice(0, limit), ...unmeasuredRows]) {
        let lbl = row.label + (row.detail ? " " + row.detail : "") + (row.n > 1 ? ` (${row.n} ${row.unit})` : "");
        lbl = shortenLabel(sanitize(lbl, 300), labelW).padEnd(labelW);
        if (row.tokens === null) out.push(`   ${lbl}  ${p.yellow("unmeasured".padStart(9))}`);
        else {
          const share = t.est ? (row.tokens / t.est) * 100 : 0;
          out.push(`   ${lbl}  ${fmtInt(row.tokens).padStart(9)}  ${fmtPct(share).padStart(6)}  ${p.cyan(bar(row.tokens / maxTok, barW))}`);
        }
      }
      if (measuredRows.length > limit) out.push(p.dim(`   … ${measuredRows.length - limit} more (use --verbose)`));
      const unmTotal = rows.filter((x) => x.tokens === null).length;
      if (unmTotal > unmeasuredRows.length) out.push(p.dim(`   … ${unmTotal - unmeasuredRows.length} more unmeasured (use --verbose)`));
      if (o.verbose) {
        for (const it of items) for (const n of it.notes) out.push(...wrap(`· ${shortenLabel(sanitize(it.label, 300), 50)}: ${sanitize(n, 300)}`, W, "     ", "       ").map((l) => p.dim(l)));
        const unm = items.filter((i) => i.tokens === null);
        for (const it of unm) out.push(...wrap(`· ${shortenLabel(sanitize(it.label, 300), 50)} unmeasured: ${it.unmeasuredReason}`, W, "     ", "       ").map((l) => p.dim(l)));
      }
    }
    if (a.gradeNote) out.push(p.dim(`   ${a.gradeNote}`));
    if (!a.items.length) {
      const by = a.detectedBy.length ? ` (via ${a.detectedBy.join(", ")})` : "";
      out.push(p.bold(`   ${a.name} is installed${by}, but nothing that loads before hello was found.`));
      out.push(...wrap(`This is NOT a score of 0 and NOT proof the agent loads nothing: it still loads its own system prompt and tools. Looked in: ${WHERE_LOOKED[a.id]}.`, W, "   ", "   ").map((l) => p.dim(l)));
      if (AGENT_HINT[a.id]) out.push(...wrap(AGENT_HINT[a.id], W, "   ", "   ").map((l) => p.dim(l)));
    }
    if (a.mcpServers.length) {
      const names = a.mcpServers.map((m) => m.name);
      const shownN = names.slice(0, o.verbose ? 40 : 8).join(", ");
      out.push(...wrap(`MCP servers configured (${a.mcpServers.length}): ${shownN}${names.length > (o.verbose ? 40 : 8) ? `, +${names.length - (o.verbose ? 40 : 8)} more` : ""}${mcpTail(a.mcpServers)}`, W, "   ", "      ").map((l) => p.dim(l)));
    }
    out.push(...wrap("not measurable from disk: " + a.unmeasuredBanner.join(" · "), W, "   ", "      ").map((l) => p.dim(l)));
    out.push("");
  }
  out.push(...tail(r, o, p, W));
  return out.join("\n") + "\n";
}

function tail(r: Report, o: TermOpts, p: ReturnType<typeof painter>, W: number, compact = false, firstRun = false): string[] {
  const out: string[] = [];
  if (!compact && r.findings.length) {
    out.push(p.bold(`Findings (${r.findings.length})`));
    for (const f of r.findings.slice(0, o.verbose ? 100 : 10)) {
      const sav = f.savingsTokens ? `  −~${fmtInt(f.savingsTokens)} tokens` : "";
      out.push(...wrap(sanitize(f.message, 400) + sav, W - 3, ` ${f.severity === "warn" ? p.yellow("⚠") : "ℹ"} `, "   "));
    }
    if (r.findings.length > 10 && !o.verbose) out.push(p.dim(`   … ${r.findings.length - 10} more (use --verbose)`));
    const total = r.findings.reduce((s, f) => s + (f.savingsTokens ?? 0), 0);
    if (total) out.push(p.dim(` Potential always-on savings (estimate): ~${fmtInt(total)} tokens. Run --fix for the plan; nothing is changed automatically.`));
    out.push("");
  }
  if (r.scan.fixturesSkipped) {
    const n = r.scan.fixturesSkipped;
    out.push(...wrap(`ℹ Skipped ${n} fixture folder${n > 1 ? "s" : ""} with agent files (use --include-fixtures).`, W, " ", "   ").map((l) => p.dim(l)));
    out.push("");
  }
  if (!compact && o.verbose && r.excluded.length) {
    out.push(p.bold(`Not loaded / ignored (${r.excluded.length})`));
    for (const e of r.excluded) out.push(...wrap(`${e.agent}: ${displayPath(e.path, { cwd: o.cwd, home: o.home })} — ${sanitize(e.reason, 200)}`, W, "   ", "      "));
    out.push("");
  }
  if (r.warnings.length) {
    out.push(p.yellow(`Partial results (${r.warnings.length} source${r.warnings.length > 1 ? "s" : ""} skipped):`));
    for (const w of r.warnings) out.push(...wrap(sanitize(w, 300), W, "   ", "      "));
    out.push("");
  }
  if (!compact && !firstRun) {
    out.push(...wrap("Never measured: " + r.notMeasurable.join("; ") + ".", W).map((l) => p.dim(l)));
    const g = r.agents.filter((a) => a.grade).sort((a, b) => (b.totals.always.est - a.totals.always.est))[0];
    if (g?.grade) out.push(...wrap(`Context Grade (${g.name}): ${g.grade.letter}${g.grade.provisional ? (g.grade.cappedAt ? ` (provisional, capped at ${g.grade.cappedAt}: some always-loaded items are unmeasured)` : " (provisional: some always-loaded items are unmeasured)") : ""} — heuristic, not a standard. See: prehello explain grade`, W).map((l) => p.dim(l)));
  }
  return out;
}

export function renderRubric(): string {
  return ["Context Grade rubric", "", ...RUBRIC.map((l) => "• " + l)].join("\n") + "\n";
}
