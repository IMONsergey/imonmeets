#!/usr/bin/env python3
"""Real CMS encryption/decryption, incremental mirroring and deletion regressions."""
import contextlib
import copy
import datetime
import importlib.util
import io
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, pathlib.Path(__file__).with_name(filename))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


backup = module("recording_backup", "recording-backup.py")
pull = module("recording_backup_pull", "pull-recording-backup.py")
export = module("recording_backup_export", "offsite-export-server.py")
transport = module("recording_backup_transport", "pull-encrypted-backup.py")
TOKEN = "syntheticfixturetoken" * 3
RID = "11111111-1111-4111-8111-111111111111"
RID2 = "22222222-2222-4222-8222-222222222222"
WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"


class Source:
    def __init__(self, fixture, entries):
        self.fixture = fixture
        self.items = entries
        self.downloads = 0
        self.queries = 0
        self.delete_during_transfer = False

    def entries(self):
        self.queries += 1
        if self.delete_during_transfer and self.queries >= 2:
            return []
        return copy.deepcopy(self.items)

    def open(self, item):
        self.downloads += 1
        return subprocess.Popen(["cat", str(self.fixture)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)


class FakeSocket:
    def __init__(self, request):
        self.input = io.BytesIO(request)
        self.output = bytearray()

    def makefile(self, *args, **kwargs):
        return self.input

    def sendall(self, data):
        self.output.extend(data)


class RecordingBackupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.key_dir = tempfile.TemporaryDirectory()
        cls.keys = pathlib.Path(cls.key_dir.name)
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
                        "-subj", "/CN=synthetic-recording-backup-test", "-keyout", str(cls.keys / "recipient.key"),
                        "-out", str(cls.keys / "recipient.pem")], check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        cls.key_dir.cleanup()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.project = self.root / "server"
        self.project.mkdir()
        self.mac = self.root / "mac"
        self.mac.mkdir(mode=0o700)
        for name in ("recipient.pem", "recipient.key"):
            shutil.copyfile(self.keys / name, self.mac / name)
            (self.mac / name).chmod(0o600)
        # No customer content: synthetic binary media-like fixture.
        self.content = b"\x00\x00\x00\x18ftypmp42" + os.urandom(1024 * 1024)
        self.fixture = self.root / "synthetic.mp4"
        self.fixture.write_bytes(self.content)
        self.item = {"id": RID, "objectKey": "recordings/" + WORKSPACE + "/" + RID + ".mp4",
                     "bytes": len(self.content), "expiresAt": (backup.utcnow() + datetime.timedelta(hours=2)).isoformat()}
        self.source = Source(self.fixture, [self.item])
        self.cfg = {"baseUrl": "https://example.invalid:8443", "bearerToken": TOKEN}

    def tearDown(self):
        self.tmp.cleanup()

    @property
    def cache(self):
        return self.project / "backups/recordings"

    def snapshot(self):
        return backup.snapshot(self.project, self.mac / "recipient.pem", self.source)

    def request(self, path, token=TOKEN):
        socket = FakeSocket((f"GET {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\n\r\n").encode())
        export.make_handler(self.project, TOKEN)(socket, ("127.0.0.1", 12345), None)
        headers, body = bytes(socket.output).split(b"\r\n\r\n", 1)
        return int(headers.split(b" ")[1]), body

    def fetch(self, root, cfg, path, output=None, max_bytes=None):
        status, body = self.request(path)
        if status != 200:
            raise ValueError("Synthetic transport failure")
        self.assertLessEqual(len(body), max_bytes)
        if output is not None:
            output.write(body)
        else:
            return body

    def test_real_crypto_mirror_restore_and_incremental_cache(self):
        self.snapshot()
        manifest = backup.read_json(self.cache / "manifest.json")
        item = manifest["objects"][0]
        ciphertext = self.cache / item["cipherFile"]
        self.assertEqual(ciphertext.stat().st_mode & 0o777, 0o600)
        self.assertNotIn(self.content[:100], ciphertext.read_bytes())
        self.assertFalse(any(path.suffix == ".mp4" for path in self.cache.iterdir()))
        self.snapshot()
        self.assertEqual(self.source.downloads, 1)
        result = pull.sync(self.mac, self.cfg, self.fetch)
        self.assertEqual(result["recordings"], 1)
        self.assertFalse(list(self.mac.glob("**/.verify-*")))
        destination = self.root / "restored.mp4"
        pull.restore(self.mac, RID, destination)
        self.assertEqual(destination.read_bytes(), self.content)
        self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(ValueError):
            pull.restore(self.mac, RID, destination)

    def test_delete_source_removes_server_and_offsite_copy(self):
        self.snapshot()
        pull.sync(self.mac, self.cfg, self.fetch)
        old = backup.read_json(self.cache / "manifest.json")["objects"][0]
        self.source.items = []
        self.snapshot()
        self.assertEqual(list(self.cache.glob("*.enc")), [])
        self.assertEqual(self.request("/_ops/recordings/" + old["cipherFile"])[0], 404)
        pull.sync(self.mac, self.cfg, self.fetch)
        self.assertEqual(list((self.mac / "recordings").glob("*.enc")), [])
        with self.assertRaises(ValueError):
            pull.restore(self.mac, RID, self.root / "deleted.mp4")

    def test_disaster_recovery_older_snapshot_without_extending_expiry(self):
        self.snapshot()
        pull.sync(self.mac, self.cfg, self.fetch)
        path = self.mac / "recordings/manifest.json"
        value = backup.read_json(path)
        value["generatedAt"] = (backup.utcnow() - datetime.timedelta(hours=1)).isoformat()
        backup.atomic_json(path, value)
        destination = self.root / "offline-recovery.mp4"
        pull.restore(self.mac, RID, destination)
        self.assertEqual(destination.read_bytes(), self.content)
        value["generatedAt"] = (backup.utcnow() + datetime.timedelta(hours=1)).isoformat()
        backup.atomic_json(path, value)
        with self.assertRaises(ValueError):
            pull.restore(self.mac, RID, self.root / "future.mp4")
        value["generatedAt"] = (backup.utcnow() - datetime.timedelta(hours=1)).isoformat()
        value["objects"][0]["expiresAt"] = (backup.utcnow() - datetime.timedelta(seconds=1)).isoformat()
        backup.atomic_json(path, value)
        with self.assertRaises(ValueError):
            pull.restore(self.mac, RID, self.root / "expired.mp4")
        self.assertFalse(list((self.mac / "recordings").glob("*.enc")))

    def test_invalid_metadata_types_rejected(self):
        for bad in (None, [], "string", {"version": 1}, {"version": 1, "complete": True, "generatedAt": 42}):
            with self.subTest(value=bad), self.assertRaises(ValueError):
                backup.validate_manifest(bad)
        for bad in (None, [None], [{**self.item, "id": None}], [{**self.item, "objectKey": []}],
                    [{**self.item, "expiresAt": None}], [{**self.item, "bytes": True}]):
            with self.subTest(value=bad), self.assertRaises(ValueError):
                backup.validate_entries(bad, encrypted=False)

    def test_deletion_during_server_transfer_never_published(self):
        self.source.delete_during_transfer = True
        self.snapshot()
        self.assertEqual(backup.read_json(self.cache / "manifest.json")["objects"], [])
        self.assertEqual(list(self.cache.glob("*.enc")), [])

    def test_new_recording_during_snapshot_does_not_report_complete(self):
        initial = self.source.entries
        second = {**self.item, "id": RID2, "objectKey": "recordings/" + WORKSPACE + "/" + RID2 + ".mp4"}
        def add_between_queries():
            values = initial()
            return values if self.source.queries == 1 else values + [second]
        with patch.object(self.source, "entries", side_effect=add_between_queries):
            result = self.snapshot()
        self.assertFalse(result["ok"])
        self.assertFalse(backup.read_json(self.cache / "manifest.json")["complete"])

    def test_delete_during_mac_transfer_rechecked_before_commit(self):
        self.snapshot()
        def fetch_then_delete(root, cfg, path, output=None, max_bytes=None):
            result = self.fetch(root, cfg, path, output, max_bytes)
            if output is not None:
                self.source.items = []
                self.snapshot()
            return result
        self.assertEqual(pull.sync(self.mac, self.cfg, fetch_then_delete)["recordings"], 0)
        self.assertEqual(list((self.mac / "recordings").glob("*.enc")), [])

    def test_expiry_removes_offsite_copy_even_when_network_fails(self):
        self.snapshot()
        pull.sync(self.mac, self.cfg, self.fetch)
        manifest_path = self.mac / "recordings/manifest.json"
        manifest = backup.read_json(manifest_path)
        manifest["objects"][0]["expiresAt"] = (backup.utcnow() - datetime.timedelta(seconds=1)).isoformat()
        backup.atomic_json(manifest_path, manifest)
        with self.assertRaises(OSError):
            pull.sync(self.mac, self.cfg, lambda *args, **kwargs: (_ for _ in ()).throw(OSError()))
        self.assertEqual(list((self.mac / "recordings").glob("*.enc")), [])

    def test_scheduled_pull_purges_expiry_before_failed_database_download(self):
        self.snapshot()
        pull.sync(self.mac, self.cfg, self.fetch)
        path = self.mac / "recordings/manifest.json"
        manifest = backup.read_json(path)
        manifest["objects"][0]["expiresAt"] = (backup.utcnow() - datetime.timedelta(seconds=1)).isoformat()
        backup.atomic_json(path, manifest)
        for name in ("pull-recording-backup.py", "recording-backup.py"):
            shutil.copyfile(pathlib.Path(__file__).with_name(name), self.mac / name)
        (self.mac / "connection.json").write_text(json.dumps({**self.cfg, "recordingBackups": True, "notifications": False}))
        def broken_network(*args, **kwargs):
            self.assertEqual(list((self.mac / "recordings").glob("*.enc")), [])
            raise OSError("synthetic unavailable server")
        with patch.object(transport, "__file__", str(self.mac / "pull.py")), \
             patch.object(transport, "https_fetch", side_effect=broken_network), \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(transport.main(), 1)
        self.assertEqual(list((self.mac / "recordings").glob("*.enc")), [])

    def test_expired_stale_or_unknown_export_not_available(self):
        self.snapshot()
        path = self.cache / "manifest.json"
        value = backup.read_json(path)
        item = value["objects"][0]
        value["objects"][0]["expiresAt"] = (backup.utcnow() - datetime.timedelta(seconds=1)).isoformat()
        backup.atomic_json(path, value)
        self.assertEqual(json.loads(self.request("/_ops/recordings")[1])["objects"], [])
        self.assertEqual(self.request("/_ops/recordings/" + item["cipherFile"])[0], 404)
        value["generatedAt"] = (backup.utcnow() - datetime.timedelta(seconds=601)).isoformat()
        backup.atomic_json(path, value)
        self.assertEqual(self.request("/_ops/recordings")[0], 503)

    def test_failed_transfer_preserves_existing_live_copy_and_cleans_partials(self):
        self.snapshot()
        pull.sync(self.mac, self.cfg, self.fetch)
        previous = set((self.mac / "recordings").glob("*.enc"))
        second = {**self.item, "id": RID2, "objectKey": "recordings/" + WORKSPACE + "/" + RID2 + ".mp4"}
        self.source.items.append(second)
        self.snapshot()
        def fail_on_new(root, cfg, path, output=None, max_bytes=None):
            if output is not None:
                output.write(b"truncated encrypted transfer")
                raise OSError("synthetic interrupted transfer")
            return self.fetch(root, cfg, path, output, max_bytes)
        with self.assertRaises(OSError):
            pull.sync(self.mac, self.cfg, fail_on_new)
        self.assertTrue(all(path.exists() for path in previous))
        self.assertFalse(list((self.mac / "recordings").glob(".incoming-*")))
        self.assertFalse(backup.read_json(self.mac / "recordings/manifest.json")["complete"])
        recovery = self.root / "recover-existing-after-failed-new.mp4"
        pull.restore(self.mac, RID, recovery)
        self.assertEqual(recovery.read_bytes(), self.content)

    def test_ciphertext_plaintext_checksum_and_recipient_errors(self):
        self.snapshot()
        item = backup.read_json(self.cache / "manifest.json")["objects"][0]
        path = self.cache / item["cipherFile"]
        with self.assertRaises(ValueError):
            pull.verify_private(self.mac, path, {**item, "sha256": "0" * 64})
        original = path.read_bytes()
        path.write_bytes(original[:-1] + bytes([original[-1] ^ 255]))
        with self.assertRaises(ValueError):
            pull.verify_private(self.mac, path, item)
        path.write_bytes(original)
        (self.mac / "recipient.key").chmod(0o644)
        with self.assertRaises(ValueError):
            pull.verify_private(self.mac, path, item)

    def test_oversized_truncated_source_and_capacity_fail_closed(self):
        self.source.items[0]["bytes"] += 1
        with self.assertRaises(ValueError):
            self.snapshot()
        self.assertFalse(list(self.cache.glob("*.enc")))
        self.assertFalse(list(self.cache.glob(".incoming-*")))
        with self.assertRaises(ValueError):
            backup.validate_entries([{**self.item, "bytes": backup.MAX_OBJECT_BYTES + 1}], encrypted=False)
        with patch.object(backup, "MAX_CACHE_BYTES", 128), self.assertRaises(ValueError):
            backup.validate_entries([self.item], encrypted=False)

    def test_authenticated_allowlist_and_no_request_logging(self):
        self.snapshot()
        with contextlib.redirect_stderr(io.StringIO()) as stderr, contextlib.redirect_stdout(io.StringIO()) as stdout:
            for path in ("/_ops/recordings", "/_ops/recordings/" + "a" * 64 + ".enc"):
                self.assertEqual(self.request(path, token="incorrect")[0], 401)
            for path in ("/_ops/recordings?token=" + TOKEN, "/_ops/recordings/../.env", "/_ops/recordings/recipient.key"):
                self.assertEqual(self.request(path)[0], 404)
        self.assertEqual(stderr.getvalue() + stdout.getvalue(), "")
        with patch.object(transport.subprocess, "run") as run:
            transport.https_fetch(self.mac, self.cfg, "/_ops/recordings")
            args, kwargs = run.call_args
            self.assertNotIn(TOKEN, repr(args))
            config = kwargs["input"].decode()
            url_line = next(line for line in config.splitlines() if line.startswith("url ="))
            self.assertNotIn(TOKEN, url_line)
            self.assertNotIn("location", config)

    def test_symlink_refused_and_wrong_recipient_manifest_refused(self):
        self.snapshot()
        value = backup.read_json(self.cache / "manifest.json")
        item = value["objects"][0]
        path = self.cache / item["cipherFile"]
        path.unlink()
        path.symlink_to(self.fixture)
        self.assertEqual(self.request("/_ops/recordings/" + item["cipherFile"])[0], 503)
        value["recipientSha256"] = "0" * 64
        backup.atomic_json(self.cache / "manifest.json", value)
        with self.assertRaises(ValueError):
            pull.sync(self.mac, self.cfg, self.fetch)


if __name__ == "__main__":
    unittest.main()
