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
Usage: ./deploy.sh [-i <key.pem>] [--timeout <seconds>] <user@host>

  -i <key.pem>       SSH identity file (e.g., -i ~/.ssh/wiki.pem)
  --timeout <secs>   How long to wait for wiki-server to become READY
                     (default 420, or $WIKI_DEPLOY_TIMEOUT). A cold read model
                     replays the whole stream on first boot — that is slow, not broken.
  <user@host>        SSH target (e.g., ubuntu@1.2.3.4)

Expects a .env in the repo root (copy from .env.example, fill in POSTGRES_PASSWORD and
the WIKI_SERVER_* GitHub-auth settings). See DEPLOY.md for full instructions.
EOF
  exit 1
}

HOST=""
SSH_KEY=""
SSH_OPTS=""
REMOTE_DIR="~/wiki-server"
READY_TIMEOUT="${WIKI_DEPLOY_TIMEOUT:-420}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) usage ;;
    -i) SSH_KEY="$2"; shift 2 ;;
    --timeout) READY_TIMEOUT="$2"; shift 2 ;;
    *) HOST="$1"; shift ;;
  esac
done

[[ "$READY_TIMEOUT" =~ ^[0-9]+$ ]] || fail "--timeout takes seconds (got: $READY_TIMEOUT)"

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

info "Waiting for services to become ready (up to ${READY_TIMEOUT}s) ..."
CHECK_RC=0
ssh $SSH_OPTS "$HOST" "bash -s" <<REMOTE_CHECK || CHECK_RC=$?
# NOT set -e: only the checks below decide what is fatal. Exit codes: 1 crashed,
# 2 not ready in time, 3 public TLS.
set -uo pipefail
cd $REMOTE_DIR

insp() { docker inspect -f "\$2" "\$1" 2>/dev/null || echo ""; }
last_msg() { docker compose logs --tail 8 "\$1" 2>/dev/null | sed -n 's/.*"msg":"\([^"]*\)".*/\1/p' | tail -1; }

# Two different questions, kept apart: LIVENESS ("is it alive and not looping?") is what
# fails a deploy fast; READINESS ("does its probe pass?") is what we WAIT for. A service
# with no healthcheck declares readiness by running.
wait_ready() {
  local svc="\$1" budget="\$2" deadline cid state health restarts base="" now noted=0 left
  deadline=\$(( \$(date +%s) + budget ))
  while :; do
    cid="\$(docker compose ps -q "\$svc" 2>/dev/null || true)"
    if [ -n "\$cid" ]; then
      state="\$(insp "\$cid" '{{.State.Status}}')"
      health="\$(insp "\$cid" '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')"
      restarts="\$(insp "\$cid" '{{.RestartCount}}')"
      [ -z "\$base" ] && base="\${restarts:-0}"
      # The ONLY fast failure. Slow-but-alive never lands here.
      if [ "\$state" = exited ] || [ "\$state" = dead ] || [ "\${restarts:-0}" -gt "\$base" ]; then
        echo "  \$svc -> CRASHED (state: \$state, restarts: \${restarts:-0})"
        docker compose logs --tail 40 "\$svc"
        return 1
      fi
      if [ "\$state" = running ] && [ "\$health" = healthy ]; then echo "  \$svc -> ready (healthy)"; return 0; fi
      if [ "\$state" = running ] && [ "\$health" = none ]; then echo "  \$svc -> running (no readiness probe)"; return 0; fi
    fi
    now=\$(date +%s)
    left=\$(( deadline - now ))
    if [ "\$left" -le 0 ]; then
      echo "  \$svc -> NOT READY YET (state: \${state:-none}, health: \${health:-none})"
      docker compose logs --tail 20 "\$svc"
      return 2
    fi
    if [ \$(( now - noted )) -ge 15 ]; then
      noted=\$now
      echo "  \$svc: \${health:-starting} — \$(last_msg "\$svc" || true) (\${left}s left)"
    fi
    sleep 3
  done
}

wait_ready postgres 120 || exit \$?
wait_ready wiki-server $READY_TIMEOUT || exit \$?
wait_ready caddy 60 || exit \$?

# Ready means the gateway is listening, so this should answer at once.
for _ in \$(seq 1 10); do
  code="\$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:4437/auth/config 2>/dev/null || echo 000)"
  [ "\$code" = "200" ] && { echo "  gateway (loopback) /auth/config -> 200"; break; }
  sleep 2
done
[ "\${code:-000}" = "200" ] || { echo "ERROR: gateway not answering on loopback (last: \${code:-none})"; docker compose logs --tail 40 wiki-server; exit 1; }

# Public TLS through Caddy — retry ~90s for first-boot ACME issuance.
for _ in \$(seq 1 30); do
  tls="\$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 https://$DOMAIN/auth/config 2>/dev/null || echo 000)"
  [ "\$tls" = "200" ] && { echo "  https://$DOMAIN/auth/config -> 200 (valid cert)"; exit 0; }
  sleep 3
done
echo "ERROR: https://$DOMAIN did not serve a valid cert / 200 (last: \${tls:-none})."
docker compose logs --tail 40 caddy || true
exit 3
REMOTE_CHECK

case "$CHECK_RC" in
  0) ;;
  2) fail "Timed out after ${READY_TIMEOUT}s. The stack is still STARTING, not crashed — a cold read
    model replays the whole stream before the server accepts traffic. Give it longer:
      WIKI_DEPLOY_TIMEOUT=900 $0 ${SSH_KEY:+-i $SSH_KEY} $HOST
    or watch it come up: ssh $SSH_OPTS $HOST 'cd ${REMOTE_DIR/#\~/~} && docker compose logs -f wiki-server'
    (it is up when the log says \"wiki-server ready\"; docker compose ps shows the same as (healthy))." ;;
  3) fail "Services are ready, but https://$DOMAIN is not serving a valid cert yet. Check the DNS A
    record for $DOMAIN points at this host and ports 80 + 443 are open, then: docker compose logs caddy" ;;
  *) fail "Health check failed — services are crash-looping. Check: docker compose -f $REMOTE_DIR/docker-compose.yml logs" ;;
esac

info "Deployed successfully!"
info "Gateway:  https://$DOMAIN  (TLS via Caddy — Let's Encrypt, auto-renewing)"
info "Logs:     ssh $SSH_OPTS $HOST 'cd ${REMOTE_DIR/#\~/~} && docker compose logs -f wiki-server caddy'"
