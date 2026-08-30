# Token Talk production deployment

## Runtime boundary

Production intentionally has three boundaries:

1. Nginx terminates HTTPS and Basic Auth. Only `/api/health` is unauthenticated.
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

Set the exact HTTPS origin, research contact, a random NewsNow JWT secret, and only the paid provider keys that are actually used. `TOKEN_TALK_CODEX_SOCKET_GID` is derived from the host group by the deploy script.

When upgrading an older deployment, replace the former `NODE_IMAGE` and `DEBIAN_MIRROR_ORIGIN` entries with `TOKEN_TALK_BUILD_NODE_IMAGE` and `ALPINE_MIRROR`. Also replace tag-based `NEWSNOW_IMAGE` and `DAILYHOT_IMAGE` values with the digest-pinned references from the current example file. Deployment stops before changing production if either supporting image is not pinned to a SHA-256 digest.

Configure Nginx:

```bash
sudo htpasswd -c /etc/nginx/token-talk.htpasswd token-talk-editor
sudo cp deploy/nginx/token-talk.conf.example /etc/nginx/sites-available/token-talk.conf
sudo nginx -t
sudo systemctl reload nginx
```

Replace the example domain and certificate paths first. Obtain the certificate using the server's existing ACME/Certbot policy.

## Release paths

GitHub Actions follows the same proven boundary as VideoFactory. The Ubuntu runner verifies a `/token-talk/` image with `public.ecr.aws/docker/library/node:22-alpine`. After tests pass, the deploy job checks out the exact commit on ECS, where the application is rebuilt with the cached `node:22-alpine` base and Alibaba Cloud's internal Alpine mirror.

NewsNow and DailyHot are free self-hosted services pinned by image digest. The deploy script reuses local images when present and only pulls a missing digest before any production component changes. The final Compose switch always uses `--pull never`.

For an authorized manual recovery, run from the repository checkout:

```bash
TOKEN_TALK_ENV_FILE="$PWD/.env.prod" bash scripts/deploy-production.sh
```

The script prepares all images before mutation, backs up the workspace volume, extracts the broker artifact, restarts systemd, starts the containers without pulling during the switch, and checks both health boundaries. After the first healthy release, later failures restore the previous broker release and application image.

## GitHub Actions secrets

- `SERVER_HOST`: ECS address reachable by SSH.
- `SERVER_USER`: deployment user with Docker and systemd permissions.
- `SSH_PRIVATE_KEY`: deployment SSH key.
- `SERVER_FINGERPRINT`: trusted SHA256 fingerprint of the ECS SSH host key.
- `PROJECT_PATH`: persistent server checkout containing `.env.prod`.
- `PUBLIC_HEALTH_URL`: for example `https://podcast.example.com/api/health`.

The GitHub runner never receives the Codex login or paid provider keys. ECS receives no registry credential from GitHub.

## Operator checks

```bash
curl --unix-socket /run/token-talk-codex/worker.sock http://localhost/health
curl http://127.0.0.1:4321/api/health
docker compose --project-name token-talk --env-file .env.prod -f docker/docker-compose.prod.yml ps
journalctl -u token-talk-codex-broker --since '10 minutes ago'
```

Before the first paid TTS run, verify the selected provider, model, exact version hashes, character count, estimated cash, rights basis, and the one-attempt authorization shown in Studio.
