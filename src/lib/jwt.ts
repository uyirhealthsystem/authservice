import { SignJWT, jwtVerify, importSPKI } from "jose";
import { getActiveSigningPrivateKey } from "./keys";
import { prisma } from "./prisma";

// Deliberately minimal claim set: sub (user id), role (the single role this
// account holds, decided by which portal it was created through - see
// src/lib/portals.ts), aud (the portal's clientId).
export interface AccessTokenClaims {
  sub: string;
  role: string;
}

export async function signAccessToken(
  claims: AccessTokenClaims,
  opts: { audience: string; expiresInMin: number },
) {
  const { kid, alg, privateKey } = await getActiveSigningPrivateKey();
  return new SignJWT({ role: claims.role })
    .setProtectedHeader({ alg, kid })
    .setSubject(claims.sub)
    .setAudience(opts.audience)
    .setIssuedAt()
    .setExpirationTime(`${opts.expiresInMin}m`)
    .sign(privateKey);
}

export async function verifyAccessToken(token: string, audience?: string) {
  const { payload } = await jwtVerify(token, localJwks, { audience });
  return payload as unknown as AccessTokenClaims & { sub: string; aud: string; exp: number; iat: number };
}

// Verifies against this service's own signing keys (ACTIVE + RETIRED) read
// straight from the DB, not over HTTP - this process IS the JWKS authority.
async function localJwks(header: { kid?: string }) {
  const key = await prisma.signingKey.findFirst({
    where: { kid: header.kid, status: { in: ["ACTIVE", "RETIRED"] } },
  });
  if (!key) throw new Error("Unknown signing key kid");
  return importSPKI(key.publicKey, key.algorithm);
}
