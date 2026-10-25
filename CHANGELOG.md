# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## Unreleased

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
