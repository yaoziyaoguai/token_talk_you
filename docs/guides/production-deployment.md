# Token Talk production deployment

## Runtime boundary

Production intentionally has three boundaries:

1. Nginx owns the public ingress and Basic Auth. Only `/api/health` is unauthenticated.
2. The Studio container binds to host loopback and receives no Codex credentials.
3. `token-talk-codex-broker` runs as a dedicated systemd user and exposes only a group-restricted Unix socket.

The browser mutation token is CSRF protection, not user authentication. Do not expose port 4321 directly to the Internet.

## One-time Alibaba Cloud setup

Install Docker Engine, Docker Compose v2, Nginx, `apache2-utils`, curl, Git, Node 22 and the Codex CLI. Then initialize the dedicated broker account:

```bash
sudo bash scripts/setup-codex-broker-host.sh
```

The first run may stop and ask the operator to install/login Codex as `token-talk-codex`. Follow the printed `runuser` command and rerun setup. The script never copies another Linux user's `auth.json`.

Create the production environment without committing it:

```bash
cp .env.prod.example .env.prod
chmod 600 .env.prod
```

Set the exact public origin, research contact, a random NewsNow JWT secret, and only the paid provider keys that are actually used. `TOKEN_TALK_CODEX_SOCKET_GID` is derived from the host group by the deploy script.

When upgrading an older deployment, replace the former `NODE_IMAGE` and `DEBIAN_MIRROR_ORIGIN` entries with `TOKEN_TALK_BUILD_NODE_IMAGE`, `TOKEN_TALK_NPM_REGISTRY`, and `ALPINE_MIRROR`. Also replace tag-based `NEWSNOW_IMAGE` and `DAILYHOT_IMAGE` values with the digest-pinned references from the current example file. Deployment stops before changing production if either supporting image is not pinned to a SHA-256 digest. The production default uses `registry.npmmirror.com`; CI overrides it with the official npm registry, and the image build preserves downloaded packages across bounded install retries.

While mainland ICP interception blocks the domain, bootstrap Nginx with a temporary self-signed certificate. This certificate is only used long enough to request a publicly trusted short-lived IP certificate; do not use the Studio through a browser warning:

```bash
sudo install -d -m 700 /etc/nginx/ssl/token-talk-ip
sudo openssl req -x509 -nodes -newkey rsa:3072 -sha256 -days 365 \
  -subj '/CN=182.92.85.15' \
  -addext 'subjectAltName=IP:182.92.85.15,DNS:talk.wangjinkun333.me' \
  -keyout /etc/nginx/ssl/token-talk-ip/server.key \
  -out /etc/nginx/ssl/token-talk-ip/server.crt
sudo chmod 600 /etc/nginx/ssl/token-talk-ip/server.key
```

Configure the ingress:

```bash
sudo htpasswd -c /etc/nginx/token-talk.htpasswd token-talk-editor
sudo cp deploy/nginx/talk.wangjinkun333.me.conf /etc/nginx/sites-available/talk.wangjinkun333.me
sudo ln -s /etc/nginx/sites-available/talk.wangjinkun333.me /etc/nginx/sites-enabled/talk.wangjinkun333.me
sudo nginx -t
sudo systemctl reload nginx
```

Install Certbot 5.4 or newer and validate IP issuance against Let's Encrypt staging before touching the live certificate:

```bash
sudo snap install certbot --classic
sudo install -d -m 755 /var/www/token-talk-acme /etc/letsencrypt/renewal-hooks/deploy
sudo /snap/bin/certbot certonly --staging --non-interactive --agree-tos --register-unsafely-without-email \
  --preferred-profile shortlived --webroot --webroot-path /var/www/token-talk-acme \
  --ip-address 182.92.85.15 --cert-name token-talk-ip-staging
sudo /snap/bin/certbot delete --non-interactive --cert-name token-talk-ip-staging
```

Install the atomic deploy hook, then issue the trusted six-day certificate. The Certbot snap renew timer reuses the same webroot and runs the hook after every successful renewal:

```bash
sudo install -m 755 deploy/certbot/token-talk-ip-deploy-hook.sh \
  /etc/letsencrypt/renewal-hooks/deploy/token-talk-ip-deploy-hook.sh
sudo /snap/bin/certbot certonly --non-interactive --agree-tos --register-unsafely-without-email \
  --preferred-profile shortlived --webroot --webroot-path /var/www/token-talk-acme \
  --ip-address 182.92.85.15 --cert-name 182.92.85.15
sudo /snap/bin/certbot renew --dry-run --no-random-sleep-on-renew --cert-name 182.92.85.15
sudo systemctl list-timers 'snap.certbot.renew*'
```

Port 80 exposes only the ACME challenge, `/api/health`, and an HTTPS redirect. Add the free Alidns `A` record `talk -> 182.92.85.15`; after ICP access is available, obtain a trusted domain certificate, change `TOKEN_TALK_PUBLIC_ORIGIN` to `https://talk.wangjinkun333.me`, and replace the temporary IP-only TLS server.

## Release paths

GitHub Actions follows the same proven boundary as VideoFactory. The Ubuntu runner verifies a root-path image with `public.ecr.aws/docker/library/node:22-alpine`. After tests pass, the deploy job checks out the exact commit on ECS, where the application is rebuilt with the cached `node:22-alpine` base and Alibaba Cloud's internal Alpine mirror.

NewsNow and DailyHot are free self-hosted services pinned by image digest. The deploy script reuses local images when present and only pulls a missing digest before any production component changes. The final Compose switch always uses `--pull never`.

For an authorized manual recovery, run from the repository checkout:

```bash
TOKEN_TALK_ENV_FILE="$PWD/.env.prod" bash scripts/deploy-production.sh
```

The script prepares all images before mutation, backs up the workspace volume, extracts the broker artifact, atomically installs the repository-owned systemd unit, reloads and restarts the broker, starts the containers without pulling during the switch, and checks both health boundaries. The broker remains single-concurrency and allows up to 720 seconds per schema-bounded Codex task. After the first healthy release, later failures restore the previous broker release, systemd unit, and application image.

## GitHub Actions secrets

- `SERVER_HOST`: ECS address reachable by SSH.
- `SERVER_USER`: deployment user with Docker and systemd permissions.
- `SSH_PRIVATE_KEY`: deployment SSH key.
- `SERVER_FINGERPRINT`: trusted SHA256 fingerprint of the ECS SSH host key.
- `PROJECT_PATH`: persistent server checkout containing `.env.prod`.
- `PUBLIC_HEALTH_URL`: use the unauthenticated, non-sensitive `http://182.92.85.15/api/health` during the ICP-blocked phase, then switch to `https://talk.wangjinkun333.me/api/health`.

The GitHub runner never receives the Codex login or paid provider keys. ECS receives no registry credential from GitHub.

## Operator checks

```bash
curl --unix-socket /run/token-talk-codex/worker.sock http://localhost/health
curl http://127.0.0.1:4321/api/health
docker compose --project-name token-talk --env-file .env.prod -f docker/docker-compose.prod.yml ps
journalctl -u token-talk-codex-broker --since '10 minutes ago'
```

Before the first paid TTS run, verify the selected provider, model, exact version hashes, character count, estimated cash, rights basis, and the one-attempt authorization shown in Studio.
