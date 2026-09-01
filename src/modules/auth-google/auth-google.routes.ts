import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/asyncHandler";
import { requireGoogleConfig, buildGoogleAuthorizeUrl } from "../../lib/googleOAuth";
import { generateCodeVerifier, codeChallengeFromVerifier, generateState } from "../../lib/pkce";
import { setOAuthCookie, readOAuthCookie, clearOAuthCookie } from "./state-cookie";
import { completeGoogleLogin, completeGoogleNativeLogin } from "./auth-google.service";
import { setRefreshCookie } from "../../lib/refreshCookie";
import { deliverRefreshToken } from "../auth-shared/refreshTokenDelivery";
import { env } from "../../lib/env";
import { Errors, AppError } from "../../lib/errors";
import { getPortal, resolveRegistrationRole } from "../../lib/portals";
import { authAttemptLimiter } from "../../middleware/rateLimit";

export const authGoogleRouter = Router();

const startSchema = z.object({
  clientId: z.string().min(1),
  redirectUri: z.string().url(),
  // Only meaningful for a multi-role WEB portal. Today every multi-role
  // portal is native (service-provider-app) and native clients are rejected
  // below, so in practice this is unused - kept so a future
  // `service-provider-portal` works without a code change. Single-role
  // portals ignore it.
  role: z.string().min(1).optional(),
});

authGoogleRouter.get(
  "/auth/google/start",
  asyncHandler(async (req, res) => {
    // requireGoogleConfig() must run BEFORE anything is written to `res` -
    // an earlier version of this route set the PKCE cookie first, so the
    // not-configured 503 leaked a Set-Cookie header.
    requireGoogleConfig();

    const { clientId, redirectUri, role } = startSchema.parse(req.query);

    if (!env.google.allowedPortalRedirectUris.includes(redirectUri)) {
      throw Errors.badRequest("REDIRECT_URI_NOT_ALLOWED", "redirectUri is not on the allow-list.");
    }

    const portal = getPortal(clientId);
    if (!portal.allowedProviders.includes("GOOGLE")) {
      throw Errors.badRequest("PROVIDER_NOT_ALLOWED", `Portal "${clientId}" does not accept Google login.`);
    }
    if (portal.nativeApp) {
      // The redirect flow is the browser path - it lands on a web
      // `redirectUri`. A native app has no such page; it uses the ID-token
      // endpoint instead. (Mirror of NOT_A_NATIVE_CLIENT on that endpoint.)
      throw Errors.badRequest(
        "USE_NATIVE_GOOGLE",
        `Portal "${clientId}" is a native app client; POST the Google ID token to /auth/google/native instead.`,
      );
    }
    // Resolve + validate the role now, before the Google round-trip, so a
    // missing/bad role fails here rather than after the user has consented.
    // Single-role portals return their one role and ignore `role`.
    const resolvedRole = resolveRegistrationRole(portal, role);

    const codeVerifier = generateCodeVerifier();
    const state = generateState();
    const codeChallenge = codeChallengeFromVerifier(codeVerifier);

    setOAuthCookie(res, { state, codeVerifier, clientId, portalRedirectUri: redirectUri, role: resolvedRole });

    res.redirect(buildGoogleAuthorizeUrl({ state, codeChallenge }));
  }),
);

authGoogleRouter.get(
  "/auth/google/callback",
  asyncHandler(async (req, res) => {
    const cookie = readOAuthCookie(req);
    if (!cookie) throw Errors.badRequest("MISSING_OAUTH_STATE", "OAuth flow expired or was not started here.");

    const { error, code, state } = req.query as Record<string, string | undefined>;

    if (error) {
      clearOAuthCookie(res);
      return res.redirect(`${cookie.portalRedirectUri}?error=${encodeURIComponent(error)}`);
    }

    if (!state || state !== cookie.state) {
      clearOAuthCookie(res);
      throw Errors.badRequest("STATE_MISMATCH", "OAuth state parameter mismatch.");
    }

    if (!code) throw Errors.badRequest("MISSING_CODE", "Missing authorization code.");

    let result;
    try {
      result = await completeGoogleLogin(
        code,
        cookie.codeVerifier,
        cookie.clientId,
        { userAgent: req.headers["user-agent"], ip: req.ip },
        cookie.role,
      );
    } catch (err) {
      // The user has already left our origin and come back via Google - a
      // raw JSON error page here is a dead end. Send a recognised outcome
      // (PENDING_APPROVAL for a fresh service-provider signup, ACCOUNT_DISABLED,
      // role mismatch, ...) back to the portal as ?error= so it can show a
      // real screen. The account row, if one was created, still stands.
      clearOAuthCookie(res);
      const errorCode = err instanceof AppError ? err.code : "GOOGLE_LOGIN_FAILED";
      return res.redirect(`${cookie.portalRedirectUri}?error=${encodeURIComponent(errorCode)}`);
    }

    clearOAuthCookie(res);
    setRefreshCookie(res, result.refreshToken, result.refreshTokenTtlDays);

    const redirect = new URL(cookie.portalRedirectUri);
    redirect.searchParams.set("accessToken", result.accessToken);
    res.redirect(redirect.toString());
  }),
);

// Native (iOS / Android) Google sign-in. The app runs Google Sign-In with
// its own SDK, gets a Google ID token, and posts it here - no browser
// redirect, no PKCE cookie. Returns the token pair in the JSON body.
const nativeSchema = z.object({
  idToken: z.string().min(1),
  clientId: z.string().min(1),
  // Required for multi-role portals (service-provider-app), same as the
  // ?role param on the redirect flow's /start.
  role: z.string().min(1).optional(),
});

authGoogleRouter.post(
  "/auth/google/native",
  authAttemptLimiter,
  asyncHandler(async (req, res) => {
    const { idToken, clientId, role } = nativeSchema.parse(req.body);
    const result = await completeGoogleNativeLogin(idToken, clientId, role, {
      userAgent: req.headers["user-agent"],
      ip: req.ip,
    });
    const body = deliverRefreshToken(res, result.portal, result.refreshToken, result.refreshTokenTtlDays);
    res.status(200).json({ accessToken: result.accessToken, role: result.role, ...body });
  }),
);
