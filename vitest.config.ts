import { defineConfig } from "vitest/config";

// The suite talks to a real Postgres (behaviour here is mostly DB-shaped:
// transactions, unique constraints, refresh-token rotation). Set DATABASE_URL
// to a throwaway test database - see test/README or docs/TESTING.md.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setupEnv.ts"],
    globalSetup: ["test/globalSetup.ts"],
    // One process, one file at a time: every test shares the same Postgres
    // and truncates between cases, so parallelism would cross the streams.
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
