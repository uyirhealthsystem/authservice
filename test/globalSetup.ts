import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { config } from "dotenv";

// Runs once, before any test file. Brings the test database up to the current
// schema and guarantees exactly one ACTIVE signing key exists (token signing
// throws without it).
export default async function () {
  if (existsSync(".env.test")) config({ path: ".env.test" });

  const run = (cmd: string) =>
    execSync(cmd, { stdio: "inherit", env: { ...process.env, NODE_ENV: "test" } });

  run("npx prisma migrate deploy");
  run("npx prisma generate");
  run("npx tsx src/scripts/ensureSigningKey.ts");
}
