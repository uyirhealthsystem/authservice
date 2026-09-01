# authservice

Identity microservice for the Uyir platform. A user's role is decided
entirely by which portal/app (`clientId`) they register and log in
through — see `src/lib/portals.ts`. Issues RSA-signed access + refresh
tokens via Google OAuth or email/password; other microservices verify
tokens independently through JWKS, with no call back to this service.

## Quick start

```bash
npm install
cp .env.example .env            # edit DATABASE_URL
npx prisma migrate deploy
npm run keys:bootstrap
npm run dev
```

Server listens on `http://localhost:4000` (`PORT` in `.env`).

```bash
npm test    # Vitest + supertest integration suite — see docs/TESTING.md
```

## Docs

- [`docs/STORY_GUIDE.md`](docs/STORY_GUIDE.md) — start here: a narrative
  walkthrough of a patient, a doctor, and an attacker all using the system.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system design and why
  each non-obvious decision was made.
- [`docs/API.md`](docs/API.md) — every HTTP endpoint, including how another
  microservice should verify tokens via JWKS.
- [`docs/LEARNING_GUIDE.md`](docs/LEARNING_GUIDE.md) — concept-first
  explanations (JWKS/key rotation, refresh rotation + reuse detection, PKCE,
  portal-decides-role).
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — operational setup, environment
  variables, key rotation, deployment/cookie gotchas, troubleshooting.
- [`docs/TESTING.md`](docs/TESTING.md) — the Vitest + supertest integration
  suite, how to run it against a throwaway Postgres.
- [`docs/CICD.md`](docs/CICD.md) — the GitHub Actions pipeline and how it
  builds, tests, and deploys to an AWS EC2 host.
- [`docs/postman/authservice.postman_collection.json`](docs/postman/authservice.postman_collection.json) —
  import into Postman: health/JWKS checks, the register/login/refresh/logout
  flow, one example per portal, and a runnable demo proving web+app shared
  accounts, cross-portal rejection, and refresh-token reuse detection.

## Tech

Express 5 + TypeScript, PostgreSQL + Prisma, `jose` for JWT/JWKS/PKCE,
`bcryptjs` for passwords, `zod` for request validation.
