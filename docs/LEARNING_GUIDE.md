# authservice — Learning Guide

Concept-first explanations for the non-obvious decisions in this build.

## 1. Why access tokens are JWTs but refresh tokens are opaque random strings

An access token needs to be **verifiable by other services without a
network call back to authservice** — that's the point of JWKS (§2). A JWT
is self-contained and signed: anyone with the public key can check "this
really was issued by authservice, for this user, hasn't expired," with
zero database access.

A refresh token has the opposite requirement: it must be **revocable**. If
it were a JWT, invalidating one early would need a blocklist, defeating the
point of using a JWT at all. So it's just a random value
(`src/lib/refreshToken.ts`), looked up in Postgres on every use — slower
than a JWT, but refresh happens rarely, and it buys instant revocation.

## 1a. Same refresh token, two transports — cookie for web, body for native

Where the refresh token *lives on the client* depends on what the client
is, and that's the only thing that changes between web and mobile here.

A browser can hold a token safely in an **httpOnly cookie**: JavaScript
(including injected XSS) can't read it, and the browser attaches it
automatically. That's strictly better than any token a script can touch, so
web portals use it.

A native app has no equivalent. Its HTTP libraries *can* keep a cookie jar,
but it's an in-memory or awkwardly-persisted afterthought, not a security
boundary. The honest move is to stop pretending: hand the app the refresh
token as a plain string, let it put that in the OS keychain/keystore (which
*is* a real boundary on a phone), and take it back in the request body.

So `PortalConfig.nativeApp` picks the transport, and
`refreshTokenDelivery.ts` is the whole implementation — `deliverRefreshToken`
on the way out, `readPresentedRefreshToken` on the way in. Everything else —
the rotation, the reuse-detection, the DB lookup — never learns which
transport was used. That's the design goal: the interesting security
property (§4) is written once and correctly, and "cookie or string" is a
contained decision at the edge.

## 2. RS256, not HS256 — asymmetric signing

HS256 uses one shared secret for both signing and verifying — anyone who
can verify a token can also forge one. That's fine for a monolith, but not
here: a dozen other microservices need to verify tokens, and none of them
should be able to mint one. RS256 keeps the private key only in
authservice; every other service only ever sees the public key (via JWKS)
and can verify but never forge.

## 3. `kid` and why JWKS publishes retired keys too

Keys rotate periodically. The moment you rotate, tokens signed moments ago
with the *old* key are still floating around and haven't expired. If JWKS
only published the new key, those tokens would suddenly fail. The fix:
every token's header carries `kid`, and JWKS publishes every key that might
still have a live token referencing it — `ACTIVE` and `RETIRED`. Verified
directly during development: sign, rotate, then verify the old token — it
still passes.

## 4. Refresh token rotation and reuse detection

If a refresh token were reusable for its whole lifetime, a stolen one is a
long-lived skeleton key with no way to detect the theft. The fix: **every
refresh consumes the token** — get a new access token, get a *new* refresh
token, mark the old one `ROTATED`, all atomically. A legitimate client
always holds exactly the latest one.

That rule turns theft into a detectable event: a `ROTATED` token presented
again means two parties now think they hold "the" refresh token, which only
happens after theft. The safe response is to burn the whole session.

**The trap in implementing this**: revoking-then-throwing inside the same
`prisma.$transaction`. A transaction is all-or-nothing — a thrown error
rolls back everything the callback did, including the revocation you just
did as a security response. The fix used here (`session.service.ts`): every
branch *returns* a result; the caller throws only after the transaction has
already committed.

## 5. PKCE — why Google login needs a code verifier and challenge

Authorization Code flow without PKCE has a weakness on public clients: the
`code` Google sends back could be intercepted and exchanged for tokens by
someone who isn't the real client. PKCE closes this: the client generates a
random `codeVerifier`, sends only its hash (`codeChallenge`) up front, and
must present the original verifier when exchanging the code. An attacker
who only saw the `code` can't complete the exchange without it.

`src/lib/pkce.ts` was verified byte-for-byte against the official RFC 7636
test vector during development. The verifier is stashed in an httpOnly
cookie between `/auth/google/start` and `/auth/google/callback`
(`sameSite: "lax"`, not `"strict"` — Google's redirect back is a cross-site
top-level navigation, and `"strict"` cookies are withheld on exactly that).

This whole flow is **web only**. `/auth/google/start` rejects a native
`clientId` with `USE_NATIVE_GOOGLE`, because there is no web page to redirect
back to. Native apps use `POST /auth/google/native`: the app runs Google
Sign-In with the platform SDK, gets a Google ID token, and posts it (plus
`role`, for `service-provider-app`) as a normal JSON body — no redirect, no
`code` exchange, no PKCE cookie. The server verifies that ID token's
signature and `aud` against Google's JWKS — the same `verifyGoogleIdToken`
the redirect flow uses on its exchanged token — and continues down the
shared find-or-create path. PKCE exists to protect a `code` in transit
through a browser redirect; there's no redirect here, so there's nothing for
it to protect.

(The redirect flow still carries a `role` through its state cookie, since a
redirect has no request body — that's dead weight today because every
multi-role portal is native, but it's there for a future
`service-provider-portal`.)

## 6. Why account-linking only happens when Google says the email is verified

Linking a Google login to an existing password account by email match alone
would mean anyone could type your email into some other Google-connected
app, get an unverified token claiming to be you, and take over your
password account here. `findOrCreateGoogleUser`
(`src/modules/auth-google/auth-google.service.ts`) only auto-links when
`email_verified === true`; otherwise it creates a brand-new account.

## 7. The portal decides which roles are *possible*; the account carries the one it *has*

`src/lib/portals.ts` maps `clientId -> roles[]`. Two cases:

- **Single-role portal** (`patient-app`, `admin-portal`, `superadmin-portal`):
  the `clientId` fully decides the role. Nothing to pick.
- **`service-provider-app`**: one app for `DOCTOR` / `HOSPITAL` / `LS` /
  `AMBULANCE_DRIVER`. The user picks at registration (`role` in the body,
  validated against the portal's list). It's then stored on the account
  and never re-asked — login just reads it back so the app can show the
  right UI.

Either way, the caller can't assert a role at *login*: the only way to get
a `DOCTOR` token is to hold an account whose stored role is `DOCTOR`, and
login re-checks that role is one the portal serves. A self-declared role at
registration isn't trusted either — it's the human approval step (§7a) that
actually vets it.

This is still deliberately minimal: one string per account, decided once,
checked on every login. An earlier version of this build had roles as
database rows with per-user grants, organizations, invite workflows, and
fine-grained permissions — far more machinery than the requirement called
for. The lesson: build the mechanism the rule describes, not the most
general system that could satisfy it.

## 7a. Registering ≠ being allowed in

Registering creates the account; it does not create the *right to log in*.
An account from `service-provider-app` or `admin-portal` is `PENDING` and
login is refused (`403 PENDING_APPROVAL`) until an `ADMIN` or `SUPER_ADMIN`
flips it to `ACTIVE` via `/admin/users/:id/approve`. (Patients and the
first super admin self-activate.)

Two small ideas worth noticing:

- **The gate lives on the portal config, not in the login code.** One
  boolean, `autoApprove`, on each `PortalConfig`. Adding a portal that needs
  vetting is `autoApprove: false` and nothing else — the login check already
  reads `status`.
- **Admins are vetted by the layer above them.** An `ADMIN` also registers
  `PENDING`; only a `SUPER_ADMIN` can approve it (`canApprove` refuses
  `ADMIN → ADMIN`). The super admin itself is the one account that
  self-activates, because there is nobody above it — that's the irreducible
  bootstrap, and §7 of `ARCHITECTURE.md` notes it as the remaining gap.

Same lesson as §7: the feature is a status column, a boolean, and three
routes — not a workflow engine.

## 8. The access token carries a role, nothing more

The token has exactly three claims: `sub`, `role`, `aud`. No permission
list, no extra metadata. What a `"DOCTOR"` token is allowed to do to any
given resource is a decision made by whichever microservice owns that
resource — authservice's job ends at "here's who they are, and here's their
role."
