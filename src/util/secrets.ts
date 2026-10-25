/** Secret-shaped string detection. Dependency-free so util/fmt can use it (sanitize() scrubs everything it displays). */

export const SECRET_RES: RegExp[] = [
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /github_pat_[A-Za-z0-9_]{30,}/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /AIza[0-9A-Za-z_-]{35}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(api[_-]?key|secret|token|passwd|password)["']?\s*[:=]\s*["']?[A-Za-z0-9_\-\/+=.]{16,}/i,
];

/** 1-based line numbers containing something that looks like a secret. Values are never returned. */
export function findSecretLines(text: string): number[] {
  const out: number[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length && out.length < 50; i++) {
    if (lines[i].length > 4000) continue;
    if (SECRET_RES.some((re) => re.test(lines[i]))) out.push(i + 1);
  }
  return out;
}

/** Replace anything secret-looking inside a string we are about to display. */
export function scrubSecrets(s: string): string {
  let out = s;
  for (const re of SECRET_RES) out = out.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"), "[redacted]");
  return out;
}
