#!/usr/bin/env python3
"""One bounded synthetic Egress job, shared lock and aggregate container budget."""
import fcntl
import json
import os
import pathlib
import re
import subprocess
import sys
import time

if os.environ.get('IMON_ISOLATED_EGRESS_ACCEPTANCE') != '1':
    raise SystemExit('Set IMON_ISOLATED_EGRESS_ACCEPTANCE=1 for disposable fixture acceptance')
run_id = sys.argv[1]
if not re.fullmatch('[a-z0-9]{8,24}', run_id):
    raise ValueError('Fresh lowercase alphanumeric run ID required')
root = pathlib.Path(__file__).resolve().parent.parent
state = pathlib.Path('/home/sergey/.local/state/imonmeets-commercial-20261103/recording-boundary-20261103')
state.mkdir(parents=True, mode=0o700, exist_ok=True)
if (state / ('run-' + run_id)).exists():
    raise ValueError('Run ID already exists; earlier evidence must be preserved')
unit = 'imonrec' + run_id
slice_name = unit + '.slice'
env = {**os.environ, 'PATH': '/opt/imon-runtime/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'IMON_EGRESS_RUN_ID': run_id}
with (state.parent / 'verify.lock').open('a+') as lock:
    print('WAITING_FOR_SHARED_LOCK', flush=True)
    deadline = time.monotonic() + 180
    while True:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.monotonic() > deadline: raise TimeoutError('Verification lock wait expired')
            time.sleep(1)
    print('LOCK_ACQUIRED', run_id, flush=True)
    status = 1
    try:
        result = subprocess.run(['sudo', '-n', 'systemd-run', '--wait', '--collect', '--unit=' + unit, '--slice=' + slice_name, '--uid=1000', '--gid=1000', '--property=RuntimeMaxSec=360', '--property=TimeoutStopSec=15', '--property=CPUQuota=100%', '--property=MemoryMax=2G', '--property=TasksMax=512', '--setenv=PATH=' + env['PATH'], '--setenv=IMON_ISOLATED_EGRESS_ACCEPTANCE=1', '--setenv=IMON_EGRESS_RUN_ID=' + run_id, '/opt/imon-runtime/node/bin/node', str(root / 'scripts/test-egress-boundary.mjs')], cwd=root, capture_output=True, text=True, timeout=420, env=env)
        status = result.returncode
        (state / (run_id + '-unit.log')).write_text(result.stdout + result.stderr)
    except subprocess.TimeoutExpired:
        subprocess.run(['sudo', '-n', 'systemctl', 'stop', unit + '.service'], capture_output=True, timeout=30)
        (state / (run_id + '-unit.log')).write_text('Outer timeout stopped the owned fixture unit\n')
    finally:
        cleanup = subprocess.run(['/opt/imon-runtime/node/bin/node', str(root / 'scripts/test-egress-boundary.mjs'), '--cleanup'], cwd=root, capture_output=True, text=True, timeout=90, env=env)
        (state / (run_id + '-cleanup.log')).write_text(cleanup.stdout + cleanup.stderr)
        journal = subprocess.run(['sudo', '-n', 'journalctl', '-u', unit + '.service', '--no-pager', '-o', 'cat', '-n', '400'], capture_output=True, text=True, timeout=15)
        (state / (run_id + '-controller.log')).write_text(journal.stdout + journal.stderr)
        subprocess.run(['sudo', '-n', 'systemctl', 'stop', slice_name], capture_output=True, timeout=15)
        subprocess.run(['sudo', '-n', 'systemctl', 'revert', slice_name], capture_output=True, timeout=15)
        print('DONE', run_id, 'unitExit', status, 'cleanupExit', cleanup.returncode, flush=True)
        print('\n'.join(line for line in journal.stdout.splitlines() if line.startswith(('PASS ', 'START ', '{')))[-6000:], flush=True)
        print(cleanup.stdout[-1000:], flush=True)
    raise SystemExit(status or cleanup.returncode)
