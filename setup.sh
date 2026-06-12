#!/bin/bash
# Provision a fresh EC2 instance with Docker + compose. Idempotent. Then run ./deploy.sh.
#   ./setup.sh -i ~/.ssh/your-key.pem ubuntu@<public-ip>
set -euo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[setup]${NC} $1"; }
warn()  { echo -e "${YELLOW}[setup]${NC} $1"; }
fail()  { echo -e "${RED}[setup]${NC} $1"; exit 1; }

usage() {
  cat <<'EOF'
Usage: ./setup.sh [-i <key.pem>] <user@host>

  -i <key.pem>   SSH identity file (e.g., -i ~/.ssh/wiki.pem)
  <user@host>    SSH target (e.g., ubuntu@1.2.3.4)

Installs Docker Engine + the docker compose plugin on the remote host.
Run once per instance; then run ./deploy.sh to deploy.
EOF
  exit 1
}

HOST=""
SSH_KEY=""
SSH_OPTS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) usage ;;
    -i) SSH_KEY="$2"; shift 2 ;;
    *) HOST="$1"; shift ;;
  esac
done

[[ -z "$HOST" ]] && fail "Missing <user@host> argument. Run with --help for usage."
if [[ -n "$SSH_KEY" ]]; then
  [[ ! -f "$SSH_KEY" ]] && fail "SSH key not found: $SSH_KEY"
  SSH_OPTS="-i $SSH_KEY"
fi

info "Provisioning $HOST (Docker Engine + compose plugin)..."
ssh $SSH_OPTS "$HOST" 'bash -s' <<'REMOTE_SETUP'
set -euo pipefail

if ! command -v docker &>/dev/null; then
  echo "Installing Docker..."
  curl -fsSL https://get.docker.com | sudo sh
  sudo systemctl enable docker
  sudo systemctl start docker
  sudo usermod -aG docker "$USER"
  echo "Docker installed."
else
  echo "Docker already installed, skipping."
fi

if docker compose version &>/dev/null || sudo docker compose version &>/dev/null; then
  echo "docker compose plugin present."
else
  echo "Installing docker compose plugin..."
  sudo apt-get update -y
  sudo apt-get install -y docker-compose-plugin
fi

echo "Provisioning complete."
REMOTE_SETUP

info "Setup complete on $HOST"
info "Log out and back in (or run 'newgrp docker') before deploying, then:"
info "  ./deploy.sh $SSH_OPTS $HOST"
