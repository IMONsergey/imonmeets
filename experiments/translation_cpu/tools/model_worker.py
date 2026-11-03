#!/usr/bin/env python3
"""Offline experiment worker. Loads only verified local ASR or MT assets; no TTS fallback."""
from __future__ import annotations
import argparse,base64,io,json,pathlib,sys,time
from fetch_opus_release import ROOT,sha256
from run_mt40 import TARGET_TOKENS,source_tokens,cgroup_limits
sys.path.insert(0,str(ROOT))
from sentence_segments import split_sentences
MAX_LINE=4*1024*1024


def main():
    parser=argparse.ArgumentParser();parser.add_argument('stage',choices=['asr','mt']);parser.add_argument('--language',choices=['en','ru','zh','ar']);parser.add_argument('--model',choices=['base','small'],default='base');parser.add_argument('--direction',choices=['en-ru','ru-en','en-zh','zh-en','en-ar','ar-en']);args=parser.parse_args()
    cgroup_limits()
    loaded=time.monotonic()
    if args.stage=='asr':
        if not args.language:raise ValueError('ASR language required')
        inventory=json.loads((ROOT/'data/lineage/installed_artifacts.json').read_text());repo='Systran/faster-whisper-'+args.model
        item=inventory['whisper'][repo];revision=item['refs']['main'];directory=ROOT/'data/models/whisper'/('models--'+repo.replace('/','--'))/'snapshots'/revision
        for file in item['snapshots'][revision]:
            if sha256(directory/file['path'])!=file['sha256']:raise ValueError('ASR artifact hash mismatch')
        model_sha=next(f['sha256'] for f in item['snapshots'][revision] if f['path']=='model.bin')
        from faster_whisper import WhisperModel
        import soundfile
        engine=WhisperModel(str(directory),device='cpu',compute_type='int8',cpu_threads=1,num_workers=1,local_files_only=True)
        def infer(payload):
            encoded=payload.get('audio_base64')
            if not isinstance(encoded,str) or len(encoded)>4*1024*1024:raise ValueError('Audio payload cap')
            audio=base64.b64decode(encoded,validate=True)
            if not audio or len(audio)>3*1024*1024 or audio[:4]!=b'RIFF' or audio[8:12]!=b'WAVE':raise ValueError('Only bounded WAV utterances accepted')
            info=soundfile.info(io.BytesIO(audio))
            if info.samplerate!=16000 or info.channels!=1 or info.duration<=0 or info.duration>30:raise ValueError('Only mono16kHz WAV up to30s accepted')
            segments,metadata=engine.transcribe(io.BytesIO(audio),language=args.language,beam_size=5,temperature=0.0,condition_on_previous_text=False,vad_filter=False,word_timestamps=False)
            text=''.join(s.text for s in segments).strip()
            return {'text':text,'audio_duration_seconds':info.duration,'language':metadata.language,'model_revision':revision}
    else:
        if not args.direction:raise ValueError('MT direction required')
        conversion=json.loads((ROOT/'data/provenance/opus'/(args.direction+'.conversion.json')).read_text());directory=ROOT/'data/models/opus_ct2'/args.direction
        if conversion['license']!='CC-BY-4.0' or conversion['target_token']!=TARGET_TOKENS.get(args.direction):raise ValueError('MT artifact license/token gate')
        for file in conversion['converted_files']:
            if sha256(directory/file['path'])!=file['sha256']:raise ValueError('MT artifact hash mismatch')
        model_sha=conversion['model_sha256']
        import ctranslate2,sentencepiece as spm
        engine=ctranslate2.Translator(str(directory),device='cpu',compute_type='int8',intra_threads=1,inter_threads=1)
        source_sp=spm.SentencePieceProcessor(model_file=str(directory/'source.spm'));target_sp=spm.SentencePieceProcessor(model_file=str(directory/'target.spm'))
        def infer(payload):
            text=payload.get('text')
            if not isinstance(text,str) or not text.strip():raise ValueError('Nonempty text required')
            results=[]
            for part in split_sentences(text):
                tokens=source_tokens(part,source_sp,args.direction)
                if len(tokens)>512:raise ValueError('MT input token cap')
                result=engine.translate_batch([tokens],beam_size=6,length_penalty=1,max_input_length=0,max_decoding_length=512,return_end_token=True)[0].hypotheses[0]
                if not result or result[-1]!='</s>':raise ValueError('MT output truncated')
                results.append(target_sp.decode(result[:-1]))
            return {'text':('' if args.direction.endswith('-zh') else ' ').join(results),'segments':len(results),'target_token':TARGET_TOKENS.get(args.direction)}
    load_seconds=time.monotonic()-loaded
    while True:
        line=sys.stdin.buffer.readline(MAX_LINE+1)
        if not line:return
        if len(line)>MAX_LINE or not line.endswith(b'\n'):raise ValueError('Worker request byte cap')
        request=json.loads(line);request_id=request.get('id');started=time.monotonic()
        try:
            if not isinstance(request_id,int) or not isinstance(request.get('payload'),dict):raise ValueError('Invalid request envelope')
            result=infer(request['payload']);result.update({'model_sha256':model_sha,'worker_inference_seconds':time.monotonic()-started,'worker_load_seconds':load_seconds})
            response={'id':request_id,'ok':True,'result':result}
        except Exception as error:
            response={'id':request_id,'ok':False,'error_type':type(error).__name__}
        sys.stdout.write(json.dumps(response,ensure_ascii=False)+'\n');sys.stdout.flush()

if __name__=='__main__':main()
