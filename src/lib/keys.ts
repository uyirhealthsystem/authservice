import { generateKeyPair, exportJWK, exportPKCS8, exportSPKI, importPKCS8, importSPKI } from "jose";
import { randomUUID } from "crypto";
import { prisma } from "./prisma";

// SigningKey.privateKey is stored as plaintext PEM in Postgres, not a KMS.
// Acceptable for now; revisit before any real production deploy.

export async function rotateSigningKey() {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
  const kid = randomUUID();

  const publicPem = await exportSPKI(publicKey);
  const privatePem = await exportPKCS8(privateKey);

  return prisma.$transaction(async (tx) => {
    await tx.signingKey.updateMany({
      where: { status: "ACTIVE" },
      data: { status: "RETIRED", retiredAt: new Date() },
    });
    return tx.signingKey.create({
      data: { kid, algorithm: "RS256", publicKey: publicPem, privateKey: privatePem, status: "ACTIVE" },
    });
  });
}

export async function getActiveSigningKey() {
  const key = await prisma.signingKey.findFirst({ where: { status: "ACTIVE" } });
  if (!key) throw new Error("No active signing key. Run `npm run keys:bootstrap`.");
  return key;
}

export async function getActiveSigningPrivateKey() {
  const key = await getActiveSigningKey();
  const privateKey = await importPKCS8(key.privateKey, key.algorithm);
  return { kid: key.kid, alg: key.algorithm, privateKey };
}

// ACTIVE + RETIRED (never REVOKED-and-deleted) so a token signed before a
// rotation still verifies against JWKS after the rotation.
export async function getVerificationKeys() {
  return prisma.signingKey.findMany({
    where: { status: { in: ["ACTIVE", "RETIRED"] } },
    orderBy: { createdAt: "desc" },
  });
}

export async function toPublicJWKS() {
  const keys = await getVerificationKeys();
  const jwks = await Promise.all(
    keys.map(async (key) => {
      const publicKey = await importSPKI(key.publicKey, key.algorithm);
      const jwk = await exportJWK(publicKey);
      return { ...jwk, kid: key.kid, alg: key.algorithm, use: "sig" };
    }),
  );
  return { keys: jwks };
}
