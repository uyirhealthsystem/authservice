import { rotateSigningKey } from "../lib/keys";
import { prisma } from "../lib/prisma";

// Deliberately rolls the signing key: the current ACTIVE key moves to
// RETIRED (still published in JWKS so tokens signed moments ago keep
// verifying) and a fresh ACTIVE key is generated. Zero downtime.
rotateSigningKey()
  .then((key) => {
    console.log(`Signing key rotated. New active kid: ${key.kid}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
