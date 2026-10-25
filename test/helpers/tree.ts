import fs from "node:fs";
import path from "node:path";
import { scan } from "../../src/scan";
import { Report, AgentReport } from "../../src/model";
import { mkTmp } from "./tmp";

/** A hermetic temp world: <root>/home, <root>/project (with a .git marker), <root>/sysroot (never created). */
export interface World {
  root: string;
  home: string;
  project: string;
  sysroot: string;
}
const worlds: string[] = [];

export function world(opts: { git?: boolean } = {}): World {
  const root = mkTmp("prehello-w-");
  worlds.push(root);
  const w = { root, home: path.join(root, "home"), project: path.join(root, "project"), sysroot: path.join(root, "sysroot") };
  fs.mkdirSync(w.home, { recursive: true });
  fs.mkdirSync(w.project, { recursive: true });
  if (opts.git !== false) {
    fs.mkdirSync(path.join(w.project, ".git"));
    fs.writeFileSync(path.join(w.project, ".git", "HEAD"), "ref: refs/heads/main\n");
  }
  return w;
}
export function cleanupWorlds(): void {
  for (const d of worlds.splice(0)) {
    try {
      if (process.platform !== "win32") chmodTree(d); // chmod does nothing useful on Windows, and walking thousands of files there is slow
    } catch {
      /* ignore */
    }
    fs.rmSync(d, { recursive: true, force: true });
  }
}
function chmodTree(d: string): void {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isSymbolicLink()) continue;
    try {
      fs.chmodSync(p, e.isDirectory() ? 0o755 : 0o644);
    } catch {
      /* ignore */
    }
    if (e.isDirectory()) chmodTree(p);
  }
}

/** Write files relative to a base dir. Value string = file content; {link: target} = symlink. */
export function put(base: string, files: Record<string, string | { link: string }>): void {
  for (const [rel, v] of Object.entries(files)) {
    const abs = path.join(base, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (typeof v === "string") fs.writeFileSync(abs, v);
    else fs.symlinkSync(v.link, abs);
  }
}

export function skillMd(name: string, description: string, body = "Do the thing.\n", extraFm = ""): string {
  return `---\nname: ${name}\ndescription: ${description}\n${extraFm}---\n${body}`;
}

export function scanWorld(w: World, extra: Partial<Parameters<typeof scan>[0]> = {}): Report {
  return scan({
    cwd: w.project,
    home: w.home,
    env: { HOME: w.home, PATH: "" },
    platform: "linux",
    ceiling: w.root,
    managedDir: path.join(w.root, "managed"),
    systemRoot: w.sysroot,
    noBundledCatalog: true,
    window: 200_000,
    tokenizer: "auto",
    claudeProfile: "current",
    now: new Date("2026-10-25T12:00:00Z"),
    ...extra,
  });
}

export function agentOf(r: Report, id: string): AgentReport {
  const a = r.agents.find((x) => x.id === id);
  if (!a) throw new Error(`agent ${id} not in report (have: ${r.agents.map((x) => x.id).join(",")})`);
  return a;
}
