# authservice — A Story

A walkthrough of the system as a narrative. Every request/response below is
real, from an actual run against a live local instance.

Cast:
- **Ananya** — a patient
- **Dr. Meera** — a doctor
- **Ravi** — an ambulance driver
- **Priya** — a Super Admin
- **the Appointments service** — a separate microservice that never touches
  authservice's database

---

## Part 1 — two doors: the patient app, and the service-provider app

There are only a handful of `clientId`s. Patients have their own app.
*Every* professional — doctor, hospital, lab, ambulance driver — comes
through **one** app, `service-provider-app`, and picks their role at sign-up.

Ananya, a patient:
```http
POST /auth/email/register
{ "email": "ananya@example.com", "password": "myS3curePass", "clientId": "patient-app" }
```
```json
201 { "id": "8b29...", "email": "ananya@example.com", "role": "PATIENT",
      "status": "ACTIVE", "pendingApproval": false }
```

Dr. Meera, through the service-provider app, choosing `DOCTOR`:
```http
POST /auth/email/register
{ "email": "meera@example.com", "password": "herOwnChoice1",
  "clientId": "service-provider-app", "role": "DOCTOR" }
```
```json
201 { "id": "2557...", "email": "meera@example.com", "role": "DOCTOR",
      "status": "PENDING", "pendingApproval": true }
```

The role she picked is now stored on her account permanently — there's no
"become a hospital later" step, and login never asks again. If she'd left
`role` out, she'd get `400 ROLE_REQUIRED`; if she'd sent `"role": "PATIENT"`,
`400 ROLE_NOT_ALLOWED` (that portal only serves the four professional roles).

But notice Ananya's account came back `ACTIVE` and Dr. Meera's came back
`PENDING`. A patient signs herself up and is done. A professional is only
*registered* at this point — someone with authority has to confirm "yes,
this person really is a doctor" before the account can log in. That's Part 1a.

## Part 1a — a human approves the professionals

Dr. Meera tries to log in right after registering:

```http
POST /auth/email/login
{ "email": "meera@example.com", "password": "herOwnChoice1", "clientId": "service-provider-app" }
```
```json
403 { "error": { "code": "PENDING_APPROVAL",
      "message": "Your account is awaiting administrator approval." } }
```

Meanwhile an admin (logged in through `admin-portal`) checks the queue:

```http
GET /admin/users/pending
Authorization: Bearer <admin's access token>
```
```json
200 { "users": [ { "id": "2557...", "email": "meera@example.com",
                   "role": "DOCTOR", "status": "PENDING", ... } ] }
```
```http
POST /admin/users/2557.../approve
Authorization: Bearer <admin's access token>
```

The admin sees the role Meera claimed (`DOCTOR`) right there in the queue —
approving *is* the check on that self-declared role. Now her account is
`ACTIVE` and her next login succeeds. If the admin had called `/reject`
instead, the account would be `DISABLED` and she'd get `403 ACCOUNT_DISABLED`.

The chain of trust has a top: an `ADMIN` can approve service providers but
not other admins — only a `SUPER_ADMIN` approves an `ADMIN`. And the very
first `SUPER_ADMIN` approves itself, simply by registering through
`superadmin-portal` (see Part 7 for why that last step is the one soft spot).

## Part 2 — logging in, and what the token actually contains

```http
POST /auth/email/login
{ "email": "meera@example.com", "password": "herOwnChoice1", "clientId": "service-provider-app" }
```
```json
200 { "accessToken": "eyJhbGci...<snip>...", "role": "DOCTOR",
      "refreshToken": "Zfd185Xt..." }
```

No `role` in that request — the account already has one. It comes back both
in the response body and inside the token, and the app reads it to decide
which home screen to show. `service-provider-app` is a native client, so the
refresh token is a plain string in the body (Part 6) — a browser client
like `patient-portal` would get it as an httpOnly cookie instead.

Decoded, the access token says exactly three things:
```json
{ "role": "DOCTOR", "sub": "2557...", "aud": "service-provider-app", "iat": ..., "exp": ... }
```

That's the entire payload. No permission list, no employer, nothing else —
just "this is user 2557..., they're a DOCTOR, this was issued for
service-provider-app, and it expires in 15 minutes."

## Part 3 — the role can't be borrowed

Dr. Meera's password is correct. Her account is real. She tries logging
into the patient app anyway, just to see:

```http
POST /auth/email/login
{ "email": "meera@example.com", "password": "herOwnChoice1", "clientId": "patient-app" }
```
```json
403 { "error": { "code": "FORBIDDEN", "message": "This account's role (DOCTOR) is not valid on this portal." } }
```

Correct password, real account, still rejected — because her stored role
is `DOCTOR`, and `patient-app` only serves `PATIENT`. The check isn't "did
you prove who you are," it's "does who you are match what this app is for."
Ananya trying `service-provider-app` with her own correct password gets the
identical rejection, the other way around.

## Part 4 — the Appointments service trusts the token without ever asking authservice

A completely separate microservice — say, one that manages appointment
bookings — receives a request carrying Dr. Meera's access token. It has
never talked to authservice's database and doesn't need to reach it right
now. All it needed, fetched once and cached:

```http
GET /.well-known/jwks.json
```
```json
{ "keys": [ { "kty": "RSA", "n": "...", "e": "AQAB", "kid": "ce68...", "alg": "RS256", "use": "sig" } ] }
```

With that public key it verifies the token entirely on its own:

```js
const jwks = createRemoteJWKSet(new URL(".../.well-known/jwks.json"));
const { payload } = await jwtVerify(token, jwks);
// { role: "DOCTOR", sub: "2557...", aud: "service-provider-app", ... }
```

This was verified for real by running exactly this code in a totally
separate Node process with zero access to authservice's source or
database. What a `DOCTOR` token is allowed to do to an appointment record
is the Appointments service's own decision — authservice's job stopped at
"here's who they are, and here's their role."

## Part 5 — someone steals Dr. Meera's refresh token

Say her phone is compromised and an attacker copies the refresh token out of
its storage (or, for a web user, the httpOnly cookie). Both of them now hold
what looks like a valid token. This part is the same whichever transport the
token came in on — the reuse-detection is on the token value, not the
carrier.

Whoever uses it first — the attacker — gets a normal response:
```http
POST /auth/token/refresh    (attacker)   { "refreshToken": "<stolen>" }
```
```json
200 { "accessToken": "...", "refreshToken": "<brand-new-value>" }
```

That consumes the stolen value — it's now `ROTATED`. Dr. Meera's app still
holds the old one. Her next auto-refresh:
```http
POST /auth/token/refresh    (Dr. Meera, stale token)
```
```json
403 { "error": { "code": "FORBIDDEN", "message": "Refresh token reuse detected; session revoked." } }
```

The system can't tell which of them is the attacker, and it doesn't need
to — a token being presented twice after being consumed once only happens
after theft, so the whole session gets burned: every refresh token under
it, including the one the attacker is now holding, gets revoked. Verified
directly: after this, *even the attacker's supposedly fresh token* stops
working. Dr. Meera just logs in again; the attacker is locked out entirely.

If she's not sure which device was compromised, she hits **sign out
everywhere** from her account settings — `POST /auth/logout-all` with her
access token — and every session on every device is revoked at once
(`200 { "revokedSessions": 4 }`). Any access token already out there keeps
working for up to 15 more minutes (it's a stateless JWT), but nothing can be
refreshed, so every device drops to the login screen shortly after.

## Part 6 — Ananya uses both her phone and the web

Ananya mostly uses the patient app, but sometimes books an appointment from
her laptop. There's no "link my devices" step — she registered once through
`patient-app`, and the same email and password just work on the web portal.

**On her laptop** (`patient-portal`, a web client):
```http
POST /auth/email/login
{ "email": "ananya@example.com", "password": "myS3curePass", "clientId": "patient-portal" }
```
```json
200 { "accessToken": "eyJhbGci...", "role": "PATIENT" }
Set-Cookie: refresh_token=<opaque>; HttpOnly; Path=/auth; ...
```
The refresh token is an httpOnly cookie — her browser stores it where no
JavaScript can read it, and sends it back automatically.

**On her phone** (`patient-app`, a native client), the same request:
```json
200 { "accessToken": "eyJhbGci...", "role": "PATIENT", "refreshToken": "<opaque>" }
```
No cookie. The refresh token comes back **in the body**, and the app puts it
in the iOS Keychain / Android Keystore itself — a phone has no httpOnly
cookie, so pretending otherwise would just mean a token sitting somewhere
worse. When the access token expires the app calls
`POST /auth/token/refresh` with `{ "refreshToken": "<opaque>" }` in the
body and gets a fresh pair back the same way. Everything *behind* that —
the rotation, the reuse-detection from Part 5 — is byte-for-byte identical
to the web path; only where the string is carried changes.

Decoding either token shows `"aud"` = `patient-portal` or `patient-app`, so
a downstream service can tell which device a request came from — but `role`
is `"PATIENT"` both times. `patient-app` and `patient-portal` are two
`clientId` entries in `src/lib/portals.ts` with the **same** `roles` list
and different `nativeApp` flags. The login check only ever compares *role*
to *role*, so "same account, two devices" falls out for free. The two
logins are independent sessions — logging out of one doesn't touch the
other.

If Ananya signs up with **"Continue with Google"**, the split is the same,
and the server enforces it: on the web (`patient-portal`) it's the
`/auth/google/start` browser redirect; in the app (`patient-app`) it's
`POST /auth/google/native` — the app runs Google Sign-In itself and posts
the ID token, no browser. Point a native `clientId` at `/auth/google/start`
and it's rejected with `USE_NATIVE_GOOGLE`; point a web one at
`/auth/google/native` and it's `NOT_A_NATIVE_CLIENT`.

Service providers work exactly like `patient-app` here — `service-provider-app`
is also a native client. Admin and Super Admin are web-only, on purpose:
back-office work, no mobile app.

## Part 7 — Ravi, and the honest limits of this design

Ravi registers through the same service-provider app as Dr. Meera, picking
`AMBULANCE_DRIVER`:
```http
POST /auth/email/register
{ "email": "ravi@example.com", "password": "...",
  "clientId": "service-provider-app", "role": "AMBULANCE_DRIVER" }
```
```json
201 { "id": "...", "role": "AMBULANCE_DRIVER", "status": "PENDING", "pendingApproval": true }
```

Like Dr. Meera, Ravi waits for an admin to approve him. Two honest limits
show up here. First, Ravi *told* the system he's an ambulance driver —
nothing checked it at registration; the only check is the admin eyeballing
the request in the pending queue and approving. Second, notice what's *not*
recorded anywhere: which ambulance company Ravi drives for. This system has
no employer concept — a role is a flat label, not "a driver employed by
Swift Ambulance Services." If a real deployment needs that, it's a
deliberate gap (see `docs/ARCHITECTURE.md` §7), layered on top of the role
in whichever service actually tracks employer relationships — not baked
into authservice.

The same honesty applies to the top of the approval chain. Service
providers and admins all now wait for approval — but the
first `SUPER_ADMIN` still just registers through `superadmin-portal` and is
active immediately, because there is nobody above it to do the approving.
So anyone who knows that one `clientId` can still mint themselves a working
super-admin account. Closing that is a small, contained change (a one-time
bootstrap secret, or disabling the portal after the first account) — see
`docs/ARCHITECTURE.md` §7 — and it doesn't touch the rest of the machinery.

Also honest: `admin` can `approve`/`reject` but not *change* the role a
provider claimed. If a doctor registers as `HOSPITAL` by mistake, today the
admin rejects and the person re-registers. A "change role on approve" option
is a few lines in `admin.service.ts` if it's ever wanted.

And on the mobile side: a native app holds its refresh token as a plain
string in the OS secure store — which is a real boundary on a phone, but not
the un-readable-by-anything an httpOnly cookie gives a browser. The
reuse-detection in Part 5, plus `POST /auth/logout-all`, are what limit the
blast radius of a stolen one. What's still missing is device-binding of
refresh tokens (so a token lifted off one phone can't be replayed from
another) — that's a real hardening step, not done here.
