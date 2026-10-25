/**
 * Test-fixture folders. A repository that tests an agent tool (prehello itself, linters for AGENTS.md, skill validators, ...) keeps
 * sample AGENTS.md / CLAUDE.md / .cursor/rules / skills under test/fixtures/**. Those files are not loaded by any agent, so the
 * project walk skips such folders by default (`--include-fixtures` brings them back).
 *
 * Pure functions over path segments; callers split paths on BOTH separators so Windows paths work.
 */

/** Names that mean "test data" wherever they appear below the scan root. */
const FIXTURE_NAMES = new Set(["fixtures", "__fixtures__", "fixture", "testdata", "test-data", "__mocks__", "__snapshots__"]);
/** Names that are too generic on their own: only fixtures when they sit under one of TEST_PARENTS. */
const GENERIC_NAMES = new Set(["snapshots", "golden", "goldens"]);
const TEST_PARENTS = new Set(["test", "tests", "__tests__", "spec", "specs", "e2e", "cypress", "testdata", "test-data"]);

export function splitSegments(p: string): string[] {
  return p.split(/[\\/]+/).filter(Boolean);
}

/**
 * Is segment `i` of `segs` a fixture folder? `segs` = the segments from some root down to the folder, folder last at `i`.
 * Comparison is case-insensitive (macOS and Windows filesystems are).
 */
export function isFixtureSegment(segs: string[], i: number): boolean {
  const name = segs[i].toLowerCase();
  if (FIXTURE_NAMES.has(name)) return true;
  if (!GENERIC_NAMES.has(name)) return false;
  for (let j = 0; j < i; j++) if (TEST_PARENTS.has(segs[j].toLowerCase())) return true;
  return false;
}

/** Is the scan root itself inside a fixture folder (so the user is deliberately scanning a fixture)? Then nothing is skipped. */
export function rootIsInsideFixtures(cwd: string): boolean {
  const segs = splitSegments(cwd);
  for (let i = 0; i < segs.length; i++) if (isFixtureSegment(segs, i)) return true;
  return false;
}

/**
 * Directory filter for the walk below `cwd`. `rel` = segments below the root (folder last). The root's own last segment counts as a
 * possible test parent for generic names (scanning `repo/test` should still skip `test/golden`).
 */
export function makeFixtureSkipper(cwd: string): (name: string, rel: string[]) => boolean {
  const base = splitSegments(cwd).slice(-1);
  return (_name, rel) => isFixtureSegment([...base, ...rel], base.length + rel.length - 1);
}
