import { prisma } from "../../lib/prisma";
import { verifyGoogleIdToken, exchangeGoogleCode } from "../../lib/googleOAuth";
import { getPortal, resolveRegistrationRole, portalServesRole, PortalConfig } from "../../lib/portals";
import { startSession } from "../auth-shared/session.service";
import { Errors } from "../../lib/errors";
import { logger } from "../../lib/logger";

async function findOrCreateGoogleUser(
  googleSub: string,
  email: string | undefined,
  emailVerified: boolean,
  portal: PortalConfig,
  requestedRole: string | undefined,
) {
  const existingGoogleIdentity = await prisma.identity.findUnique({
    where: { provider_providerUserId: { provider: "GOOGLE", providerUserId: googleSub } },
    include: { user: true },
  });
  if (existingGoogleIdentity) return existingGoogleIdentity.user;

  // Only auto-link to an existing PASSWORD account when Google has actually
  // verified the email - otherwise anyone could claim an arbitrary email at
  // Google and take over an unrelated account here.
  if (email && emailVerified) {
    const existingPasswordIdentity = await prisma.identity.findUnique({
      where: { provider_providerUserId: { provider: "PASSWORD", providerUserId: email } },
      include: { user: true },
    });
    if (existingPasswordIdentity) {
      await prisma.identity.create({
        data: { userId: existingPasswordIdentity.userId, provider: "GOOGLE", providerUserId: googleSub, verifiedAt: new Date() },
      });
      return existingPasswordIdentity.user;
    }
  }

  // Brand-new account. `requestedRole` was picked at /auth/google/start and
  // already validated there; for single-role portals it's undefined and
  // resolveRegistrationRole returns the portal's one role.
  const role = resolveRegistrationRole(portal, requestedRole);
  const status = portal.autoApprove ? "ACTIVE" : "PENDING";
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: emailVerified ? email : undefined,
        role,
        status,
        approvedAt: status === "ACTIVE" ? new Date() : null,
      },
    });
    await tx.identity.create({
      data: { userId: user.id, provider: "GOOGLE", providerUserId: googleSub, verifiedAt: new Date() },
    });
    return user;
  });
}

// Shared tail of every Google login path (redirect + native): the same
// status / role checks as email login, then a session.
async function finishGoogleLogin(
  user: { id: string; status: string; role: string },
  portal: PortalConfig,
  meta: { userAgent?: string; ip?: string },
) {
  if (user.status === "PENDING") throw Errors.pendingApproval();
  if (user.status !== "ACTIVE") throw Errors.accountDisabled();

  if (!portalServesRole(portal, user.role)) {
    throw Errors.forbidden(`This account's role (${user.role}) is not valid on this portal.`);
  }

  const session = await startSession({
    userId: user.id,
    role: user.role,
    portalId: portal.clientId,
    audience: portal.clientId,
    accessTokenTtlMin: portal.accessTokenTtlMin,
    refreshTokenTtlDays: portal.refreshTokenTtlDays,
    userAgent: meta.userAgent,
    ip: meta.ip,
  });

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  return { ...session, role: user.role, refreshTokenTtlDays: portal.refreshTokenTtlDays, portal };
}

// Web redirect flow: Google sent us back a `code`, we exchange it.
export async function completeGoogleLogin(
  code: string,
  codeVerifier: string,
  clientId: string,
  meta: { userAgent?: string; ip?: string },
  requestedRole?: string,
) {
  const portal = getPortal(clientId);
  if (!portal.allowedProviders.includes("GOOGLE")) {
    throw Errors.badRequest("PROVIDER_NOT_ALLOWED", `Portal "${clientId}" does not accept Google login.`);
  }

  const tokenResponse = await exchangeGoogleCode(code, codeVerifier);
  logger.info({ idToken: tokenResponse.id_token }, "grabbed id_token")

  const idTokenClaims = await verifyGoogleIdToken(tokenResponse.id_token);

  const user = await findOrCreateGoogleUser(
    idTokenClaims.sub,
    idTokenClaims.email,
    idTokenClaims.email_verified ?? false,
    portal,
    requestedRole,
  );

  return finishGoogleLogin(user, portal, meta);
}

// Native flow: the mobile app ran Google Sign-In itself and posts us the
// resulting Google ID token. No code exchange, no redirect, no PKCE cookie.
export async function completeGoogleNativeLogin(
  idToken: string,
  clientId: string,
  requestedRole: string | undefined,
  meta: { userAgent?: string; ip?: string },
) {
  const portal = getPortal(clientId);
  if (!portal.allowedProviders.includes("GOOGLE")) {
    throw Errors.badRequest("PROVIDER_NOT_ALLOWED", `Portal "${clientId}" does not accept Google login.`);
  }
  if (!portal.nativeApp) {
    throw Errors.badRequest(
      "NOT_A_NATIVE_CLIENT",
      `Portal "${clientId}" is a web client; use the /auth/google/start redirect flow.`,
    );
  }

  const claims = await verifyGoogleIdToken(idToken);

  const user = await findOrCreateGoogleUser(
    claims.sub,
    claims.email,
    claims.email_verified ?? false,
    portal,
    requestedRole,
  );

  return finishGoogleLogin(user, portal, meta);
}
