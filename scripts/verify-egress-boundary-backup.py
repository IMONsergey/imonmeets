#!/usr/bin/env python3
"""Restore actual synthetic Egress outputs through the production backup module."""
import datetime as dt
import hashlib
import importlib.util
import json
import pathlib
import subprocess
import sys
import uuid

root = pathlib.Path(__file__).resolve().parent.parent
folder = pathlib.Path(sys.argv[1]).resolve()
state = pathlib.Path('/home/sergey/.local/state/imonmeets-commercial-20261103/recording-boundary-20261103')
if folder.parent != state or not folder.name.startswith('run-'):
    raise ValueError('Only owned isolated evidence directories are accepted')
spec = importlib.util.spec_from_file_location('recording_backup', root / 'scripts/recording-backup.py')
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)
assert backup.MAX_OBJECT_BYTES == 512 * 1024 * 1024
assert backup.MAX_CACHE_BYTES == 1024 * 1024 * 1024
receipt = json.loads((folder / 'receipt.json').read_text())
key = folder / 'synthetic-backup-key.pem'
cert = folder / 'synthetic-backup-recipient.pem'
subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(key), '-out', str(cert), '-days', '1', '-subj', '/CN=Synthetic Egress Boundary'], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=30, check=True)
key.chmod(0o600)
result = {'scope': 'Actual short Egress MP4 bytes encrypted and restored locally; no offsite receiver or full production-size claim', 'sourceHash': hashlib.sha256((root / 'scripts/recording-backup.py').read_bytes()).hexdigest(), 'hardObjectLimitBytes': backup.MAX_OBJECT_BYTES, 'cacheLimitBytes': backup.MAX_CACHE_BYTES, 'runs': []}
try:
    for phase in receipt['runs']:
        source = folder / (phase['phase'] + '.mp4')
        assert source.is_file() and not source.is_symlink()
        rid, wid = str(uuid.uuid4()), str(uuid.uuid4())
        item = {'id': rid, 'objectKey': 'recordings/' + wid + '/' + rid + '.mp4', 'bytes': source.stat().st_size, 'expiresAt': (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=1)).isoformat()}
        class LocalSource:
            def entries(self):
                return [item]
            def open(self, entry):
                assert entry == item
                return subprocess.Popen(['cat', str(source)], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        project = folder / ('backup-' + phase['phase'])
        project.mkdir(mode=0o700, exist_ok=True)
        outcome = backup.snapshot(project, cert, source=LocalSource())
        assert outcome['ok'] is True and outcome['recordings'] == 1
        directory = project / 'backups/recordings'
        manifest = backup.validate_manifest(backup.read_json(directory / 'manifest.json'))
        assert manifest['complete'] is True
        entry = manifest['objects'][0]
        restored = folder / (phase['phase'] + '-restored.mp4')
        subprocess.run(['openssl', 'cms', '-decrypt', '-binary', '-inform', 'DER', '-in', str(directory / entry['cipherFile']), '-recip', str(cert), '-inkey', str(key), '-out', str(restored)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=30, check=True)
        digest = hashlib.sha256(restored.read_bytes()).hexdigest()
        assert digest == phase['sha256'] == entry['sha256']
        assert restored.stat().st_size == phase['finalBytes'] == entry['bytes']
        row = {'phase': phase['phase'], 'sha256': digest, 'bytes': entry['bytes'], 'cipherBytes': entry['cipherBytes'], 'completeManifest': True, 'restoredByteIdentical': True}
        if phase['phase'] == 'size':
            original = backup.MAX_OBJECT_BYTES
            try:
                backup.MAX_OBJECT_BYTES = phase['stopThresholdBytes']
                try:
                    backup.validate_entries([item], encrypted=False)
                except ValueError as error:
                    assert str(error) == 'Invalid recording size'
                    row['scaledEqualStopAndBackupCeilingAccepts'] = False
                    row['scaledRejection'] = str(error)
                else:
                    raise AssertionError('A hard backup ceiling equal to the soft stop threshold incorrectly accepted the oversized real output')
            finally:
                backup.MAX_OBJECT_BYTES = original
        oversized = {**item, 'bytes': backup.MAX_OBJECT_BYTES + 1}
        try:
            backup.validate_entries([oversized], encrypted=False)
        except ValueError as error:
            assert str(error) == 'Invalid recording size'
            row['productionHardCeilingMetadataRejectsPlusOne'] = True
        else:
            raise AssertionError('Production backup hard ceiling no longer enforces its bound')
        result['runs'].append(row)
finally:
    key.unlink(missing_ok=True)
    cert.unlink(missing_ok=True)
(folder / 'backup-receipt.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
