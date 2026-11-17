import "dotenv/config";
import { parseKafkaSettings } from "./kafkaConfig";

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

  // Kafka is intentionally NOT required() - like Google above, the service
  // boots and serves every other path with zero Kafka setup. When brokers are
  // unset the producer is a no-op (a warning is logged) and /api/v1/auth/password/forgot
  // still returns 202 - the reset email just isn't dispatched until Kafka +
  // the notification service are up. See src/lib/kafka.ts. TLS / SASL for a
  // managed cluster: see src/lib/kafkaConfig.ts.
  kafka: parseKafkaSettings(process.env),

  // Brute-force guard on register / login / google-native. Defaults match the
  // original hard-coded values; overridable so tests (and a future shared
  // Redis store) can tune them without touching code.
  authRateLimit: {
    max: Number(optional("AUTH_RATE_LIMIT_MAX", "20")),
    windowMs: Number(optional("AUTH_RATE_LIMIT_WINDOW_MS", String(15 * 60 * 1000))),
  },

  // Email OTP as the second step of email/password login (every portal). On
  // by default. LOGIN_OTP_ENABLED=false is an operational kill switch (e.g.
  // the mail provider is down): login then issues tokens straight after the
  // password check, as it did before OTP existed. Google login never asks for
  // a code - Google has already proven the user owns the address.
  loginOtp: {
    enabled: optional("LOGIN_OTP_ENABLED", "true").toLowerCase() !== "false",
    ttlMin: Number(optional("LOGIN_OTP_TTL_MIN", "5")),
    maxAttempts: Number(optional("LOGIN_OTP_MAX_ATTEMPTS", "5")),
    resendCooldownSec: Number(optional("LOGIN_OTP_RESEND_COOLDOWN_SEC", "30")),
    maxSendsPerChallenge: Number(optional("LOGIN_OTP_MAX_SENDS_PER_CHALLENGE", "4")),
    // Caps codes emailed to one account per window, across all challenges -
    // stops someone who knows the password from mail-bombing the owner.
    maxSendsPerUserWindow: Number(optional("LOGIN_OTP_MAX_SENDS_PER_USER", "10")),
    userWindowMin: Number(optional("LOGIN_OTP_USER_WINDOW_MIN", "15")),
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
    // the native path (POST /api/v1/auth/google/native) - the iOS and Android
    // clients from the same Google Cloud project. The web clientId above is
    // always accepted too.
    nativeClientIds: (process.env.GOOGLE_NATIVE_CLIENT_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },
};

export const isProduction = env.nodeEnv === "production";
