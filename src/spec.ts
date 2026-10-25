import fs from "node:fs";
import path from "node:path";

export interface Spec {
  agent: string;
  verifiedAt: string;
  verifiedNote: string;
  docs: Record<string, string>;
  caps: Record<string, number>;
  minVersions?: Record<string, string>;
}

const SPEC_DIR = path.join(__dirname, "..", "spec");
const cache = new Map<string, Spec>();

export function loadSpec(agent: "claude-code" | "cursor" | "codex"): Spec {
  let s = cache.get(agent);
  if (!s) {
    s = JSON.parse(fs.readFileSync(path.join(SPEC_DIR, `${agent}.json`), "utf8")) as Spec;
    cache.set(agent, s);
  }
  return s;
}

export function loadBundledCatalogPath(): string {
  return path.join(SPEC_DIR, "mcp-weights.json");
}

export function evidenceFor(agent: "claude-code" | "cursor" | "codex", doc: string): { docUrl: string; verifiedAt: string } {
  const s = loadSpec(agent);
  return { docUrl: s.docs[doc] ?? Object.values(s.docs)[0], verifiedAt: s.verifiedAt };
}
