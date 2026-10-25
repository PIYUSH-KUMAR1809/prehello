export type FmValue = string | boolean | string[];
export interface Frontmatter {
  data: Record<string, FmValue>;
  body: string;
  hasFrontmatter: boolean;
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) return t.slice(1, -1);
  return t;
}

/** Tiny YAML-subset frontmatter parser: scalars, booleans, inline lists, "- item" lists, | and > block scalars. */
export function parseFrontmatter(text: string): Frontmatter {
  const t = text.replace(/\r\n?/g, "\n");
  if (!t.startsWith("---\n") && t !== "---") return { data: Object.create(null), body: t, hasFrontmatter: false };
  const rest = t.slice(4);
  const m = /(^|\n)---[ \t]*(\n|$)/.exec(rest);
  if (!m) return { data: Object.create(null), body: t, hasFrontmatter: false };
  const header = rest.slice(0, m.index);
  const body = rest.slice(m.index + m[0].length);
  // no prototype: a key such as `__proto__: [a, b]` in an untrusted file must stay plain data
  const data: Record<string, FmValue> = Object.create(null);
  const lines = header.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const km = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!km) continue;
    const key = km[1];
    const val = km[2].trim();
    if (val === "|" || val === ">" || val === "|-" || val === ">-") {
      const parts: string[] = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1] === "")) parts.push(lines[++i].trim());
      data[key] = parts.join(val.startsWith(">") ? " " : "\n").trim();
    } else if (val === "") {
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) items.push(unquote(lines[++i].replace(/^\s*-\s+/, "")));
      data[key] = items.length ? items : "";
    } else if (val.startsWith("[") && val.endsWith("]")) {
      data[key] = val
        .slice(1, -1)
        .split(",")
        .map((x) => unquote(x))
        .filter(Boolean);
    } else if (val === "true" || val === "false") {
      data[key] = val === "true";
    } else {
      // plain or quoted scalar that continues on indented lines (YAML folds the line breaks into spaces)
      let full = val;
      const q = full[0] === '"' || full[0] === "'" ? full[0] : "";
      const closed = () => q === "" || full.indexOf(q, 1) !== -1;
      while (i + 1 < lines.length && (!closed() || (/^[ \t]+\S/.test(lines[i + 1]) && !/^\s*-\s/.test(lines[i + 1])))) {
        if (q && closed()) break;
        i++;
        full += " " + lines[i].trim();
        if (i > 4000) break;
      }
      data[key] = unquote(full);
    }
  }
  return { data, body, hasFrontmatter: true };
}

/** Normalise a frontmatter value that may be a list or a comma-separated string. */
export function asList(v: FmValue | undefined): string[] {
  if (v === undefined || typeof v === "boolean") return [];
  if (Array.isArray(v)) return v.filter(Boolean);
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function asString(v: FmValue | undefined): string {
  if (v === undefined) return "";
  if (typeof v === "boolean") return String(v);
  return Array.isArray(v) ? v.join(", ") : v;
}
