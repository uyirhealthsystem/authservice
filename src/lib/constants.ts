export const REFRESH_COOKIE_NAME = "refresh_token";

// Every authservice route (except /health and /.well-known/jwks.json) lives
// under this prefix - see docs/API_NAMING_CONVENTION.md.
export const AUTH_API_PREFIX = "/api/v1/auth";

// Pre-/api/v1 paths, still mounted so un-updated clients keep working.
// Responses on these carry `Deprecation: true`. Remove once every client has
// moved to AUTH_API_PREFIX.
export const LEGACY_AUTH_PREFIX = "/auth";
export const LEGACY_ADMIN_PREFIX = "/admin";
