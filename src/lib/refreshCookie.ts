import { Response } from "express";
import { env, isProduction } from "./env";
import { AUTH_API_PREFIX, REFRESH_COOKIE_NAME } from "./constants";

// Scoped to the prefix the request arrived on (set per mount in app.ts), so
// the cookie is only ever sent back to authservice's own routes - never to
// other services behind the same gateway domain.
function cookiePath(res: Response): string {
  return (res.locals.refreshCookiePath as string | undefined) ?? AUTH_API_PREFIX;
}

export function setRefreshCookie(res: Response, token: string, ttlDays: number) {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    domain: env.cookieDomain,
    path: cookiePath(res),
    maxAge: ttlDays * 24 * 60 * 60 * 1000,
  });
}

export function clearRefreshCookie(res: Response) {
  res.clearCookie(REFRESH_COOKIE_NAME, { domain: env.cookieDomain, path: cookiePath(res) });
}
