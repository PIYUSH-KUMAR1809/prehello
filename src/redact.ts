import path from "node:path";
import { sanitize } from "./util/fmt";
import { findSecretLines, scrubSecrets } from "./util/secrets";

export { findSecretLines, scrubSecrets };

export interface PathCtx {
  cwd: string;
  home: string;
  /** Path flavour of the machine the paths came from (default: this host). Tests pass path.win32 to prove Windows paths never leak. */
  pathMod?: path.PlatformPath;
}

/** True when `rel` (from path.relative) leaves its base: "..", "../x", but not a child called "..foo". */
function escapes(pm: path.PlatformPath, rel: string): boolean {
  return rel === ".." || rel.startsWith(".." + pm.sep) || pm.isAbsolute(rel);
}

/** Display form of a path: ./relative inside the project, ~/ inside HOME, else absolute. Always forward slashes. Sanitised + scrubbed. */
export function displayPath(p: string, c: PathCtx): string {
  const pm = c.pathMod ?? path;
  const slash = (x: string) => x.split(pm.sep).join("/");
  let out: string;
  const rel = pm.relative(c.cwd, p);
  if (rel === "") out = ".";
  else if (!escapes(pm, rel)) out = "./" + slash(rel);
  else {
    const hr = pm.relative(c.home, p);
    if (hr === "") out = "~";
    else if (!escapes(pm, hr)) out = "~/" + slash(hr);
    else if (rel.split(pm.sep).filter((x) => x === "..").length <= 4 && !pm.isAbsolute(rel)) out = slash(rel); // ../../CLAUDE.md (ancestor directory)
    else out = slash(p); // absolute elsewhere; on Windows "C:/Users/..." rather than backslashes (JSON/markdown-safe)
  }
  return scrubSecrets(sanitize(out, 200));
}
