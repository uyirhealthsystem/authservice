import { existsSync } from "node:fs";
import { config } from "dotenv";
import { afterAll } from "vitest";
import { prisma } from "../src/lib/prisma";

// Load .env.test when present (local runs). CI injects the vars directly, so
// there is no file and this is skipped. Never override an already-set var -
// that lets CI / the shell win over a stale file.
if (existsSync(".env.test")) {
  config({ path: ".env.test" });
}

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL ??= "silent";
process.env.COOKIE_DOMAIN ??= "localhost";
// Don't let the brute-force limiter trip across the whole suite (one IP, one
// process). One dedicated test lowers it deliberately.
process.env.AUTH_RATE_LIMIT_MAX ??= "100000";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. Create .env.test (see docs/TESTING.md) or export it before running the suite.",
  );
}

afterAll(async () => {
  await prisma.$disconnect();
});
