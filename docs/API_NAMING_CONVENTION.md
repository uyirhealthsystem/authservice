# Uyir — API Naming Convention

One page, platform-wide. Every microservice in the Uyir platform
(`authservice`, and whatever comes after it — appointments, hospitals,
dispatch, lab-results, …) follows these rules so that a caller who has
learned one service can predict the shape of the next one.

`authservice` is the reference implementation. Where it currently deviates,
that is called out in §12 — new services should follow the rule, not copy
the deviation.

---

## 1. Service naming

- A service is one lower-case word, no separator, suffixed `service`:
  `authservice`, `appointmentservice`, `hospitalservice`,
  `dispatchservice`, `labservice`.
- The repository name, the systemd unit, the internal DNS name and the
  `Host` other services use to reach it are all that same string.
- One service owns one domain and one database. It never reads another
  service's tables — it calls that service's API.

---

## 2. URL structure

```
https://<host>/api/<version>/<resource>/<id>/<sub-resource>...
```

### 2.1 Casing

- Path segments: **`kebab-case`**, always lower-case.
  `/lab-results`, `/service-providers`, not `/labResults` or `/LabResults`.
- Never put an underscore or an uppercase letter in a path.

### 2.2 Resources are plural nouns

- Collections are plural nouns: `/users`, `/appointments`, `/hospitals`.
- A single item is addressed by id under the collection:
  `/users/{id}`, `/appointments/{id}`.
- Nest only one level deep to show ownership:
  `/hospitals/{id}/departments`. Beyond one level, start a new top-level
  collection with a filter: `/appointments?departmentId=…`, not
  `/hospitals/{id}/departments/{id}/appointments`.
- No verbs in resource paths. `/getUser`, `/create-appointment` are wrong.
  The HTTP method is the verb (§3).

### 2.3 Actions that are not plain CRUD

Some operations do not map to `POST`/`PATCH` on a resource — a state
transition, a side-effecting command. Model these as a sub-resource with an
imperative verb, via `POST`:

```
POST /users/{id}/approve
POST /users/{id}/reject
POST /appointments/{id}/cancel
POST /api/v1/auth/token/refresh
```

- The verb is a single lower-case word (`approve`, `cancel`, `resend`).
- Prefer making it a real resource first (`POST /appointments/{id}/cancellation`)
  only when the action produces a thing worth addressing later; otherwise
  the plain verb is fine and shorter.

### 2.4 Versioning

- Every routable path is prefixed with `/api` and a major version: `/api/v1/...`.
  The gateway routes on that prefix, so each service owns one
  `/api/v1/<its-root>` namespace (authservice: `/api/v1/auth`).
- The version only changes on a **breaking** change. Additive changes
  (a new optional field, a new endpoint) stay on the same version.
- Two exceptions, which are never versioned because they are
  infrastructure contracts, not the service's domain API:
  - `GET /health`
  - `GET /.well-known/jwks.json` (auth-issuing services only)

### 2.5 Trailing slash

No trailing slash. `/api/v1/users`, never `/api/v1/users/`.

---

## 3. HTTP methods

| Method   | Use                                        | Body | Idempotent |
|----------|--------------------------------------------|------|------------|
| `GET`    | Read a collection or one item              | no   | yes        |
| `POST`   | Create an item, or run an action (§2.3)    | yes  | no         |
| `PATCH`  | Partial update of an existing item         | yes  | no         |
| `PUT`    | Full replace (rare — prefer `PATCH`)       | yes  | yes        |
| `DELETE` | Remove an item                             | no   | yes        |

- `GET` never changes state and never takes a request body.
- Prefer `PATCH` over `PUT`. Only use `PUT` when the client genuinely
  owns and sends the whole representation.

---

## 4. Path and query parameters

### 4.1 Path parameters

- Always `camelCase` and named for what they identify: `{id}`, `{userId}`,
  `{appointmentId}`.
- A path parameter always identifies a resource. Anything else is a query
  parameter.

### 4.2 Query parameters

- `camelCase`: `?pageSize=20`, `?departmentId=…`, `?status=PENDING`.
- Filtering: one query param per field, name = field name.
  `GET /api/v1/appointments?status=BOOKED&doctorId=abc`.
- Sorting: `?sort=createdAt` (ascending) or `?sort=-createdAt`
  (descending, leading `-`). Multiple: `?sort=-createdAt,name`.
- Pagination: **cursor-based** is the default.
  `?pageSize=<n>&cursor=<opaque>`. The response carries the next cursor
  (§6.3). Offset pagination (`?page=2`) only where a total count and page
  jumps are genuinely needed.
- Booleans are the words `true` / `false`.
- Never pass secrets or tokens as query parameters (they land in logs and
  browser history).

---

## 5. Request body — field naming

- JSON only. `Content-Type: application/json`.
- All keys are **`camelCase`**: `clientId`, `refreshToken`, `emailVerified`.
- Enum **values** are `SCREAMING_SNAKE_CASE` strings, never integers:
  `"role": "DOCTOR"`, `"status": "PENDING"`. This matches the JWT `role`
  claim and the DB.
- Timestamps are ISO-8601 UTC strings with a `Z`:
  `"2026-09-03T10:15:30Z"`. Field names end in `At`: `createdAt`,
  `approvedAt`, `lastLoginAt`.
- Identifiers end in `Id` (`userId`, `hospitalId`); a list of them ends in
  `Ids`.
- Durations in a field name carry their unit: `accessTokenTtlMin`,
  `refreshTokenTtlDays`. No bare `ttl`.
- Money, if it ever appears: integer minor units + a currency field
  (`amountPaise`, `currency: "INR"`). Never a float.

---

## 6. Response body

### 6.1 Success — single resource

Return the resource as a named object, not bare:

```json
{ "user": { "id": "…", "email": "…", "role": "DOCTOR", "status": "ACTIVE" } }
```

The wrapper key is the singular resource name. This leaves room to add
siblings later (`{ "user": {…}, "meta": {…} }`) without a breaking change.

### 6.2 Success — collection

```json
{ "users": [ {…}, {…} ], "nextCursor": "eyJpZCI6…" }
```

- The wrapper key is the plural resource name and its value is the array.
- `nextCursor` is `null` when there are no more pages.

### 6.3 Field naming

Same rules as the request body (§5): `camelCase` keys, `SCREAMING_SNAKE`
enum values, ISO-8601 `…At` timestamps, `…Id` identifiers.

### 6.4 Never

- No bare arrays as the top-level response (breaks extensibility, and is a
  historical JSON hijacking foot-gun).
- Don't return `null` fields you could omit — except where `null` is
  meaningful (`approvedAt: null` = "not yet approved").

---

## 7. Errors

Every service, every error, one shape:

```json
{ "error": { "code": "SOME_CODE", "message": "Human-readable, no PII." } }
```

- `code`: `SCREAMING_SNAKE_CASE`, stable, machine-branchable. This is the
  contract — clients switch on `code`, never on `message` or status alone.
- `message`: for a human reading logs. May change wording any time.
- Validation errors use `code: "VALIDATION_ERROR"` with `400` and add a
  `details` object (per-field messages).
- Code naming: name the reason, not the fix.
  `EMAIL_TAKEN`, `PENDING_APPROVAL`, `ROLE_NOT_ALLOWED`, `NOT_AUTHENTICATED`,
  `RATE_LIMITED`. Not `ERROR_1`, not `PLEASE_LOG_IN`.
- A given `code` maps to exactly one HTTP status across the platform.

---

## 8. HTTP status codes

| Status | When                                                              |
|--------|------------------------------------------------------------------|
| `200`  | `GET`, action, or update succeeded and returns a body            |
| `201`  | `POST` created a resource                                        |
| `204`  | Succeeded, no body (e.g. `logout`, some `DELETE`)                |
| `400`  | Malformed / failed validation (`VALIDATION_ERROR`, `UNKNOWN_*`)  |
| `401`  | No / bad / expired credentials (`NOT_AUTHENTICATED`)             |
| `403`  | Authenticated but not allowed (`FORBIDDEN`, `PENDING_APPROVAL`)  |
| `404`  | No such resource (`NOT_FOUND`)                                   |
| `409`  | Conflict with current state (`EMAIL_TAKEN`, `NOT_PENDING`)       |
| `422`  | Semantically invalid but well-formed (use sparingly; prefer 400)|
| `429`  | Rate limited (`RATE_LIMITED`)                                    |
| `500`  | Unhandled — never deliberately returned                          |
| `503`  | Dependency down / not configured (`SERVICE_UNAVAILABLE`)         |

401 vs 403: **401 = we don't know who you are; 403 = we know, and no.**

---

## 9. Standard endpoints every service exposes

| Endpoint                       | Auth | Purpose                                  |
|--------------------------------|------|------------------------------------------|
| `GET /health`                  | none | Liveness + real dependency check (`SELECT 1`). `200 {"status":"ok"}` / `503 {"status":"unavailable"}` |
| `GET /.well-known/jwks.json`   | none | **auth-issuing services only** — public signing keys |

`/health` is unversioned, does a real check (not a static `200`), and never
requires auth.

---

## 10. Authentication conventions

- Access token: `Authorization: Bearer <RS256 JWT>`. Nothing else carries
  identity — no `X-User-Id` header, no user id in the URL for "the current
  user" (use `/api/v1/users/me` if such a route is needed).
- Token claims, fixed platform-wide:
  - `sub` — user id
  - `role` — one `SCREAMING_SNAKE_CASE` string (`"DOCTOR"`)
  - `aud` — the portal `clientId` the token was issued for
  - `iss` — the issuing service's URL
  - `exp`, `iat` — standard
  - No permission lists, no org ids in the token. A downstream service
    decides what a `role` may do to *its* resources.
- Every service verifies tokens **locally** against `authservice`'s JWKS
  (fetch once, cache by `kid`, refetch on a `kid` miss). No per-request
  call back to `authservice`.
- Correlation: propagate `X-Request-Id` (create one if absent) on every
  inbound request and every outbound call. Custom headers are
  `X-Kebab-Case`.

---

## 11. Service-to-service calls

- Same URL and error conventions as public calls — there is no separate
  "internal" API shape.
- A service calls another over the internal network using the callee's
  service name as host: `http://appointmentservice/api/v1/appointments/{id}`.
- Auth for machine-to-machine calls is a service token (client-credentials
  style) with its own `role` (e.g. `"SERVICE"`), carried the same way:
  `Authorization: Bearer …`.
- Timeouts and retries are the **caller's** responsibility. Retry only
  idempotent methods (`GET`, `PUT`, `DELETE`), and only on `502/503/504`
  or a connection error — never on `4xx`.

---

## 12. `authservice` today — known deviations

New services follow §1–§11. `authservice` predates this doc and differs in:

- **Legacy unversioned aliases.** The pre-`/api/v1` paths (`/auth/*`,
  `/admin/users/*`) are still served, identical in behaviour, with a
  `Deprecation: true` response header, so un-updated clients keep working.
  They will be removed once every client has moved; new clients must use
  `/api/v1/auth/*`.
- **Auth paths are grouped by method, not resource** — `/api/v1/auth/email/*`,
  `/api/v1/auth/google/*`, `/api/v1/auth/token/refresh`. This is deliberate: the "resource"
  here is a session/token flow, not a CRUD entity, and the grouping reads
  better than `/sessions` would.
- **`GET /health` has no versioning and no JWKS-style `/.well-known`
  sibling** for its own liveness — that's fine, it matches §9.
- Some responses predate the "always wrap" rule (§6.1) and return fields at
  the top level (`{ "accessToken": …, "role": … }`). Login/refresh keep
  this shape for client compatibility; new endpoints wrap.

---

## 13. Checklist for a new endpoint

- [ ] Path is `/api/v1/`-prefixed, `kebab-case`, plural-noun resources, ≤ 1 level of nesting
- [ ] Method matches the semantics in §3; `GET` has no body and no side effects
- [ ] Non-CRUD operation is `POST /resource/{id}/verb`
- [ ] Path params `camelCase` and identify a resource; everything else is a query param
- [ ] Request + response keys `camelCase`; enum values `SCREAMING_SNAKE`; timestamps ISO-8601 `…At`
- [ ] Single resource wrapped under its singular name; collection under its plural name + `nextCursor`
- [ ] Errors are `{ "error": { "code", "message" } }` with a stable `SCREAMING_SNAKE` `code`
- [ ] Status code from §8; each `code` maps to exactly one status
- [ ] Auth via `Authorization: Bearer`; token verified locally via JWKS
- [ ] `X-Request-Id` propagated
