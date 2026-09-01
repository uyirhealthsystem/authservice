import { NextFunction, Request, Response } from "express";
import { verifyAccessToken } from "../lib/jwt";
import { Errors } from "../lib/errors";

// Route guard for the few endpoints this service protects itself (the admin
// approval API). Reads `Authorization: Bearer <accessToken>`, verifies it
// against our own signing keys, and - if `roles` is non-empty - checks the
// token's role is one of them. Populates req.auth for the handler.
//
// Note: we do NOT pin an audience here. An admin's access token has
// aud=admin-portal / superadmin-portal; that is enough. Authorization is the
// role check below.
export function requireAuth(...roles: string[]) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const header = req.headers.authorization;
      if (!header?.startsWith("Bearer ")) throw Errors.notAuthenticated();

      let claims;
      try {
        claims = await verifyAccessToken(header.slice("Bearer ".length));
      } catch {
        throw Errors.notAuthenticated();
      }

      if (roles.length > 0 && !roles.includes(claims.role)) {
        throw Errors.forbidden("This endpoint requires a different role.");
      }

      req.auth = { userId: claims.sub, role: claims.role };
      next();
    } catch (err) {
      next(err);
    }
  };
}
