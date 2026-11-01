#!/usr/bin/env python3
"""Fetch an encrypted backup and validate its private, temporary plaintext bundle."""

import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse


class StaleBackupError(ValueError):
    pass


class FutureBackupError(ValueError):
    pass


def atomic_json(path, value):
    temporary = path.with_suffix(".tmp")
    with open(temporary, "w", opener=lambda p, flags: os.open(p, flags, 0o600)) as out:
        json.dump(value, out, indent=2)
        out.write("\n")
    temporary.chmod(0o600)
    temporary.replace(path)


def https_fetch(root, cfg, path, output=None, max_bytes=512 * 1024 * 1024):
    """Use macOS curl's TLS trust, never disable certificate/hostname checks.

    The bearer travels via stdin, not process arguments, URLs, logs or shell.
    Redirects are not followed, preventing credential forwarding to another host.
    """
    base = cfg.get("baseUrl", "")
    url = urllib.parse.urlsplit(base)
    if (url.scheme != "https" or not url.hostname or url.username or url.password
            or url.query or url.fragment or url.path not in {"", "/"}):
        raise ValueError("A plain HTTPS origin is required")
    token = cfg.get("bearerToken", "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{43,128}", token):
        raise ValueError("Invalid export token")
    options = {
        "url": base.rstrip("/") + path,
        "header": "Authorization: Bearer " + token,
        "proto": "=https",
        "connect-timeout": "15",
        "max-time": "240",
        "max-filesize": str(max_bytes),
    }
    if cfg.get("caFile"):
        ca = pathlib.Path(cfg["caFile"])
        if not ca.is_absolute():
            ca = root / ca
        if not ca.is_file() or ca.is_symlink():
            raise ValueError("Missing trusted CA file")
        options["cacert"] = str(ca)
    config = "silent\nshow-error\nfail\ntlsv1.2\n" + "".join(
        key + " = " + json.dumps(value) + "\n" for key, value in options.items())
    result = subprocess.run(
        ["/usr/bin/curl", "--config", "-"], input=config.encode(),
        stdout=output if output is not None else subprocess.PIPE,
        stderr=subprocess.PIPE, check=True, timeout=250,
    )
    return result.stdout


def notify_mac(title, message):
    script = ('on run argv\n'
              'display notification (item 2 of argv) with title (item 1 of argv)\n'
              'end run')
    subprocess.run(["/usr/bin/osascript", "-e", script, title, message],
                   check=True, capture_output=True, timeout=10)


def update_alerts(root, status, enabled=True, now=None):
    """Two consecutive failures, six-hour reminders and a recovery notice."""
    if not enabled:
        return
    now = time.time() if now is None else now
    path = root / "alert-state.json"
    try:
        old = json.loads(path.read_text())
    except Exception:
        old = {}
    failed = not status.get("ok")
    count = old.get("consecutiveFailures", 0) + 1 if failed else 0
    active = old.get("active", False)
    last = old.get("lastNotifiedAt", 0)
    result = {"consecutiveFailures": count, "active": active, "lastNotifiedAt": last,
              "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}
    if failed and count >= 2 and (not active or now - last >= 21600):
        title = "IMON Meets: нужна проверка"
        labels = {"api": "сервис", "mediaSignaling": "подключение к звонкам",
                  "backup": "резервная копия", "disk": "место на сервере",
                  "recordingStorage": "хранилище записей"}
        checks = status.get("serverHealth", {}).get("checks", {})
        problems = [labels[key] for key, value in checks.items()
                    if key in labels and value.get("ok") is not True]
        message = "Проверьте " + ", ".join(problems) if problems else "Нет подтверждения доступности сервиса или свежей копии."
    elif not failed and active:
        title = "IMON Meets: работа восстановлена"
        message = "Сервис доступен. Свежая зашифрованная копия проверена на этом Mac."
    else:
        atomic_json(path, result)
        return
    try:
        notify_mac(title, message)
        result.update(active=failed, lastNotifiedAt=now)
    except Exception as error:
        result["notificationError"] = type(error).__name__
    atomic_json(path, result)


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
    # A launch timer and a manual run must not decrypt or replace the same copy.
    lock = (root / ".pull.lock").open("w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close()
        return 0
    temporary = decrypted = None
    cfg = {"notifications": sys.platform == "darwin"}
    try:
        cfg = json.loads((root / "connection.json").read_text())
        with tempfile.NamedTemporaryFile(prefix=".incoming-", dir=store, delete=False) as incoming:
            temporary = pathlib.Path(incoming.name)
            if cfg.get("baseUrl"):
                https_fetch(root, cfg, "/_ops/backup", incoming)
            else:
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
            "backupOk": True,
            "automatic": os.environ.get("IMON_AUTOMATED") == "1",
            "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "backupCreatedAt": manifest["createdAt"],
            "file": destination.name,
            "databaseBytes": size,
            "verifiedSha256": manifest["sha256"],
            "transport": "https" if cfg.get("baseUrl") else "ssh",
        }
        if cfg.get("baseUrl"):
            try:
                health = json.loads(https_fetch(root, cfg, "/_ops/health", max_bytes=65536))
                checked = datetime.datetime.fromisoformat(health["checkedAt"].replace("Z", "+00:00"))
                age = (datetime.datetime.now(datetime.timezone.utc) - checked).total_seconds()
                result["serverHealth"] = health
                result["ok"] = health.get("ok") is True and 0 <= age <= 600
            except Exception as error:
                result["serverHealth"] = {"ok": False, "error": type(error).__name__}
                result["ok"] = False
        for saved in store.glob("imonmeets-*.dump.enc"):
            if saved.is_file() and not saved.is_symlink() and saved.stat().st_mtime < time.time() - 30 * 86400:
                saved.unlink()
        atomic_json(state, result)
        update_alerts(root, result, cfg.get("notifications", False))
        print(json.dumps(result))
        return 0 if result["ok"] else 1
    except Exception as error:
        previous = {}
        try:
            previous = json.loads(state.read_text())
        except Exception:
            pass
        result = {
            "ok": False,
            "automatic": os.environ.get("IMON_AUTOMATED") == "1",
            "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "error": type(error).__name__,
            "lastSuccessfulBackup": previous.get("file") or previous.get("lastSuccessfulBackup"),
        }
        atomic_json(state, result)
        update_alerts(root, result, cfg.get("notifications", False))
        print(json.dumps(result))
        return 1
    finally:
        for item in [temporary, decrypted]:
            if item is not None:
                item.unlink(missing_ok=True)
        lock.close()


if __name__ == "__main__":
    sys.exit(main())
