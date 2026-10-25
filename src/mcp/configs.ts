import { parse as parseToml } from "smol-toml";
import { sanitize } from "../util/fmt";

export interface McpServerDef {
  name: string; // sanitised
  transport: "stdio" | "http" | "sse" | "unknown";
  /** npm-ish package guess from command args, only used for catalog matching; never output. */
  pkg?: string;
  disabled?: boolean;
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function guessPkg(entry: Record<string, unknown>): string | undefined {
  const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === "string") : [];
  const cmd = typeof entry.command === "string" ? entry.command : "";
  if (!/(^|\/)(npx|bunx|pnpx|uvx|pipx)$/.test(cmd) && !/^(npx|bunx|pnpx|uvx|pipx)$/.test(cmd)) return undefined;
  const a = args.find((x) => !x.startsWith("-"));
  return a ? a.replace(/@[\w.^~<>=*-]+$/, (m) => (a.startsWith("@") && a.indexOf("@", 1) === -1 ? m : "")) : undefined;
}

/** A real config has a handful of servers. A hostile one with 200,000 entries must not become a 180 MB report. */
export const MAX_MCP_SERVERS = 500;

/** Extract server definitions from a `{ mcpServers: {...} }`-style map. Values (env, headers, args) are never retained. */
export function parseMcpMap(map: unknown, warn?: (msg: string) => void): McpServerDef[] {
  if (!isObj(map)) return [];
  const out: McpServerDef[] = [];
  const names = Object.keys(map);
  if (names.length > MAX_MCP_SERVERS) warn?.(`an MCP config lists ${names.length} servers; only the first ${MAX_MCP_SERVERS} were read, so MCP counts are a lower bound`);
  for (const name of names.slice(0, MAX_MCP_SERVERS)) {
    const v = map[name];
    if (!isObj(v)) continue;
    const t = typeof v.type === "string" ? v.type : typeof v.transport === "string" ? v.transport : undefined;
    const transport: McpServerDef["transport"] =
      t === "http" || t === "streamable-http" ? "http" : t === "sse" ? "sse" : t === "stdio" || typeof v.command === "string" ? "stdio" : typeof v.url === "string" ? "http" : "unknown";
    out.push({ name: sanitize(name, 60), transport, pkg: guessPkg(v), disabled: v.disabled === true || v.enabled === false });
  }
  return out;
}

export function parseCodexToml(text: string, warn?: (msg: string) => void): { servers: McpServerDef[]; config: Record<string, unknown> } {
  const cfg = parseToml(text) as Record<string, unknown>;
  return { servers: parseMcpMap(cfg.mcp_servers, warn), config: cfg };
}
