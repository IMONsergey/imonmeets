#!/usr/bin/env python3
"""Validate real Compose rendering with synthetic inputs; never start a service."""
import json
import os
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]


def fixture():
    return {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": os.environ["HOME"],
        "APP_IMAGE": "sha256:" + "1" * 64,
        "APP_URL": "https://app.example.test",
        "POSTGRES_PASSWORD": "synthetic-database-password",
        "APP_DATABASE_PASSWORD": "synthetic-application-password",
        "BETTER_AUTH_SECRET": "synthetic-auth-secret-never-deployed-20261103",
        "LIVEKIT_API_KEY": "synthetic-livekit-key",
        "LIVEKIT_API_SECRET": "synthetic-livekit-secret-never-deployed-20261103",
        "DELETION_JOURNAL_HOST_DIR": "/tmp/imonmeets-compose-fixture-journal-not-created",
        "WITNESS_IMAGE": "sha256:" + "2" * 64,
        "WITNESS_STORAGE_ROLE": "independent-durable",
        "WITNESS_ALLOWED_JOURNAL_ID": "11111111-1111-4111-8111-111111111111",
        "WITNESS_ALLOWED_GENESIS_SHA256": "3" * 64,
        "WITNESS_JOURNAL_KEY": "synthetic-journal-key-never-deployed-20261103",
        "WITNESS_API_TOKEN": "synthetic-witness-token-never-deployed-20261103",
        "WITNESS_DATA_DIRECTORY": "/tmp/imonmeets-compose-fixture-data-not-created",
        "WITNESS_PRIVATE_DIRECTORY": "/tmp/imonmeets-compose-fixture-private-not-created",
    }


def render(files, environment=None, *, check=True):
    arguments = ["docker", "compose", "--env-file", "/dev/null", "-p", "imonmeets-compose-readonly-fixture"]
    for filename in files:
        arguments.extend(["-f", str(ROOT / filename)])
    arguments.extend(["config", "--format", "json"])
    result = subprocess.run(arguments, cwd=ROOT, env=environment or fixture(),
                            capture_output=True, text=True, timeout=15)
    if check:
        if result.returncode:
            raise AssertionError("Compose rendering failed: " + result.stderr[:500])
        return json.loads(result.stdout)
    return result


class DeletionComposeTests(unittest.TestCase):
    def test_app_journal_mount_never_creates_a_missing_host_directory(self):
        service = render(["compose.yml", "compose.deletion.yml"])["services"]["app"]
        mount = next(item for item in service["volumes"]
                     if item["target"] == "/var/lib/imonmeets/deletion-journal")
        self.assertEqual(mount["type"], "bind")
        self.assertFalse(mount["bind"].get("create_host_path", False))
        self.assertFalse(mount.get("read_only", False))

    def test_witness_tmpfs_is_one_absolute_mount_including_its_mode(self):
        service = render(["compose.deletion-witness.yml"])["services"]["witness"]
        self.assertEqual(service["tmpfs"], ["/tmp:size=8m,mode=1777"])
        self.assertTrue(all(item.startswith("/") for item in service["tmpfs"]))

    def test_witness_requires_both_existing_private_host_directories(self):
        service = render(["compose.deletion-witness.yml"])["services"]["witness"]
        mounts = {item["target"]: item for item in service["volumes"]}
        self.assertEqual(set(mounts), {"/data", "/run/imon"})
        for mount in mounts.values():
            self.assertEqual(mount["type"], "bind")
            self.assertFalse(mount["bind"].get("create_host_path", False))
        self.assertTrue(mounts["/run/imon"]["read_only"])
        self.assertFalse(mounts["/data"].get("read_only", False))

    def test_missing_directory_input_fails_before_any_deployment(self):
        for missing in ["WITNESS_DATA_DIRECTORY", "WITNESS_PRIVATE_DIRECTORY"]:
            environment = fixture()
            del environment[missing]
            with self.subTest(missing=missing):
                result = render(["compose.deletion-witness.yml"], environment, check=False)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(missing, result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
