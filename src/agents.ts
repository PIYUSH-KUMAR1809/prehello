/**
 * The single list of supported agents. Everything agent-specific that is not adapter logic lives here:
 * ids, display names, the tokenizer family, the "where we looked" texts and card chips.
 * Adapters are registered in src/adapters/index.ts, keyed by these ids (the compiler enforces completeness);
 * each agent also needs spec/<id>.json (enforced by test/registry.test.ts).
 */
export type TokenFamily = "claude" | "openai" | "mixed" | "gemini";

export interface AgentMeta {
  id: string;
  name: string;
  /** How o200k counts are scaled for this agent (src/tokens/families.ts). */
  tokenFamily: TokenFamily;
  /** Shown when nothing was found: how the agent is detected. */
  lookedFor: string;
  /** Shown when an agent has no measured context: where its context files were searched. */
  whereLooked: string;
  /** Extra advice when nothing on disk could be measured. */
  hint?: string;
  /** Extra share-card chips (things that are known to be unmeasurable). */
  cardChips?: string[];
  /** Top-level files/dirs whose presence makes a folder "a project" (for the not-a-project walk guard). */
  projectMarkers: string[];
}

export const AGENTS = [
  {
    id: "claude-code",
    name: "Claude Code",
    tokenFamily: "claude",
    lookedFor: "~/.claude, ~/.claude.json, `claude` on PATH; CLAUDE.md, .claude/, .mcp.json in the project",
    whereLooked: "CLAUDE.md (project, parent folders, ~/.claude), .claude/{rules,skills,commands}, plugins, .mcp.json, ~/.claude.json",
    projectMarkers: ["CLAUDE.md", "CLAUDE.local.md", ".mcp.json", ".claude/"],
  },
  {
    id: "cursor",
    name: "Cursor",
    tokenFamily: "mixed",
    lookedFor: "~/.cursor, Cursor.app, `cursor` on PATH; .cursor/, .cursorrules, AGENTS.md in the project",
    whereLooked: ".cursor/rules (incl. nested), AGENTS.md, .cursorrules, skills folders, ~/.cursor/{skills,plugins,mcp.json}, .cursor/mcp.json",
    hint: "Cursor's User Rules live inside the app, not on disk. Paste them into a file and run with --paste-user-rules <file> to count them.",
    cardChips: ["unmeasured: User Rules"],
    projectMarkers: [".cursorrules", "AGENTS.md", ".cursor/"],
  },
  {
    id: "codex",
    name: "Codex",
    tokenFamily: "openai",
    lookedFor: "~/.codex, `codex` on PATH; AGENTS.md, .codex/, .agents/skills in the project",
    whereLooked: "AGENTS.md chain, ~/.codex/{AGENTS.md,config.toml}, .agents/skills, ~/.agents/skills, .codex/config.toml",
    projectMarkers: ["AGENTS.md", ".codex/", ".agents/"],
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    tokenFamily: "mixed",
    lookedFor: "~/.copilot, `copilot` on PATH, the VS Code Copilot Chat extension; .github/copilot-instructions.md, .github/instructions/, .github/prompts/, .vscode/mcp.json in the project",
    whereLooked: ".github/copilot-instructions.md, AGENTS.md/CLAUDE.md/GEMINI.md (repo root → cwd), .github/instructions/**, .github/prompts/**, ~/.copilot/{copilot-instructions.md,instructions,mcp-config.json}, .mcp.json, .github/mcp.json, .vscode/mcp.json, VS Code user mcp.json",
    hint: "Organization instructions and VS Code settings-based instructions live on GitHub or in VS Code settings, not in the scanned files.",
    projectMarkers: [".github/copilot-instructions.md", ".github/instructions/", ".vscode/mcp.json"],
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    tokenFamily: "gemini",
    lookedFor: "~/.gemini, `gemini` on PATH; GEMINI.md, .gemini/ in the project",
    whereLooked: "~/.gemini/GEMINI.md, GEMINI.md (cwd → project root, and below cwd), context.fileName, ~/.gemini/extensions/*, ~/.gemini/settings.json, .gemini/settings.json, .gemini/skills, .agents/skills",
    projectMarkers: ["GEMINI.md", ".gemini/"],
  },
] as const satisfies readonly AgentMeta[];

export type AgentId = (typeof AGENTS)[number]["id"];
export const ALL_AGENTS: AgentId[] = AGENTS.map((a) => a.id);
export const AGENT_NAMES = Object.fromEntries(AGENTS.map((a) => [a.id, a.name])) as Record<AgentId, string>;
export function agentMeta(id: AgentId): AgentMeta {
  return AGENTS.find((a) => a.id === id)!;
}
