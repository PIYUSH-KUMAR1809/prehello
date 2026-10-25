# Security policy

prehello is a local, read-only command line tool. It reads agent configuration files and prints token estimates; it makes no network
calls and starts no child processes (both are tested). Even so, it parses untrusted files (a repository you cloned can contain a hostile
`CLAUDE.md`, `.cursor/rules/*.mdc` or `.mcp.json`), so security reports are welcome.

## What counts

Please report, privately:

- a way for a crafted file to make prehello **write, delete or overwrite** a file it was not asked to write, follow a symlink out of the scanned project, or read outside the allowed roots;
- a way for file **contents or secrets** to reach any output (terminal, `--json`, `--card`, `--markdown`, `--sarif`);
- a **hang, crash or unbounded memory/output** caused by a small crafted input (regular expression backtracking, huge files, huge directory trees);
- a prototype-pollution or injection issue in the parsers or in the generated Markdown, SVG, JSON or SARIF;
- anything that makes the tool contact the network or run another program.

Wrong token estimates and wrong agent loading rules are bugs, not vulnerabilities: please open a normal issue.

## How to report

Use GitHub's private vulnerability reporting for this repository (Security tab → "Report a vulnerability"). Please do not open a public
issue for a security problem. Include the version (`prehello --version`), your OS and Node version, and a minimal file or directory
layout that reproduces it. Do not send real secrets.

This is a small volunteer project: expect an acknowledgement within about a week and a fix or a clear answer as soon as is practical.
Only the latest released version is supported.

## Safety properties the tests enforce

- The scanner never writes. The only file writers are the output flags you pass, all in `src/safe-write.ts`; a source scan fails the build if a write API appears anywhere else.
- Output files are opened with `O_NOFOLLOW`, re-checked after opening, never written through a symlink, and an existing file is replaced only if it is a previous prehello output (or with `--force`).
- A runtime guard blocks and records any filesystem write, network, DNS, `fetch` or child-process attempt while the CLI runs on fixtures.
- Limits: 4 MiB per file, 64 MiB and 20 s per scan, 5,000 directory entries, 500 MCP servers per config, 2,000 `@import` candidates per file, 300 files in the duplicate check.
