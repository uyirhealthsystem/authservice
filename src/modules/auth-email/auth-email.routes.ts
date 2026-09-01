import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler";
import { registerSchema, loginSchema, refreshSchema, logoutSchema } from "./auth-email.schemas";
import { registerWithEmail, loginWithEmail } from "./auth-email.service";
import {
  rotateRefreshToken,
  revokeSessionByRefreshToken,
  revokeAllSessionsForUser,
} from "../auth-shared/session.service";
import { setRefreshCookie, clearRefreshCookie } from "../../lib/refreshCookie";
import { deliverRefreshToken, readPresentedRefreshToken } from "../auth-shared/refreshTokenDelivery";
import { Errors } from "../../lib/errors";
import { authAttemptLimiter } from "../../middleware/rateLimit";
import { requireAuth } from "../../middleware/authGuard";

export const authEmailRouter = Router();

authEmailRouter.post(
  "/auth/email/register",
  authAttemptLimiter,
  asyncHandler(async (req, res) => {
    const { email, password, clientId, role } = registerSchema.parse(req.body);
    const user = await registerWithEmail(email, password, clientId, role);
    res.status(201).json({
      id: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
      // PENDING accounts must be approved by an ADMIN / SUPER_ADMIN before
      // they can log in; ACTIVE accounts can log in immediately.
      pendingApproval: user.status === "PENDING",
    });
  }),
);

authEmailRouter.post(
  "/auth/email/login",
  authAttemptLimiter,
  asyncHandler(async (req, res) => {
    const { email, password, clientId } = loginSchema.parse(req.body);
    const result = await loginWithEmail(email, password, clientId, {
      userAgent: req.headers["user-agent"],
      ip: req.ip,
    });
    // Web portal -> httpOnly cookie. Native app -> refreshToken in the body.
    const body = deliverRefreshToken(res, result.portal, result.refreshToken, result.refreshTokenTtlDays);
    res.status(200).json({ accessToken: result.accessToken, role: result.role, ...body });
  }),
);

authEmailRouter.post(
  "/auth/token/refresh",
  asyncHandler(async (req, res) => {
    refreshSchema.parse(req.body ?? {});
    // Native clients send the refresh token in the body; web sends the
    // cookie. The response mirrors the request.
    const { token, fromBody } = readPresentedRefreshToken(req);
    if (!token) throw Errors.notAuthenticated();

    const result = await rotateRefreshToken(token);

    if (fromBody) {
      res.status(200).json({ accessToken: result.accessToken, refreshToken: result.refreshToken });
    } else {
      setRefreshCookie(res, result.refreshToken, result.refreshTokenTtlDays);
      res.status(200).json({ accessToken: result.accessToken });
    }
  }),
);

authEmailRouter.post(
  "/auth/logout",
  asyncHandler(async (req, res) => {
    logoutSchema.parse(req.body ?? {});
    const { token } = readPresentedRefreshToken(req);
    if (token) await revokeSessionByRefreshToken(token);
    clearRefreshCookie(res); // harmless when there was no cookie (native)
    res.status(204).send();
  }),
);

// Sign out every device. Needs a valid access token (Authorization: Bearer),
// not the refresh token - it acts on the whole account, not one session.
authEmailRouter.post(
  "/auth/logout-all",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const revokedSessions = await revokeAllSessionsForUser(req.auth!.userId);
    clearRefreshCookie(res);
    res.status(200).json({ revokedSessions });
  }),
);
