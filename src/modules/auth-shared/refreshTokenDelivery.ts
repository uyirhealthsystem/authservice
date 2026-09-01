import { Response } from "express";
import { PortalConfig } from "../../lib/portals";
import { setRefreshCookie } from "../../lib/refreshCookie";
import { REFRESH_COOKIE_NAME } from "../../lib/constants";

// One decision, in one place: web portals get the refresh token as an
// httpOnly cookie (survives XSS, invisible to JS); native app clients get it
// as a string in the JSON body (no cookie jar to rely on - the app stashes
// it in the OS keychain / keystore itself).
//
// Returns the fields to merge into the JSON response body. For web that's
// nothing (the cookie was set on `res`); for native it's { refreshToken }.
export function deliverRefreshToken(
  res: Response,
  portal: PortalConfig,
  refreshToken: string,
  refreshTokenTtlDays: number,
): { refreshToken?: string } {
  if (portal.nativeApp) {
    return { refreshToken };
  }
  setRefreshCookie(res, refreshToken, refreshTokenTtlDays);
  return {};
}

// The inverse, for /auth/token/refresh and /auth/logout: a native client
// sends the refresh token in the body, a web client sends the cookie. Body
// wins if both are somehow present.
export function readPresentedRefreshToken(req: {
  body?: { refreshToken?: unknown };
  cookies?: Record<string, string | undefined>;
}): { token: string | undefined; fromBody: boolean } {
  const bodyToken = typeof req.body?.refreshToken === "string" ? req.body.refreshToken : undefined;
  if (bodyToken) return { token: bodyToken, fromBody: true };
  return { token: req.cookies?.[REFRESH_COOKIE_NAME], fromBody: false };
}
