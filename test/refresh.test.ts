import { describe, it, expect, beforeEach } from "vitest";
import { api, register, login, resetDb, uniqueEmail, PASSWORD, readSetCookie } from "./helpers";

// Refresh-token rotation + reuse detection is the core security-sensitive
// operation in the service (see session.service.ts). Test both transports.
describe("POST /auth/token/refresh - native (body) transport", () => {
  beforeEach(resetDb);

  async function nativeSession() {
    const email = uniqueEmail("nat");
    await register({ email, password: PASSWORD, clientId: "patient-app" });
    const li = await login({ email, password: PASSWORD, clientId: "patient-app" });
    return li.body as { accessToken: string; refreshToken: string };
  }

  it("rotates: the old token stops working, the new one works", async () => {
    const s = await nativeSession();

    const r1 = await api.post("/auth/token/refresh").send({ refreshToken: s.refreshToken });
    expect(r1.status).toBe(200);
    expect(r1.body.accessToken).toBeTruthy();
    expect(r1.body.refreshToken).toBeTruthy();
    expect(r1.body.refreshToken).not.toBe(s.refreshToken);

    // Old one is now ROTATED -> reuse path.
    const reused = await api.post("/auth/token/refresh").send({ refreshToken: s.refreshToken });
    expect(reused.status).toBe(403);
    expect(reused.body.error.code).toBe("FORBIDDEN");

    // ...and reuse revokes the whole session, so the freshly-minted token dies too.
    const afterReuse = await api.post("/auth/token/refresh").send({ refreshToken: r1.body.refreshToken });
    expect(afterReuse.status).toBe(403);
  });

  it("rejects a garbage token with 401", async () => {
    const res = await api.post("/auth/token/refresh").send({ refreshToken: "not-a-real-token" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("NOT_AUTHENTICATED");
  });

  it("rejects a missing token with 401", async () => {
    const res = await api.post("/auth/token/refresh").send({});
    expect(res.status).toBe(401);
  });

  it("logout revokes the session; the token can no longer refresh", async () => {
    const s = await nativeSession();

    const out = await api.post("/auth/logout").send({ refreshToken: s.refreshToken });
    expect(out.status).toBe(204);

    const res = await api.post("/auth/token/refresh").send({ refreshToken: s.refreshToken });
    expect(res.status).toBe(403); // session revoked -> reuse-detection path
  });

  it("logout-all revokes every session for the user", async () => {
    const email = uniqueEmail("all");
    await register({ email, password: PASSWORD, clientId: "patient-app" });
    const a = (await login({ email, password: PASSWORD, clientId: "patient-app" })).body;
    const b = (await login({ email, password: PASSWORD, clientId: "patient-app" })).body;

    const res = await api.post("/auth/logout-all").set("Authorization", `Bearer ${a.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.revokedSessions).toBe(2);

    for (const token of [a.refreshToken, b.refreshToken]) {
      expect((await api.post("/auth/token/refresh").send({ refreshToken: token })).status).toBe(403);
    }
  });

  it("logout-all requires a valid access token", async () => {
    expect((await api.post("/auth/logout-all")).status).toBe(401);
    expect(
      (await api.post("/auth/logout-all").set("Authorization", "Bearer garbage")).status,
    ).toBe(401);
  });
});

describe("POST /auth/token/refresh - web (cookie) transport", () => {
  beforeEach(resetDb);

  it("rotates via the httpOnly cookie and detects reuse of the old cookie", async () => {
    const email = uniqueEmail("web");
    await register({ email, password: PASSWORD, clientId: "patient-portal" });
    const li = await api.post("/auth/email/login").send({ email, password: PASSWORD, clientId: "patient-portal" });
    const first = readSetCookie(li, "refresh_token")!;
    expect(first).toBeTruthy();

    const r1 = await api.post("/auth/token/refresh").set("Cookie", `refresh_token=${first}`);
    expect(r1.status).toBe(200);
    expect(r1.body.accessToken).toBeTruthy();
    expect(r1.body.refreshToken).toBeUndefined(); // web response never echoes it
    const second = readSetCookie(r1, "refresh_token")!;
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);

    const reused = await api.post("/auth/token/refresh").set("Cookie", `refresh_token=${first}`);
    expect(reused.status).toBe(403);
  });
});
