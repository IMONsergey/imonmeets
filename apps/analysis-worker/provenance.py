"""Measured model provenance. No network, fallback models, or name-based claims."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import stat
from pathlib import Path, PurePosixPath

SHA256 = re.compile(r"[a-f0-9]{64}\Z")
MAX_MANIFEST = 256 * 1024
MAX_ARTIFACT = 16 * 1024 * 1024 * 1024
REQUIRED_WHISPER = {"model.bin", "config.json", "tokenizer.json"}


def fingerprint(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def plain_path(path):
    path = Path(os.path.abspath(path))
    for item in [*reversed(path.parents), path]:
        if item.is_symlink():
            raise RuntimeError("Model symlinks are forbidden")
    return path


def relative_path(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 256:
        raise RuntimeError("Invalid model path")
    parts = value.split("/")
    if any(part in ("", ".", "..") for part in parts) or not re.fullmatch(r"[A-Za-z0-9_./-]+", value):
        raise RuntimeError("Invalid model path")
    if PurePosixPath(value).is_absolute():
        raise RuntimeError("Invalid model path")
    return value


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise RuntimeError("Duplicate manifest field")
        result[key] = value
    return result


def exact(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise RuntimeError("Invalid model manifest")
    return value


def artifact(value):
    exact(value, {"path", "sha256", "bytes"})
    relative_path(value["path"])
    if not isinstance(value["sha256"], str) or not SHA256.fullmatch(value["sha256"]):
        raise RuntimeError("Invalid artifact digest")
    if type(value["bytes"]) is not int or not 0 < value["bytes"] <= MAX_ARTIFACT:
        raise RuntimeError("Invalid artifact size")
    return value


def read_digest(path, maximum=MAX_ARTIFACT):
    path = plain_path(path)
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= maximum:
        raise RuntimeError("Invalid model artifact")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        if fingerprint(os.fstat(stream.fileno())) != fingerprint(before):
            raise RuntimeError("Model changed during verification")
        while block := stream.read(1024 * 1024):
            digest.update(block)
        after = os.fstat(stream.fileno())
    if fingerprint(before) != fingerprint(after) or fingerprint(path.stat()) != fingerprint(after):
        raise RuntimeError("Model changed during verification")
    return digest.hexdigest(), fingerprint(after)


def inventory(directory):
    directory = plain_path(directory)
    if not directory.is_dir():
        raise RuntimeError("Whisper directory is missing")
    result = set()
    for root, directories, files in os.walk(directory, followlinks=False):
        for name in directories:
            if (Path(root) / name).is_symlink():
                raise RuntimeError("Model symlinks are forbidden")
        for name in files:
            item = Path(root) / name
            relative = item.relative_to(directory).as_posix()
            relative_path(relative)
            if item.is_symlink() or not item.is_file():
                raise RuntimeError("Invalid model artifact")
            result.add(relative)
            if len(result) > 128:
                raise RuntimeError("Too many model files")
    return result


class VerifiedModels:
    def __init__(self, manifest_path, manifest_sha256, whisper_path, files, summary, snapshots):
        self.manifest_path = manifest_path
        self.manifest_sha256 = manifest_sha256
        self.whisper_path = whisper_path
        self.files = files
        self.whisper_sha256 = hashlib.sha256(
            json.dumps(files, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
        ).hexdigest()
        self.whisper_identity = "faster-whisper-sha256-" + self.whisper_sha256
        self.summary = summary
        self.summary_identity = "gguf-sha256-" + summary["sha256"] if summary else None
        self.snapshots = snapshots

    def assert_unchanged(self):
        if not os.statvfs(self.manifest_path.parent).f_flag & os.ST_RDONLY:
            raise RuntimeError("Model directory is no longer read-only")
        for path, snapshot in self.snapshots:
            if fingerprint(plain_path(path).stat()) != snapshot:
                raise RuntimeError("Verified model changed")
        if inventory(self.whisper_path) != {entry["path"] for entry in self.files}:
            raise RuntimeError("Whisper inventory changed")

    def result_provenance(self, summary=False):
        value = {
            "schema": 1, "manifestSha256": self.manifest_sha256,
            "whisper": {"sha256": self.whisper_sha256, "files": self.files},
        }
        if summary:
            if not self.summary:
                raise RuntimeError("Verified summary model is missing")
            value["summary"] = {"sha256": self.summary["sha256"], "bytes": self.summary["bytes"]}
        return value


def verify_models(*, require_summary=False):
    expected = os.environ.get("ANALYSIS_MODEL_MANIFEST_SHA256", "")
    if not SHA256.fullmatch(expected):
        raise RuntimeError("Expected model manifest digest is required")
    path = plain_path(os.environ.get("ANALYSIS_MODEL_MANIFEST_PATH", "/models/analysis-manifest.json"))
    # A writable model volume is never enabled through a configuration bypass.
    if not os.statvfs(path.parent).f_flag & os.ST_RDONLY:
        raise RuntimeError("Model directory must be mounted read-only")
    measured, manifest_snapshot = read_digest(path, MAX_MANIFEST)
    if not hmac.compare_digest(measured, expected):
        raise RuntimeError("Model manifest digest mismatch")
    raw = path.read_bytes()
    if len(raw) > MAX_MANIFEST or hashlib.sha256(raw).hexdigest() != measured:
        raise RuntimeError("Model manifest changed")
    value = exact(json.loads(raw, object_pairs_hook=unique_object), {"schema", "whisper", "summary"})
    if type(value["schema"]) is not int or value["schema"] != 1:
        raise RuntimeError("Unsupported model manifest")
    whisper = exact(value["whisper"], {"directory", "files"})
    directory = plain_path(path.parent / relative_path(whisper["directory"]))
    entries = whisper["files"]
    if not isinstance(entries, list) or not 3 <= len(entries) <= 128:
        raise RuntimeError("Invalid Whisper inventory")
    records = [artifact(entry) for entry in entries]
    names = {entry["path"] for entry in records}
    if len(names) != len(records) or not REQUIRED_WHISPER <= names or inventory(directory) != names:
        raise RuntimeError("Incomplete Whisper inventory")
    configured = os.environ.get("WHISPER_MODEL_PATH")
    if configured and plain_path(configured) != directory:
        raise RuntimeError("Whisper path differs from verified manifest")
    snapshots = [(path, manifest_snapshot)]
    measured_files = []
    for entry in sorted(records, key=lambda entry: entry["path"]):
        file_path = directory / entry["path"]
        digest, snapshot = read_digest(file_path)
        if digest != entry["sha256"] or snapshot[2] != entry["bytes"]:
            raise RuntimeError("Whisper artifact mismatch")
        snapshots.append((file_path, snapshot))
        measured_files.append({"path": entry["path"], "sha256": digest, "bytes": snapshot[2]})
    summary = value["summary"]
    if require_summary and summary is None:
        raise RuntimeError("Summary artifact is required")
    if summary is not None:
        artifact(summary)
        summary_path = plain_path(path.parent / summary["path"])
        digest, snapshot = read_digest(summary_path)
        with summary_path.open("rb") as stream:
            magic = stream.read(4)
        if digest != summary["sha256"] or snapshot[2] != summary["bytes"] or snapshot[2] < 24 or magic != b"GGUF":
            raise RuntimeError("Summary artifact mismatch")
        summary = {"path": summary_path, "sha256": digest, "bytes": snapshot[2]}
        snapshots.append((summary_path, snapshot))
    models = VerifiedModels(path, measured, directory, measured_files, summary, snapshots)
    models.assert_unchanged()
    return models
