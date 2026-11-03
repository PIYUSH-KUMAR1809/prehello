import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AGENTS, ALL_AGENTS, AGENT_NAMES } from "../src/agents";
import { ADAPTERS } from "../src/adapters";
import { loadSpec } from "../src/spec";
import { profileFor } from "../src/tokens/families";
import { expandImports } from "../src/text/imports";
import { cleanup, materialize, runScan, Mat } from "./helpers/fixtures";
import type { Report } from "../src/model";
import { fsPath, posix } from "./helpers/tmp";

afterAll(cleanup);

const ROOT = path.join(__dirname, "..");
const itemsOf = (r: Report, id: string) => r.agents.find((a) => a.id === id)?.items ?? [];
// Report paths may be the PREHELLO_SIM_WINSEP backslash view; compare in forward-slash form and open via fsPath
const rel = (m: Mat, p: string) => path.posix.relative(posix(m.root), posix(p));
const write = (p: string, c: string) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, c);
};

describe("agent registry", () => {
  it("ids are unique and every agent has a name, an adapter, a spec with docs, and a profile", () => {
    expect(new Set(ALL_AGENTS).size).toBe(AGENTS.length);
    expect(Object.keys(ADAPTERS).sort()).toEqual([...ALL_AGENTS].sort());
    for (const id of ALL_AGENTS) {
      expect(AGENT_NAMES[id]).toBeTruthy();
      const s = loadSpec(id);
      expect(s.agent).toBe(id);
      expect(s.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Object.values(s.docs).length).toBeGreaterThan(0);
      for (const u of Object.values(s.docs)) expect(u).toMatch(/^https:\/\//);
      expect(profileFor(id, "bpe-o200k" as never, "current").label).toBeTruthy();
    }
  });
  it("no agent list is hard-coded outside the registry", () => {
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !p.endsWith(path.join("src", "agents.ts")) && !p.endsWith(path.join("adapters", "index.ts"))) {
          const t = fs.readFileSync(p, "utf8");
          if (/"claude-code"\s*\|\s*"cursor"/.test(t) || /\[\s*"claude-code",\s*"cursor",\s*"codex"/.test(t)) offenders.push(path.relative(ROOT, p));
        }
      }
    };
    walk(path.join(ROOT, "src"));
    expect(offenders).toEqual([]);
  });
  it("Copilot and Gemini estimates are marked unvalidated and use no agent-specific factor", () => {
    for (const id of ["github-copilot", "gemini-cli"] as const) {
      const p = profileFor(id, "bpe-o200k" as never, "current");
      expect(p.unvalidated).toBe(true);
      const e = p.apply(1000);
      expect(e.low).toBeLessThanOrEqual(1000);
      expect(e.high).toBeGreaterThan(1000);
    }
    expect(profileFor("gemini-cli", "bpe-o200k" as never, "current").apply(1000).est).toBe(1000);
    expect(profileFor("gemini-cli", "bpe-o200k" as never, "current").label).toMatch(/no measured Gemini ratio/);
  });
});

describe("GitHub Copilot adapter", () => {
  const m = materialize("copilot-mix");
  const r = runScan(m, { agents: ["github-copilot"] });
  const its = itemsOf(r, "github-copilot");
  const by = (suffix: string) => its.filter((i) => rel(m, i.path).endsWith(suffix));

  it("always-on: user + repo copilot-instructions, AGENTS.md, GEMINI.md", () => {
    for (const f of ["home/.copilot/copilot-instructions.md", "project/.github/copilot-instructions.md", "project/AGENTS.md", "project/GEMINI.md"]) {
      expect(by(f).map((i) => i.loadMode), f).toEqual(["always"]);
    }
  });
  it("identical CLAUDE.md is removed as a duplicate (documented)", () => {
    expect(by("project/CLAUDE.md")).toEqual([]);
    expect(r.excluded.some((e) => e.agent === "github-copilot" && posix(e.path).endsWith("CLAUDE.md") && /identical/.test(e.reason))).toBe(true);
  });
  it("@imports: relative in-repo followed; absolute and ~/ not; none in GEMINI.md", () => {
    const ci = by("project/.github/copilot-instructions.md")[0];
    expect(ci.detail).toBe("(+1 @import)");
    expect(ci.notes.join(" ")).toMatch(/2 @import\(s\) not followed/);
    expect(by("project/GEMINI.md")[0].detail).toBeUndefined();
  });
  it("*.instructions.md: applyTo → conditional, description only → deferred, neither → excluded", () => {
    expect(by("ts.instructions.md")[0].loadMode).toBe("conditional");
    expect(by("personal.instructions.md")[0].loadMode).toBe("conditional");
    expect(by("review.instructions.md")[0].loadMode).toBe("deferred");
    expect(by("manual.instructions.md")).toEqual([]);
    expect(r.excluded.some((e) => posix(e.path).endsWith("manual.instructions.md"))).toBe(true);
  });
  it("frontmatter is not counted in instruction bodies", () => {
    const t = by("ts.instructions.md")[0];
    expect(t.chars).toBeLessThan(fs.readFileSync(fsPath(t.path), "utf8").length);
  });
  it("prompt files are on-demand; nested AGENTS.md is conditional", () => {
    expect(by("release.prompt.md")[0].loadMode).toBe("on-demand");
    expect(by("packages/api/AGENTS.md")[0].loadMode).toBe("conditional");
  });
  it("MCP: project .mcp.json wins over ~/.copilot/mcp-config.json; .vscode/mcp.json servers read", () => {
    const a = r.agents[0];
    expect(a.mcpServers.map((s) => s.name).sort()).toEqual(["context7", "playwright"]);
    const c7 = its.filter((i) => i.server?.name === "context7");
    expect(c7).toHaveLength(1);
    expect(c7[0].scope).toBe("project");
    expect(posix(its.find((i) => i.server?.name === "playwright")!.path).endsWith(".vscode/mcp.json")).toBe(true);
  });
  it("AGENTS.md alone does not make Copilot or Gemini show up", () => {
    const m2 = materialize("empty-machine");
    write(path.join(m2.project, "AGENTS.md"), "# a\n\nhello there\n");
    const r2 = runScan(m2);
    expect(r2.agents.map((a) => a.id)).not.toContain("github-copilot");
    expect(r2.agents.map((a) => a.id)).not.toContain("gemini-cli");
  });
  it("repo-only detection: .github/copilot-instructions.md without ~/.copilot", () => {
    const m2 = materialize("empty-machine");
    write(path.join(m2.project, ".github", "copilot-instructions.md"), "# x\n\nUse tabs.\n");
    const a = runScan(m2).agents.find((x) => x.id === "github-copilot")!;
    expect(a.presentInRepoOnly).toBe(true);
  });
  it("COPILOT_HOME replaces ~/.copilot", () => {
    const m2 = materialize("empty-machine");
    write(path.join(m2.root, "alt", "copilot-instructions.md"), "# alt\n\nFrom COPILOT_HOME.\n");
    const r2 = runScan(m2, { env: { HOME: m2.home, PATH: "", COPILOT_HOME: path.join(m2.root, "alt") }, agents: ["github-copilot"] });
    expect(itemsOf(r2, "github-copilot").some((i) => posix(i.path).startsWith(posix(path.join(m2.root, "alt")) + "/"))).toBe(true);
  });
});

describe("Gemini CLI adapter", () => {
  const m = materialize("gemini-mix");
  const r = runScan(m, { agents: ["gemini-cli"] });
  const its = itemsOf(r, "gemini-cli");
  const by = (suffix: string) => its.filter((i) => rel(m, i.path).endsWith(suffix));

  it("global + project GEMINI.md and context.fileName entries are always-on", () => {
    for (const f of ["home/.gemini/GEMINI.md", "home/.gemini/AGENTS.md", "project/GEMINI.md", "project/AGENTS.md"]) expect(by(f).map((i) => i.loadMode), f).toEqual(["always"]);
  });
  it("stops at the .git boundary and says so", () => {
    expect(its.some((i) => rel(m, i.path) === "GEMINI.md")).toBe(false);
    expect(r.excluded.some((e) => rel(m, e.path) === "GEMINI.md" && /boundary/.test(e.reason))).toBe(true);
  });
  it("@imports are followed recursively and skipped inside code blocks", () => {
    expect(by("project/GEMINI.md")[0].detail).toBe("(+2 @imports)");
  });
  it("subdirectory GEMINI.md is conditional (just-in-time)", () => {
    expect(by("services/GEMINI.md")[0].loadMode).toBe("conditional");
  });
  it("extensions: context file always-on; settings win an MCP name clash", () => {
    expect(by("acme-ext/ACME.md")[0].loadMode).toBe("always");
    const gh = its.filter((i) => i.server?.name === "github");
    expect(gh).toHaveLength(1);
    expect(gh[0].scope).toBe("user");
    expect(its.find((i) => i.server?.name === "acme-db")!.scope).toBe("plugin");
    expect(its.find((i) => i.server?.name === "local-tool")!.scope).toBe("project");
  });
  it("skills: name + description listing always, body deferred", () => {
    expect(its.find((i) => i.kind === "skills-listing")!.loadMode).toBe("always");
    expect(its.find((i) => i.kind === "skill-body")!.loadMode).toBe("deferred");
  });
  it("memoryBoundaryMarkers [] disables parent traversal; workspace fileName overrides user", () => {
    const m2 = materialize("gemini-mix");
    const sub = path.join(m2.project, "services");
    write(path.join(sub, ".gemini", "settings.json"), JSON.stringify({ context: { memoryBoundaryMarkers: [], fileName: "GEMINI.md" } }));
    const its2 = itemsOf(runScan(m2, { cwd: sub, agents: ["gemini-cli"] }), "gemini-cli");
    const rels = its2.filter((i) => i.kind === "instructions").map((i) => rel(m2, i.path));
    expect(rels).toContain("project/services/GEMINI.md");
    expect(rels).not.toContain("project/GEMINI.md");
    expect(rels).not.toContain("home/.gemini/AGENTS.md");
  });
  it("import depth follows the documented 5 levels", () => {
    const d = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "pre-imp-"));
    for (let i = 0; i < 7; i++) fs.writeFileSync(path.join(d, `f${i}.md`), `level ${i}\n@./f${i + 1}.md\n`);
    fs.writeFileSync(path.join(d, "f7.md"), "end\n");
    const res = expandImports(fs.readFileSync(path.join(d, "f0.md"), "utf8"), path.join(d, "f0.md"), d, () => true, { stripComments: false, maxDepth: 5 });
    expect(res.imported).toBe(5);
    expect(res.skipped.map((s) => s.reason)).toContain("depth>5");
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe("release workflow", () => {
  // GitHub filter syntax: [0-9] a class, + one or more of the previous, . literal; the pattern must match the whole tag.
  const toRe = (glob: string) => new RegExp("^" + glob.replace(/\./g, "\\.").replace(/\*/g, "[^/]*") + "$");
  const yml = fs.readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  const m = /tags:\s*\[("[^"]+"(?:\s*,\s*"[^"]+")*)\]/.exec(yml);
  const pats = m![1].split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
  it("only vX.Y.Z tags trigger a publish; the moving v1 tag does not", () => {
    const hit = (t: string) => pats.some((p) => toRe(p).test(t));
    expect(hit("v1.0.0")).toBe(true);
    expect(hit("v12.3.45")).toBe(true);
    for (const t of ["v1", "v1.0", "v1.0.0-rc.1", "latest", "v1.x"]) expect(hit(t), t).toBe(false);
  });
});
