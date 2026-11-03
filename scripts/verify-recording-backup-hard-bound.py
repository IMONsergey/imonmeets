#!/usr/bin/env python3
"""Bounded real crypto/receiver/restore at the hard object bound, no network.

The input is an actual short synthetic Egress MP4. A valid ISO BMFF free atom
extends it to the staging ceiling; this is NOT a 30-minute Egress acceptance.
"""
import datetime as dt
import hashlib
import importlib.util
import json
import pathlib
import shutil
import struct
import subprocess
import sys
import uuid

root = pathlib.Path(__file__).resolve().parent.parent
state = pathlib.Path('/home/sergey/.local/state/imonmeets-commercial-20261103/recording-boundary-20261103')
source = pathlib.Path(sys.argv[1]).resolve()
folder = pathlib.Path(sys.argv[2]).resolve()
assert source.parent.parent == state and source.name == 'size.mp4'
assert folder.parent == state and folder.name.startswith('hard-bound-')
folder.mkdir(mode=0o700, exist_ok=False)
if shutil.disk_usage(folder).free < 4 * 1024 ** 3:
    raise ValueError('Four GiB of scratch headroom required before this bounded acceptance')

def digest(file):
    h = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(128 * 1024), b''): h.update(chunk)
    return h.hexdigest()

def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value

backup = module('backup_bound_current', root / 'scripts/recording-backup.py')
pull = module('backup_bound_receiver', root / 'scripts/pull-recording-backup.py')
baseline = folder / 'baseline-validator.py'
baseline.write_bytes(subprocess.check_output(['git', '-C', str(root), 'show', 'd46de552200c87c16b4d8c604170c47f113cde54:scripts/recording-backup.py']))
old = module('backup_bound_original', baseline)
limit = 512 * 1024 * 1024
assert backup.MAX_OBJECT_BYTES == pull.backup.MAX_OBJECT_BYTES == limit
assert backup.MAX_CACHE_BYTES == pull.backup.MAX_CACHE_BYTES == 1024 ** 3
receipt = {'result': 'RUNNING', 'startedAt': backup.utcnow().isoformat(), 'sourceHead': subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip(), 'sourceHash': digest(source), 'validatorHash': digest(root / 'scripts/recording-backup.py'), 'receiverHash': digest(root / 'scripts/pull-recording-backup.py'), 'baselineValidatorHash': digest(baseline), 'generatorHash': digest(pathlib.Path(__file__)), 'scope': 'Synthetic short Egress MP4 plus a valid free atom, actual 512MiB crypto/cache/receiver/restore; not a full-size Egress capture or offsite network acceptance', 'productionEgressBoundaryAccepted': False}
media = folder / 'synthetic-hard-bound.mp4'
receiver = folder / 'receiver'
receiver.mkdir(mode=0o700)
key = receiver / 'recipient.key'
cert = receiver / 'recipient.pem'
try:
    initial = source.stat().st_size
    remaining = limit - initial
    assert remaining >= 8 and remaining < 2 ** 32
    with source.open('rb') as incoming, media.open('wb') as output:
        shutil.copyfileobj(incoming, output, 128 * 1024)
        output.write(struct.pack('>I4s', remaining, b'free'))
        zeros = bytes(1024 * 1024)
        remaining -= 8
        while remaining:
            n = min(remaining, len(zeros)); output.write(zeros[:n]); remaining -= n
    assert media.stat().st_size == limit
    media_hash = digest(media)
    probe = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', str(media)], timeout=30))
    assert any(x['codec_name'] == 'h264' for x in probe['streams'])
    assert any(x['codec_name'] == 'aac' for x in probe['streams'])
    subprocess.run(['ffmpeg', '-v', 'error', '-xerror', '-threads', '1', '-i', str(media), '-f', 'null', '-'], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=60, check=True)
    receipt.update({'plainBytes': limit, 'plainSha256': media_hash, 'freeAtomBytes': limit - initial, 'durationSeconds': float(probe['format']['duration']), 'completeDecodeAccepted': True})
    rid, wid = str(uuid.uuid4()), str(uuid.uuid4())
    item = {'id': rid, 'objectKey': 'recordings/' + wid + '/' + rid + '.mp4', 'bytes': limit, 'expiresAt': (backup.utcnow() + dt.timedelta(hours=1)).isoformat()}
    try: old.validate_entries([item], encrypted=False)
    except ValueError as error:
        assert str(error) == 'Invalid recording size'
        receipt['baselineRejectsActualValidFile'] = str(error)
    else: raise AssertionError('Original validator should reject the actual file above its soft-stop ceiling')
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=Synthetic Backup Hard Bound', '-keyout', str(key), '-out', str(cert)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=30, check=True)
    key.chmod(0o600); cert.chmod(0o600)
    class Source:
        def entries(self): return [item]
        def open(self, value):
            assert value == item
            return subprocess.Popen(['cat', str(media)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    project = folder / 'server'
    project.mkdir(mode=0o700)
    outcome = backup.snapshot(project, cert, Source())
    assert outcome['ok'] is True
    cache = project / 'backups/recordings'
    manifest = backup.validate_manifest(backup.read_json(cache / 'manifest.json'))
    assert manifest['complete'] is True and len(manifest['objects']) == 1
    entry = manifest['objects'][0]
    assert entry['sha256'] == media_hash and entry['bytes'] == limit
    assert entry['cipherBytes'] <= backup.cipher_limit(limit) < backup.MAX_CACHE_BYTES
    def fetch(_root, _cfg, target, output=None, max_bytes=None):
        if target == '/_ops/recordings':
            data = (cache / 'manifest.json').read_bytes()
            assert len(data) <= max_bytes
            return data
        assert target == '/_ops/recordings/' + entry['cipherFile'] and output is not None
        total = 0
        with (cache / entry['cipherFile']).open('rb') as stream:
            for chunk in iter(lambda: stream.read(128 * 1024), b''):
                total += len(chunk)
                assert total <= max_bytes
                output.write(chunk)
    synced = pull.sync(receiver, {'baseUrl': 'https://synthetic.invalid', 'bearerToken': 'synthetic-boundary-token'}, fetch)
    assert synced['recordings'] == 1
    restored = folder / 'restored-hard-bound.mp4'
    pull.restore(receiver, rid, restored)
    assert restored.stat().st_size == limit and digest(restored) == media_hash
    receipt.update({'serverCompleteManifest': True, 'receiverSynced': True, 'restoredByteIdentical': True, 'cipherBytes': entry['cipherBytes'], 'cipherReserveBytes': backup.cipher_limit(limit), 'cacheLimitBytes': backup.MAX_CACHE_BYTES, 'serverCipherCacheBytes': sum(p.stat().st_size for p in cache.glob('*.enc')), 'receiverCipherCacheBytes': sum(p.stat().st_size for p in (receiver / 'recordings').glob('*.enc')), 'result': 'PASS_REAL_HARD_BOUND_BACKUP_RESTORE'})
except Exception as error:
    receipt['result'] = 'FAIL'; receipt['error'] = type(error).__name__ + ': ' + str(error)
    raise
finally:
    key.unlink(missing_ok=True); cert.unlink(missing_ok=True)
    receipt['finishedAt'] = backup.utcnow().isoformat()
    (folder / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt), flush=True)
