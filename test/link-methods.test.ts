import { describe, it, expect, beforeEach, vi } from "vitest";
import { api, register, login, resetDb, uniqueEmail, PASSWORD } from "./helpers";
import { prisma } from "../src/lib/prisma";

// Same googleOAuth stub as google-native.test.ts: only the ID-token
// verification is faked; find-or-create / link / session code is real.
vi.mock("../src/lib/googleOAuth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/googleOAuth")>();
  return { ...actual, verifyGoogleIdToken: vi.fn() };
});
import { verifyGoogleIdToken } from "../src/lib/googleOAuth";
const mockVerify = vi.mocked(verifyGoogleIdToken);

const googleNative = (clientId: string, opts?: { role?: string }) =>
  api.post("/api/v1/auth/google/native").send({ idToken: "fake", clientId, ...opts });

// The Google-first -> add-a-password direction now goes through the
// forgot/reset flow (see test/password-reset.test.ts). This file covers the
// other direction and the registration guard.
describe("email/password <-> Google on the same account", () => {
  beforeEach(() => {
    mockVerify.mockReset();
    return resetDb();
  });

  it("password first, then Google: one account, both methods work", async () => {
    const email = uniqueEmail("pw-first");
    const reg = await register({ email, password: PASSWORD, clientId: "patient-app" });

    mockVerify.mockResolvedValue({ sub: "sub-pw-first", email, email_verified: true });
    const g = await googleNative("patient-app");
    expect(g.status).toBe(200);

    // still logs in with the password too
    const li = await login({ email, password: PASSWORD, clientId: "patient-app" });
    expect(li.status).toBe(200);

    const identities = await prisma.identity.findMany({ where: { userId: reg.body.id } });
    expect(identities.map((i) => i.provider).sort()).toEqual(["GOOGLE", "PASSWORD"]);
  });

  it("a Google-first account can't be re-registered with a password (409 EMAIL_TAKEN)", async () => {
    const email = uniqueEmail("re-reg");
    mockVerify.mockResolvedValue({ sub: "sub-re-reg", email, email_verified: true });
    await googleNative("patient-app");

    const reg = await register({ email, password: PASSWORD, clientId: "patient-app" });
    expect(reg.status).toBe(409);
    expect(reg.body.error.code).toBe("CONFLICT_EMAIL_TAKEN");
  });
});
