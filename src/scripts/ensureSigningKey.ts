import { prisma } from "../lib/prisma";
import { rotateSigningKey } from "../lib/keys";

// Idempotent "bootstrap": create the first ACTIVE signing key only if the
// service has none. Safe to run on every deploy - it is a no-op once a key
// exists. Use `keys:rotate` (never this) to deliberately roll the key.
async function main() {
  const existing = await prisma.signingKey.findFirst({ where: { status: "ACTIVE" } });
  if (existing) {
    console.log(`Signing key already present (kid: ${existing.kid}); nothing to do.`);
    return;
  }
  const key = await rotateSigningKey();
  console.log(`Bootstrapped first signing key. Active kid: ${key.kid}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
