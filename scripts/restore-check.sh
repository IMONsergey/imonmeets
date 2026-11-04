#!/usr/bin/env bash
# Restore a supplied dump into a newly created disposable database, never the app database.
set -euo pipefail
cd "$(dirname "$0")/.."
dump_path="${1:?Usage: bash scripts/restore-check.sh backups/FILE.dump}"
test -s "$dump_path"
restore_mode="${2:-}"
if [ "$#" -gt 2 ] || { [ -n "$restore_mode" ] && [ "$restore_mode" != "--inspect-unbound-offline" ]; }; then
  printf 'Only --inspect-unbound-offline is accepted as the optional mode.\n' >&2
  exit 2
fi
imon_restore_node="${IMON_RESTORE_NODE:-node}"
if [ -z "${IMON_RESTORE_NODE:-}" ] && [ -x /opt/imon-runtime/node/bin/node ]; then
  imon_restore_node=/opt/imon-runtime/node/bin/node
fi
restore_db="imonmeets_restore_$(date -u +%s)_${RANDOM}"
created=false
cleanup() {
  local result=$?
  trap - EXIT
  if "$created"; then
    if ! docker compose -p imonmeets exec -T db dropdb --force -U imonmeets "$restore_db"; then
      printf 'Cleanup failed for disposable database %s; manual cleanup is required.\n' "$restore_db" >&2
      if [ "$result" -eq 0 ]; then result=1; fi
    fi
  fi
  exit "$result"
}
trap cleanup EXIT
docker compose -p imonmeets exec -T db createdb -U imonmeets "$restore_db"
created=true
docker compose -p imonmeets exec -T db pg_restore -U imonmeets -d "$restore_db" --exit-on-error < "$dump_path"
restore_args=("$restore_db")
if [ -n "$restore_mode" ]; then restore_args+=("$restore_mode"); fi
"$imon_restore_node" scripts/check-restored-database.mjs "${restore_args[@]}"
printf 'SQL restore inspection completed; disposable database cleanup follows. This does not authorize serving.\n'
