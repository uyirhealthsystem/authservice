#!/usr/bin/env bash
# One-time provisioning for a fresh Ubuntu 22.04/24.04 EC2 host.
# Run as a sudo-capable user:  bash setup-ec2.sh
set -euo pipefail

NODE_MAJOR=22
ROOT=/opt/authservice
SVC_USER=authservice
DEPLOY_USER=${SUDO_USER:-$USER}

echo "==> Node.js ${NODE_MAJOR}.x"
if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" != "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "==> service user + directories"
sudo useradd --system --create-home --home-dir "$ROOT" --shell /usr/sbin/nologin "$SVC_USER" 2>/dev/null || true
sudo mkdir -p "$ROOT/releases" "$ROOT/shared"
# The deploy user (GitHub Actions / deploy-local.sh) uploads releases and flips
# the 'current' symlink; the service user only needs to read the tree.
sudo chown -R "$DEPLOY_USER:$SVC_USER" "$ROOT"
sudo chmod -R g+rX "$ROOT"

echo "==> env file"
if [ ! -f "$ROOT/shared/authservice.env" ]; then
  sudo cp "$(dirname "$0")/authservice.env.example" "$ROOT/shared/authservice.env"
  # Readable by the deploy user (remote-release.sh sources it) and the service.
  sudo chown "$DEPLOY_USER:$SVC_USER" "$ROOT/shared/authservice.env"
  sudo chmod 640 "$ROOT/shared/authservice.env"
  echo "   -> edit $ROOT/shared/authservice.env before the first deploy"
fi

echo "==> systemd unit"
sudo cp "$(dirname "$0")/authservice.service" /etc/systemd/system/authservice.service
sudo systemctl daemon-reload
sudo systemctl enable authservice

echo "==> sudoers: let the deploy user restart the service without a password"
echo "$DEPLOY_USER ALL=(root) NOPASSWD: /bin/systemctl restart authservice, /bin/systemctl status authservice" \
  | sudo tee /etc/sudoers.d/authservice-deploy >/dev/null
sudo chmod 440 /etc/sudoers.d/authservice-deploy

cat <<EOF

Done. Next:
  1. Edit  $ROOT/shared/authservice.env   (DATABASE_URL, COOKIE_DOMAIN, Google...)
  2. Make sure the DB is reachable and the schema user can CREATE.
  3. Add these GitHub repo secrets (Settings > Secrets and variables > Actions):
       EC2_HOST     = this host's public DNS / IP
       EC2_USER     = $DEPLOY_USER
       EC2_SSH_KEY  = a private key whose public half is in ~$DEPLOY_USER/.ssh/authorized_keys
  4. Push to main - the CI/CD workflow deploys here.
     Or deploy the current checkout manually:  bash deploy/deploy-local.sh
EOF
