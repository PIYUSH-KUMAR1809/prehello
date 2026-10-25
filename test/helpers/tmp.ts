import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The canonical temp directory. Windows: os.tmpdir() is often an 8.3 short path (C:\Users\RUNNER~1\...) and only the NATIVE realpath expands it. */
export const canonical = (p: string): string => fs.realpathSync.native(p);

/** A fresh temp directory whose path is the canonical one (what prehello reports), never an alias (8.3 short name, macOS /var -> /private/var). */
export function mkTmp(prefix: string): string {
  return canonical(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Every spelling of a path that must never show up in shareable output: native, forward-slash, JSON-escaped, and the uncanonicalised alias. */
export function leakForms(p: string): string[] {
  const forms = new Set<string>();
  for (const x of [p, canonical(p)]) {
    forms.add(x);
    forms.add(x.replace(/\\/g, "/"));
    forms.add(x.replace(/\\/g, "\\\\"));
  }
  return [...forms];
}

/**
 * Can this process create symlinks? Always on Linux/macOS. Windows needs Developer Mode or an elevated shell (GitHub's runners are elevated);
 * on a developer laptop without it the symlink tests skip instead of failing at fixture creation.
 */
export const CAN_SYMLINK: boolean = (() => {
  const d = mkTmp("prehello-symprobe-");
  try {
    fs.writeFileSync(path.join(d, "t"), "x");
    fs.symlinkSync("t", path.join(d, "l"));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
})();
