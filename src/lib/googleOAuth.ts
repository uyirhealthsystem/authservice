import { createRemoteJWKSet, jwtVerify } from "jose";
import { env } from "./env";
import { Errors } from "./errors";

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

const googleJwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));

// Google env vars are optional at boot so every other login method works
// with zero Google setup. Routes that need Google call this first and 503
// before writing anything to the response (including cookies).
export function requireGoogleConfig() {
  if (!env.google.clientId || !env.google.clientSecret || !env.google.redirectUri) {
    throw Errors.serviceUnavailable("Google login is not configured on this server.");
  }
  return {
    clientId: env.google.clientId,
    clientSecret: env.google.clientSecret,
    redirectUri: env.google.redirectUri,
  };
}

export function buildGoogleAuthorizeUrl(opts: { state: string; codeChallenge: string }) {
  const config = requireGoogleConfig();
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", opts.state);
  url.searchParams.set("code_challenge", opts.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeGoogleCode(code: string, codeVerifier: string) {
  const config = requireGoogleConfig();
  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code",
    code_verifier: codeVerifier,
  });

  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = (await response.json()) as { id_token: string; access_token: string; error?: string; error_description?: string };
  if (!response.ok) {
    throw Errors.badRequest("GOOGLE_TOKEN_EXCHANGE_FAILED", data.error_description ?? data.error ?? "Google token exchange failed.");
  }
  return data;
}

// Verifies a Google ID token from either flow:
//  - the web redirect flow's token exchange (aud = GOOGLE_CLIENT_ID)
//  - the native flow (POST /auth/google/native), where the mobile app's
//    Google Sign-In SDK mints the token with the iOS/Android OAuth client
//    ID as aud - hence GOOGLE_NATIVE_CLIENT_IDS is accepted too.
// Only needs GOOGLE_CLIENT_ID set (not clientSecret / redirectUri), so the
// native path works on a deployment with no web redirect configured.
export async function verifyGoogleIdToken(idToken: string) {
  if (!env.google.clientId) {
    throw Errors.serviceUnavailable("Google login is not configured on this server.");
  }
  const acceptedAudiences = [env.google.clientId, ...env.google.nativeClientIds];
  const { payload } = await jwtVerify(idToken, googleJwks, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: acceptedAudiences,
  });
  return payload as {
    sub: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
  };
}
