export const SCHEMA_VERSION = 1;

export type AgentId = "claude-code" | "cursor" | "codex";
export const AGENT_NAMES: Record<AgentId, string> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  codex: "Codex",
};
export const ALL_AGENTS: AgentId[] = ["claude-code", "cursor", "codex"];

/** How/when an item enters the context window. */
export type LoadMode = "always" | "conditional" | "deferred" | "on-demand" | "unknown";
export const LOAD_MODES: LoadMode[] = ["always", "conditional", "deferred", "on-demand", "unknown"];

/** documented = from vendor docs (per spec file); observed = confirmed on a real install; assumed = our model, unverified. */
export type Confidence = "documented" | "observed" | "assumed";

export type ItemKind =
  | "instructions"
  | "rule"
  | "memory"
  | "skills-listing"
  | "skill-body"
  | "subagents"
  | "rule-description"
  | "rule-body"
  | "mcp-server"
  | "user-rules";

export type Scope = "managed" | "user" | "project" | "local" | "ancestor" | "nested" | "plugin" | "builtin";

export interface TokenEst {
  est: number;
  low: number;
  high: number;
}

export interface Item {
  id: string;
  agent: AgentId;
  /** Absolute path in memory; rendered through displayPath() everywhere it is output. */
  path: string;
  kind: ItemKind;
  scope: Scope;
  loadMode: LoadMode;
  /** null = UNMEASURED (never rendered as 0). */
  tokens: TokenEst | null;
  unmeasuredReason?: string;
  chars: number;
  lines: number;
  confidence: Confidence;
  evidence: { docUrl: string; verifiedAt: string };
  notes: string[];
  /** Short, generic, privacy-safe label used in share cards. */
  cardLabel: string;
  /** Human label for the terminal (already sanitised). */
  label: string;
  /** Optional detail like "(+2 @imports)". */
  detail?: string;
  /** Biggest contributors inside an aggregated item (e.g. the heaviest skill descriptions in a skills listing). Estimates, same scaling as `tokens`. */
  breakdown?: Array<{ label: string; tokens: number }>;
  /** Cut-list parts of an aggregated skills listing: one per plugin (or the whole group when there is no plugin). Sums to this item's estimate. */
  parts?: Array<{ name: string; tokens: number; count: number }>;
  /** Set on MCP server items: the configured name and transport (never env/args/headers). */
  server?: { name: string; transport: string };
  /** Items sharing a group (+agent+loadMode) are aggregated into one terminal line. */
  group?: string;
  groupLabel?: string;
}

export interface Excluded {
  agent: AgentId | "all";
  path: string;
  reason: string;
}

export type Severity = "warn" | "info";
export interface Finding {
  id: string; // F1..F10 per plan catalogue
  severity: Severity;
  agent: AgentId | "all";
  message: string;
  paths: string[];
  savingsTokens?: number; // always-on tokens saved if the suggestion is followed (estimate)
  confidence: "high" | "medium" | "low" | "needs-your-call";
  fix?: string; // human-readable suggestion; never auto-applied
  /** Structured facts behind `message`, for renderers that must not reuse the message (it can name user-level paths). Numbers only. */
  data?: { lines?: number[]; fileLines?: number; guidelineLines?: number; similarityPct?: number; omittedPairs?: number };
}

export interface Totals {
  est: number;
  low: number;
  high: number;
  measuredItems: number;
  unmeasuredItems: number;
}

export interface Grade {
  letter: string;
  score: number;
  provisional: boolean;
  /** Set when the letter was limited because always-loaded items are unmeasured. */
  cappedAt?: string;
  reasons: string[];
}

/** What a scan could and could not see, per agent. Never contains file contents. */
export interface Coverage {
  agent: AgentId;
  alwaysMeasuredItems: number;
  alwaysUnmeasuredItems: number;
  /** measured / (measured + unmeasured) among always-on items; null when there are none. */
  alwaysFraction: number | null;
  /** Counts by kind, always-on measured items only, e.g. { "skills-listing": 3 }. */
  measuredKinds: Record<string, number>;
  unmeasuredKinds: Record<string, number>;
  mcpServers: number;
}

export interface Offender {
  agent: AgentId;
  label: string;
  path: string;
  kind: ItemKind;
  loadMode: LoadMode;
  tokens: number;
  note?: string;
}

/** One thing you could remove (a plugin's skills, a skills folder, an MCP server) and what it costs up front. Estimates. */
export interface CutCandidate {
  label: string;
  kind: "skills" | "mcp";
  tokens: number;
  /** skills in the group (1 for an MCP server) */
  count: number;
}

/** "What to cut": what removing the top groups would save. Always an estimate, never a promise. */
export interface Savings {
  n: number;
  top: CutCandidate[];
  topTokens: number;
  /** All removable groups together (skills/plugins/MCP servers with a measured size). */
  groupsTokens: number;
  groupsCount: number;
  pctOfAlways: number;
  pctOfGroups: number;
  pctOfWindow: number;
}

export interface AgentReport {
  id: AgentId;
  name: string;
  detected: boolean;
  detectedBy: string[];
  /** true = files exist in the repo but the agent isn't found on this machine -> collapsed, excluded from headline/card. */
  presentInRepoOnly: boolean;
  profile: { id: string; label: string; band: string };
  items: Item[];
  totals: Record<LoadMode, Totals>;
  percentOfWindowAlways: number | null;
  unmeasuredBanner: string[];
  grade: Grade | null;
  /** Totals are a lower bound: some always-on items are unmeasured, or the scan was cut short by its budget. */
  lowerBound: boolean;
  /** What removing the top plugin/skill/MCP groups would save; null when nothing meaningful can be said. */
  savings: Savings | null;
  /** Why there is no grade (e.g. nothing measured). */
  gradeNote?: string;
  coverage: Coverage;
  /** Heaviest always-on contributors (items, or entries inside aggregated listings), biggest first. */
  offenders: Offender[];
  /** Names of configured MCP servers (names only). Unmeasured servers are listed here even though they have no token count. */
  mcpServers: Array<{ name: string; source: string; scope: Scope; transport: string; measured: boolean }>;
}

export interface Report {
  schemaVersion: number;
  tool: { name: string; version: string };
  generatedAt: string;
  scan: {
    cwd: string;
    window: number;
    tokenizer: { method: "bpe-o200k" | "heuristic"; note: string };
    claudeProfile: "current" | "legacy";
  };
  agents: AgentReport[];
  excluded: Excluded[];
  findings: Finding[];
  warnings: string[];
  notMeasurable: string[];
  /** Set when a whole-scan budget (bytes or time) cut the scan short: every total is then a lower bound. */
  partial?: { reason: "bytes" | "time"; filesNotRead: number };
}
