import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SuperTest, Test } from "supertest";

// The rest of the suite runs with the limiter effectively disabled
// (AUTH_RATE_LIMIT_MAX huge). This file builds its own app instance with a
// low limit to prove the brute-force guard actually fires. vitest isolates
// module state per test file, so this does not leak.
describe("auth attempt rate limiting", () => {
  let api: SuperTest<Test>;
  let disconnect: () => Promise<void>;

  beforeAll(async () => {
    process.env.AUTH_RATE_LIMIT_MAX = "3";
    process.env.AUTH_RATE_LIMIT_WINDOW_MS = "60000";
    const supertest = (await import("supertest")).default;
    const { app } = await import("../src/app");
    const { prisma } = await import("../src/lib/prisma");
    api = supertest(app) as unknown as SuperTest<Test>;
    disconnect = () => prisma.$disconnect();
  });

  afterAll(async () => {
    process.env.AUTH_RATE_LIMIT_MAX = "100000";
    await disconnect();
  });

  it("returns 429 RATE_LIMITED once the per-window limit is exceeded", async () => {
    const body = { email: "ratelimit@example.test", password: "whatever", clientId: "patient-portal" };

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await api.post("/auth/email/login").send(body)).status);
    }

    // First few get the normal 401; later ones are blocked.
    expect(statuses.slice(0, 3)).not.toContain(429);
    expect(statuses).toContain(429);

    const blocked = await api.post("/auth/email/login").send(body);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
  });
});
