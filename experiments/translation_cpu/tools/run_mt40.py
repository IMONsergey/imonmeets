#!/usr/bin/env python3
"""Real bounded MT on the preserved 40 common FLEURS IDs, with per-direction resume."""
from __future__ import annotations
import argparse, datetime, hashlib, importlib.metadata, json, math, os, pathlib, resource, threading, time, unicodedata
from fetch_opus_release import ROOT, sha256, atomic_json
SELECTION_SHA256 = 'caf155b7d8b440132295416f7d0ebd210061add74672e39d7e929dffb60ae62a'
LANGUAGES = {'en':'en_us','ru':'ru_ru','zh':'cmn_hans_cn','ar':'ar_eg'}
TARGET_TOKENS = {'en-zh':'>>cmn_Hans<<','en-ar':'>>ara<<'}
RUN_ID = 'opus-original-20261103'
SETTINGS = {'beam_size':6,'length_penalty':1.0,'max_input_tokens':512,'max_output_tokens':512,'per_item_seconds':45,'intra_threads':1,'inter_threads':1,'compute_type':'int8','normalization':'NFKC, remove non-printing characters, collapse whitespace; SentencePiece internal normalization'}

def cases_for(direction):
    source,target = direction.split('-')
    if source == target or source not in LANGUAGES or target not in LANGUAGES: raise ValueError('Invalid direction')
    selection_path = ROOT/'data/fleurs_subset/selection_manifest.json'
    if sha256(selection_path) != SELECTION_SHA256: raise ValueError('Saved selection changed')
    selection = json.loads(selection_path.read_text())
    cases = []
    for sentence in selection['sentences']:
        cases.append({'case_id':'fleurs-'+str(sentence['sentence_id']),'kind':'fleurs_gold_text','sentence_id':sentence['sentence_id'],'input':sentence['languages'][LANGUAGES[source]]['transcription'],'reference':sentence['languages'][LANGUAGES[target]]['transcription'],'slots':None})
    if len(cases) != 40 or len({c['case_id'] for c in cases}) != 40: raise ValueError('Expected the same 40 IDs')
    contrasts = json.loads((ROOT/'data/mt40_contrasts.json').read_text())
    for case in contrasts['cases']:
        cases.append({'case_id':'contrast-'+case['id'],'kind':'authored_contrast','input':case['texts'][source],'reference':case['texts'][target],'slots':case['slots']})
    original = json.loads((ROOT/'data/corpus.json').read_text())
    for case in original['cases']:
        if case['source']==source and case['text']:
            cases.append({'case_id':'original-'+case['id'],'kind':'authored_existing_corpus','input':case['text'],'reference':None,'slots':case['slots'],'original_expected_target':case['target']})
    if len({c['case_id'] for c in cases}) != len(cases): raise ValueError('Duplicate cases')
    return cases

def source_tokens(text, tokenizer, direction):
    normalized = unicodedata.normalize('NFKC',text)
    normalized = ''.join(c for c in normalized if c.isspace() or not unicodedata.category(c).startswith('C'))
    normalized = ' '.join(normalized.split())
    tokens = tokenizer.encode(normalized,out_type=str)
    token = TARGET_TOKENS.get(direction)
    return ([token] if token else []) + tokens

def cgroup_limits():
    row = next(x for x in pathlib.Path('/proc/self/cgroup').read_text().splitlines() if x.startswith('0::'))
    directory = pathlib.Path('/sys/fs/cgroup')/row.split('::',1)[1].lstrip('/')
    quota,period = (directory/'cpu.max').read_text().split()
    memory = (directory/'memory.max').read_text().strip()
    if quota=='max' or int(quota)>int(period) or memory=='max' or int(memory)>2147483648:
        raise RuntimeError('Inference requires CPU <= 1 and memory <= 2 GiB cgroup')
    return {'cpu_max':quota+' '+period,'memory_max':int(memory),'pids_max':(directory/'pids.max').read_text().strip(),'cgroup':str(directory)}

def read_records(path):
    if not path.exists(): return []
    records = []
    for line in path.read_text().splitlines():
        if line.strip(): records.append(json.loads(line))
    return records

def append_record(path, record):
    with path.open('a',encoding='utf-8') as output:
        output.write(json.dumps(record,ensure_ascii=False)+'\n'); output.flush(); os.fsync(output.fileno())

def percentile(values, fraction):
    if not values: return None
    ordered=sorted(values)
    return round(ordered[max(0,math.ceil(fraction*len(ordered))-1)],4)

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('direction',choices=[a+'-'+b for a in LANGUAGES for b in LANGUAGES if a!=b])
    args=parser.parse_args()
    source,target=args.direction.split('-')
    cases=cases_for(args.direction)
    pivot = source!='en' and target!='en'
    loaded_direction = 'en-'+target if pivot else args.direction
    provenance=ROOT/'data/provenance/opus'
    conversion=json.loads((provenance/(loaded_direction+'.conversion.json')).read_text())
    model=ROOT/'data/models/opus_ct2'/loaded_direction
    for file in conversion['converted_files']:
        if sha256(model/file['path']) != file['sha256']: raise ValueError('Model bundle hash mismatch: '+file['path'])
    if conversion['target_token'] != TARGET_TOKENS.get(loaded_direction): raise ValueError('Target token differs from pinned model')
    limits=cgroup_limits()
    directory=ROOT/'data/mt40'/RUN_ID
    directory.mkdir(parents=True,exist_ok=True)
    output_path=directory/(args.direction+'.jsonl')
    journal_path=directory/(args.direction+'.attempts.jsonl')
    first_hop={}
    first_conversion=None
    if pivot:
        first_direction=source+'-en'
        first_conversion=json.loads((provenance/(first_direction+'.conversion.json')).read_text())
        for record in read_records(directory/(first_direction+'.jsonl')):
            first_hop[record['case_id']]=record
        for case in cases:
            prior=first_hop.get(case['case_id'])
            if not prior or prior['status']!='ok' or prior['input']!=case['input'] or prior['model_sha256']!=first_conversion['model_sha256']:
                raise ValueError('Missing matching successful real first hop for '+case['case_id'])
    fingerprints={'selection_sha256':SELECTION_SHA256,'cases_sha256':hashlib.sha256(json.dumps(cases,ensure_ascii=False,sort_keys=True).encode()).hexdigest(),'model_sha256':conversion['model_sha256'],'first_model_sha256':first_conversion['model_sha256'] if pivot else None,'target_token':conversion['target_token'],'settings':SETTINGS}
    config_id=hashlib.sha256(json.dumps(fingerprints,sort_keys=True).encode()).hexdigest()
    previous=read_records(output_path)
    if any(r['config_id']!=config_id for r in previous): raise ValueError('Existing output belongs to different evaluation inputs/settings')
    completed={r['case_id'] for r in previous if r['status']=='ok'}
    import ctranslate2
    import sentencepiece as spm
    loaded=time.monotonic()
    translator=ctranslate2.Translator(str(model),device='cpu',compute_type='int8',intra_threads=1,inter_threads=1)
    source_sp=spm.SentencePieceProcessor(model_file=str(model/'source.spm'))
    target_sp=spm.SentencePieceProcessor(model_file=str(model/'target.spm'))
    load_seconds=time.monotonic()-loaded
    print('MODEL_READY',args.direction,conversion['model_sha256'],'load_seconds',round(load_seconds,4),'cases',len(cases),'resume',len(completed),flush=True)
    for index,case in enumerate(cases):
        if case['case_id'] in completed: continue
        mt_input=first_hop[case['case_id']]['output'] if pivot else case['input']
        started=time.monotonic()
        utc=datetime.datetime.now(datetime.timezone.utc).isoformat()
        record={**case,'run_id':RUN_ID,'direction':args.direction,'source_language':source,'target_language':target,'pivot_language':'en' if pivot else None,'mt_input':mt_input,'target_token':conversion['target_token'],'model_sha256':conversion['model_sha256'],'model_chain':[first_conversion['model_sha256'],conversion['model_sha256']] if pivot else [conversion['model_sha256']],'source_archive_sha256':conversion['source_archive_sha256'],'config_id':config_id,'selection_sha256':SELECTION_SHA256,'started_at':utc,'output':None,'error':None,'quality_status':'unreviewed','status':'running'}
        if pivot: record['first_hop']={k:first_hop[case['case_id']][k] for k in ['direction','output','model_sha256','inference_seconds','target_token']}
        append_record(journal_path,{'case_id':case['case_id'],'config_id':config_id,'started_at':utc,'state':'started'})
        try:
            tokens=source_tokens(mt_input,source_sp,loaded_direction)
            record['input_tokens']=len(tokens)
            if not tokens or len(tokens)>SETTINGS['max_input_tokens']: raise ValueError('Input token budget exceeded; no silent truncation')
            finished=threading.Event()
            # CT2 callbacks support greedy decoding only. A watchdog terminates this
            # isolated worker on a stuck beam-search call; the start journal survives.
            def watchdog():
                if not finished.wait(SETTINGS['per_item_seconds']):
                    print('ITEM_DEADLINE_WORKER_EXIT',args.direction,case['case_id'],flush=True)
                    os._exit(124)
            guard=threading.Thread(target=watchdog,daemon=True)
            guard.start()
            try:
                result=translator.translate_batch([tokens],beam_size=SETTINGS['beam_size'],length_penalty=1.0,max_input_length=0,max_decoding_length=SETTINGS['max_output_tokens'],return_end_token=True,return_scores=True)[0]
            finally:
                finished.set();guard.join(timeout=1)
            generated=result.hypotheses[0]
            record['output_tokens']=len(generated)
            record['score']=result.scores[0]
            if time.monotonic()-started>SETTINGS['per_item_seconds']: raise TimeoutError('Per-item deadline reached; partial output rejected')
            if not generated or generated[-1]!='</s>': raise ValueError('No EOS before output cap; partial output rejected')
            record['output']=target_sp.decode(generated[:-1])
            record['status']='ok'
        except Exception as error:
            record['status']='error';record['error']={'type':type(error).__name__,'message':str(error)}
        record['inference_seconds']=round(time.monotonic()-started,6)
        record['pipeline_mt_seconds']=round(record['inference_seconds']+(record['first_hop']['inference_seconds'] if pivot else 0),6)
        record['max_rss_kib']=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        append_record(output_path,record)
        append_record(journal_path,{'case_id':case['case_id'],'config_id':config_id,'state':record['status'],'finished_at':datetime.datetime.now(datetime.timezone.utc).isoformat()})
        print('MT_RESULT',args.direction,index+1,len(cases),case['case_id'],record['status'],record['inference_seconds'],json.dumps(record['error']),flush=True)
    latest={r['case_id']:r for r in read_records(output_path)}
    results=[latest[c['case_id']] for c in cases if c['case_id'] in latest]
    seconds=[r['inference_seconds'] for r in results if r['status']=='ok']
    summary={'run_id':RUN_ID,'direction':args.direction,'config_id':config_id,'expected_cases':len(cases),'gold_cases':40,'recorded_cases':len(results),'successful_inference':sum(r['status']=='ok' for r in results),'errors':sum(r['status']!='ok' for r in results),'quality_status':'unreviewed','model_load_seconds_this_invocation':round(load_seconds,6),'stage_seconds':{'p50':percentile(seconds,.5),'p95':percentile(seconds,.95),'max':max(seconds) if seconds else None},'max_rss_kib':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,'cgroup_limits':limits,'fingerprints':fingerprints,'versions':{n:importlib.metadata.version(n) for n in ['ctranslate2','sentencepiece','numpy']},'finished_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'output_sha256':sha256(output_path)}
    atomic_json(directory/(args.direction+'.summary.json'),summary)
    print('DIRECTION_COMPLETE',json.dumps(summary,ensure_ascii=False),flush=True)
    if summary['errors'] or len(results)!=len(cases): raise SystemExit(1)

if __name__=='__main__':main()
