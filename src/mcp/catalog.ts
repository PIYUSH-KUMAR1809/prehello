import fs from "node:fs";
import { decodeUserText } from "../platform";
import { McpServerDef } from "./configs";
import { loadBundledCatalogPath } from "../spec";

export interface CatalogEntry {
  name?: string;
  package?: string;
  tools: number;
  nameTokens: number; // raw o200k tokens for tool names list
  schemaTokens: number; // raw o200k tokens for full schemas
  measuredAt: string;
  version?: string;
}

function valid(e: unknown): e is CatalogEntry {
  if (typeof e !== "object" || e === null) return false;
  const x = e as Record<string, unknown>;
  return (
    (typeof x.name === "string" || typeof x.package === "string") &&
    Number.isFinite(x.nameTokens) && (x.nameTokens as number) >= 0 &&
    Number.isFinite(x.schemaTokens) && (x.schemaTokens as number) >= 0 &&
    Number.isFinite(x.tools) &&
    typeof x.measuredAt === "string"
  );
}

export function loadCatalog(extraPath?: string, noBundled = false): { entries: CatalogEntry[]; warnings: string[] } {
  const entries: CatalogEntry[] = [];
  const warnings: string[] = [];
  // user-supplied file first: lookup() returns the first match, so a user's own measurement beats the bundled one
  for (const p of [extraPath, noBundled ? undefined : loadBundledCatalogPath()].filter((x): x is string => !!x)) {
    try {
      const j = JSON.parse(decodeUserText(fs.readFileSync(p))) as { servers?: unknown[] };
      for (const e of j.servers ?? []) {
        if (valid(e)) entries.push(e);
        else warnings.push("an MCP catalog entry was malformed and ignored");
      }
    } catch {
      if (p === extraPath) warnings.push("MCP catalog file could not be read or parsed; ignored");
    }
  }
  return { entries, warnings };
}

export function lookup(entries: CatalogEntry[], def: McpServerDef): CatalogEntry | undefined {
  return entries.find((e) => (e.name && e.name === def.name) || (e.package && def.pkg && e.package === def.pkg));
}
