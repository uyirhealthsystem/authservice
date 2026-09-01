import { describe, it, expect, beforeEach } from "vitest";
import { api, register, login, resetDb, uniqueEmail, PASSWORD, activeUserAccessToken } from "./helpers";

describe("admin approval API", () => {
  beforeEach(resetDb);

  it("the whole lifecycle: register PENDING -> can't log in -> approved -> can log in", async () => {
    const superToken = (await activeUserAccessToken({ clientId: "superadmin-portal" })).accessToken;

    const docEmail = uniqueEmail("doc");
    const reg = await register({
      email: docEmail,
      password: PASSWORD,
      clientId: "service-provider-app",
      role: "DOCTOR",
    });
    expect(reg.body.status).toBe("PENDING");

    const blocked = await login({ email: docEmail, password: PASSWORD, clientId: "service-provider-app" });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("PENDING_APPROVAL");

    const pending = await api.get("/admin/users/pending").set("Authorization", `Bearer ${superToken}`);
    expect(pending.status).toBe(200);
    expect(pending.body.users.map((u: { id: string }) => u.id)).toContain(reg.body.id);

    const approve = await api
      .post(`/admin/users/${reg.body.id}/approve`)
      .set("Authorization", `Bearer ${superToken}`);
    expect(approve.status).toBe(200);
    expect(approve.body.user).toMatchObject({ status: "ACTIVE" });
    expect(approve.body.user.approvedAt).toBeTruthy();

    const ok = await login({ email: docEmail, password: PASSWORD, clientId: "service-provider-app" });
    expect(ok.status).toBe(200);
    expect(ok.body.role).toBe("DOCTOR");
  });

  it("reject sets the account DISABLED", async () => {
    const superToken = (await activeUserAccessToken({ clientId: "superadmin-portal" })).accessToken;
    const reg = await register({
      email: uniqueEmail("rej"),
      password: PASSWORD,
      clientId: "service-provider-app",
      role: "HOSPITAL",
    });

    const res = await api
      .post(`/admin/users/${reg.body.id}/reject`)
      .set("Authorization", `Bearer ${superToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.status).toBe("DISABLED");
  });

  it("requires an ADMIN / SUPER_ADMIN token", async () => {
    const patientToken = (await activeUserAccessToken({ clientId: "patient-portal" })).accessToken;

    expect((await api.get("/admin/users/pending")).status).toBe(401);
    expect(
      (await api.get("/admin/users/pending").set("Authorization", `Bearer ${patientToken}`)).status,
    ).toBe(403);
  });

  it("an ADMIN cannot see or approve another ADMIN - only a SUPER_ADMIN can", async () => {
    const superToken = (await activeUserAccessToken({ clientId: "superadmin-portal" })).accessToken;

    // admin1 gets approved by the super admin and logs in.
    const admin1 = await register({ email: uniqueEmail("a1"), password: PASSWORD, clientId: "admin-portal" });
    await api.post(`/admin/users/${admin1.body.id}/approve`).set("Authorization", `Bearer ${superToken}`);
    const admin1Token = (
      await login({ email: admin1.body.email, password: PASSWORD, clientId: "admin-portal" })
    ).body.accessToken;

    // admin2 is still PENDING.
    const admin2 = await register({ email: uniqueEmail("a2"), password: PASSWORD, clientId: "admin-portal" });

    // admin1's pending queue hides admin2 (an ADMIN row it can't action).
    const queue = await api.get("/admin/users/pending").set("Authorization", `Bearer ${admin1Token}`);
    expect(queue.body.users.map((u: { id: string }) => u.id)).not.toContain(admin2.body.id);

    // ...and a direct approve attempt is forbidden.
    const attempt = await api
      .post(`/admin/users/${admin2.body.id}/approve`)
      .set("Authorization", `Bearer ${admin1Token}`);
    expect(attempt.status).toBe(403);

    // The super admin can.
    const ok = await api
      .post(`/admin/users/${admin2.body.id}/approve`)
      .set("Authorization", `Bearer ${superToken}`);
    expect(ok.status).toBe(200);
  });

  it("approving a non-PENDING user is a 400", async () => {
    const superToken = (await activeUserAccessToken({ clientId: "superadmin-portal" })).accessToken;
    const reg = await register({
      email: uniqueEmail("dbl"),
      password: PASSWORD,
      clientId: "service-provider-app",
      role: "LS",
    });
    await api.post(`/admin/users/${reg.body.id}/approve`).set("Authorization", `Bearer ${superToken}`);

    const again = await api
      .post(`/admin/users/${reg.body.id}/approve`)
      .set("Authorization", `Bearer ${superToken}`);
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("NOT_PENDING");
  });

  it("approving an unknown user id is a 404", async () => {
    const superToken = (await activeUserAccessToken({ clientId: "superadmin-portal" })).accessToken;
    const res = await api
      .post(`/admin/users/00000000-0000-0000-0000-000000000000/approve`)
      .set("Authorization", `Bearer ${superToken}`);
    expect(res.status).toBe(404);
  });
});
