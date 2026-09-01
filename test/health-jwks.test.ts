import { describe, it, expect, beforeEach } from "vitest";
import { createLocalJWKSet, jwtVerify } from "jose";
import { api, resetDb, activeUserAccessToken } from "./helpers";

describe("infrastructure endpoints", () => {
  beforeEach(resetDb);

  it("GET /health reports ok when the database is reachable", async () => {
    const res = await api.get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("unknown routes return a structured 404", async () => {
    const res = await api.get("/does/not/exist");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("GET /.well-known/jwks.json publishes at least one RS256 signing key", async () => {
    const res = await api.get("/.well-known/jwks.json");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.keys)).toBe(true);
    expect(res.body.keys.length).toBeGreaterThan(0);
    const [key] = res.body.keys;
    expect(key).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig" });
    expect(key.kid).toBeTruthy();
    expect(key.d).toBeUndefined(); // never leak the private component
  });

  it("an issued access token verifies against the published JWKS", async () => {
    const { accessToken } = await activeUserAccessToken({ clientId: "patient-portal" });

    const jwks = createLocalJWKSet((await api.get("/.well-known/jwks.json")).body);
    const { payload } = await jwtVerify(accessToken, jwks, { audience: "patient-portal" });

    expect(payload.role).toBe("PATIENT");
    expect(payload.sub).toBeTruthy();
    expect(payload.aud).toBe("patient-portal");
  });
});
