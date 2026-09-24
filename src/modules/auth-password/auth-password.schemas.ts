import { z } from "zod";

// POST /api/v1/auth/password/forgot - start a reset. Always answered with 202
// regardless of whether the email exists (no account enumeration).
export const forgotSchema = z.object({
  email: z.string().email(),
  clientId: z.string().min(1, "clientId (portal) is required."),
});

// POST /api/v1/auth/password/reset - redeem the emailed OTP and set a new password.
// Works whether or not the account already had one (a Google-first user is
// setting their first password here).
export const resetSchema = z.object({
  email: z.string().email(),
  otp: z.string().length(6, "Code must be 6 digits."),
  password: z.string().min(8, "Password must be at least 8 characters."),
});
