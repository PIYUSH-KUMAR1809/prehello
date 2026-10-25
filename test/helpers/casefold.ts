import fs from "node:fs";
import path from "node:path";

/**
 * Simulates a case-insensitive, case-preserving filesystem (macOS APFS default, Windows NTFS) on top of a
 * case-sensitive one by canonicalising the case of every path component before the call reaches the real fs.
 * Directory listings still return the true on-disk names, exactly like the real thing.
 * Test-only; installs and removes patches on the shared `fs` module object.
 */
const realReaddir = fs.readdirSync.bind(fs);
const realLstat = fs.lstatSync.bind(fs);

export function foldPath(p: string): string {
  if (!path.isAbsolute(p)) return p;
  // start from the real root ("/" or "C:\\"): seeding with a bare separator doubles the drive on Windows ("D:\\D:\\a\\...")
  const norm = path.normalize(p);
  const root = path.parse(norm).root;
  const parts = norm.slice(root.length).split(path.sep).filter(Boolean);
  let cur: string = root;
  for (const part of parts) {
    let actual = part;
    try {
      const names = realReaddir(cur) as string[];
      if (!names.includes(part)) {
        const hit = names.find((n) => n.toLowerCase() === part.toLowerCase());
        if (hit) actual = hit;
      }
    } catch {
      /* not a directory / unreadable: keep as is */
    }
    cur = path.join(cur, actual);
  }
  return cur;
}

type AnyFn = (...a: unknown[]) => unknown;
const PATCH = ["statSync", "lstatSync", "readFileSync", "openSync", "existsSync", "readlinkSync", "accessSync"] as const;

export function installCaseInsensitiveFs(): () => void {
  const f = fs as unknown as Record<string, AnyFn & { native?: AnyFn }>;
  const saved: Record<string, AnyFn> = {};
  const fix = (a: unknown[]) => (typeof a[0] === "string" ? [foldPath(a[0] as string), ...a.slice(1)] : a);
  for (const n of PATCH) {
    const orig = f[n];
    saved[n] = orig;
    f[n] = function (...a: unknown[]) {
      return orig.apply(fs, fix(a));
    } as AnyFn;
  }
  const origReal = f.realpathSync;
  const origNative = origReal.native;
  saved.realpathSync = origReal;
  const patched = function (...a: unknown[]) {
    return origReal.apply(fs, fix(a));
  } as AnyFn & { native?: AnyFn };
  patched.native = function (...a: unknown[]) {
    return (origNative as AnyFn).apply(fs, fix(a));
  } as AnyFn;
  f.realpathSync = patched;
  return () => {
    for (const n of PATCH) f[n] = saved[n];
    f.realpathSync = saved.realpathSync;
  };
}

/** Upper-case a path (what a user typing it in the wrong case, or a case-insensitive shell, can produce). */
export const shout = (p: string) => p.toUpperCase();
void realLstat;
