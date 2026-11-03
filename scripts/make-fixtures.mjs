// NOTE: "__PROJECT__" / "__SLUG__" placeholders are substituted when tests copy a fixture to a temp dir.
// Generates synthetic fixture trees under test/fixtures/<scenario>/{home,project}.
// All content is invented. Run: node scripts/make-fixtures.mjs   (deterministic; safe to re-run)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");
// Hand-made fixtures (not generated here) survive a re-run.
const KEEP = new Set(["context-output"]);
for (const e of fs.existsSync(ROOT) ? fs.readdirSync(ROOT) : []) if (!KEEP.has(e)) fs.rmSync(path.join(ROOT, e), { recursive: true, force: true });

let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const SENT = [
  "Prefer small, focused functions and name them after what they return.",
  "Run the unit tests before opening a pull request and paste failures verbatim.",
  "Never commit generated files under dist or build directories.",
  "Use the shared logger instead of console.log in application code.",
  "Database migrations must be reversible and reviewed by a second engineer.",
  "API handlers validate input with the schema library and return typed errors.",
  "Keep React components under two hundred lines and extract hooks early.",
  "Feature flags are read through the flags service and default to off.",
  "When adding a dependency, explain the alternative you rejected in the PR.",
  "Error messages are written for the on-call engineer at three in the morning.",
  "Do not mock the database in integration tests; use the disposable container.",
  "Public functions carry doc comments describing units and failure modes.",
];
const para = (n) => Array.from({ length: n }, () => pick(SENT)).join(" ");
const doc = (title, sections) => `# ${title}\n\n` + sections.map((s) => `## ${s}\n\n${para(4)}\n\n- ${pick(SENT)}\n- ${pick(SENT)}\n`).join("\n");
const write = (p, c) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, c);
};
const j = (o) => JSON.stringify(o, null, 2) + "\n";
const fx = (name) => ({ home: path.join(ROOT, name, "home"), proj: path.join(ROOT, name, "project"), root: path.join(ROOT, name) });
const git = (proj) => write(path.join(proj, "__GIT__", "HEAD"), "ref: refs/heads/main\n");
const sharedText = doc("Acme Web engineering guide", ["Commands", "Architecture", "Testing", "Style", "Review"]);

// ---------- realistic: three agents, MCP, rules, skills, nested files, duplicates ----------
{
  const { home, proj } = fx("realistic");
  git(proj);
  write(path.join(home, ".claude", "CLAUDE.md"), doc("Personal preferences", ["Tone", "Tooling"]));
  write(path.join(home, ".claude", "settings.json"), j({ model: "claude-sonnet-fixture", env: {} }));
  write(path.join(home, ".claude.json"), j({
    mcpServers: { github: { command: "npx", args: ["-y", "@example/github-mcp"], env: { GITHUB_TOKEN: "FIXTURE_NOT_A_REAL_TOKEN" } }, playwright: { command: "npx", args: ["@playwright/mcp@latest"] } },
    projects: { "__PROJECT__": { mcpServers: { "local-db": { type: "http", url: "https://db.example.invalid/mcp" } } } },
  }));
  for (const [n, d] of [["code-review", "Review a diff for correctness, security and style. Use when the user asks for a review."], ["release-notes", "Draft release notes from merged pull requests since the last tag."], ["db-migrate", "Plan and verify a database migration. " + para(3)]]) {
    write(path.join(home, ".claude", "skills", n, "SKILL.md"), `---\nname: ${n}\ndescription: ${d}\n---\n\n${doc(n, ["When to use", "Steps", "Checks"])}`);
  }
  write(path.join(home, ".claude", "agents", "reviewer.md"), `---\nname: reviewer\ndescription: Reviews pull requests.\n---\n\n${para(6)}\n`);
  write(path.join(home, ".cursor", "mcp.json"), j({ mcpServers: { filesystem: { command: "npx", args: ["-y", "@example/fs-mcp", "/tmp"] }, fetch: { command: "uvx", args: ["mcp-server-fetch"] } } }));
  write(path.join(home, ".codex", "config.toml"), `model = "fixture-model"\n\n[mcp_servers.docs]\ncommand = "npx"\nargs = ["-y", "@example/docs-mcp"]\n`);
  write(path.join(home, ".codex", "AGENTS.md"), doc("Global Codex notes", ["Habits"]));
  write(path.join(proj, "CLAUDE.md"), `<!-- maintainers: keep this file short; comments here cost nothing -->\n${sharedText}\nSee @docs/architecture.md for the module map.\n`);
  write(path.join(proj, "docs", "architecture.md"), doc("Architecture", ["Modules", "Data flow", "Deploy"]));
  write(path.join(proj, "AGENTS.md"), sharedText); // identical to CLAUDE.md body -> duplicate (F2); ignored by Claude (F7)
  write(path.join(proj, ".claude", "rules", "style.md"), doc("Style rules", ["Naming", "Imports"]));
  write(path.join(proj, ".claude", "rules", "frontend.md"), `---\npaths:\n  - "src/ui/**"\n  - "src/components/**"\n---\n\n${doc("Frontend rules", ["Components", "State"])}`);
  write(path.join(proj, ".claude", "skills", "deploy", "SKILL.md"), `---\nname: deploy\ndescription: Deploy the app to staging and verify health checks.\n---\n\n${doc("deploy", ["Steps"])}`);
  write(path.join(proj, ".mcp.json"), j({ mcpServers: { sentry: { type: "sse", url: "https://sentry.example.invalid/sse" } } }));
  write(path.join(proj, "packages", "web", "CLAUDE.md"), doc("Web package notes", ["Build"]));
  write(path.join(proj, ".cursor", "rules", "always.mdc"), `---\nalwaysApply: true\n---\n\n${doc("Always rule", ["Policy"])}`);
  write(path.join(proj, ".cursor", "rules", "tests.mdc"), `---\nglobs: "**/*.test.ts, **/*.spec.ts"\nalwaysApply: false\n---\n\n${doc("Testing rule", ["Policy"])}`);
  write(path.join(proj, ".cursor", "rules", "api-design.mdc"), `---\ndescription: Guidelines for designing HTTP APIs in this repo\nalwaysApply: false\n---\n\n${doc("API design", ["Resources", "Errors"])}`);
  write(path.join(proj, ".cursor", "rules", "manual.mdc"), `---\nalwaysApply: false\n---\n\n${doc("Manual rule", ["Notes"])}`);
  write(path.join(proj, ".cursor", "rules", "ignored.md"), "This plain markdown rule is ignored by Cursor.\n");
}

// ---------- claude-agents-and-claude (F7) ----------
{
  const { home, proj } = fx("claude-agents-and-claude");
  git(proj);
  write(path.join(home, ".claude", "settings.json"), j({}));
  write(path.join(proj, "CLAUDE.md"), doc("Project", ["A", "B"]));
  write(path.join(proj, "AGENTS.md"), doc("Agents file", ["C", "D"]));
}
// ---------- claude-agents-md-only (fallback loads AGENTS.md) ----------
{
  const { home, proj } = fx("claude-agents-md-only");
  git(proj);
  write(path.join(home, ".claude", "settings.json"), j({}));
  write(path.join(proj, "AGENTS.md"), doc("Agents file", ["C", "D"]));
}
// ---------- claude-memory-over-200 ----------
{
  const { home, proj } = fx("claude-memory-over-200");
  git(proj);
  write(path.join(home, ".claude", "projects", "__SLUG__", "memory", "MEMORY.md"), Array.from({ length: 260 }, (_, i) => `- [topic-${i}](topic-${i}.md) — ${pick(SENT)}`).join("\n") + "\n");
  write(path.join(proj, "CLAUDE.md"), "# Tiny\n\nKeep it simple.\n");
}
// ---------- claude-mcp-toolsearch-off ----------
{
  const { home, proj } = fx("claude-mcp-toolsearch-off");
  git(proj);
  write(path.join(home, ".claude", "settings.json"), j({ env: { ENABLE_TOOL_SEARCH: "false" } }));
  write(path.join(proj, ".mcp.json"), j({ mcpServers: { playwright: { command: "npx", args: ["@playwright/mcp@latest"] }, notes: { command: "node", args: ["notes-server.js"] } } }));
  write(path.join(proj, "CLAUDE.md"), "# Tiny\n\nKeep it simple.\n");
}
// ---------- mcp-catalog (user-supplied weights make servers measured) ----------
{
  const { home, proj, root } = fx("mcp-catalog");
  git(proj);
  write(path.join(home, ".claude", "settings.json"), j({}));
  write(path.join(proj, ".mcp.json"), j({ mcpServers: { playwright: { command: "npx", args: ["@playwright/mcp@latest"] }, mystery: { command: "node", args: ["x.js"] } } }));
  write(path.join(proj, "CLAUDE.md"), "# Tiny\n\nKeep it simple.\n");
  write(path.join(root, "catalog.json"), j({ version: 1, servers: [{ package: "@playwright/mcp", tools: 21, nameTokens: 150, schemaTokens: 6400, measuredAt: "2026-01-01 (FIXTURE DATA, not a real measurement)", version: "fixture" }] }));
}
// ---------- codex-chain-override ----------
{
  const { home, proj } = fx("codex-chain-override");
  git(proj);
  write(path.join(home, ".codex", "AGENTS.override.md"), "# Global override\n\nAlways answer briefly.\n");
  write(path.join(home, ".codex", "AGENTS.md"), "# Global (shadowed by override)\n\nThis one is not loaded.\n");
  write(path.join(home, ".codex", "config.toml"), `project_doc_fallback_filenames = ["TEAM_GUIDE.md"]\n`);
  write(path.join(proj, "AGENTS.md"), doc("Root agents", ["Root"]));
  write(path.join(proj, "services", "api", "AGENTS.override.md"), doc("API override", ["API"]));
  write(path.join(proj, "services", "api", "AGENTS.md"), "shadowed by override in same dir\n");
  write(path.join(proj, "services", "api", "handlers", "TEAM_GUIDE.md"), doc("Team guide fallback", ["Handlers"]));
}
// ---------- codex-32k-truncate ----------
{
  const { home, proj } = fx("codex-32k-truncate");
  git(proj);
  write(path.join(home, ".codex", "config.toml"), "# defaults\n");
  write(path.join(proj, "AGENTS.md"), "# Big root file\n\n" + Array.from({ length: 330 }, () => para(3)).join("\n\n") + "\n");
  write(path.join(proj, "sub", "AGENTS.md"), doc("Sub", ["Never loaded"]));
}
// ---------- monorepo-ancestors ----------
{
  const { home, proj, root } = fx("monorepo-ancestors");
  write(path.join(root, "project", "__GIT__", "HEAD"), "ref: refs/heads/main\n");
  write(path.join(home, ".claude", "settings.json"), j({}));
  write(path.join(proj, "CLAUDE.md"), doc("Monorepo root", ["Root"]));
  write(path.join(proj, "apps", "CLAUDE.md"), doc("Apps level", ["Apps"]));
  write(path.join(proj, "apps", "web", "CLAUDE.local.md"), "# Local\n\nMy local notes.\n");
  write(path.join(proj, "apps", "web", ".claude", "CLAUDE.md"), doc("Web package", ["Web"]));
  fs.mkdirSync(path.join(proj, "apps", "web", "src"), { recursive: true });
  write(path.join(proj, "apps", "web", "src", "CLAUDE.md"), doc("Deeper, conditional", ["Src"]));
}
// ---------- empty-machine ----------
{
  const { home, proj } = fx("empty-machine");
  write(path.join(home, ".gitkeep"), "");
  write(path.join(proj, ".gitkeep"), "");
}
// ---------- repo-only (agent files in repo, no agents on machine) ----------
{
  const { home, proj } = fx("repo-only");
  git(proj);
  write(path.join(home, ".gitkeep"), "");
  write(path.join(proj, ".cursorrules"), doc("Legacy rules", ["One"]));
  write(path.join(proj, "CLAUDE.md"), doc("Claude file", ["Two"]));
}
// ---------- symlink-escape ----------
{
  const { home, proj, root } = fx("symlink-escape");
  git(proj);
  write(path.join(home, ".claude", "settings.json"), j({}));
  write(path.join(root, "outside", "secret-notes.md"), "OUTSIDE-CANARY-DO-NOT-READ " + para(8) + "\n");
  fs.mkdirSync(proj, { recursive: true });
  fs.symlinkSync(path.join("..", "outside", "secret-notes.md"), path.join(proj, "CLAUDE.md"));
  write(path.join(proj, "AGENTS.md"), "# ok\n\nA normal file.\n");
}
// ---------- crlf-unicode ----------
{
  const { home, proj } = fx("crlf-unicode");
  git(proj);
  write(path.join(home, ".claude", "settings.json"), j({}));
  write(path.join(proj, "CLAUDE.md"), "\uFEFF# Règles du projet 🚀\r\n\r\n- Écrire des tests avant le code.\r\n- 日本語のコメントを許可する。\r\n- Не коммитить секреты.\r\n<!-- note -->\r\n```\r\n<!-- kept: inside a code fence -->\r\n```\r\n");
}
// ---------- binary-garbage ----------
{
  const { home, proj } = fx("binary-garbage");
  git(proj);
  write(path.join(home, ".claude", "settings.json"), j({}));
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, "CLAUDE.md"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13, 0xff, 0xfe, 0, 1, 2, 3]));
  write(path.join(proj, "AGENTS.md"), "# fine\n\nStill measured.\n");
}
// ---------- privacy-canary: secrets, usernames, server names, paths that must never reach card/strict output ----------
{
  const { home, proj } = fx("privacy-canary");
  git(proj);
  write(path.join(home, ".claude", "settings.json"), j({}));
  write(path.join(home, ".claude", "CLAUDE.md"), "# Notes\n\nCANARY-FILE-CONTENT-ALPHA " + para(5) + "\napi_key = \"CANARYSECRETVALUE1234567890abcdef\"\n");
  write(path.join(home, ".claude.json"), j({ mcpServers: { "canary-server-name-zeta": { command: "npx", args: ["-y", "@canary-org/secret-pkg"], env: { TOKEN: "CANARYENVVALUE-xyz" } } } }));
  write(path.join(proj, "CLAUDE.md"), "# Project CANARY-PROJECT-CONTENT-BETA\n\n" + para(6) + "\n");
  write(path.join(proj, ".cursor", "rules", "canary-rule-name-gamma.mdc"), `---\nalwaysApply: true\n---\n\n${para(6)}\n`);
  write(path.join(home, ".cursor", "mcp.json"), j({ mcpServers: {} }));
}
// ---------- plugin-heavy: Cursor with three local plugins and a handful of own skills (savings / "what to cut") ----------
{
  const { home, proj } = fx("plugin-heavy");
  git(proj);
  const skill = (dir, name, desc) => write(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\n${para(3)}\n`);
  const desc = (topic) => `Use when the user asks about ${topic}. ${pick(SENT)} ${pick(SENT)}`;
  for (const [plugin, topic, n] of [["analytics-kit", "product analytics, funnels and experiments", 40], ["design-kit", "design systems, tokens and components", 24], ["cloud-kit", "cloud infrastructure and deployments", 14]]) {
    const base = path.join(home, ".cursor", "plugins", "local", plugin);
    write(path.join(base, ".cursor-plugin", "plugin.json"), j({ name: plugin }));
    for (let i = 1; i <= n; i++) skill(path.join(base, "skills"), `${plugin.split("-")[0]}-task-${i}`, desc(topic));
  }
  for (let i = 1; i <= 5; i++) skill(path.join(home, ".cursor", "skills"), `my-helper-${i}`, desc("my own workflows"));
  write(path.join(proj, "AGENTS.md"), doc("Acme Web engineering guide", ["Commands", "Architecture", "Testing"]));
  write(path.join(proj, ".cursor", "rules", "always.mdc"), `---\nalwaysApply: true\n---\n\n${para(10)}\n`);
}

// ---------- copilot-mix: GitHub Copilot (CLI + VS Code) ----------
{
  const { home, proj } = fx("copilot-mix");
  git(proj);
  const shared = "# Shared agent guide\n\nRun npm test before pushing. Keep handlers thin.\n";
  write(path.join(home, ".copilot", "copilot-instructions.md"), "# Personal\n\nAnswer briefly. Prefer TypeScript.\n");
  write(path.join(home, ".copilot", "instructions", "personal.instructions.md"), `---\napplyTo: "**"\n---\nAlways explain trade-offs in one sentence.\n`);
  write(path.join(home, ".copilot", "mcp-config.json"), j({ mcpServers: { context7: { type: "local", command: "npx", args: ["-y", "@upstash/context7-mcp"], tools: ["*"] } } }));
  write(path.join(proj, ".github", "copilot-instructions.md"), "# Repo instructions\n\nSee @../docs/style.md for style.\nIgnored: @/etc/hosts and @~/private.md\n\n" + para(3) + "\n");
  write(path.join(proj, "docs", "style.md"), "# Style\n\nTwo-space indent. No default exports.\n");
  write(path.join(proj, "AGENTS.md"), shared);
  write(path.join(proj, "CLAUDE.md"), shared); // identical: Copilot CLI removes the duplicate
  write(path.join(proj, "GEMINI.md"), "# Gemini notes\n\n@docs/style.md is not expanded by Copilot.\n");
  write(path.join(proj, ".github", "instructions", "ts.instructions.md"), `---\napplyTo: "**/*.ts,**/*.tsx"\n---\n# TypeScript\n\n${para(2)}\n`);
  write(path.join(proj, ".github", "instructions", "backend", "review.instructions.md"), `---\ndescription: "Use when reviewing API handlers."\n---\n# Review\n\n${para(2)}\n`);
  write(path.join(proj, ".github", "instructions", "manual.instructions.md"), "# Manual only\n\nAttach me by hand.\n");
  write(path.join(proj, ".github", "prompts", "release.prompt.md"), `---\nagent: agent\ndescription: Cut a release\n---\nBump the version, update the changelog and tag.\n`);
  write(path.join(proj, ".vscode", "mcp.json"), j({ servers: { playwright: { command: "npx", args: ["@playwright/mcp@latest"] } } }));
  write(path.join(proj, ".mcp.json"), j({ mcpServers: { context7: { command: "npx", args: ["-y", "@upstash/context7-mcp"] } } }));
  write(path.join(proj, "packages", "api", "AGENTS.md"), "# API package\n\nHandlers return typed errors.\n");
}
// ---------- gemini-mix: Gemini CLI ----------
{
  const { home, proj, root } = fx("gemini-mix");
  git(proj);
  write(path.join(root, "GEMINI.md"), "# Above the .git boundary: never loaded\n"); // parent of the project
  write(path.join(home, ".gemini", "GEMINI.md"), "# Global\n\nBe concise.\n");
  write(path.join(home, ".gemini", "AGENTS.md"), "# Global agents file (listed in context.fileName)\n\nPrefer small diffs.\n");
  write(path.join(home, ".gemini", "settings.json"), j({ context: { fileName: ["GEMINI.md", "AGENTS.md"] }, mcpServers: { github: { httpUrl: "https://api.example.invalid/mcp" } } }));
  write(path.join(home, ".gemini", "extensions", "acme-ext", "gemini-extension.json"), j({ name: "acme-ext", version: "1.0.0", contextFileName: "ACME.md", mcpServers: { github: { command: "node", args: ["x.js"] }, "acme-db": { command: "node", args: ["${extensionPath}/db.js"] } } }));
  write(path.join(home, ".gemini", "extensions", "acme-ext", "ACME.md"), "# Acme extension\n\nUse the acme-db tools for SQL.\n");
  write(path.join(proj, "GEMINI.md"), "# Project\n\n@./docs/a.md\n\n```\n@./docs/ignored.md\n```\n\n" + para(3) + "\n");
  write(path.join(proj, "docs", "a.md"), "# A\n\nImported. Also @./b.md\n");
  write(path.join(proj, "docs", "b.md"), "# B\n\nImported twice removed.\n");
  write(path.join(proj, "docs", "ignored.md"), "# Ignored\n\nInside a code block, so not imported.\n");
  write(path.join(proj, "AGENTS.md"), "# Agents\n\nShared with other agents.\n");
  write(path.join(proj, "services", "GEMINI.md"), "# Services\n\nLoaded just in time.\n");
  write(path.join(proj, ".gemini", "settings.json"), j({ mcpServers: { "local-tool": { command: "python", args: ["tool.py"] } } }));
  write(path.join(proj, ".gemini", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Deploy the app to staging.\n---\nRun the deploy script.\n");
}
console.log("fixtures written to", ROOT);
