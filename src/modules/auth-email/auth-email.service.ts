import { prisma } from "../../lib/prisma";
import { hashPassword, verifyPassword } from "../../lib/password";
import { Errors } from "../../lib/errors";
import { getPortal, resolveRegistrationRole, portalServesRole, type PortalConfig } from "../../lib/portals";
import { env } from "../../lib/env";
import { startSession } from "../auth-shared/session.service";
import { notifyLogin } from "../auth-shared/login-notification";
import { startLoginChallenge } from "./login-otp.service";

export async function registerWithEmail(
  email: string,
  password: string,
  clientId: string,
  requestedRole?: string,
) {
  const portal = getPortal(clientId);
  if (!portal.allowedProviders.includes("PASSWORD")) {
    throw Errors.badRequest("PROVIDER_NOT_ALLOWED", `Portal "${clientId}" does not accept email/password login.`);
  }

  // Single-role portal -> that role. service-provider-app -> the role the
  // user picked (validated against the portal's allowed set).
  const role = resolveRegistrationRole(portal, requestedRole);

  // Any account already on this email blocks a fresh registration - whether it
  // was created with a password or with Google. A Google-first user who also
  // wants a password uses the forgot/reset flow (POST /api/v1/auth/password/forgot)
  // to set one; registration can't safely attach a credential to an account
  // it can't prove the caller owns.
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw Errors.conflict(
      "EMAIL_TAKEN",
      "An account with this email already exists. If you signed up with Google, use \"forgot password\" to set a password for it.",
    );
  }

  const credentialHash = await hashPassword(password);

  // autoApprove portals (patient apps, super-admin bootstrap) go straight to
  // ACTIVE. Everyone else is PENDING until an ADMIN / SUPER_ADMIN approves.
  const status = portal.autoApprove ? "ACTIVE" : "PENDING";

  const user = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email,
        role,
        status,
        approvedAt: status === "ACTIVE" ? new Date() : null,
      },
    });
    await tx.identity.create({
      data: { userId: user.id, provider: "PASSWORD", providerUserId: email, credentialHash, verifiedAt: null },
    });
    return user;
  });

  return user;
}

export type LoginMeta = { userAgent?: string; ip?: string };

// Status + portal-role gate shared by both login steps (the OTP step re-runs
// it, since the account can change between the two).
export function assertCanLogin(user: { status: string; role: string }, portal: PortalConfig): void {
  if (user.status === "PENDING") throw Errors.pendingApproval();
  if (user.status !== "ACTIVE") throw Errors.accountDisabled();
  // The account's stored role must be one this portal serves - so a PATIENT
  // account presenting perfectly correct credentials at service-provider-app
  // still gets rejected here, and vice versa.
  if (!portalServesRole(portal, user.role)) {
    throw Errors.forbidden(`This account's role (${user.role}) is not valid on this portal.`);
  }
}

// Final step of an email/password login: session + tokens, lastLoginAt, and
// the "new sign-in" alert.
export async function issueLoginSession(
  user: { id: string; email: string | null; role: string },
  portal: PortalConfig,
  meta: LoginMeta,
) {
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
  notifyLogin(user, portal, "PASSWORD", meta);

  return {
    ...session,
    role: user.role,
    refreshTokenTtlDays: portal.refreshTokenTtlDays,
    portal,
  };
}

// Step 1 of email/password login. With login OTP on (the default) a correct
// password only starts a challenge - the code is emailed and the tokens come
// from POST /email/login/verify. LOGIN_OTP_ENABLED=false issues tokens here.
export async function loginWithEmail(email: string, password: string, clientId: string, meta: LoginMeta) {
  const portal = getPortal(clientId);

  const identity = await prisma.identity.findUnique({
    where: { provider_providerUserId: { provider: "PASSWORD", providerUserId: email } },
    include: { user: true },
  });

  if (!identity || !identity.credentialHash || !(await verifyPassword(password, identity.credentialHash))) {
    throw Errors.invalidCredentials();
  }

  assertCanLogin(identity.user, portal);

  if (env.loginOtp.enabled) {
    // A PASSWORD identity's providerUserId is the email, so there is always
    // an address to send the code to.
    const user = { id: identity.user.id, email: identity.user.email ?? email };
    return { kind: "otp" as const, challenge: await startLoginChallenge(user, portal, meta) };
  }
  return { kind: "session" as const, ...(await issueLoginSession(identity.user, portal, meta)) };
}
