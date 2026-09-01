import { Response, Request } from "express";
import { env, isProduction } from "../../lib/env";

const COOKIE_NAME = "google_oauth";

interface OAuthCookiePayload {
  state: string;
  codeVerifier: string;
  clientId: string;
  portalRedirectUri: string;
  // The role picked at /auth/google/start, for multi-role portals. Already
  // validated against the portal there; undefined for single-role portals.
  role?: string;
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
    path: "/auth/google",
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
  res.clearCookie(COOKIE_NAME, { domain: env.cookieDomain, path: "/auth/google" });
}
