#!/usr/bin/env python3
"""Offline transfer refusal tests. No Docker, provider, credentials, or release writes."""
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("candidate", Path(__file__).with_name("ci-candidate-image.py"))
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)
COMMIT = "a" * 40
CI = {"repository": candidate.REPOSITORY, "runId": "123", "runAttempt": "1"}
ENV = {"GITHUB_ACTIONS": "true", "GITHUB_EVENT_NAME": "push", "GITHUB_REPOSITORY": candidate.REPOSITORY,
       "GITHUB_REF": candidate.RELEASE_REF, "GITHUB_SHA": COMMIT, "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1"}


def encoded(value):
    return (json.dumps(value, sort_keys=True) + "\n").encode()


def fixture(directory, *, unsafe=False):
    config = encoded({"architecture": "amd64", "os": "linux", "config": {
        "Env": ["RELEASE_COMMIT=" + COMMIT], "Labels": {"org.opencontainers.image.revision": COMMIT}}})
    image_id = "sha256:" + hashlib.sha256(config).hexdigest()
    config_name = "blobs/sha256/" + image_id[7:]
    archive_buffer = io.BytesIO()
    with tarfile.open(fileobj=archive_buffer, mode="w") as archive:
        for name, content in {
            "manifest.json": encoded([{"Config": config_name, "Layers": ["layer/layer.tar"]}]),
            config_name: config, "layer/layer.tar": b"synthetic-layer-not-a-runtime-image",
        }.items():
            member = tarfile.TarInfo(name); member.size = len(content)
            archive.addfile(member, io.BytesIO(content))
        if unsafe:
            member = tarfile.TarInfo("escape"); member.type = tarfile.SYMTYPE; member.linkname = "/etc/passwd"
            archive.addfile(member)
    raw = archive_buffer.getvalue()
    name = "imonmeets-app-" + COMMIT + ".tar.gz"
    (directory / name).write_bytes(gzip.compress(raw, mtime=0))
    for item in candidate.INVENTORY_FILES:
        (directory / item).write_bytes(encoded({"fixture": item}))
    build = {"sourceCommit": COMMIT, "imageId": image_id, "sourceArchiveSha256": "b" * 64,
             "productionChanges": False, "deployed": False}
    inventory = {"sourceCommit": COMMIT, "status": "PASS_RUNTIME_NPM_INVENTORY", "productionChanges": False,
                 "deployed": False, **{key: candidate.file_hash(directory / item, candidate.MAX_JSON)["sha256"]
                                        for item, key in candidate.INVENTORY_FILES.items()}}
    (directory / "build-receipt.json").write_bytes(encoded(build))
    (directory / "inventory-receipt.json").write_bytes(encoded(inventory))
    manifest = {"schema": 1, "status": "EXPORTED_CANDIDATE_NOT_DEPLOYED", "sourceCommit": COMMIT,
                "imageId": image_id, "platform": "linux/amd64", "archive": {
                    "filename": name, "format": "docker-save+gzip", "uncompressedBytes": len(raw),
                    **candidate.file_hash(directory / name, candidate.MAX_ARCHIVE)},
                "evidence": {item: candidate.file_hash(directory / item, candidate.MAX_JSON) for item in candidate.EVIDENCE},
                "ci": CI, "productionChanges": False, "deployed": False}
    (directory / "transfer-manifest.json").write_bytes(encoded(manifest))
    sums = "".join(candidate.file_hash(p, candidate.MAX_ARCHIVE)["sha256"] + "  " + p.name + "\n"
                   for p in sorted(directory.iterdir()))
    (directory / "SHA256SUMS").write_text(sums)
    return manifest, raw


class TransferTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.manifest, self.raw = fixture(self.directory)

    def tearDown(self):
        self.temp.cleanup()

    def test_complete_payload_with_independent_expected_identities(self):
        result = candidate.verify(self.directory, COMMIT, expected_image=self.manifest["imageId"],
                                  expected_archive=self.manifest["archive"]["sha256"],
                                  expected_manifest=candidate.file_hash(self.directory / "transfer-manifest.json", candidate.MAX_JSON)["sha256"],
                                  expected_ci=CI)
        self.assertEqual(result["status"], "PASS_CANDIDATE_IMAGE_TRANSFER")
        self.assertIs(result["deployed"], False)

    def test_different_commit_image_or_ci_attempt_rejected(self):
        for changes in ({"commit": "c" * 40}, {"expected_image": "sha256:" + "d" * 64},
                        {"expected_ci": {**CI, "runAttempt": "2"}}, {"expected_manifest": "e" * 64}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                candidate.verify(self.directory, changes.get("commit", COMMIT), **{k: v for k, v in changes.items() if k != "commit"})

    def test_archive_corruption_is_not_accepted_by_manifest(self):
        path = self.directory / self.manifest["archive"]["filename"]
        path.write_bytes(path.read_bytes() + b"corruption")
        with self.assertRaisesRegex(ValueError, "ARCHIVE_HASH_OR_SIZE_MISMATCH"):
            candidate.verify(self.directory, COMMIT)

    def test_receipt_and_inventory_tampering_rejected(self):
        for name in ("inventory-receipt.json", "installed-npm-tree.json"):
            path = self.directory / name
            original = path.read_bytes()
            path.write_bytes(encoded({"sourceCommit": COMMIT, "status": "FAILED"}))
            with self.subTest(name=name), self.assertRaises(ValueError):
                candidate.verify(self.directory, COMMIT)
            path.write_bytes(original)

    def test_unexpected_file_and_symbolic_link_rejected(self):
        extra = self.directory / "unexpected.env"
        extra.write_text("fixture-only")
        with self.assertRaisesRegex(ValueError, "UNEXPECTED_PAYLOAD_FILES"):
            candidate.verify(self.directory, COMMIT)
        extra.unlink()
        path = self.directory / "build-receipt.json"
        path.unlink(); path.symlink_to("/etc/passwd")
        with self.assertRaisesRegex(ValueError, "INVALID_PAYLOAD_FILE"):
            candidate.verify(self.directory, COMMIT)

    def test_archive_size_cap_is_enforced_before_hashing(self):
        with patch.object(candidate, "MAX_ARCHIVE", 1), self.assertRaisesRegex(ValueError, "INVALID_PAYLOAD_FILE"):
            candidate.verify(self.directory, COMMIT)

    def test_saved_config_hash_and_revision_are_checked_without_extracting(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "image.tar"; path.write_bytes(self.raw)
            candidate.check_saved_image(path, COMMIT, self.manifest["imageId"])
            with self.assertRaisesRegex(ValueError, "SAVED_IMAGE_ID_MISMATCH"):
                candidate.check_saved_image(path, COMMIT, "sha256:" + "e" * 64)
            with self.assertRaisesRegex(ValueError, "SAVED_IMAGE_SOURCE_MISMATCH"):
                candidate.check_saved_image(path, "f" * 40, self.manifest["imageId"])

    def test_outer_archive_link_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); manifest, raw = fixture(root, unsafe=True)
            path = root / "image.tar"; path.write_bytes(raw)
            with self.assertRaisesRegex(ValueError, "UNSAFE_SAVE_MEMBER"):
                candidate.check_saved_image(path, COMMIT, manifest["imageId"])

    def test_only_the_exact_repository_push_branch_can_export_or_publish(self):
        with patch.dict(os.environ, ENV, clear=True):
            self.assertEqual(candidate.ci_context(), CI)
            for key, value in (("GITHUB_EVENT_NAME", "pull_request"), ("GITHUB_REF", candidate.RELEASE_REF + "-other"),
                               ("GITHUB_REPOSITORY", "someone/imonmeets")):
                with patch.dict(os.environ, {key: value}), self.assertRaisesRegex(ValueError, "AUTHORIZED_CI_PUSH_REQUIRED"):
                    candidate.ci_context()

    def test_existing_release_or_tag_and_ambiguous_api_failures_refuse_publication(self):
        missing = subprocess.CompletedProcess([], 1, "HTTP/2.0 404 Not Found\n\n{}", "")
        found = subprocess.CompletedProcess([], 0, "HTTP/2.0 200 OK\n\n{}", "")
        errors = [found, subprocess.CompletedProcess([], 1, "HTTP/2.0 403 Forbidden\n\n{}", ""),
                  subprocess.CompletedProcess([], 1, "", "timeout")]
        with patch.dict(os.environ, ENV, clear=True):
            with patch.object(candidate.subprocess, "run", side_effect=[missing, missing]) as run:
                self.assertEqual(candidate.require_release_absent(COMMIT)["status"], "RELEASE_AND_TAG_ABSENT")
                self.assertTrue(all(call.args[0][:3] == ["gh", "api", "--include"] for call in run.call_args_list))
            for response in errors:
                with self.subTest(response=response), patch.object(candidate.subprocess, "run", return_value=response), self.assertRaises(ValueError):
                    candidate.require_release_absent(COMMIT)
            with patch.object(candidate.subprocess, "run", side_effect=[missing, found]), self.assertRaises(ValueError):
                candidate.require_release_absent(COMMIT)


if __name__ == "__main__":
    unittest.main()
