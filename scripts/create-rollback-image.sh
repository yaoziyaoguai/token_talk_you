#!/usr/bin/env bash
set -Eeuo pipefail

container="${1:?用法：create-rollback-image.sh <container> [target-image]}"
target_image="${2:-token-talk:rollback}"
validation_container="token-talk-rollback-validate-$$"

cleanup() {
  docker rm --force --volumes "$validation_container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker container inspect "$container" >/dev/null
docker export "$container" | docker import \
  --change 'USER token-talk' \
  --change 'WORKDIR /app' \
  --change 'ENV NODE_ENV=production HOST=0.0.0.0 PORT=4311 TOKEN_TALK_CONTAINER_BIND=1 TOKEN_TALK_WORKSPACE=/data/token-talk HOME=/tmp PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' \
  --change 'EXPOSE 4311' \
  --change 'VOLUME ["/data/token-talk"]' \
  --change 'ENTRYPOINT ["/sbin/tini","--"]' \
  --change 'CMD ["node","apps/studio/dist/server/main.js"]' \
  - "$target_image" >/dev/null

docker image inspect "$target_image" >/dev/null
if docker image inspect "$target_image" --format '{{json .Config.Env}}' \
  | grep -Eq 'ELEVENLABS_API_KEY|DASHSCOPE_API_KEY|ARK_API_KEY'; then
  echo "回滚镜像包含受保护的 API 配置，拒绝发布。" >&2
  exit 1
fi

docker create --name "$validation_container" "$target_image" >/dev/null
docker rm --volumes "$validation_container" >/dev/null

echo "回滚镜像已创建并通过配置验证：$target_image"
