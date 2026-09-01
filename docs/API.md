# authservice — API Reference

Base URL (local dev): `http://localhost:4000`

All error responses share one shape:
```json
{ "error": { "code": "SOME_CODE", "message": "Human-readable message." } }
```
Validation errors (`400 VALIDATION_ERROR`) additionally include a `details`
field (Zod's `flatten()` output).

**Portals** (`clientId` values). There are only four, and they fall into two
shapes:

| clientId | role(s) it serves | role chosen | client | login methods | on register |
|---|---|---|---|---|---|
| `patient-app` | `PATIENT` | implied | **native** | password, Google | **ACTIVE** |
| `patient-portal` | `PATIENT` | implied | web | password, Google | **ACTIVE** |
| `service-provider-app` | `DOCTOR`, `HOSPITAL`, `LS`, `AMBULANCE_DRIVER` | **picked at registration** | **native** | password, Google | PENDING |
| `admin-portal` | `ADMIN` | implied | web | password | PENDING (a `SUPER_ADMIN` approves) |
| `superadmin-portal` | `SUPER_ADMIN` | implied | web | password | **ACTIVE** (bootstrap) |

- **Single-role portals** (`patient-*`, `admin-portal`, `superadmin-portal`):
  the role is fixed by the `clientId`. Nothing to pick.
- **The service-provider portal**: one app for all four professional roles.
  The user picks their role when they sign up — `role` in the
  `/auth/email/register` body, or `role` in the `/auth/google/native` body —
  one of `DOCTOR` / `HOSPITAL` / `LS` / `AMBULANCE_DRIVER`. It is stored on
  the account permanently. Login returns it (in the token and the response)
  so the mobile app can route to the right role-based UI; login itself never
  re-asks for a role.

Login always re-checks the account's stored role is one the portal serves —
a `PATIENT` can't log in through `service-provider-app`, and a `DOCTOR`
can't log in through `patient-app`.

### Web clients vs. native clients

The **client** column above splits the portals by how they carry the refresh
token and do Google sign-in:

- **web** (`patient-portal`, `admin-portal`, `superadmin-portal`): the
  refresh token is an httpOnly `refresh_token` cookie (`Path=/auth`). Google
  sign-in is the browser redirect flow (`/auth/google/start` →
  `/auth/google/callback`).
- **native** (`patient-app`, `service-provider-app`): no cookie — login and
  refresh return the refresh token **as a string in the JSON body**, and the
  app stores it itself (Keychain / Keystore). `/auth/token/refresh` and
  `/auth/logout` take it back in the request body. Google sign-in is
  `POST /auth/google/native` (the app runs Google Sign-In with its own SDK
  and posts the ID token — no browser).

The rotation + reuse-detection machinery is identical for both; only the
transport differs.

### Account approval

Accounts registered through `service-provider-app` or `admin-portal` start
`PENDING` and **cannot log in** (`403 PENDING_APPROVAL`) until an `ADMIN`
or `SUPER_ADMIN` approves them via the [Admin API](#admin--account-approval).
Patient accounts and the first super admin start `ACTIVE`.

Approval rules:

- `SUPER_ADMIN` can approve/reject **anyone** (service providers and admins).
- `ADMIN` can approve/reject **service-provider** accounts only — never
  another `ADMIN` or a `SUPER_ADMIN`.
- The first `SUPER_ADMIN` is created just by registering through
  `superadmin-portal` (it self-activates — there is nobody above it).

`UserStatus` values: `PENDING` → `ACTIVE` (approved) or `DISABLED`
(rejected / deactivated).

---

## Health

### `GET /health`
No auth. Does a real `SELECT 1` against Postgres.
- `200 { "status": "ok" }` / `503 { "status": "unavailable" }`

---

## For other microservices: JWKS

### `GET /.well-known/jwks.json`
No auth. Publishes every `ACTIVE` and `RETIRED` signing key's **public**
half.

**How to use this**: fetch once, cache by `kid`, verify incoming
`Authorization: Bearer <token>` headers **locally**:

```js
import { createRemoteJWKSet, jwtVerify } from "jose";
const jwks = createRemoteJWKSet(new URL("http://authservice/.well-known/jwks.json"));
const { payload } = await jwtVerify(token, jwks);
// payload.sub -> user id, payload.role -> "DOCTOR", payload.aud -> the portal clientId
```

Authorization decisions (what a `"DOCTOR"` token can do to *your*
resources) are entirely your service's call — authservice only vouches for
"this is who they are, and this is their role."

---

## Email/password auth

### `POST /auth/email/register`
```json
{ "email": "meera@example.com", "password": "at-least-8-chars",
  "clientId": "service-provider-app", "role": "DOCTOR" }
```
- `clientId` decides the portal. `role` is **required for
  `service-provider-app`** (one of `DOCTOR` / `HOSPITAL` / `LS` /
  `AMBULANCE_DRIVER`) and **ignored** for single-role portals (patient,
  admin, superadmin — the role is implied).
- The chosen role is stored on the account permanently.
- `service-provider-app` and `admin-portal` accounts are created `PENDING`
  and must be approved before they can log in.
- `201 { "id": "...", "email": "...", "role": "DOCTOR", "status": "PENDING", "pendingApproval": true }`
- `409 EMAIL_TAKEN`
- `400 UNKNOWN_PORTAL` — unrecognized `clientId`.
- `400 PROVIDER_NOT_ALLOWED` — that portal doesn't accept password login.
- `400 ROLE_REQUIRED` — `service-provider-app` with no `role` in the body.
- `400 ROLE_NOT_ALLOWED` — `role` is not one this portal offers.

### `POST /auth/email/login`
```json
{ "email": "meera@example.com", "password": "...", "clientId": "service-provider-app" }
```
No `role` on login — the account already has one. It comes back in the
access token (`role` claim) **and** as `role` in the response body.

The refresh token delivery depends on the portal's client type:
- **native** (`patient-app`, `service-provider-app`):
  `200 { "accessToken": "<JWT>", "role": "DOCTOR", "refreshToken": "<opaque>" }`
  — no cookie. Store `refreshToken` in the OS secure store.
- **web** (`patient-portal`, `admin-portal`, `superadmin-portal`):
  `200 { "accessToken": "<JWT>", "role": "DOCTOR" }` + `Set-Cookie:
  refresh_token=…; HttpOnly; Path=/auth`.

Errors:
- `401 INVALID_CREDENTIALS`
- `403 PENDING_APPROVAL` — account is registered but not yet approved by an
  `ADMIN` / `SUPER_ADMIN`.
- `403 ACCOUNT_DISABLED` — account was rejected or deactivated.
- `403 FORBIDDEN` — account's stored role is not one this portal serves
  (e.g. a `PATIENT` account trying `service-provider-app`).
- `429 RATE_LIMITED` — 20 attempts / 15 min per IP.

### `POST /auth/token/refresh`
Rotates the refresh token. Reusing an already-rotated token revokes the
whole session.
- **native**: body `{ "refreshToken": "<opaque>" }` →
  `200 { "accessToken": "<JWT>", "refreshToken": "<new opaque>" }`.
- **web**: no body, reads the `refresh_token` cookie →
  `200 { "accessToken": "<JWT>" }` + new `Set-Cookie`.
- The response mirrors the request: send the token in the body, get the new
  one in the body; send the cookie, get a new cookie.
- `401 NOT_AUTHENTICATED` (missing / unknown / expired) / `403 FORBIDDEN`
  (reuse detected — session revoked).

### `POST /auth/logout`
Revokes the session and clears the cookie.
- **native**: body `{ "refreshToken": "<opaque>" }`.
- **web**: no body, reads the cookie.
- `204 No Content` either way, even if no token was supplied.

### `POST /auth/logout-all`
Sign out **every device**. Revokes every live session on the account, on
every portal. Unlike `/auth/logout` this acts on the whole account, so it
takes the **access token**, not a refresh token:

`Authorization: Bearer <accessToken>` (no body).

- `200 { "revokedSessions": 3 }` (+ clears this caller's cookie).
- `401 NOT_AUTHENTICATED` — missing / invalid / expired access token.
- Access tokens already handed out stay valid until they expire (≤ 15 min) —
  they're stateless JWTs — but no session can be **refreshed** again, so
  every device is fully logged out within that window. A revoked session's
  next `/auth/token/refresh` returns `403 FORBIDDEN`.

---

## Google OAuth

Optional at boot — returns `503 SERVICE_UNAVAILABLE` until Google is
configured. The **web redirect flow** needs `GOOGLE_CLIENT_ID` /
`GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI`. The **native flow**
(`/auth/google/native`) needs only `GOOGLE_CLIENT_ID`, plus
`GOOGLE_NATIVE_CLIENT_IDS` (the iOS/Android OAuth client IDs, comma-separated)
if the app's ID token has a different `aud` than the web client.

### Web redirect flow (Authorization Code + PKCE)

For **web** portals only. A native `clientId` (`patient-app`,
`service-provider-app`) is rejected with `400 USE_NATIVE_GOOGLE` — those use
`/auth/google/native` below.

#### `GET /auth/google/start?clientId=…&redirectUri=<portal-callback>`
Browser top-level navigation — redirects to Google's consent screen.
- `clientId` must be a **web** portal with `GOOGLE` in `allowedProviders`.
  In practice that's `patient-portal` (the admin portals are password-only).
- `redirectUri` must be on the `GOOGLE_ALLOWED_PORTAL_REDIRECT_URIS`
  allow-list.
- Fails before the redirect with `400 USE_NATIVE_GOOGLE` (native client),
  `400 PROVIDER_NOT_ALLOWED`, or `400 REDIRECT_URI_NOT_ALLOWED`.
- A `role` query param is accepted for a hypothetical multi-role web portal
  but is unused today (every multi-role portal is native).

#### `GET /auth/google/callback`
Google redirects here. On success, redirects to the portal's `redirectUri`
with `?accessToken=<JWT>` and sets the refresh-token cookie.

On failure — including a post-consent outcome like a disabled account or a
role mismatch — it redirects to `redirectUri?error=<CODE>` rather than
rendering a JSON error, since the user has already left the portal's origin.

A brand-new Google login creates the account with the portal's role (web
portals with Google are single-role today). An existing account's stored
role must be one the portal serves, exactly like email login. Google
account-linking to an existing password account still only happens when
Google reports `email_verified`.

### Native flow

#### `POST /auth/google/native`
```json
{ "idToken": "<Google ID token from the native Sign-In SDK>",
  "clientId": "service-provider-app", "role": "DOCTOR" }
```
The app runs Google Sign-In itself, gets an ID token, and posts it here — no
browser, no redirect, no PKCE. The server verifies the ID token (`aud` must
be `GOOGLE_CLIENT_ID` or one of `GOOGLE_NATIVE_CLIENT_IDS`), then does the
same find-or-create + role + status checks as every other login.

- `role` — required for `service-provider-app`, ignored for `patient-app`.
- Only works for **native** portals (`patient-app`, `service-provider-app`).
- `200 { "accessToken": "<JWT>", "role": "DOCTOR", "refreshToken": "<opaque>" }`
- `400 NOT_A_NATIVE_CLIENT` — a web `clientId` was used (use the redirect flow).
- `400 PROVIDER_NOT_ALLOWED` / `400 ROLE_REQUIRED` / `400 ROLE_NOT_ALLOWED`
- `401` — the Google ID token failed verification.
- `403 PENDING_APPROVAL` / `403 ACCOUNT_DISABLED` / `403 FORBIDDEN` — same as
  email login (a fresh `service-provider-app` Google signup is `PENDING`).
- `429 RATE_LIMITED`

---

## Admin — account approval

All routes require `Authorization: Bearer <accessToken>` where the token's
`role` is `ADMIN` or `SUPER_ADMIN` (get one by logging in through
`admin-portal` / `superadmin-portal`).

- `401 NOT_AUTHENTICATED` — missing / invalid / expired access token.
- `403 FORBIDDEN` — token role is not `ADMIN` / `SUPER_ADMIN`, or the actor
  may not action this particular target (an `ADMIN` acting on an `ADMIN` /
  `SUPER_ADMIN`).

The user object returned by these endpoints:
```json
{ "id": "...", "email": "...", "role": "DOCTOR", "status": "PENDING",
  "approvedAt": null, "approvedById": null,
  "createdAt": "...", "lastLoginAt": null }
```

### `GET /admin/users/pending`
Lists accounts awaiting approval. An `ADMIN` sees only service-provider
accounts; a `SUPER_ADMIN` also sees `PENDING` admins.
- `200 { "users": [ <user>, ... ] }`

### `POST /admin/users/:id/approve`
Flips a `PENDING` account to `ACTIVE` and stamps `approvedAt` / `approvedById`.
- `200 { "user": <user> }`
- `400 NOT_PENDING` — the account is already `ACTIVE` / `DISABLED`.
- `404 NOT_FOUND` — no such user.

### `POST /admin/users/:id/reject`
Flips a `PENDING` account to `DISABLED`. Same errors as `approve`.
- `200 { "user": <user> }`
