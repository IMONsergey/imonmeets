#!/usr/bin/env python3
import fcntl,pathlib,subprocess
root=pathlib.Path('/home/sergey/imonmeets-recording-boundary-20261103')
state=pathlib.Path('/home/sergey/.local/state/imonmeets-commercial-20261103/recording-boundary-20261103')
with (state.parent/'verify.lock').open('a+') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX)
 r=subprocess.run(['sudo','-n','systemd-run','--wait','--collect','--unit=imon-rec-backup-hard-bound-20261103','--uid=1000','--gid=1000','--property=RuntimeMaxSec=240','--property=CPUQuota=100%','--property=MemoryMax=2G','--property=TasksMax=256','--setenv=PATH=/opt/imon-runtime/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','python3',str(root/'scripts/verify-recording-backup-hard-bound.py'),str(state/'run-rec09d20261103/size.mp4'),str(state/'hard-bound-512-20261103')],capture_output=True,text=True,timeout=270)
 (state/'hard-bound-unit.log').write_text(r.stdout+r.stderr)
 print('DONE hard-bound',r.returncode,flush=True)
 receipt=state/'hard-bound-512-20261103/receipt.json'
 print(receipt.read_text() if receipt.exists() else r.stderr,flush=True)
 raise SystemExit(r.returncode)
