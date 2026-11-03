"""Record changes made by fixture-only Alpine dependencies; never hide upgrades."""

import datetime
import hashlib
import json
from pathlib import Path
import ssl
import subprocess


ROOT = Path("/fixture-provenance")


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def manifest(path):
    return {name: checksum for checksum, name in (line.split(maxsplit=1) for line in path.read_text().splitlines())}


def version(command):
    return subprocess.check_output(command, text=True).strip()


original_binary = manifest(ROOT / "base-haproxy.sha256")
current_binary = {name: sha256(Path(name)) for name in original_binary}
if current_binary != original_binary:
    raise SystemExit("BASE_HAPROXY_BINARY_CHANGED")
original_libraries = manifest(ROOT / "base-library-files.sha256")
current_libraries = {
    name: sha256(Path(name)) if Path(name).is_file() else None
    for name in original_libraries
}
changed_libraries = {
    name: {"before": before, "after": current_libraries[name]}
    for name, before in original_libraries.items()
    if current_libraries[name] != before
}
receipt = {
    "schema": 1,
    "status": "FIXTURE_DERIVATIVE_NOT_DEPLOYMENT_IMAGE",
    "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "declaredBaseImage": "haproxy:3.0-alpine@sha256:f06f6cc1c25c7071e62d955d8e67a33d6935066ced8fac496cdd0ad9ffdd17f3",
    "baseHaproxyBinaryUnchanged": True,
    "haproxyBinarySha256": current_binary,
    "baseLibraryFileCount": len(original_libraries),
    "baseLibraryFilesChanged": changed_libraries,
    "baseLibraryManifestSha256": sha256(ROOT / "base-library-files.sha256"),
    "fixtureDependencies": ["python3", "openssl", "nodejs"],
    "nodeVersion": version(["node", "--version"]),
    "opensslVersion": version(["openssl", "version"]),
    "pythonOpenSsl": ssl.OPENSSL_VERSION,
    "haproxyVersion": version(["haproxy", "-vv"]),
    "fixtureHaproxyRuntimeAccepted": False,
    "deployedImageAccepted": False,
}
(ROOT / "image-provenance.json").write_text(json.dumps(receipt, indent=2) + "\n")
