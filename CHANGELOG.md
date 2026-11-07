# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## 1.0.0 - 2026-11-07

### Added
#### Agents
- GitHub Copilot (CLI and VS Code): user and repository `copilot-instructions.md`, `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` from the repo root to the working directory, path-specific `*.instructions.md` (`applyTo` → conditional, description only → deferred, neither → ignored), prompt files (on demand), MCP servers from `~/.copilot/mcp-config.json`, `.mcp.json`, `.github/mcp.json`, `.vscode/mcp.json` and VS Code's user `mcp.json`. Sources in `spec/github-copilot.json`.
- Gemini CLI: the `GEMINI.md` hierarchy (`~/.gemini`, working directory up to the `.git` boundary, subdirectories just-in-time), `context.fileName`, `@file` imports, extensions (`gemini-extension.json`), skills and MCP servers from settings. Sources in `spec/gemini-cli.json`.
- Token estimates for both are unvalidated: Copilot uses the "model unknown" midpoint, Gemini the raw o200k count with a borrowed band (no Gemini ratio is invented).
- Agent registry: one list of agents (`src/agents.ts`, `src/adapters/index.ts`) drives the CLI, scan, renderers and token profiles.

#### Calibration
- `prehello calibrate`: paste Claude Code's `/context` output (`--file ctx.txt`, `--context-file`, or `-` for standard input) and see prehello's estimate next to it per category (memory files one by one, skills, custom agents, MCP tools), with the error and whether it falls inside the band. `--json` prints it as JSON; `--save <file>` writes a record with no paths or names. Offline. Reads the grid layout, the newer "Estimated usage by category" layout and the legend-only form.
- `docs/ACCURACY.md`: where every factor comes from, the measured spread, and what is not measured.
- `scripts/calibrate-anthropic.mjs` (development only): measures the Claude/o200k ratio on real files via `count_tokens` or `claude -p`.

#### PR diff, GitHub Action, badge
- `--save <file>` writes a snapshot (the JSON report). `prehello diff <base.json> <head.json>` prints each agent's change, e.g. `Claude Code: +1.2k tokens before hello (~3.1k → ~4.3k, +39%)`, with the 10 biggest item changes. `--markdown` (or `--markdown=<file>`) gives a PR comment, `--json` the data, `--fail-above <tokens>` exits 2 when an agent grows by more. Offline; no git inside prehello.
- GitHub Action (`action.yml`, `uses: PIYUSH-KUMAR1809/prehello@v1`): scans the PR base (git worktree) and head with an empty HOME, writes the job summary and one sticky PR comment, optional `fail-above`. Needs only `pull-requests: write`; fork PRs on `pull_request` fall back to the job summary. `docs/github-action.md` explains `pull_request_target` risk. This repository runs it on its own PRs (`.github/workflows/prehello.yml`).
- `--badge <file>`: a shields.io endpoint JSON (`context before hello: ~5.2k tokens (Cursor)`).

#### Benchmark
- `benchmark/` (not in the npm package): `collect.mjs` samples public GitHub repositories with agent context files across stars buckets, `run.mjs` runs prehello on each with an empty HOME, `analyze.mjs` writes `benchmark/data/summary.json` and the charts in `benchmark/charts/`. Results (559 repositories, 2026-11-03) in `docs/BENCHMARK.md`.

#### Fixture folders
- Test-fixture folders are skipped by the project walk by default, for every agent: `fixtures`, `__fixtures__`, `fixture`, `testdata`, `test-data`, `__mocks__`, `__snapshots__` at any depth, and `snapshots` / `golden` / `goldens` below a `test`/`tests`/`__tests__`/`spec`/`e2e`/`cypress` folder (case-insensitive, both path separators). Running prehello in a repository that keeps sample `AGENTS.md`, `.cursor/rules` or skills there (such as prehello itself) no longer lists them as conditional context. `--include-fixtures` brings them back.
- When a skipped fixture folder held agent files, the terminal report, Markdown and SARIF (`properties.prehello.fixtureFoldersSkipped`) say how many were skipped (a count, no paths) and `--json` has `scan.fixturesSkipped` (absent when 0). Not a warning; the exit code is unchanged.
- A scan whose root is itself inside a fixtures folder never skips anything, and the scanned project's own top-level files are never skipped.

#### Docs
- README rewritten for 1.0: all five agents up front, benchmark numbers and charts, the GitHub Action snippet, error bands, and new screenshots in `docs/images/` (terminal scan, what-to-cut list, PR comment, share card) from real runs on a demo setup built from the test fixtures. Sample cards regenerated. `prehello diff --markdown`: the per-agent `<summary>` line is plain escaped text (GitHub does not render Markdown backticks there).

#### Release and repository tooling
- `release.yml`: pushing a `vX.Y.Z` tag (for the next release; the moving `v1` Action tag and pre-release tags do not trigger it) runs typecheck, tests and the install smoke test, checks that the tag matches `package.json`, then publishes to npm with provenance.
- Dependabot (npm and GitHub Actions, weekly), CodeQL and OpenSSF Scorecard workflows.

### Changed
- Requires Node 22 or newer (`engines.node` is now `>=22`). Node 18 and 20 are end-of-life (April 2025 and April 2026); CI tests Node 22, 24 and 26 on Linux, macOS and Windows.
- `--card card.png` (with a space) is accepted as the card file name, like `--card=card.png`. The next argument is taken as the file name only when it ends in `.svg` or `.png` and is not an existing directory.
- The share card footer and the Markdown report footer now say `npx prehello` and link to the repository.
- The version has one source of truth: `package.json`. `scripts/gen-version.mjs` writes `src/version.ts` before every build and typecheck, and a test fails if they drift.
- MCP configs: `type: "local"` is read as stdio and `httpUrl` as HTTP (Copilot CLI and Gemini CLI formats).
- The long README reference moved to `docs/REFERENCE.md`; SARIF rule help points there.

#### Numbers
- Claude Code: the single ×1.5 ±20% prior is replaced by ×1.43 for text and ×1.35 for JSON (MCP tool schemas), ±15%, from published Claude-tokenizer measurements (`spec/calibration.json`). Claude totals drop by roughly 5–10%. `--claude-profile legacy` is ×0.82 of the current factor (was a flat ×1.2).
- Cursor: the skills listing is now modelled on what Cursor staff described (June 2026): `<agent_skill fullPath="…">` entries with descriptions cut to 80 characters. The low end assumes path-only entries, the high end full descriptions. Cursor skill-heavy totals drop; bands widen.

#### Tests, CI and tooling
- Tests use canonical temp directories (`test/helpers/tmp.ts`). On Windows the runner's temp dir is an 8.3 short path (`C:\Users\RUNNER~1\...`) while prehello, correctly, reports the real one; comparing the two caused most Windows failures (goldens, memory slugs, SARIF, adapters). An opt-in simulation (`PREHELLO_SIM_SHORTPATH=1`) reproduces this on any OS.
- Fixture `.claude.json` files get their `__PROJECT__` placeholder JSON-escaped (a raw `C:\Users\x` made the file invalid JSON).
- Symlink fixtures are stored as `<name>.__SYMLINK__` marker files and linked at run time; tests that need symlinks skip where the OS refuses them.
- The case-insensitive-filesystem simulator handles drive roots; POSIX-only assertions are skipped on Windows; hostile-file-name test no longer needs an ESC file name on Windows; guard scripts embed paths as JSON strings.
- Added `test/ci-portability.test.ts` (canonical temp dirs, JSON escaping, symlink markers, no backslash/drive/temp paths in terminal and `--json` output).
- `scripts/smoke-install.mjs` removes `node_modules/@resvg` after install when newer npm versions install the optional engine despite `--omit=optional`, so the "engine absent" scenario is real.
- CI: `actions/checkout@v5`, `actions/setup-node@v5`; the Windows PowerShell smoke step checks every exit code and uses a unique work directory.
- Tests compared raw Report paths (native: backslashes on Windows) with forward-slash literals (`endsWith("project/CLAUDE.md")`), and a JSON dump with an unescaped path; they now compare normalised values (`posix()` in `test/helpers/tmp.ts`). `leakForms`/`canonical` no longer touch the disk for made-up paths.
- New opt-in simulation `PREHELLO_SIM_WINSEP=1` (`test/helpers/winsep.ts`): tests see a Report whose paths use backslashes while the renderers still get the pristine one. It reproduces the failures of the second run on Linux; CI runs it (together with `PREHELLO_SIM_SHORTPATH=1`) on Ubuntu.

### Fixed
- CHANGELOG: 0.1.0 was published on 2026-10-25.
- Windows: `autoMemoryDirectory` set as `~\...` is expanded like `~/...`.

## 0.1.0 - 2026-10-25

First version.

### Added
- Scan of a repository and the user-level config of Claude Code, Cursor and Codex (and plain `AGENTS.md`): instruction files, rules, skills, plugins, MCP servers.
- Estimated tokens split into always-on / conditional / deferred / on-demand, with low/high bands, an explicit "not measured" list (never counted as 0) and a Context Grade (a heuristic).
- "What to cut": the heaviest plugins, skill folders and MCP servers, with the estimated saving.
- Findings: duplicate files, over-long or truncated files, ignored files, possible secrets (by line number only), skills listings over budget.
- Outputs: terminal, `--json` (versioned, `--redact`), SVG/PNG share cards (`--card`), Markdown report (`--markdown`, `--markdown-compact`), SARIF 2.1.0 (`--sarif`, rules PH001-PH011), `--fix` dry-run plan.
- CI gate `--max-tokens` (exit code 2).
- Safe output writing (no symlinks, no overwriting files prehello did not write), scan budgets, hostile-input limits.
- Linux, macOS and Windows support; Node 18, 20, 22.
