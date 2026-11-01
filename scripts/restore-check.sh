#!/usr/bin/env bash
# Restore a supplied dump into a newly created disposable database, never the app database.
set -euo pipefail
cd "$(dirname "$0")/.."
dump_path="${1:?Usage: bash scripts/restore-check.sh backups/FILE.dump}"
test -s "$dump_path"
restore_db="imonmeets_restore_$(date -u +%s)_${RANDOM}"
created=false
cleanup() {
  if "$created"; then docker compose exec -T db dropdb --force -U imonmeets "$restore_db"; fi
}
trap cleanup EXIT
docker compose exec -T db createdb -U imonmeets "$restore_db"
created=true
docker compose exec -T db pg_restore -U imonmeets -d "$restore_db" --exit-on-error < "$dump_path"
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U imonmeets -d "$restore_db" -c 'SELECT count(*) AS restored_workspaces FROM im_workspaces; SELECT count(*) AS restored_rooms FROM im_rooms; SELECT count(*) AS restored_users FROM "user"; SELECT count(*) AS restored_accounts FROM account; SELECT count(*) AS restored_memberships FROM im_members; SELECT count(*) AS restored_invitations FROM im_invitations;'
printf 'Restore into disposable database succeeded; cleanup follows.\n'
