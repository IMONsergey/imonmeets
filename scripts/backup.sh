#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
mkdir -p backups
exec 9>backups/.backup.lock
flock -n 9 || { printf 'Backup already running.\n'; exit 0; }
backup_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_path="backups/imonmeets-${backup_stamp}.dump"
backup_tmp="$(mktemp backups/.incomplete.XXXXXX)"
trap 'rm -f "$backup_tmp"' EXIT
docker compose exec -T db pg_dump -U imonmeets -d imonmeets -Fc > "$backup_tmp"
test -s "$backup_tmp"
docker compose exec -T db pg_restore --list < "$backup_tmp" >/dev/null
mv "$backup_tmp" "$backup_path"
python3 - "$backup_path" <<'PY'
import hashlib,json,os,pathlib,sys,datetime
p=pathlib.Path(sys.argv[1]);digest=hashlib.sha256()
with p.open('rb') as source:
    for block in iter(lambda:source.read(1024*1024),b''):digest.update(block)
data={"createdAt":datetime.datetime.now(datetime.timezone.utc).isoformat(),"file":p.name,"bytes":p.stat().st_size,"sha256":digest.hexdigest()}
tmp=p.parent/".latest.json.tmp"
tmp.write_text(json.dumps(data,indent=2)+"\n");os.chmod(tmp,0o600);tmp.replace(p.parent/"latest.json")
PY
# An operator-installed public certificate enables encrypted off-host copies.
if [ -f /etc/imonmeets/backup-recipient.pem ]; then
  bundle_tmp="$(mktemp backups/.bundle.XXXXXX)"
  encrypted_tmp="$(mktemp backups/.encrypted.XXXXXX)"
  trap 'rm -f "$backup_tmp" "$bundle_tmp" "$encrypted_tmp"' EXIT
  bundle_files=("$backup_path" backups/latest.json .env)
  recording_credentials="deploy/recording-private/credentials.json"
  if [ -e "$recording_credentials" ] || [ -L "$recording_credentials" ]; then
    if [ ! -f "$recording_credentials" ] || [ -L "$recording_credentials" ]; then
      printf 'Recording recovery credentials must be a regular file, not a symlink.\n' >&2
      exit 1
    fi
    bundle_files+=("$recording_credentials")
  fi
  tar -czf "$bundle_tmp" "${bundle_files[@]}"
  openssl cms -encrypt -binary -aes-256-cbc -outform DER \
    -in "$bundle_tmp" -out "$encrypted_tmp" /etc/imonmeets/backup-recipient.pem
  test -s "$encrypted_tmp"
  mv "$encrypted_tmp" "${backup_path}.enc"
  rm -f "$bundle_tmp"
fi
python3 - <<'PY'
import pathlib,time,os
days=int(os.environ.get("BACKUP_RETENTION_DAYS","7"))
if not 2 <= days <= 365: raise SystemExit("BACKUP_RETENTION_DAYS must be between 2 and 365")
cutoff=time.time()-days*86400
for p in pathlib.Path("backups").glob("imonmeets-*.dump*"):
    if p.is_file() and not p.is_symlink() and p.stat().st_mtime < cutoff: p.unlink()
PY
printf 'Verified backup: %s\n' "$backup_path"
