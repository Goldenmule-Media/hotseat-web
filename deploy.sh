#!/bin/bash
# Deploy the stack to an EC2 host: rsync repo + built model bundles, copy .env, build and
# bring up docker compose on the remote, then health-check. Re-run to ship updates.
#   ./deploy.sh -i ~/.ssh/your-key.pem ubuntu@<public-ip>
# Run ./setup.sh once first to install Docker. See DEPLOY.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[deploy]${NC} $1"; }
warn()  { echo -e "${YELLOW}[deploy]${NC} $1"; }
fail()  { echo -e "${RED}[deploy]${NC} $1"; exit 1; }

usage() {
  cat <<'EOF'
Usage: ./deploy.sh [-i <key.pem>] <user@host>

  -i <key.pem>   SSH identity file (e.g., -i ~/.ssh/wiki.pem)
  <user@host>    SSH target (e.g., ubuntu@1.2.3.4)

Expects a .env in the repo root (copy from .env.example, fill in POSTGRES_PASSWORD and
the WIKI_SERVER_* GitHub-auth settings). See DEPLOY.md for full instructions.
EOF
  exit 1
}

HOST=""
SSH_KEY=""
SSH_OPTS=""
REMOTE_DIR="~/wiki-server"

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

ENV_FILE="$SCRIPT_DIR/.env"
[[ ! -f "$ENV_FILE" ]] && fail ".env not found. Copy .env.example to .env and fill in values."

# Public hostname for the TLS check: WIKI_DOMAIN, else stripped from WIKI_SERVER_PUBLIC_URL.
DOMAIN="$(sed -n 's/^WIKI_DOMAIN=//p' "$ENV_FILE" | tr -d '"'"'"' \r' | head -1)"
[[ -z "$DOMAIN" ]] && DOMAIN="$(sed -n 's#^WIKI_SERVER_PUBLIC_URL=https\?://##p' "$ENV_FILE" | tr -d '"'"'"' \r' | sed 's#/.*##' | head -1)"
[[ -z "$DOMAIN" ]] && fail "Set WIKI_DOMAIN in .env (the public hostname Caddy serves TLS for)."

LOCAL_SHA="$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
info "Deploying $LOCAL_SHA to $HOST:$REMOTE_DIR ..."

info "Building wiki-models bundles ..."
( cd "$SCRIPT_DIR" && npm run build -w wiki-models >/dev/null ) || fail "wiki-models build failed."
[[ -d "$SCRIPT_DIR/wiki-models/dist" ]] || fail "wiki-models/dist missing after build."

RSYNC_ARGS=(-az --delete)
[[ -n "$SSH_KEY" ]] && RSYNC_ARGS+=(-e "ssh -i $SSH_KEY")

info "Syncing project ..."
rsync "${RSYNC_ARGS[@]}" \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '**/node_modules' \
  --exclude '**/dist' \
  --exclude 'wiki-ui' \
  --exclude '.wiki-data' \
  --exclude '**/.wiki-data' \
  --exclude '.env' \
  --exclude '/models' \
  --exclude '*.log' \
  "$SCRIPT_DIR/" "$HOST:$REMOTE_DIR/"

info "Syncing model bundles -> $REMOTE_DIR/models ..."
rsync "${RSYNC_ARGS[@]}" "$SCRIPT_DIR/wiki-models/dist/" "$HOST:$REMOTE_DIR/models/"

info "Copying .env ..."
scp $SSH_OPTS "$ENV_FILE" "$HOST:$REMOTE_DIR/.env"

info "Building image and starting stack on remote ..."
ssh $SSH_OPTS "$HOST" "bash -s" <<REMOTE_DEPLOY || fail "Remote build/up failed — see output above."
set -euo pipefail
cd $REMOTE_DIR
docker compose up -d --build
# A Caddyfile edit doesn't trigger a recreate (file content isn't in the compose
# config hash, and the single-file bind mount pins the old inode) — force it.
docker compose up -d --force-recreate caddy
REMOTE_DEPLOY

info "Verifying services are healthy ..."
ssh $SSH_OPTS "$HOST" "bash -s" <<REMOTE_CHECK || fail "Health check failed — services may be crash-looping. Check: docker compose -f $REMOTE_DIR/docker-compose.yml logs"
set -euo pipefail
cd $REMOTE_DIR

check_running() {
  local svc="\$1" cid state
  for _ in \$(seq 1 20); do
    cid="\$(docker compose ps -q "\$svc" 2>/dev/null || true)"
    if [ -n "\$cid" ]; then
      state="\$(docker inspect -f '{{.State.Status}}' "\$cid" 2>/dev/null || echo unknown)"
      [ "\$state" = "running" ] && { echo "  \$svc -> running"; return 0; }
    fi
    sleep 2
  done
  echo "ERROR: \$svc not running (last state: \${state:-none})"
  docker compose logs --tail 40 "\$svc" || true
  return 1
}

check_running postgres
check_running wiki-server
check_running caddy

# Gateway up on loopback.
for _ in \$(seq 1 15); do
  code="\$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:4437/auth/config 2>/dev/null || echo 000)"
  if [ "\$code" = "200" ]; then echo "  gateway (loopback) /auth/config -> 200"; break; fi
  sleep 2
done
[ "\$code" = "200" ] || { echo "ERROR: gateway not answering on loopback (last: \${code:-none})"; docker compose logs --tail 40 wiki-server; exit 1; }

# Public TLS through Caddy — retry ~90s for first-boot ACME issuance.
for _ in \$(seq 1 30); do
  tls="\$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 https://$DOMAIN/auth/config 2>/dev/null || echo 000)"
  if [ "\$tls" = "200" ]; then echo "  https://$DOMAIN/auth/config -> 200 (valid cert)"; exit 0; fi
  sleep 3
done
echo "ERROR: https://$DOMAIN did not serve a valid cert / 200 (last: \${tls:-none})."
echo "  Check: DNS A record for $DOMAIN → this host, security-group ports 80 + 443 open, then:"
echo "  docker compose logs caddy"
docker compose logs --tail 40 caddy || true
exit 1
REMOTE_CHECK

info "Deployed successfully!"
info "Gateway:  https://$DOMAIN  (TLS via Caddy — Let's Encrypt, auto-renewing)"
info "Logs:     ssh $SSH_OPTS $HOST 'cd ${REMOTE_DIR/#\~/~} && docker compose logs -f wiki-server caddy'"
