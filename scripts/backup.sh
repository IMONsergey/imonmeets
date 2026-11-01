#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
mkdir -p backups
backup_path="backups/imonmeets-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose exec -T db pg_dump -U imonmeets -d imonmeets -Fc > "$backup_path"
test -s "$backup_path"
docker compose exec -T db pg_restore --list < "$backup_path" >/dev/null
printf 'Verified backup: %s\n' "$backup_path"
