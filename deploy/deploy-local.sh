#!/usr/bin/env bash
# Deploy the current working checkout to EC2 without GitHub Actions.
# Usage:  EC2_HOST=1.2.3.4 EC2_USER=ubuntu EC2_SSH_KEY=~/.ssh/id_ed25519 bash deploy/deploy-local.sh
set -euo pipefail

: "${EC2_HOST:?set EC2_HOST}"
: "${EC2_USER:?set EC2_USER}"
SSH_KEY="${EC2_SSH_KEY:-$HOME/.ssh/id_ed25519}"
cd "$(dirname "$0")/.."

echo "==> build"
npm ci
npm run build

echo "==> assemble bundle"
rm -rf release && mkdir -p release
cp -r dist package.json package-lock.json prisma release/
cp -r deploy release/deploy

echo "==> upload"
rsync -az --delete --mkpath -e "ssh -i $SSH_KEY" \
  release/ "$EC2_USER@$EC2_HOST:/opt/authservice/releases/next/"

echo "==> activate"
ssh -i "$SSH_KEY" "$EC2_USER@$EC2_HOST" 'bash -s' < deploy/remote-release.sh

echo "==> health"
ssh -i "$SSH_KEY" "$EC2_USER@$EC2_HOST" \
  'curl -fsS --retry 5 --retry-delay 2 http://127.0.0.1:4000/health' && echo
