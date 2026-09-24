import { describe, it, expect, beforeEach, vi } from "vitest";
import { api, register, login, resetDb, uniqueEmail, PASSWORD } from "./helpers";
import { prisma } from "../src/lib/prisma";
import { hashOtp } from "../src/lib/otp";

// Capture emitted domain events instead of publishing to Kafka. The raw OTP
// only exists in the event payload (the DB stores just its hash), so this
// mock is also how the test gets a usable code.
vi.mock("../src/lib/events", () => ({
  AUTH_EVENTS_TOPIC: "auth.events",
  emitPasswordResetRequested: vi.fn(async () => {}),
}));
import { emitPasswordResetRequested } from "../src/lib/events";
const mockEmit = vi.mocked(emitPasswordResetRequested);

// Stub Google ID-token verification (same pattern as google-native.test.ts).
vi.mock("../src/lib/googleOAuth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/googleOAuth")>();
  return { ...actual, verifyGoogleIdToken: vi.fn() };
});
import { verifyGoogleIdToken } from "../src/lib/googleOAuth";
const mockVerify = vi.mocked(verifyGoogleIdToken);

const forgot = (email: string, clientId = "patient-portal") =>
  api.post("/api/v1/auth/password/forgot").send({ email, clientId });

const reset = (email: string, otp: string, password: string) =>
  api.post("/api/v1/auth/password/reset").send({ email, otp, password });

/** Pull the raw OTP out of the most recent emitted PasswordResetRequested. */
function lastEmittedOtp(): string {
  const call = mockEmit.mock.calls.at(-1);
  if (!call) throw new Error("no PasswordResetRequested event was emitted");
  return call[0].otp;
}

/** A Google-first patient account (ACTIVE, has email, no password). */
async function googleFirstUser(email: string) {
  mockVerify.mockResolvedValue({ sub: `sub-${email}`, email, email_verified: true });
  const res = await api.post("/api/v1/auth/google/native").send({ idToken: "fake", clientId: "patient-app" });
  if (res.status !== 200) throw new Error(`google login failed: ${JSON.stringify(res.body)}`);
  return res.body as { accessToken: string; refreshToken: string };
}

describe("POST /api/v1/auth/password/forgot + /api/v1/auth/password/reset", () => {
  beforeEach(() => {
    mockEmit.mockClear();
    mockVerify.mockReset();
    return resetDb();
  });

  it("Google-first user: forgot emits an event and reset sets their first password", async () => {
    const email = uniqueEmail("g-forgot");
    await googleFirstUser(email);

    const f = await forgot(email);
    expect(f.status).toBe(202);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit.mock.calls[0][0]).toMatchObject({ email });

    const rows = await prisma.passwordResetToken.findMany();
    expect(rows).toHaveLength(1);

    const r = await reset(email, lastEmittedOtp(), "brand-new-pass-1");
    expect(r.status).toBe(204);

    // PASSWORD identity now exists and logs in
    const li = await login({ email, password: "brand-new-pass-1", clientId: "patient-app" });
    expect(li.status).toBe(200);
    expect(li.body.role).toBe("PATIENT");

    const user = await prisma.user.findUniqueOrThrow({ where: { email }, include: { identities: true } });
    expect(user.identities.map((i) => i.provider).sort()).toEqual(["GOOGLE", "PASSWORD"]);
    expect((await prisma.passwordResetToken.findFirstOrThrow()).usedAt).not.toBeNull();
  });

  it("forgot password for an existing password account replaces the hash", async () => {
    const email = uniqueEmail("pw-forgot");
    await register({ email, password: PASSWORD, clientId: "patient-portal" });

    await forgot(email);
    const r = await reset(email, lastEmittedOtp(), "the-new-one-2");
    expect(r.status).toBe(204);

    const oldPw = await login({ email, password: PASSWORD, clientId: "patient-portal" });
    expect(oldPw.status).toBe(401);
    const newPw = await login({ email, password: "the-new-one-2", clientId: "patient-portal" });
    expect(newPw.status).toBe(200);
  });

  it("unknown email: 202 but no event, no token row", async () => {
    const f = await forgot(uniqueEmail("nobody"));
    expect(f.status).toBe(202);
    expect(mockEmit).not.toHaveBeenCalled();
    expect(await prisma.passwordResetToken.count()).toBe(0);
  });

  it("rejects an unknown email (400 INVALID_RESET_CODE)", async () => {
    const r = await reset(uniqueEmail("no-such-account"), "123456", "whatever-pass-9");
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("INVALID_RESET_CODE");
  });

  it("rejects a wrong code for a real account (400 INVALID_RESET_CODE)", async () => {
    const email = uniqueEmail("wrong-code");
    await register({ email, password: PASSWORD, clientId: "patient-portal" });
    await forgot(email);

    const r = await reset(email, "000000", "whatever-pass-9");
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("INVALID_RESET_CODE");
  });

  it("rejects a reused code (400 on the second redemption)", async () => {
    const email = uniqueEmail("reuse");
    await register({ email, password: PASSWORD, clientId: "patient-portal" });
    await forgot(email);
    const otp = lastEmittedOtp();

    expect((await reset(email, otp, "first-time-pass-3")).status).toBe(204);
    const second = await reset(email, otp, "second-time-pass-4");
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe("INVALID_RESET_CODE");
  });

  it("rejects an expired code", async () => {
    const email = uniqueEmail("expired");
    const reg = await register({ email, password: PASSWORD, clientId: "patient-portal" });

    const raw = "654321";
    await prisma.passwordResetToken.create({
      data: {
        userId: reg.body.id,
        codeHash: hashOtp(raw),
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    const r = await reset(email, raw, "should-not-work-5");
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("INVALID_RESET_CODE");
  });

  it("reset revokes every existing session", async () => {
    const email = uniqueEmail("revoke");
    const { refreshToken } = await googleFirstUser(email);

    await forgot(email);
    expect((await reset(email, lastEmittedOtp(), "post-reset-pass-6")).status).toBe(204);

    // the session that existed before the reset can no longer refresh
    const refreshed = await api.post("/api/v1/auth/token/refresh").send({ refreshToken });
    expect(refreshed.status).toBe(403);
  });

  it("also invalidates sibling codes", async () => {
    const email = uniqueEmail("siblings");
    await register({ email, password: PASSWORD, clientId: "patient-portal" });

    await forgot(email);
    const first = lastEmittedOtp();
    await forgot(email);
    const second = lastEmittedOtp();

    expect((await reset(email, second, "redeemed-pass-7")).status).toBe(204);
    // the earlier code is now dead too
    expect((await reset(email, first, "too-late-pass-8")).status).toBe(400);
  });
});
