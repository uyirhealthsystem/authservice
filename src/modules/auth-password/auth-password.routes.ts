import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler";
import { forgotSchema, resetSchema } from "./auth-password.schemas";
import { requestPasswordReset, resetPassword } from "./auth-password.service";
import { authAttemptLimiter } from "../../middleware/rateLimit";

export const authPasswordRouter = Router();

// Start a reset. One flow for two cases: a Google-first user setting their
// first password, and a user who forgot theirs. Always 202 - the response
// never reveals whether the email has an account.
authPasswordRouter.post(
  "/password/forgot",
  authAttemptLimiter,
  asyncHandler(async (req, res) => {
    const { email, clientId } = forgotSchema.parse(req.body);
    await requestPasswordReset(email, clientId);
    res.status(202).json({
      message: "If an account exists for that email, a code has been sent.",
    });
  }),
);

// Redeem the emailed code and set the new password. Revokes every existing
// session for the account.
authPasswordRouter.post(
  "/password/reset",
  authAttemptLimiter,
  asyncHandler(async (req, res) => {
    const { email, otp, password } = resetSchema.parse(req.body);
    await resetPassword(email, otp, password);
    res.status(204).send();
  }),
);
