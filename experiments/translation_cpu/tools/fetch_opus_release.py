#!/usr/bin/env python3
"""Fetch only an explicitly recorded official OPUS release; never execute archive code."""
from __future__ import annotations
import argparse, datetime, hashlib, json, os, pathlib, time, urllib.parse, urllib.request, zipfile
ROOT = pathlib.Path(__file__).resolve().parents[1]
CAP = 768 * 1024 * 1024

def sha256(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for data in iter(lambda: stream.read(1024 * 1024), b''): h.update(data)
    return h.hexdigest()

def atomic_json(path, data):
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    os.replace(tmp, path)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('direction', choices=['en-ru','ru-en','en-zh','zh-en','en-ar','ar-en'])
    args = parser.parse_args()
    source = json.loads((ROOT/'data/provenance/opus/sources.json').read_text())['models'][args.direction]
    url = source['archive_url']
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname != 'object.pouta.csc.fi' or not parsed.path.endswith('.zip'):
        raise ValueError('Not an allowlisted official archive')
    directory = ROOT/'data/models/opus_original'/args.direction
    directory.mkdir(parents=True, exist_ok=True)
    archive = directory/'release.zip'
    record_path = ROOT/'data/provenance/opus'/(args.direction+'.download.json')
    if archive.exists():
        if not record_path.exists(): raise ValueError('Existing archive has no integrity record')
        record = json.loads(record_path.read_text())
        if record['archive_sha256'] != sha256(archive) or record['archive_url'] != url:
            raise ValueError('Existing archive differs from pinned record')
        print('VERIFIED_CACHED', args.direction, record['archive_sha256'], flush=True)
        return
    part = archive.with_suffix('.zip.part')
    started = time.monotonic()
    request = urllib.request.Request(url, headers={'User-Agent':'IMON-Meets-reproducible-evaluation/1','Accept-Encoding':'identity'})
    digest = hashlib.sha256()
    count = 0
    last_progress = 0
    try:
        with urllib.request.urlopen(request, timeout=30) as response, part.open('wb') as output:
            final = urllib.parse.urlsplit(response.url)
            if final.scheme != 'https' or final.hostname != 'object.pouta.csc.fi': raise ValueError('Unexpected redirect')
            expected = int(response.headers.get('Content-Length', '0'))
            if expected > CAP: raise ValueError('Archive exceeds cap')
            response_metadata = {key:response.headers.get(key) for key in ('Content-Length','ETag','Last-Modified','Content-Type')}
            while True:
                data = response.read(1024 * 1024)
                if not data: break
                count += len(data)
                if count > CAP or time.monotonic()-started > 600: raise ValueError('Download budget exceeded')
                output.write(data); digest.update(data)
                if count-last_progress >= 64*1024*1024:
                    print('DOWNLOAD_PROGRESS', args.direction, count, flush=True); last_progress=count
            output.flush(); os.fsync(output.fileno())
        if expected and count != expected: raise ValueError('Truncated archive')
        with zipfile.ZipFile(part) as zipped:
            infos = zipped.infolist()
            if len(infos) > 256: raise ValueError('Too many archive members')
            members = [{'name':i.filename,'bytes':i.file_size,'compressed_bytes':i.compress_size} for i in infos]
        record = {**source,'retrieved_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'archive_sha256':digest.hexdigest(),'archive_bytes':count,'download_seconds':round(time.monotonic()-started,3),'response_metadata':response_metadata,'archive_members':members}
        atomic_json(record_path, record)
        os.replace(part, archive)
        print('DOWNLOADED', args.direction, json.dumps(record,ensure_ascii=False), flush=True)
    except BaseException:
        part.unlink(missing_ok=True)
        raise

if __name__ == '__main__': main()
