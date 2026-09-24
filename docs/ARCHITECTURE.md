# authservice — Architecture

## 1. What this service does

`authservice` issues and verifies identity tokens for every portal/app in
the Uyir platform (Patient, Hospital, Doctor, LS, Ambulance Driver, Admin,
Super Admin). It does one job: **log someone in, decide their role, hand
back a token pair**. It does not model hospitals, appointments, dispatch,
or lab results — those are other microservices' concerns, and they trust
this service's tokens without needing to call it on every request (§2).

## 2. Tokens, signing keys, and JWKS

- **Access token**: a short-lived RS256 JWT. Claims: `sub` (user id), `role`
  (a single string, e.g. `"DOCTOR"`), `aud` (the portal's `clientId`).
  Nothing else — no permission list, no organization, no extra metadata.
- **Refresh token**: an opaque, long-lived random value. Only its SHA-256
  hash is ever stored — the raw value exists only in the client's httpOnly
  cookie. Used once, then rotated (§4).
- **Signing keys** (`SigningKey` table): RS256 key pairs. Exactly one
  `ACTIVE` at a time (a hand-written partial unique index enforces this at
  the DB level, not just in app code). Rotating retires the old key to
  `RETIRED` rather than deleting it.
- **JWKS** (`GET /.well-known/jwks.json`): publishes the public half of
  every `ACTIVE` **and** `RETIRED` key. This is why a token signed moments
  before a rotation still verifies afterward — the verifier looks up the
  key by `kid`, and the retired key is still published. Private key
  material never leaves this service.

Other microservices fetch this JWKS once, cache it by `kid`, and verify
tokens **locally** — no call back to authservice per request. See
`docs/API.md`'s "For other microservices" section.

**Known simplification**: `SigningKey.privateKey` is plaintext PEM in
Postgres, not a KMS. Fine for now; revisit before real production use.

## 3. Portals, and how a role gets onto an account

The whole model is one file: `src/lib/portals.ts`. Five `clientId`s, in two
shapes. Each `PortalConfig` lists the `roles` it serves:

```
patient-app, patient-portal   -> [PATIENT]                                (implied)
service-provider-app          -> [DOCTOR, HOSPITAL, LS, AMBULANCE_DRIVER] (picked at registration)
admin-portal                  -> [ADMIN]                                  (implied)
superadmin-portal             -> [SUPER_ADMIN]                            (implied)
```

- **Single-role portals** — the role is fixed by the `clientId`.
  `POST /api/v1/auth/email/register` assigns it; there is nothing to choose.
- **`service-provider-app`** — one app for every professional role. The
  caller passes `role` (one of the four) in the `/api/v1/auth/email/register` body,
  or in the `/api/v1/auth/google/native` body; it is validated against the portal's
  `roles` list (`resolveRegistrationRole`) and stored on `User.role`, once,
  permanently. This is what "one Service Provider app, patient has its own"
  means: professionals don't get a portal each any more, they get a role
  picker at sign-up.

The role is a plain string on `User.role` (not a Postgres enum) — adding a
role is one entry in a `roles` array, never a migration.

`POST /api/v1/auth/email/login` (and the Google callback) re-checks the account's
stored role is one the portal serves (`portalServesRole`). A `PATIENT`
presenting perfectly correct credentials at `service-provider-app` still
gets `403`, and a `DOCTOR` at `patient-app` likewise — nothing about *what
role a token carries* is something the caller gets to assert. On login the
role is simply read back (in the `role` claim and the response) so the
mobile app can route to the right role-based UI; the auth service does not
re-ask which role.

There is no organization model and no per-user permission table. A role is
just a label the token carries; what a `"DOCTOR"` token is allowed to do is
entirely up to whichever downstream microservice receives it.

Web vs. mobile: a portal can still have a web sibling (`patient-portal`
alongside `patient-app`) — same `roles`, shorter refresh TTL. Login only
ever compares role to role, so one account works across a portal and its
sibling as independent sessions. Service providers are app-only for now; a
`service-provider-portal` entry is all it would take to add web.

## 3a. Account approval (PENDING → ACTIVE)

Registration creates the account but does not automatically let it log in.
Each `PortalConfig` in `portals.ts` carries an `autoApprove` flag:

- `autoApprove: true` — `patient-app`, `patient-portal`, `superadmin-portal`.
  Account is created `status = ACTIVE` and can log in immediately. Patients
  are self-service; the super admin is the bootstrap account with nobody
  above it to approve it.
- `autoApprove: false` — `service-provider-app` and `admin-portal`. Account
  is created `status = PENDING`. Login returns `403 PENDING_APPROVAL` until
  approved.

`src/modules/admin/` exposes the approval surface, guarded by
`requireAuth("ADMIN", "SUPER_ADMIN")` (`src/middleware/authGuard.ts` — the
only place this service authorizes its *own* endpoints rather than just
minting tokens for others):

- `GET  /api/v1/auth/users?status=PENDING`
- `POST /api/v1/auth/users/:id/approve` → `status = ACTIVE`, stamps `approvedAt` /
  `approvedById`
- `POST /api/v1/auth/users/:id/reject`  → `status = DISABLED`

Who may action whom (`canApprove` in `admin.service.ts`): a `SUPER_ADMIN`
can action anyone; an `ADMIN` can action service-provider accounts only,
never another `ADMIN` or a `SUPER_ADMIN`. So an admin is itself vetted by a
super admin before it can do any vetting.

This is deliberately the minimum: one boolean on the portal config, one
enum value, one three-route module. No invite tokens, no email step, no
per-request permission checks.

## 4. Refresh token rotation and reuse detection

Every refresh **rotates**: the presented token is marked `ROTATED` and a
new one is issued, atomically, in the same database transaction. If a
`ROTATED` or `REVOKED` token is ever presented again, that's a signal it
was stolen (a legitimate client only ever has the *latest* one) — the
entire session and every refresh token under it are immediately revoked.

Implemented as one `SELECT ... FOR UPDATE` + branch inside a single Prisma
transaction (`session.service.ts`'s `rotateRefreshToken`). The non-obvious
trap: **a `throw` inside `prisma.$transaction` is a rollback signal, not
"commit what happened, then report an error."** Every branch (including
reuse-detected) *returns* a discriminated result; the caller throws only
after the transaction has already committed.

## 4a. Web vs. native: how the refresh token travels

The refresh token itself — an opaque string, SHA-256-hashed at rest — and
everything in §4 is identical for every client. Only the **transport** in
and out of the browser/app differs, and that choice is one boolean on the
portal: `PortalConfig.nativeApp`.

- **Web portals** (`nativeApp: false`) — the refresh token is set as an
  httpOnly `Path=/api/v1/auth` cookie. The browser can't read it from JS (XSS
  can't steal it) and sends it automatically on `/api/v1/auth/token/refresh` and
  `/api/v1/auth/logout`.
- **Native app clients** (`nativeApp: true` — `patient-app`,
  `service-provider-app`) — there is no reliable cookie jar in a React
  Native / Flutter / native app, so login returns the refresh token as a
  string in the JSON body; the app stores it in the OS keychain/keystore
  and passes it back in the body of `/api/v1/auth/token/refresh` and
  `/api/v1/auth/logout`. The response mirrors the request (body in → body out),
  so the two routes serve both client types without a mode flag.

`src/modules/auth-shared/refreshTokenDelivery.ts` is the whole mechanism:
`deliverRefreshToken()` (cookie or body, on the way out) and
`readPresentedRefreshToken()` (body wins over cookie, on the way in).

Google sign-in splits the same way, and the split is enforced both
directions: `/api/v1/auth/google/start` rejects a native `clientId`
(`USE_NATIVE_GOOGLE`), and `/api/v1/auth/google/native` rejects a web one
(`NOT_A_NATIVE_CLIENT`). Web does the redirect → `/callback`; native posts a
Google ID token to `/api/v1/auth/google/native` and never opens a browser.

## 5. Identity model

A `User` has an id, an optional email, a `role`, a `status` (`PENDING` /
`ACTIVE` / `DISABLED` — see §3a), and `approvedAt` / `approvedById`. Login methods
live in a separate `Identity` table (`provider` = `PASSWORD` | `GOOGLE`),
so one person can hold both a password and a Google login pointing at the
same account. Linking works in both directions:

- **password → Google:** signing in with Google on an email that already has
  a password account attaches a `GOOGLE` identity to it — only when Google's
  `email_verified` claim is true, to prevent someone claiming an unverified
  email at Google and taking over an existing account here.
- **Google → password:** a Google-first user runs the forgot/reset flow
  (`POST /api/v1/auth/password/forgot` → emailed 6-digit code → `POST /api/v1/auth/password/reset`).
  Redeeming the code creates the `PASSWORD` identity (or replaces the
  hash for a genuine "forgot"), then revokes every existing session.
  Re-registering the email is refused with `409 EMAIL_TAKEN`.

Reset codes live in `password_reset_tokens` — 10-min TTL, single-use, only
the SHA-256 hash stored (same pattern as `RefreshToken`). Lookups are scoped
by `userId` (resolved from the email in the request), since a 6-digit code
isn't globally unique. Redeeming one also invalidates the user's other
outstanding codes.

## 6. Module layout

```
src/
  lib/            env, logger, prisma, jwt (sign/verify), keys (JWKS/signing),
                  password, refreshToken, otp, refreshCookie, pkce,
                  googleOAuth, portals (clientId -> roles + nativeApp),
                  kafka (best-effort producer), events (domain events), errors
  middleware/     errorHandler, rateLimit, authGuard (requireAuth for /api/v1/auth/users)
  modules/
    health/       GET /health
    jwks/         GET /.well-known/jwks.json
    auth-email/   register, login, refresh, logout, logout-all
                  (refresh/logout/logout-all shared with Google + auth-password)
    auth-password/ POST /api/v1/auth/password/forgot + /api/v1/auth/password/reset
    auth-google/  redirect flow (web) + POST /api/v1/auth/google/native (native)
    auth-shared/  session.service.ts - startSession / rotateRefreshToken /
                  revokeSessionByRefreshToken;
                  refreshTokenDelivery.ts - cookie vs. JSON-body transport
    admin/        GET /api/v1/auth/users?status=PENDING, POST /api/v1/auth/users/:id/approve|reject
```

Nothing outside `lib/prisma.ts` imports `@prisma/client` directly except
`*.service.ts` files.

## 7. Known gaps / deliberate simplifications

- Self-registration goes through the same public `/api/v1/auth/email/register`
  endpoint for everyone. `service-provider-app` and `admin-portal` accounts
  land `PENDING` and need an `ADMIN` / `SUPER_ADMIN` approval before they can
  log in (§3a), which closes most of the gap — but `superadmin-portal` still
  self-activates, so anyone who knows that `clientId` can still mint
  themselves a working super-admin account. If that matters for a real
  deployment, gate `superadmin-portal` registration (a one-time bootstrap
  secret, or disable it after the first account) without touching the rest
  of the machinery.
- A service provider **self-declares** their role (`DOCTOR` / `HOSPITAL` /
  `LS` / `AMBULANCE_DRIVER`) when they sign up — `role` in the
  `/api/v1/auth/email/register` body, or in the `/api/v1/auth/google/native` body.
  Nothing verifies the claim at that point — the check is the human approval
  step: an admin sees the requested role in the pending queue and approves
  or rejects. An admin cannot currently *change* the role while approving
  (approve/reject only); if that's needed it's a small addition to
  `admin.service.ts`.
- No organization/employer model — Doctor, LS, and Ambulance Driver are
  flat roles with no record of which hospital/lab/company someone works
  for. If that turns out to be needed, it can be added later as a separate
  concern layered on top of the role a token already carries, rather than
  baked into authservice's login/token logic.
- Google's `id_token` result is returned to the portal via a redirect query
  parameter (and errors as `?error=<CODE>`). Works, but a hardened version
  would prefer `postMessage` or a one-time exchange code. (The native flow,
  `/api/v1/auth/google/native`, sidesteps this entirely — tokens come back in a
  normal JSON response.)
- Native clients hold the refresh token as a plain string in the OS secure
  store. That's the standard trade-off for apps with no httpOnly cookie —
  the reuse-detection in §4 is what limits the damage of a stolen one. No
  device-binding of refresh tokens yet. `POST /api/v1/auth/logout-all`
  (`revokeAllSessionsForUser`) does exist for the "I lost my phone" case —
  it revokes every session on the account — but access tokens already issued
  still work until they expire (≤ `accessTokenTtlMin`), since they're
  stateless JWTs with no revocation list.
- The native Google path trusts any ID token whose `aud` is in
  `GOOGLE_CLIENT_ID` + `GOOGLE_NATIVE_CLIENT_IDS` and whose issuer is
  Google. That's the documented Google "verify on your backend" contract;
  keep `GOOGLE_NATIVE_CLIENT_IDS` to exactly your own app client IDs.
- Rate limiting (`express-rate-limit`) is in-memory/single-instance only.
- Password-reset email delivery depends on Kafka **and** `notification-service`
  **and** SMTP all being up. Each degrades independently (§8); the deliberate
  gap is that a reset event whose send keeps failing relies on Kafka
  redelivery alone — there is no dead-letter topic.

## 8. Events (Kafka)

authservice is a **producer only**. It publishes domain events to the
`auth.events` topic and never consumes anything.

- `src/lib/kafka.ts` — a single best-effort producer. If `KAFKA_BROKERS` is
  unset it is a **no-op** (one warning logged); the service boots and serves
  every route regardless. Send failures are caught and logged, never thrown —
  a Kafka outage must not fail an auth request.
- `src/lib/events.ts` — the event catalogue. Envelope:
  `{ eventType, eventVersion, occurredAt, data }`, message key = `userId`.

Current events:

| eventType | when | consumer |
|---|---|---|
| `PasswordResetRequested` (v1) | `POST /api/v1/auth/password/forgot` for a real, eligible account | `notification-service` → sends the reset email |

`data` for `PasswordResetRequested`: `{ userId, email, otp, expiresAt }`.
`otp` is the raw 6-digit code. Because that code is a live credential, the
`auth.events` topic is configured with a **1-hour retention** (see
`docker-compose.kafka.yml`) and the code TTL is 10 minutes.
A stronger design — emit only `userId` and have the consumer call back for a
code — is noted but not built.
