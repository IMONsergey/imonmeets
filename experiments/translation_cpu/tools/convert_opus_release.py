#!/usr/bin/env python3
"""Convert a pinned official NPZ release to INT8; no pickle, remote code or shell hooks."""
from __future__ import annotations
import argparse, datetime, hashlib, importlib.metadata, json, os, pathlib, shutil, stat, time, zipfile
from fetch_opus_release import ROOT, sha256, atomic_json
ALLOWED_NAMES = {'README.md','LICENSE','decoder.yml','source.spm','target.spm'}

def archive_members(infos):
    names = set()
    selected = []
    total = 0
    for item in infos:
        path = pathlib.PurePosixPath(item.filename)
        mode = item.external_attr >> 16
        if path.is_absolute() or len(path.parts) != 1 or '\\' in item.filename or path.name in {'.','..'}:
            raise ValueError('Archive path is not a flat relative filename')
        if item.filename in names or stat.S_ISLNK(mode): raise ValueError('Duplicate or symlink archive member')
        names.add(item.filename)
        if item.filename in ALLOWED_NAMES or item.filename.endswith(('.npz','.yml')):
            if item.file_size > 768*1024*1024: raise ValueError('Member size cap')
            total += item.file_size
            selected.append(item)
    if total > 1024*1024*1024 or len(selected) > 40: raise ValueError('Archive extraction cap')
    if not {'LICENSE','decoder.yml','source.spm','target.spm'} <= {i.filename for i in selected}:
        raise ValueError('Missing required release artifacts')
    return selected

def local_artifact(directory, name):
    if not isinstance(name,str) or pathlib.PurePosixPath(name).name != name or '\\' in name or name in {'.','..'}:
        raise ValueError('Decoder path escapes model directory')
    path = directory/name
    if not path.is_file() or path.is_symlink(): raise ValueError('Missing or symlink decoder artifact')
    return path

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('direction', choices=['en-ru','ru-en','en-zh','zh-en','en-ar','ar-en'])
    args = parser.parse_args()
    provenance = ROOT/'data/provenance/opus'
    downloaded = json.loads((provenance/(args.direction+'.download.json')).read_text())
    source = ROOT/'data/models/opus_original'/args.direction
    archive = source/'release.zip'
    if sha256(archive) != downloaded['archive_sha256']: raise ValueError('Archive hash mismatch')
    destination = ROOT/'data/models/opus_ct2'/args.direction
    record_path = provenance/(args.direction+'.conversion.json')
    if destination.exists():
        if not record_path.exists(): raise ValueError('Existing conversion has no integrity record')
        previous = json.loads(record_path.read_text())
        if previous['source_archive_sha256'] != downloaded['archive_sha256']: raise ValueError('Wrong source checkpoint')
        for file in previous['converted_files']:
            if sha256(destination/file['path']) != file['sha256']: raise ValueError('Converted artifact hash mismatch')
        print('VERIFIED_CONVERSION', args.direction, previous['model_sha256'], flush=True)
        return
    unpacked = source/'unpacked'
    unpacked.mkdir(exist_ok=True)
    with zipfile.ZipFile(archive) as zipped:
        selected = archive_members(zipped.infolist())
        for item in selected:
            path = unpacked/item.filename
            if path.is_symlink(): raise ValueError('Symlink extraction destination')
            with zipped.open(item) as incoming, path.open('wb') as outgoing:
                shutil.copyfileobj(incoming, outgoing, length=1024*1024)
    license_bytes = (unpacked/'LICENSE').read_bytes()
    if not license_bytes.startswith(b'Attribution 4.0 International'):
        raise ValueError('Release lacks expected CC-BY-4.0 license')
    import yaml
    import numpy as np
    decoder = yaml.safe_load((unpacked/'decoder.yml').read_text())
    if len(decoder.get('models',[])) != 1 or len(decoder.get('vocabs',[])) != 2:
        raise ValueError('Unsupported decoder layout')
    model = local_artifact(unpacked,decoder['models'][0])
    vocabs = [local_artifact(unpacked,n) for n in decoder['vocabs']]
    if not model.name.endswith('.npz'): raise ValueError('Only data-only NPZ weights accepted')
    # Inspect every array with pickle disabled before the converter can access it.
    with np.load(model, allow_pickle=False) as weights:
        for name in weights.files:
            if weights[name].dtype.hasobject: raise ValueError('Object array is prohibited')
    from ctranslate2.converters.marian import MarianConverter
    started = time.monotonic()
    temporary = destination.with_name(destination.name+'.partial')
    if temporary.exists(): shutil.rmtree(temporary)
    temporary.parent.mkdir(parents=True,exist_ok=True)
    MarianConverter(str(model),[str(v) for v in vocabs]).convert(str(temporary),quantization='int8',force=False)
    for name in ('source.spm','target.spm','LICENSE','README.md'):
        if (unpacked/name).exists(): shutil.copy2(unpacked/name, temporary/name)
    files = [{'path':p.name,'bytes':p.stat().st_size,'sha256':sha256(p)} for p in sorted(temporary.iterdir()) if p.is_file()]
    source_files = [{'path':p.name,'bytes':p.stat().st_size,'sha256':sha256(p)} for p in sorted(unpacked.iterdir()) if p.is_file()]
    record = {'direction':args.direction,'source_archive_sha256':downloaded['archive_sha256'],'source_npz_sha256':sha256(model),'source_npz':model.name,'license':'CC-BY-4.0','license_sha256':hashlib.sha256(license_bytes).hexdigest(),'source_files':source_files,'converted_files':files,'model_sha256':next(f['sha256'] for f in files if f['path']=='model.bin'),'target_token':downloaded['target_token'],'quantization':'int8','conversion_seconds':round(time.monotonic()-started,3),'converter':'CTranslate2 MarianConverter','versions':{n:importlib.metadata.version(n) for n in ['ctranslate2','numpy','PyYAML','sentencepiece']},'created_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'pickle_allowed':False,'remote_code':False,'archive_scripts_executed':False}
    atomic_json(record_path,record)
    os.replace(temporary,destination)
    shutil.copy2(unpacked/'LICENSE',provenance/(args.direction+'.LICENSE'))
    print('CONVERTED',args.direction,json.dumps({k:v for k,v in record.items() if k not in {'converted_files','source_files'}},ensure_ascii=False),flush=True)

if __name__ == '__main__': main()
