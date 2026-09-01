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

## Approving accounts

Log in through `admin-portal` or `superadmin-portal` to get an access token,
then:
```bash
# list who is waiting
curl http://localhost:4000/admin/users/pending \
  -H "Authorization: Bearer $ACCESS_TOKEN"

# approve (or .../reject) one
curl -X POST http://localhost:4000/admin/users/<user-id>/approve \
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
| `GOOGLE_CLIENT_ID` | no | needed for any Google login. The web redirect flow also needs the two below; the native flow (`/auth/google/native`) needs only this |
| `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | no | web redirect flow only |
| `GOOGLE_ALLOWED_PORTAL_REDIRECT_URIS` | no | comma-separated allow-list checked in `/auth/google/start` |
| `GOOGLE_NATIVE_CLIENT_IDS` | no | comma-separated iOS/Android OAuth client IDs, accepted as the `aud` of an ID token on `/auth/google/native` |

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
  `COOKIE_DOMAIN=localhost` keeps working. Exception: `/auth/google/start`
  must stay an absolute, unproxied, top-level navigation.
- **True cross-site**: requires `sameSite: "none"` + `Secure` (HTTPS) on
  the API.

## Mobile apps (`patient-app`, `service-provider-app`)

Native clients don't use the cookie at all — none of the above applies:
- Login / `POST /auth/google/native` return `refreshToken` in the JSON body.
  Store it in the OS secure store (`expo-secure-store`,
  `flutter_secure_storage`, Keychain, EncryptedSharedPreferences).
- `POST /auth/token/refresh` and `POST /auth/logout` take
  `{ "refreshToken": "..." }` in the body.
- Google sign-in: run the platform Google Sign-In SDK in the app, then
  `POST /auth/google/native { idToken, clientId, role? }`. Register each
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
| `400 NOT_A_NATIVE_CLIENT` on `/auth/google/native` | a web `clientId` (e.g. `patient-portal`) was posted - web uses `/auth/google/start` |
| `400 USE_NATIVE_GOOGLE` on `/auth/google/start` | a native `clientId` (`patient-app`, `service-provider-app`) was used - native apps use `POST /auth/google/native` |
| `/auth/token/refresh` always `401` (web) | refresh cookie not being sent - check `Domain`/`SameSite`/`Secure` against the actual origins |
| `/auth/token/refresh` always `401` (native) | app isn't putting `{ "refreshToken": "..." }` in the body, or is sending a stale one - after a rotation only the newest token works |
| `/auth/token/refresh` returns `403 "reuse detected"` right after a `/auth/logout-all` | expected - the session was revoked. The message is shared with the genuine-reuse path; the client should just send the user back to login |
