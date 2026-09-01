import { z } from "zod";

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters."),
  clientId: z.string().min(1, "clientId (portal) is required."),
  // Only used by multi-role portals (service-provider-app), where the user
  // picks which kind of provider they are. Ignored by single-role portals.
  role: z.string().min(1).optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
  clientId: z.string().min(1, "clientId (portal) is required."),
});

// /auth/token/refresh and /auth/logout: native clients pass the refresh
// token here; web clients send it as a cookie and omit the body.
export const refreshSchema = z.object({
  refreshToken: z.string().min(1).optional(),
});

export const logoutSchema = refreshSchema;
