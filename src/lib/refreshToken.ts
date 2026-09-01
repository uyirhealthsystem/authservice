import { randomBytes, createHash } from "crypto";

// Opaque bearer value handed to the client; only its SHA-256 hash is ever
// persisted, mirroring the OTP/password pattern - the raw secret never lives
// in the DB.
export function generateRefreshToken() {
  return randomBytes(32).toString("base64url");
}

export function hashRefreshToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
