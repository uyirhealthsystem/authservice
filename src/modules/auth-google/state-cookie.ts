import { Response, Request } from "express";
import { env, isProduction } from "../../lib/env";
import { AUTH_API_PREFIX } from "../../lib/constants";

const COOKIE_NAME = "google_oauth";

interface OAuthCookiePayload {
  state: string;
  codeVerifier: string;
  clientId: string;
  portalRedirectUri: string;
  // The role picked at /api/v1/auth/google/start, for multi-role portals. Already
  // validated against the portal there; undefined for single-role portals.
  role?: string;
}

// Scoped to the directory of GOOGLE_REDIRECT_URI (e.g. /api/v1/auth/google),
// derived rather than hard-coded so the cookie always reaches whichever
// callback Google actually redirects to - including while the env var still
// points at a legacy /api/v1/auth/google/callback.
function cookiePath(): string {
  const redirectUri = env.google.redirectUri;
  if (!redirectUri) return `${AUTH_API_PREFIX}/google`;
  const pathname = new URL(redirectUri).pathname;
  return pathname.slice(0, pathname.lastIndexOf("/")) || "/";
}

// sameSite MUST be "lax", not "strict" - Google's redirect back to our
// callback is a cross-site top-level GET, and "strict" would drop the
// cookie before we ever see the state param.
export function setOAuthCookie(res: Response, payload: OAuthCookiePayload) {
  res.cookie(COOKIE_NAME, JSON.stringify(payload), {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    domain: env.cookieDomain,
    path: cookiePath(),
    maxAge: 10 * 60 * 1000,
  });
}

export function readOAuthCookie(req: Request): OAuthCookiePayload | undefined {
  const raw = req.cookies?.[COOKIE_NAME];
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function clearOAuthCookie(res: Response) {
  res.clearCookie(COOKIE_NAME, { domain: env.cookieDomain, path: cookiePath() });
}
