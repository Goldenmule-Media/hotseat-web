# Deploying wiki-server

A single EC2 instance running **Postgres + wiki-server + Caddy** via `docker compose`.
Postgres holds the wiki read model; wiki-server is the Durable Streams host with the
embedded wiki-mcp and the GitHub auth gateway; Caddy terminates TLS (Let's Encrypt) in
front of the gateway. The browser app (`wiki-ui`) deploys separately (AWS Amplify) and
points at this server.

The image builds **only wiki-server** (its `wiki`/`wiki-mcp` deps are bundled into
`dist/main.js`). The page-type schema (`wiki-models`) is **not** baked in: `deploy.sh`
builds the bundles locally, rsyncs them to `~/wiki-server/models`, and compose
bind-mounts that at `/models` (`WIKI_SERVER_MODELS_DIR`). So a schema-only change ships by
re-running `deploy.sh` — no server image rebuild.

```
Internet ─→ :443 caddy (TLS, Let's Encrypt) ─→ wiki-server :4437 (auth gateway) ─┐
            :80  caddy (ACME + HTTP→HTTPS)                                        ▼
                                                              postgres (read model, internal)
```

wiki-server is **not** published publicly — Caddy reaches it over the compose network
(`:4437` is bound to host loopback only, for debugging). TLS is the only public path.

## 1. Provision an EC2 instance

1. **EC2 → Launch Instance**:
   - **AMI**: Ubuntu 24.04 LTS
   - **Instance type**: `t3.small` (2 GB RAM) — the build runs `npm ci` + tsdown on the box
   - **Storage**: 20 GB gp3
   - **Key pair**: select/create your SSH key
2. **Security group** inbound rules:

   | Port | Source    | Purpose                                   |
   |------|-----------|-------------------------------------------|
   | 22   | Your IP   | SSH                                       |
   | 80   | 0.0.0.0/0 | ACME challenge + HTTP→HTTPS redirect (Caddy) |
   | 443  | 0.0.0.0/0 | HTTPS — the public surface (Caddy → gateway) |

   Both 80 and 443 must be open for Let's Encrypt to issue the certificate.
3. **DNS**: point an A record for your domain (e.g. `hotseat.thegoldenmule.com`) at the
   instance's public IP. This is required before deploying — Caddy validates domain
   ownership against it during the ACME challenge.

## 2. Configure secrets

```bash
cp .env.example .env
```

Fill in `.env` (gitignored — never committed):

- `POSTGRES_PASSWORD` — a strong random value (`openssl rand -base64 24`)
- `WIKI_DOMAIN` — the public hostname Caddy serves TLS for (e.g. `hotseat.thegoldenmule.com`)
- `WIKI_SERVER_GITHUB_CLIENT_ID` / `WIKI_SERVER_GITHUB_CLIENT_SECRET` — from a GitHub OAuth App
- `WIKI_SERVER_PUBLIC_URL` — `https://${WIKI_DOMAIN}` (the https URL browsers/GitHub reach).
  **The OAuth App's callback URL must be exactly `${WIKI_SERVER_PUBLIC_URL}/auth/github/callback`.**
- `WIKI_SERVER_UI_ORIGINS` — where `wiki-ui` runs (its Amplify URL)
- `WIKI_SERVER_AUTH_USERS` — comma-separated GitHub logins allowed to sign in

## 3. First-time setup (install Docker on the instance)

```bash
./setup.sh -i ~/.ssh/your-key.pem ubuntu@<public-ip>
```

Then log out/in (or `newgrp docker`) on the remote so the docker group applies.

## 4. Deploy

```bash
./deploy.sh -i ~/.ssh/your-key.pem ubuntu@<public-ip>
```

This builds the `wiki-models` bundles locally, rsyncs the repo + bundles to
`~/wiki-server` (bundles → `~/wiki-server/models`), copies your `.env`, and runs
`docker compose up -d --build`, then waits for all three containers, the gateway, and a
valid cert at `https://$WIKI_DOMAIN/auth/config`. Re-run it any time to ship updates —
including schema-only changes, which reload from the `/models` mount without rebuilding the
image.

> Requires Node + npm on the machine you run `deploy.sh` from (it builds `wiki-models`).
> The EC2 host needs only Docker.
>
> **First deploy:** Caddy obtains the Let's Encrypt cert during boot via the ACME
> challenge — this needs DNS already pointing at the host and ports 80+443 open, and can
> take 10–60s. `deploy.sh` retries the TLS check for ~90s.

## 5. Verify

```bash
curl https://<your-domain>/auth/config        # {"enabled":true,"provider":"github"}
```

A clean `200` over `https` (no cert warning) confirms TLS is working. Point `wiki-ui` at
`NEXT_PUBLIC_WIKI_STREAM_BASE_URL=https://<your-domain>` (and the matching
`NEXT_PUBLIC_WIKI_NAMESPACE`), sign in with GitHub, and the first user to open a workspace
claims it as owner.

## Operations

SSH in (`ssh -i … ubuntu@<public-ip>`), then from `~/wiki-server`:

```bash
docker compose ps                       # container status
docker compose logs -f wiki-server      # server logs (JSON)
docker compose logs -f caddy            # TLS / cert issuance
docker compose logs -f postgres
docker compose restart wiki-server
docker compose down                     # stop (volumes persist)
```

- **Data**: durable stream events, the auth ledger (`/data/auth/access.json`), and the
  session secret live in the `wikidata` volume; the read model lives in `pgdata`; issued
  certs + ACME state live in `caddy_data`. All survive `down`/`up` and redeploys. The read
  model is a pure projection — if `pgdata` is ever lost, wiki-server rebuilds it from the
  stream on next boot.
- **Migrations** run automatically on startup; Postgres creates the `wiki` database on
  first boot from `POSTGRES_DB`.
- **Rotating `WIKI_SERVER_SESSION_SECRET`** signs every user out (the revocation lever for
  the stateless bearer sessions).

## TLS

Caddy (the `caddy` compose service) terminates TLS and **auto-obtains + auto-renews** a
Let's Encrypt certificate for `WIKI_DOMAIN` — no certbot, no cron, no manual steps. It
proxies to the gateway over the internal network; wiki-server itself is never exposed
publicly. GitHub OAuth marks the session cookie `Secure` automatically because
`WIKI_SERVER_PUBLIC_URL` is `https://`.

Cert issuance needs, on first boot: **DNS for `WIKI_DOMAIN` → this host**, and **ports 80
+ 443 open**. If `https://` fails, that's almost always one of those two — check
`docker compose logs caddy`. Issued certs persist in the `caddy_data` volume, so restarts
and redeploys reuse them (no Let's Encrypt rate-limit risk).

Prefer to terminate TLS elsewhere (AWS ALB + ACM, or Cloudflare proxy)? Drop the `caddy`
service, publish wiki-server's `4437` to your proxy instead, and keep `WIKI_SERVER_PUBLIC_URL`
as the external `https://` URL.

## Cost

`t3.small` ≈ $15/mo + ~$1.60/mo for 20 GB gp3. `t3.micro` (1 GB) can *run* the stack but
may OOM during the in-place image build — build on a larger box or prebuild the image.
