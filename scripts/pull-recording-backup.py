#!/usr/bin/env python3
"""Private incremental mirror of encrypted recordings; plaintext stays in a pipe."""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
import pathlib
import subprocess
import tempfile
import threading


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, pathlib.Path(__file__).with_name(filename))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


backup = module("recording_backup_common", "recording-backup.py")


def verify_private(root, ciphertext, item, destination=None):
    for name in ("recipient.key", "recipient.pem"):
        path = root / name
        if path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077:
            raise ValueError("Private recipient files must have mode 0600")
    digest, size = backup.file_digest(ciphertext)
    if digest != item["cipherSha256"] or size != item["cipherBytes"]:
        raise ValueError("Encrypted recording checksum mismatch")
    decoder = subprocess.Popen(["openssl", "cms", "-decrypt", "-binary", "-inform", "DER", "-in", str(ciphertext),
                                "-inkey", str(root / "recipient.key"), "-recip", str(root / "recipient.pem")],
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    timer = threading.Timer(240, decoder.kill)
    timer.daemon = True
    timer.start()
    temporary = output = None
    try:
        if destination is not None:
            if destination.exists() or destination.is_symlink():
                raise ValueError("Restore destination already exists")
            # Only an explicit restore creates plaintext, in a private temporary file.
            fd, name = tempfile.mkstemp(prefix=".recording-restore-", dir=destination.parent)
            temporary = pathlib.Path(name)
            output = os.fdopen(fd, "wb")
        digest = hashlib.sha256()
        size = 0
        for block in iter(lambda: decoder.stdout.read(128 * 1024), b""):
            size += len(block)
            if size > item["bytes"]:
                raise ValueError("Decrypted recording exceeds declared size")
            digest.update(block)
            if output is not None:
                output.write(block)
        if decoder.wait(timeout=15) or size != item["bytes"] or digest.hexdigest() != item["sha256"]:
            raise ValueError("Decrypted recording checksum mismatch")
        if output is not None:
            output.flush()
            os.fsync(output.fileno())
            output.close()
            output = None
            # Atomic no-replace commit, refusing a concurrent substituted target.
            os.link(temporary, destination)
            temporary.unlink()
            temporary = None
    finally:
        timer.cancel()
        if output:
            output.close()
        if temporary:
            temporary.unlink(missing_ok=True)
        if decoder.poll() is None:
            decoder.kill()
        decoder.wait(timeout=15)
        decoder.stdout.close()


def catalog(root, cfg, fetch):
    raw = fetch(root, cfg, "/_ops/recordings", max_bytes=backup.MAX_MANIFEST_BYTES)
    if len(raw) > backup.MAX_MANIFEST_BYTES:
        raise ValueError("Recording manifest too large")
    value = backup.validate_manifest(json.loads(raw))
    fingerprint = hashlib.sha256((root / "recipient.pem").read_bytes()).hexdigest()
    if value["recipientSha256"] != fingerprint:
        raise ValueError("Recording backup recipient mismatch")
    # A source snapshot can remain fresh while an individual object's expiry passes.
    value["objects"] = [obj for obj in value["objects"] if backup.timestamp(obj["expiresAt"]) > backup.utcnow()]
    return value


def sync(root, cfg, fetch):
    directory = root / "recordings"
    backup.private_dir(directory)
    with (directory / ".lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return _sync(root, cfg, fetch)


def housekeeping(root):
    """Run even when database backup or the network is unavailable."""
    directory = root / "recordings"
    backup.private_dir(directory)
    with (directory / ".lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        backup.purge_expired(directory)


def _sync(root, cfg, fetch):
    directory = root / "recordings"
    backup.private_dir(directory)
    backup.purge_expired(directory)
    manifest = catalog(root, cfg, fetch)
    allowed = {obj["cipherFile"] for obj in manifest["objects"]}
    backup.prune(directory, allowed)
    # Record withdrawals before transfers. A failed new download cannot revive
    # deleted objects through a formerly successful local manifest.
    pending = {**manifest, "complete": False,
               "objects": [obj for obj in manifest["objects"]
                           if (directory / obj["cipherFile"]).is_file()
                           and not (directory / obj["cipherFile"]).is_symlink()]}
    backup.atomic_json(directory / "manifest.json", pending)
    result = []
    for item in manifest["objects"]:
        destination = directory / item["cipherFile"]
        valid = False
        if destination.exists() and not destination.is_symlink():
            valid = backup.file_digest(destination) == (item["cipherSha256"], item["cipherBytes"])
        if not valid:
            destination.unlink(missing_ok=True)
            fd, name = tempfile.mkstemp(prefix=".incoming-", dir=directory)
            temporary = pathlib.Path(name)
            try:
                with os.fdopen(fd, "wb") as output:
                    fetch(root, cfg, "/_ops/recordings/" + item["cipherFile"], output, max_bytes=item["cipherBytes"])
                    output.flush()
                    os.fsync(output.fileno())
                if temporary.stat().st_size != item["cipherBytes"]:
                    raise ValueError("Encrypted recording length mismatch")
                verify_private(root, temporary, item)
                temporary.replace(destination)
            finally:
                temporary.unlink(missing_ok=True)
        else:
            # A verified cipher hash identifies exactly the previously verified bytes.
            # First adoption of an already existing local file still requires decryption.
            verify_private(root, destination, item)
        result.append(item)
    # Recheck current source authorization after downloads, as recordings may be
    # deleted while a larger object is being transferred.
    current = catalog(root, cfg, fetch)
    current_by_file = {item["cipherFile"]: item for item in current["objects"]}
    result = [item for item in result if current_by_file.get(item["cipherFile"]) == item]
    backup.prune(directory, {obj["cipherFile"] for obj in result})
    complete = (manifest.get("complete") is True and current.get("complete") is True
                and len(result) == len(current["objects"]))
    backup.atomic_json(directory / "manifest.json", {**current, "complete": complete, "objects": result})
    if not complete:
        raise ValueError("Recording snapshot is still being updated")
    return {"ok": True, "recordings": len(result), "encryptedBytes": sum(obj["cipherBytes"] for obj in result),
            "snapshotAt": current["generatedAt"]}


def restore(root, recording_id, destination):
    directory = root / "recordings"
    with (directory / ".lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return _restore(root, recording_id, destination)


def _restore(root, recording_id, destination):
    directory = root / "recordings"
    backup.purge_expired(directory)
    # Disaster recovery must work when the original server has been unavailable
    # for longer than the sync freshness window. Original object expiry still applies.
    manifest = backup.validate_manifest(backup.read_json(directory / "manifest.json"), fresh=False)
    # A later new-object transfer can fail while a previously verified object
    # remains recoverable. Its own checksums/expiry, not the global job state,
    # determine whether this explicit private-file recovery is safe.
    item = next((obj for obj in manifest["objects"] if obj["id"] == recording_id
                 and backup.timestamp(obj["expiresAt"]) > backup.utcnow()), None)
    if item is None:
        raise ValueError("Recording is not eligible for recovery")
    verify_private(root, directory / item["cipherFile"], item, destination)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=pathlib.Path, required=True)
    parser.add_argument("--restore-id")
    parser.add_argument("--output", type=pathlib.Path)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if args.restore_id:
            if not args.output:
                parser.error("--output is required for a restore")
            restore(args.root, args.restore_id, args.output)
            result = {"ok": True, "restored": True}
        else:
            pull_name = "pull.py" if pathlib.Path(__file__).with_name("pull.py").exists() else "pull-encrypted-backup.py"
            pull = module("recording_https_transport", pull_name)
            cfg = backup.read_json(args.root / "connection.json")
            result = sync(args.root, cfg, pull.https_fetch)
        print(json.dumps(result))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error": type(error).__name__}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
