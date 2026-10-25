import path from "node:path";
import { readTextSafe, isInside, realpathOrSelf, ReadResult } from "../fs-safe";
import { splitFences, stripHtmlComments } from "./comments";

export interface ImportResult {
  /** Parent text + all imported text (used only for token counting, never output). */
  text: string;
  imported: number;
  skipped: Array<{ spec: string; reason: string }>;
}

const MAX_DEPTH = 4;
/** Upper bound on @path candidates examined per file tree; a hostile file with 150,000 of them would otherwise cost seconds of stat calls. */
const MAX_CANDIDATES = 2000;

function candidates(prose: string): string[] {
  // Drop inline code spans first, then find @path tokens.
  const noCode = prose.replace(/`[^`\n]*`/g, " ");
  const out: string[] = [];
  const re = /(^|[\s(])@([^\s)]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noCode))) {
    let spec = m[2].replace(/[.,;:!?]+$/, "");
    if (!spec) continue;
    const looksLikePath = spec.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(spec);
    if (!looksLikePath || /^[\w.-]+@[\w.-]+$/.test(spec)) continue; // @mentions / emails
    out.push(spec);
  }
  return out;
}

/**
 * Expand Claude-style `@path` imports (depth ≤ 4, cycle-safe, code spans/fences skipped).
 * Imports do NOT reduce cost, so imported text is added to the total.
 * `allowed(realPath)` restricts which files may be read (project tree / home).
 */
export function expandImports(
  fileText: string,
  filePath: string,
  home: string,
  allowed: (realPath: string) => boolean,
  opts: { stripComments: boolean; read?: (target: string) => ReadResult },
): ImportResult {
  const seen = new Set<string>([realpathOrSelf(filePath)]);
  const skipped: ImportResult["skipped"] = [];
  let imported = 0;
  let tried = 0;
  const parts: string[] = [];

  const walk = (text: string, from: string, depth: number) => {
    const prose = splitFences(text)
      .filter((s) => !s.code)
      .map((s) => s.text)
      .join("\n");
    for (const spec of candidates(prose)) {
      if (++tried > MAX_CANDIDATES) {
        if (tried === MAX_CANDIDATES + 1) skipped.push({ spec: "(more)", reason: `more than ${MAX_CANDIDATES} @imports; the rest were not followed` });
        continue;
      }
      const target = spec.startsWith("~/") ? path.join(home, spec.slice(2)) : path.resolve(path.dirname(from), spec);
      const real = realpathOrSelf(target);
      if (seen.has(real)) continue;
      if (depth >= MAX_DEPTH) {
        skipped.push({ spec, reason: "depth>4" });
        continue;
      }
      if (!allowed(real)) {
        skipped.push({ spec, reason: "outside allowed roots" });
        continue;
      }
      const r = (opts.read ?? ((t: string) => readTextSafe(t)))(target);
      if (!r.ok) {
        if (r.reason !== "missing") skipped.push({ spec, reason: r.reason });
        continue;
      }
      seen.add(real);
      imported++;
      const t = opts.stripComments ? stripHtmlComments(r.text) : r.text;
      parts.push(t);
      walk(t, target, depth + 1);
    }
  };
  walk(fileText, filePath, 0);
  return { text: [fileText, ...parts].join("\n"), imported, skipped };
}

export { isInside };
