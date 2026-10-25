/**
 * Windows path-shape simulation (opt-in: PREHELLO_SIM_WINSEP=1).
 *
 * On Windows, every path inside a Report (item.path, excluded[].path, ...) is native: backslashes. Only the renderers turn them into forward-slash
 * display paths. Tests that compared those raw values against "dir/file.md" literals passed on Linux/macOS and failed on Windows.
 * This simulation hands tests a Report whose path strings use backslashes, while the renderers (mocked in sim-winsep-setup.ts) still receive the
 * pristine report, so the only thing that changes is what the test code sees. Any test that fails under it has a separator assumption.
 */
export const WINSEP = process.env.PREHELLO_SIM_WINSEP === "1";

const originals = new WeakMap<object, unknown>();

/** The pristine object behind a simulated view (identity for anything else). */
export function real<T>(x: T): T {
  return (typeof x === "object" && x !== null && originals.has(x as object) ? originals.get(x as object) : x) as T;
}

function view(v: unknown, root: string): unknown {
  if (typeof v === "string") return v.startsWith(root) ? v.replace(/\//g, "\\") : v;
  if (Array.isArray(v)) {
    const out = v.map((x) => view(x, root));
    originals.set(out, v);
    return out;
  }
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = view(x, root);
    originals.set(out, v);
    return out;
  }
  return v;
}

/** Report as Windows would hand it out: path strings under `root` with backslashes. No-op unless the simulation is on. */
export function winView<T>(report: T, root: string): T {
  return WINSEP ? winViewForced(report, root) : report;
}

/** The same view regardless of the flag (used to test the simulation itself). */
export function winViewForced<T>(report: T, root: string): T {
  return view(report, root) as T;
}
