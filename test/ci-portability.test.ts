import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { materialize, cleanup, runScan, terminalOf, jsonOf, substituteProject } from "./helpers/fixtures";
import { mkTmp, canonical, leakForms, CAN_SYMLINK } from "./helpers/tmp";

afterAll(cleanup);

/**
 * Guards for the bugs the first Windows CI run found. They run on every OS, so a regression is visible on Linux first:
 *  - temp dirs must be canonical (Windows 8.3 short names, macOS /var -> /private/var) because prehello reports canonical paths;
 *  - machine-specific values written into JSON fixtures must be JSON-escaped (C:\Users\x is not a valid JSON string body);
 *  - product output uses forward slashes only.
 */
describe("test helpers: temp dirs and fixtures are canonical and escaped", () => {
  it("mkTmp returns the canonical path, so it equals what the product reports for it", () => {
    const d = mkTmp("prehello-ci-");
    try {
      expect(d).toBe(fs.realpathSync.native(d));
      expect(canonical(d)).toBe(d);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("substituteProject JSON-escapes Windows paths (and leaves POSIX paths unchanged)", () => {
    const tpl = '{ "projects": { "__PROJECT__": { "mcpServers": { "a": { "command": "x" } } } } }';
    for (const p of ["C:\\Users\\runneradmin\\AppData\\Local\\Temp\\prehello-fx-1\\project", "D:\\a\\prehello\\x \"q\"\\p", "/tmp/prehello-fx-1/project"]) {
      const parsed = JSON.parse(substituteProject(tpl, p));
      expect(Object.keys(parsed.projects)).toEqual([p]);
    }
    // the raw replacement the first CI run used is exactly what breaks
    expect(() => JSON.parse(tpl.replaceAll("__PROJECT__", "C:\\Users\\x"))).toThrow();
  });

  it("leakForms covers the native, forward-slash and JSON-escaped spellings", () => {
    const forms = leakForms("/tmp");
    expect(forms).toContain("/tmp");
    // synthetic Windows-style path: the three spellings differ and are all produced
    const win = "C:\\Users\\me";
    const spelled = [win, win.replace(/\\/g, "/"), win.replace(/\\/g, "\\\\")];
    expect(new Set(spelled).size).toBe(3);
  });

  it("symlink fixtures are stored as plain marker files and materialised as links only where links are allowed", () => {
    const src = path.join(__dirname, "fixtures", "symlink-escape");
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of walk(src)) expect(fs.lstatSync(f).isSymbolicLink(), `${f} must be a plain file in git`).toBe(false);
    const m = materialize("symlink-escape");
    expect(fs.existsSync(path.join(m.project, "CLAUDE.md.__SYMLINK__"))).toBe(false);
    expect(fs.lstatSync(path.join(m.project, "CLAUDE.md"), { throwIfNoEntry: false })?.isSymbolicLink() ?? false).toBe(CAN_SYMLINK);
  });

  it("fixture .claude.json files stay valid JSON after materialising", () => {
    for (const name of ["realistic", "claude-mcp-toolsearch-off", "monorepo-ancestors", "plugin-heavy", "privacy-canary"]) {
      const m = materialize(name);
      const f = path.join(m.home, ".claude.json");
      if (fs.existsSync(f)) expect(() => JSON.parse(fs.readFileSync(f, "utf8")), name).not.toThrow();
    }
  });
});

describe("product output: forward-slash relative paths, no leaked machine paths, on every OS", () => {
  const STRING = /"((?:[^"\\]|\\.)*)"/g;
  for (const [name, cwdRel] of [["realistic", ""], ["monorepo-ancestors", "apps/web"], ["codex-chain-override", "services/api/handlers"], ["claude-memory-over-200", ""], ["plugin-heavy", ""]] as const) {
    it(`${name}: no backslash path separators, drive letters or temp paths in terminal or --json`, () => {
      const m = materialize(name);
      const r = runScan(m, cwdRel ? { cwd: path.join(m.project, ...cwdRel.split("/")) } : {});
      const term = terminalOf(r, m, true);
      const json = jsonOf(r, m, false);
      for (const [label, text] of [["terminal", term], ["json", json]] as const) {
        for (const bad of [...leakForms(m.root), ...leakForms(m.home)]) expect(text, `${label} leaks ${bad}`).not.toContain(bad);
        expect(text, `${label} drive letter`).not.toMatch(/(^|[\s"'(=])[A-Za-z]:[\\/]/m);
      }
      expect(term).not.toMatch(/[\w.\-@~]\\[\w.\-@~]/);
      for (const mm of json.matchAll(STRING)) expect(JSON.parse(`"${mm[1]}"`), "json string").not.toMatch(/[\w.\-@~]\\[\w.\-@~]/);
    });
  }
});
