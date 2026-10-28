import express, { Router, RequestHandler } from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { logger } from "./lib/logger";
import { AUTH_API_PREFIX, LEGACY_AUTH_PREFIX, LEGACY_ADMIN_PREFIX } from "./lib/constants";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { healthRouter } from "./modules/health/health.routes";
import { jwksRouter } from "./modules/jwks/jwks.routes";
import { authEmailRouter } from "./modules/auth-email/auth-email.routes";
import { authPasswordRouter } from "./modules/auth-password/auth-password.routes";
import { authGoogleRouter } from "./modules/auth-google/auth-google.routes";
import { adminRouter, legacyAdminRouter } from "./modules/admin/admin.routes";

export const app = express();

app.use(helmet());
app.use(cors({ credentials: true, origin: true }));
app.use(cookieParser());
app.use(express.json());
app.use(pinoHttp({ logger }));

// Unversioned infrastructure contracts (API_NAMING_CONVENTION.md §2.4).
app.use(healthRouter);
app.use(jwksRouter);

// Records which prefix this request came in on. The refresh cookie is scoped
// to it (see lib/refreshCookie.ts), so a client on the legacy /auth paths and
// one on /api/v1/auth each get a cookie their own refresh call will send.
const cookieBase =
  (prefix: string): RequestHandler =>
  (_req, res, next) => {
    res.locals.refreshCookiePath = prefix;
    next();
  };

const deprecated: RequestHandler = (_req, res, next) => {
  res.set("Deprecation", "true");
  next();
};

const authApi = Router();
authApi.use(authEmailRouter, authPasswordRouter, authGoogleRouter, adminRouter);
app.use(AUTH_API_PREFIX, cookieBase(AUTH_API_PREFIX), authApi);

// Legacy aliases - same handlers, old paths. Remove once every client has
// moved to /api/v1/auth.
app.use(LEGACY_AUTH_PREFIX, deprecated, cookieBase(LEGACY_AUTH_PREFIX), authEmailRouter, authPasswordRouter, authGoogleRouter);
app.use(LEGACY_ADMIN_PREFIX, deprecated, legacyAdminRouter, adminRouter);

app.use(notFoundHandler);
app.use(errorHandler);
