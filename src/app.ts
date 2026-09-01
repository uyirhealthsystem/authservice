import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { logger } from "./lib/logger";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { healthRouter } from "./modules/health/health.routes";
import { jwksRouter } from "./modules/jwks/jwks.routes";
import { authEmailRouter } from "./modules/auth-email/auth-email.routes";
import { authGoogleRouter } from "./modules/auth-google/auth-google.routes";
import { adminRouter } from "./modules/admin/admin.routes";

export const app = express();

app.use(helmet());
app.use(cors({ credentials: true, origin: true }));
app.use(cookieParser());
app.use(express.json());
app.use(pinoHttp({ logger }));

app.use(healthRouter);
app.use(jwksRouter);
app.use(authEmailRouter);
app.use(authGoogleRouter);
app.use(adminRouter);

app.use(notFoundHandler);
app.use(errorHandler);
