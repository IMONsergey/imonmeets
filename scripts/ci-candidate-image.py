#!/usr/bin/env python3
"""Export an already tested CI image, or verify its bounded transfer payload.

No image build, Docker load, deployment, credential/configuration transfer, or
release mutation is implemented here. The publisher executes this source from
a fresh exact-commit checkout, never executable files from the artifact.
"""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile

REPOSITORY = "IMONsergey/imonmeets"
RELEASE_REF = "refs/heads/release/edge-transport-acme-20261103"
MAX_ARCHIVE = 768 * 1024**2
MAX_RAW = 2 * 1024**3
MAX_JSON = 5 * 1024**2
INVENTORY_FILES = {
    "installed-npm-tree.json": "installedTreeSha256",
    "installed-npm-inventory.json": "inventorySha256",
    "dependency-lock-sbom.cdx.json": "lockSbomSha256",
    "runtime-npm-sbom.cdx.json": "runtimeSbomSha256",
}
EVIDENCE = ("build-receipt.json", "inventory-receipt.json", *INVENTORY_FILES)


def require(value, code):
    if not value:
        raise ValueError(code)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def source(value):
    require(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{40}", value), "INVALID_SOURCE_COMMIT")
    return value


def regular(path, maximum):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= maximum, "INVALID_PAYLOAD_FILE")
    return info.st_size


def file_hash(path, maximum):
    size = regular(path, maximum)
    digest = hashlib.sha256()
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        require(before.st_size == size, "PAYLOAD_FILE_CHANGED")
        total = 0
        while chunk := stream.read(1024 * 1024):
            total += len(chunk)
            require(total <= maximum, "PAYLOAD_FILE_TOO_LARGE")
            digest.update(chunk)
        after = os.fstat(stream.fileno())
        require(total == size and before.st_size == after.st_size and before.st_mtime_ns == after.st_mtime_ns,
                "PAYLOAD_FILE_CHANGED")
    return {"bytes": size, "sha256": digest.hexdigest()}


def read_json(path):
    regular(path, MAX_JSON)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        raw = stream.read(MAX_JSON + 1)
    require(len(raw) <= MAX_JSON, "JSON_TOO_LARGE")
    value = json.loads(raw)
    require(isinstance(value, dict), "JSON_OBJECT_REQUIRED")
    return value


def receipts(directory, commit):
    build = read_json(directory / "build-receipt.json")
    inventory = read_json(directory / "inventory-receipt.json")
    require(build.get("sourceCommit") == commit and inventory.get("sourceCommit") == commit,
            "EVIDENCE_SOURCE_MISMATCH")
    require(isinstance(build.get("imageId"), str) and re.fullmatch(r"sha256:[0-9a-f]{64}", build["imageId"]),
            "INVALID_IMAGE_ID")
    require(re.fullmatch(r"[0-9a-f]{64}", build.get("sourceArchiveSha256", "")), "INVALID_SOURCE_ARCHIVE_HASH")
    require(build.get("productionChanges") is False and build.get("deployed") is False and
            inventory.get("productionChanges") is False and inventory.get("deployed") is False,
            "CANDIDATE_ONLY_EVIDENCE_REQUIRED")
    require(inventory.get("status") == "PASS_RUNTIME_NPM_INVENTORY", "RUNTIME_INVENTORY_NOT_ACCEPTED")
    for name, key in INVENTORY_FILES.items():
        require(file_hash(directory / name, MAX_JSON)["sha256"] == inventory.get(key), "INVENTORY_HASH_MISMATCH")
    return build, inventory


def ci_context():
    require(os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("GITHUB_EVENT_NAME") == "push" and
            os.environ.get("GITHUB_REPOSITORY") == REPOSITORY and os.environ.get("GITHUB_REF") == RELEASE_REF,
            "AUTHORIZED_CI_PUSH_REQUIRED")
    require(all(re.fullmatch(r"[1-9][0-9]*", os.environ.get(k, "")) for k in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT")),
            "CI_RUN_IDENTITY_REQUIRED")
    return {"repository": REPOSITORY, "runId": os.environ["GITHUB_RUN_ID"],
            "runAttempt": os.environ["GITHUB_RUN_ATTEMPT"]}


def check_saved_image(raw_archive, commit, image_id):
    """Read metadata without extracting the Docker archive or running its image."""
    regular(raw_archive, MAX_RAW)
    with tarfile.open(raw_archive, "r:") as archive:
        members = archive.getmembers()
        require(len(members) <= 4096 and len({m.name for m in members}) == len(members), "INVALID_SAVE_MEMBERS")
        for member in members:
            path = PurePosixPath(member.name)
            require(not path.is_absolute() and ".." not in path.parts and (member.isfile() or member.isdir()),
                    "UNSAFE_SAVE_MEMBER")
        manifest_member = archive.getmember("manifest.json")
        require(manifest_member.isfile() and 0 < manifest_member.size <= MAX_JSON, "INVALID_SAVE_MANIFEST")
        saved = json.load(archive.extractfile(manifest_member))
        require(isinstance(saved, list) and len(saved) == 1 and isinstance(saved[0], dict), "ONE_SAVED_IMAGE_REQUIRED")
        config_name = saved[0].get("Config")
        require(isinstance(config_name, str), "INVALID_SAVE_CONFIG")
        config_member = archive.getmember(config_name)
        require(config_member.isfile() and 0 < config_member.size <= MAX_JSON, "INVALID_SAVE_CONFIG")
        config_bytes = archive.extractfile(config_member).read(MAX_JSON + 1)
        require("sha256:" + sha256(config_bytes) == image_id, "SAVED_IMAGE_ID_MISMATCH")
        config = json.loads(config_bytes)
        require(config.get("os") == "linux" and config.get("architecture") == "amd64", "LINUX_AMD64_IMAGE_REQUIRED")
        require(config.get("config", {}).get("Labels", {}).get("org.opencontainers.image.revision") == commit,
                "SAVED_IMAGE_SOURCE_MISMATCH")
        env = config.get("config", {}).get("Env", [])
        require([x for x in env if x.startswith("RELEASE_COMMIT=")] == ["RELEASE_COMMIT=" + commit],
                "SAVED_IMAGE_SOURCE_ENV_MISMATCH")
        layers = saved[0].get("Layers")
        require(isinstance(layers, list) and 0 < len(layers) <= 128 and
                all(isinstance(name, str) and archive.getmember(name).isfile() for name in layers),
                "INVALID_SAVED_LAYERS")


def write_json(path, value):
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write("\n")


def verify(directory, commit, *, expected_manifest=None, expected_archive=None, expected_image=None, expected_ci=None):
    source(commit)
    name = "imonmeets-app-" + commit + ".tar.gz"
    require(not directory.is_symlink() and directory.is_dir(), "PAYLOAD_DIRECTORY_REQUIRED")
    expected_names = {*EVIDENCE, name, "transfer-manifest.json", "SHA256SUMS"}
    require({p.name for p in directory.iterdir()} == expected_names, "UNEXPECTED_PAYLOAD_FILES")
    manifest_hash = file_hash(directory / "transfer-manifest.json", MAX_JSON)["sha256"]
    require(expected_manifest is None or manifest_hash == expected_manifest, "TRANSFER_MANIFEST_HASH_MISMATCH")
    manifest = read_json(directory / "transfer-manifest.json")
    require(set(manifest) == {"schema", "status", "sourceCommit", "imageId", "platform", "archive", "evidence", "ci", "productionChanges", "deployed"},
            "INVALID_TRANSFER_SCHEMA")
    require(manifest["schema"] == 1 and manifest["status"] == "EXPORTED_CANDIDATE_NOT_DEPLOYED" and
            manifest["sourceCommit"] == commit and manifest["platform"] == "linux/amd64" and
            manifest["productionChanges"] is False and manifest["deployed"] is False, "INVALID_TRANSFER_IDENTITY")
    build, _ = receipts(directory, commit)
    require(manifest["imageId"] == build["imageId"] and (expected_image is None or manifest["imageId"] == expected_image),
            "TRANSFER_IMAGE_ID_MISMATCH")
    ci = manifest["ci"]
    require(isinstance(ci, dict) and set(ci) == {"repository", "runId", "runAttempt"} and
            ci["repository"] == REPOSITORY and all(isinstance(ci[k], str) and re.fullmatch(r"[1-9][0-9]*", ci[k]) for k in ("runId", "runAttempt")),
            "INVALID_TRANSFER_CI_IDENTITY")
    require(expected_ci is None or ci == expected_ci, "TRANSFER_CI_IDENTITY_MISMATCH")
    actual = file_hash(directory / name, MAX_ARCHIVE)
    a = manifest["archive"]
    require(isinstance(a, dict) and set(a) == {"filename", "bytes", "sha256", "uncompressedBytes", "format"} and
            a["filename"] == name and a["format"] == "docker-save+gzip" and
            type(a["uncompressedBytes"]) is int and 0 < a["uncompressedBytes"] <= MAX_RAW and
            a["bytes"] == actual["bytes"] and a["sha256"] == actual["sha256"], "ARCHIVE_HASH_OR_SIZE_MISMATCH")
    require(expected_archive is None or actual["sha256"] == expected_archive, "EXPECTED_ARCHIVE_HASH_MISMATCH")
    require(isinstance(manifest["evidence"], dict) and set(manifest["evidence"]) == set(EVIDENCE), "INVALID_EVIDENCE_SET")
    for item in EVIDENCE:
        require(manifest["evidence"][item] == file_hash(directory / item, MAX_JSON), "TRANSFER_EVIDENCE_HASH_MISMATCH")
    sums = "".join(file_hash(directory / item, MAX_ARCHIVE if item == name else MAX_JSON)["sha256"] + "  " + item + "\n"
                   for item in sorted(expected_names - {"SHA256SUMS"}))
    regular(directory / "SHA256SUMS", MAX_JSON)
    require((directory / "SHA256SUMS").read_text() == sums, "CHECKSUM_LIST_MISMATCH")
    return {"status": "PASS_CANDIDATE_IMAGE_TRANSFER", "sourceCommit": commit, "imageId": manifest["imageId"],
            "archiveSha256": actual["sha256"], "manifestSha256": manifest_hash, "deployed": False}


def export(build_path, inventory_dir, output, commit):
    ci = ci_context()
    require(commit == os.environ.get("GITHUB_SHA"), "CI_SOURCE_MISMATCH")
    source(commit)
    require(output.is_absolute() and not output.exists(), "NEW_ABSOLUTE_OUTPUT_REQUIRED")
    require(shutil.disk_usage(output.parent).free >= MAX_RAW + MAX_ARCHIVE + 512 * 1024**2, "EXPORT_DISK_HEADROOM_REQUIRED")
    output.mkdir(mode=0o700)
    os.umask(0o077)
    for name, original in [("build-receipt.json", build_path), *((n, inventory_dir / n) for n in EVIDENCE if n != "build-receipt.json")]:
        regular(original, MAX_JSON)
        shutil.copyfile(original, output / name, follow_symlinks=False)
    build, _ = receipts(output, commit)
    image_id = build["imageId"]
    require(shutil.which("prlimit"), "FILE_LIMIT_TOOL_REQUIRED")
    # Apply the bound after sudo, so sudo policy cannot reset an inherited limit.
    docker = ["sudo", "-n", "prlimit", "--fsize=" + str(MAX_RAW) + ":" + str(MAX_RAW), "--", "docker"]
    # Save by the accepted immutable ID, not the mutable local build tag.
    with tempfile.TemporaryDirectory(prefix="imon-image-export-", dir=output.parent) as temporary:
        raw = Path(temporary) / "image.tar"
        with raw.open("xb") as archive, (Path(temporary) / "docker-save.log").open("xb") as log:
            subprocess.run(docker + ["save", image_id], stdout=archive, stderr=log, check=True, timeout=300)
        check_saved_image(raw, commit, image_id)
        name = "imonmeets-app-" + commit + ".tar.gz"
        with raw.open("rb") as incoming, (output / name).open("xb") as outgoing:
            with gzip.GzipFile(filename="", mode="wb", fileobj=outgoing, compresslevel=3, mtime=0) as compressed:
                while chunk := incoming.read(1024 * 1024):
                    compressed.write(chunk)
                    require(outgoing.tell() <= MAX_ARCHIVE, "COMPRESSED_ARCHIVE_TOO_LARGE")
        archive = {**file_hash(output / name, MAX_ARCHIVE), "filename": name, "format": "docker-save+gzip", "uncompressedBytes": raw.stat().st_size}
    manifest = {"schema": 1, "status": "EXPORTED_CANDIDATE_NOT_DEPLOYED", "sourceCommit": commit,
                "imageId": image_id, "platform": "linux/amd64", "archive": archive,
                "evidence": {n: file_hash(output / n, MAX_JSON) for n in EVIDENCE}, "ci": ci,
                "productionChanges": False, "deployed": False}
    write_json(output / "transfer-manifest.json", manifest)
    sums = "".join(file_hash(p, MAX_ARCHIVE if p.name == name else MAX_JSON)["sha256"] + "  " + p.name + "\n"
                   for p in sorted(output.iterdir()))
    (output / "SHA256SUMS").write_text(sums)
    result = verify(output, commit, expected_ci=ci)
    destination = os.environ.get("GITHUB_OUTPUT")
    if destination:
        with open(destination, "a", encoding="utf-8") as stream:
            for key, value in {"manifest_sha256": result["manifestSha256"], "archive_sha256": result["archiveSha256"], "image_id": image_id}.items():
                stream.write(key + "=" + value + "\n")
    return result


def require_release_absent(commit):
    ci_context()
    require(commit == os.environ.get("GITHUB_SHA"), "CI_SOURCE_MISMATCH")
    tag = "candidate-" + source(commit)
    for suffix in ("releases/tags/" + tag, "git/ref/tags/" + tag):
        response = subprocess.run(["gh", "api", "--include", "repos/" + REPOSITORY + "/" + suffix],
                                  capture_output=True, text=True, timeout=30)
        status = re.search(r"^HTTP/\S+\s+(\d{3})\b", response.stdout, re.MULTILINE)
        require(response.returncode != 0 and status and status.group(1) == "404", "EXISTING_RELEASE_TAG_OR_API_UNCERTAINTY")
    return {"status": "RELEASE_AND_TAG_ABSENT", "tag": tag, "mutationPerformed": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("export", "verify", "check-release-absent"))
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--directory", type=Path)
    parser.add_argument("--build-receipt", type=Path)
    parser.add_argument("--inventory-directory", type=Path)
    parser.add_argument("--expected-manifest-sha256")
    parser.add_argument("--expected-archive-sha256")
    parser.add_argument("--expected-image-id")
    parser.add_argument("--notes-file", type=Path)
    args = parser.parse_args()
    if args.action == "export":
        require(args.directory and args.build_receipt and args.inventory_directory, "EXPORT_ARGUMENTS_REQUIRED")
        result = export(args.build_receipt, args.inventory_directory, args.directory, args.source_commit)
    elif args.action == "verify":
        require(args.directory, "PAYLOAD_DIRECTORY_REQUIRED")
        result = verify(args.directory, args.source_commit, expected_manifest=args.expected_manifest_sha256,
                        expected_archive=args.expected_archive_sha256, expected_image=args.expected_image_id,
                        expected_ci=ci_context() if os.environ.get("GITHUB_ACTIONS") == "true" else None)
        if args.notes_file:
            with args.notes_file.open("x", encoding="utf-8") as notes:
                notes.write("# IMON Meets candidate\n\nSource: `" + args.source_commit + "`\n\nImage ID: `" + result["imageId"] +
                            "`\n\nArchive SHA256: `" + result["archiveSha256"] +
                            "`\n\nThis is a tested CI candidate, not a deployment or commercial-launch approval. "
                            "No production configuration or credentials are included. The Docker image ID, image archive checksum, "
                            "and GitHub artifact ZIP digest identify different objects. Verify the transfer manifest before import; "
                            "production migration, witness enrollment and external acceptance remain separate operations.\n")
    else:
        result = require_release_absent(args.source_commit)
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError, tarfile.TarError):
        # CLI/API/JSON errors can contain untrusted text. Keep public logs fixed.
        raise SystemExit("Candidate image transfer failed; no deployment or release mutation was performed by this script")
