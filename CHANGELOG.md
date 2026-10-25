# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## Unreleased

### Fixed
- Windows: `autoMemoryDirectory` set as `~\...` is expanded like `~/...`.

### Changed (tests, CI and tooling; second Windows CI run)
- Tests compared raw Report paths (native: backslashes on Windows) with forward-slash literals (`endsWith("project/CLAUDE.md")`), and a JSON dump with an unescaped path; they now compare normalised values (`posix()` in `test/helpers/tmp.ts`). `leakForms`/`canonical` no longer touch the disk for made-up paths.
- New opt-in simulation `PREHELLO_SIM_WINSEP=1` (`test/helpers/winsep.ts`): tests see a Report whose paths use backslashes while the renderers still get the pristine one. It reproduces the failures of the second run on Linux; CI runs it (together with `PREHELLO_SIM_SHORTPATH=1`) on ubuntu / Node 20.

### Changed (tests, CI and tooling; found by the first CI run on Windows, macOS and Linux)
- Tests use canonical temp directories (`test/helpers/tmp.ts`). On Windows the runner's temp dir is an 8.3 short path (`C:\Users\RUNNER~1\...`) while prehello, correctly, reports the real one; comparing the two caused most Windows failures (goldens, memory slugs, SARIF, adapters). An opt-in simulation (`PREHELLO_SIM_SHORTPATH=1`) reproduces this on any OS.
- Fixture `.claude.json` files get their `__PROJECT__` placeholder JSON-escaped (a raw `C:\Users\x` made the file invalid JSON).
- Symlink fixtures are stored as `<name>.__SYMLINK__` marker files and linked at run time; tests that need symlinks skip where the OS refuses them.
- The case-insensitive-filesystem simulator handles drive roots; POSIX-only assertions are skipped on Windows; hostile-file-name test no longer needs an ESC file name on Windows; guard scripts embed paths as JSON strings.
- Added `test/ci-portability.test.ts` (canonical temp dirs, JSON escaping, symlink markers, no backslash/drive/temp paths in terminal and `--json` output).
- `scripts/smoke-install.mjs` removes `node_modules/@resvg` after install when newer npm versions install the optional engine despite `--omit=optional`, so the "engine absent" scenario is real.
- CI: `actions/checkout@v5`, `actions/setup-node@v5`; the Windows PowerShell smoke step checks every exit code and uses a unique work directory.

## 0.1.0 (not yet published)

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
