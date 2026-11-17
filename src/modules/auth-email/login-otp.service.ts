import { prisma } from "../../lib/prisma";
import { env, isProduction } from "../../lib/env";
import { Errors } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { emitLoginOtpRequested } from "../../lib/events";
import { generateOtp, hashOtp, otpMatches } from "../../lib/otp";
import { getPortal, type PortalConfig } from "../../lib/portals";
import { assertCanLogin, issueLoginSession, type LoginMeta } from "./auth-email.service";

// Second step of email/password login. Flow:
//   1. POST /email/login          password OK -> startLoginChallenge(): code emailed,
//                                 client gets { otpRequired, challengeId, ... }
//   2. POST /email/login/verify   challengeId + code -> verifyLoginChallenge(): tokens
//      POST /email/login/resend   challengeId -> resendLoginChallenge(): fresh code
//
// Guards, all enforced in the database so they hold across processes:
//   - code TTL (env.loginOtp.ttlMin), single use (consumedAt)
//   - wrong guesses capped per challenge (attempts, incremented atomically
//     BEFORE comparing, so parallel guesses can't exceed the cap)
//   - challenge bound to the portal it started on
//   - resend cooldown + per-challenge send cap + per-account send cap per window
//   - account status / portal role re-checked at verify time

const CODE_LENGTH = 6;
// How long after the password step a challenge can still be resent. Past this
// the user must enter their password again.
const CHALLENGE_MAX_AGE_MIN = 30;

const cfg = () => env.loginOtp;
const minutesFromNow = (min: number) => new Date(Date.now() + min * 60_000);

export interface ChallengeResponse {
  otpRequired: true;
  challengeId: string;
  email: string; // masked, e.g. "me***@example.com" - for "we sent a code to ..."
  codeLength: number;
  expiresAt: string;
  resendAvailableAt: string;
}

// "meera@example.com" -> "me***@example.com"; "ab@x.com" -> "a***@x.com"
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  const local = email.slice(0, at);
  const keep = local.length > 2 ? 2 : 1;
  return `${local.slice(0, keep)}***${email.slice(at)}`;
}

function challengeResponse(c: { id: string; expiresAt: Date; lastSentAt: Date }, email: string): ChallengeResponse {
  return {
    otpRequired: true,
    challengeId: c.id,
    email: maskEmail(email),
    codeLength: CODE_LENGTH,
    expiresAt: c.expiresAt.toISOString(),
    resendAvailableAt: new Date(c.lastSentAt.getTime() + cfg().resendCooldownSec * 1000).toISOString(),
  };
}

// Per-account cap on codes emailed in the rolling window, across every
// challenge. Someone who knows the password can't use login/resend to flood
// the owner's inbox.
async function assertUserSendBudget(userId: string): Promise<void> {
  const since = new Date(Date.now() - cfg().userWindowMin * 60_000);
  const sent = await prisma.loginChallenge.aggregate({
    where: { userId, createdAt: { gte: since } },
    _sum: { sendCount: true },
  });
  if ((sent._sum.sendCount ?? 0) >= cfg().maxSendsPerUserWindow) {
    throw Errors.tooManyRequests(
      "LOGIN_CODE_LIMIT",
      `Too many sign-in codes requested. Please wait ${cfg().userWindowMin} minutes and try again.`,
    );
  }
}

// Hands the code to notification-service. Returns false if it could not be
// sent. With Kafka unconfigured outside production (local dev), the code is
// logged instead so a developer can still log in; production never does that.
async function sendCode(
  user: { id: string; email: string },
  portal: PortalConfig,
  otp: string,
  expiresAt: Date,
  meta: LoginMeta,
): Promise<boolean> {
  let delivered: boolean;
  try {
    delivered = await emitLoginOtpRequested({
      userId: user.id,
      email: user.email,
      otp,
      expiresAt: expiresAt.toISOString(),
      portalName: portal.name,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
  } catch (err) {
    logger.error({ err, userId: user.id }, "failed to publish LoginOtpRequested");
    return false;
  }
  if (delivered) return true;
  if (isProduction) {
    logger.error({ userId: user.id }, "KAFKA_BROKERS not set - cannot send login codes in production");
    return false;
  }
  logger.warn({ userId: user.id, email: user.email, otp }, "DEV ONLY: Kafka not configured - login code logged instead of emailed");
  return true;
}

const sendFailed = () =>
  Errors.serviceUnavailable("We couldn't send your sign-in code right now. Please try again in a moment.");

/** Step 1 (after the password checked out): create a challenge and email its code. */
export async function startLoginChallenge(
  user: { id: string; email: string },
  portal: PortalConfig,
  meta: LoginMeta,
): Promise<ChallengeResponse> {
  await assertUserSendBudget(user.id);

  // Housekeeping: this account's challenges from over a day ago are dead
  // weight (the send-budget window is far shorter). Keeps the table small
  // without a separate cleanup job.
  await prisma.loginChallenge.deleteMany({
    where: { userId: user.id, createdAt: { lt: new Date(Date.now() - 24 * 60 * 60_000) } },
  });

  const otp = generateOtp();
  const challenge = await prisma.loginChallenge.create({
    data: {
      userId: user.id,
      portalId: portal.clientId,
      codeHash: hashOtp(otp),
      expiresAt: minutesFromNow(cfg().ttlMin),
      ip: meta.ip,
      userAgent: meta.userAgent,
    },
  });

  if (!(await sendCode(user, portal, otp, challenge.expiresAt, meta))) {
    await prisma.loginChallenge.delete({ where: { id: challenge.id } }).catch(() => {});
    throw sendFailed();
  }
  return challengeResponse(challenge, user.email);
}

/** Step 2: redeem challengeId + code for a session. */
export async function verifyLoginChallenge(challengeId: string, otp: string, clientId: string, meta: LoginMeta) {
  const portal = getPortal(clientId);
  const now = new Date();

  // Count the attempt first, atomically, and only on a live challenge for this
  // portal. If nothing matched, work out why for the error message.
  const counted = await prisma.loginChallenge.updateMany({
    where: {
      id: challengeId,
      portalId: clientId,
      consumedAt: null,
      expiresAt: { gt: now },
      attempts: { lt: cfg().maxAttempts },
    },
    data: { attempts: { increment: 1 } },
  });
  if (counted.count === 0) {
    const existing = await prisma.loginChallenge.findFirst({ where: { id: challengeId, portalId: clientId } });
    if (existing && !existing.consumedAt && existing.expiresAt > now && existing.attempts >= cfg().maxAttempts) {
      throw Errors.invalidLoginCode(0);
    }
    throw Errors.loginChallengeInvalid();
  }

  const challenge = await prisma.loginChallenge.findUniqueOrThrow({
    where: { id: challengeId },
    include: { user: true },
  });

  if (!otpMatches(otp, challenge.codeHash)) {
    throw Errors.invalidLoginCode(cfg().maxAttempts - challenge.attempts);
  }

  // Single use: only one concurrent request can flip consumedAt.
  const consumed = await prisma.loginChallenge.updateMany({
    where: { id: challengeId, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (consumed.count === 0) throw Errors.loginChallengeInvalid();

  // The account may have been disabled (or its role changed) since step 1.
  assertCanLogin(challenge.user, portal);

  return issueLoginSession(challenge.user, portal, meta);
}

/** Replace the challenge's code with a fresh one and email it. */
export async function resendLoginChallenge(challengeId: string, clientId: string, meta: LoginMeta) {
  const portal = getPortal(clientId);
  const challenge = await prisma.loginChallenge.findFirst({
    where: {
      id: challengeId,
      portalId: clientId,
      consumedAt: null,
      attempts: { lt: cfg().maxAttempts },
      createdAt: { gt: new Date(Date.now() - CHALLENGE_MAX_AGE_MIN * 60_000) },
    },
    include: { user: true },
  });
  if (!challenge || !challenge.user.email || challenge.user.status !== "ACTIVE") {
    throw Errors.loginChallengeInvalid();
  }

  const readyAt = challenge.lastSentAt.getTime() + cfg().resendCooldownSec * 1000;
  if (Date.now() < readyAt) {
    const wait = Math.ceil((readyAt - Date.now()) / 1000);
    throw Errors.tooManyRequests(
      "LOGIN_CODE_RESEND_TOO_SOON",
      `Please wait ${wait} second${wait === 1 ? "" : "s"} before requesting another code.`,
    );
  }
  if (challenge.sendCount >= cfg().maxSendsPerChallenge) {
    throw Errors.tooManyRequests("LOGIN_CODE_RESEND_LIMIT", "Too many codes requested for this sign-in. Please log in again.");
  }
  await assertUserSendBudget(challenge.userId);

  // Optimistic lock on lastSentAt: of two simultaneous resends, one wins.
  const otp = generateOtp();
  const expiresAt = minutesFromNow(cfg().ttlMin);
  const lastSentAt = new Date();
  const swapped = await prisma.loginChallenge.updateMany({
    where: { id: challengeId, consumedAt: null, lastSentAt: challenge.lastSentAt },
    data: { codeHash: hashOtp(otp), expiresAt, lastSentAt, sendCount: { increment: 1 } },
  });
  if (swapped.count === 0) {
    throw Errors.tooManyRequests("LOGIN_CODE_RESEND_TOO_SOON", "A new code was just sent. Please check your email.");
  }

  const user = { id: challenge.userId, email: challenge.user.email };
  if (!(await sendCode(user, portal, otp, expiresAt, meta))) {
    // Put the previous code back so the email the user already has still works
    // and they can retry straight away.
    await prisma.loginChallenge
      .update({
        where: { id: challengeId },
        data: {
          codeHash: challenge.codeHash,
          expiresAt: challenge.expiresAt,
          lastSentAt: challenge.lastSentAt,
          sendCount: challenge.sendCount,
        },
      })
      .catch(() => {});
    throw sendFailed();
  }
  return challengeResponse({ id: challengeId, expiresAt, lastSentAt }, user.email);
}
