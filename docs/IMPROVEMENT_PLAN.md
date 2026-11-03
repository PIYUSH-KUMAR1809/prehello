# prehello improvement plan

Written 2026-11-03 against `main` at `42aaad4` (npm `prehello@0.1.0`). Planning only: nothing in `src/` was changed.

`docs/PRODUCT_PLAN.md` is gitignored (`.gitignore`, "local-only notes"), so this plan could not read it. It is based on the code, the README,
the CHANGELOG, a real run on a machine with 126 Cursor skills, the npm registry, and the competitors' own READMEs. Where this plan and
`PRODUCT_PLAN.md` disagree, settle it on purpose. Two source references point at documents that do not exist in the repo:
`src/tokens/families.ts:18` cites "PRODUCT_PLAN §7.2" and "docs/accuracy.md".

---

## 0. Top 10 recommendations (in priority order)

| # | Recommendation | Impact | Effort | Section |
| --- | --- | --- | --- | --- |
| 1 | **Calibrate against ground truth and publish the error.** Claude `count_tokens` for the tokenizer factor, differential `claude -p` / `codex exec --json` runs for injection overhead, and a `prehello calibrate` command that parses Claude Code's `/context` output. Publish `docs/ACCURACY.md`. | Very high | M | 4.1 |
| 2 | **Fix the Cursor skills-listing model.** This run found prehello's Cursor listing about **2.4x higher** than the listing format seen in a live Cursor session (descriptions cut to about 80 characters, plus a path). That listing is the biggest number most Cursor users see. | Very high | S | 4.2 |
| 3 | **Close the share loop.** Put `npx prehello` and the repo URL on the card and in the Markdown footer, accept `--card card.png` with a space, make the default terminal output fit in about 20 lines, and end it with "next steps". | High | S | 4.3 |
| 4 | **Add `--save`, `prehello diff`, and a GitHub Action that posts a sticky PR comment** ("this PR adds +1.2k tokens before hello"), plus a README badge. Every comment and badge advertises the tool in someone else's repo. | Very high | M | 4.4 |
| 5 | **Release engineering:** a tag-driven release workflow with npm trusted publishing and provenance, a single source for the version, an accurate CHANGELOG, deprecation of `0.0.0-stage`, a Node 22/24/26 matrix, Dependabot, CodeQL, Scorecard, and lint/format. | High (trust, resume) | S–M | 4.5 |
| 6 | **Measure MCP without breaking the promise.** Add a names-only catalog for popular *remote* MCP servers and read any on-disk tool caches the agents keep. A process-starting probe, if built at all, should be an explicit, separate opt-in. | High | M | 4.6 |
| 7 | **Adapter registry, then GitHub Copilot and Gemini CLI adapters**, followed by opencode and Windsurf. | High (reach) | M each | 4.7 |
| 8 | **Make `--fix` actionable while staying read-only.** Print copy-paste config snippets per agent (`skillOverrides` set to name-only, `enabledPlugins: false`, Codex `[[skills.config]]`). Add an opt-in `--usage` mode that marks skills and MCP servers unused in the last 30 days, using local session logs. | High | M | 4.8 |
| 9 | **A public, telemetry-free benchmark:** "State of agent context", built by scanning 500 or more public repos, plus a plugin weight leaderboard. This is the launch content and the data-engineering showcase. | High (growth, resume) | M | 4.10 |
| 10 | **Relaunch with data, not with the tool.** Email HN for a second chance, then lead with the benchmark post. Submit to awesome lists, package a `/prehello` Claude Code plugin and Cursor skill, and rewrite the README's first screen around real numbers and the competitor table. | High | S | 5 |

---

## 1. Where things stand (measured on 2026-11-03)

| Fact | Value | How it was measured |
| --- | --- | --- |
| Tests | 489 passing across 19 files; `npm run typecheck` clean; about 24 s locally | `npm ci && npm run typecheck && npm test` |
| Scan time, 126 skills and 10 plugins | 0.38 s | `time node dist/cli.js` |
| Package | 143 kB tarball, 51 files; installed `gpt-tokenizer` takes **30 MB** (all encodings, ESM and CJS) | `npm pack --dry-run`, `du` |
| npm downloads | **288 of the first-week total came on publish day (2026-10-25)**, then 12, 7, 22, 4, **1 (launch day, Oct 30)**, 1, 10 | `api.npmjs.org/downloads/range/2026-10-20:2026-11-02/prehello` |
| GitHub | 3 stars, 0 forks, 0 issues | `gh api repos/PIYUSH-KUMAR1809/prehello` |
| npm provenance | **None** (no `dist.attestations`); a stray `0.0.0-stage` version is published | `npm view prehello --json` |
| Published commit | npm `gitHead` is `fba5bce`, but tag `v0.1.0` points at `6cbb194` ("Release 0.1.0", made *after* publishing) | `npm view`, `git rev-list -n1 v0.1.0` |

**Read the download numbers honestly.** The "~333 first week" is mostly a publish-day spike. That pattern is typical of registry mirrors,
scanners and the author's own installs. The Oct 30 launch (Show HN, which was auto-killed, five subreddits, and X) produced **almost no
installs**. So the problem is not conversion of a large audience but having no audience that saw it. This changes the plan: growth needs
artifacts that travel on their own (PR comments, badges, a data post), not more launch posts of the same README.

---

## 2. Honest audit

### 2.1 Code quality and architecture

**Strengths (keep them, and advertise them):**
- Strict TypeScript and only three runtime dependencies (`gpt-tokenizer`, `picomatch`, `smol-toml`), with PNG rendering as an optional dependency.
- A clean pipeline. `src/scan.ts` runs each adapter's `detect`/`discover` and then the analyses (`src/analyze/*`). The renderers (`src/render/*`) are pure functions of a `Report` (`src/model.ts`).
- Product promises are enforced in code. All writes go through `src/safe-write.ts` (`O_NOFOLLOW`, re-check after open, refusal to overwrite foreign files). File reads are bounded by `src/fs-safe.ts`, with jails, a 4 MiB cap and scan budgets. Output is deterministic (`SOURCE_DATE_EPOCH`).
- Honesty is designed into the data model: `tokens: null` means unmeasured, `lowerBound` marks lower bounds, every item carries a confidence label (`documented`/`observed`/`assumed`), and there are `evidence.docUrl` links and `spec/*.json` with `verifiedAt` dates.

**Issues, most important first:**

| Issue | Where | Why it matters | Fix |
| --- | --- | --- | --- |
| The agent list is hard-coded in at least five places | `src/model.ts:3-9` (type union, names, `ALL_AGENTS`), `src/scan.ts:18-22` (`ADAPTERS`), `src/cli.ts:28,193` (help and errors), `src/tokens/families.ts:21-55` (profiles) | Each new agent touches every one of them; this is the main blocker for item 7 | Add an adapter registry (4.7) |
| `src/cli.ts` is one 250-line `main()` with a hand-rolled argument parser | `src/cli.ts:93-388` | Subcommands `calibrate`, `diff` and `ci` are already reserved (`src/cli.ts:163`) and will not fit cleanly | Use `node:util` `parseArgs` (Node ≥ 18.3), with `src/commands/{scan,explain,calibrate,diff}.ts` |
| The version is defined in two places | `src/scan.ts:16` `VERSION = "0.1.0"` and `package.json` | They will drift at the first release that forgets one | Generate `src/version.ts` at prebuild, or read `package.json` at runtime (4.5) |
| Very long lines | 103 lines over 200 characters in `src/`, 24 over 300, the longest 542 (for example `src/adapters/cursor.ts:67-80`, `src/adapters/claude-code.ts:337`) | Hard to review and to diff; contributors bounce off | Prettier (printWidth 140) plus typescript-eslint, in one formatting-only commit |
| No public library API | `package.json` has `bin` but no `exports`/`types` | A VS Code extension, the GitHub Action and the benchmark all want `scan()` as a function, not a subprocess | `exports: { ".": "./dist/index.js" }` with `scan`, `toJson` and types (4.9) |
| Module-level mutable cache | `src/adapters/common.ts:123` `catalogCache` | Fine for a one-shot CLI, wrong for a long-lived extension or watch mode | Move it into `Ctx` |
| Loading rules are code; the specs are only metadata | `spec/*.json` holds docs URLs and caps; the rules and "assumed" notes are string literals in the adapters | The "honest" claims cannot be audited in one place | Later: a structured rules table that generates `docs/LOADING_RULES.md` |
| Two finding ID schemes | internal `F1`–`F13` (`src/adapters/*`, `src/analyze/findings.ts`) and SARIF `PH001`–`PH011` (`src/render/sarif.ts:58-121`) | Users see neither ID in the terminal, so findings cannot be searched or documented | Print `PH0xx` next to each terminal finding and document each rule in `docs/rules/PH0xx.md` (that also fills SARIF `helpUri`) |
| Dangling references | `src/tokens/families.ts:18` (PRODUCT_PLAN §7.2, `docs/accuracy.md`) | Contributors cannot follow them | Create `docs/ACCURACY.md` (4.1) and drop the private reference |
| Heavy tokenizer install | `gpt-tokenizer` is 30 MB installed, but only `o200k_base` is used (`src/tokens/counter.ts:20`) | Slower cold `npx` on bad networks and in CI | Low priority: vendor only o200k, or check whether a slimmer package works |

### 2.2 Tests and CI

**Strengths:** 489 tests, goldens for every renderer (`test/golden/`), SARIF validated against the OASIS schema (`test/schema/`), a runtime guard
that blocks and records network, DNS and child-process calls (`test/helpers/guard.cjs`, `test/safety.test.ts`), privacy canaries, hostile-input
tests, and simulated Windows 8.3 short paths and backslashes (`test/helpers/sim-*.ts`). For a v0.1 tool this is unusually strong. It is the best
resume material in the repo, and the README undersells it.

**Gaps:**
- **No coverage measurement.** Add `@vitest/coverage-v8` and report it in CI (no gate). A badge is optional.
- **Test files are named after the process, not the behaviour:** `test/v02-regressions.test.ts`, `test/review-regressions.test.ts`. Fold them into feature files.
- **No ground-truth tests.** Every factor test asserts the prior itself (`test/unit.test.ts:116-126` expects `1500` for 1000 raw tokens). After calibration, golden tests should load `spec/calibration.json` instead.
- **CI matrix.** `.github/workflows/ci.yml` tests Node 18 and 20, both end-of-life by now, and does **not** test Node 24 or 26. It runs 9 full jobs on every push. Proposed: Ubuntu on Node 18, 22, 24 and 26; Windows and macOS on 22 and 24 only.
- **Missing jobs:** lint/format, `npm audit signatures`, CodeQL, Dependabot. Actions are pinned by tag, not by SHA (Scorecard flags this).
- **Stale comments:** the header of `ci.yml` still says "This file is the FIRST real run of the test suite on Windows and macOS".
- **The README's SARIF workflow "has not been run against GitHub code scanning yet"** (README.md:416). Dogfood it in this repo (4.4).

### 2.3 Accuracy risks (ranked by how wrong a typical user's headline could be)

1. **Cursor skills listing: likely overcounted, about 2.4x on the machine tested.** prehello models each skill as `name: description` with the
   full description (`src/adapters/cursor.ts:196`). In a live Cursor cloud-agent session on 2026-11-03, the listing actually injected rendered
   each skill as an element with a compressed path attribute (`$3/<skill>/SKILL.md`). The description was cut to **80 characters plus "..."**,
   except for a couple of first-party skills shown in full. Rebuilding both formats from the same 126 `SKILL.md` files on this VM gives:

   | Model | Raw o200k tokens |
   | --- | --- |
   | prehello today (`name: full description`) | 11,800 |
   | Observed format (80-character description and path tag) | 4,840 |

   prehello then multiplies by about 1.25 (the Cursor midpoint), so it reports ~14.4k where the real cost is probably about 5–6k. This was seen
   in one harness (a cloud agent), so **check it in desktop Cursor first**. Either way, the current number is the upper end of the plausible range,
   not the middle. (The script used is in Appendix A.)
2. **The Claude ×1.5 factor and ±20% band are unvalidated priors** (`src/tokens/families.ts:34-41`). Every Claude Code total is scaled by them.
   The `--claude-profile legacy` ×1.2 option shows the author already expects tokenizer differences between models, so the factor should be per model and measured.
3. **Wrapper overhead is not counted.** Agents wrap each file and listing in headers and tags ("Contents of CLAUDE.md…", XML-like elements,
   file paths). That is small per file but adds up across 100+ skills. Only the differential runs in 4.1 can measure it.
4. **Unmeasured MCP servers make nearly everyone's total a lower bound.** The catalog (`spec/mcp-weights.json`) has 7 stdio npm packages. Most
   setups now use remote HTTP servers (GitHub, Notion, Linear, Sentry, PostHog, Figma…). On the machine tested, **8 of the 10 always-on items were
   unmeasured**, and the grade became "B (provisional)" for a reason the user cannot fix.
5. **Plugin enablement is assumed.** Cursor counts every plugin found under `~/.cursor/plugins` (`src/adapters/cursor.ts:213`, "assumed"). Claude
   Code treats installed plugins missing from `enabledPlugins` as enabled (`src/adapters/claude-code.ts:113`). A disabled plugin can then
   dominate the cut list, which is the worst kind of error for a tool whose main output is "cut this".
6. **The Claude Code tool-search model is simplified.** Tool search is modelled as "names always, schemas deferred"
   (`src/adapters/claude-code.ts:409-411`). ccaudit's README describes a version-dependent threshold and a fixed ToolSearch overhead of about 8.7k
   tokens in deferred mode. Verify against `/context`.
7. **Codex MCP is modelled as fully upfront**, marked "unverified" (`src/adapters/codex.ts:119`).
8. **The docs drift.** The specs say `verifiedAt: 2026-10-25`, and these agents change monthly. Nothing reminds the maintainer when a spec is stale.
   Add a scheduled workflow that opens an issue when `verifiedAt` is more than 45 days old, and print the spec age in `--about-specs`.

### 2.4 Output UX

From the real run (Section 1), roughly 50 lines of terminal output:

| What | Problem | Change (`src/render/terminal.ts` unless noted) |
| --- | --- | --- |
| Header | Two lines of disclaimer come before the first number | Keep one short line ("estimates, see docs/ACCURACY.md"); after calibration, show the measured error instead |
| Headline `Cursor ≥ ~14.4k tokens` | `≥ ~` is symbol soup | "Cursor: at least ~14.4k tokens" (line 211) |
| `DEFERRED ~334k tokens` | Bigger than the 200k window with no framing, which reads like a bug | "~334k tokens of skill bodies load only when a skill is used (not part of the number above)" |
| Top offenders | When one plugin dominates, this lists five of its skills and repeats the cut list (line 128) | Hide entries already covered by a cut-list group, or show it only with `--verbose` |
| Band text | "midpoint of GPT-like (×1.0) and Claude-like (×1.5) priors" is jargon | "model unknown: 11.1k–20.7k", with details under `--verbose` |
| "Never measured" paragraph | The same four clauses on every run (line 316) | One line plus `prehello explain unmeasured` |
| No next step | The output ends with the grade | A footer: share (`--card=card.png`), CI (`docs/CI.md`), "wrong number? `prehello calibrate`" |
| `--fix` | Only one generic suggestion on a real machine | Copy-paste snippets (4.8) |
| Card (`src/render/card.ts:193`) | **No `npx prehello` and no URL**, so a shared card leads nowhere; the tile label "17 Cursor-manag…" is cut off; the "deferred ~334k" chip is larger than the window | Add a call-to-action footer, shorter group labels ("17 built-in skills"), and rename the chip to "on use ~334k" |
| Markdown footer (`src/render/markdown.ts:137`) | No link back | Append "[prehello](https://github.com/PIYUSH-KUMAR1809/prehello)" |

**Proposed default:** a compact view of about 20 lines (headline, cut list, measured vs not measured, next steps), with today's output under
`--full`. ctxweight's README shows this works: grade, one-line summary, then the bars.

### 2.5 Install and onboarding friction

- `npx prehello` works and is fast (1.2 s cold on a fast network). Good.
- **`--card card.png` with a space is rejected** (`src/cli.ts:170`). This is the most common way people type it, and the share feature is the
  growth feature. When the next argument ends in `.svg` or `.png`, accept it as the card file name.
- **The default card is SVG** (`src/cli.ts:221`), which X, Reddit and Slack previews do not render. Default to PNG when the optional engine is
  present (it is with `npx`) and fall back to SVG with a message.
- On CI runners `--agent` is required because there is no home config, and the user has to know that. The Action (4.4) should hide it.
- The README's Outputs table uses `node dist/cli.js` (README.md:97-105) instead of `npx prehello`.

### 2.6 README

527 lines and 39 KB. Its strengths are the card at the top and the honest "On one real machine" table. Its weaknesses:
- The first screen is about 40% caveats. Hedging is a feature, but it belongs in one "Accuracy" section with a measured table, not on every line.
- **"How it differs" is out of date** (README.md:146-160). It omits ccaudit, ctxwise, tool-tax and clawprint, and says "I read them, I did not run them". Replace it with the table in Section 3.
- There is no animated or terminal demo. Add a rendered SVG of the compact output (generated from a fixture, like the cards).
- Most of the reference material should move to `docs/REFERENCE.md`, `docs/PRIVACY.md` and `docs/CI.md`. Target: a README under 200 lines.

### 2.7 Release and supply chain

- No release workflow: the publish was manual, from a commit the tag does not point at (Section 1).
- No npm provenance. For a tool whose pitch is "trust me, nothing leaves your machine", a verifiable build is part of the product.
- `0.0.0-stage` is visible in `npm view prehello versions`.
- `CHANGELOG.md:28` says "0.1.0 (not yet published)", and the "Unreleased" section lists fixture skipping, which *is* in the published tarball (`gitHead fba5bce`).

---

## 3. Competitors and differentiation

Data from each project's npm/PyPI/GitHub page and README, gathered 2026-11-03. Downloads are npm's last-week or last-month counts.

| Tool | What it is | Agents | Traction | Overlap with prehello | What prehello lacks that it has |
| --- | --- | --- | --- | --- | --- |
| **ccaudit** (`fabio-dee/ccaudit`, npm `ccaudit-cli` 1.5.1) | Finds "ghost" agents, skills, MCP servers, commands, hooks and memory that load but are **unused** (from session logs), then archives them with `restore` | Claude Code only | 47 stars; 22 downloads/month | High | Usage awareness ("unused for 7 days"), an interactive TUI, reversible archiving (it writes files), a punchy headline ("~5-10% of your context is gone before you type a word") |
| **ctxwise** (`FramY2/ctxwise`, npm `@framy2/ctxwise` 1.1.0) | "Context firewall": `mcp-xray --probe-stdio`, cross-agent `sync --compress`, a secret and prompt-injection `shield`, budget lock, GitHub Action `uses: FramY2/ctxwise@v1` | Claude Code, Codex, Cursor | 8 stars; **710 downloads/month** | High | Live MCP probing, a GitHub Action, file rewriting, a security angle, heavy README marketing |
| **ctxweight** (npm 0.1.0) | Static "health + budget": grade A–F, always-on vs on-demand, dollar cost via `--model`, SARIF, `--md` | CLAUDE.md, AGENTS.md, `.cursorrules`, `copilot-instructions.md`, skills, MCP | 0 stars; 3 downloads/week | Very high (nearly the same concept) | Copilot instruction files, a dollar estimate. prehello is ahead on almost everything else. |
| **clawprint** (npm 0.5.0) | A capability manifest (`CLAWPRINT.md`) plus `clawprint check` in PRs: what the agent setup *can do* (network, commands, env), with diffs | Claude, Cursor, Codex, Gemini, Copilot, Windsurf, Cline files | 0 stars; 4 downloads/week | Low (security, not tokens) | **Diff in PR review**, a GitHub Action, broad agent file coverage |
| **tool-tax** (PyPI 0.9.0) | MCP and OpenAPI tool-schema budget linter: probes stdio `tools/list`, `diff` in CI, slim index, lazy proxy | MCP configs of Claude Code, Cursor, VS Code, Cline | PyPI only | Medium (MCP part) | Measured MCP schemas, catalog diff in CI |
| **ctxaudit** (`sanjeed5`, PyPI 0.1.0; also `vaultcj/ctxaudit`) | Context tax of skills, rules and instruction files | Several | 0 stars | Medium | Nothing significant |
| **context-lens** (npm 0.8.0) | A local HTTP **proxy** that intercepts real LLM API calls and visualizes the context | Any API-based agent | 98 downloads/week | Complementary | **Ground truth** (sees the real payload), at the cost of setup and a proxy |
| **ccusage** (npm 20.x) | Usage and cost from past sessions' logs | Claude Code, Codex, others | **183k downloads/week** | None (complementary) | An audience. "ccusage tells you what you spent; prehello tells you what you pay before you start." |
| **`/context`** (built into Claude Code) | Live breakdown for the current session | Claude Code | Built in | Partial | Exactness. It is also prehello's best calibration source (4.1). |

**Where prehello already wins:** three agents with per-agent loading rules (precedence, caps, shadowing), a per-plugin cut list,
"unmeasured is never 0" with lower bounds, confidence labels on every item, share cards and a privacy-safe Markdown report, SARIF that passes
schema validation, Windows support, and a **tested** no-network/no-process guarantee. No competitor proves its privacy claims with a runtime guard.

**Where prehello is behind:** a GitHub Action and PR diffs (ctxwise, clawprint), MCP measurement (ctxwise, tool-tax), usage awareness
(ccaudit), agent breadth (clawprint, ctxweight), and marketing energy (ctxwise, ccaudit).

**Positioning to aim for, in one line:** *"The calibrated one: what your agent loads before hello, across Claude Code, Cursor, Codex, Copilot
and Gemini, with a published error rate, in every PR."* Two properties no competitor has: **(a) measured accuracy published per agent
version**, and **(b) a PR comment that shows the token delta of a config change**. Everything in Section 4 serves one of the two, or the
reach of both (more agents).

**Explicit non-goals,** to stay distinct: no rewriting or "compressing" of the user's files (ctxwise does that), no archive/move (ccaudit does
that; prehello prints the exact snippet instead), no proxy (context-lens), no dollar billing (ccusage).

---

## 4. Improvements, ranked by impact and effort

Effort scale: **S** = one or two modules, no new interface. **M** = a new subcommand, interface or workflow across several modules.
**L** = a new published surface (an extension, a separate repo or package).

| Rank | Item | Impact | Effort | Main files |
| --- | --- | --- | --- | --- |
| 1 | Calibration: tokenizer factor, injection overhead, `prehello calibrate`, `docs/ACCURACY.md` | Very high | M | `scripts/calibrate/*`, `spec/calibration.json`, `src/tokens/families.ts`, `src/commands/calibrate.ts` |
| 2 | Cursor listing format: verify, then model it | Very high | S | `src/adapters/cursor.ts:190-199`, `spec/cursor.json`, goldens |
| 3 | Share loop: card and Markdown call-to-action, `--card` with a space, PNG default, compact terminal | High | S | `src/render/card.ts`, `src/render/markdown.ts`, `src/render/terminal.ts`, `src/cli.ts` |
| 4 | `--save` / `diff` / GitHub Action with PR comment / badge | Very high | M | `src/commands/diff.ts`, `src/render/diff-markdown.ts`, a separate `prehello-action` repo |
| 5 | Release workflow, provenance, version source, CHANGELOG, CI matrix, lint, Dependabot, CodeQL, Scorecard | High | S–M | `.github/workflows/release.yml`, `ci.yml`, `codeql.yml`, `scorecard.yml`, `.github/dependabot.yml`, `package.json` |
| 6 | MCP: remote names-only catalog, on-disk tool caches | High | M | `spec/mcp-weights.json` (v2), `src/mcp/catalog.ts`, `src/adapters/*` |
| 7 | Adapter registry, then Copilot and Gemini CLI (then opencode, Windsurf) | High | M + M per agent | `src/adapters/registry.ts`, `src/adapters/{copilot,gemini,opencode,windsurf}.ts`, `spec/*.json` |
| 8 | Actionable `--fix` snippets; opt-in `--usage` | High | M | `src/render/fix.ts`, `src/analyze/usage.ts` |
| 9 | Library API (`exports`), CLI split, Prettier/ESLint | Medium (enables 4, 11, 12) | S–M | `src/index.ts`, `src/cli.ts`, `package.json` |
| 10 | Public benchmark and plugin weight leaderboard | High (growth, resume) | M | `bench/` (dev-only), `docs/STATE_OF_AGENT_CONTEXT.md`, `docs/PLUGIN_WEIGHTS.md` |
| 11 | `--watch` | Low–medium | S | `src/commands/watch.ts` |
| 12 | VS Code / Cursor extension | Medium | L | a new `prehello-vscode` repo using the library API |
| 13 | Explicit `prehello probe` for MCP (separate package) | Medium | M | a `prehello-probe` package reusing `scripts/measure-mcp.cjs` |

### 4.1 Accuracy calibration (rank 1)

The goal is to replace "priors, unvalidated" with "measured: median error X% (n=Y, agent version Z, date)". This uses three layers. Only the
third runs on users' machines, and it stays offline. The first two are **dev-only scripts** that need the maintainer's API key or subscription,
like `scripts/measure-mcp.cjs` today. They are never shipped and never imported by `src/`.

**Layer 1: tokenizer factor per model family.**
- Corpus: `bench/corpus/manifest.json` lists about 300 public files (repo, path, commit SHA, licence): CLAUDE.md, AGENTS.md, SKILL.md, `.mdc`
  rules, and the MCP tool-list JSON from `scripts/measure-mcp.cjs`. Commit only the manifest; the script fetches the content at run time.
- `scripts/calibrate/count-claude.mjs` calls Anthropic's free `POST /v1/messages/count_tokens` for each file and each current Claude model. It
  subtracts an empty-message baseline to remove the fixed overhead, and records o200k counts next to them.
- Output: `spec/calibration.json`, for example
  `{ "claude": { "model": "…", "measuredAt": "…", "n": 300, "byKind": { "markdown": { "median": 1.xx, "p10": …, "p90": … }, "json": { … } } } }`.
- `src/tokens/families.ts` reads this file instead of the constants `1.5` and `0.2`: the factor is the median per content kind, and the band is p10–p90.
  `unvalidated` becomes `false` only when `n ≥ 100`. Later, Gemini's free `countTokens` does the same for the Gemini adapter.

**Layer 2: injection overhead (what the agent actually wraps around the content).**
- **Claude Code:** run `claude -p "Reply OK" --output-format json` in a hermetic config (`CLAUDE_CONFIG_DIR=$(mktemp -d)`, plus flags such as
  `--setting-sources` / `--strict-mcp-config`; check the exact flag names for the installed version). Compare an empty baseline with one added item:
  a CLAUDE.md of known size, 10/50/100 skills, one plugin, one MCP server with tool search on and off. Real input =
  `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. The difference from baseline is the true cost of that item. Fit
  `cost = a + b × count_tokens(content)`; `a` is the wrapper overhead per item and per listing entry.
- **Codex:** run `codex exec --json "Reply OK"` with a temporary `CODEX_HOME`, and read the usage from the turn-completed event. This also checks
  the 32 KiB cap (`src/adapters/codex.ts:94`) and the `name: desc (file: path)` listing (`src/adapters/codex.ts:148`).
- **Cursor:** no headless usage API is known. Check whether the `cursor-agent` CLI reports usage in JSON output. Otherwise, keep a manual
  protocol (`docs/calibration/cursor.md`) based on the in-app context indicator, plus listing-format observations like the one in 2.3.
- Scripts live in `scripts/calibrate/{claude-diff,codex-diff}.mjs`. Results go to `bench/calibration/<agent>-<version>-<date>.json`, and
  `scripts/calibrate/report.mjs` generates the table in `docs/ACCURACY.md`.

**Layer 3: user ground truth, offline (`prehello calibrate`).**
- `prehello calibrate --context-file ctx.txt` (or `-` for stdin) parses the text a user copies from Claude Code's `/context`. That includes the
  category rows (system prompt, system tools, MCP tools, custom agents, memory files, skills, messages, free space) and the per-file and
  per-skill rows when present.
- It compares those categories with prehello's own, prints the error per category, and with `--json --redact` emits a snippet with no paths that
  the user can paste into the existing `.github/ISSUE_TEMPLATE/wrong-estimate.md`. This gives crowd-sourced calibration with no telemetry.
- The `calibrate` placeholder already exists (`src/cli.ts:163`). Add `test/fixtures/context-output/` with captures from at least two Claude Code
  versions, and make the parser tolerant of format changes: on any line it does not understand, fail with a clear message, never guess.

**Acceptance criteria:**
- `docs/ACCURACY.md` has, per agent: n, agent version, date, median absolute error, and p90 error.
- On at least 5 real Claude Code setups, the always-on estimate is within ±10% of `/context`'s *memory files + skills + custom agents* (+ MCP
  tools when measured).
- `spec/calibration.json` drives `src/tokens/families.ts`, tests load it instead of hard-coding `1500`, and `--about-specs` prints the calibration date.
- The README replaces "priors, not validated" with the measured numbers, and keeps the caveats for what still is unvalidated (Cursor).

### 4.2 Cursor skills-listing model (rank 2)

1. **Verify on desktop Cursor first.** Add a skill with a 300-character description, then compare the context indicator, or the listing if it
   can be observed, with and without it. Record the result in `spec/cursor.json` (`verifiedNote`) with `confidence: "observed"`.
2. If the cut to about 80 characters holds, change `lineFor` in `src/adapters/cursor.ts:196` to render the observed shape: the path attribute plus
   `desc.slice(0, 80) + "..."`. Keep today's full-description count as the band's upper end, since some first-party skills were shown in full.
3. Rebuild the goldens (`test/golden/*cursor*`, `plugin-heavy*`, card SVGs) and **read the diff**. The cut-list *ranking* mostly survives; the magnitudes drop about 2x.
4. Say so in the CHANGELOG under "Changed (numbers)". Users who shared a card deserve to know the numbers moved, and why.

### 4.3 Share loop and output (rank 3)

- Card footer (`src/render/card.ts:193`): replace `"prehello", "local-only scan"` with `"npx prehello"` and `"github.com/PIYUSH-KUMAR1809/prehello"`.
  Keep the estimate band. Update the card goldens.
- Shorten group labels so tiles do not cut them off: "17 Cursor-managed skills" becomes "17 built-in skills". Rename the "deferred" chip to "on use".
- `src/cli.ts:126-135, 170`: accept `--card <file>` when the value ends in `.svg` or `.png`; keep the `=` form. Make PNG the default when the engine is present.
- Markdown footer (`src/render/markdown.ts:137`): add a link.
- A **before/after card mode** (`--card-mode cut`): two bars, "now ~14.4k" and "after cutting top 3 ~1.3k". This is the most shareable shape.
- Terminal: the compact default and the fixes in the 2.4 table, with `--full` for today's view.
- **Acceptance:** a card produced by `npx prehello --card card.png` (with a space) contains the text `npx prehello`, and the compact output on
  `test/fixtures/realistic` is 25 lines or fewer (asserted by a test).

### 4.4 `--save`, `diff`, GitHub Action, badge (rank 4)

- **`--save=<file>`** writes the redacted JSON (`toJson(report, …, strict=true)`) with stable ordering. **`prehello diff <base.json> <head.json>`**
  reports, per agent, the always-on change (central estimate and band), per-group changes, and items added or removed. Renderers: terminal,
  Markdown (the PR comment) and JSON. `--max-increase 500` exits 2 above that.
- **Action**, in a separate repo `PIYUSH-KUMAR1809/prehello-action`. GitHub Marketplace has repository-layout requirements, and a separate repo
  keeps its `v1` tag independent of npm tags. It is a composite action that:
  1. checks out the PR head, plus the base commit in a worktree (`git worktree add base ${{ github.event.pull_request.base.sha }}`);
  2. runs `npx prehello@<pinned> --agent <input> --save` on both (CI has no home config, so the comment says "repo-level config only");
  3. runs `prehello diff --markdown` and creates or updates **one sticky comment** (marker `<!-- prehello -->`, needs `pull-requests: write`);
  4. optionally writes SARIF (`--sarif`) and uploads it, and applies the `max-tokens` / `max-increase` gates.
  - Inputs: `agents`, `max-tokens`, `max-increase`, `comment` (default true), `sarif` (default false), `version`.
  - Example comment: "**prehello**: this PR changes what loads before hello. Claude Code **+1.2k** (~3.4k → ~4.6k); biggest change: `.claude/skills/deploy` +900 (estimate). [What is this?](…)"
- **Badge:** `--badge=<file.svg>` writes a shields-style SVG, "before hello | ~3.4k tokens", in `src/render/badge.ts`. The Action can commit it
  on the default branch (opt-in). The README snippet links back to the repo.
- **Dogfood:** add `.github/workflows/prehello.yml` to this repo so the README's SARIF claim stops saying "not run yet".
- **Acceptance:** a PR that adds a 2k-token CLAUDE.md to a test repo gets one comment showing about +2k (estimate). A second push updates the
  same comment. `max-increase` fails the job with exit code 2. The Action is listed on the Marketplace.

### 4.5 Release engineering (rank 5)

- `.github/workflows/release.yml`, triggered on `push: tags: ['v*']`: `npm ci`, `npm test`, a check that the tag equals the `package.json`
  version equals the built `VERSION`, then `npm publish --provenance --access public` via **npm trusted publishing** (`permissions: id-token: write`,
  no `NPM_TOKEN` secret). It then creates a GitHub Release with the matching CHANGELOG section and the tarball's SHA-256.
- Version from one source: a prebuild `scripts/gen-version.mjs` writes `src/version.ts` from `package.json`, and `src/scan.ts:16` imports it.
- Run `npm deprecate prehello@0.0.0-stage "accidental staging publish"`.
- `CHANGELOG.md`: change "0.1.0 (not yet published)" to "0.1.0 – 2026-10-25", move the fixture-skipping entries into 0.1.0, and add a release date to each future section.
- CI: the matrix change from 2.2, a lint job (`npm run lint` = ESLint + `prettier --check`), coverage as an artifact, `npm audit signatures`, and actions pinned by SHA.
- New workflows: `codeql.yml`, `scorecard.yml` (with a README badge), and `.github/dependabot.yml` (npm and github-actions, weekly).
- **Acceptance:** `npm view prehello@0.1.1 --json` shows `dist.attestations`, the npm page shows the provenance badge, the GitHub Release
  exists, and the Scorecard result is published.

### 4.6 MCP coverage without breaking the promise (rank 6)

- **Names-only catalog for remote servers.** For Cursor (tool names only in static context, `src/adapters/cursor.ts:241`) and for Claude with tool
  search, the always-on cost is the *names*. Popular remote servers publish their tool lists in docs or repos: GitHub's MCP server, Notion,
  Linear, Sentry, Atlassian, Slack, Figma, PostHog, Stripe, Supabase.
  - Extend `spec/mcp-weights.json` to v2: `{ "match": { "url": "…" } | { "package": "…" }, "tools": n, "nameTokens": n, "schemaTokens"?: n, "source": "measured" | "docs", "measuredAt": "…" }`.
  - Match by URL host in `src/mcp/catalog.ts`. Entries from docs get `confidence: "documented"`; measured ones stay as today.
  - Target 25 or more servers, which would turn "8 of 10 unmeasured" on the machine tested into "0–2 of 10".
- **On-disk caches.** Check whether desktop Cursor writes MCP tool descriptors to disk (its dynamic-context-discovery post describes syncing tool
  descriptions to files), and whether Claude Code caches tool lists. If so, read them (still read-only, no process) and label the result `observed`.
- **Probe:** keep it out of the core. ctxwise and tool-tax already probe, and "never runs anything of yours" is prehello's distinctive promise. If
  there is demand, publish `prehello-probe` as a separate package with an interactive confirmation, stdio only and a scrubbed environment, reusing
  `scripts/measure-mcp.cjs`. It writes a `--mcp-catalog` file the core then reads.

### 4.7 Adapter registry and new agents (rank 7)

**Registry first.** `src/adapters/registry.ts` exports `ADAPTERS = [claude, cursor, codex, …] as const`. Each entry is
`{ id, name, family: "claude" | "openai" | "gemini" | "mixed", detect, discover, spec }`. `AgentId`, `AGENT_NAMES`, `ALL_AGENTS`, the CLI help
text and the token profiles are all derived from it. Factor a shared `src/adapters/rule-modes.ts` out of `ruleFile()`
(`src/adapters/cursor.ts:50-84`): Cursor `.mdc`, Windsurf `trigger:`, Copilot `applyTo:` and Kiro steering all map frontmatter to
always/glob/description/manual. Add `docs/ADDING_AN_AGENT.md`, a "good first issue" for contributors.

**Order and what to scan.** Re-check every rule against current docs before coding, mark it in `spec/<agent>.json`, and label anything unclear `assumed`.

| Agent | Why now | What to scan (verify each) | Token family |
| --- | --- | --- | --- |
| **GitHub Copilot** (VS Code, Copilot CLI, coding agent) | The largest user base; ctxweight and clawprint already read its files | `.github/copilot-instructions.md` (always); `.github/instructions/**/*.instructions.md` with `applyTo` globs (conditional); `AGENTS.md`; `.github/prompts/*.prompt.md` (on-demand); custom agents and skills folders if supported; MCP in `.vscode/mcp.json` (key `servers`, not `mcpServers`) | mixed (model unknown) |
| **Gemini CLI** | Free tier, popular, clearly documented | `~/.gemini/GEMINI.md`; `GEMINI.md` from cwd up to the project root and any it loads from subdirectories; `context.fileName` in `settings.json` (can be `AGENTS.md`); `@file` imports; MCP `mcpServers` in `~/.gemini/settings.json` and `.gemini/settings.json`; extensions `~/.gemini/extensions/*/gemini-extension.json` (`contextFileName`, MCP). `/memory show` is a ground-truth source for calibration. | gemini (calibrate with `countTokens`) |
| **opencode** | The launch already reached r/opencodecli; small effort since it is AGENTS.md-based | `AGENTS.md`, `~/.config/opencode/AGENTS.md`, any CLAUDE.md fallback; the `instructions` globs in `opencode.json` (always-on); `mcp` in `opencode.json`; agents in `.opencode/agent/*.md`; skills if supported | mixed |
| **Windsurf** | Documented character limits make truncation findings (PH007) valuable | `.windsurf/rules/*.md` with `trigger` modes; global `~/.codeium/windsurf/memories/global_rules.md`; legacy `.windsurfrules`; per-file and total character limits; MCP `~/.codeium/windsurf/mcp_config.json` | mixed |
| Cline / Roo / Kilo, Kiro, Junie, Amp | Later | `.clinerules`, `.kiro/steering`, `.junie/guidelines.md`, … | mixed |

**Acceptance per adapter:** a fixture under `test/fixtures/<agent>-*` (via `scripts/make-fixtures.mjs`), goldens for terminal, JSON, Markdown
and SARIF, a hostile-input case, the README table updated, and `spec/<agent>.json` with docs URLs and `verifiedAt`.

### 4.8 Actionable fixes and usage awareness (rank 8)

**Copy-paste fixes** (`src/render/fix.ts`, still print-only):
- Claude Code: for the heaviest plugin, the `enabledPlugins` JSON snippet (`{"<id>": false}`), or the CLI disable command if one is documented.
  For the heaviest skills, a `skillOverrides` snippet setting `"name-only"` (handled at `src/adapters/claude-code.ts:306-314`). For project MCP
  servers, `disabledMcpjsonServers`. Each comes with "saves ~X (estimate)".
- Codex: a `[[skills.config]] path = "…" enabled = false` TOML block (handled at `src/adapters/codex.ts:136-146`).
- Cursor: the UI path, since no file-based toggle is documented.

**`--usage` (opt-in, local, read-only):**
- Claude Code: read the `~/.claude/projects/<slug>/*.jsonl` session logs, count only tool-use **names** (the skill tool's skill name,
  `mcp__<server>__<tool>`) from the last N days (default 30), and mark cut-list groups "unused in 30 days". Codex: `~/.codex/sessions/**.jsonl` (verify the layout).
- Privacy: never print or keep message content. Add a canary test that plants a secret in a transcript and asserts it reaches no output.
  Respect the scan budgets.
- This turns "biggest" into "biggest *and unused*", ccaudit's core hook, across agents and without moving files.

### 4.9 Library API and CLI split (rank 9)

- `src/index.ts` exports `scan`, `toJson`, `renderMarkdown`, `renderSarif` and the types. `package.json` gets
  `"exports": { ".": "./dist/index.js", "./package.json": "./package.json" }` and `"types"`. Turn on `declaration: true` in `tsconfig.build.json`.
- `src/cli.ts` becomes a thin dispatcher over `src/commands/*` using `node:util` `parseArgs`. Keep every existing flag and error message (goldens and `test/cli.test.ts` protect them).
- Prettier and ESLint in one mechanical commit (add it to `.git-blame-ignore-revs`).

### 4.10 Telemetry-free benchmarks (rank 10)

**A. "State of agent context" (public repos only, repo-level config).**
- `bench/repos/discover.mjs` uses GitHub code search (`filename:AGENTS.md`, `filename:CLAUDE.md`, `path:.cursor/rules`,
  `path:.github/copilot-instructions.md`) to list the top-starred 500–1,000 repos.
- `fetch.mjs` does a sparse, shallow checkout of agent files only. `run.mjs` runs `prehello --agent … --json --redact` through the library API.
- `aggregate.mjs` uses DuckDB to write `bench/results/<date>/summary.json` plus a CSV. Commit only aggregates and repo slugs with SHAs, never file contents.
- Headline candidates (the analyzers already detect all of them):
  - the distribution of always-on tokens per agent;
  - the share of repos where Claude Code **ignores AGENTS.md** because a CLAUDE.md exists (F7 / PH008);
  - the share with `.md` files in `.cursor/rules` that **Cursor ignores** (F11 / PH008);
  - the share over the **Codex 32 KiB cap** (F12 / PH007);
  - near-duplicate CLAUDE.md/AGENTS.md pairs (PH005).
  - Possible secrets: report only an aggregate count, and **never name repos**. Disclose privately if anything is real.
- Publish `docs/STATE_OF_AGENT_CONTEXT.md` with generated SVG charts, and rerun monthly with a scheduled workflow.

**B. Plugin weight leaderboard.** Run the skills-listing estimator over public plugin marketplaces and plugin repos (Claude Code's and Cursor's).
Publish `docs/PLUGIN_WEIGHTS.md` ("listing cost before hello per plugin") and ship it as `spec/plugin-weights.json`, so the cut list can say
"plugin X: ~10k (typical: ~2k)". Phrase it neutrally and invite plugin authors to trim. Their "we cut ours by 70%" posts are distribution.

**C. Performance.** Add `bench/perf.mjs` (hyperfine) over a large monorepo checkout. Report scan time in `docs/ACCURACY.md`, and add a non-gating CI check for regressions.

### 4.11 Watch mode, extension, probe (ranks 11–13, after the two weeks)

- **`--watch`** (S): `fs.watch` on the discovered item paths and config directories, debounced at 300 ms, redrawing the compact view. Good for
  "trim CLAUDE.md and watch the number drop", and for a demo GIF. It needs the catalog cache moved into `Ctx` first (2.1).
- **VS Code / Cursor extension** (L): a status bar ("before hello ~5k"), a tree view grouped by load mode, a CodeLens on CLAUDE.md/SKILL.md/`.mdc`
  ("~1.2k tokens, always on"), and diagnostics from the SARIF rules. Publish to the VS Code Marketplace and Open VSX (which Cursor uses). Requires 4.9.
- **`prehello-probe`** (M): see 4.6.

---

## 5. Growth and distribution, tied to features

Each idea is linked to the feature that makes it work. The pattern is **artifacts that travel on their own**.

| Idea | Feature it needs | Why it spreads |
| --- | --- | --- |
| **A PR comment in other people's repos** ("+1.2k tokens before hello") | 4.4 | Every comment is seen by every reviewer of that repo; the footer links back |
| **A README badge** "before hello: ~3.4k tokens" | 4.4 badge | Permanent, on repos with traffic; badges get copied |
| **A card with a call to action and a before/after shape** | 4.3 | Today a shared card leads nowhere; "14.4k → 1.3k" is the screenshot people post |
| **"How heavy is my setup?" comparison:** "more than X% of public repos" on the card (repo level) | 4.10A distribution | Comparison drives sharing ("mine is worse than yours") |
| **Plugin weight leaderboard** | 4.10B | Plugin authors react, trim and post about it; users check their own plugins |
| **A data post:** "I scanned 1,000 repos' agent configs: N% ship rules their agent ignores" | 4.10A | HN and Reddit reward data, not tool announcements; the tool is the methodology link |
| **"What Claude Code really loads before your first message, measured"** | 4.1 | Evergreen and searchable; positions prehello as the accurate one; cite `/context` and `count_tokens` |
| **A `/prehello` Claude Code plugin and a Cursor skill** with `disable-model-invocation: true` | packaging only | Listed in plugin marketplaces; the gimmick "the plugin that costs ~0 tokens before hello" is on brand |
| **The GitHub Marketplace listing** | 4.4 | Marketplace search is a discovery channel; the Action shows up next to linters |
| **Pairing with ccusage, not competing:** "ccusage = what you spent, prehello = what you pay before you start" | — | 183k weekly downloads. Open one useful discussion or PR (for example a "see also" in their docs) only if it fits their norms. Never spam. |

**Relaunch playbook** (after milestones M2 and M3, Section 6):
1. **HN:** email `hn@ycombinator.com` with the killed submission's link and ask for it to be reviewed or put in the second-chance pool. Spam
   filters often catch new accounts posting GitHub links. Relaunch as a **data post** (the benchmark) on a weekday morning, US Eastern time. Title
   style: "Show HN: I measured what Claude Code, Cursor and Codex load before your first message". No adjectives.
2. **Reddit:** post *results*, not the tool. r/ClaudeAI and r/cursor with the benchmark and a card; r/ClaudeCode with the calibration post
   (`/context` vs prehello). In threads asking "why is my context full", answer with the command and the cut list, once per thread and only where it is on topic.
3. **Cursor forum and GitHub Discussions:** post the Cursor listing finding (4.2). It is useful to Cursor users whether or not they install prehello.
4. **Awesome lists:** PRs to the Claude Code, Cursor, MCP and AGENTS.md "awesome" lists and tooling pages, each with the one-line positioning from Section 3.
5. **X:** a thread of four cards (before/after, plugin leaderboard, benchmark chart, the PR comment screenshot), each with the `npx` command.

**What to stop:** reposting the same README to more subreddits. The Oct 30 launch showed that does not move installs.

---

## 6. Two-week roadmap (2026-11-03 to 2026-11-16)

Milestones are ordered so that each one makes the next one more effective: trust, then accuracy, then the PR loop, then reach, then the relaunch.
If time runs short, cut M4 down to Copilot only. Do not cut M2 or M3.

### M1: Trustworthy release, v0.1.1 (Tue Nov 3 – Wed Nov 4)
Scope: 4.5 (release workflow, version source, CHANGELOG, deprecation, CI matrix, Dependabot, CodeQL, Scorecard), the 4.3 share-loop fixes
(card and Markdown call to action, `--card` with a space, PNG default), lint/format setup, and a `.github/workflows/prehello.yml` dogfood.
**Acceptance criteria:**
- `v0.1.1` was published only by `release.yml`, and `npm view prehello@0.1.1 --json` contains `dist.attestations`.
- `npm view prehello@0.0.0-stage deprecated` is set.
- CI is green on the new matrix with a lint job.
- `npx prehello@0.1.1 --card card.png` writes a PNG whose footer contains `npx prehello` (checked by a golden).

### M2: Calibrated, v0.2.0 (Thu Nov 5 – Sun Nov 8)
Scope: 4.1 layers 1 and 3 (`count_tokens` corpus, `prehello calibrate --context-file`), layer 2 for Claude Code (at least the CLAUDE.md,
skills and plugin cases), 4.2 (Cursor listing verified and modelled), `docs/ACCURACY.md`, and the compact terminal default from 4.3.
**Acceptance criteria:**
- `spec/calibration.json` is committed, and `src/tokens/families.ts` reads it.
- `docs/ACCURACY.md` reports n, version, date and median/p90 error for Claude Code (5 or more setups, including the author's) and Codex (3 or more).
- Cursor's listing is labelled `observed`, with a dated note.
- `prehello calibrate` parses captured `/context` output from 2 Claude Code versions (fixtures) and prints the error per category.
- The compact output on `test/fixtures/realistic` is 25 lines or fewer, and `--full` matches today's golden.
- The README's first screen shows the measured error instead of "unvalidated" for Claude Code.

### M3: In every PR, v0.3.0 and Action v1 (Mon Nov 9 – Wed Nov 11)
Scope: 4.4 (`--save`, `diff`, `--badge`, the `prehello-action` repo, the sticky comment, gates, a Marketplace listing) and the names-only remote MCP catalog from 4.6 (15 or more servers).
**Acceptance criteria:**
- On a demo repo, a PR adding a 2k-token CLAUDE.md gets one prehello comment showing about +2k, updated in place on the next push.
- `max-increase: 500` fails that PR with exit code 2.
- The Action is on the GitHub Marketplace, and prehello's own repo uses it.
- On the machine tested in Section 1, the unmeasured MCP count drops from 8 to 3 or fewer.

### M4: More agents, v0.4.0 (Thu Nov 12 – Sat Nov 14)
Scope: the 4.7 registry refactor, then **Copilot** and **Gemini CLI** adapters (opencode if time allows), plus the library API from 4.9 (needed by the benchmark).
**Acceptance criteria:**
- Adding an agent touches `src/adapters/registry.ts`, the new adapter file, `spec/<agent>.json`, fixtures and goldens, and nothing else (checked by reviewing the diff).
- Each new adapter has terminal, JSON, Markdown and SARIF goldens and a hostile-input test.
- `--agent copilot,gemini` works, and `import { scan } from "prehello"` works in a TypeScript project.

### M5: Relaunch with data (Sat Nov 14 – Mon Nov 16)
Scope: the 4.10A benchmark (500 or more repos), `docs/STATE_OF_AGENT_CONTEXT.md`, the README rewrite (2.6, Section 3's table), the
plugin-weights first pass (4.10B, top 20 plugins), and the relaunch playbook in Section 5.
**Acceptance criteria:**
- `bench/` reproduces `summary.json` from a clean checkout with one command, and only aggregates and repo slugs with SHAs are committed.
- The README is 200 lines or fewer, its competitor table is current, and its first screen holds a real number, `npx prehello` and the card.
- The HN email has been sent; the data post and two Reddit posts are live; PRs are open on at least 3 awesome lists.

### Metrics to watch (instead of total downloads)
- **Weekly npm downloads, excluding publish days** (from the range API). Publish-day spikes are mirrors.
- **Repos using the Action** (GitHub code search for `uses: PIYUSH-KUMAR1809/prehello-action`) and **badges in READMEs**. These are the true adoption signal.
- **Distinct issue and PR authors who are not the maintainer.** Accuracy reports through the wrong-estimate template count double.
- **Median calibration error per agent** in `docs/ACCURACY.md`, tracked per release.
- Stars, as a lagging signal only. Do not optimise for them directly.

---

## 7. Guardrails (keep the product promises)

- The default `prehello` scan stays **local, read-only, with no network and no child processes**. `test/safety.test.ts` keeps enforcing it for
  every new subcommand, including `calibrate`, `diff`, `--usage` and `--watch`.
- Dev-only scripts under `scripts/` and `bench/` may use the network and API keys. They are never in `files` in `package.json` and never imported
  by `src/` (extend the source-scan test that already bans those modules in `src/`).
- Every new number is labelled an estimate until calibrated. Calibrated numbers carry their error and date. Unmeasured stays never-zero.
- No file contents in any output, including PR comments and benchmark artifacts.

---

## 8. Open questions to verify before building

1. Desktop Cursor's skills listing format: is it the same ~80-character cut seen in the cloud agent? This decides the size of the 4.2 change.
2. The current `/context` text format in Claude Code, and whether a non-interactive way to get it exists.
3. Which `claude -p` flags give a fully hermetic run (`--setting-sources`, `--strict-mcp-config`, `CLAUDE_CONFIG_DIR`) in the installed version.
4. Whether Cursor and Claude Code keep MCP tool lists on disk (4.6).
5. Copilot's current file set (custom agents, skills, `.vscode/mcp.json` shape) and Gemini CLI's downward GEMINI.md discovery rules.
6. Whether Claude Code's tool-search threshold and fixed overhead (as described by ccaudit) match `/context`.

---

## 9. How this reads on a resume (the owner's stated goal)

The two weeks above produce concrete, checkable bullets for software, DevOps and data roles:
- *Software:* "Built a cross-platform TypeScript CLI (Linux, macOS, Windows) with a pluggable adapter architecture for 5 AI coding agents; 500+
  tests including schema-validated SARIF, golden files, and a runtime guard proving no network or process access."
- *DevOps:* "Shipped a GitHub Action (Marketplace) that comments token-budget diffs on PRs and gates CI; tag-driven releases with npm trusted
  publishing and provenance, CodeQL and OpenSSF Scorecard."
- *Data:* "Calibrated a static estimator against ground truth (Anthropic `count_tokens`, differential agent runs), reaching ±X% median error
  across N setups; built a reproducible DuckDB pipeline over 1,000 public repos and published the 'State of agent context' report."

Each bullet is backed by a public artifact (`docs/ACCURACY.md`, the Action listing, `bench/`, the npm provenance badge), which matters more than the star count.

---

## Appendix A: commands used for this audit

```sh
npm ci && npm run typecheck && npm test                     # 489 tests passing
time node dist/cli.js                                       # real run: 126 skills, 10 plugins, 8 MCP servers
node dist/cli.js --markdown-compact | --fix | --json | --card=/tmp/c.png
npm view prehello --json                                    # no attestations; 0.0.0-stage; gitHead fba5bce
curl https://api.npmjs.org/downloads/range/2026-10-20:2026-11-02/prehello
npm view ctxweight clawprint ccusage context-lens ccaudit-cli @framy2/ctxwise
gh search repos ctxwise|ccaudit|clawprint|ctxweight|ctxaudit
gh api repos/<owner>/<repo>/readme                          # competitor READMEs
```

The Cursor listing comparison in 2.3 used prehello's own frontmatter parser (`dist/text/frontmatter.js`) and o200k over the same 126 `SKILL.md`
files, in two formats: `name: <full description>` (prehello's model today) and
`<agent_skill fullPath="$3/<dir>/SKILL.md"><first 80 chars>...</agent_skill>` (the format seen in a live Cursor session).
