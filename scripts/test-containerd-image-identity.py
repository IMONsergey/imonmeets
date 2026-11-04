#!/usr/bin/env python3
"""Offline archive/loaded-image refusal tests. No Docker, network or deployment."""
import copy
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("identity_bridge", Path(__file__).with_name("verify-containerd-image-identity.py"))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
candidate = bridge.candidate
COMMIT, SOURCE_HASH = "a" * 40, "d" * 64
CREATED = "2026-11-03T06:00:00Z"
MANIFEST_TYPE = "application/vnd.oci.image.manifest.v1+json"
LAYER_TYPE = "application/vnd.oci.image.layer.v1.tar"

def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()

def digest(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()

def blob_path(value):
    return "blobs/sha256/" + value[7:]

def fixture(directory, fault=None):
    directory.mkdir(parents=True, exist_ok=True)
    layer_bytes = [b"synthetic-first-layer-not-executed", b"synthetic-second-layer-not-executed"]
    layer_ids = [digest(data) for data in layer_bytes]
    config = {"architecture": "amd64", "os": "linux", "created": CREATED,
              "rootfs": {"type": "layers", "diff_ids": layer_ids},
              "config": {"Env": ["RELEASE_COMMIT=" + COMMIT],
                         "Labels": {"org.opencontainers.image.revision": COMMIT}}}
    if fault == "config-source":
        config["config"]["Labels"]["org.opencontainers.image.revision"] = "f" * 40
    if fault == "release-env":
        config["config"]["Env"] = ["RELEASE_COMMIT=" + "f" * 40]
    config_bytes = encoded(config)
    config_id = digest(config_bytes)
    layers = [{"mediaType": LAYER_TYPE, "digest": value, "size": len(data)}
              for value, data in zip(layer_ids, layer_bytes)]
    if fault == "reordered-layers":
        layers.reverse()
    if fault == "extra-layer":
        layers.append(copy.deepcopy(layers[0]))
    if fault == "compressed-type":
        layers[0]["mediaType"] = "application/vnd.oci.image.layer.v1.tar+gzip"
    manifest = {"schemaVersion": 2, "mediaType": MANIFEST_TYPE,
                "config": {"mediaType": "application/vnd.oci.image.config.v1+json",
                           "digest": config_id, "size": len(config_bytes)}, "layers": layers}
    if fault == "wrong-config":
        manifest["config"]["digest"] = layer_ids[0]
    manifest_bytes = encoded(manifest)
    runtime_id = digest(manifest_bytes)
    index = {"schemaVersion": 2, "manifests": [{"mediaType": MANIFEST_TYPE,
              "digest": runtime_id, "size": len(manifest_bytes)}]}
    if fault == "multiple-images":
        index["manifests"].append(copy.deepcopy(index["manifests"][0]))
    saved = [{"Config": blob_path(config_id), "Layers": [blob_path(x["digest"]) for x in layers]}]
    if fault == "legacy-order":
        saved[0]["Layers"].reverse()
    if fault == "config-alias":
        saved[0]["Config"] = "./" + saved[0]["Config"]
    files = {"index.json": encoded(index), "manifest.json": encoded(saved),
             "oci-layout": encoded({"imageLayoutVersion": "1.0.0"}),
             blob_path(config_id): config_bytes, blob_path(runtime_id): manifest_bytes,
             **{blob_path(value): data for value, data in zip(layer_ids, layer_bytes)}}
    if fault == "missing-layer":
        del files[blob_path(layer_ids[0])]
    if fault == "layer-bytes":
        files[blob_path(layer_ids[0])] = b"altered-layer"
    if fault == "foreign-archive-file":
        files["unexpected.txt"] = b"unreviewed-data"
    if fault == "member-alias":
        files["./" + blob_path(layer_ids[0])] = files.pop(blob_path(layer_ids[0]))
    raw_io = io.BytesIO()
    with tarfile.open(fileobj=raw_io, mode="w") as archive:
        for name, data in files.items():
            member = tarfile.TarInfo(name)
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
        if fault == "unsafe-link":
            member = tarfile.TarInfo("unexpected-link")
            member.type, member.linkname = tarfile.SYMTYPE, "/etc/passwd"
            archive.addfile(member)
    raw = raw_io.getvalue()
    archive_name = "imonmeets-app-" + COMMIT + ".tar.gz"
    (directory / archive_name).write_bytes(gzip.compress(raw, mtime=0))
    limits = {"CpuPeriod": 100000, "CpuQuota": 100000, "Memory": 2147483648, "MemorySwap": 2147483648}
    build = {"schema": 1, "sourceCommit": COMMIT, "sourceArchiveSha256": SOURCE_HASH, "imageId": config_id,
             "imageTag": "imonmeets:identity-fixture", "imageCreatedAt": CREATED,
             "startedAt": "2026-11-03T05:59:00Z", "completedAt": "2026-11-03T06:02:00Z",
             "builder": "synthetic bounded builder", "observedRunStepLimits": {"c" * 64: limits},
             "productionChanges": False, "deployed": False,
             "acceptance": "build-only; migrations and external capabilities not accepted"}
    for name in candidate.INVENTORY_FILES:
        (directory / name).write_bytes(encoded({"fixture": name}))
    inventory = {"sourceCommit": COMMIT, "status": "PASS_RUNTIME_NPM_INVENTORY", "productionChanges": False,
                 "deployed": False, **{key: candidate.file_hash(directory / name, candidate.MAX_JSON)["sha256"]
                                       for name, key in candidate.INVENTORY_FILES.items()}}
    (directory / "build-receipt.json").write_bytes(encoded(build))
    (directory / "build-receipt.json").chmod(0o600)
    (directory / "inventory-receipt.json").write_bytes(encoded(inventory))
    transfer = {"schema": 1, "status": "EXPORTED_CANDIDATE_NOT_DEPLOYED", "sourceCommit": COMMIT,
                "imageId": config_id, "platform": "linux/amd64", "productionChanges": False, "deployed": False,
                "ci": {"repository": candidate.REPOSITORY, "runId": "123", "runAttempt": "1"},
                "archive": {"filename": archive_name, "format": "docker-save+gzip", "uncompressedBytes": len(raw),
                            **candidate.file_hash(directory / archive_name, candidate.MAX_ARCHIVE)},
                "evidence": {name: candidate.file_hash(directory / name, candidate.MAX_JSON) for name in candidate.EVIDENCE}}
    (directory / "transfer-manifest.json").write_bytes(encoded(transfer))
    (directory / "SHA256SUMS").write_text("".join(candidate.file_hash(p, candidate.MAX_ARCHIVE)["sha256"] + "  " + p.name + "\n" for p in sorted(directory.iterdir())))
    loaded = {"id": runtime_id, "created": CREATED, "revision": COMMIT, "os": "linux", "architecture": "amd64",
              "rootfs": {"type": "layers", "diff_ids": layer_ids}, "releaseCommit": COMMIT}
    return {"buildReceipt": build, "buildReceiptSha256": hashlib.sha256(encoded(build)).hexdigest(),
            "imageInfo": loaded, "sourceCommit": COMMIT, "sourceArchiveSha256": SOURCE_HASH}

class IdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name) / "candidate"
        self.context = fixture(self.directory)
    def tearDown(self):
        self.temp.cleanup()
    def verify(self, context=None, **changes):
        c = context or self.context
        args = dict(directory=self.directory, loaded=c["imageInfo"], commit=c["sourceCommit"],
                    expected_config=c["buildReceipt"]["imageId"], expected_receipt_hash=c["buildReceiptSha256"])
        args.update(changes)
        return bridge.verify(**args)
    def test_verified_mapping_preserves_original_receipt(self):
        original = (self.directory / "build-receipt.json").read_bytes()
        proof = self.verify()
        self.assertEqual(proof["legacyConfigDigest"], self.context["buildReceipt"]["imageId"])
        self.assertEqual(proof["runtimeManifestDigest"], self.context["imageInfo"]["id"])
        self.assertNotEqual(proof["legacyConfigDigest"], proof["runtimeManifestDigest"])
        self.assertEqual(proof["layerCount"], 2)
        self.assertTrue(proof["loadedRootfsMatches"])
        self.assertFalse(proof["imageExecuted"])
        self.assertEqual((self.directory / "build-receipt.json").read_bytes(), original)
    def test_archive_structure_and_bytes_refuse_inconsistent_mapping(self):
        faults = ["config-source", "release-env", "reordered-layers", "extra-layer", "compressed-type",
                  "wrong-config", "multiple-images", "legacy-order", "config-alias", "missing-layer",
                  "layer-bytes", "unsafe-link", "foreign-archive-file", "member-alias"]
        for fault in faults:
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as temp:
                directory = Path(temp) / "candidate"
                c = fixture(directory, fault)
                with self.assertRaises((ValueError, KeyError)):
                    self.verify(c, directory=directory)
    def test_unrelated_loaded_image_and_rootfs_or_platform_refused(self):
        for field, value in [("id", "sha256:" + "f" * 64), ("id", self.context["buildReceipt"]["imageId"]), ("revision", "f" * 40),
                             ("architecture", "arm64"), ("created", "2026-11-03T06:01:00Z"),
                             ("releaseCommit", "f" * 40),
                             ("rootfs", {"type": "layers", "diff_ids": list(reversed(self.context["imageInfo"]["rootfs"]["diff_ids"]))})]:
            loaded = copy.deepcopy(self.context["imageInfo"])
            loaded[field] = value
            with self.subTest(field=field), self.assertRaises((ValueError, KeyError)):
                self.verify(loaded=loaded)
    def test_original_receipt_pin_and_payload_checksum_cannot_be_overridden(self):
        for changes in [{"expected_config": "sha256:" + "f" * 64}, {"expected_receipt_hash": "f" * 64},
                        {"commit": "f" * 40}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.verify(**changes)
        archive = self.directory / ("imonmeets-app-" + COMMIT + ".tar.gz")
        archive.write_bytes(archive.read_bytes() + b"corruption")
        with self.assertRaises(ValueError):
            self.verify()
    def test_foreign_files_and_payload_directory_alias_are_refused(self):
        extra = self.directory / "unreviewed.env"
        extra.write_text("synthetic-only")
        with self.assertRaises(ValueError):
            self.verify()
        extra.unlink()
        alias = self.directory.parent / "alias"
        alias.symlink_to(self.directory, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.verify(directory=alias)
        alias.unlink()
        alias.symlink_to(self.directory.parent, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.verify(directory=alias / "candidate")

if __name__ == "__main__":
    if len(sys.argv) in (3, 5) and sys.argv[1] == "fixture":
        if len(sys.argv) == 5:
            COMMIT, SOURCE_HASH = sys.argv[3:5]
        print(json.dumps(fixture(Path(sys.argv[2]))))
    else:
        unittest.main()
