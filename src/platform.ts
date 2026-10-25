/**
 * Platform helpers: everything that differs between Linux, macOS and Windows lives here, as pure functions that take the
 * platform (and a `path` implementation) as arguments, so the Windows behaviour can be unit-tested on any machine.
 */
import path from "node:path";
import picomatch from "picomatch";

/** Is `p` an absolute path in the Windows sense (C:\x, C:/x, \\server\share)? Works on any host. */
export function isWinAbsolute(p: string): boolean {
  return path.win32.isAbsolute(p) && /^(?:[a-zA-Z]:[\\/]|\\\\|\/\/)/.test(p);
}

/**
 * The home directory the AGENTS use. Claude Code, Cursor (Electron) and Codex all take it from the OS, not from $HOME:
 * on Windows that is %USERPROFILE%. Git Bash sets HOME to a POSIX-style "/c/Users/me" that Node cannot open, and a network HOME
 * ("H:\") can differ from the profile folder the agents read, so on Windows HOME is only a last resort.
 */
export function resolveHomeDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, osHomedir: () => string): string {
  if (platform === "win32") {
    if (env.USERPROFILE && isWinAbsolute(env.USERPROFILE)) return env.USERPROFILE;
    if (env.HOMEDRIVE && env.HOMEPATH && isWinAbsolute(env.HOMEDRIVE + env.HOMEPATH)) return env.HOMEDRIVE + env.HOMEPATH;
    if (env.HOME && isWinAbsolute(env.HOME)) return env.HOME;
    return osHomedir();
  }
  if (env.HOME && path.posix.isAbsolute(env.HOME)) return env.HOME;
  return osHomedir();
}

/** Windows device names: opening "nul.svg" or "COM1.md" writes to a device (silently discarding the report), whatever the extension. */
export function isWindowsReservedName(file: string): boolean {
  const base = file.split(/[\\/]/).pop() ?? "";
  const stem = base.split(".")[0].replace(/[ .]+$/, "");
  return /^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i.test(stem);
}

/** On Windows a ":" after the drive letter is an NTFS alternate data stream ("report.md:hidden"): never write one. */
export function hasWindowsStream(file: string): boolean {
  return file.replace(/^(?:\\\\\?\\)?[a-zA-Z]:/, "").includes(":");
}

/**
 * Can this terminal draw the box/block/arrow glyphs prehello uses? Mirrors the widely used "is-unicode-supported" rule:
 * the Linux virtual console (TERM=linux) and the legacy Windows console host (cmd.exe / classic PowerShell window) cannot,
 * Windows Terminal, VS Code, JetBrains, ConEmu, Alacritty and modern xterm-likes can.
 */
export function unicodeSupported(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (env.PREHELLO_ASCII === "1") return false;
  if (platform !== "win32") return env.TERM !== "linux";
  return (
    !!env.WT_SESSION ||
    !!env.TERMINUS_SUBLIME ||
    env.ConEmuTask === "{cmd::Cmder}" ||
    env.TERM_PROGRAM === "vscode" ||
    env.TERM_PROGRAM === "Terminus-Sublime" ||
    env.TERM === "xterm-256color" ||
    env.TERM === "alacritty" ||
    env.TERMINAL_EMULATOR === "JetBrains-JediTerm"
  );
}

const ASCII_MAP: Record<string, string> = {
  "·": "-", "–": "-", "—": "-", "−": "-", "…": "...", "≥": ">=", "≤": "<=", "→": "->", "⚠": "!", "ℹ": "i", "•": "*",
  "█": "#", "▌": "=", "‘": "'", "’": "'", "“": '"', "”": '"', "≈": "~", "×": "x",
};
/** Replace every non-ASCII glyph prehello prints with an ASCII stand-in (accents and other letters become "?"). */
export function toAscii(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[^\x00-\x7f]/gu, (c) => ASCII_MAP[c] ?? "?");
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Glob matcher for settings such as claudeMdExcludes. Always matches forward-slash paths: a Windows path is converted first,
 * and backslashes in a pattern are path separators there (not escapes). Windows paths are case-insensitive.
 */
export function makeGlobMatcher(patterns: string[], platform: NodeJS.Platform): (file: string) => boolean {
  const win = platform === "win32";
  const pats = win ? patterns.map(toPosix) : patterns;
  const m = picomatch(pats, { dot: true, windows: false, nocase: win });
  return (file) => m(win ? toPosix(file) : file);
}

/** True if `child` is `parent` or inside it. A directory called "..foo" is inside; "../x" is not. */
export function isInsideWith(pm: path.PlatformPath, child: string, parent: string): boolean {
  const rel = pm.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + pm.sep) && !pm.isAbsolute(rel));
}

/**
 * Text a USER hands to prehello (--mcp-catalog file, --paste-user-rules file or stdin). Windows editors and PowerShell 5 write
 * a UTF-8 BOM or UTF-16: both are decoded here instead of failing as "malformed JSON" or counting a BOM as a token.
 * CRLF is normalised to LF for pasted rules so the same text counts the same on every platform.
 */
export function decodeUserText(buf: Buffer): string {
  let s: string;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) s = buf.subarray(2).toString("utf16le");
  else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) s = Buffer.from(buf.subarray(2)).swap16().toString("utf16le");
  else s = buf.toString("utf8");
  return s.replace(/^\ufeff/, "");
}
