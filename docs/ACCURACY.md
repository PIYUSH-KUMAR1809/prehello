# How accurate are prehello's numbers?

prehello estimates. It does not read your agent's real context, and its tokenizer is OpenAI's o200k, not Anthropic's. This page says where each number comes from and how far off it can be. Everything here was measured by the sources named, not by prehello itself, unless it says otherwise.

## Counting

| Agent | How | Band |
|---|---|---|
| Codex (OpenAI models) | o200k BPE, exact tokenizer for GPT-4o/GPT-5 family | ±3% (wrappers, not tokens) |
| Claude Code | o200k × 1.43 (text) or × 1.35 (JSON, MCP schemas) | ±15% |
| Claude Code `--claude-profile legacy` | the above × 0.82 (Claude 4.6 and older tokenizer) | ±15% |
| Cursor | model unknown: midpoint of GPT-like and Claude-like | GPT-like −3% to Claude-like +15% |
| GitHub Copilot | model is user-selectable (GPT, Claude, Gemini, ...): same midpoint as Cursor, unvalidated | GPT-like −3% to Claude-like +15% |
| Gemini CLI | o200k × 1.0. No published Gemini-vs-o200k ratio was found, so none is applied; the band is the GPT-like-to-Claude-like spread, borrowed, NOT a Gemini measurement (unvalidated) | −3% to +64% |
| `--tokenizer heuristic` | chars / 3.5 (3.0 for JSON) | ±35% |

## Where the Claude factors come from

`spec/calibration.json` holds the data points (each with its URL). Claude 4.7 and later (Opus/Sonnet/Haiku share one tokenizer):

| Content | Claude / o200k | Source |
|---|---|---|
| English prose | 1.486 | measuredlab.com/tools/token-counter, measured 2026-10-23 via count_tokens |
| Markdown / reST, 5 files (44,621 → 61,523 tokens) | 1.38 | aitoollabs.dev/posts/count-tokens-in-codebase, `claude -p` differential |
| Code, 20 files (45,006 → 71,330) | 1.58 | aitoollabs.dev (not used: prehello counts no code) |
| JSON | 1.282 | measuredlab.com |
| YAML / JSON / TOML | 1.42 | aitoollabs.dev |
| German/French/Spanish | 1.806 | measuredlab.com (not used; see below) |
| Chinese/Japanese | 1.301 | measuredlab.com |
| Older tokenizer (Sonnet 4.6) | 0.82 × current | aitoollabs.dev ("18% fewer tokens") |

prehello uses the mean of the two text points (1.43) and of the two JSON points (1.35). The two sources disagree by about ±4% around those means; single files ranged 1.43–1.84 for code. A ±15% band covers every English text and JSON point above. It does **not** cover non-English prose (×1.8): a CLAUDE.md written in German can be undercounted by about 20%.

About 10 data points from two independent sources is a small sample, so the Claude profile is still marked `unvalidated` in the JSON output.

## Wrappers

The agent wraps each file before the model sees it (headers, `<system-reminder>`, skill listing lines). prehello models these from the vendors' docs and captured prompts; the wrapper text is counted with the same factor. Not measured byte for byte.

## Cursor skills listing

Cursor staff confirmed on the forum (forum.cursor.com/t/163761, 2026-06-22 and 2026-06-25) that the preloaded skill list is capped: descriptions are shortened first (cloud agents showed 80 characters plus an ellipsis), then skills are listed by path only. The cap is not documented. The entry format is `<agent_skill fullPath="…">description</agent_skill>` (forum.cursor.com/t/163768; staff note that a model's dump of its own context is a reconstruction). prehello estimates 80-character entries, with path-only entries as the low end and full descriptions as the high end. The cap itself is unknown, so a very large skill set may cost less than shown.

## Not measured at all

The agent's own system prompt and built-in tools, server-side or team rules, Cursor User Rules (unless pasted), conversation messages, hook output, and anything injected at run time. `/context` shows some of these (System prompt, System tools, Messages); `prehello calibrate` lists them as "not estimated".

## Check it yourself

1. In a fresh Claude Code session in your repository, run `/context` (or `/context all` to list every file) and copy the whole output into `ctx.txt`.
2. `npx prehello calibrate --file ctx.txt` (or `pbpaste | npx prehello calibrate -`).
3. `--json` gives the same as JSON; `--save calibration.json` writes a record with no paths or names that you can attach to an issue.

`/context` rounds (2.8k means 2,750–2,849); "in band" allows for that. Codex's `/status` shows only totals, so there is nothing per category to compare yet.

To refresh the factors from Anthropic directly: `ANTHROPIC_API_KEY=… node scripts/calibrate-anthropic.mjs FILE…` (count_tokens is free) or `node scripts/calibrate-anthropic.mjs --claude-cli FILE…` (uses your Claude Code login).
