#!/usr/bin/env bash
# Runs ON the EC2 host (piped in over SSH by the GitHub Actions deploy job).
# Promotes the freshly-uploaded release in /opt/authservice/releases/next,
# runs migrations, ensures a signing key, and restarts the service.
set -euo pipefail

ROOT=/opt/authservice
ENV_FILE="$ROOT/shared/authservice.env"
KEEP=5

[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE - run deploy/setup-ec2.sh first"; exit 1; }
[ -d "$ROOT/releases/next" ] || { echo "no uploaded release at $ROOT/releases/next"; exit 1; }

TS=$(date +%Y%m%d%H%M%S)
REL="$ROOT/releases/$TS"
mv "$ROOT/releases/next" "$REL"
cd "$REL"

# DATABASE_URL etc. for the migrate / key steps below.
set -a; . "$ENV_FILE"; set +a
export NODE_ENV=production

echo "==> installing production dependencies"
npm ci --omit=dev

echo "==> applying database migrations"
npx prisma migrate deploy

echo "==> ensuring a signing key exists"
node dist/scripts/ensureSigningKey.js

echo "==> switching 'current' symlink -> $TS"
ln -sfn "$REL" "$ROOT/current"

echo "==> restarting service"
sudo systemctl restart authservice

echo "==> pruning old releases (keeping last $KEEP)"
ls -1dt "$ROOT"/releases/*/ | tail -n +$((KEEP + 1)) | xargs -r rm -rf

echo "==> deployed $TS"
