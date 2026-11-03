#!/usr/bin/env python3
"""Wait for the already authorized jobs, verify saved outputs, and checkpoint evidence."""
from __future__ import annotations
import argparse,datetime,json,pathlib,subprocess,sys,time
from fetch_opus_release import ROOT,sha256,atomic_json
from run_mt40 import SELECTION_SHA256,cases_for,LANGUAGES


def identity(pid):
    try:
        text=pathlib.Path(f'/proc/{pid}/stat').read_text();fields=text[text.rfind(')')+2:].split()
        if fields[0]=='Z':return None
        if pathlib.Path(f'/proc/{pid}/cwd').resolve()!=ROOT.parents[1]:return None
        return fields[19]
    except FileNotFoundError:return None

def latest(path,key):return {r[key]:r for r in map(json.loads,path.read_text().splitlines())}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('pids',nargs='*',type=int);args=parser.parse_args()
    waiting={pid:identity(pid) for pid in args.pids};waiting={p:s for p,s in waiting.items() if s is not None}
    deadline=time.monotonic()+7200
    print('WAITING_FOR_CURRENT_JOBS',list(waiting),flush=True)
    while any(identity(pid)==start for pid,start in waiting.items()):
        if time.monotonic()>deadline:raise TimeoutError('Existing job completion wait exceeded2h')
        time.sleep(2)
    data=ROOT/'data';errors=[]
    try:
        assert sha256(data/'fleurs_subset/selection_manifest.json')==SELECTION_SHA256
        selection=json.loads((data/'fleurs_subset/selection_manifest.json').read_text());ids={s['sentence_id'] for s in selection['sentences']}
        for direction in ['en-ru','ru-en','en-zh','zh-en','en-ar','ar-en']:
            cases={x['case_id']:x for x in cases_for(direction)}
            baseline_path=data/'mt40/opus-original-20261103'/(direction+'.jsonl')
            baseline=latest(baseline_path,'case_id')
            assert set(baseline)==set(cases),(direction,'case set')
            for cid,row in baseline.items():assert row['status']=='ok' and row['input']==cases[cid]['input'],(direction,cid)
            summary=json.loads(baseline_path.with_suffix('.summary.json').read_text());assert summary['output_sha256']==sha256(baseline_path)
            for folder in ['opus-core-sentences-20261103','opus-heldout-whole-20261103','opus-heldout-sentences-20261103']:
                p=data/'mt40'/folder/(direction+'.jsonl');rows=latest(p,'case_id');summary=json.loads(p.with_suffix('.summary.json').read_text())
                assert summary['output_sha256']==sha256(p) and summary['errors']==0 and len(rows)==summary['expected_cases'],(folder,direction)
                assert all(r['status']=='ok' and r['model_sha256']==baseline[next(iter(baseline))]['model_sha256'] for r in rows.values()),(folder,direction,'model identity')
                if folder=='opus-core-sentences-20261103':assert set(rows)==set(cases)
                else:assert len(rows)==6
        for model in ['base','small']:
            for language,config in LANGUAGES.items():
                p=data/'asr40'/('faster-whisper-'+model+'-20261103')/(language+'.jsonl');rows=latest(p,'sentence_id');summary=json.loads(p.with_suffix('.summary.json').read_text())
                assert set(rows)==ids and all(r['status']=='ok' for r in rows.values()) and summary['output_sha256']==sha256(p),(model,language)
                audio=json.loads((data/'fleurs_subset'/('audio-'+config+'.json')).read_text());clips={x['sentence_id']:x for x in audio['clips']}
                assert all(r['audio_sha256']==clips[sid]['sha256'] for sid,r in rows.items()),(model,language,'audio identity')
        smoke=json.loads((data/'process_pipeline/results.json').read_text())
        assert len(smoke['results'])==12 and len(smoke['cancellations'])==4
        assert all(x['actual_mt_input']==x['actual_asr_text'] for x in smoke['results'])
        assert all(x['worker_reaped'] for x in smoke['cancellations'])
    except Exception as error:errors.append(type(error).__name__+': '+str(error))
    subprocess.run([sys.executable,str(ROOT/'tools/summarize_experiments.py')],check=True)
    status=json.loads((data/'verification_status.json').read_text());status['final_metadata_validation_errors']=errors
    if not status['last_control_test_receipt'] or status['last_control_test_receipt']['exit_code']!=0:errors.append('Control suite did not pass')
    for key in ['direct_mt_complete','asr_complete','wrapper_complete','process_smoke_complete']:
        if not status[key]:errors.append('Incomplete: '+key)
    status['final_metadata_validation_errors']=errors;atomic_json(data/'verification_status.json',status)
    candidates=[ROOT/'RESULTS_2026-11-03.md',ROOT/'tools/finalize_evidence.py',data/'verification_status.json',data/'mt40/quality_review.json',data/'mt40/opus-core-sentences-20261103',data/'mt40/opus-heldout-whole-20261103',data/'mt40/opus-heldout-sentences-20261103',data/'mt40/receipts',data/'asr40',data/'process_pipeline']
    subprocess.run(['git','add','-f',*[str(p) for p in candidates if p.exists()]],cwd=ROOT,check=True)
    subprocess.run(['git','diff','--cached','--check','--','tools','tests','process_stage.py','real_engines.py','sentence_segments.py','README.md','LICENSE_MANIFEST.md','RESULTS_2026-11-03.md'],cwd=ROOT,check=True)
    if subprocess.run(['git','diff','--cached','--quiet'],cwd=ROOT).returncode:
        subprocess.run(['git','commit','-m','Checkpoint complete real MT-ASR evaluation and process cancellation evidence'],cwd=ROOT,check=True)
    head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
    receipt={'finished_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'commit':head,'validation_errors':errors,'direct_mt_outputs':status['direct_mt_outputs'],'asr_outputs':status['asr_outputs'],'wrapper_complete':status['wrapper_complete'],'pipeline_outputs':status['real_process_pipeline_outputs'],'native_cancel_checks':status['real_native_cancel_checks'],'voice_translation_release_gate':'blocked','models_or_audio_committed':False}
    state=pathlib.Path('/home/sergey/.local/state/imonmeets-commercial-20261103/translation-finalization.json');atomic_json(state,receipt)
    print('FINAL_CHECKPOINT',json.dumps(receipt),flush=True)
    if errors:raise SystemExit(1)

if __name__=='__main__':main()
