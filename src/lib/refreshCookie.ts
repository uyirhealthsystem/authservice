import { Response } from "express";
import { env, isProduction } from "./env";
import { REFRESH_COOKIE_NAME, REFRESH_COOKIE_PATH } from "./constants";

export function setRefreshCookie(res: Response, token: string, ttlDays: number) {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    domain: env.cookieDomain,
    path: REFRESH_COOKIE_PATH,
    maxAge: ttlDays * 24 * 60 * 60 * 1000,
  });
}

export function clearRefreshCookie(res: Response) {
  res.clearCookie(REFRESH_COOKIE_NAME, { domain: env.cookieDomain, path: REFRESH_COOKIE_PATH });
}
