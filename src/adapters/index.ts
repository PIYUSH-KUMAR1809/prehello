import type { AgentId } from "../agents";
import { Ctx } from "../context";
import { AdapterResult, Detection } from "./types";
import { detectClaude, discoverClaude } from "./claude-code";
import { detectCursor, discoverCursor } from "./cursor";
import { detectCodex, discoverCodex } from "./codex";
import { detectCopilot, discoverCopilot } from "./github-copilot";
import { detectGemini, discoverGemini } from "./gemini-cli";

export interface Adapter {
  detect: (c: Ctx) => Detection;
  discover: (c: Ctx) => AdapterResult;
}

/** One adapter per id in src/agents.ts. A missing entry is a compile error. */
export const ADAPTERS: Record<AgentId, Adapter> = {
  "claude-code": { detect: detectClaude, discover: discoverClaude },
  cursor: { detect: detectCursor, discover: discoverCursor },
  codex: { detect: detectCodex, discover: discoverCodex },
  "github-copilot": { detect: detectCopilot, discover: discoverCopilot },
  "gemini-cli": { detect: detectGemini, discover: discoverGemini },
};
