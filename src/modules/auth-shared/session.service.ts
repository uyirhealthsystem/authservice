import { prisma } from "../../lib/prisma";
import { generateRefreshToken, hashRefreshToken } from "../../lib/refreshToken";
import { signAccessToken } from "../../lib/jwt";
import { Errors } from "../../lib/errors";
import { getPortal } from "../../lib/portals";

interface StartSessionInput {
  userId: string;
  role: string;
  portalId: string;
  audience: string;
  accessTokenTtlMin: number;
  refreshTokenTtlDays: number;
  userAgent?: string;
  ip?: string;
}

export async function startSession(input: StartSessionInput) {
  const session = await prisma.session.create({
    data: {
      userId: input.userId,
      portalId: input.portalId,
      audience: input.audience,
      userAgent: input.userAgent,
      ip: input.ip,
    },
  });

  const refreshToken = generateRefreshToken();
  const expiresAt = new Date(Date.now() + input.refreshTokenTtlDays * 24 * 60 * 60 * 1000);
  await prisma.refreshToken.create({
    data: { sessionId: session.id, tokenHash: hashRefreshToken(refreshToken), expiresAt },
  });

  const accessToken = await signAccessToken(
    { sub: input.userId, role: input.role },
    { audience: input.audience, expiresInMin: input.accessTokenTtlMin },
  );

  return { accessToken, refreshToken, sessionId: session.id };
}

// The core security-sensitive operation in the service. A throw inside
// prisma.$transaction is a ROLLBACK signal, not "commit the writes so far,
// then report an error" - so every branch (including reuse-detected) must
// RETURN a discriminated result and let the caller throw only after the
// transaction has committed. Getting this backwards would silently undo the
// very revocation meant to punish token reuse.
type RotateResult =
  | { kind: "ok"; accessToken: string; refreshToken: string; refreshTokenTtlDays: number }
  | { kind: "reuse_detected"; sessionId: string }
  | { kind: "expired" }
  | { kind: "not_found" };

export async function rotateRefreshToken(
  presentedToken: string,
): Promise<{ accessToken: string; refreshToken: string; refreshTokenTtlDays: number }> {
  const presentedHash = hashRefreshToken(presentedToken);

  const result = await prisma.$transaction<RotateResult>(async (tx) => {
    const rows = await tx.$queryRaw<
      {
        id: string;
        sessionId: string;
        status: string;
        expiresAt: Date;
        userId: string;
        audience: string;
        portalId: string;
        role: string;
      }[]
    >`
      SELECT rt.id, rt."sessionId", rt.status, rt."expiresAt",
             s."userId", s.audience, s."portalId", u.role
      FROM refresh_tokens rt
      JOIN sessions s ON s.id = rt."sessionId"
      JOIN users u ON u.id = s."userId"
      WHERE rt."tokenHash" = ${presentedHash}
      FOR UPDATE OF rt
    `;
    const row = rows[0];
    if (!row) return { kind: "not_found" };
    const portal = getPortal(row.portalId);

    if (row.status === "ROTATED" || row.status === "REVOKED") {
      await tx.session.update({ where: { id: row.sessionId }, data: { revokedAt: new Date() } });
      await tx.refreshToken.updateMany({
        where: { sessionId: row.sessionId, status: "ACTIVE" },
        data: { status: "REVOKED" },
      });
      return { kind: "reuse_detected", sessionId: row.sessionId };
    }

    if (row.expiresAt < new Date()) return { kind: "expired" };

    await tx.refreshToken.update({ where: { id: row.id }, data: { status: "ROTATED", rotatedAt: new Date() } });

    const newToken = generateRefreshToken();
    const expiresAt = new Date(Date.now() + portal.refreshTokenTtlDays * 24 * 60 * 60 * 1000);
    await tx.refreshToken.create({
      data: { sessionId: row.sessionId, tokenHash: hashRefreshToken(newToken), expiresAt },
    });

    const accessToken = await signAccessToken(
      { sub: row.userId, role: row.role },
      { audience: row.audience, expiresInMin: portal.accessTokenTtlMin },
    );

    return { kind: "ok", accessToken, refreshToken: newToken, refreshTokenTtlDays: portal.refreshTokenTtlDays };
  });

  if (result.kind === "reuse_detected") {
    throw Errors.forbidden("Refresh token reuse detected; session revoked.");
  }
  if (result.kind === "expired") throw Errors.notAuthenticated();
  if (result.kind === "not_found") throw Errors.notAuthenticated();

  return {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    refreshTokenTtlDays: result.refreshTokenTtlDays,
  };
}

export async function revokeSessionByRefreshToken(presentedToken: string) {
  const tokenHash = hashRefreshToken(presentedToken);
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash } });
  if (!row) return;
  await prisma.session.update({ where: { id: row.sessionId }, data: { revokedAt: new Date() } });
  await prisma.refreshToken.updateMany({
    where: { sessionId: row.sessionId, status: "ACTIVE" },
    data: { status: "REVOKED" },
  });
}

// "Sign out all devices": revoke every live session this user has, on every
// device/portal. Access tokens already issued stay valid until they expire
// (they're stateless JWTs - at most accessTokenTtlMin more) - but no session
// can be refreshed again, so within that window every device is logged out.
// Returns how many sessions were revoked.
export async function revokeAllSessionsForUser(userId: string): Promise<number> {
  const sessions = await prisma.session.findMany({
    where: { userId, revokedAt: null },
    select: { id: true },
  });
  if (sessions.length === 0) return 0;
  const ids = sessions.map((s) => s.id);

  await prisma.$transaction([
    prisma.session.updateMany({ where: { id: { in: ids } }, data: { revokedAt: new Date() } }),
    prisma.refreshToken.updateMany({
      where: { sessionId: { in: ids }, status: "ACTIVE" },
      data: { status: "REVOKED" },
    }),
  ]);

  return ids.length;
}
