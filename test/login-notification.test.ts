import { describe, it, expect, beforeEach, vi } from "vitest";
import { api, register, login, resetDb, uniqueEmail, PASSWORD } from "./helpers";

// Capture the login event instead of publishing to Kafka.
vi.mock("../src/lib/events", () => ({
  AUTH_EVENTS_TOPIC: "auth.events",
  emitPasswordResetRequested: vi.fn(async () => {}),
  emitUserLoggedIn: vi.fn(async () => {}),
  emitLoginOtpRequested: vi.fn(async () => true),
}));
import { emitUserLoggedIn } from "../src/lib/events";
const mockEmit = vi.mocked(emitUserLoggedIn);

vi.mock("../src/lib/googleOAuth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/googleOAuth")>();
  return { ...actual, verifyGoogleIdToken: vi.fn() };
});
import { verifyGoogleIdToken } from "../src/lib/googleOAuth";
const mockVerify = vi.mocked(verifyGoogleIdToken);

describe("login notification (UserLoggedIn event)", () => {
  beforeEach(async () => {
    await resetDb();
    vi.clearAllMocks();
  });

  it("emits UserLoggedIn after a successful email/password login", async () => {
    const email = uniqueEmail("alert");
    await register({ email, password: PASSWORD, clientId: "patient-app" });
    mockEmit.mockClear();

    const res = await login({ email, password: PASSWORD, clientId: "patient-app" });
    expect(res.status).toBe(200);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit.mock.calls[0][0]).toMatchObject({
      email,
      role: "PATIENT",
      portalId: "patient-app",
      method: "PASSWORD",
    });
  });

  it("does not emit on a failed login", async () => {
    const email = uniqueEmail("alert");
    await register({ email, password: PASSWORD, clientId: "patient-app" });
    mockEmit.mockClear();

    const res = await login({ email, password: "wrong-password", clientId: "patient-app" });
    expect(res.status).toBe(401);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it("emits UserLoggedIn with method GOOGLE for a Google login", async () => {
    const email = uniqueEmail("g");
    mockVerify.mockResolvedValue({ sub: `g-${Date.now()}`, email, email_verified: true } as never);

    const res = await api.post("/api/v1/auth/google/native").send({ idToken: "x", clientId: "patient-app" });
    expect(res.status).toBe(200);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit.mock.calls[0][0]).toMatchObject({ email, method: "GOOGLE", portalId: "patient-app" });
  });
});
