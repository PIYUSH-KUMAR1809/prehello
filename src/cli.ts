#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scan, VERSION } from "./scan";
import { AGENT_NAMES, ALL_AGENTS, AgentId } from "./model";
import { renderTerminal, renderRubric } from "./render/terminal";
import { renderFix } from "./render/fix";
import { toJson } from "./render/json";
import { pickCardAgent, renderCard } from "./render/card";
import { svgToPng, PngUnavailableError, PNG_FONT_FAMILY, PNG_CHAR_EM } from "./render/png";
import { renderMarkdown } from "./render/markdown";
import { renderSarif } from "./render/sarif";
import { decodeUserText, resolveHomeDir, toAscii, unicodeSupported } from "./platform";
import { parseWindow, fmtTok } from "./util/fmt";
import { isDir, realpathOrSelf } from "./fs-safe";
import { safeWrite, SafeWriteError, describeWriteError, MD_MARKER_PREFIX, OutputKind } from "./safe-write";
import { loadSpec } from "./spec";

const HELP = `prehello ${VERSION} — what your coding agent loads before you say hello.
Local-only, read-only scan. No network, no telemetry, no API key. Token counts are ESTIMATES.

Usage:
  prehello [path] [options]
  prehello explain grade        print the Context Grade rubric

Options:
  --agent <list>        comma list of: claude-code, cursor, codex (forces them "in use")
  --window <n|200k|1m>  context window for percentages (default 200k)
  --json                print the report as JSON to stdout (versioned schema)
  --json=<file>         also write the JSON to <file>
  --redact              strict JSON: no paths or names (share-safe)
  --card[=<file>]       write a share card (no paths or file contents). The file extension picks the format:
                        .svg (default name prehello-card.svg) or .png (prehello-card.png)
                        write the file name with "=": --card=card.png (a space, "--card card.png", is not accepted)
  --markdown[=<file>]   a shareable Markdown report (title, headline, tables, what to cut, measured vs not measured) for a
                        GitHub issue / PR / README / Slack. Without a file it is printed to stdout INSTEAD of the terminal
                        report (pipe it: prehello --markdown | pbcopy); with a file (.md or .markdown) it is written there
                        and the terminal report is still printed. No paths, file contents or finding texts, ever.
  --markdown-compact    the short version for a PR comment: headline, one line per agent, the first things to cut
                        (implies --markdown; combine with --markdown=<file> to save it)
  --sarif[=<file>]      SARIF 2.1.0 for GitHub code scanning / IDEs (rules PH001-PH011: large always-on files, heavy plugins and MCP servers,
                        over --max-tokens, unmeasured items, duplicates, over-long / truncated / ignored files, possible secrets).
                        Without a file it is printed to stdout INSTEAD of the terminal report; with a file (.sarif or .sarif.json)
                        it is written there and the terminal report is still printed. File locations only for files inside the
                        scanned folder (relative to %SRCROOT%: run it from the repository root); never home or user-config paths.
  --card-anonymize      show plugin and MCP server names on the card and in the Markdown report as "plugin 1" / "MCP server 1"
                        (implied by --redact; --anonymize is the same flag). In SARIF, --redact also drops every file location.
  --card-format svg|png format when --card has no file name (default svg); must match the extension if both are given
  --card-theme dark|light     --card-size og|square     --card-agent <id>
  --card-scale 1|2      PNG only: 1 = 1200x630 (square 1080x1080), 2 = double that, sharper (default 2)
  --card-headline cut|total   (card and Markdown report) lead with "skills/plugins cost ~X before hello; cutting the top N saves ~Y"
                        (default; falls back to the total when there is no meaningful saving) or always with
                        the always-on total
  --force               let --json=<file> / --card=<file> / --markdown=<file> replace an existing file that prehello did not write.
                        Symlinks are never written through, with or without --force.
  --max-tokens <n|16k>  CI gate: exit 2 if the always-on token count (a lower bound when anything is
                        unmeasured) of any agent in use is above n. Compares the central estimate.
  --fix                 print a dry-run fix plan (changes nothing)
  --tokenizer auto|heuristic  --claude-profile current|legacy
  --no-bundled-catalog  ignore the measured MCP weights that ship with prehello
  --mcp-catalog <file>  extra pre-measured MCP weights (see spec/mcp-weights.json)
  --paste-user-rules <file|->  count text you pasted for rules that live inside an app
                        (Cursor "User Rules"). Read-only; the text is counted, never printed.
  --scan-budget-mb <n>  stop reading after n MiB in total (default 64); the report is then marked PARTIAL
  --scan-budget-ms <n>  stop walking/reading after n ms (default 20000); a safety net, so it is the one
                        limit that can vary run to run on a slow disk
  --include-fixtures    also look inside test-fixture folders (fixtures, __fixtures__, fixture, testdata, test-data, __mocks__,
                        __snapshots__, and snapshots/golden under test/spec/e2e folders) for nested AGENTS.md, CLAUDE.md,
                        .cursor/rules and skills. By default they are skipped (no agent loads them) and the report says how many.
                        Scanning a folder that is itself inside a fixtures folder never skips anything.
  --cwd <dir>           simulate launching the agent from <dir>
  --ascii               plain ASCII output (no block characters or arrows); automatic in terminals that cannot draw them
                        (Linux console, classic Windows console). PREHELLO_ASCII=1 does the same.
  --no-grade  --no-color  --quiet  --verbose  --about-specs  --version  --help

Output files (--json=<file>, --card=<file>, --markdown=<file>, --sarif=<file>): a symlink is never followed; an existing file is only replaced
if it is a previous prehello output (or with --force).

Scan budget: at most ~64 MiB read and ~20 s of walking per run, then the scan stops, warns, and every total is a
lower bound. Files over 4 MiB are skipped (Claude Code skips them at startup too).

PNG cards need the optional package @resvg/resvg-wasm. If it is not installed, prehello prints how to install it, writes no card,
exits 1, and everything else you asked for (report, --json, --markdown) is still produced. An SVG card never needs it.

Windows: the home folder is %USERPROFILE%; use --markdown=<file> or --json=<file> rather than shell redirection (Windows PowerShell 5
re-encodes redirected output as UTF-16). Works the same on Linux, macOS and Windows.

Exit codes: 0 ok · 1 error (incl. PNG engine missing) · 2 --max-tokens exceeded · 3 partial (some sources unreadable/skipped/budget hit; report still printed)
  (2 wins over 3 when both apply)
`;

interface Args {
  flags: Map<string, string | true>;
  positional: string[];
}

const VALUE_FLAGS = new Set(["agent", "window", "tokenizer", "claude-profile", "card-theme", "card-size", "card-agent", "cwd", "mcp-catalog", "ceiling", "managed-dir", "system-root", "paste-user-rules", "card-headline", "card-format", "card-scale", "png-engine", "max-tokens", "scan-budget-mb", "scan-budget-ms"]);
const BOOL_FLAGS = new Set(["json", "card", "redact", "fix", "no-grade", "no-color", "quiet", "verbose", "about-specs", "version", "help", "no-redact", "no-bundled-catalog", "force", "card-anonymize", "anonymize", "markdown", "markdown-compact", "sarif", "ascii", "include-fixtures"]);

function parseArgs(argv: string[]): Args | string {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-h") {
      flags.set("help", true);
      continue;
    }
    if (a === "-v" || a === "-V") {
      flags.set("version", true);
      continue;
    }
    if (a.length > 1 && a.startsWith("-") && !a.startsWith("--")) return `unknown option ${a} (try --help)`;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    const inline = eq === -1 ? undefined : a.slice(eq + 1);
    if (VALUE_FLAGS.has(name)) {
      const v = inline ?? argv[++i];
      if (v === undefined || (inline === undefined && v.startsWith("--"))) return `option --${name} needs a value`;
      if (v === "" && name !== "paste-user-rules") return `option --${name} needs a value`;
      flags.set(name, v);
    } else if (BOOL_FLAGS.has(name)) {
      if (inline !== undefined && name !== "json" && name !== "card" && name !== "markdown" && name !== "sarif") return `option --${name} does not take a value`;
      if (inline === "" && name === "json") return "--json= needs a file name (for stdout, write --json with no =)";
      flags.set(name, inline ?? true);
    } else return `unknown option --${name} (try --help)`;
  }
  return { flags, positional };
}

function fail(msg: string): never {
  process.stderr.write(`prehello: ${msg}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  if (typeof parsed === "string") return fail(parsed);
  const { flags, positional } = parsed;
  if (flags.has("help")) return void process.stdout.write(HELP);
  if (flags.has("version")) return void process.stdout.write(VERSION + "\n");
  if (flags.has("about-specs")) {
    for (const id of ALL_AGENTS) {
      const s = loadSpec(id);
      process.stdout.write(`${AGENT_NAMES[id]}: verifiedAt ${s.verifiedAt}\n  ${s.verifiedNote}\n  docs: ${Object.values(s.docs).join(" ")}\n`);
    }
    return;
  }
  if (positional[0] === "explain") {
    if (positional[1] === "grade") return void process.stdout.write(renderRubric());
    return fail("usage: prehello explain grade");
  }
  if (positional[0] === "ci" || positional[0] === "diff" || positional[0] === "calibrate") return fail(`'${positional[0]}' is not part of 0.1 (planned for 0.2)`);
  if (positional.length > 1) return fail("at most one path argument is supported");

  const env = process.env;
  const target = (flags.get("cwd") as string | undefined) ?? positional[0] ?? process.cwd();
  const cwdAbs = path.resolve(target);
  if (!isDir(cwdAbs)) {
    if (flags.get("card") === true && positional[0] && /\.(svg|png)$/i.test(positional[0])) return fail(`not a directory: ${target}. To name the card file write --card=${positional[0]} (with "=", no space)`);
    return fail(`not a directory: ${target}`);
  }
  const cwd = realpathOrSelf(cwdAbs);
  // Windows: %USERPROFILE% (what the agents use), not HOME (Git Bash sets a POSIX-style "/c/Users/me" Node cannot open).
  const home = realpathOrSelf(resolveHomeDir(env, process.platform, os.homedir));

  let window = 200_000;
  if (flags.has("window")) {
    const w = parseWindow(String(flags.get("window")));
    if (!w) return fail("--window must look like 200k, 1m or 128000");
    window = w;
  }
  const tokenizer = String(flags.get("tokenizer") ?? "auto");
  if (tokenizer === "exact") return fail("--tokenizer exact (network) is not part of 0.1; this build never makes network calls");
  if (tokenizer !== "auto" && tokenizer !== "heuristic") return fail("--tokenizer must be auto or heuristic");
  const cp = String(flags.get("claude-profile") ?? "current");
  if (cp !== "current" && cp !== "legacy") return fail("--claude-profile must be current or legacy");
  let agents: AgentId[] | undefined;
  if (flags.has("agent")) {
    const list = String(flags.get("agent")).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!list.length) return fail("--agent needs at least one of: " + ALL_AGENTS.join(", "));
    const bad = list.filter((x) => !ALL_AGENTS.includes(x as AgentId));
    if (bad.length) return fail(`unknown agent '${bad[0]}' (supported in 0.1: ${ALL_AGENTS.join(", ")})`);
    agents = list as AgentId[];
  }
  const cardTheme = String(flags.get("card-theme") ?? "dark");
  const cardSize = String(flags.get("card-size") ?? "og");
  if (!["dark", "light"].includes(cardTheme)) return fail("--card-theme must be dark or light");
  if (!["og", "square"].includes(cardSize)) return fail("--card-size must be og or square");

  const cardHeadline = String(flags.get("card-headline") ?? "cut");
  if (!["total", "cut"].includes(cardHeadline)) return fail("--card-headline must be total or cut");
  const cardScaleRaw = String(flags.get("card-scale") ?? "2");
  if (!["1", "2"].includes(cardScaleRaw)) return fail("--card-scale must be 1 or 2");
  const cardScale = Number(cardScaleRaw) as 1 | 2;
  const fmtFlag = flags.has("card-format") ? String(flags.get("card-format")).toLowerCase() : undefined;
  if (fmtFlag !== undefined && !["svg", "png"].includes(fmtFlag)) return fail("--card-format must be svg or png");
  if (flags.has("png-engine") && flags.get("png-engine") !== "none") return fail("--png-engine only accepts 'none' (test hook)");
  let cardFile = "";
  let cardFormat: "svg" | "png" = "svg";
  if (flags.get("card") !== undefined) {
    const cf = flags.get("card");
    if (typeof cf === "string") {
      const ext = /\.(svg|png)$/i.exec(cf)?.[1].toLowerCase() as "svg" | "png" | undefined;
      if (!ext) return fail("--card file name must end in .svg or .png");
      if (fmtFlag && fmtFlag !== ext) return fail(`--card-format ${fmtFlag} does not match the file name ${cf}`);
      cardFile = cf;
      cardFormat = ext;
    } else {
      cardFormat = (fmtFlag as "svg" | "png" | undefined) ?? "svg";
      cardFile = `prehello-card.${cardFormat}`;
    }
  } else if (fmtFlag) return fail("--card-format needs --card");
  const mdFlag = flags.get("markdown");
  const mdCompact = flags.has("markdown-compact");
  let mdFile = "";
  if (typeof mdFlag === "string") {
    if (!/\.(md|markdown)$/i.test(mdFlag)) return fail("--markdown file name must end in .md or .markdown (for stdout, write --markdown with no file name)");
    mdFile = mdFlag;
  }
  const mdStdout = mdFile === "" && (mdFlag !== undefined || mdCompact);
  const sarifFlag = flags.get("sarif");
  let sarifFile = "";
  if (typeof sarifFlag === "string") {
    if (!/\.sarif(\.json)?$/i.test(sarifFlag)) return fail("--sarif file name must end in .sarif or .sarif.json (for stdout, write --sarif with no file name)");
    sarifFile = sarifFlag;
  }
  const sarifStdout = sarifFlag === true;
  if (mdStdout && flags.get("json") === true) return fail("--json and --markdown both want standard output; give one of them a file: --markdown=report.md or --json=report.json");
  if (mdStdout && flags.has("fix")) return fail("--fix and --markdown both want standard output; give the Markdown report a file: --markdown=report.md");
  if (sarifStdout && flags.get("json") === true) return fail("--json and --sarif both want standard output; give one of them a file: --sarif=report.sarif or --json=report.json");
  if (sarifStdout && mdStdout) return fail("--markdown and --sarif both want standard output; give one of them a file: --sarif=report.sarif or --markdown=report.md");
  if (sarifStdout && flags.has("fix")) return fail("--fix and --sarif both want standard output; give the SARIF report a file: --sarif=report.sarif");
  let maxTokens: number | undefined;
  if (flags.has("max-tokens")) {
    const m = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(String(flags.get("max-tokens")).trim());
    if (!m) return fail("--max-tokens must look like 16000 or 16k");
    maxTokens = Math.round(parseFloat(m[1]) * (m[2].toLowerCase() === "k" ? 1000 : m[2].toLowerCase() === "m" ? 1_000_000 : 1));
  }
  const force = flags.has("force");
  const posNum = (name: string): number | undefined | string => {
    if (!flags.has(name)) return undefined;
    const raw = String(flags.get(name));
    const n = Number(raw);
    return /^\d+(\.\d+)?$/.test(raw) && n > 0 ? n : `--${name} must be a positive number`;
  };
  const budgetMb = posNum("scan-budget-mb");
  const budgetMs = posNum("scan-budget-ms");
  if (typeof budgetMb === "string") return fail(budgetMb);
  if (typeof budgetMs === "string") return fail(budgetMs);

  let pastedUserRules: string | undefined;
  if (flags.has("paste-user-rules")) {
    const src = String(flags.get("paste-user-rules"));
    try {
      if (src === "-") {
        if (process.stdin.isTTY) return fail("--paste-user-rules - reads standard input; pipe the text in (e.g. pbpaste | prehello --paste-user-rules -) or pass a file");
        pastedUserRules = decodeUserText(fs.readFileSync(0)).replace(/\r\n/g, "\n");
      } else {
        const st = fs.statSync(src);
        if (!st.isFile()) return fail(`--paste-user-rules: not a file: ${src}`);
        if (st.size > 1024 * 1024) return fail("--paste-user-rules: file is larger than 1 MB");
        pastedUserRules = decodeUserText(fs.readFileSync(src)).replace(/\r\n/g, "\n");
      }
    } catch (e) {
      return fail(`--paste-user-rules: could not read ${src === "-" ? "standard input" : src} (${(e as NodeJS.ErrnoException).code ?? "error"})`);
    }
    if (pastedUserRules.length > 1024 * 1024) return fail("--paste-user-rules: text is larger than 1 MB");
    if (!pastedUserRules.trim()) return fail("--paste-user-rules: the text is empty");
  }

  const report = scan({
    cwd,
    home,
    env,
    platform: process.platform,
    ceiling: flags.has("ceiling") ? realpathOrSelf(String(flags.get("ceiling"))) : undefined,
    managedDir: flags.has("managed-dir") ? String(flags.get("managed-dir")) : undefined,
    noBundledCatalog: flags.has("no-bundled-catalog"),
    systemRoot: flags.has("system-root") ? path.resolve(String(flags.get("system-root"))) : undefined,
    pastedUserRules,
    window,
    tokenizer,
    claudeProfile: cp,
    includeFixtures: flags.has("include-fixtures"),
    agents,
    catalogPath: flags.has("mcp-catalog") ? path.resolve(String(flags.get("mcp-catalog"))) : undefined,
    now: new Date(),
    maxScanBytes: budgetMb === undefined ? undefined : Math.round(budgetMb * 1048576),
    maxScanMs: budgetMs,
    noGrade: flags.has("no-grade"),
  });

  const protectedPaths = new Set(report.agents.flatMap((a) => a.items.map((i) => realpathOrSelf(i.path))));
  const write = (file: string, content: string | Buffer, what: string, kind: OutputKind): void => {
    const abs = path.resolve(file);
    if (protectedPaths.has(realpathOrSelf(abs))) return fail(`refusing to overwrite a scanned context file with ${what}: ${file}`);
    try {
      safeWrite(abs, content, { kind, force });
    } catch (e) {
      if (e instanceof SafeWriteError) return fail(`${what} not written to ${file}: ${e.message}`);
      return fail(`could not write ${what} to ${file}: ${describeWriteError((e as NodeJS.ErrnoException).code)}`);
    }
  };

  const strict = flags.has("redact");
  const jsonFlag = flags.get("json");
  const color = !flags.has("no-color") && !env.NO_COLOR && env.TERM !== "dumb" && !!process.stdout.isTTY;
  const asciiOut = flags.has("ascii") || env.PREHELLO_ASCII === "1" || (!!process.stdout.isTTY && !unicodeSupported(env, process.platform));
  const term = (t: string): string => (asciiOut ? toAscii(t) : t);
  const width = Math.min(process.stdout.columns || 80, 100);
  const jsonText = jsonFlag !== undefined ? JSON.stringify(toJson(report, { cwd, home }, strict), null, 2) + "\n" : "";

  if (typeof jsonFlag === "string") write(jsonFlag, jsonText, "JSON", "json");

  let cardMsg = "";
  let cardFailed = false;
  const anonymizeNames = flags.has("card-anonymize") || flags.has("anonymize") || strict;
  let mdText = "";
  let mdMsg = "";
  let sarifOut = "";
  if (mdFlag !== undefined || mdCompact) {
    mdText = renderMarkdown(report, { anonymize: anonymizeNames, compact: mdCompact, headline: cardHeadline as "total" | "cut" });
    if (mdFile) {
      write(mdFile, `${MD_MARKER_PREFIX}${VERSION} -->\n${mdText}`, "Markdown report", "md");
      mdMsg = `Markdown report written to ${mdFile} (no paths, file contents or finding texts; ${anonymizeNames ? "plugin and MCP server names anonymised" : "plugin and MCP server names are shown, add --card-anonymize to hide them"}).\n`;
    }
  }
  if (cardFile) {
    const agent = pickCardAgent(report, flags.has("card-agent") ? String(flags.get("card-agent")) : undefined);
    if (!agent) cardMsg = "No card written: nothing measurable (or unmeasured) loads before hello for the selected agent(s).\n";
    else {
      const base = { theme: cardTheme as "dark" | "light", size: cardSize as "og" | "square", headline: cardHeadline as "total" | "cut", anonymize: anonymizeNames };
      if (cardFormat === "svg") write(cardFile, renderCard(report, agent, base), "card", "svg");
      else {
        try {
          const png = await svgToPng(renderCard(report, agent, { ...base, fontFamily: PNG_FONT_FAMILY, charEm: PNG_CHAR_EM }), {
            scale: cardScale,
            version: VERSION,
            resolver: flags.get("png-engine") === "none" ? () => { throw new Error("disabled"); } : undefined,
          });
          write(cardFile, png, "card", "png");
        } catch (e) {
          if (!(e instanceof PngUnavailableError)) throw e;
          cardFailed = true;
          cardMsg = `prehello: ${e.message}\n`;
        }
      }
      if (!cardFailed) cardMsg = `Card written to ${cardFile} (${agent.name}; no paths or file contents; ${anonymizeNames ? "plugin and MCP server names anonymised" : "plugin and MCP server names are shown, add --card-anonymize to hide them"}).\n`;
    }
  }

  let sarifMsg = "";
  if (sarifFlag !== undefined) {
    const sarifText = renderSarif(report, { anonymize: anonymizeNames, strict, maxTokens, cwd, home });
    if (sarifFile) {
      write(sarifFile, sarifText, "SARIF report", "sarif");
      sarifMsg = `SARIF report written to ${sarifFile} (no file contents or finding texts; file locations only for files inside the scanned folder${strict ? ", none with --redact" : ""}).\n`;
    } else sarifOut = sarifText;
  }
  const docOnStdout = jsonFlag === true || mdStdout || sarifStdout;
  if (jsonFlag === true) process.stdout.write(jsonText);
  else if (sarifStdout) process.stdout.write(sarifOut);
  else if (mdStdout) process.stdout.write(mdText);
  else if (flags.has("fix")) process.stdout.write(term(renderFix(report)));
  else process.stdout.write(term(renderTerminal(report, { color, width, verbose: flags.has("verbose"), quiet: flags.has("quiet"), home, cwd })));
  if (cardMsg) (docOnStdout || cardFailed ? process.stderr : process.stdout).write(term(cardMsg));
  if (mdMsg) (docOnStdout ? process.stderr : process.stdout).write(term(mdMsg));
  if (sarifMsg) (docOnStdout ? process.stderr : process.stdout).write(term(sarifMsg));
  process.exitCode = cardFailed ? 1 : report.warnings.length ? 3 : 0;
  if (maxTokens !== undefined) {
    const over = report.agents.filter((a) => !a.presentInRepoOnly && a.totals.always.est > maxTokens!);
    for (const a of over) {
      const lb = a.lowerBound ? "at least " : "";
      process.stderr.write(`prehello: ${a.name} always-on context is ${lb}~${fmtTok(a.totals.always.est)} tokens (estimate), above --max-tokens ${maxTokens}\n`);
    }
    if (over.length) process.exitCode = 2;
  }
}

// `prehello --markdown | head` closes the pipe early: that is not an error.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(process.exitCode ?? 0);
  throw e;
});

main().catch((e: Error) => {
  process.stderr.write(`prehello: internal error: ${e.message}\n`);
  process.exitCode = 1;
});
