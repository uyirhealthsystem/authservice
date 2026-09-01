import rateLimit from "express-rate-limit";
import { env } from "../lib/env";

// In-memory store: per-process only. A shared store (e.g. Redis) is needed
// before running more than one instance of this service. Limits come from
// env (AUTH_RATE_LIMIT_MAX / AUTH_RATE_LIMIT_WINDOW_MS) - see src/lib/env.ts.
export const authAttemptLimiter = rateLimit({
  windowMs: env.authRateLimit.windowMs,
  limit: env.authRateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many attempts, try again later." } },
});
