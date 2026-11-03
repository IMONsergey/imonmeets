#!/usr/bin/env bash
set -u
flock -w 1200 /home/sergey/.local/state/imonmeets-commercial-20261103/verify.lock env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus systemd-run --user --wait --collect --pipe --quiet --unit=imonmeets-tr-lifecycle-20261103t084316z-1353554 --working-directory=/home/sergey/imonmeets-translation-cpu-20261102 -p CPUQuota=100% -p MemoryMax=2G -p TasksMax=256 -p RuntimeMaxSec=240 -p KillMode=control-group /usr/bin/env OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1 NUMEXPR_NUM_THREADS=1 TOKENIZERS_PARALLELISM=false CUDA_VISIBLE_DEVICES= HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 PYTHONUNBUFFERED=1 /home/sergey/imonmeets-translation-cpu-20261102/.venv/bin/python /home/sergey/imonmeets-translation-cpu-20261102/experiments/translation_cpu/tools/verify_lifecycle.py lifecycle-20261103t084316z-1353554
code=$?
/usr/bin/python3 - "$code" <<'STATUS'
import datetime,json,pathlib,sys
path=pathlib.Path('/home/sergey/imonmeets-translation-cpu-20261102/experiments/translation_cpu/data/lifecycle/lifecycle-20261103t084316z-1353554/launcher.json')
path.write_text(json.dumps({'run_id':'lifecycle-20261103t084316z-1353554','unit':'imonmeets-tr-lifecycle-20261103t084316z-1353554','exit_code':int(sys.argv[1]),'completed_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'runtime_max_seconds':240,'cpu_quota':'100%','memory_max_bytes':2147483648,'tasks_max':256,'kill_mode':'control-group','lock':'/home/sergey/.local/state/imonmeets-commercial-20261103/verify.lock','detached_regular_log':True},indent=2)+'\n')
STATUS
exit "$code"
