import { describe, it, expect, beforeEach } from "vitest";
import { api, register, resetDb, uniqueEmail, PASSWORD, activeUserAccessToken } from "./helpers";

// The pre-/api/v1 paths are kept as aliases so un-updated clients keep
// working. Delete this file together with the legacy mounts in src/app.ts.
describe("legacy /auth and /admin aliases", () => {
  beforeEach(resetDb);

  it("old /auth paths still work, flagged Deprecation, cookie scoped to /auth", async () => {
    const email = uniqueEmail("legacy");
    const reg = await api
      .post("/auth/email/register")
      .send({ email, password: PASSWORD, clientId: "patient-portal" });
    expect(reg.status).toBe(201);
    expect(reg.headers["deprecation"]).toBe("true");

    const li = await api.post("/auth/email/login").send({ email, password: PASSWORD, clientId: "patient-portal" });
    expect(li.status).toBe(200);
    const setCookie = (li.headers["set-cookie"] as unknown as string[]).find((c) => c.startsWith("refresh_token="));
    expect(setCookie).toContain("Path=/auth;");
  });

  it("new paths are not flagged and scope the cookie to /api/v1/auth", async () => {
    const email = uniqueEmail("v1");
    await register({ email, password: PASSWORD, clientId: "patient-portal" });

    const li = await api
      .post("/api/v1/auth/email/login")
      .send({ email, password: PASSWORD, clientId: "patient-portal" });
    expect(li.status).toBe(200);
    expect(li.headers["deprecation"]).toBeUndefined();
    const setCookie = (li.headers["set-cookie"] as unknown as string[]).find((c) => c.startsWith("refresh_token="));
    expect(setCookie).toContain("Path=/api/v1/auth;");
  });

  it("old GET /admin/users/pending and POST /admin/users/:id/approve still work", async () => {
    const superToken = (await activeUserAccessToken({ clientId: "superadmin-portal" })).accessToken;
    const reg = await register({
      email: uniqueEmail("doc"),
      password: PASSWORD,
      clientId: "service-provider-app",
      role: "DOCTOR",
    });

    const pending = await api.get("/admin/users/pending").set("Authorization", `Bearer ${superToken}`);
    expect(pending.status).toBe(200);
    expect(pending.headers["deprecation"]).toBe("true");
    expect(pending.body.users.map((u: { id: string }) => u.id)).toContain(reg.body.id);

    const approve = await api
      .post(`/admin/users/${reg.body.id}/approve`)
      .set("Authorization", `Bearer ${superToken}`);
    expect(approve.status).toBe(200);
    expect(approve.body.user).toMatchObject({ status: "ACTIVE" });
  });

  it("the legacy admin alias still requires an admin token", async () => {
    const res = await api.get("/admin/users/pending");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/v1/auth/users", () => {
  beforeEach(resetDb);

  it("requires ?status=PENDING", async () => {
    const superToken = (await activeUserAccessToken({ clientId: "superadmin-portal" })).accessToken;
    const res = await api.get("/api/v1/auth/users").set("Authorization", `Bearer ${superToken}`);
    expect(res.status).toBe(400);
  });
});
