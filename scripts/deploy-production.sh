#!/usr/bin/env bash
set -Eeuo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
environment_file="${TOKEN_TALK_ENV_FILE:-$repository_root/.env.prod}"
public_health_url="${PUBLIC_HEALTH_URL:-}"
container=token_talk_prod
broker_service=token-talk-codex-broker
broker_root=/opt/token-talk/codex-broker
broker_socket=/run/token-talk-codex/worker.sock
broker_user=token-talk-codex
compose=(docker compose --project-name token-talk --env-file "$environment_file" -f "$repository_root/docker/docker-compose.prod.yml")

[[ -f "$environment_file" ]] || { echo "缺少生产环境文件：$environment_file" >&2; exit 1; }
systemctl cat "$broker_service" >/dev/null 2>&1 || { echo "请先运行 scripts/setup-codex-broker-host.sh" >&2; exit 1; }

bridge_gid="$(getent group token-talk-bridge | cut -d: -f3 || true)"
[[ -n "$bridge_gid" ]] || { echo "缺少 token-talk-bridge 组。" >&2; exit 1; }
export TOKEN_TALK_CODEX_SOCKET_GID="$bridge_gid"

check_codex_upstream() {
  local code
  for _ in 1 2 3; do
    code="$(runuser -u "$broker_user" -- curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
      --connect-timeout 8 --max-time 15 https://api.openai.com/v1/models || true)"
    if [[ "$code" =~ ^[1-5][0-9][0-9]$ ]]; then
      return 0
    fi
    sleep 3
  done
  echo "Codex 专用用户无法连通 OpenAI；保持当前生产版本。" >&2
  return 1
}

wait_for_broker() {
  for _ in $(seq 1 20); do
    if curl --fail --silent --max-time 5 --unix-socket "$broker_socket" http://localhost/health >/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

app_port() {
  docker port "$container" 4311/tcp 2>/dev/null | head -n 1 | awk -F: '{print $NF}'
}

wait_for_app() {
  local port
  for _ in $(seq 1 36); do
    port="$(app_port)"
    if [[ -n "$port" ]] && curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:$port/api/health" >/dev/null; then
      return 0
    fi
    sleep 5
  done
  return 1
}

previous_image="$(docker inspect --format='{{.Image}}' "$container" 2>/dev/null || true)"
previous_broker_release="$(readlink -f "$broker_root/current" 2>/dev/null || true)"
deployment_mutated=0
deployment_committed=0

rollback() {
  local failed=0
  if [[ -n "$previous_broker_release" && "$previous_broker_release" == "$broker_root"/releases/* && -d "$previous_broker_release" ]]; then
    ln -sfn "$previous_broker_release" "$broker_root/current" || failed=1
    systemctl restart "$broker_service" || failed=1
    wait_for_broker || failed=1
  else
    echo "没有可恢复的 broker release。" >&2
    failed=1
  fi
  if [[ -n "$previous_image" ]]; then
    docker tag "$previous_image" token-talk:candidate || failed=1
    "${compose[@]}" up --detach --no-deps --force-recreate app || failed=1
    wait_for_app || failed=1
  else
    echo "没有可恢复的应用镜像。" >&2
    failed=1
  fi
  return "$failed"
}

on_exit() {
  local status="$?"
  trap - EXIT
  if [[ "$status" -ne 0 && "$deployment_mutated" -eq 1 && "$deployment_committed" -eq 0 ]]; then
    echo "发布失败，开始恢复上一版本。" >&2
    if ! rollback; then
      echo "回滚未完整恢复，需要人工检查 systemd 与容器状态。" >&2
    fi
  fi
  exit "$status"
}
trap on_exit EXIT

install_broker_release() {
  local image_container staging release_id release_dir
  image_container="$(docker create token-talk:candidate)"
  staging="$(mktemp -d)"
  if ! docker cp "$image_container:/app/apps/codex-broker/dist" "$staging/dist"; then
    docker rm "$image_container" >/dev/null 2>&1 || true
    rm -rf "$staging"
    return 1
  fi
  docker rm "$image_container" >/dev/null
  release_id="$(date -u +%Y%m%dT%H%M%SZ)-$(git -C "$repository_root" rev-parse --short HEAD 2>/dev/null || echo local)"
  release_dir="$broker_root/releases/$release_id"
  [[ "$release_dir" == "$broker_root"/releases/* ]] || { rm -rf "$staging"; return 1; }
  mv "$staging" "$release_dir"
  chown -R "$broker_user:token-talk-bridge" "$release_dir"
  chmod -R a+rX "$release_dir"
  ln -sfn "$release_dir" "$broker_root/current"
}

check_codex_upstream
"${compose[@]}" build app
"${compose[@]}" pull newsnow dailyhot
"$repository_root/scripts/backup-production.sh"

if [[ -n "$previous_image" ]]; then
  docker tag "$previous_image" token-talk:rollback
fi
install_broker_release
deployment_mutated=1

systemctl restart "$broker_service"
if ! wait_for_broker; then
  systemctl --no-pager --lines=80 status "$broker_service" || true
  exit 1
fi

"${compose[@]}" up --detach --remove-orphans --force-recreate
if ! wait_for_app; then
  "${compose[@]}" ps || true
  "${compose[@]}" logs --tail=180 app || true
  exit 1
fi
wait_for_broker

if [[ -n "$public_health_url" ]]; then
  curl --fail --silent --show-error --max-time 15 "$public_health_url" >/dev/null
fi

deployment_committed=1
"${compose[@]}" ps || true
docker image prune --force >/dev/null || true

current_release="$(readlink -f "$broker_root/current")"
find "$broker_root/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
  | sort -rn | tail -n +4 | cut -d' ' -f2- \
  | while read -r stale; do
      if [[ "$stale" == "$broker_root"/releases/* && "$stale" != "$current_release" && "$stale" != "$previous_broker_release" ]]; then
        rm -rf "$stale"
      fi
    done || echo "旧 broker release 清理未完成，但本次发布已健康。" >&2

echo "Token Talk 发布完成。"
