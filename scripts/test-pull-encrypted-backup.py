#!/usr/bin/env python3
"""Offline archive validation tests. No SSH, OpenSSL, real keys or customer data."""
import datetime
import hashlib
import importlib.util
import io
import json
import pathlib
import tarfile
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("backup_pull", pathlib.Path(__file__).with_name("pull-encrypted-backup.py"))
pull = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pull)
NOW = datetime.datetime(2026, 11, 1, 12, tzinfo=datetime.timezone.utc)
DUMP = b"synthetic dump fixture; not a database or credential"


class BackupValidationTests(unittest.TestCase):
    def verify(self, overrides=None, dump=DUMP, include_env=True):
        manifest = {
            "file": "imonmeets-20261101T120000Z.dump",
            "createdAt": NOW.isoformat(),
            "bytes": len(DUMP),
            "sha256": hashlib.sha256(DUMP).hexdigest(),
        }
        manifest.update(overrides or {})
        with tempfile.TemporaryDirectory() as directory:
            bundle = pathlib.Path(directory) / "synthetic.tar.gz"
            with tarfile.open(bundle, "w:gz") as archive:
                entries = [("backups/latest.json", json.dumps(manifest).encode()),
                           ("backups/imonmeets-20261101T120000Z.dump", dump)]
                if include_env:
                    entries.append((".env", b"SYNTHETIC_FIXTURE=true\n"))
                for name, contents in entries:
                    member = tarfile.TarInfo(name)
                    member.size = len(contents)
                    archive.addfile(member, io.BytesIO(contents))
            return pull.verify_bundle(bundle, now=NOW)

    def test_fresh_matching_archive(self):
        manifest, size = self.verify()
        self.assertEqual(size, len(DUMP))
        self.assertEqual(manifest["sha256"], hashlib.sha256(DUMP).hexdigest())

    def test_freshness_boundaries(self):
        for delta in [-7200, 300]:
            with self.subTest(delta=delta):
                self.verify({"createdAt": (NOW + datetime.timedelta(seconds=delta)).isoformat()})
        with self.assertRaises(pull.StaleBackupError):
            self.verify({"createdAt": (NOW - datetime.timedelta(seconds=7201)).isoformat()})
        with self.assertRaises(pull.FutureBackupError):
            self.verify({"createdAt": (NOW + datetime.timedelta(seconds=301)).isoformat()})

    def test_invalid_or_timezone_free_timestamp(self):
        for value in ["not-a-date", "2026-11-01T12:00:00"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.verify({"createdAt": value})

    def test_equivalent_timestamp_with_offset(self):
        self.verify({"createdAt": "2026-11-01T15:00:00+03:00"})

    def test_checksum_and_size_mismatch(self):
        with self.assertRaises(ValueError):
            self.verify(dump=b"tampered synthetic fixture")
        with self.assertRaises(ValueError):
            self.verify({"bytes": len(DUMP) + 1})

    def test_unsafe_name_and_missing_recovery_config(self):
        with self.assertRaises(ValueError):
            self.verify({"file": "../../unexpected.dump"})
        with self.assertRaises(KeyError):
            self.verify(include_env=False)

    def test_stale_pull_reports_failure_and_removes_private_temporary_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / "connection.json").write_text(json.dumps({"destination": "synthetic.invalid"}))
            (root / "status.json").write_text(json.dumps({"ok": True, "file": "previous.dump.enc"}))
            def fake_process(args, **kwargs):
                if args[0] == "ssh":
                    kwargs["stdout"].write(b"synthetic encrypted fixture" * 10)
                elif args[0] == "openssl":
                    target = pathlib.Path(args[args.index("-out") + 1])
                    self.assertEqual(target.stat().st_mode & 0o777, 0o600)
                else:
                    self.fail("Unexpected external process")
            with patch.object(pull, "__file__", str(root / "pull-encrypted-backup.py")), \
                 patch.object(pull.subprocess, "run", side_effect=fake_process), \
                 patch.object(pull, "verify_bundle", side_effect=pull.StaleBackupError("synthetic old backup")), \
                 redirect_stdout(io.StringIO()):
                self.assertEqual(pull.main(), 1)
            status = json.loads((root / "status.json").read_text())
            self.assertFalse(status["ok"])
            self.assertEqual(status["error"], "StaleBackupError")
            self.assertEqual(status["lastSuccessfulBackup"], "previous.dump.enc")
            self.assertEqual(list(root.glob(".verify-*")), [])
            self.assertEqual(list((root / "copies").iterdir()), [])


if __name__ == "__main__":
    unittest.main()
