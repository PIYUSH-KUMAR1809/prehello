import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/helpers/sim-shortpath.ts"],
    testTimeout: 60_000,
    // creating and deleting thousands of files is slow on Windows runners (Defender): the 10 s default failed the afterAll cleanup there
    hookTimeout: 120_000,
    pool: "forks",
  },
});
