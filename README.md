<h1 align="center">prehello</h1>

<p align="center"><b>See what your coding agent loads before you say hello, and what you could cut.</b></p>

<p align="center">
  <a href="https://github.com/PIYUSH-KUMAR1809/prehello/actions/workflows/ci.yml"><img src="https://github.com/PIYUSH-KUMAR1809/prehello/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/prehello"><img src="https://img.shields.io/npm/v/prehello" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522-brightgreen" alt="Node 22 or newer">
  <img src="https://img.shields.io/badge/platform-linux%20%7C%20macos%20%7C%20windows-lightgrey" alt="Linux, macOS and Windows">
</p>

<p align="center">
  <img src="docs/sample-card-cursor.png" width="760" alt="A prehello share card: 'Skills and plugins cost ~3.9k tokens before hello', with a treemap of which plugins and files they come from">
  <br>
  <sub>A share card (<code>--card=card.png</code>). Sample data shaped like a real Cursor setup, not a real machine.</sub>
</p>

Every Claude Code, Cursor, Codex, GitHub Copilot or Gemini CLI session starts with a pile of rules, skills, plugin listings and MCP servers already sitting
in the context window, before you type a word. **prehello** scans your repo and your home-directory agent config and tells you
**how many tokens that is, which plugin or skill folder is responsible, and roughly what removing the top few would save.**

- **Local and read-only.** No network, no telemetry, no API key, no child processes. Nothing leaves your machine.
- **Honest numbers.** Every count is an estimate (`~`). What it cannot measure is listed, never shown as 0.
- **Actionable.** A ranked "what to cut" list, a share card, a Markdown report, SARIF for code scanning, and a `--max-tokens` CI gate.

## Try it

```sh
npx prehello                                   # scan the current folder plus your user-level agent config
npx prehello ~/code/your-project               # scan a specific project
npx prehello ~/code/your-project --card=card.png  # also write a PNG share card
npm install -g prehello                        # or install it once and run `prehello`
```

Needs Node 22 or newer, on Linux, macOS or Windows.

<details>
<summary>Run from source instead</summary>

```sh
git clone https://github.com/PIYUSH-KUMAR1809/prehello.git
cd prehello
npm ci && npm run build
node dist/cli.js ~/code/your-project
```

</details>

## What it prints

A real run on bundled **fixture** data (`test/fixtures/plugin-heavy`: three invented plugins plus a few skills), not anyone's real numbers:

```text
prehello 0.1.0 · this folder + user config · window 200k
Token counts are ESTIMATES (o200k BPE with per-agent scaling factors), shown with
~. Not exact for any model.

Before your first message: Cursor ~5.2k tokens

What to cut (estimates)
  Cursor  skills, plugins and MCP servers add ~4.7k tokens before hello: 91% of
          the measured always-on total, in 4 groups.
          Top 3 groups = 95% of that. Removing them would save about 4.5k tokens
          (2.2% of a 200k window); estimate, not a promise.
           1. plugin analytics-kit (40 skills)               ~2.3k    45%
           2. plugin design-kit (24 skills)                  ~1.4k    26%
           3. plugin cloud-kit (14 skills)                    ~765    15%

Measured vs. not measured (always-on items)
  Cursor  measured 4 of 4 (100%): 2 skills listings, 1 instruction file, 1 rule
...
```

That is the first screen. Below it come a per-agent breakdown (always-on / conditional / deferred / on-demand), what could not be measured, and a
Context Grade (a heuristic of this tool, not a standard). The full output is in [docs/REFERENCE.md](docs/REFERENCE.md).

> **Read the numbers as "what YOUR config adds".** The agent's own built-in system prompt and built-in tool definitions are **not** counted:
> they are usually the largest fixed chunk of the context window and are not on disk, so no static scanner can see them. prehello's total is the part
> *you* control. For the exact live total in one Claude Code session, use `/context`.

### On one real machine

The author's own Cursor setup, one run of prehello 0.1.0 on 2026-10-25. **One machine, estimates, not reproducible from this repo.**

| What | Estimate, before hello |
| --- | --- |
| Skills, plugins and MCP servers | **at least ~14.3k tokens** (a lower bound: items prehello cannot measure, such as Cursor User Rules, are not in it) |
| Cut list, top 3 of 6 groups | `plugin posthog` ~10.3k (72%), `plugin figma` ~1.7k, 18 Cursor-managed skills ~1.3k: removing them would save about **~13.2k** |

Almost all of it is skill listings, mostly from one plugin. Every enabled skill puts its name and description in the context on every session,
whether you use it or not. That is what the cut list is for, and removing a plugin you actually use costs you the plugin.

### Across 559 public repositories

The [State of agent context 2026](docs/BENCHMARK.md) benchmark ran prehello with an empty HOME on 559 public GitHub repositories that ship agent files.
The median repo adds **~2.2k tokens** before hello (p90 ~8.4k, max ~53k). 20% have both CLAUDE.md and AGENTS.md at the root, so Claude Code ignores AGENTS.md,
and 17% have an instruction file longer than the agent's documented guideline. Data and scripts are in [`benchmark/`](benchmark/).

## Outputs

| You want | Run |
| --- | --- |
| The report in the terminal | `node dist/cli.js` (`--verbose` for per-item evidence) |
| A share card (PNG or SVG) | `--card=card.png` or `--card=card.svg` (write the name with `=`) |
| Something to paste into an issue, PR or Slack | `--markdown` (or `--markdown=report.md`, `--markdown-compact` for a PR comment) |
| GitHub code scanning / IDEs | `--sarif=prehello.sarif` |
| Machine-readable | `--json` (add `--redact` before sharing it: no paths or names) |
| A budget gate in CI | `--max-tokens 16k` (exit code 2 above it) |
| What a PR changes | `--save base.json` / `--save head.json`, then `prehello diff base.json head.json` (`--markdown`, `--fail-above 2k`) |
| A PR comment on every pull request | the GitHub Action: `uses: PIYUSH-KUMAR1809/prehello@v1` ([docs/github-action.md](docs/github-action.md)) |
| A README badge | `--badge badge.json` (shields.io endpoint JSON; see [docs/github-action.md](docs/github-action.md#badge)) |
| Check the estimate against Claude Code | `prehello calibrate --file ctx.txt` (paste `/context` output; see [docs/ACCURACY.md](docs/ACCURACY.md)) |
| Suggestions, changing nothing | `--fix` (dry run) |
| Count Cursor "User Rules" you paste in | `--paste-user-rules rules.txt` |
| Also count agent files inside test-fixture folders | `--include-fixtures` (skipped by default; see [docs/REFERENCE.md](docs/REFERENCE.md)) |

`node dist/cli.js --help` lists every flag. PNG cards need the optional package `@resvg/resvg-wasm`; if it is missing, prehello prints how to install it
and exits 1 without a stack trace, and the SVG card and everything else keep working.

## Agents covered

Claude Code, Cursor, Codex, GitHub Copilot (CLI and VS Code), Gemini CLI, and plain `AGENTS.md` files. Details of what is scanned for each are in [docs/REFERENCE.md](docs/REFERENCE.md). Not yet: Windsurf, Cline.

## FAQ

**Does it send anything anywhere?** No. No network, no telemetry, no API key, no child processes. A test runs the CLI with a guard that blocks and records any
network, DNS or child-process attempt. It writes only the output files you name (`--card=`, `--json=`, `--markdown=`, `--sarif=`).

**Is the token count exact?** No, and it says so. It counts with the o200k tokenizer and applies a per-agent factor. The Claude factors come from
published `count_tokens` measurements (a small sample, see [docs/ACCURACY.md](docs/ACCURACY.md)), not from prehello's own runs, so every
total carries an error band and a `~`. `prehello calibrate` compares the estimate with your own Claude Code `/context` reading.

**Why is my total smaller than what `/context` shows?** `/context` also sees the built-in system prompt, built-in tool definitions and the conversation. prehello only sees what is on disk.

**Why not just use `/context`?** If you only use Claude Code and want the true number for one live session, do. prehello works before a session, covers Cursor, Codex, Copilot and Gemini CLI too,
runs in CI, and ranks *which plugin or skill folder* to remove.

**Does it start my MCP servers?** No. It lists their names and counts. Sizes come only from a small measured catalog (`spec/mcp-weights.json`, 7 servers) or a file you give it; every other server stays "unmeasured".

**Does it change my files?** No. `--fix` is a dry run that only prints suggestions.

**Can I trust the Context Grade?** It is a heuristic of this tool, not a standard. It is capped at B and marked provisional when something that always loads could not be measured. `node dist/cli.js explain grade` prints the rubric. `--no-grade` hides it.

**Why does it say "Skipped N fixture folders"?** A repo that tests agent tooling keeps sample `AGENTS.md`, `CLAUDE.md`, `.cursor/rules` and skills under `test/fixtures/` and similar. No agent loads those, so prehello skips such folders by default and says how many it skipped (only folders where it found agent files). `--include-fixtures` counts them; scanning a folder that is itself inside a fixtures folder never skips anything.

**Does it work on Windows?** Yes. CI runs the full suite on Ubuntu, Windows and macOS with Node 22 and 24. See [docs/REFERENCE.md](docs/REFERENCE.md).

## Limitations

- Token counts are **estimates**; the Claude factors rest on about 10 published measurements, and Cursor's model is unknown (see [docs/ACCURACY.md](docs/ACCURACY.md)).
- The built-in system prompt, built-in tools, Cursor User and Team Rules (unless pasted), claude.ai connectors, hook output and anything injected at runtime are **never measured**.
- Loading rules come from the agents' public docs and announcements, not from their source, and were **not re-verified against live installs**; items where sources disagree are labelled `assumed`.
- Five agents plus `AGENTS.md` are covered (Copilot and Gemini CLI token factors are unvalidated), and MCP server sizes exist for just 7 servers.

Full list: [docs/REFERENCE.md](docs/REFERENCE.md).

## How it differs

Several small tools look at neighbouring problems. As of 2026-10-25, from each project's own npm, PyPI or docs page; **I read them, I did not run them**.
They overlap with prehello in places, so if one of them fits better, use it.

- **`/context`** (built into Claude Code): per Anthropic, it visualizes what is currently loaded into the context window and where it is being spent, for the live session.
- **ccusage**: its npm description is "Analyze coding (agent) CLI token usage and costs from local data", so it is about what past sessions used and cost, not what loads before a session.
- **ctxlint**: a linter for AI agent context files and MCP configs, catching broken paths, wrong commands and leaked secrets.
- **ctxweight** (npm, v0.1.0): describes itself as an X-ray of your agent's context, with health checks and token cost in one command.
- **ctxaudit**: audits "the invisible context tax" from skills, rules and instruction files (v0.1.0, PyPI).

What prehello focuses on: a per-plugin / per-skill-folder **cut list**, **unmeasured is never 0** (totals become lower bounds), a confidence label on every item
(`documented`, `observed`, `assumed`), a share card that holds no paths or file contents, and a CI gate. What it does **not** do: live sessions, dollar cost,
linting your instructions against your code, or exact token counts.

## Roadmap

Not yet: `--probe` (starting MCP servers to measure real schemas), history beyond two snapshots, `--apply` / `--patch`, Windsurf and Cline adapters,
Cursor Team Rules, a catalog beyond the 7 measured servers.

## Contributing, security, licence

Issues and PRs are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md) (the ground rules are product promises: local, read-only, estimates labelled, no file contents in output).
Report vulnerabilities as described in [SECURITY.md](SECURITY.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

MIT © 2026 Piyush Kumar
