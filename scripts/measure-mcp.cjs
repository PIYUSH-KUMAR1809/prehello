#!/usr/bin/env node
/**
 * DEV-ONLY helper (not shipped in the CLI path, never imported by src/).
 * Starts ONE MCP server you name, asks it for tools/list over stdio, and prints a
 * catalog entry. It exists so spec/mcp-weights.json can hold MEASURED numbers, not guesses.
 *
 *   node scripts/measure-mcp.cjs --package @scope/pkg --version 1.2.3 -- node /path/bin.js [args]
 *
 * Run it in a sandbox (e.g. `unshare -rn`, scrubbed env). The prehello CLI itself never does this.
 * Token basis: o200k_base over JSON.stringify of each tool's {name, description, inputSchema}.
 * That is the raw tool-list payload, NOT the exact text an agent injects (formats differ).
 */
const { spawn } = require("node:child_process");
const { encode } = require("gpt-tokenizer/encoding/o200k_base");
const a = process.argv.slice(2);
const dd = a.indexOf("--");
const flag = (n) => { const i = a.indexOf(n); return i >= 0 && i < dd ? a[i + 1] : undefined; };
const pkg = flag("--package"), version = flag("--version");
if (dd < 0 || !pkg) { console.error("usage: measure-mcp.cjs --package P [--version V] -- cmd args"); process.exit(2); }
const [cmd, ...args] = a.slice(dd + 1);
const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "ignore"], env: { PATH: process.env.PATH, HOME: "/tmp/mcp-home" } });
let buf = "", id = 0; const pending = new Map();
child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue; try { const m = JSON.parse(l); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {} } });
const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
const call = (method, params) => new Promise((res, rej) => { const i = ++id; pending.set(i, res); send({ jsonrpc: "2.0", id: i, method, params }); setTimeout(() => rej(new Error("timeout " + method)), 20000); });
(async () => {
  try {
    await call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "prehello-measure", version: "0" } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    let tools = [], cursor;
    do { const r = await call("tools/list", cursor ? { cursor } : {}); tools = tools.concat(r.result.tools); cursor = r.result.nextCursor; } while (cursor);
    const slim = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    const nameTokens = slim.reduce((s, t) => s + encode(t.name).length, 0);
    const schemaTokens = slim.reduce((s, t) => s + encode(JSON.stringify({ description: t.description, inputSchema: t.inputSchema })).length, 0);
    console.log(JSON.stringify({ package: pkg, tools: slim.length, nameTokens, schemaTokens, measuredAt: new Date().toISOString().slice(0, 10), version: version ?? "unknown" }));
  } catch (e) { console.error("FAILED", pkg, String(e.message || e)); process.exitCode = 1; } finally { child.kill(); }
})();
