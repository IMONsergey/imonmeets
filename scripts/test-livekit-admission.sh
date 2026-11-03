#!/bin/sh
# Isolated host acceptance only; the JS guard rejects any non-fixture database.
set -eu
export PATH=/opt/imon-runtime/node/bin:/usr/local/bin:/usr/bin:/bin
: "${TEST_DATABASE_URL:?Set the isolated loopback acceptance database URL}"
: "${IMON_ISOLATED_LIVEKIT_ACCEPTANCE:?Set IMON_ISOLATED_LIVEKIT_ACCEPTANCE=1}"
[ "$IMON_ISOLATED_LIVEKIT_ACCEPTANCE" = 1 ] || exit 2
[ "$(node -p 'process.versions.node.split(".")[0]')" = 24 ] || exit 2
task_repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
task_state=/home/sergey/.local/state/imonmeets-commercial-20261103
[ -d "$task_state" ] || exit 2
task_uid=$(id -u)
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$task_uid}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
IMON_RUNTIME_RUN_ID="${IMON_RUNTIME_RUN_ID:-$(node -e 'process.stdout.write("runtime"+require("node:crypto").randomBytes(8).toString("hex"))')}"
case "$IMON_RUNTIME_RUN_ID" in ''|*[!a-z0-9]*) exit 2 ;; esac
[ "${#IMON_RUNTIME_RUN_ID}" -ge 8 ] && [ "${#IMON_RUNTIME_RUN_ID}" -le 32 ] || exit 2
[ ! -e "$task_state/livekit-runtime-$IMON_RUNTIME_RUN_ID" ] || exit 2
[ ! -e "$task_state/livekit-runtime-$IMON_RUNTIME_RUN_ID.json" ] || exit 2
export IMON_RUNTIME_RUN_ID TEST_DATABASE_URL IMON_ISOLATED_LIVEKIT_ACCEPTANCE
task_unit="imonmeets-core-lk-runtime-$IMON_RUNTIME_RUN_ID"
# The lock also covers cleanup of external Docker resources.
exec 9>"$task_state/verify.lock"
flock -w 1200 9
cleanup() {
  task_status=$?
  trap - EXIT HUP INT TERM
  timeout 30s systemctl --user stop "$task_unit.service" >/dev/null 2>&1 || true
  timeout 30s node --import tsx "$task_repo/scripts/test-livekit-admission.mjs" --cleanup || task_status=1
  exit "$task_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
cd "$task_repo"
systemd-run --user --wait --collect --pipe --quiet   --unit="$task_unit" --working-directory="$task_repo"   -p CPUQuota=100% -p MemoryMax=2G -p TasksMax=256   -p RuntimeMaxSec=600 -p KillMode=control-group   /usr/bin/env PATH=/opt/imon-runtime/node/bin:/usr/local/bin:/usr/bin:/bin   TEST_DATABASE_URL="$TEST_DATABASE_URL"   IMON_ISOLATED_LIVEKIT_ACCEPTANCE=1 IMON_RUNTIME_RUN_ID="$IMON_RUNTIME_RUN_ID"   IMON_BROWSER_ENGINE="${IMON_BROWSER_ENGINE:-chromium}" IMON_BROWSER_EXECUTABLE="${IMON_BROWSER_EXECUTABLE:-}"   IMON_INGRESS_GENERATOR="${IMON_INGRESS_GENERATOR:-$task_repo/scripts/prepare-ingress443.mjs}"   RAYON_NUM_THREADS=2 UV_THREADPOOL_SIZE=2   /bin/sh -c 'node --version && node --check scripts/test-livekit-admission.mjs && node --import tsx scripts/test-livekit-admission.mjs'
