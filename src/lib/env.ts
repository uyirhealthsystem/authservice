import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const env = {
  nodeEnv: optional("NODE_ENV", "development"),
  port: Number(optional("PORT", "4000")),
  logLevel: optional("LOG_LEVEL", "info"),

  databaseUrl: required("DATABASE_URL"),
  cookieDomain: optional("COOKIE_DOMAIN", "localhost"),

  // Brute-force guard on register / login / google-native. Defaults match the
  // original hard-coded values; overridable so tests (and a future shared
  // Redis store) can tune them without touching code.
  authRateLimit: {
    max: Number(optional("AUTH_RATE_LIMIT_MAX", "20")),
    windowMs: Number(optional("AUTH_RATE_LIMIT_WINDOW_MS", String(15 * 60 * 1000))),
  },

  // Google OAuth is intentionally NOT required() - the service must boot and
  // serve every other login method with zero Google setup. Routes that need
  // it call requireGoogleConfig() lazily and 503 if it's missing.
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI,
    allowedPortalRedirectUris: (process.env.GOOGLE_ALLOWED_PORTAL_REDIRECT_URIS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    // Extra OAuth client IDs accepted as the `aud` of a Google ID token on
    // the native path (POST /auth/google/native) - the iOS and Android
    // clients from the same Google Cloud project. The web clientId above is
    // always accepted too.
    nativeClientIds: (process.env.GOOGLE_NATIVE_CLIENT_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },
};

export const isProduction = env.nodeEnv === "production";
