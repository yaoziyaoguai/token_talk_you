#!/usr/bin/env bash
set -Eeuo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
port="${TOKEN_TALK_SMOKE_PORT:-4391}"
workspace="$(mktemp -d)"
server_pid=""
ready=0

cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" >/dev/null 2>&1 || true
  fi
  rm -rf "$workspace"
}
trap cleanup EXIT

NODE_ENV=production PORT="$port" TOKEN_TALK_WORKSPACE="$workspace" \
  node "$repository_root/apps/studio/dist/server/main.js" >"$workspace/server.log" 2>&1 &
server_pid="$!"

for _ in $(seq 1 30); do
  if curl --fail --silent --show-error "http://127.0.0.1:$port/api/health" >/dev/null; then
    ready=1
    break
  fi
  if ! kill -0 "$server_pid" >/dev/null 2>&1; then
    cat "$workspace/server.log" >&2
    exit 1
  fi
  sleep 1
done
if [[ "$ready" -ne 1 ]]; then
  cat "$workspace/server.log" >&2
  exit 1
fi

curl --fail --silent --show-error "http://127.0.0.1:$port/" | grep -q "Token Talk Studio"
curl --fail --silent --show-error "http://127.0.0.1:$port/production/smoke" | grep -q "Token Talk Studio"
status="$(curl --silent --output /dev/null --write-out '%{http_code}' --header 'Host: attacker.example' "http://127.0.0.1:$port/api/health")"
[[ "$status" == "403" ]] || { echo "伪造 Host 应返回 403，实际为 $status" >&2; exit 1; }

echo "生产构建 smoke test 通过。"
