# authservice — Runbook

## First-time setup

```bash
npm install
cp .env.example .env        # then edit DATABASE_URL etc.
npx prisma migrate deploy   # applies migrations to DATABASE_URL
npm run keys:bootstrap      # generates the first ACTIVE signing key - required, server has no keys otherwise
npm run dev
```

There is no seed script and no separate role-bootstrap step. The first
`SUPER_ADMIN` is created the normal way and self-activates (its portal has
`autoApprove: true`), so it can log in right away:
```bash
curl -X POST http://localhost:4000/auth/email/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"...","clientId":"superadmin-portal"}'
```
Service providers register through the one `service-provider-app` clientId
and **pick their role** in the body:
```bash
curl -X POST http://localhost:4000/auth/email/register \
  -H "Content-Type: application/json" \
  -d '{"email":"dr@example.com","password":"...","clientId":"service-provider-app","role":"DOCTOR"}'
```
That account (and any `admin-portal` account) is created `PENDING` and must
be approved before it can log in — see "Approving accounts" below. See
`docs/ARCHITECTURE.md` §3 for the portal model, §3a for approval, §7 for the
gaps that remain.

## Password-reset email pipeline (optional locally)

`/api/v1/auth/password/forgot` and `/api/v1/auth/password/reset` work with **no** extra
setup — but with Kafka unconfigured, `forgot` returns `202` without an email
actually being sent. To exercise the whole path locally:

```bash
# shared Kafka (repo root) - creates the auth.events topic
docker compose -f ../docker-compose.kafka.yml up -d

# fake SMTP inbox at http://localhost:8025
docker compose -f ../notification-service/docker-compose.yml up -d

# authservice .env:
#   KAFKA_BROKERS=localhost:9092

# then run the notification service (see ../notification-service/README.md):
#   .env: KAFKA_BROKERS=localhost:9092  SMTP_HOST=localhost  SMTP_PORT=1025
cd ../notification-service && npm run dev
```

A `forgot` request now lands as an email in the Mailpit UI. authservice never
talks to SMTP — it only publishes a `PasswordResetRequested` event
(`ARCHITECTURE.md` §8).

## Approving accounts

Log in through `admin-portal` or `superadmin-portal` to get an access token,
then:
```bash
# list who is waiting
curl http://localhost:4000/api/v1/auth/users?status=PENDING \
  -H "Authorization: Bearer $ACCESS_TOKEN"

# approve (or .../reject) one
curl -X POST http://localhost:4000/api/v1/auth/users/<user-id>/approve \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```
A `SUPER_ADMIN` can approve anyone including `PENDING` admins; an `ADMIN`
can approve service-provider accounts only.

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `PORT` | no (4000) | |
| `NODE_ENV` | no (development) | `secure` cookie flag turns on in production |
| `COOKIE_DOMAIN` | no (localhost) | Domain for the refresh-token cookie |
| `GOOGLE_CLIENT_ID` | no | needed for any Google login. The web redirect flow also needs the two below; the native flow (`/api/v1/auth/google/native`) needs only this |
| `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | no | web redirect flow only |
| `GOOGLE_ALLOWED_PORTAL_REDIRECT_URIS` | no | comma-separated allow-list checked in `/api/v1/auth/google/start` |
| `GOOGLE_NATIVE_CLIENT_IDS` | no | comma-separated iOS/Android OAuth client IDs, accepted as the `aud` of an ID token on `/api/v1/auth/google/native` |
| `KAFKA_BROKERS` | no | comma-separated brokers. Unset ⇒ the domain-event producer is a no-op: `/api/v1/auth/password/forgot` still returns `202` but no reset email is dispatched |
| `KAFKA_CLIENT_ID` | no (`authservice`) | |

## Moving to `/api/v1/auth` (and retiring the legacy paths)

Routes moved from `/auth/*` + `/admin/users/*` to `/api/v1/auth/*`. The old
paths are still mounted (same handlers, `Deprecation: true` header), so the
deploy itself breaks nothing. Rollout, in order:

1. **Deploy** authservice and the api-gateway (its routing table already
   lists both the new prefixes and the legacy ones).
2. **Google web login.** In Google Cloud Console → Credentials → the OAuth
   client → *Authorized redirect URIs*, **add**
   `https://<api-host>/api/v1/auth/google/callback` (keep the old one for
   now). Only then set `GOOGLE_REDIRECT_URI` to that URL on the server and
   restart. Doing it in the other order gives `redirect_uri_mismatch` on
   Google's page. The OAuth state cookie's path is derived from
   `GOOGLE_REDIRECT_URI`, so no code change is needed either way.
3. **Clients.** Point every portal / app at `/api/v1/auth`. Web portal users
   are logged out once (their refresh cookie is scoped to `/auth`; the new
   one is scoped to `/api/v1/auth`). Native apps are unaffected - their
   refresh token is in the request body.
4. **Retire the aliases** once logs show no more `Deprecation`-flagged
   traffic: delete the two legacy `app.use(...)` lines in `src/app.ts`,
   `legacyAdminRouter`, the `LEGACY_*` constants, `test/legacy-paths.test.ts`,
   the `auth-legacy` / `auth-admin-legacy` entries in the gateway, and the old
   redirect URI in Google Cloud Console.

## Adding a role or a portal

- **New professional role** (a fifth kind of service provider): add the role
  string to `SERVICE_PROVIDER_ROLES` in `src/lib/portals.ts`. It's now a
  valid `role` choice at `service-provider-app` registration. No migration.
- **New portal** (e.g. a web `service-provider-portal`, or a brand-new app):
  add one entry to `PORTALS` with a `clientId`, a `roles` array, login/token
  settings, and `autoApprove` (`false` = needs admin approval before first
  login; `true` = self-service/bootstrap only).
- **A web sibling for an app**: add an entry with a different `clientId` but
  the **same** `roles` array. One account then works across both as
  independent sessions — the login check only compares role to role. Web
  clients conventionally get a shorter `refreshTokenTtlDays` than the app.

That's the whole mechanism — see `docs/ARCHITECTURE.md` §3 / §3a.

## Rotating the signing key

```bash
npm run keys:rotate           # local / dev (tsx)
npm run keys:rotate:prod      # on a built deploy (node dist/…)
```
Safe any time, zero downtime: the previous key moves to `RETIRED` and stays
published in JWKS, so tokens issued moments before rotation still verify.

`npm run keys:bootstrap` (and `keys:bootstrap:prod`) is the *idempotent*
sibling — it creates the first key only if there is none, and is a no-op
afterwards, so the deploy pipeline runs it on every release.

## Web frontend on a different domain than the API

Only the **web** portals (`patient-portal`, `admin-portal`,
`superadmin-portal`) use the refresh-token cookie, so this only matters for
them. The cookie's `Domain`/`SameSite` must match reality or the browser
silently drops it. Two working setups:
- **Same origin via a dev proxy** (recommended while iterating): point the
  frontend dev server's proxy at the API, call it with relative paths.
  `COOKIE_DOMAIN=localhost` keeps working. Exception: `/api/v1/auth/google/start`
  must stay an absolute, unproxied, top-level navigation.
- **True cross-site**: requires `sameSite: "none"` + `Secure` (HTTPS) on
  the API.

## Mobile apps (`patient-app`, `service-provider-app`)

Native clients don't use the cookie at all — none of the above applies:
- Login / `POST /api/v1/auth/google/native` return `refreshToken` in the JSON body.
  Store it in the OS secure store (`expo-secure-store`,
  `flutter_secure_storage`, Keychain, EncryptedSharedPreferences).
- `POST /api/v1/auth/token/refresh` and `POST /api/v1/auth/logout` take
  `{ "refreshToken": "..." }` in the body.
- Google sign-in: run the platform Google Sign-In SDK in the app, then
  `POST /api/v1/auth/google/native { idToken, clientId, role? }`. Register each
  platform's OAuth client ID in `GOOGLE_NATIVE_CLIENT_IDS`.
- The access token still goes in `Authorization: Bearer` to every service,
  same as web.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `GET /health` returns 503 | Postgres unreachable / `DATABASE_URL` wrong |
| Every login gets 500 "No active signing key" | forgot `npm run keys:bootstrap` |
| `403 FORBIDDEN` "role is not valid on this portal" | account's stored role isn't in the portal's `roles` list - e.g. a PATIENT trying `service-provider-app`. Check `src/lib/portals.ts` and which role the account was registered with |
| `403 PENDING_APPROVAL` on login | account registered fine but no admin has approved it yet - see "Approving accounts" |
| `403 ACCOUNT_DISABLED` on login | account was rejected or deactivated by an admin |
| `service-provider-app` / `admin-portal` registration can't log in | expected - it's `PENDING` until approved. Patient and the first superadmin self-activate |
| `400 ROLE_REQUIRED` on register | `service-provider-app` needs a `role` field (`DOCTOR`/`HOSPITAL`/`LS`/`AMBULANCE_DRIVER`) |
| `400 ROLE_NOT_ALLOWED` on register | the `role` sent isn't one that `clientId` offers |
| `400 UNKNOWN_PORTAL` | `clientId` isn't a key in `src/lib/portals.ts` |
| `400 NOT_A_NATIVE_CLIENT` on `/api/v1/auth/google/native` | a web `clientId` (e.g. `patient-portal`) was posted - web uses `/api/v1/auth/google/start` |
| `400 USE_NATIVE_GOOGLE` on `/api/v1/auth/google/start` | a native `clientId` (`patient-app`, `service-provider-app`) was used - native apps use `POST /api/v1/auth/google/native` |
| `/api/v1/auth/token/refresh` always `401` (web) | refresh cookie not being sent - check `Domain`/`SameSite`/`Secure` against the actual origins |
| `/api/v1/auth/token/refresh` always `401` (native) | app isn't putting `{ "refreshToken": "..." }` in the body, or is sending a stale one - after a rotation only the newest token works |
| `/api/v1/auth/token/refresh` returns `403 "reuse detected"` right after a `/api/v1/auth/logout-all` | expected - the session was revoked. The message is shared with the genuine-reuse path; the client should just send the user back to login |
| `/api/v1/auth/token/refresh` returns `403 "reuse detected"` right after a password reset | expected - `/api/v1/auth/password/reset` revokes every session on the account. Client re-logs in |
| `POST /api/v1/auth/password/forgot` returns `202` but no email arrives | one of three independent hops is down. **Kafka**: check `KAFKA_BROKERS` and that the broker is up (unset ⇒ producer no-ops, logs a warning). **notification-service**: check it's running and consuming `auth.events`. **SMTP**: check `notification-service`'s `SMTP_*` (with no `SMTP_HOST` it logs the email instead of sending). Events sit in the topic for 1h, so a brief outage self-heals on restart |
| `400 INVALID_RESET_CODE` on `/api/v1/auth/password/reset` | email unknown, or the code is wrong, already used, or older than 10 min. Also fires for every code except the newest - requesting a new one invalidates the previous |
| reset succeeds but login still fails | the reset revoked existing sessions and the client cached an old token - clear it and log in fresh |
c