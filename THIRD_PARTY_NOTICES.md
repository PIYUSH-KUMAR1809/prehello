# Third-party notices

prehello itself is MIT licensed (see `LICENSE`). It uses the following third-party material.

## Runtime dependencies (installed by npm, not copied into this repository)

| Package | Licence | Used for |
| --- | --- | --- |
| [gpt-tokenizer](https://github.com/niieani/gpt-tokenizer) 4.x | MIT | token counting with the `o200k_base` encoding. The encoding data originates from OpenAI's [tiktoken](https://github.com/openai/tiktoken) (MIT). |
| [picomatch](https://github.com/micromatch/picomatch) 4.x | MIT | glob matching for agent settings (for example `claudeMdExcludes`) |
| [smol-toml](https://github.com/squirrelchat/smol-toml) 1.x | BSD-3-Clause | reading Codex `config.toml` |

## Optional dependency

| Package | Licence | Used for |
| --- | --- | --- |
| [@resvg/resvg-wasm](https://github.com/yisibl/resvg-js) 2.x (resvg) | MPL-2.0 | rendering the PNG share card. Installed as an npm `optionalDependency`, loaded only when you ask for a PNG, never modified or bundled here. Its source and licence are available from the package. |

## Bundled files

| File | Licence | Notes |
| --- | --- | --- |
| `assets/fonts/Inter-*.subset.ttf` | SIL Open Font License 1.1 | Subsets (Basic Latin, Latin-1, a few punctuation marks) of static instances of [Inter](https://github.com/rsms/inter), Copyright 2016 The Inter Project Authors. Used only to draw the PNG card. The licence text is in `assets/fonts/OFL.txt`. |

## Development-only dependencies (not shipped)

TypeScript (Apache-2.0), vitest (MIT), ajv and ajv-formats (MIT), `@types/*` (MIT). The SARIF 2.1.0 JSON schema in `test/schema/` is published by OASIS (see `test/schema/README.md`).

## Documentation

The loading rules in `spec/*.json` are facts summarised from the public documentation of Claude Code, Cursor and Codex, each with the URL it came from. No documentation text is copied.

The Code of Conduct is the [Contributor Covenant](https://www.contributor-covenant.org) 2.1 (CC BY 4.0).
