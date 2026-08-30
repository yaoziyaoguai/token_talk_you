#!/usr/bin/env bash
set -Eeuo pipefail

backup_root="${TOKEN_TALK_BACKUP_ROOT:-/var/backups/token-talk}"
workspace_volume="${TOKEN_TALK_WORKSPACE_VOLUME:-token-talk_token_talk_workspace}"
backup_name="token-talk-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"

if ! docker volume inspect "$workspace_volume" >/dev/null 2>&1; then
  echo "工作区卷尚不存在，跳过首次发布备份。"
  exit 0
fi
if ! docker image inspect token-talk:candidate >/dev/null 2>&1; then
  echo "缺少 token-talk:candidate，无法使用受控镜像备份。" >&2
  exit 1
fi

install -d -m 0750 "$backup_root"
docker run --rm --user 0:0 \
  --volume "$workspace_volume:/data:ro" \
  --volume "$backup_root:/backup" \
  token-talk:candidate \
  tar -czf "/backup/$backup_name" -C /data .

find "$backup_root" -maxdepth 1 -type f -name 'token-talk-*.tar.gz' -mtime +14 -delete
echo "工作区备份已写入 $backup_root/$backup_name"
