#!/usr/bin/env python3
"""Incremental, bounded encrypted recording snapshots. No plaintext files."""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import tempfile
import threading
import time

MAX_CACHE_BYTES = 1024 * 1024 * 1024
MAX_OBJECT_BYTES = 350 * 1024 * 1024
MAX_OBJECTS = 2048
MAX_MANIFEST_BYTES = 2 * 1024 * 1024
MAX_AGE_SECONDS = 600
UUID = r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}"
HASH = r"[0-9a-f]{64}"


def cipher_limit(size):
    # Streaming CMS uses BER chunk wrappers in addition to the encrypted payload.
    return size + size // 100 + 65536


def utcnow():
    return dt.datetime.now(dt.timezone.utc)


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError("Timestamp must be a string")
    result = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.utcoffset() is None:
        raise ValueError("Timezone required")
    return result


def private_dir(path):
    if path.is_symlink():
        raise ValueError("Symlink directory refused")
    path.mkdir(parents=True, mode=0o700, exist_ok=True)
    path.chmod(0o700)


def read_json(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            raise ValueError("Regular file required")
        data = source.read(MAX_MANIFEST_BYTES + 1)
        if len(data) > MAX_MANIFEST_BYTES:
            raise ValueError("Manifest too large")
        return json.loads(data)


def atomic_json(path, value):
    encoded = (json.dumps(value, separators=(",", ":")) + "\n").encode()
    if len(encoded) > MAX_MANIFEST_BYTES:
        raise ValueError("Manifest too large")
    with tempfile.NamedTemporaryFile(prefix=".manifest-", dir=path.parent, delete=False) as out:
        temporary = pathlib.Path(out.name)
        try:
            out.write(encoded)
            out.flush()
            os.fsync(out.fileno())
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


def validate_entries(entries, now=None, encrypted=True):
    now = now or utcnow()
    if not isinstance(entries, list) or len(entries) > MAX_OBJECTS:
        raise ValueError("Too many recordings")
    ids = set()
    total = 0
    for item in entries:
        if not isinstance(item, dict):
            raise ValueError("Recording metadata must be an object")
        rid = item.get("id", "")
        if not isinstance(rid, str) or not re.fullmatch(UUID, rid) or rid in ids:
            raise ValueError("Invalid recording id")
        ids.add(rid)
        if (not isinstance(item.get("objectKey"), str)
                or not re.fullmatch(r"recordings/" + UUID + "/" + rid + r"\.mp4", item["objectKey"])):
            raise ValueError("Invalid recording key")
        size = item.get("bytes")
        if type(size) is not int or not 1 <= size <= MAX_OBJECT_BYTES:
            raise ValueError("Invalid recording size")
        timestamp(item.get("expiresAt"))
        if encrypted:
            for field in ("sha256", "cipherSha256"):
                if not isinstance(item.get(field), str) or not re.fullmatch(HASH, item[field]):
                    raise ValueError("Invalid checksum")
            if item.get("cipherFile") != item["cipherSha256"] + ".enc":
                raise ValueError("Invalid encrypted filename")
            cipher_size = item.get("cipherBytes")
            if type(cipher_size) is not int or not size < cipher_size <= cipher_limit(size):
                raise ValueError("Invalid encrypted size")
            total += cipher_size
        else:
            total += cipher_limit(size)
    if total > MAX_CACHE_BYTES:
        raise ValueError("Recording backup capacity exceeded")
    return entries


def validate_manifest(value, now=None, fresh=True):
    now = now or utcnow()
    if not isinstance(value, dict) or value.get("version") != 1 or type(value.get("complete")) is not bool:
        raise ValueError("Unsupported recording manifest")
    age = (now - timestamp(value.get("generatedAt"))).total_seconds()
    if age < -300 or (fresh and age > MAX_AGE_SECONDS):
        raise ValueError("Recording manifest is stale")
    if (not isinstance(value.get("recipientSha256"), str)
            or not re.fullmatch(HASH, value["recipientSha256"])):
        raise ValueError("Missing recipient fingerprint")
    validate_entries(value.get("objects"), now)
    return value


def file_digest(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    digest = hashlib.sha256()
    size = 0
    with os.fdopen(fd, "rb") as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            raise ValueError("Regular file required")
        for block in iter(lambda: source.read(128 * 1024), b""):
            size += len(block)
            if size > cipher_limit(MAX_OBJECT_BYTES):
                raise ValueError("Encrypted object too large")
            digest.update(block)
    return digest.hexdigest(), size


def prune(directory, allowed):
    """Only this dedicated cache's ciphertext and interrupted writes are removed."""
    for path in directory.iterdir():
        if (re.fullmatch(HASH + r"\.enc", path.name) and path.name not in allowed) or path.name.startswith(".incoming-"):
            if path.is_dir() and not path.is_symlink():
                raise ValueError("Unexpected cache directory")
            path.unlink()


def purge_expired(directory, now=None):
    now = now or utcnow()
    try:
        manifest = validate_manifest(read_json(directory / "manifest.json"), now, fresh=False)
    except FileNotFoundError:
        prune(directory, set())
        return
    allowed = {obj["cipherFile"] for obj in manifest["objects"] if timestamp(obj["expiresAt"]) > now}
    prune(directory, allowed)


QUERY_JS = r"""
import pg from 'pg';
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,statement_timeout:10000,connectionTimeoutMillis:10000});
try {
 const days=Number(process.env.RECORDING_RETENTION_DAYS||14);
 if(!Number.isInteger(days)||days<1||days>365)throw Error();
 const result=await pool.query(`SELECT id,object_key AS "objectKey",size_bytes::text AS bytes,
 COALESCE(expires_at,COALESCE(ended_at,started_at)+($1*interval '1 day')) AS "expiresAt"
 FROM im_recordings WHERE status='complete' AND deletion_requested_at IS NULL AND deleted_at IS NULL
 AND COALESCE(expires_at,COALESCE(ended_at,started_at)+($1*interval '1 day'))>now()
 ORDER BY id LIMIT 2049`,[days]);
 process.stdout.write(JSON.stringify(result.rows.map(r=>({...r,bytes:Number(r.bytes)}))));
}catch{process.exitCode=1;}finally{await pool.end();}
"""
OBJECT_JS = r"""
import {S3Client,GetObjectCommand} from '@aws-sdk/client-s3';
const item=JSON.parse(process.argv[1]);
try {
 const s3=new S3Client({region:process.env.S3_REGION||'us-east-1',endpoint:process.env.S3_ENDPOINT,
 forcePathStyle:process.env.S3_FORCE_PATH_STYLE==='true',credentials:{accessKeyId:process.env.S3_ACCESS_KEY_ID,secretAccessKey:process.env.S3_SECRET_ACCESS_KEY}});
 const object=await s3.send(new GetObjectCommand({Bucket:process.env.S3_BUCKET,Key:item.objectKey}),{abortSignal:AbortSignal.timeout(180000)});
 if(object.ContentLength!==item.bytes)throw Error();
 let size=0;for await(const chunk of object.Body){size+=chunk.length;if(size>item.bytes)throw Error();
 if(!process.stdout.write(chunk))await new Promise(resolve=>process.stdout.once('drain',resolve));}
 if(size!==item.bytes)throw Error();s3.destroy();
}catch{process.exitCode=1;}
"""


class DockerSource:
    def __init__(self, project):
        self.project = project

    def command(self, code):
        return ["docker", "compose", "exec", "-T", "app", "node", "--input-type=module", "-e", code]

    def entries(self):
        result = subprocess.run(self.command(QUERY_JS), cwd=self.project, capture_output=True, check=True, timeout=30)
        if len(result.stdout) > MAX_MANIFEST_BYTES:
            raise ValueError("Source catalog too large")
        return validate_entries(json.loads(result.stdout), encrypted=False)

    def open(self, item):
        return subprocess.Popen(self.command(OBJECT_JS) + [json.dumps(item)], cwd=self.project,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)


def encrypt_object(source, item, directory, recipient):
    if shutil.disk_usage(directory).free < item["bytes"] + 64 * 1024 * 1024:
        raise ValueError("Insufficient backup disk space")
    fd, name = tempfile.mkstemp(prefix=".incoming-", dir=directory)
    os.close(fd)
    temporary = pathlib.Path(name)
    reader = encoder = None
    timers = []
    try:
        reader = source.open(item)
        encoder = subprocess.Popen(["openssl", "cms", "-encrypt", "-binary", "-aes-256-cbc", "-stream",
                                    "-outform", "DER", "-out", str(temporary), str(recipient)],
                                   stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for process in (reader, encoder):
            timer = threading.Timer(240, process.kill)
            timer.daemon = True
            timer.start()
            timers.append(timer)
        digest = hashlib.sha256()
        size = 0
        for block in iter(lambda: reader.stdout.read(128 * 1024), b""):
            size += len(block)
            if size > item["bytes"]:
                raise ValueError("Source exceeds declared size")
            digest.update(block)
            encoder.stdin.write(block)
        encoder.stdin.close()
        if reader.wait(timeout=10) or encoder.wait(timeout=30) or size != item["bytes"]:
            raise ValueError("Recording encryption failed")
        cipher_hash, cipher_size = file_digest(temporary)
        result = {**item, "sha256": digest.hexdigest(), "cipherSha256": cipher_hash,
                  "cipherBytes": cipher_size, "cipherFile": cipher_hash + ".enc"}
        validate_entries([result])
        with temporary.open("rb") as handle:
            os.fsync(handle.fileno())
        temporary.replace(directory / result["cipherFile"])
        return result
    finally:
        for timer in timers:
            timer.cancel()
        for process in (reader, encoder):
            if process is not None:
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=10)
                for handle in (process.stdin, process.stdout):
                    if handle and not handle.closed:
                        handle.close()
        temporary.unlink(missing_ok=True)


def same_source(a, b):
    return all(a.get(key) == b.get(key) for key in ("id", "objectKey", "bytes", "expiresAt"))


def snapshot(project, recipient, source=None):
    directory = project / "backups/recordings"
    private_dir(directory)
    with (directory / ".lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        purge_expired(directory)
        if recipient.is_symlink() or not recipient.is_file():
            raise ValueError("Recipient certificate required")
        fingerprint = hashlib.sha256(recipient.read_bytes()).hexdigest()
        source = source or DockerSource(project)
        live = validate_entries(source.entries(), encrypted=False)
        old = {}
        try:
            previous = validate_manifest(read_json(directory / "manifest.json"), fresh=False)
            if previous["recipientSha256"] == fingerprint:
                old = {obj["id"]: obj for obj in previous["objects"]}
        except FileNotFoundError:
            pass
        reusable = {item["id"]: old[item["id"]] for item in live
                    if item["id"] in old and same_source(item, old[item["id"]])}
        # Removed recordings disappear even if a subsequent new-object download fails.
        prune(directory, {obj["cipherFile"] for obj in reusable.values()})
        atomic_json(directory / "manifest.json", {"version": 1, "generatedAt": utcnow().isoformat(),
                    "recipientSha256": fingerprint, "complete": False, "objects": list(reusable.values())})
        result = []
        for item in live:
            cached = reusable.get(item["id"])
            if cached:
                try:
                    digest, size = file_digest(directory / cached["cipherFile"])
                    if digest != cached["cipherSha256"] or size != cached["cipherBytes"]:
                        raise ValueError("Cached recording is damaged")
                except (OSError, ValueError):
                    (directory / cached["cipherFile"]).unlink(missing_ok=True)
                    cached = None
            result.append(cached or encrypt_object(source, item, directory, recipient))
        # Deletion/expiry during a long S3 transfer must not publish a stale object.
        current = {obj["id"]: obj for obj in validate_entries(source.entries(), encrypted=False)}
        result = [obj for obj in result if obj["id"] in current and same_source(obj, current[obj["id"]])
                  and timestamp(obj["expiresAt"]) > utcnow()]
        validate_entries(result)
        prune(directory, {obj["cipherFile"] for obj in result})
        manifest = {"version": 1, "generatedAt": utcnow().isoformat(),
                    "recipientSha256": fingerprint, "complete": len(result) == len(current), "objects": result}
        atomic_json(directory / "manifest.json", manifest)
        return {"ok": manifest["complete"], "recordings": len(result),
                "encryptedBytes": sum(obj["cipherBytes"] for obj in result)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parent.parent)
    parser.add_argument("--recipient", type=pathlib.Path, default=pathlib.Path("/etc/imonmeets/backup-recipient.pem"))
    args = parser.parse_args()
    os.umask(0o077)
    try:
        result = snapshot(args.project.resolve(), args.recipient)
        print(json.dumps(result))
        return 0 if result["ok"] else 1
    except BlockingIOError:
        return 0
    except Exception as error:
        # Never print subprocess arguments, credentials, object URLs or database rows.
        print(json.dumps({"ok": False, "error": type(error).__name__}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
