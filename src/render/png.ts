/**
 * PNG export of the share card. Pure JS + WebAssembly: no native binaries, no network, no child processes.
 *
 * Engine: `@resvg/resvg-wasm` (MPL-2.0), an OPTIONAL dependency. If it is not installed, prehello says so and SVG keeps working.
 * Fonts: three subsetted static weights of Inter (SIL OFL 1.1, see assets/fonts/OFL.txt) are shipped in the package and handed to the
 * renderer as buffers. System fonts are never used, so the PNG looks the same on every machine and can never show "tofu" boxes
 * for the glyphs a card uses (ASCII, Latin-1, and a handful of punctuation marks).
 */
import fs from "node:fs";
import path from "node:path";

export class PngUnavailableError extends Error {}

/** Family name the PNG variant of the SVG asks for; it matches the name inside the shipped font files. */
export const PNG_FONT_FAMILY = "Inter";
const FONT_FILES = ["Inter-Regular.subset.ttf", "Inter-SemiBold.subset.ttf", "Inter-ExtraBold.subset.ttf"];
/** Average advance of the shipped Inter weights is 0.46-0.50 em on card text and 0.58-0.61 on caps and digits; layout uses this (the system-font stack uses a wider 0.62). */
export const PNG_CHAR_EM = 0.58;
export const FONT_DIR = path.join(__dirname, "..", "..", "assets", "fonts");

/** How this copy of prehello was installed; decides which install hint is listed first. Pure: takes the directory of the running code. */
export type InstallKind = "npx" | "global" | "local" | "source";
export function detectInstallKind(dir: string = __dirname, hasPackageJson: (d: string) => boolean = (d) => fs.existsSync(path.join(d, "package.json"))): InstallKind {
  const hits = [...dir.matchAll(/[\\/]node_modules(?=[\\/]|$)/g)];
  if (!hits.length) return "source";
  if (dir.split(/[\\/]+/).includes("_npx")) return "npx";
  // <something>/node_modules/prehello/dist/render -> <something> is a project (has package.json) for a local install,
  // and a global prefix (<prefix>/lib or %APPDATA%\npm, no package.json) for `npm install -g`.
  const holder = dir.slice(0, hits[hits.length - 1].index) || "/";
  return hasPackageJson(holder) ? "local" : "global";
}

/**
 * Printed (stderr) when PNG is asked for and the optional engine is missing. Same wording on Linux, macOS and Windows: npm commands
 * are identical there. The detected install kind is marked, the other ways follow, and SVG is always offered.
 */
export function pngUnavailableMessage(kind: InstallKind | "unknown" = "unknown"): string {
  const here = (k: InstallKind) => (kind === k ? "   <- how this prehello was installed" : "");
  return [
    "PNG cards need the optional package @resvg/resvg-wasm, which is not installed here, so no card was written (everything else in this run completed normally).",
    "Install it, then run the same command again:",
    `  global install of prehello:  npm install -g @resvg/resvg-wasm${here("global")}`,
    `  project install:             npm install @resvg/resvg-wasm   (run it in the project that has prehello in node_modules)${here("local")}`,
    `  one-off with npx:            npx --package prehello --package @resvg/resvg-wasm -- prehello --card=card.png${here("npx")}`,
    ...(kind === "source" ? ["  from a source checkout:      npm install   (in the prehello folder)   <- how this prehello is running"] : []),
    "  if you installed with --omit=optional (or npm config optional=false), reinstall without it.",
    "Or skip PNG: an SVG card needs no extra install, e.g. --card=card.svg (browsers and most image tools open it).",
  ].join("\n");
}

/** Generic form of the message (install kind unknown). */
export const PNG_UNAVAILABLE_MESSAGE = pngUnavailableMessage();

type ResvgModule = typeof import("@resvg/resvg-wasm");
let engine: Promise<ResvgModule> | undefined;

/** Loads the optional engine once. `resolver` exists so tests can simulate a missing dependency. */
export function loadEngine(resolver: (id: string) => string = require.resolve): Promise<ResvgModule> {
  if (engine) return engine;
  const p = (async (): Promise<ResvgModule> => {
    let mod: ResvgModule;
    let wasmPath: string;
    try {
      wasmPath = resolver("@resvg/resvg-wasm/index_bg.wasm");
      mod = require(resolver("@resvg/resvg-wasm")) as ResvgModule;
    } catch {
      throw new PngUnavailableError(pngUnavailableMessage(detectInstallKind()));
    }
    try {
      await mod.initWasm(fs.readFileSync(wasmPath));
    } catch (e) {
      const msg = (e as Error).message;
      // initWasm throws "Already initialized" when something else in the process initialised it: harmless.
      if (!/already initialized/i.test(msg)) throw new PngUnavailableError(`PNG export could not start its WebAssembly renderer (${msg}). Reinstalling it may help: npm install @resvg/resvg-wasm. Or write an SVG instead: --card=card.svg`);
    }
    return mod;
  })();
  // a failed load is not cached when the caller injected a resolver (tests); the real one is cached either way
  if (resolver === require.resolve) engine = p;
  return p;
}

/** Every glyph the card can print is in the font subset; anything else (never expected) becomes "?" rather than a tofu box. */
export function toFontSafeText(svg: string): string {
  return svg.replace(/[^\x09\x0a\x0d\x20-\x7e\u00a0-\u00ff\u2013\u2014\u2018\u2019\u201c\u201d\u2022\u2026\u2192\u2212\u2248\u2264\u2265]/gu, "?");
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function textChunk(keyword: string, text: string): Buffer {
  const data = Buffer.concat([Buffer.from(keyword, "latin1"), Buffer.from([0]), Buffer.from(text, "latin1")]);
  const body = Buffer.concat([Buffer.from("tEXt", "latin1"), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Adds `Software` and `Description` tEXt chunks right after IHDR. This is how prehello recognises its own PNG before replacing it. */
export function tagPng(png: Buffer, version: string): Buffer {
  const ihdrEnd = 8 + 4 + 4 + 13 + 4; // signature + length + type + data + crc
  return Buffer.concat([
    png.subarray(0, ihdrEnd),
    textChunk("Software", `prehello ${version}`),
    textChunk("Description", "Share card generated locally by prehello. Token counts are estimates."),
    png.subarray(ihdrEnd),
  ]);
}

export const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface PngOpts {
  /** 1 = the SVG's own pixel size (1200x630 / 1080x1080); 2 = double that, for sharp rendering on high-density screens (default). */
  scale: 1 | 2;
  version: string;
  resolver?: (id: string) => string;
}

/** Rasterises a card SVG (made with `fontFamily: PNG_FONT_FAMILY`) to a PNG buffer. Throws PngUnavailableError when the engine is missing. */
export async function svgToPng(svg: string, o: PngOpts): Promise<Buffer> {
  const { Resvg } = await loadEngine(o.resolver);
  let fontBuffers: Uint8Array[];
  try {
    fontBuffers = FONT_FILES.map((f) => new Uint8Array(fs.readFileSync(path.join(FONT_DIR, f))));
  } catch {
    throw new PngUnavailableError("PNG export could not read prehello's bundled fonts (assets/fonts is missing from this install). Reinstall prehello, or write an SVG instead: --card=card.svg");
  }
  const width = Number(/<svg[^>]*\swidth="(\d+)"/.exec(svg)?.[1] ?? 1200);
  try {
    const r = new Resvg(toFontSafeText(svg), {
      font: { fontBuffers, defaultFontFamily: PNG_FONT_FAMILY, sansSerifFamily: PNG_FONT_FAMILY },
      fitTo: { mode: "width", value: width * o.scale },
      textRendering: 1,
      shapeRendering: 2,
    });
    try {
      return tagPng(Buffer.from(r.render().asPng()), o.version);
    } finally {
      r.free();
    }
  } catch (e) {
    // never a stack trace: a renderer failure is reported like a missing engine, and SVG keeps working
    throw new PngUnavailableError(`PNG rendering failed (${String((e as Error)?.message ?? e).slice(0, 200)}). Write an SVG instead: --card=card.svg`);
  }
}
