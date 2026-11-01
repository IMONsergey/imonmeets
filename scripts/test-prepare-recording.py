#!/usr/bin/env python3
"""Security regressions for private recording preparation; no services used."""
import importlib.util
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("prepare_recording", Path(__file__).with_name("prepare-recording.py"))
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class RecordingPreparationTests(unittest.TestCase):
    def test_app_identity_is_bucket_scoped_and_distinct_from_admin(self):
        credentials = prepare.new_credentials()
        config = prepare.s3_config(credentials)
        self.assertEqual(len(config["identities"]), 2)
        app = config["identities"][1]
        self.assertEqual(set(app["actions"]), {"Read:imon-recordings", "Write:imon-recordings", "List:imon-recordings"})
        self.assertNotEqual(app["credentials"], config["identities"][0]["credentials"])
        self.assertFalse(any(item["name"] == "anonymous" for item in config["identities"]))
        values = prepare.environment_values(credentials, Path("/srv/recordings"), "https://media.example.test:8443", {})
        self.assertNotIn(credentials["admin"]["secretKey"], str(values))
        self.assertEqual(values["RECORDING_ENABLED"], "false")
        self.assertEqual(values["MAX_ACTIVE_RECORDINGS"], "1")
        self.assertEqual(values["RECORDING_RETENTION_DAYS"], "3")
        self.assertEqual(prepare.environment_values(credentials, Path("/srv/recordings"), "https://media.example.test:8443", values), values)
        with self.assertRaises(ValueError):
            prepare.environment_values(credentials, Path("/srv/recordings"), "https://media.example.test", {"S3_ACCESS_KEY_ID": "existing-other-owner"})

    def test_storage_guard_rejects_host_disk_or_missing_mount(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            with self.assertRaises(ValueError):
                prepare.validate_storage(directory)
            with patch.object(Path, "is_mount", return_value=True):
                with patch.object(prepare.os, "statvfs", return_value=SimpleNamespace(f_blocks=1024**3 // 4096, f_frsize=4096)):
                    prepare.validate_storage(directory)
                with patch.object(prepare.os, "statvfs", return_value=SimpleNamespace(f_blocks=64 * 1024**3 // 4096, f_frsize=4096)):
                    with self.assertRaises(ValueError):
                        prepare.validate_storage(directory)

    def test_rejects_insecure_origin_and_template_injection(self):
        for origin in ("http://example.test", "https://user:secret@example.test", "https://example.test/bucket", "https://example.test?token=secret", "https://example.test#fragment"):
            with self.assertRaises(ValueError):
                prepare.https_origin(origin)
        template = 'api_key: "__LIVEKIT_API_KEY__"\napi_secret: "__LIVEKIT_API_SECRET__"\n'
        with self.assertRaises(ValueError):
            prepare.render_egress(template, {"LIVEKIT_API_KEY": "valid-test-key", "LIVEKIT_API_SECRET": "a" * 40 + "\nenable_chrome_sandbox: false"})
        with self.assertRaises(ValueError):
            prepare.render_egress(template * 2, {"LIVEKIT_API_KEY": "valid-test-key", "LIVEKIT_API_SECRET": "a" * 40})

    def test_env_is_parsed_without_executing_commands_and_duplicate_keys_fail(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            env = directory / ".env"
            sentinel = directory / "should-not-exist"
            env.write_text(f'SMTP_PASSWORD=$(touch {sentinel})\nREGISTRATION_ENABLED=false\n')
            original, values = prepare.read_env(env)
            self.assertFalse(sentinel.exists())
            self.assertIn("$(touch", values["SMTP_PASSWORD"])
            merged = prepare.merge_environment(original, {"S3_BUCKET": "imon-recordings"})
            self.assertIn("REGISTRATION_ENABLED=false", merged)
            self.assertIn(f"SMTP_PASSWORD=$(touch {sentinel})", merged)
            env.write_text("S3_BUCKET=first\nS3_BUCKET=second\n")
            with self.assertRaises(ValueError):
                prepare.read_env(env)

    def test_private_atomic_write_refuses_symlink_and_keeps_permissions(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            destination = directory / "secret"
            prepare.atomic_private_write(destination, "private-test-only", os.getuid(), os.getgid(), 0o400)
            self.assertEqual(destination.stat().st_mode & 0o777, 0o400)
            self.assertEqual(destination.read_text(), "private-test-only")
            linked = directory / "linked"
            linked.symlink_to(destination)
            with self.assertRaises(ValueError):
                prepare.atomic_private_write(linked, "overwritten", os.getuid(), os.getgid())
            self.assertEqual(destination.read_text(), "private-test-only")


if __name__ == "__main__":
    unittest.main()
