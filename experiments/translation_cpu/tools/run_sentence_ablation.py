#!/usr/bin/env python3
"""Evaluate one explicit sentence wrapper on the same pinned MT weights, not a new model."""
from __future__ import annotations
import argparse, datetime, hashlib, importlib.metadata, json, os, pathlib, resource, sys, threading, time
from fetch_opus_release import ROOT, sha256, atomic_json
from run_mt40 import SETTINGS, SELECTION_SHA256, TARGET_TOKENS, cases_for, source_tokens, cgroup_limits, read_records, append_record, percentile
sys.path.insert(0,str(ROOT))
from sentence_segments import split_sentences


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('direction',choices=['en-ru','ru-en','en-zh','zh-en','en-ar','ar-en'])
    parser.add_argument('--suite',choices=['core','heldout'],default='core')
    parser.add_argument('--whole',action='store_true',help='Unsegmented comparison; required for heldout baseline only')
    args=parser.parse_args();source,target=args.direction.split('-')
    if args.whole and args.suite!='heldout':raise ValueError('Core baseline is already preserved; do not rerun it here')
    if args.suite=='core':cases=cases_for(args.direction)
    else:
        p=ROOT/'data/mt40_holdout.json'
        if sha256(p)!='a8b8bc9fb819288f607e189ab787772ea5e4232ddfe37425e767999415404dff':raise ValueError('Frozen holdout changed')
        cases=[{'case_id':'heldout-'+c['id'],'kind':'authored_heldout','input':c['texts'][source],'reference':c['texts'][target],'slots':c['slots']} for c in json.loads(p.read_text())['cases']]
    mode='whole' if args.whole else 'sentences'
    run_id='opus-'+args.suite+'-'+mode+'-20261103'
    provenance=ROOT/'data/provenance/opus'
    conversion=json.loads((provenance/(args.direction+'.conversion.json')).read_text())
    model=ROOT/'data/models/opus_ct2'/args.direction
    for file in conversion['converted_files']:
        if sha256(model/file['path'])!=file['sha256']:raise ValueError('Model bundle changed')
    if conversion['target_token']!=TARGET_TOKENS.get(args.direction):raise ValueError('Wrong target token')
    limits=cgroup_limits();directory=ROOT/'data/mt40'/run_id;directory.mkdir(parents=True,exist_ok=True)
    output=directory/(args.direction+'.jsonl');journal=directory/(args.direction+'.attempts.jsonl')
    fingerprints={'mode':mode,'suite':args.suite,'model_sha256':conversion['model_sha256'],'target_token':conversion['target_token'],'settings':SETTINGS,'selection_sha256':SELECTION_SHA256,'cases_sha256':hashlib.sha256(json.dumps(cases,ensure_ascii=False,sort_keys=True).encode()).hexdigest(),'runner_sha256':sha256(pathlib.Path(__file__)),'segmenter_sha256':sha256(ROOT/'sentence_segments.py')}
    config_id=hashlib.sha256(json.dumps(fingerprints,sort_keys=True).encode()).hexdigest()
    previous=read_records(output)
    if any(r['config_id']!=config_id for r in previous):raise ValueError('Existing ablation differs')
    completed={r['case_id'] for r in previous if r['status']=='ok'}
    import ctranslate2
    import sentencepiece as spm
    started_load=time.monotonic()
    engine=ctranslate2.Translator(str(model),device='cpu',compute_type='int8',intra_threads=1,inter_threads=1)
    source_sp=spm.SentencePieceProcessor(model_file=str(model/'source.spm'));target_sp=spm.SentencePieceProcessor(model_file=str(model/'target.spm'))
    load_seconds=time.monotonic()-started_load
    print('ABLATION_READY',run_id,args.direction,len(cases),flush=True)
    for index,case in enumerate(cases):
        if case['case_id'] in completed:continue
        record={**case,'run_id':run_id,'direction':args.direction,'source_language':source,'target_language':target,'mode':mode,'model_sha256':conversion['model_sha256'],'source_archive_sha256':conversion['source_archive_sha256'],'target_token':conversion['target_token'],'config_id':config_id,'segments':[],'status':'running','output':None,'error':None,'quality_status':'unreviewed','started_at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
        append_record(journal,{'case_id':case['case_id'],'config_id':config_id,'state':'started'})
        started=time.monotonic();done=threading.Event()
        def watchdog():
            if not done.wait(SETTINGS['per_item_seconds']):print('ABLATION_DEADLINE_EXIT',case['case_id'],flush=True);os._exit(124)
        guard=threading.Thread(target=watchdog,daemon=True);guard.start()
        try:
            parts=[case['input']] if args.whole else split_sentences(case['input'])
            if not parts:raise ValueError('Empty input')
            for part in parts:
                tokens=source_tokens(part,source_sp,args.direction)
                if not tokens or len(tokens)>SETTINGS['max_input_tokens']:raise ValueError('Input token cap; no silent truncation')
                segment_started=time.monotonic()
                result=engine.translate_batch([tokens],beam_size=SETTINGS['beam_size'],length_penalty=1.0,max_input_length=0,max_decoding_length=SETTINGS['max_output_tokens'],return_end_token=True,return_scores=True)[0]
                generated=result.hypotheses[0]
                if not generated or generated[-1]!='</s>':raise ValueError('No EOS; partial output rejected')
                record['segments'].append({'input':part,'output':target_sp.decode(generated[:-1]),'input_tokens':len(tokens),'output_tokens':len(generated),'seconds':round(time.monotonic()-segment_started,6),'score':result.scores[0]})
            if time.monotonic()-started>SETTINGS['per_item_seconds']:raise TimeoutError('Per-item deadline')
            record['output']=('' if target=='zh' else ' ').join(s['output'] for s in record['segments'])
            record['status']='ok'
        except Exception as error:record['status']='error';record['error']={'type':type(error).__name__,'message':str(error)}
        finally:done.set();guard.join(timeout=1)
        record['inference_seconds']=round(time.monotonic()-started,6);record['max_rss_kib']=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        append_record(output,record);append_record(journal,{'case_id':case['case_id'],'config_id':config_id,'state':record['status']})
        print('ABLATION_RESULT',args.direction,args.suite,mode,index+1,len(cases),case['case_id'],record['status'],record['inference_seconds'],flush=True)
    latest={r['case_id']:r for r in read_records(output)};results=[latest[c['case_id']] for c in cases if c['case_id'] in latest]
    good=[r for r in results if r['status']=='ok'];times=[r['inference_seconds'] for r in good]
    summary={'run_id':run_id,'direction':args.direction,'same_weights_wrapper_comparison':True,'config_id':config_id,'expected_cases':len(cases),'successful_inference':len(good),'errors':len(results)-len(good),'quality_status':'unreviewed','model_load_seconds_this_invocation':load_seconds,'stage_seconds':{'p50':percentile(times,.5),'p95':percentile(times,.95),'max':max(times) if times else None},'max_rss_kib':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,'fingerprints':fingerprints,'cgroup_limits':limits,'output_sha256':sha256(output),'finished_at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
    atomic_json(directory/(args.direction+'.summary.json'),summary)
    print('ABLATION_COMPLETE',json.dumps(summary),flush=True)
    if len(good)!=len(cases):raise SystemExit(1)

if __name__=='__main__':main()
