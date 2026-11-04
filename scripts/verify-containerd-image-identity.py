#!/usr/bin/env python3
"""Verify a containerd runtime ID against the unchanged CI config-ID receipt.
No extraction, Docker command, image execution, network or receipt writes.
Only this publisher's uncompressed Docker-save layer format is supported.
"""
import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import resource
import stat
import sys
import tarfile

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("candidate_transfer", Path(__file__).with_name("ci-candidate-image.py"))
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)
MAX_RAW, MAX_JSON, CHUNK = 2 * 1024**3, 5 * 1024**2, 1024**2

def require(ok, code):
    if not ok:
        raise ValueError(code)

def sha(data):
    return hashlib.sha256(data).hexdigest()

def fingerprint(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns

def read_json(path):
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and 0 < before.st_size <= MAX_JSON, "UNSAFE_JSON")
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as stream:
        require(fingerprint(os.fstat(stream.fileno())) == fingerprint(before), "JSON_CHANGED")
        raw = stream.read(MAX_JSON + 1)
        require(len(raw) == before.st_size and fingerprint(os.fstat(stream.fileno())) == fingerprint(before), "JSON_CHANGED")
    value = json.loads(raw)
    require(isinstance(value, dict), "JSON_OBJECT_REQUIRED")
    return value, sha(raw)

class BoundedStream:
    def __init__(self, stream, limit):
        self.stream, self.limit, self.count = stream, limit, 0
    def read(self, size=-1):
        data = self.stream.read(CHUNK if size < 0 else min(size, CHUNK))
        self.count += len(data)
        require(self.count <= self.limit, "RAW_ARCHIVE_LIMIT")
        return data

def verify(directory, loaded, commit, expected_config, expected_receipt_hash, loaded_bytes=None):
    require(re.fullmatch(r"[0-9a-f]{40}", commit or ""), "INVALID_COMMIT")
    require(re.fullmatch(r"sha256:[0-9a-f]{64}", expected_config or ""), "INVALID_CONFIG_DIGEST")
    require(re.fullmatch(r"[0-9a-f]{64}", expected_receipt_hash or ""), "INVALID_RECEIPT_HASH")
    require(directory.is_absolute() and directory == directory.resolve(strict=True), "CANONICAL_PAYLOAD_DIRECTORY_REQUIRED")
    # Reuse the trusted source verifier, never executable bytes from the payload.
    checked = candidate.verify(directory, commit, expected_image=expected_config)
    build, build_hash = read_json(directory / "build-receipt.json")
    transfer, transfer_hash = read_json(directory / "transfer-manifest.json")
    require(transfer_hash == checked["manifestSha256"] and transfer["archive"]["sha256"] == checked["archiveSha256"], "TRANSFER_CHANGED")
    require(build_hash == expected_receipt_hash and transfer["evidence"]["build-receipt.json"]["sha256"] == build_hash, "ORIGINAL_BUILD_RECEIPT_MISMATCH")
    require(isinstance(loaded, dict), "LOADED_INSPECT_REQUIRED")
    config_id, runtime_id = build["imageId"], loaded["id"]
    require(config_id == expected_config and re.fullmatch(r"sha256:[0-9a-f]{64}", runtime_id or ""), "INVALID_DIGEST")
    require(runtime_id != config_id, "DISTINCT_MANIFEST_AND_CONFIG_REQUIRED")
    archive = transfer["archive"]
    archive_path = directory / archive["filename"]
    before = archive_path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_size == archive["bytes"], "ARCHIVE_CHANGED")
    require(0 < archive["uncompressedBytes"] <= MAX_RAW, "RAW_SIZE_LIMIT")
    config_name = "blobs/sha256/" + config_id[7:]
    manifest_name = "blobs/sha256/" + runtime_id[7:]
    wanted = {"manifest.json", "index.json", "oci-layout", config_name, manifest_name}
    payload, members, hashes, sizes = {}, set(), {}, {}
    with os.fdopen(os.open(archive_path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as archive_stream:
        require(fingerprint(os.fstat(archive_stream.fileno())) == fingerprint(before), "ARCHIVE_CHANGED")
        compressed_hash = hashlib.sha256()
        while data := archive_stream.read(CHUNK):
            compressed_hash.update(data)
        require(compressed_hash.hexdigest() == archive["sha256"], "ARCHIVE_MISMATCH")
        archive_stream.seek(0)
        with gzip.GzipFile(fileobj=archive_stream, mode="rb") as incoming:
            bounded = BoundedStream(incoming, archive["uncompressedBytes"])
            with tarfile.open(fileobj=bounded, mode="r|") as saved:
                for member in saved:
                    path = PurePosixPath(member.name)
                    require(len(members) < 4096 and member.name not in members, "DUPLICATE_OR_EXCESS_MEMBERS")
                    members.add(member.name)
                    require(not path.is_absolute() and ".." not in path.parts and member.name == path.as_posix() and (member.isfile() or member.isdir()), "UNSAFE_MEMBER")
                    if member.isdir():
                        require(member.name in ("blobs", "blobs/sha256"), "UNEXPECTED_DIRECTORY")
                        continue
                    require(member.name in ("manifest.json", "index.json", "oci-layout") or re.fullmatch(r"blobs/sha256/[0-9a-f]{64}", member.name), "UNEXPECTED_ARCHIVE_FILE")
                    require(0 <= member.size <= MAX_RAW, "MEMBER_SIZE")
                    keep = member.name in wanted
                    require(not keep or member.size <= MAX_JSON, "METADATA_TOO_LARGE")
                    stream, h, chunks, count = saved.extractfile(member), hashlib.sha256(), [], 0
                    while data := stream.read(CHUNK):
                        h.update(data)
                        count += len(data)
                        if keep:
                            chunks.append(data)
                    require(count == member.size, "TRUNCATED_MEMBER")
                    actual = "sha256:" + h.hexdigest()
                    hashes[member.name], sizes[member.name] = actual, count
                    if member.name.startswith("blobs/sha256/"):
                        require(member.name == "blobs/sha256/" + h.hexdigest(), "BLOB_DIGEST_MISMATCH")
                    if keep:
                        payload[member.name] = b"".join(chunks)
            while bounded.read(CHUNK):
                pass
            require(bounded.count == archive["uncompressedBytes"], "RAW_SIZE_MISMATCH")
        require(fingerprint(os.fstat(archive_stream.fileno())) == fingerprint(before), "ARCHIVE_CHANGED")
    require(wanted <= payload.keys(), "MISSING_METADATA")
    index, saved = json.loads(payload["index.json"]), json.loads(payload["manifest.json"])
    manifest, config = json.loads(payload[manifest_name]), json.loads(payload[config_name])
    require(json.loads(payload["oci-layout"])["imageLayoutVersion"] == "1.0.0", "OCI_LAYOUT")
    require(index["schemaVersion"] == 2 and len(index["manifests"]) == 1, "ONE_OCI_IMAGE_REQUIRED")
    target = index["manifests"][0]
    require(target["digest"] == runtime_id and target["size"] == sizes[manifest_name], "OCI_TARGET_MISMATCH")
    require(target["mediaType"] == manifest["mediaType"] and manifest["schemaVersion"] == 2, "MANIFEST_TYPE")
    require(manifest["mediaType"] in ("application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"), "UNSUPPORTED_MANIFEST")
    require(manifest["config"]["mediaType"] in ("application/vnd.oci.image.config.v1+json", "application/vnd.docker.container.image.v1+json") and manifest["config"]["digest"] == config_id and manifest["config"]["size"] == sizes[config_name], "CONFIG_DESCRIPTOR")
    require(isinstance(saved, list) and len(saved) == 1 and saved[0]["Config"] == config_name, "DOCKER_CONFIG_MISMATCH")
    require(config["os"] == loaded["os"] == "linux" and config["architecture"] == loaded["architecture"] == "amd64", "PLATFORM_MISMATCH")
    require(config["created"] == loaded["created"] == build["imageCreatedAt"], "CREATED_MISMATCH")
    require(config["config"]["Labels"]["org.opencontainers.image.revision"] == loaded["revision"] == commit, "REVISION_MISMATCH")
    require([x for x in config["config"]["Env"] if x.startswith("RELEASE_COMMIT=")] == ["RELEASE_COMMIT=" + commit] and loaded["releaseCommit"] == commit, "RELEASE_ENV_MISMATCH")
    require(config["rootfs"]["type"] == loaded["rootfs"]["type"] == "layers", "ROOTFS_TYPE")
    diff_ids = config["rootfs"]["diff_ids"]
    require(diff_ids == loaded["rootfs"]["diff_ids"], "LOADED_ROOTFS_MISMATCH")
    layers = manifest["layers"]
    require(0 < len(layers) == len(diff_ids) <= 128, "LAYER_COUNT_MISMATCH")
    paths = ["blobs/sha256/" + layer["digest"].split(":")[1] for layer in layers]
    require(saved[0]["Layers"] == paths, "LAYER_ORDER_MISMATCH")
    proof = []
    for n, (layer, name, diff_id) in enumerate(zip(layers, paths, diff_ids)):
        require(layer["mediaType"] in ("application/vnd.oci.image.layer.v1.tar", "application/vnd.docker.image.rootfs.diff.tar"), "UNSUPPORTED_COMPRESSED_LAYER")
        require(hashes.get(name) == layer["digest"] == diff_id and sizes[name] == layer["size"], "LAYER_BYTES_OR_DIFFID_MISMATCH")
        proof.append({"index": n, "blobDigest": layer["digest"], "bytes": layer["size"], "rootfsDiffId": diff_id})
    return {"schema": 1, "status": "PASS_ARCHIVE_TO_RUNTIME_IDENTITY", "verifiedAt": datetime.now(timezone.utc).isoformat(),
            "sourceCommit": commit, "sourceArchiveSha256": build["sourceArchiveSha256"], "imageCreatedAt": config["created"],
            "legacyConfigDigest": config_id, "runtimeManifestDigest": runtime_id,
            "archiveSha256": archive["sha256"], "buildReceiptSha256": build_hash, "transferManifestSha256": transfer_hash,
            "loadedProjectionSha256": sha(loaded_bytes if loaded_bytes is not None else json.dumps(loaded, sort_keys=True).encode()),
            "layerCount": len(layers), "layers": proof, "loadedRootfsMatches": True,
            "imageExecuted": False, "originalReceiptsModified": False}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--expected-config-digest", required=True)
    parser.add_argument("--expected-build-receipt-sha256", required=True)
    args = parser.parse_args()
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024**2, 512 * 1024**2))
    resource.setrlimit(resource.RLIMIT_CPU, (90, 90))
    raw = sys.stdin.buffer.read(128 * 1024 + 1)
    require(len(raw) <= 128 * 1024, "LOADED_INSPECT_TOO_LARGE")
    result = verify(args.directory, json.loads(raw), args.source_commit,
                    args.expected_config_digest, args.expected_build_receipt_sha256, raw)
    print(json.dumps(result, separators=(",", ":")))

if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, IndexError, AttributeError, tarfile.TarError, EOFError):
        raise SystemExit("IMAGE_IDENTITY_BRIDGE_REFUSED: immutable archive and loaded image did not verify")
