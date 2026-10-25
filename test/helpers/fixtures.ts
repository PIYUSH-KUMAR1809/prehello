import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { scan } from "../../src/scan";
import { Report } from "../../src/model";
import { toJson } from "../../src/render/json";
import { renderTerminal } from "../../src/render/terminal";
import { mkTmp, CAN_SYMLINK } from "./tmp";
import { winView } from "./winsep";

export const FIXTURE_SRC = path.join(__dirname, "..", "fixtures");
const created: string[] = [];
const SYMLINK_SUFFIX = ".__SYMLINK__";

export interface Mat {
  root: string;
  home: string;
  project: string;
}

/**
 * Put a project path into JSON text. The placeholder sits inside a JSON string, so the path must be JSON-escaped: a Windows path
 * (C:\\Users\\x) written raw makes the file invalid JSON (the first Windows CI run lost the "github" MCP server and got exit code 3 from it).
 */
export function substituteProject(jsonText: string, project: string): string {
  return jsonText.replaceAll("__PROJECT__", JSON.stringify(project).slice(1, -1));
}

/** Copy fixtures/<name> to a fresh temp dir, substituting machine-specific placeholders. */
export function materialize(name: string): Mat {
  const base = mkTmp("prehello-fx-");
  created.push(base);
  const root = path.join(base, name);
  fs.cpSync(path.join(FIXTURE_SRC, name), root, { recursive: true, verbatimSymlinks: true });
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const slug = project.replace(/[^A-Za-z0-9]/g, "-");
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && e.name === "__GIT__") {
        // Fixtures store .git as __GIT__ so packaging tools (tar --exclude=.git, npm, zip) cannot strip it.
        fs.renameSync(p, path.join(d, ".git"));
      } else if (e.isDirectory() && e.name === "__SLUG__") {
        fs.renameSync(p, path.join(d, slug));
        walk(path.join(d, slug));
      } else if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(SYMLINK_SUFFIX)) {
        // Symlinks are stored as "<name>.__SYMLINK__" text files holding the link target: a Windows checkout (core.symlinks=false) or an
        // archive tool cannot flatten them. Without symlink privilege the fixture simply has no link (tests that need it skip).
        const target = fs.readFileSync(p, "utf8").trim();
        fs.rmSync(p);
        if (CAN_SYMLINK) fs.symlinkSync(target, p.slice(0, -SYMLINK_SUFFIX.length));
      } else if (e.isFile() && e.name === ".claude.json") fs.writeFileSync(p, substituteProject(fs.readFileSync(p, "utf8"), project));
    }
  };
  walk(root);
  return { root, home, project };
}

export function cleanup(): void {
  for (const d of created.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}

export function runScan(m: Mat, extra: Partial<Parameters<typeof scan>[0]> = {}): Report {
  return winView(scan({
    cwd: m.project,
    home: m.home,
    env: { HOME: m.home, PATH: "" },
    platform: "linux",
    ceiling: m.root,
    managedDir: path.join(m.root, "managed"),
    systemRoot: path.join(m.root, "sysroot"),
    noBundledCatalog: true,
    window: 200_000,
    tokenizer: "auto",
    claudeProfile: "current",
    now: new Date("2026-10-24T12:00:00Z"),
    ...extra,
  }), m.root);
}

export function normalize(s: string, m: Mat): string {
  const slug = m.project.replace(/[^A-Za-z0-9]/g, "-");
  const tmp = path.dirname(m.root);
  // prehello prints forward slashes on every OS, so a Windows temp dir shows up as C:/Users/.../Temp: replace that spelling too
  return s.split(slug).join("<SLUG>").split(tmp).join("<TMP>").split(tmp.replace(/\\/g, "/")).join("<TMP>");
}

export function terminalOf(r: Report, m: Mat, verbose = false): string {
  return normalize(renderTerminal(r, { color: false, width: 100, verbose, quiet: false, home: m.home, cwd: m.project }), m);
}

export function jsonOf(r: Report, m: Mat, strict = false): string {
  return normalize(JSON.stringify(toJson(r, { cwd: m.project, home: m.home }, strict), null, 2), m);
}

export function treeHash(dir: string): string {
  const h = crypto.createHash("sha256");
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      const st = fs.lstatSync(p);
      h.update(p + "|" + st.mode + "|" + st.size + "|" + st.mtimeMs + "\n");
      if (e.isDirectory()) walk(p);
      else if (e.isSymbolicLink()) h.update(fs.readlinkSync(p));
      else h.update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex");
}

const GOLDEN = path.join(__dirname, "..", "golden");
export function golden(name: string, actual: string): { ok: boolean; message: string } {
  const f = path.join(GOLDEN, name);
  if (process.env.UPDATE_GOLDEN === "1") {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, actual);
    return { ok: true, message: "updated" };
  }
  if (!fs.existsSync(f)) return { ok: false, message: `missing golden ${name}; run with UPDATE_GOLDEN=1 and review the file` };
  // a Windows checkout with core.autocrlf turns goldens into CRLF: compare on LF (.gitattributes pins them to LF anyway)
  const expected = fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
  return { ok: expected === actual, message: expected === actual ? "ok" : `golden mismatch for ${name}` };
}
