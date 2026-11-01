#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
latest_dump="$(python3 - <<'PY'
import json,pathlib,re,hashlib
p=pathlib.Path('backups')
manifest=json.loads((p/'latest.json').read_text());name=manifest['file']
if not re.fullmatch(r'imonmeets-\d{8}T\d{6}Z\.dump',name): raise SystemExit('Invalid backup manifest')
f=p/name
if not f.is_file() or f.is_symlink(): raise SystemExit('Backup unavailable')
digest=hashlib.sha256()
with f.open('rb') as stream:
    for chunk in iter(lambda:stream.read(1024*1024),b''): digest.update(chunk)
if digest.hexdigest()!=manifest['sha256']: raise SystemExit('Backup checksum mismatch')
print(f)
PY
)"
bash scripts/restore-check.sh "$latest_dump"

