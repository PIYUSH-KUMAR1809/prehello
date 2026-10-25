import { vi } from "vitest";

// Opt-in (PREHELLO_SIM_WINSEP=1): renderers always get the pristine report, see winsep.ts.
// vi.mock is hoisted above everything, so the helper lives in vi.hoisted; without the flag the factories return the real module untouched.
const wrap = vi.hoisted(() => {
  return async (names: string[], orig: () => Promise<Record<string, unknown>>) => {
    const o = await orig();
    if (process.env.PREHELLO_SIM_WINSEP !== "1") return o;
    const { real } = await import("./winsep");
    const out: Record<string, unknown> = { ...o };
    for (const n of names) {
      const fn = o[n] as (...a: unknown[]) => unknown;
      out[n] = function (this: unknown, ...a: unknown[]) {
        return fn.apply(this, a.map((x) => real(x)));
      };
    }
    return out;
  };
});

vi.mock("../../src/render/terminal", (orig) => wrap(["renderTerminal"], orig as never));
vi.mock("../../src/render/json", (orig) => wrap(["toJson"], orig as never));
vi.mock("../../src/render/markdown", (orig) => wrap(["renderMarkdown"], orig as never));
vi.mock("../../src/render/sarif", (orig) => wrap(["toSarif", "renderSarif"], orig as never));
vi.mock("../../src/render/fix", (orig) => wrap(["renderFix"], orig as never));
vi.mock("../../src/render/card", (orig) => wrap(["renderCard", "pickCardAgent", "buildHeadline"], orig as never));
