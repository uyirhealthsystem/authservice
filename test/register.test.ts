import { describe, it, expect, beforeEach } from "vitest";
import { api, register, resetDb, uniqueEmail, PASSWORD } from "./helpers";

describe("POST /auth/email/register", () => {
  beforeEach(resetDb);

  it("creates an ACTIVE patient account that can log in immediately", async () => {
    const email = uniqueEmail("patient");
    const { status, body } = await register({ email, password: PASSWORD, clientId: "patient-portal" });

    expect(status).toBe(201);
    expect(body).toMatchObject({ email, role: "PATIENT", status: "ACTIVE", pendingApproval: false });
    expect(body.id).toBeTruthy();
  });

  it("creates a PENDING service-provider account with the chosen role", async () => {
    const { status, body } = await register({
      email: uniqueEmail("doc"),
      password: PASSWORD,
      clientId: "service-provider-app",
      role: "DOCTOR",
    });

    expect(status).toBe(201);
    expect(body).toMatchObject({ role: "DOCTOR", status: "PENDING", pendingApproval: true });
  });

  it("rejects a second account with the same email (409)", async () => {
    const email = uniqueEmail("dupe");
    await register({ email, password: PASSWORD, clientId: "patient-portal" });
    const second = await register({ email, password: PASSWORD, clientId: "patient-portal" });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("CONFLICT_EMAIL_TAKEN");
  });

  it("rejects an unknown portal (400 UNKNOWN_PORTAL)", async () => {
    const { status, body } = await register({
      email: uniqueEmail(),
      password: PASSWORD,
      clientId: "ghost-portal",
    });
    expect(status).toBe(400);
    expect(body.error.code).toBe("UNKNOWN_PORTAL");
  });

  it("rejects service-provider registration with no role (400 ROLE_REQUIRED)", async () => {
    const { status, body } = await register({
      email: uniqueEmail(),
      password: PASSWORD,
      clientId: "service-provider-app",
    });
    expect(status).toBe(400);
    expect(body.error.code).toBe("ROLE_REQUIRED");
  });

  it("rejects a role the portal does not offer (400 ROLE_NOT_ALLOWED)", async () => {
    const { status, body } = await register({
      email: uniqueEmail(),
      password: PASSWORD,
      clientId: "service-provider-app",
      role: "PATIENT",
    });
    expect(status).toBe(400);
    expect(body.error.code).toBe("ROLE_NOT_ALLOWED");
  });

  it("creates a PENDING admin account via admin-portal password registration", async () => {
    const { status, body } = await register({
      email: uniqueEmail("admin"),
      password: PASSWORD,
      clientId: "admin-portal",
    });
    expect(status).toBe(201);
    expect(body).toMatchObject({ role: "ADMIN", status: "PENDING" });
  });

  it("validates the request body (400 VALIDATION_ERROR)", async () => {
    const res = await api
      .post("/auth/email/register")
      .send({ email: "not-an-email", password: "short", clientId: "patient-portal" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});
