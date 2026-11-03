#!/usr/bin/env python3
import fcntl,hashlib,json,os,pathlib,re,subprocess,sys
state=pathlib.Path('/home/sergey/.local/state/imonmeets-commercial-20261103/recording-boundary-20261103')
root=pathlib.Path('/home/sergey/imonmeets-recording-boundary-20261103')
phase=sys.argv[1]
assert phase in ['red','green']
folder=state/('targeted-'+phase)
folder.mkdir(mode=0o700,exist_ok=True)
if '--inner' in sys.argv:
 files=['scripts/recording-backup.py','scripts/test-recording-backup.py','apps/api/src/recordings.ts','apps/api/test/recordings.test.ts','compose.recording.yml']
 receipt={'phase':phase,'sourceHead':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'sourceFiles':{p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in files},'checks':[],'scope':'Local synthetic targeted regressions; no Docker, production, network or provider calls'}
 tests=['RecordingBackupTests.test_backup_object_bound_matches_hard_egress_output_mount','RecordingBackupTests.test_two_recordings_keep_aggregate_ciphertext_capacity_guard','RecordingBackupTests.test_hard_bound_free_space_reserve_precedes_download'] if phase=='red' else []
 commands=[('backup',['python3','scripts/test-recording-backup.py',*tests]),('api',['/opt/imon-runtime/node/bin/node','--import','tsx','--test','--test-concurrency=1','apps/api/test/recordings.test.ts'])]
 for name,cmd in commands:
  with (folder/(name+'.log')).open('w') as log:r=subprocess.run(cmd,cwd=root,stdout=log,stderr=subprocess.STDOUT,timeout=90)
  receipt['checks'].append({'name':name,'exitCode':r.returncode})
 (folder/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
 print(json.dumps(receipt['checks']),flush=True)
 sys.exit(any(x['exitCode'] for x in receipt['checks']))
with (state.parent/'verify.lock').open('a+') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX)
 r=subprocess.run(['sudo','-n','systemd-run','--wait','--collect','--unit=imon-rec-targeted-'+phase+'-20261103','--uid=1000','--gid=1000','--property=RuntimeMaxSec=180','--property=CPUQuota=100%','--property=MemoryMax=2G','--property=TasksMax=256','--setenv=PATH=/opt/imon-runtime/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','python3',__file__,phase,'--inner'],capture_output=True,text=True,timeout=200)
 (folder/'controller.log').write_text(r.stdout+r.stderr)
 print('DONE',phase,r.returncode,flush=True)
 print((folder/'receipt.json').read_text(),flush=True)
 for name in ['backup','api']:print(name,(folder/(name+'.log')).read_text()[-6000:],flush=True)
 sys.exit(r.returncode)
