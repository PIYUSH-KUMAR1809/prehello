import { AgentId, AgentReport, Coverage, Item, Offender } from "../model";
import { cmp } from "../util/fmt";

/** What the scan measured vs. could not measure among always-on items. Counts only; no content. */
export function coverageOf(agent: AgentId, items: Item[]): Coverage {
  const always = items.filter((i) => i.loadMode === "always");
  const measuredKinds: Record<string, number> = {};
  const unmeasuredKinds: Record<string, number> = {};
  let m = 0;
  let u = 0;
  for (const it of always) {
    if (it.tokens) {
      m++;
      measuredKinds[it.kind] = (measuredKinds[it.kind] ?? 0) + 1;
    } else {
      u++;
      unmeasuredKinds[it.kind] = (unmeasuredKinds[it.kind] ?? 0) + 1;
    }
  }
  const servers = new Set(items.filter((i) => i.server).map((i) => `${i.server!.name}|${i.path}|${i.scope}`));
  return { agent, alwaysMeasuredItems: m, alwaysUnmeasuredItems: u, alwaysFraction: m + u ? m / (m + u) : null, measuredKinds, unmeasuredKinds, mcpServers: servers.size };
}

export function mcpServersOf(items: Item[]): AgentReport["mcpServers"] {
  const map = new Map<string, AgentReport["mcpServers"][number]>();
  for (const it of items) {
    if (!it.server) continue;
    const key = `${it.server.name}|${it.path}|${it.scope}`;
    const cur = map.get(key);
    const measured = it.tokens !== null;
    if (!cur) map.set(key, { name: it.server.name, source: it.path, scope: it.scope, transport: it.server.transport, measured });
    else cur.measured = cur.measured && measured;
  }
  return [...map.values()].sort((a, b) => cmp(a.name, b.name) || cmp(a.source, b.source));
}

/** Heaviest always-on contributors. Aggregated listings (skills) are expanded into their biggest entries. */
export function offendersOf(agent: AgentId, items: Item[], limit = 15): Offender[] {
  const out: Offender[] = [];
  for (const it of items) {
    if (it.loadMode !== "always" || !it.tokens) continue;
    if (it.breakdown && it.breakdown.length) {
      for (const b of it.breakdown) out.push({ agent, label: `skill "${b.label}"`, path: it.path, kind: it.kind, loadMode: it.loadMode, tokens: b.tokens, note: `inside ${it.label}` });
    } else {
      out.push({ agent, label: it.label, path: it.path, kind: it.kind, loadMode: it.loadMode, tokens: it.tokens.est });
    }
  }
  return out.sort((a, b) => b.tokens - a.tokens || cmp(a.label, b.label)).slice(0, limit);
}
