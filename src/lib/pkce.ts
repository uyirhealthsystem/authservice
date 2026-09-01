import { randomBytes, createHash } from "crypto";

export function generateCodeVerifier() {
  return randomBytes(32).toString("base64url");
}

export function codeChallengeFromVerifier(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function generateState() {
  return randomBytes(16).toString("base64url");
}
