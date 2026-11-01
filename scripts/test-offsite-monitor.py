#!/usr/bin/env python3
"""Offline access-control and alert-state regression tests, using synthetic data."""
import datetime
import importlib.util
import io
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, pathlib.Path(__file__).with_name(file))
    obj = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(obj)
    return obj


export = module("offsite_export", "offsite-export-server.py")
pull = module("offsite_pull", "pull-encrypted-backup.py")
TOKEN = "syntheticfixturetoken" * 3
NOW = datetime.datetime(2026, 11, 1, 12, tzinfo=datetime.timezone.utc)


class FakeSocket:
    def __init__(self, request):
        self.input = io.BytesIO(request)
        self.output = bytearray()

    def makefile(self, *args, **kwargs):
        return self.input

    def sendall(self, data):
        self.output.extend(data)


class ExportTests(unittest.TestCase):
    def request(self, project, path="/_ops/health", token=TOKEN):
        request = f"GET {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\n\r\n"
        socket = FakeSocket(request.encode())
        export.make_handler(project, TOKEN)(socket, ("127.0.0.1", 10000), None)
        headers, body = bytes(socket.output).split(b"\r\n\r\n", 1)
        return headers, body

    def test_authentication_and_fixed_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            headers, body = self.request(root, token="wrong")
            self.assertIn(b"401", headers)
            self.assertEqual(json.loads(body), {"error": "unauthorized"})
            for path in ["/_ops/backup?token=x", "/../.env", "/_ops/health/", "/"]:
                headers, body = self.request(root, path=path)
                self.assertIn(b"404", headers)

    def test_backup_is_encrypted_file_only_and_rejects_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            backups = root / "backups"
            backups.mkdir()
            name = "imonmeets-20261101T120000Z.dump"
            (backups / "latest.json").write_text(json.dumps({"file": name}))
            encrypted = backups / (name + ".enc")
            contents = b"synthetic encrypted fixture" * 10
            encrypted.write_bytes(contents)
            headers, body = self.request(root, "/_ops/backup")
            self.assertIn(b"200", headers)
            self.assertEqual(body, contents)
            encrypted.unlink()
            (root / "unrelated").write_bytes(b"must not be exported")
            encrypted.symlink_to(root / "unrelated")
            headers, body = self.request(root, "/_ops/backup")
            self.assertIn(b"503", headers)
            self.assertNotIn(b"must not be exported", body)

    def test_health_freshness_and_sanitization(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / "ops-state").mkdir()
            data = {"ok": True, "checkedAt": NOW.isoformat(),
                    "secret": "must not leave host",
                    "checks": {"api": {"ok": True, "secret": "private"}}}
            target = root / "ops-state/health.json"
            target.write_text(json.dumps(data))
            health = export.sanitized_health(root, NOW)
            self.assertTrue(health["ok"])
            self.assertNotIn("secret", json.dumps(health))
            self.assertFalse(export.sanitized_health(root, NOW + datetime.timedelta(seconds=601))["ok"])


class MonitorTests(unittest.TestCase):
    def test_tls_url_and_token_not_in_process_arguments(self):
        cfg = {"baseUrl": "https://example.invalid:8443", "bearerToken": TOKEN}
        with patch.object(pull.subprocess, "run") as run:
            pull.https_fetch(pathlib.Path("/tmp"), cfg, "/_ops/health")
            args, kwargs = run.call_args
            self.assertEqual(args[0], ["/usr/bin/curl", "--config", "-"])
            text = kwargs["input"].decode()
            self.assertIn("Authorization: Bearer " + TOKEN, text)
            self.assertNotIn("insecure", text)
            self.assertNotIn("location", text)
            self.assertIn('proto = "=https"', text)
        for base in ["http://example.invalid", "https://user:pass@example.invalid", "https://example.invalid?a=b"]:
            with self.assertRaises(ValueError):
                pull.https_fetch(pathlib.Path("/tmp"), {**cfg, "baseUrl": base}, "/_ops/health")

    def test_alert_debounce_reminder_and_recovery(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(pull, "notify_mac") as notify:
            root = pathlib.Path(directory)
            pull.update_alerts(root, {"ok": False}, now=100)
            notify.assert_not_called()
            pull.update_alerts(root, {"ok": False}, now=400)
            self.assertEqual(notify.call_count, 1)
            pull.update_alerts(root, {"ok": False}, now=700)
            self.assertEqual(notify.call_count, 1)
            pull.update_alerts(root, {"ok": False}, now=22001)
            self.assertEqual(notify.call_count, 2)
            pull.update_alerts(root, {"ok": True}, now=22300)
            self.assertEqual(notify.call_count, 3)
            self.assertFalse(json.loads((root / "alert-state.json").read_text())["active"])
            pull.update_alerts(root, {"ok": True}, now=22600)
            self.assertEqual(notify.call_count, 3)

    def test_failed_notification_is_retried(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(pull, "notify_mac", side_effect=OSError) as notify:
            root = pathlib.Path(directory)
            for now in [100, 400, 700]:
                pull.update_alerts(root, {"ok": False}, now=now)
            self.assertEqual(notify.call_count, 2)
            state = json.loads((root / "alert-state.json").read_text())
            self.assertFalse(state["active"])
            self.assertEqual(state["notificationError"], "OSError")


if __name__ == "__main__":
    unittest.main()
