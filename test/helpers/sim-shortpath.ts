/**
 * Test-only simulation of the Windows "8.3 short name" trap, runnable on Linux and macOS.
 *
 * On a GitHub Windows runner os.tmpdir() is C:\Users\RUNNER~1\AppData\Local\Temp while the canonical path is
 * C:\Users\runneradmin\AppData\Local\Temp. fs.realpathSync (the JS implementation) leaves the short name alone, fs.realpathSync.native
 * expands it, and prehello canonicalises with the native one. A test helper that builds its fixture root with the JS realpath therefore
 * disagrees with the paths prehello reports (that was the cause of most of the first Windows CI failures).
 *
 * Enabled with PREHELLO_SIM_SHORTPATH=1 (vitest setup file, see vitest.config.mts): os.tmpdir() returns a symlink alias of the real temp
 * directory, and the JS realpathSync stops resolving symlinks under it, exactly like Windows does for short names.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (process.env.PREHELLO_SIM_SHORTPATH === "1") {
  const real = fs.realpathSync.native(os.tmpdir());
  const alias = path.join(real, `RUNNER~1-${process.pid}`);
  const target = path.join(real, `runneradmin-${process.pid}`);
  fs.mkdirSync(target, { recursive: true });
  try {
    fs.symlinkSync(target, alias, "dir");
  } catch {
    /* already there */
  }
  os.tmpdir = () => alias;
  const jsReal = fs.realpathSync;
  const patched = function (p: fs.PathLike, o?: fs.EncodingOption): string {
    const s = typeof p === "string" ? p : p.toString();
    if (s === alias || s.startsWith(alias + path.sep)) return path.resolve(s); // the short name survives, like on Windows
    return jsReal(p, o as never) as string;
  } as typeof fs.realpathSync;
  patched.native = jsReal.native;
  fs.realpathSync = patched;
  process.on("exit", () => {
    try {
      fs.rmSync(alias, { force: true });
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
}
