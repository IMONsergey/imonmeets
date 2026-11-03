#!/usr/bin/env bash
# All expensive experiment work shares one host-wide lock and a killable cgroup.
set -euo pipefail
label=${1:?label required}
seconds=${2:?runtime seconds required}
shift 2
[[ "$label" =~ ^[a-z0-9-]+$ ]] || exit 64
[[ "$seconds" =~ ^[0-9]+$ ]] && (( seconds >= 10 && seconds <= 3600 )) || exit 64
root=$(cd "$(dirname "$0")/.." && pwd)
state=/home/sergey/.local/state/imonmeets-commercial-20261103
mkdir -p "$state" "$root/data/mt40/receipts"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
unit="imonmeets-mt-${label}-${stamp}-$$"
log="$root/data/mt40/receipts/${unit}.log"
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
set +e
flock -w 1200 "$state/verify.lock" env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus systemd-run --user --wait --collect --pipe --quiet --unit="$unit" --working-directory="$root" -p CPUQuota=100% -p MemoryMax=2G -p TasksMax=128 -p RuntimeMaxSec="$seconds" -p KillMode=control-group /usr/bin/env OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1 NUMEXPR_NUM_THREADS=1 TOKENIZERS_PARALLELISM=false CUDA_VISIBLE_DEVICES= HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 PYTHONUNBUFFERED=1 "$@" 2>&1 | tee "$log"
code=${PIPESTATUS[0]}
set -e
python3 - "$log" "$unit" "$started" "$seconds" "$code" "$@" <<'PY'
import datetime,json,pathlib,sys
log,unit,started,seconds,code,*command=sys.argv[1:]
record={'unit':unit,'started_at':started,'finished_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'runtime_max_seconds':int(seconds),'exit_code':int(code),'command':command,'log':str(pathlib.Path(log).name),'cpu_quota':'100%','memory_max_bytes':2147483648,'tasks_max':128,'kill_mode':'control-group','lock':'/home/sergey/.local/state/imonmeets-commercial-20261103/verify.lock'}
pathlib.Path(log).with_suffix('.json').write_text(json.dumps(record,indent=2)+'\n')
print('RECEIPT',json.dumps(record),flush=True)
PY
exit "$code"
