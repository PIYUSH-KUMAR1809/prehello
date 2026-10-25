/**
 * Windows behaviour proven on any host: pure helpers take `path.win32` / a platform argument, and the scan is driven with
 * platform "win32" over a real temp tree. This is SIMULATION: the real Windows run is the CI matrix (.github/workflows/ci.yml).
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { world, cleanupWorlds, put, scanWorld, agentOf } from "./helpers/tree";
import { decodeUserText, hasWindowsStream, isInsideWith, isWinAbsolute, isWindowsReservedName, makeGlobMatcher, resolveHomeDir, toAscii, toPosix, unicodeSupported } from "../src/platform";
import { displayPath } from "../src/redact";
import { safeWrite, SafeWriteError, looksLikePrehelloOutput, MD_MARKER_PREFIX } from "../src/safe-write";
import { loadCatalog } from "../src/mcp/catalog";
import { renderMarkdown } from "../src/render/markdown";
import { renderTerminal } from "../src/render/terminal";
import { detectInstallKind, pngUnavailableMessage } from "../src/render/png";

afterAll(cleanupWorlds);
const W = path.win32;

describe("home directory", () => {
  const home = () => "/os/home";
  it("Windows: USERPROFILE wins over HOME (Git Bash sets HOME=/c/Users/me, which Node cannot open)", () => {
    expect(resolveHomeDir({ USERPROFILE: "C:\\Users\\me", HOME: "/c/Users/me" }, "win32", home)).toBe("C:\\Users\\me");
  });
  it("Windows: falls back to HOMEDRIVE+HOMEPATH, then an absolute HOME, then the OS answer; a relative or POSIX-style HOME is ignored", () => {
    expect(resolveHomeDir({ HOMEDRIVE: "D:", HOMEPATH: "\\Users\\me" }, "win32", home)).toBe("D:\\Users\\me");
    expect(resolveHomeDir({ HOME: "E:\\h" }, "win32", home)).toBe("E:\\h");
    expect(resolveHomeDir({ HOME: "/c/Users/me" }, "win32", home)).toBe("/os/home");
    expect(resolveHomeDir({ USERPROFILE: "relative" }, "win32", home)).toBe("/os/home");
  });
  it("macOS / Linux: HOME when absolute, else the OS answer", () => {
    expect(resolveHomeDir({ HOME: "/Users/me", USERPROFILE: "C:\\x" }, "darwin", home)).toBe("/Users/me");
    expect(resolveHomeDir({ HOME: "rel" }, "linux", home)).toBe("/os/home");
    expect(resolveHomeDir({}, "linux", home)).toBe("/os/home");
  });
});

describe("path predicates", () => {
  it("isWinAbsolute: drive, UNC and extended paths; not relative, not rooted-without-drive", () => {
    for (const p of ["C:\\x", "c:/x", "\\\\server\\share\\x", "//server/share", "\\\\?\\C:\\x"]) expect(isWinAbsolute(p), p).toBe(true);
    for (const p of ["x\\y", "\\x", "C:x", "/x", ""]) expect(isWinAbsolute(p), p).toBe(false);
  });
  it("isInsideWith(win32): case-insensitive drive, sibling prefix, other drive, UNC", () => {
    expect(isInsideWith(W, "C:\\repo\\sub\\f", "C:\\repo")).toBe(true);
    expect(isInsideWith(W, "c:\\REPO\\sub", "C:\\repo")).toBe(true);
    expect(isInsideWith(W, "C:\\repo2\\f", "C:\\repo")).toBe(false);
    expect(isInsideWith(W, "D:\\repo\\f", "C:\\repo")).toBe(false);
    expect(isInsideWith(W, "C:\\repo\\..foo\\f", "C:\\repo")).toBe(true); // a folder called "..foo" is inside
    expect(isInsideWith(W, "C:\\repo\\..\\x", "C:\\repo")).toBe(false);
    expect(isInsideWith(W, "\\\\srv\\share\\a\\b", "\\\\srv\\share\\a")).toBe(true);
    expect(isInsideWith(W, "\\\\srv\\other\\a", "\\\\srv\\share\\a")).toBe(false);
  });
  it("reserved device names are caught with any extension, case, trailing dots/spaces and folder", () => {
    for (const n of ["nul", "NUL.md", "C:\\out\\con.svg", "aux.json", "COM1.md", "lpt9.txt", "prn .md", "Nul..md", "COM\u00b9.md"]) expect(isWindowsReservedName(n), n).toBe(true);
    for (const n of ["console.md", "report.md", "com10.md", "nulls.md", "C:\\nul\\report.md"]) expect(isWindowsReservedName(n), n).toBe(false);
  });
  it("NTFS alternate data streams: a ':' after the drive letter is refused", () => {
    expect(hasWindowsStream("C:\\out\\report.md:hidden")).toBe(true);
    expect(hasWindowsStream("report.md:hidden")).toBe(true);
    expect(hasWindowsStream("C:\\out\\report.md")).toBe(false);
    expect(hasWindowsStream("\\\\?\\C:\\out\\report.md")).toBe(false);
  });
});

describe("paths never leak, whatever the separator", () => {
  const ctx = { cwd: "C:\\Users\\me\\proj", home: "C:\\Users\\me", pathMod: W };
  it("project-relative and home-relative use forward slashes", () => {
    expect(displayPath("C:\\Users\\me\\proj\\.cursor\\rules\\a.mdc", ctx)).toBe("./.cursor/rules/a.mdc");
    expect(displayPath("C:\\Users\\me\\.claude\\CLAUDE.md", ctx)).toBe("~/.claude/CLAUDE.md");
    expect(displayPath("c:\\users\\ME\\.claude\\CLAUDE.md", ctx)).toBe("~/.claude/CLAUDE.md");
    expect(displayPath("C:\\Users\\me\\proj", ctx)).toBe(".");
  });
  it("ancestors, other drives and UNC paths have no backslashes", () => {
    expect(displayPath("C:\\Users\\me\\CLAUDE.md", { ...ctx, home: "C:\\other" })).toBe("../CLAUDE.md");
    expect(displayPath("D:\\work\\x\\CLAUDE.md", ctx)).toBe("D:/work/x/CLAUDE.md");
    expect(displayPath("\\\\srv\\share\\CLAUDE.md", ctx)).not.toContain("\\");
    expect(displayPath("C:\\Users\\me\\proj\\..foo\\a.md", ctx)).toBe("./..foo/a.md");
  });
  it("toPosix", () => expect(toPosix("a\\b\\c")).toBe("a/b/c"));
});

describe("globs (claudeMdExcludes) on Windows", () => {
  it("backslash patterns and paths match, case-insensitively; POSIX behaviour is unchanged", () => {
    const win = makeGlobMatcher(["**\\legacy\\**", "C:\\Work\\Old\\*.md"], "win32");
    expect(win("C:\\proj\\Legacy\\CLAUDE.md")).toBe(true);
    expect(win("c:\\work\\old\\CLAUDE.md")).toBe(true);
    expect(win("C:\\proj\\new\\CLAUDE.md")).toBe(false);
    const lin = makeGlobMatcher(["**/legacy/**"], "linux");
    expect(lin("/p/legacy/CLAUDE.md")).toBe(true);
    expect(lin("/p/Legacy/CLAUDE.md")).toBe(false);
    expect(lin("/p/new/CLAUDE.md")).toBe(false);
  });
});

describe("safe-write file-name rules for win32", () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "prehello-win-"));
  it("refuses device names and streams before touching the disk", () => {
    const d = dir();
    for (const name of ["nul.md", "CON.svg", "report.md:stream"]) {
      expect(() => safeWrite(path.join(d, name), "x", { kind: "md", force: false, platform: "win32" })).toThrow(SafeWriteError);
      expect(fs.readdirSync(d)).toEqual([]);
    }
    fs.rmSync(d, { recursive: true, force: true });
  });
  it("the same names are ordinary file names on POSIX (not refused there)", () => {
    const d = dir();
    safeWrite(path.join(d, "nul.md"), `${MD_MARKER_PREFIX}0 -->\nx`, { kind: "md", force: false, platform: "linux" });
    expect(fs.readdirSync(d)).toEqual(["nul.md"]);
    fs.rmSync(d, { recursive: true, force: true });
  });
  it("our own output is still recognised after a Windows editor adds a BOM and CRLF", () => {
    const body = `${MD_MARKER_PREFIX}0.1.0 -->\r\n## prehello report\r\n`;
    expect(looksLikePrehelloOutput("\ufeff" + body, "md")).toBe(true);
    expect(looksLikePrehelloOutput(Buffer.from("\ufeff" + body, "utf8").toString("latin1"), "md")).toBe(true);
    expect(looksLikePrehelloOutput('\ufeff{\r\n  "tool": { "name": "prehello", "version": "1" } }', "json")).toBe(true);
    expect(looksLikePrehelloOutput("# my notes", "md")).toBe(false);
  });
  it("a read-only existing file gives a friendly message, not a stack trace", () => {
    const d = dir();
    const f = path.join(d, "r.md");
    safeWrite(f, `${MD_MARKER_PREFIX}0 -->\nold`, { kind: "md", force: false });
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      fs.chmodSync(f, 0o444);
      expect(() => safeWrite(f, `${MD_MARKER_PREFIX}0 -->\nnew`, { kind: "md", force: false })).toThrow(/permission denied|read-only/);
      expect(fs.readFileSync(f, "utf8")).toContain("old");
    }
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe("user-supplied text files: BOM, UTF-16, CRLF", () => {
  it("decodeUserText handles UTF-8 BOM, UTF-16 LE/BE and plain", () => {
    const txt = "{\"servers\": []}\r\n";
    expect(decodeUserText(Buffer.from("\ufeff" + txt, "utf8"))).toBe(txt);
    expect(decodeUserText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(txt, "utf16le")]))).toBe(txt);
    expect(decodeUserText(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(txt, "utf16le").swap16()]))).toBe(txt);
    expect(decodeUserText(Buffer.from(txt))).toBe(txt);
  });
  it("--mcp-catalog files saved by Windows PowerShell 5 / Notepad (BOM, UTF-16) load", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "prehello-cat-"));
    const json = JSON.stringify({ servers: [{ name: "x", tools: 3, nameTokens: 10, schemaTokens: 100, measuredAt: "2026-01-01" }] }, null, 2).replace(/\n/g, "\r\n");
    const files: Record<string, Buffer> = {
      "bom.json": Buffer.from("\ufeff" + json),
      "utf16.json": Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, "utf16le")]),
      "plain.json": Buffer.from(json),
    };
    for (const [n, b] of Object.entries(files)) {
      fs.writeFileSync(path.join(d, n), b);
      const c = loadCatalog(path.join(d, n), true);
      expect(c.warnings, n).toEqual([]);
      expect(c.entries.length, n).toBe(1);
    }
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe("CRLF and BOM context files count like their LF twins", () => {
  const tokens = (w: ReturnType<typeof world>) => agentOf(scanWorld(w), "claude-code").totals.always.est;
  it("CLAUDE.md with CRLF + BOM = the same estimate as LF (within 2%), and the BOM is not counted", () => {
    const text = "# Project\n\nUse tabs.\nRun the tests before you commit.\n".repeat(40);
    const a = world();
    put(a.project, { "CLAUDE.md": text });
    put(a.home, { ".claude/CLAUDE.md": "x" });
    const b = world();
    put(b.project, { "CLAUDE.md": "\ufeff" + text.replace(/\n/g, "\r\n") });
    put(b.home, { ".claude/CLAUDE.md": "x" });
    const ta = tokens(a);
    const tb = tokens(b);
    expect(ta).toBeGreaterThan(100);
    expect(Math.abs(ta - tb) / ta).toBeLessThan(0.02);
  });
  it("Cursor .mdc frontmatter written with CRLF (+BOM) is still parsed: alwaysApply works", () => {
    const rule = "---\r\ndescription: x\r\nalwaysApply: true\r\n---\r\nAlways answer in French. ".repeat(1) + "Lorem ipsum dolor sit amet. ".repeat(30) + "\r\n";
    const w = world();
    put(w.project, { ".cursor/rules/a.mdc": "\ufeff" + rule });
    put(w.home, { ".cursor/.keep": "" });
    const a = agentOf(scanWorld(w, { agents: ["cursor"] }), "cursor");
    expect(a.totals.always.measuredItems).toBeGreaterThan(0);
    expect(a.items.some((i) => i.kind === "rule" && i.loadMode === "always")).toBe(true);
  });
  it("a UTF-16 CLAUDE.md (PowerShell 5 '>') is reported with a re-save-as-UTF-8 message instead of 'binary'", () => {
    const w = world();
    fs.writeFileSync(path.join(w.project, "CLAUDE.md"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("# Hello\r\nUse tabs\r\n", "utf16le")]));
    put(w.home, { ".claude/.keep": "" });
    const r = scanWorld(w, { agents: ["claude-code"] });
    const text = JSON.stringify(r.findings) + JSON.stringify(r.excluded) + JSON.stringify(r.warnings);
    expect(text).toMatch(/UTF-16/);
    expect(text).not.toMatch(/binary/i);
  });
});

describe("Windows layout of machine-wide files (platform win32 over a re-rooted system root)", () => {
  it("the managed CLAUDE.md is found under %ProgramFiles%\\ClaudeCode, wherever ProgramFiles points", () => {
    const w = world();
    put(w.sysroot, { "PF/ClaudeCode/CLAUDE.md": "Managed policy text. ".repeat(50) });
    put(w.home, { ".claude/.keep": "" });
    const r = scanWorld(w, { platform: "win32", managedDir: undefined, env: { USERPROFILE: w.home, ProgramFiles: "D:\\PF", PATH: "" }, agents: ["claude-code"] });
    expect(agentOf(r, "claude-code").items.some((i) => i.scope === "managed")).toBe(true);
    const r2 = scanWorld(w, { platform: "win32", managedDir: undefined, env: { USERPROFILE: w.home, PATH: "" }, agents: ["claude-code"] });
    expect(agentOf(r2, "claude-code").items.some((i) => i.scope === "managed")).toBe(false); // default C:\Program Files\ClaudeCode does not exist there
  });
  it("Cursor installed per-user (%LOCALAPPDATA%\\Programs\\cursor\\Cursor.exe) is detected without ~/.cursor or PATH", () => {
    const w = world();
    const local = path.join(w.root, "Local");
    put(local, { "Programs/cursor/Cursor.exe": "MZ" });
    const r = scanWorld(w, { platform: "win32", env: { USERPROFILE: w.home, LOCALAPPDATA: local, PATH: "" } });
    expect(agentOf(r, "cursor").detectedBy).toContain("Cursor.exe");
    // and not detected when it is not installed
    const w2 = world();
    expect(r.agents.length).toBeGreaterThan(0);
    expect(scanWorld(w2, { platform: "win32", env: { USERPROFILE: w2.home, PATH: "" } }).agents.some((a) => a.id === "cursor" && !a.presentInRepoOnly)).toBe(false);
  });
});

describe("console glyphs, colour and ASCII fallback", () => {
  it("legacy Windows console (cmd.exe / classic PowerShell) is not unicode-capable; Windows Terminal and VS Code are", () => {
    expect(unicodeSupported({}, "win32")).toBe(false);
    expect(unicodeSupported({ WT_SESSION: "1" }, "win32")).toBe(true);
    expect(unicodeSupported({ TERM_PROGRAM: "vscode" }, "win32")).toBe(true);
    expect(unicodeSupported({}, "darwin")).toBe(true);
    expect(unicodeSupported({ TERM: "linux" }, "linux")).toBe(false);
    expect(unicodeSupported({ PREHELLO_ASCII: "1" }, "darwin")).toBe(false);
  });
  it("toAscii leaves nothing outside 0x7f and keeps the report readable", () => {
    const w = world();
    put(w.project, { "CLAUDE.md": "# hi\n".repeat(50) });
    put(w.home, { ".claude/.keep": "" });
    const r = scanWorld(w, { agents: ["claude-code"] });
    const t = toAscii(renderTerminal(r, { color: false, width: 100, verbose: true, quiet: false, home: w.home, cwd: w.project }));
    expect(t).toMatch(/^[\x00-\x7f]*$/);
    expect(t).toMatch(/ALWAYS ON/);
    expect(toAscii("a · b → c ≥ d …")).toBe("a - b -> c >= d ...");
  });
  it("the markdown report is ASCII-only already (survives cmd.exe code pages and PowerShell redirection)", () => {
    const w = world();
    put(w.project, { "CLAUDE.md": "# hi\n".repeat(50) });
    put(w.home, { ".claude/.keep": "" });
    const r = scanWorld(w, { agents: ["claude-code"] });
    expect(renderMarkdown(r, { anonymize: false, compact: false, headline: "cut" })).toMatch(/^[\x20-\x7e\n]*$/);
  });
});

describe("PNG engine missing: install-kind detection and wording (all platforms' layouts)", () => {
  const hasPkg = (set: string[]) => (d: string) => set.includes(d);
  it("detects local, global, npx and source layouts, including Windows and Homebrew/nvm prefixes", () => {
    expect(detectInstallKind("/home/me/proj/node_modules/prehello/dist/render", hasPkg(["/home/me/proj"]))).toBe("local");
    expect(detectInstallKind("C:\\Users\\me\\proj\\node_modules\\prehello\\dist\\render", hasPkg(["C:\\Users\\me\\proj"]))).toBe("local");
    expect(detectInstallKind("/usr/local/lib/node_modules/prehello/dist/render", hasPkg([]))).toBe("global");
    expect(detectInstallKind("/opt/homebrew/lib/node_modules/prehello/dist/render", hasPkg([]))).toBe("global");
    expect(detectInstallKind("/home/me/.nvm/versions/node/v20.1.0/lib/node_modules/prehello/dist/render", hasPkg([]))).toBe("global");
    expect(detectInstallKind("C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\prehello\\dist\\render", hasPkg([]))).toBe("global");
    expect(detectInstallKind("/home/me/.npm/_npx/abc123/node_modules/prehello/dist/render", hasPkg(["/home/me/.npm/_npx/abc123"]))).toBe("npx");
    expect(detectInstallKind("C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\abc123\\node_modules\\prehello\\dist\\render", hasPkg([]))).toBe("npx");
    expect(detectInstallKind("/work/prehello/dist/render", hasPkg([]))).toBe("source");
  });
  it("every variant lists global, local and npx options plus the SVG escape hatch; the right one is marked", () => {
    for (const kind of ["global", "local", "npx", "source", "unknown"] as const) {
      const m = pngUnavailableMessage(kind);
      expect(m, kind).toContain("npm install -g @resvg/resvg-wasm");
      expect(m, kind).toContain("npm install @resvg/resvg-wasm");
      expect(m, kind).toContain("npx --package prehello --package @resvg/resvg-wasm -- prehello --card=card.png");
      expect(m, kind).toContain("--card=card.svg");
      expect(m, kind).toContain("--omit=optional");
      expect(m.match(/<- how this prehello/g)?.length ?? 0, kind).toBe(kind === "unknown" ? 0 : 1);
      expect(m, kind).toMatch(/^[\x20-\x7e\n]*$/); // ASCII: readable in any console code page
    }
    expect(pngUnavailableMessage("global")).toMatch(/npm install -g @resvg\/resvg-wasm\s+<- how this prehello was installed/);
    expect(pngUnavailableMessage("npx")).toMatch(/--card=card\.png\s+<- how this prehello was installed/);
  });
});

describe("package shape that Windows builds must not break", () => {
  it("dist/cli.js keeps an LF shebang (a CRLF shebang breaks `prehello` on Linux/macOS if the package was built on Windows)", () => {
    const head = fs.readFileSync(path.join(__dirname, "..", "dist", "cli.js"), "latin1").slice(0, 40);
    expect(head.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(fs.readFileSync(path.join(__dirname, "..", "dist", "cli.js"), "latin1")).not.toContain("\r\n");
  });
  it("package.json bin points at the built file and ships the files the CLI needs", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    expect(pkg.bin.prehello).toBe("dist/cli.js");
    for (const f of ["dist", "assets", "spec"]) expect(pkg.files).toContain(f);
    expect(pkg.optionalDependencies["@resvg/resvg-wasm"]).toBeTruthy();
    expect(Object.keys(pkg.dependencies).length).toBeLessThanOrEqual(5);
  });
});
