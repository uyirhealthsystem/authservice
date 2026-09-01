import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../src/lib/prisma";
import { register, login, resetDb, uniqueEmail, PASSWORD } from "./helpers";

describe("POST /auth/email/login", () => {
  beforeEach(resetDb);

  it("returns an access token + refresh cookie for a web portal", async () => {
    const email = uniqueEmail("web");
    await register({ email, password: PASSWORD, clientId: "patient-portal" });

    const res = await login({ email, password: PASSWORD, clientId: "patient-portal" });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.role).toBe("PATIENT");
    expect(res.body.refreshToken).toBeUndefined(); // web keeps it in the cookie

    const cookie = res.cookies;
    expect(cookie).toMatch(/refresh_token=/);
  });

  it("returns the refresh token in the body for a native app portal", async () => {
    const email = uniqueEmail("app");
    await register({ email, password: PASSWORD, clientId: "patient-app" });

    const res = await login({ email, password: PASSWORD, clientId: "patient-app" });
    expect(res.status).toBe(200);
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.cookies).toBe(""); // native gets no cookie
  });

  it("rejects a wrong password (401 INVALID_CREDENTIALS)", async () => {
    const email = uniqueEmail();
    await register({ email, password: PASSWORD, clientId: "patient-portal" });

    const res = await login({ email, password: "wrong-password", clientId: "patient-portal" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("rejects an unknown email with the same 401 (no user enumeration)", async () => {
    const res = await login({ email: uniqueEmail(), password: PASSWORD, clientId: "patient-portal" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("rejects a PENDING account with 403 PENDING_APPROVAL", async () => {
    const email = uniqueEmail("pending");
    await register({ email, password: PASSWORD, clientId: "service-provider-app", role: "DOCTOR" });

    const res = await login({ email, password: PASSWORD, clientId: "service-provider-app" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("PENDING_APPROVAL");
  });

  it("rejects a DISABLED account with 403 ACCOUNT_DISABLED", async () => {
    const email = uniqueEmail("disabled");
    const reg = await register({ email, password: PASSWORD, clientId: "patient-portal" });
    await prisma.user.update({ where: { id: reg.body.id }, data: { status: "DISABLED" } });

    const res = await login({ email, password: PASSWORD, clientId: "patient-portal" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCOUNT_DISABLED");
  });

  it("rejects login through a portal that does not serve the account's role (cross-portal)", async () => {
    // Registered as a PATIENT, tries to sign in at the service-provider app.
    const email = uniqueEmail("cross");
    await register({ email, password: PASSWORD, clientId: "patient-portal" });

    const res = await login({ email, password: PASSWORD, clientId: "service-provider-app" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("the same account works across an app and its web sibling as separate sessions", async () => {
    const email = uniqueEmail("shared");
    await register({ email, password: PASSWORD, clientId: "patient-app" });

    const onApp = await login({ email, password: PASSWORD, clientId: "patient-app" });
    const onWeb = await login({ email, password: PASSWORD, clientId: "patient-portal" });

    expect(onApp.status).toBe(200);
    expect(onWeb.status).toBe(200);
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, include: { sessions: true } });
    expect(user.sessions.map((s) => s.portalId).sort()).toEqual(["patient-app", "patient-portal"]);
  });

  it("updates lastLoginAt", async () => {
    const email = uniqueEmail();
    const reg = await register({ email, password: PASSWORD, clientId: "patient-portal" });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: reg.body.id } })).lastLoginAt).toBeNull();

    await login({ email, password: PASSWORD, clientId: "patient-portal" });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: reg.body.id } })).lastLoginAt).not.toBeNull();
  });

  it("does not set a refresh cookie on a failed login", async () => {
    const email = uniqueEmail();
    await register({ email, password: PASSWORD, clientId: "patient-portal" });
    const res = await login({ email, password: "nope", clientId: "patient-portal" });
    expect(res.cookies).not.toMatch(/refresh_token=/);
  });
});
