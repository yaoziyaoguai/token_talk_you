ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS builder

ARG TOKEN_TALK_BASE_PATH=/
ENV TOKEN_TALK_BASE_PATH=${TOKEN_TALK_BASE_PATH}

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/studio/package.json apps/studio/package.json
COPY apps/codex-broker/package.json apps/codex-broker/package.json
COPY packages/agent-protocol/package.json packages/agent-protocol/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/workflow/package.json packages/workflow/package.json
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM ${NODE_IMAGE} AS runtime

ARG DEBIAN_MIRROR_ORIGIN=http://deb.debian.org

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4311 \
    TOKEN_TALK_CONTAINER_BIND=1 \
    TOKEN_TALK_WORKSPACE=/data/token-talk

RUN sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR_ORIGIN}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::ForceIPv4=true update \
    && apt-get -o Acquire::ForceIPv4=true install --yes --no-install-recommends ca-certificates espeak-ng ffmpeg tini util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 1001 token-talk \
    && useradd --system --uid 1001 --gid token-talk --home-dir /app token-talk \
    && mkdir -p /data/token-talk \
    && chown -R token-talk:token-talk /data/token-talk

ENV HOME=/tmp

WORKDIR /app
COPY --from=builder /app/apps/studio/dist apps/studio/dist
# Broker 只供部署脚本提取给宿主机 systemd，容器不会启动它。
COPY --from=builder /app/apps/codex-broker/dist apps/codex-broker/dist

USER token-talk
EXPOSE 4311
VOLUME ["/data/token-talk"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4311/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/studio/dist/server/main.js"]
