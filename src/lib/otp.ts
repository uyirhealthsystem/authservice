import { randomInt, createHash, timingSafeEqual } from "crypto";

// Numeric one-time code emailed for the forgot/reset-password flow. Only its
// SHA-256 hash is persisted (mirrors src/lib/refreshToken.ts - the raw value
// never lives in the DB). Zero-padded to always be 6 digits.
export function generateOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function hashOtp(otp: string): string {
  return createHash("sha256").update(otp).digest("hex");
}

// How long a code stays valid. Short - it's emailed in the clear and typed in
// by hand rather than clicked.
export const OTP_TTL_MIN = 10;

// Constant-time check of a presented code against a stored hash, so response
// timing can't be used to learn how much of a guess was right.
export function otpMatches(otp: string, storedHash: string): boolean {
  const a = Buffer.from(hashOtp(otp), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
