import { spawnSync, SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { mkTmp } from "./tmp";

export const ROOT = path.resolve(__dirname, "..", "..");
export const CLI = path.join(ROOT, "dist", "cli.js");
export const GUARD = path.join(__dirname, "guard.cjs");

export interface RunOpts {
  home: string;
  cwd?: string;
  guard?: boolean;
  allowWrite?: string[];
  env?: Record<string, string>;
  prefix?: string[]; // e.g. ["unshare","-rn"]
}

export function runCli(args: string[], o: RunOpts): SpawnSyncReturns<string> & { guardLog: string } {
  const log = path.join(mkTmp("prehello-guardlog-"), "log");
  fs.writeFileSync(log, "");
  // Hermetic by construction: machine-wide locations (/Applications, /etc, /Library/...) are re-rooted under a
  // directory that does not exist, so a developer's real Cursor.app / managed Claude settings can never leak into a test.
  const hermetic = args.includes("--system-root") || args.some((a) => a.startsWith("--system-root=")) ? [] : ["--system-root", path.join(o.home, "__no_system_root__")];
  const nodeArgs = [...(o.guard === false ? [] : ["-r", GUARD]), CLI, ...args, ...hermetic];
  const [cmd, ...pre] = o.prefix ? [...o.prefix, process.execPath] : [process.execPath];
  const res = spawnSync(cmd, [...pre, ...nodeArgs], {
    cwd: o.cwd ?? ROOT,
    encoding: "utf8",
    env: {
      HOME: o.home,
      USERPROFILE: o.home, // Windows takes the home folder from here
      // a Windows node.exe needs SystemRoot to start; harmless elsewhere
      ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } : {}),
      PATH: "",
      NO_COLOR: "1",
      PREHELLO_GUARD_LOG: log,
      PREHELLO_ALLOW_WRITE: (o.allowWrite ?? []).join(path.delimiter),
      SOURCE_DATE_EPOCH: "1792843200",
      ...(o.env ?? {}),
    },
    timeout: 60_000,
  });
  const guardLog = fs.readFileSync(log, "utf8");
  fs.rmSync(path.dirname(log), { recursive: true, force: true });
  return Object.assign(res, { guardLog });
}
