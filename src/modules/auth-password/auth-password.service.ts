import { prisma } from "../../lib/prisma";
import { hashPassword } from "../../lib/password";
import { Errors } from "../../lib/errors";
import { getPortal } from "../../lib/portals";
import { generateOtp, hashOtp, OTP_TTL_MIN } from "../../lib/otp";
import { emitPasswordResetRequested } from "../../lib/events";
import { revokeAllSessionsForUser } from "../auth-shared/session.service";
import { logger } from "../../lib/logger";

// Start a reset. Deliberately silent about whether the email maps to an
// account - the route always answers 202. On a real hit we mint a single-use
// OTP, store only its hash, and emit a domain event carrying the raw code;
// the notification service turns that into an email.
export async function requestPasswordReset(email: string, clientId: string): Promise<void> {
  getPortal(clientId); // validates the portal (throws UNKNOWN_PORTAL)

  const user = await prisma.user.findUnique({ where: { email } });
  // No account, a disabled account, or a Google account with no verified email
  // (nothing to key a password on) -> do nothing, but still 202.
  if (!user || user.status === "DISABLED" || !user.email) {
    logger.info({ email }, "password reset requested for a non-eligible address - ignoring");
    return;
  }

  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + OTP_TTL_MIN * 60 * 1000);
  await prisma.passwordResetToken.create({
    data: { userId: user.id, codeHash: hashOtp(otp), expiresAt },
  });

  await emitPasswordResetRequested({
    userId: user.id,
    email: user.email,
    otp,
    expiresAt: expiresAt.toISOString(),
  });
}

// Redeem the emailed code and set the password. Creates the PASSWORD identity
// if the account never had one (Google-first user), or replaces the hash if
// it did (genuine "forgot"). Every existing session is revoked afterwards.
export async function resetPassword(email: string, otp: string, password: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email }, include: { identities: true } });

  const row =
    user &&
    (await prisma.passwordResetToken.findFirst({
      where: { userId: user.id, codeHash: hashOtp(otp) },
      orderBy: { createdAt: "desc" },
    }));

  if (!user || !row || row.usedAt || row.expiresAt < new Date()) {
    throw Errors.badRequest("INVALID_RESET_CODE", "This code is invalid or has expired.");
  }

  if (!user.email) {
    // Defensive - requestPasswordReset already filters these out.
    throw Errors.badRequest("NO_EMAIL", "This account has no email address on file.");
  }
  const userEmail = user.email;

  const credentialHash = await hashPassword(password);
  const passwordIdentity = user.identities.find((i) => i.provider === "PASSWORD");

  await prisma.$transaction(async (tx) => {
    if (passwordIdentity) {
      await tx.identity.update({
        where: { id: passwordIdentity.id },
        data: { credentialHash, verifiedAt: new Date() },
      });
    } else {
      await tx.identity.create({
        data: {
          userId: user.id,
          provider: "PASSWORD",
          providerUserId: userEmail,
          credentialHash,
          verifiedAt: new Date(),
        },
      });
    }

    await tx.passwordResetToken.update({ where: { id: row.id }, data: { usedAt: new Date() } });
    // Invalidate any other outstanding codes for this user.
    await tx.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });
  });

  // Runs its own transaction - must be outside the block above.
  await revokeAllSessionsForUser(user.id);
}
