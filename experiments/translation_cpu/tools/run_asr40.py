#!/usr/bin/env python3
"""Real local ASR on the unchanged, individually hashed FLEURS audio selection."""
from __future__ import annotations
import argparse, datetime, hashlib, importlib.metadata, json, os, pathlib, resource, threading, time, unicodedata
from fetch_opus_release import ROOT, sha256, atomic_json
from run_mt40 import SELECTION_SHA256, LANGUAGES, cgroup_limits, read_records, append_record, percentile
SETTINGS={'beam_size':5,'temperature':0.0,'condition_on_previous_text':False,'vad_filter':False,'word_timestamps':False,'compute_type':'int8','cpu_threads':1,'num_workers':1,'per_clip_seconds':90,'normalization':'NFKC + lowercase; punctuation/symbols replaced by spaces; whitespace collapsed. CER excludes whitespace. Chinese reports CER only.'}

def normalize(text):
    text=unicodedata.normalize('NFKC',text).lower()
    text=''.join(' ' if unicodedata.category(c)[0] in {'P','S'} else c for c in text)
    return ' '.join(text.split())

def edit_distance(reference,hypothesis):
    previous=list(range(len(hypothesis)+1))
    for i,a in enumerate(reference,1):
        current=[i]
        for j,b in enumerate(hypothesis,1):
            current.append(min(previous[j]+1,current[-1]+1,previous[j-1]+(a!=b)))
        previous=current
    return previous[-1]

def metrics(reference,hypothesis,language):
    ref=normalize(reference);hyp=normalize(hypothesis)
    rw=ref.split();hw=hyp.split();rc=''.join(rw);hc=''.join(hw)
    return {'normalized_reference':ref,'normalized_hypothesis':hyp,'reference_words':len(rw) if language!='zh' else None,'word_errors':edit_distance(rw,hw) if language!='zh' else None,'reference_characters':len(rc),'character_errors':edit_distance(rc,hc)}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('language',choices=list(LANGUAGES));parser.add_argument('--model',choices=['base','small'],default='base');args=parser.parse_args()
    limits=cgroup_limits()
    subset=ROOT/'data/fleurs_subset'
    if sha256(subset/'selection_manifest.json')!=SELECTION_SHA256:raise ValueError('Saved selection changed')
    selected=json.loads((subset/'selection_manifest.json').read_text())
    config=LANGUAGES[args.language]
    audio_manifest=json.loads((subset/('audio-'+config+'.json')).read_text())
    if audio_manifest['selection_sha256']!=SELECTION_SHA256 or audio_manifest['selected_clips']!=40:raise ValueError('Wrong audio selection')
    clips={c['sentence_id']:c for c in audio_manifest['clips']}
    inventory=json.loads((ROOT/'data/lineage/installed_artifacts.json').read_text())
    repo='Systran/faster-whisper-'+args.model
    item=inventory['whisper'][repo]
    revision=item['refs']['main']
    model=ROOT/'data/models/whisper'/('models--'+repo.replace('/','--'))/'snapshots'/revision
    for file in item['snapshots'][revision]:
        if sha256(model/file['path'])!=file['sha256']:raise ValueError('Whisper artifact hash mismatch: '+file['path'])
    model_sha=next(f['sha256'] for f in item['snapshots'][revision] if f['path']=='model.bin')
    directory=ROOT/'data/asr40'/('faster-whisper-'+args.model+'-20261103');directory.mkdir(parents=True,exist_ok=True)
    output=directory/(args.language+'.jsonl');journal=directory/(args.language+'.attempts.jsonl')
    fingerprints={'selection_sha256':SELECTION_SHA256,'audio_manifest_sha256':sha256(subset/('audio-'+config+'.json')),'repository':repo,'revision':revision,'model_sha256':model_sha,'settings':SETTINGS,'language':args.language,'runner_sha256':sha256(pathlib.Path(__file__))}
    config_id=hashlib.sha256(json.dumps(fingerprints,sort_keys=True).encode()).hexdigest()
    previous=read_records(output)
    if any(r['config_id']!=config_id for r in previous):raise ValueError('Existing ASR settings differ')
    completed={r['sentence_id'] for r in previous if r['status']=='ok'}
    from faster_whisper import WhisperModel
    started_load=time.monotonic()
    engine=WhisperModel(str(model),device='cpu',compute_type='int8',cpu_threads=1,num_workers=1,local_files_only=True)
    model_load_seconds=time.monotonic()-started_load
    print('ASR_MODEL_READY',args.language,args.model,revision,model_sha,'resume',len(completed),flush=True)
    for index,sentence in enumerate(selected['sentences']):
        sid=sentence['sentence_id']
        if sid in completed:continue
        gold=sentence['languages'][config];clip=clips[sid];path=subset/'audio'/config/clip['file']
        if clip['file']!=gold['file'] or clip['num_samples']!=gold['num_samples'] or sha256(path)!=clip['sha256']:raise ValueError('Clip differs from selected/hashed input')
        record={'sentence_id':sid,'language':args.language,'model':repo,'revision':revision,'model_sha256':model_sha,'config_id':config_id,'audio_file':clip['file'],'audio_sha256':clip['sha256'],'audio_duration_seconds':clip['duration_seconds'],'reference':gold['transcription'],'reference_normalized_dataset':gold['raw_transcription'],'hypothesis':None,'segments':[],'status':'running','error':None,'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'quality_status':'unreviewed'}
        append_record(journal,{'sentence_id':sid,'config_id':config_id,'state':'started','started_at':record['started_at']})
        started=time.monotonic();done=threading.Event()
        def watchdog():
            if not done.wait(SETTINGS['per_clip_seconds']):
                print('ASR_CLIP_DEADLINE_WORKER_EXIT',args.language,sid,flush=True);os._exit(124)
        guard=threading.Thread(target=watchdog,daemon=True);guard.start()
        try:
            segments,info=engine.transcribe(str(path),language=args.language,task='transcribe',beam_size=SETTINGS['beam_size'],temperature=0.0,condition_on_previous_text=False,vad_filter=False,word_timestamps=False)
            for segment in segments:
                record['segments'].append({'start':segment.start,'end':segment.end,'text':segment.text,'avg_logprob':segment.avg_logprob,'no_speech_prob':segment.no_speech_prob})
            record['hypothesis']=''.join(s['text'] for s in record['segments']).strip()
            record['metrics']=metrics(record['reference'],record['hypothesis'],args.language)
            record['status']='ok';record['reported_language']=info.language;record['reported_language_probability']=info.language_probability
        except Exception as error:
            record['status']='error';record['error']={'type':type(error).__name__,'message':str(error)}
        finally:
            done.set();guard.join(timeout=1)
        record['asr_seconds']=round(time.monotonic()-started,6)
        record['real_time_factor']=round(record['asr_seconds']/clip['duration_seconds'],6)
        record['max_rss_kib']=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        append_record(output,record);append_record(journal,{'sentence_id':sid,'state':record['status'],'config_id':config_id})
        print('ASR_RESULT',args.language,args.model,index+1,40,sid,record['status'],record['asr_seconds'],record['real_time_factor'],flush=True)
    latest={r['sentence_id']:r for r in read_records(output)}
    results=[latest[s['sentence_id']] for s in selected['sentences'] if s['sentence_id'] in latest]
    good=[r for r in results if r['status']=='ok'];times=[r['asr_seconds'] for r in good]
    words=sum(r['metrics']['reference_words'] or 0 for r in good);word_errors=sum(r['metrics']['word_errors'] or 0 for r in good)
    chars=sum(r['metrics']['reference_characters'] for r in good);char_errors=sum(r['metrics']['character_errors'] for r in good)
    seconds=sum(r['audio_duration_seconds'] for r in good)
    summary={'language':args.language,'model':args.model,'expected_cases':40,'successful_inference':len(good),'errors':len(results)-len(good),'recorded_cases':len(results),'quality_status':'unreviewed','audio_seconds':round(seconds,3),'asr_seconds':round(sum(times),3),'aggregate_real_time_factor':sum(times)/seconds if seconds else None,'word_error_rate':word_errors/words if words else None,'character_error_rate':char_errors/chars if chars else None,'word_errors':word_errors if words else None,'reference_words':words or None,'character_errors':char_errors,'reference_characters':chars,'per_clip_seconds':{'p50':percentile(times,.5),'p95':percentile(times,.95),'max':max(times) if times else None},'model_load_seconds_this_invocation':model_load_seconds,'max_rss_kib':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,'cgroup_limits':limits,'fingerprints':fingerprints,'versions':{n:importlib.metadata.version(n) for n in ['faster-whisper','ctranslate2','av','tokenizers']},'output_sha256':sha256(output),'finished_at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
    atomic_json(directory/(args.language+'.summary.json'),summary)
    print('ASR_DIRECTION_COMPLETE',json.dumps(summary),flush=True)
    if len(good)!=40:raise SystemExit(1)

if __name__=='__main__':main()
