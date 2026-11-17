import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { api, register, resetDb, uniqueEmail, PASSWORD, readSetCookie } from "./helpers";
import { prisma } from "../src/lib/prisma";
import { env } from "../src/lib/env";

// Capture the emitted events: the raw code only exists in the event payload.
vi.mock("../src/lib/events", () => ({
  AUTH_EVENTS_TOPIC: "auth.events",
  emitPasswordResetRequested: vi.fn(async () => {}),
  emitUserLoggedIn: vi.fn(async () => {}),
  emitLoginOtpRequested: vi.fn(async () => true),
}));
import { emitLoginOtpRequested, emitUserLoggedIn } from "../src/lib/events";
const mockOtpEmit = vi.mocked(emitLoginOtpRequested);
const mockLoginEmit = vi.mocked(emitUserLoggedIn);

const lastCode = () => mockOtpEmit.mock.calls.at(-1)![0].otp;
const wrongCode = (code: string) => (code === "000000" ? "111111" : "000000");

const start = (email: string, clientId: string, password = PASSWORD) =>
  api.post("/api/v1/auth/email/login").send({ email, password, clientId });
const verify = (challengeId: string, otp: string, clientId: string) =>
  api.post("/api/v1/auth/email/login/verify").send({ challengeId, otp, clientId });
const resend = (challengeId: string, clientId: string) =>
  api.post("/api/v1/auth/email/login/resend").send({ challengeId, clientId });

/** Let the resend cooldown pass without sleeping. */
const skipCooldown = (challengeId: string) =>
  prisma.loginChallenge.update({
    where: { id: challengeId },
    data: { lastSentAt: new Date(Date.now() - (env.loginOtp.resendCooldownSec + 1) * 1000) },
  });

async function newAccount(clientId = "patient-app") {
  const email = uniqueEmail("otp");
  const reg = await register({ email, password: PASSWORD, clientId });
  if (reg.body.status === "PENDING") {
    await prisma.user.update({ where: { id: reg.body.id }, data: { status: "ACTIVE" } });
  }
  return { email, userId: reg.body.id as string, clientId };
}

describe("email login OTP (second step)", () => {
  beforeEach(async () => {
    await resetDb();
    vi.clearAllMocks();
    mockOtpEmit.mockImplementation(async () => true);
  });

  it("password step returns 202 with a challenge - no tokens, no cookie - and emails a code", async () => {
    const { email, userId } = await newAccount("patient-portal");
    const res = await start(email, "patient-portal");

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ otpRequired: true, codeLength: 6 });
    expect(res.body.challengeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.email).toMatch(/^ot\*\*\*@example\.test$/);
    expect(res.body.accessToken).toBeUndefined();
    expect(res.headers["set-cookie"]).toBeUndefined();

    expect(mockOtpEmit).toHaveBeenCalledTimes(1);
    const event = mockOtpEmit.mock.calls[0][0];
    expect(event).toMatchObject({ userId, email, portalName: expect.any(String) });
    expect(event.otp).toMatch(/^\d{6}$/);

    // Only the hash is stored.
    const row = await prisma.loginChallenge.findUniqueOrThrow({ where: { id: res.body.challengeId } });
    expect(row.codeHash).not.toContain(event.otp);
    expect(mockLoginEmit).not.toHaveBeenCalled(); // no "new sign-in" alert until the code is verified
  });

  it("native app: correct code -> 200 with access + refresh token in the body", async () => {
    const { email } = await newAccount("patient-app");
    const s = await start(email, "patient-app");

    const res = await verify(s.body.challengeId, lastCode(), "patient-app");
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.role).toBe("PATIENT");
    expect(mockLoginEmit).toHaveBeenCalledTimes(1);
  });

  it("web portal: correct code -> 200 with the refresh token as a cookie", async () => {
    const { email } = await newAccount("patient-portal");
    const s = await start(email, "patient-portal");

    const res = await verify(s.body.challengeId, lastCode(), "patient-portal");
    expect(res.status).toBe(200);
    expect(res.body.refreshToken).toBeUndefined();
    expect(readSetCookie(res, "refresh_token")).toBeTruthy();
  });

  it("service-provider-app works the same way (after approval)", async () => {
    const email = uniqueEmail("doc");
    const reg = await register({ email, password: PASSWORD, clientId: "service-provider-app", role: "DOCTOR" });
    await prisma.user.update({ where: { id: reg.body.id }, data: { status: "ACTIVE" } });

    const s = await start(email, "service-provider-app");
    expect(s.status).toBe(202);
    const res = await verify(s.body.challengeId, lastCode(), "service-provider-app");
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("DOCTOR");
  });

  it("wrong password never starts a challenge or sends a code", async () => {
    const { email } = await newAccount();
    const res = await start(email, "patient-app", "wrong-password");
    expect(res.status).toBe(401);
    expect(mockOtpEmit).not.toHaveBeenCalled();
    expect(await prisma.loginChallenge.count()).toBe(0);
  });

  it("PENDING accounts are still refused at the password step, before any code", async () => {
    const email = uniqueEmail("pending");
    await register({ email, password: PASSWORD, clientId: "service-provider-app", role: "DOCTOR" });
    const res = await start(email, "service-provider-app");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("PENDING_APPROVAL");
    expect(mockOtpEmit).not.toHaveBeenCalled();
  });

  it("wrong code -> 400 with attempts left; locks after the max even for the right code", async () => {
    const { email } = await newAccount();
    const s = await start(email, "patient-app");
    const code = lastCode();
    const max = env.loginOtp.maxAttempts;

    for (let i = 1; i <= max; i++) {
      const r = await verify(s.body.challengeId, wrongCode(code), "patient-app");
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("INVALID_LOGIN_CODE");
      if (i < max) expect(r.body.error.message).toContain(`${max - i} attempt`);
    }

    const locked = await verify(s.body.challengeId, code, "patient-app");
    expect(locked.status).toBe(400);
    expect(locked.body.error.code).toBe("INVALID_LOGIN_CODE");
    expect(locked.body.error.message).toMatch(/log in again/i);
  });

  it("a code is single-use", async () => {
    const { email } = await newAccount();
    const s = await start(email, "patient-app");
    const code = lastCode();

    expect((await verify(s.body.challengeId, code, "patient-app")).status).toBe(200);
    const again = await verify(s.body.challengeId, code, "patient-app");
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("LOGIN_CHALLENGE_INVALID");
  });

  it("parallel verifies with the right code yield exactly one session", async () => {
    const { email } = await newAccount();
    const s = await start(email, "patient-app");
    const code = lastCode();

    const results = await Promise.all([1, 2, 3].map(() => verify(s.body.challengeId, code, "patient-app")));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await prisma.session.count()).toBe(1);
  });

  it("an expired code is rejected", async () => {
    const { email } = await newAccount();
    const s = await start(email, "patient-app");
    await prisma.loginChallenge.update({ where: { id: s.body.challengeId }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await verify(s.body.challengeId, lastCode(), "patient-app");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("LOGIN_CHALLENGE_INVALID");
  });

  it("a challenge only works on the portal it was started on", async () => {
    const { email } = await newAccount("patient-app");
    const s = await start(email, "patient-app");

    const res = await verify(s.body.challengeId, lastCode(), "patient-portal");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("LOGIN_CHALLENGE_INVALID");
  });

  it("an account disabled between the two steps can't finish logging in", async () => {
    const { email, userId } = await newAccount();
    const s = await start(email, "patient-app");
    await prisma.user.update({ where: { id: userId }, data: { status: "DISABLED" } });

    const res = await verify(s.body.challengeId, lastCode(), "patient-app");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCOUNT_DISABLED");
    expect(await prisma.session.count()).toBe(0);
  });

  it("validates the body (6-digit code, uuid challengeId)", async () => {
    const r1 = await verify("not-a-uuid", "123456", "patient-app");
    expect(r1.status).toBe(400);
    const r2 = await verify("8f14e45f-ceea-4e7a-9f3b-2b6b7c9d0e1f", "12ab56", "patient-app");
    expect(r2.status).toBe(400);
  });

  it("returns 503 and leaves no challenge behind when the code can't be sent", async () => {
    const { email } = await newAccount();
    mockOtpEmit.mockRejectedValueOnce(new Error("broker down"));

    const res = await start(email, "patient-app");
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(await prisma.loginChallenge.count()).toBe(0);
  });

  describe("resend", () => {
    it("is refused during the cooldown", async () => {
      const { email } = await newAccount();
      const s = await start(email, "patient-app");

      const res = await resend(s.body.challengeId, "patient-app");
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe("LOGIN_CODE_RESEND_TOO_SOON");
    });

    it("after the cooldown sends a new code; the new one works and the old one doesn't", async () => {
      const { email } = await newAccount();
      const s = await start(email, "patient-app");
      const oldCode = lastCode();
      await skipCooldown(s.body.challengeId);

      const r = await resend(s.body.challengeId, "patient-app");
      expect(r.status).toBe(202);
      expect(r.body.challengeId).toBe(s.body.challengeId);
      expect(mockOtpEmit).toHaveBeenCalledTimes(2);
      let newCode = lastCode();
      // 1-in-a-million chance the fresh code equals the old one; regenerate if so.
      while (newCode === oldCode) {
        await skipCooldown(s.body.challengeId);
        await resend(s.body.challengeId, "patient-app");
        newCode = lastCode();
      }

      expect((await verify(s.body.challengeId, oldCode, "patient-app")).status).toBe(400);
      expect((await verify(s.body.challengeId, newCode, "patient-app")).status).toBe(200);
    });

    it("stops after the per-challenge send limit", async () => {
      const { email } = await newAccount();
      const s = await start(email, "patient-app");

      for (let sent = 1; sent < env.loginOtp.maxSendsPerChallenge; sent++) {
        await skipCooldown(s.body.challengeId);
        expect((await resend(s.body.challengeId, "patient-app")).status).toBe(202);
      }
      await skipCooldown(s.body.challengeId);
      const res = await resend(s.body.challengeId, "patient-app");
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe("LOGIN_CODE_RESEND_LIMIT");
    });

    it("restores the previous code if the new one can't be sent", async () => {
      const { email } = await newAccount();
      const s = await start(email, "patient-app");
      const oldCode = lastCode();
      await skipCooldown(s.body.challengeId);
      mockOtpEmit.mockRejectedValueOnce(new Error("broker down"));

      expect((await resend(s.body.challengeId, "patient-app")).status).toBe(503);
      expect((await verify(s.body.challengeId, oldCode, "patient-app")).status).toBe(200);
    });
  });

  it("caps codes emailed to one account per window (no mail-bombing via repeated logins)", async () => {
    const { email } = await newAccount();
    for (let i = 0; i < env.loginOtp.maxSendsPerUserWindow; i++) {
      expect((await start(email, "patient-app")).status).toBe(202);
    }
    const res = await start(email, "patient-app");
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("LOGIN_CODE_LIMIT");
  });

  describe("LOGIN_OTP_ENABLED=false (kill switch)", () => {
    beforeEach(() => {
      env.loginOtp.enabled = false;
    });
    afterEach(() => {
      env.loginOtp.enabled = true;
    });

    it("issues tokens straight from the password step", async () => {
      const { email } = await newAccount();
      const res = await start(email, "patient-app");
      expect(res.status).toBe(200);
      expect(res.body.accessToken).toBeTruthy();
      expect(mockOtpEmit).not.toHaveBeenCalled();
    });
  });
});
