#!/usr/bin/env python3
"""Real audio→ASR→MT process-boundary smoke. No TTS, LiveKit, or streaming-latency claim."""
from __future__ import annotations
import asyncio,json,os,pathlib,sys,time
from fetch_opus_release import ROOT,sha256,atomic_json
from run_mt40 import LANGUAGES,SELECTION_SHA256,cgroup_limits
sys.path.insert(0,str(ROOT))
from real_engines import ASRProcessEngine,MTProcessEngine

async def main():
    limits=cgroup_limits();subset=ROOT/'data/fleurs_subset'
    if sha256(subset/'selection_manifest.json')!=SELECTION_SHA256:raise ValueError('Selection changed')
    selection=json.loads((subset/'selection_manifest.json').read_text())
    python=ROOT.parents[1]/'.venv/bin/python'
    destination=ROOT/'data/process_pipeline';destination.mkdir(parents=True,exist_ok=True)
    results=[];cancellations=[]
    for language in ['en','ru','zh','ar']:
        target='ru' if language=='en' else 'en';config=LANGUAGES[language]
        audio_manifest=json.loads((subset/('audio-'+config+'.json')).read_text());clips={c['sentence_id']:c for c in audio_manifest['clips']}
        asr=ASRProcessEngine(python,language);mt=MTProcessEngine(python,language,target)
        try:
            for index,sentence in enumerate(selection['sentences'][:3]):
                clip=clips[sentence['sentence_id']];path=subset/'audio'/config/clip['file']
                if sha256(path)!=clip['sha256']:raise ValueError('Audio changed')
                audio=path.read_bytes();started=time.monotonic()
                transcript=await asr(audio,language);asr_wall=time.monotonic()-started
                mt_started=time.monotonic();translated=await mt(transcript,language,target);mt_wall=time.monotonic()-mt_started
                row={'sentence_id':sentence['sentence_id'],'direction':language+'-'+target,'cold_workers':index==0,'audio_sha256':clip['sha256'],'audio_seconds':clip['duration_seconds'],'gold_transcript':sentence['languages'][config]['transcription'],'actual_asr_text':transcript,'actual_mt_input':transcript,'translated_text':translated,'gold_target_reference':sentence['languages'][LANGUAGES[target]]['transcription'],'asr_wall_seconds':asr_wall,'mt_wall_seconds':mt_wall,'total_after_full_utterance_seconds':time.monotonic()-started,'asr_worker':asr.last_result,'mt_worker':mt.last_result,'quality_status':'unreviewed'}
                results.append(row);atomic_json(destination/'results.json',{'selection_sha256':SELECTION_SHA256,'cgroup_limits':limits,'results':results,'cancellations':cancellations,'scope':'Whole-utterance real audio→ASR→MT through reusable isolated workers. No TTS or LiveKit. No first-audio latency measurement.'})
                print('PIPELINE_RESULT',language,index+1,round(row['total_after_full_utterance_seconds'],3),flush=True)
            # The already loaded real ASR engine is interrupted during another inference.
            old_pid=asr.stage.pid;started=time.monotonic();pending=asyncio.create_task(asr(audio,language))
            await asyncio.sleep(.1);pending.cancel()
            try:await pending
            except asyncio.CancelledError:pass
            else:raise AssertionError('Real ASR unexpectedly completed before cancellation')
            try:os.kill(old_pid,0)
            except ProcessLookupError:terminated=True
            else:terminated=False
            if not terminated or asr.stage.pid is not None:raise AssertionError('Real ASR process remains after cancellation')
            cancellations.append({'language':language,'real_asr_model_inference':True,'worker_reaped':terminated,'cancel_to_reaped_seconds':time.monotonic()-started-.1})
            atomic_json(destination/'results.json',{'selection_sha256':SELECTION_SHA256,'cgroup_limits':limits,'results':results,'cancellations':cancellations,'scope':'Whole-utterance real audio→ASR→MT through reusable isolated workers. No TTS or LiveKit. No first-audio latency measurement.'})
            print('REAL_ASR_CANCELLED_AND_REAPED',language,cancellations[-1]['cancel_to_reaped_seconds'],flush=True)
        finally:await asr.close();await mt.close()
    if len(results)!=12 or len(cancellations)!=4:raise AssertionError('Incomplete real pipeline smoke')
    print('PIPELINE_COMPLETE',len(results),len(cancellations),flush=True)

if __name__=='__main__':asyncio.run(main())
