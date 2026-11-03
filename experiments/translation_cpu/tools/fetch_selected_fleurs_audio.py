#!/usr/bin/env python3
"""Stream a pinned official test archive; persist only the 40 already selected WAVs."""
from __future__ import annotations
import argparse, datetime, hashlib, json, os, pathlib, shutil, tarfile, time, urllib.parse, urllib.request
from fetch_opus_release import ROOT, sha256, atomic_json
from run_mt40 import SELECTION_SHA256, cgroup_limits

class BoundedHashReader:
    def __init__(self, stream, max_bytes, max_seconds=600):
        self.stream=stream;self.max_bytes=max_bytes;self.started=time.monotonic();self.max_seconds=max_seconds
        self.digest=hashlib.sha256();self.bytes=0
    def read(self, size=-1):
        if time.monotonic()-self.started>self.max_seconds:raise TimeoutError('Archive stream deadline')
        data=self.stream.read(min(size if size>=0 else 1024*1024,1024*1024))
        self.bytes+=len(data)
        if self.bytes>self.max_bytes:raise ValueError('Compressed archive byte cap')
        self.digest.update(data)
        return data

def selected_member(info, selected):
    path=pathlib.PurePosixPath(info.name)
    if path.is_absolute() or '..' in path.parts or '\\' in info.name:raise ValueError('Unsafe tar path')
    if info.issym() or info.islnk() or not (info.isfile() or info.isdir()):raise ValueError('Tar links and special files prohibited')
    if path.name not in selected:return None
    if not info.isfile() or path.parts not in [(path.name,),('test',path.name)]:raise ValueError('Unexpected selected path')
    if info.size>8*1024*1024:raise ValueError('Selected clip exceeds byte cap')
    return path.name

def main():
    parser=argparse.ArgumentParser();parser.add_argument('config',choices=['en_us','ru_ru','cmn_hans_cn','ar_eg']);args=parser.parse_args()
    limits=cgroup_limits()
    subset=ROOT/'data/fleurs_subset'
    if sha256(subset/'selection_manifest.json')!=SELECTION_SHA256:raise ValueError('Saved selection changed')
    selection=json.loads((subset/'selection_manifest.json').read_text())
    source=json.loads((subset/'audio_sources.json').read_text())['sources'][args.config]
    selected={s['languages'][args.config]['file']:{'sentence_id':s['sentence_id'],**s['languages'][args.config]} for s in selection['sentences']}
    if len(selected)!=40:raise ValueError('Expected exact 40 selected files')
    out=subset/'audio'/args.config
    manifest_path=subset/('audio-'+args.config+'.json')
    if manifest_path.exists():
        previous=json.loads(manifest_path.read_text())
        if previous['archive_sha256']!=source['sha256'] or previous['selection_sha256']!=SELECTION_SHA256:raise ValueError('Existing source differs')
        for file in previous['clips']:
            if sha256(out/file['file'])!=file['sha256']:raise ValueError('Cached selected clip corrupted')
        print('VERIFIED_SELECTED_AUDIO',args.config,40,flush=True);return
    incoming=subset/('audio-incoming-'+args.config)
    if incoming.exists():shutil.rmtree(incoming)
    incoming.mkdir(parents=True)
    found={};started=time.monotonic();decompressed_bytes=0
    if source['bytes']>800*1024*1024:raise ValueError('Official test archive exceeds configured cap')
    request=urllib.request.Request(source['url'],headers={'User-Agent':'IMON-Meets-reproducible-evaluation/1','Accept-Encoding':'identity'})
    try:
        with urllib.request.urlopen(request,timeout=30) as response:
            final=urllib.parse.urlsplit(response.url)
            if final.scheme!='https' or not (final.hostname=='huggingface.co' or final.hostname.endswith(('.huggingface.co','.hf.co'))):raise ValueError('Unexpected asset host')
            reader=BoundedHashReader(response,source['bytes'])
            with tarfile.open(fileobj=reader,mode='r|gz') as archive:
                for info in archive:
                    decompressed_bytes+=info.size
                    if decompressed_bytes>2*1024*1024*1024:raise ValueError('Decompressed test archive cap')
                    name=selected_member(info,selected)
                    if not name:continue
                    if name in found:raise ValueError('Duplicate selected clip')
                    stream=archive.extractfile(info)
                    with stream, (incoming/name).open('wb') as output:
                        shutil.copyfileobj(stream,output,length=1024*1024)
                    found[name]={'file':name,'sentence_id':selected[name]['sentence_id'],'bytes':info.size,'sha256':sha256(incoming/name)}
                    print('SELECTED_AUDIO',args.config,len(found),40,selected[name]['sentence_id'],flush=True)
            while reader.read(1024*1024):pass
        if reader.bytes!=source['bytes'] or reader.digest.hexdigest()!=source['sha256']:raise ValueError('Official archive size/SHA-256 mismatch')
        if set(found)!=set(selected):raise ValueError('Missing selected clips')
        import soundfile
        for name in selected:
            info=soundfile.info(str(incoming/name))
            if info.samplerate!=16000 or info.channels!=1 or info.frames!=selected[name]['num_samples']:raise ValueError('Selected audio metadata differs from preserved manifest')
            found[name].update({'sample_rate':info.samplerate,'channels':info.channels,'num_samples':info.frames,'duration_seconds':info.frames/info.samplerate,'subtype':info.subtype})
        if out.exists():raise ValueError('Unmanifested destination already exists')
        out.parent.mkdir(exist_ok=True);os.replace(incoming,out)
        record={'config':args.config,'dataset':'google/fleurs','dataset_revision':source['revision'],'license':'CC-BY-4.0','selection_sha256':SELECTION_SHA256,'archive_url':source['url'],'archive_sha256':reader.digest.hexdigest(),'archive_bytes_read':reader.bytes,'decompressed_bytes_streamed':decompressed_bytes,'archive_persisted':False,'nonselected_clips_persisted':0,'selected_clips':40,'selected_bytes':sum(x['bytes'] for x in found.values()),'download_extract_seconds':round(time.monotonic()-started,3),'verified_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'cgroup_limits':limits,'clips':[found[s['languages'][args.config]['file']] for s in selection['sentences']]}
        atomic_json(manifest_path,record)
        print('AUDIO_COMPLETE',json.dumps({k:v for k,v in record.items() if k!='clips'}),flush=True)
    except BaseException:
        if incoming.exists():shutil.rmtree(incoming)
        raise

if __name__=='__main__':main()
