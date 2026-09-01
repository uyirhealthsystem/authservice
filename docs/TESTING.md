# authservice — Testing

The suite is [Vitest](https://vitest.dev) + [supertest](https://github.com/ladjs/supertest).
Almost every behaviour worth testing here is database-shaped — transactions,
unique constraints, refresh-token rotation and reuse detection — so the tests
run against a **real Postgres**, not a mock. They are integration tests that
drive the Express app in-process (no listening port).

## Layout

| File | Covers |
|---|---|
| `test/portals.unit.test.ts` | pure unit — the `clientId → role` map, the whole authz model |
| `test/health-jwks.test.ts` | `/health`, `/.well-known/jwks.json`, 404 shape, and an issued access token verified against the published JWKS |
| `test/register.test.ts` | `/auth/email/register` — auto-approve vs pending, role rules, duplicate email, validation |
| `test/login.test.ts` | `/auth/email/login` — cookie vs body transport, wrong password, pending/disabled, **cross-portal rejection**, shared app+web account |
| `test/refresh.test.ts` | `/auth/token/refresh`, `/auth/logout`, `/auth/logout-all` — rotation + **reuse detection revokes the session** (both transports) |
| `test/admin-approval.test.ts` | `/admin/users/*` — full pending→approved lifecycle, `ADMIN` cannot action another `ADMIN`, 400/404 edges |
| `test/google-native.test.ts` | `/auth/google/native` — `verifyGoogleIdToken` stubbed, everything downstream real; account linking, pending service provider |
| `test/rate-limit.test.ts` | the brute-force limiter actually returns `429` (own app instance, low limit) |

`test/helpers.ts` has the shared `supertest` client, `resetDb()` (truncates
account tables between cases; `beforeEach` in each file), and small
register/login helpers.

## Running locally

```bash
# 1. a throwaway database (NOT your dev one — the suite truncates tables)
createdb authservice_test        # or: psql -c 'CREATE DATABASE authservice_test'

# 2. point the suite at it
cp .env.test.example .env.test   # edit DATABASE_URL if your creds differ

# 3. run
npm test           # one-shot
npm run test:watch # watch mode
```

`test/globalSetup.ts` runs `prisma migrate deploy` + `prisma generate` +
`ensureSigningKey` once before the suite, so a fresh database just works.

## How it stays deterministic

- `vitest.config.ts` pins `fileParallelism: false` + a single fork — one
  process, one file at a time — because every file shares the one database.
- `resetDb()` truncates `users` (cascading to identities/sessions/refresh
  tokens) before each test. `signing_keys` is left alone.
- `AUTH_RATE_LIMIT_MAX` is set huge for the suite so the limiter doesn't trip
  across hundreds of register/login calls; `rate-limit.test.ts` builds its own
  app with a low limit to test the 429 path.

## CI

`.github/workflows/ci-cd.yml` → job `test` spins up a `postgres:16` service
container and runs `npm ci → prisma migrate deploy → typecheck → test →
build` on every push and PR. Deploy only runs if this job is green.
