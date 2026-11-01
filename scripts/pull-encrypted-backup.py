#!/usr/bin/env python3
"""Fetch an encrypted backup and validate its private, temporary plaintext bundle."""

import datetime
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import tarfile
import tempfile
import time


class StaleBackupError(ValueError):
    pass


class FutureBackupError(ValueError):
    pass


def verify_bundle(bundle, now=None):
    """Read only archive members; never extract paths or execute dump contents."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    with tarfile.open(bundle, "r:gz") as archive:
        member = archive.getmember("backups/latest.json")
        if not member.isfile() or member.size > 65536:
            raise ValueError("Invalid backup manifest member")
        manifest = json.loads(archive.extractfile(member).read())
        name = manifest["file"]
        if not isinstance(name, str) or not re.fullmatch(r"imonmeets-\d{8}T\d{6}Z\.dump", name):
            raise ValueError("Invalid backup name")
        created = datetime.datetime.fromisoformat(manifest["createdAt"].replace("Z", "+00:00"))
        if created.tzinfo is None or created.utcoffset() is None:
            raise ValueError("Backup timestamp must include a timezone")
        age = (now - created).total_seconds()
        if age > 7200:
            raise StaleBackupError("Backup is older than two hours")
        if age < -300:
            raise FutureBackupError("Backup timestamp is more than five minutes in the future")
        dump_member = archive.getmember("backups/" + name)
        if not dump_member.isfile():
            raise ValueError("Database dump is not a regular archive member")
        digest = hashlib.sha256()
        size = 0
        with archive.extractfile(dump_member) as dump:
            for block in iter(lambda: dump.read(1024 * 1024), b""):
                digest.update(block)
                size += len(block)
        if size <= 0 or digest.hexdigest() != manifest["sha256"] or size != manifest["bytes"]:
            raise ValueError("Database checksum or size mismatch")
        env_member = archive.getmember(".env")
        if not env_member.isfile() or env_member.size == 0:
            raise ValueError("Missing recovery configuration")
    return manifest, size


def main():
    root = pathlib.Path(__file__).resolve().parent
    store = root / "copies"
    store.mkdir(exist_ok=True, mode=0o700)
    state = root / "status.json"
    temporary = decrypted = None
    try:
        cfg = json.loads((root / "connection.json").read_text())
        with tempfile.NamedTemporaryFile(prefix=".incoming-", dir=store, delete=False) as incoming:
            temporary = pathlib.Path(incoming.name)
            subprocess.run(
                ["ssh", "-T", "-i", str(root / "id_ed25519"), "-o", "IdentitiesOnly=yes",
                 "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "StrictHostKeyChecking=yes",
                 "-o", "UserKnownHostsFile=" + str(root / "known_hosts"), cfg["destination"], "backup"],
                stdout=incoming, stderr=subprocess.PIPE, check=True, timeout=300,
            )
        if temporary.stat().st_size < 100:
            raise ValueError("Encrypted backup is empty")
        # NamedTemporaryFile creates mode 0600. Keep a bounded subprocess rather
        # than a pipe whose tar reader could wait indefinitely for a child.
        with tempfile.NamedTemporaryFile(prefix=".verify-", dir=root, delete=False) as plaintext:
            decrypted = pathlib.Path(plaintext.name)
        subprocess.run(
            ["openssl", "cms", "-decrypt", "-binary", "-inform", "DER", "-in", str(temporary),
             "-inkey", str(root / "recipient.key"), "-recip", str(root / "recipient.pem"),
             "-out", str(decrypted)],
            check=True, capture_output=True, timeout=300,
        )
        manifest, size = verify_bundle(decrypted)
        destination = store / (manifest["file"] + ".enc")
        temporary.replace(destination)
        destination.chmod(0o600)
        temporary = None
        result = {
            "ok": True,
            "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "backupCreatedAt": manifest["createdAt"],
            "file": destination.name,
            "databaseBytes": size,
            "verifiedSha256": manifest["sha256"],
        }
        for saved in store.glob("imonmeets-*.dump.enc"):
            if saved.is_file() and not saved.is_symlink() and saved.stat().st_mtime < time.time() - 30 * 86400:
                saved.unlink()
        state.write_text(json.dumps(result, indent=2) + "\n")
        state.chmod(0o600)
        print(json.dumps(result))
        return 0
    except Exception as error:
        previous = {}
        try:
            previous = json.loads(state.read_text())
        except Exception:
            pass
        result = {
            "ok": False,
            "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "error": type(error).__name__,
            "lastSuccessfulBackup": previous.get("file") or previous.get("lastSuccessfulBackup"),
        }
        state.write_text(json.dumps(result, indent=2) + "\n")
        state.chmod(0o600)
        print(json.dumps(result))
        return 1
    finally:
        for item in [temporary, decrypted]:
            if item is not None:
                item.unlink(missing_ok=True)


if __name__ == "__main__":
    sys.exit(main())
