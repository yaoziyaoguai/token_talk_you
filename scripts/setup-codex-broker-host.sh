#!/usr/bin/env bash
# 宿主机一次性初始化。凭据只由专用用户手动登录生成，脚本不会复制其他用户的登录态。
set -Eeuo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
broker_root=/opt/token-talk/codex-broker
broker_user=token-talk-codex
broker_group=token-talk-bridge
broker_uid="${TOKEN_TALK_CODEX_UID:-22011}"
broker_gid="${TOKEN_TALK_CODEX_GID:-22012}"
broker_home=/home/token-talk-codex
broker_state=/var/lib/token-talk-codex
broker_codex_home="$broker_state/codex-home"
env_file=/etc/token-talk/codex-broker.env
unit_source="$repository_root/apps/codex-broker/deploy/token-talk-codex-broker.service"
unit_target=/etc/systemd/system/token-talk-codex-broker.service

fail() {
  echo "[token-talk-codex-setup] $1" >&2
  exit 1
}

[[ "$(id -u)" -eq 0 ]] || fail "必须以 root 运行。"

if ! getent group "$broker_group" >/dev/null 2>&1; then
  groupadd --gid "$broker_gid" "$broker_group"
elif [[ "$(getent group "$broker_group" | cut -d: -f3)" != "$broker_gid" ]]; then
  fail "$broker_group 已存在但 gid 与 $broker_gid 不一致；请通过 TOKEN_TALK_CODEX_GID 指定现有 gid。"
fi

if ! id -u "$broker_user" >/dev/null 2>&1; then
  useradd --create-home --uid "$broker_uid" --shell /bin/bash "$broker_user"
elif [[ "$(id -u "$broker_user")" != "$broker_uid" ]]; then
  fail "$broker_user 已存在但 uid 与 $broker_uid 不一致；请通过 TOKEN_TALK_CODEX_UID 指定现有 uid。"
fi
usermod --append --groups "$broker_group" "$broker_user"

install -d -m 0755 "$broker_root" "$broker_root/bin" "$broker_root/releases"
install -d -o "$broker_user" -g "$broker_group" -m 0750 "$broker_state" "$broker_state/workspace" "$broker_codex_home"
install -d -o "$broker_user" -g "$broker_user" -m 0700 "$broker_home/.codex" "$broker_home/.codex/sessions" "$broker_home/.codex/log"

node_bin=""
for candidate in "$broker_home/.local/node22/bin/node" "$broker_home/.local/bin/node" /usr/local/bin/node /usr/bin/node; do
  if [[ -x "$candidate" ]] && runuser -u "$broker_user" -- "$candidate" --version >/dev/null 2>&1; then
    node_bin="$candidate"
    break
  fi
done
[[ -n "$node_bin" ]] || fail "未找到 $broker_user 可执行的 Node 22。请先为专用用户安装 Node 22。"
node_major="$(runuser -u "$broker_user" -- "$node_bin" --version | sed -E 's/^v([0-9]+).*/\1/')"
[[ "$node_major" =~ ^[0-9]+$ && "$node_major" -ge 22 ]] || fail "Codex broker 需要 Node >= 22。"

codex_path="$(dirname "$node_bin"):$broker_home/.local/bin:/usr/local/bin:/usr/bin:/bin"
codex_bin=""
for candidate in "$broker_home/.local/bin/codex" /usr/local/bin/codex /usr/bin/codex; do
  if [[ -x "$candidate" ]] && runuser -u "$broker_user" -- env HOME="$broker_home" PATH="$codex_path" "$candidate" --version >/dev/null 2>&1; then
    codex_bin="$candidate"
    break
  fi
done
[[ -n "$codex_bin" ]] || fail "未找到 $broker_user 可执行的 Codex CLI。请为专用用户安装后重跑。"

if ! runuser -u "$broker_user" -- env HOME="$broker_home" PATH="$codex_path" "$codex_bin" login status >/dev/null 2>&1; then
  fail "专用用户尚未登录 Codex。请手动执行：runuser -u $broker_user -- env HOME=$broker_home PATH=$codex_path $codex_bin login"
fi

codex_auth="$broker_home/.codex/auth.json"
[[ -f "$codex_auth" ]] || fail "登录状态存在但未找到 $codex_auth。"
if [[ -e "$broker_codex_home/auth.json" && ! -L "$broker_codex_home/auth.json" ]]; then
  fail "$broker_codex_home/auth.json 不是符号链接，拒绝覆盖。"
fi
ln -sfn "$codex_auth" "$broker_codex_home/auth.json"
chown -h "$broker_user:$broker_group" "$broker_codex_home/auth.json"

node_tmp="$(mktemp "$broker_root/bin/.node.XXXXXX")"
trap 'rm -f "$node_tmp"' EXIT
install -o root -g root -m 0755 "$node_bin" "$node_tmp"
mv -f "$node_tmp" "$broker_root/bin/node"
trap - EXIT

install -d -m 0755 "$(dirname "$env_file")"
env_tmp="$(mktemp)"
{
  grep -v '^CODEX_BIN=' "$env_file" 2>/dev/null || true
  printf 'CODEX_BIN=%s\n' "$codex_bin"
} >"$env_tmp"
install -o root -g "$broker_group" -m 0640 "$env_tmp" "$env_file"
rm -f "$env_tmp"

[[ -f "$unit_source" ]] || fail "缺少 systemd unit：$unit_source"
install -m 0644 "$unit_source" "$unit_target"
systemctl daemon-reload
systemctl enable token-talk-codex-broker >/dev/null

if [[ -f "$broker_root/current/dist/main.js" ]]; then
  systemctl restart token-talk-codex-broker
  for _ in $(seq 1 20); do
    if curl --fail --silent --max-time 5 --unix-socket /run/token-talk-codex/worker.sock http://localhost/health >/dev/null; then
      echo "Codex broker 已就绪；bridge gid=$broker_gid。"
      exit 0
    fi
    sleep 1
  done
  systemctl --no-pager --lines=60 status token-talk-codex-broker || true
  fail "Codex broker 健康检查失败。"
fi

echo "宿主机边界已初始化，bridge gid=$broker_gid。首次发布会安装 broker 制品并启动服务。"
