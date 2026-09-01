# authservice — CI/CD (GitHub Actions → AWS EC2)

`.github/workflows/ci-cd.yml` has two jobs:

```
push / PR ─▶ test ──(main only)──▶ deploy ─▶ EC2
```

### `test` (every push + PR)
Postgres 16 service container, then `npm ci` → `prisma migrate deploy` →
`npm run typecheck` → `npm test` → `npm run build`.

### `deploy` (push to `main` only, needs `test` green)
1. `npm ci` + `npm run build` on the runner.
2. Bundle `dist/ package.json package-lock.json prisma/ deploy/` into `release/`.
3. `rsync` the bundle to `EC2_HOST:/opt/authservice/releases/next/`.
4. SSH in and run `deploy/remote-release.sh`, which:
   - promotes `releases/next` → `releases/<timestamp>`,
   - `npm ci --omit=dev` (runs `prisma generate` via `postinstall`),
   - `npx prisma migrate deploy`,
   - `node dist/scripts/ensureSigningKey.js` (idempotent — no-op once a key exists),
   - repoints `/opt/authservice/current` → the new release,
   - `sudo systemctl restart authservice`,
   - keeps the last 5 releases, deletes older ones.
5. `curl http://127.0.0.1:4000/health` on the box as a smoke test.

Rollback = point `current` at the previous `releases/*` dir and
`sudo systemctl restart authservice` (migrations are not auto-reverted).

## One-time EC2 setup

On a fresh Ubuntu 22.04/24.04 instance (open the app port / put it behind an
ALB or nginx separately):

```bash
scp -r deploy ubuntu@EC2_HOST:/tmp/deploy
ssh ubuntu@EC2_HOST 'bash /tmp/deploy/setup-ec2.sh'
ssh ubuntu@EC2_HOST 'sudo -u authservice nano /opt/authservice/shared/authservice.env'
```

`setup-ec2.sh` installs Node 22, creates the `authservice` system user and
`/opt/authservice/{releases,shared}`, installs the systemd unit
(`deploy/authservice.service`), and grants the deploy user a NOPASSWD sudoers
entry limited to `systemctl restart/status authservice`.

Postgres: use RDS (recommended) or install it on the box. The DB user in
`DATABASE_URL` must be able to run migrations (DDL).

## GitHub configuration

Repo → Settings → Secrets and variables → Actions → **New repository secret**:

| Secret | Value |
|---|---|
| `EC2_HOST` | public DNS or IP of the instance |
| `EC2_USER` | SSH user (e.g. `ubuntu`) — same user `setup-ec2.sh` ran as |
| `EC2_SSH_KEY` | private key (full PEM) whose public half is in that user's `~/.ssh/authorized_keys` |

The `deploy` job uses a GitHub **Environment** named `production` — add
required reviewers there if you want a manual approval gate before each
deploy.

## Deploying without GitHub

The repo isn't a git repo yet. Until it's pushed to GitHub you can deploy the
working checkout straight from your machine:

```bash
EC2_HOST=1.2.3.4 EC2_USER=ubuntu EC2_SSH_KEY=~/.ssh/authservice.pem \
  bash deploy/deploy-local.sh
```

It does exactly what the `deploy` job does (build → rsync → `remote-release.sh`
→ health check).

## Files

| Path | Purpose |
|---|---|
| `.github/workflows/ci-cd.yml` | the pipeline |
| `deploy/setup-ec2.sh` | one-time host provisioning |
| `deploy/authservice.service` | systemd unit |
| `deploy/authservice.env.example` | template for `/opt/authservice/shared/authservice.env` |
| `deploy/remote-release.sh` | runs on the host per deploy (promote + migrate + restart) |
| `deploy/deploy-local.sh` | manual deploy from a workstation |
