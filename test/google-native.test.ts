import { describe, it, expect, beforeEach, vi } from "vitest";
import { api, register, resetDb, uniqueEmail, PASSWORD } from "./helpers";
import { prisma } from "../src/lib/prisma";

// The Google ID-token verification talks to Google's JWKS. Stub just that one
// function; everything downstream (find-or-create, portal/role checks,
// session issue) is the real code path.
vi.mock("../src/lib/googleOAuth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/googleOAuth")>();
  return { ...actual, verifyGoogleIdToken: vi.fn() };
});

import { verifyGoogleIdToken } from "../src/lib/googleOAuth";
const mockVerify = vi.mocked(verifyGoogleIdToken);

describe("POST /auth/google/native", () => {
  beforeEach(() => {
    mockVerify.mockReset();
    return resetDb();
  });

  it("creates a new patient account from a verified Google identity", async () => {
    mockVerify.mockResolvedValue({ sub: "google-sub-1", email: uniqueEmail("g"), email_verified: true });

    const res = await api
      .post("/auth/google/native")
      .send({ idToken: "fake", clientId: "patient-app" });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.role).toBe("PATIENT");
  });

  it("links to an existing password account when the Google email is verified", async () => {
    const email = uniqueEmail("link");
    const reg = await register({ email, password: PASSWORD, clientId: "patient-app" });
    mockVerify.mockResolvedValue({ sub: "google-sub-2", email, email_verified: true });

    const res = await api.post("/auth/google/native").send({ idToken: "fake", clientId: "patient-app" });
    expect(res.status).toBe(200);

    const identities = await prisma.identity.findMany({ where: { userId: reg.body.id } });
    expect(identities.map((i) => i.provider).sort()).toEqual(["GOOGLE", "PASSWORD"]);
  });

  it("rejects a web portal clientId (400 NOT_A_NATIVE_CLIENT)", async () => {
    mockVerify.mockResolvedValue({ sub: "google-sub-3", email: uniqueEmail(), email_verified: true });
    const res = await api.post("/auth/google/native").send({ idToken: "fake", clientId: "patient-portal" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("NOT_A_NATIVE_CLIENT");
  });

  it("a fresh service-provider Google signup is PENDING and cannot get a session yet", async () => {
    mockVerify.mockResolvedValue({ sub: "google-sub-4", email: uniqueEmail("sp"), email_verified: true });
    const res = await api
      .post("/auth/google/native")
      .send({ idToken: "fake", clientId: "service-provider-app", role: "DOCTOR" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("PENDING_APPROVAL");
  });
});
