/** Split markdown into alternating [prose, fence, prose, fence...] segments (``` or ~~~ fences). */
export function splitFences(text: string): Array<{ code: boolean; text: string }> {
  const lines = text.split("\n");
  const out: Array<{ code: boolean; text: string }> = [];
  let cur: string[] = [];
  let inFence = false;
  let marker = "";
  const flush = (code: boolean) => {
    if (cur.length) out.push({ code, text: cur.join("\n") });
    cur = [];
  };
  for (const line of lines) {
    const fm = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (!inFence && fm) {
      flush(false);
      inFence = true;
      marker = fm[1][0];
      cur.push(line);
    } else if (inFence && fm && fm[1][0] === marker && /^\s{0,3}(`{3,}|~{3,})\s*$/.test(line)) {
      cur.push(line);
      flush(true);
      inFence = false;
    } else {
      cur.push(line);
    }
  }
  flush(inFence);
  return out;
}

/** Claude Code strips block-level HTML comments before injection; comments inside code fences are kept. */
export function stripHtmlComments(text: string): string {
  return splitFences(text)
    .map((seg) => (seg.code ? seg.text : stripComments(seg.text)))
    .join("\n");
}

/**
 * Linear-time equivalent of text.replace(/<!--[\s\S]*?-->/g, ""). The regex form is quadratic on input such as "<!--" repeated
 * (every start rescans to the end for a "-->" that never comes), which a hostile 4 MiB CLAUDE.md turns into a hang.
 */
function stripComments(text: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const s = text.indexOf("<!--", i);
    if (s < 0) return out + text.slice(i);
    const e = text.indexOf("-->", s + 4);
    if (e < 0) return out + text.slice(i); // an unclosed comment is left as it is, like the regex
    out += text.slice(i, s);
    i = e + 3;
  }
}
