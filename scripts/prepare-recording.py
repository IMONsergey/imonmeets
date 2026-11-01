#!/usr/bin/env python3
"""Prepare private recording config. Does not start services or enable capture."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import secrets
import stat
import tempfile
from urllib.parse import urlsplit

BUCKET = "imon-recordings"
PRIVATE_ENDPOINT = "http://recording-storage:8333"
MIN_FILESYSTEM_BYTES = 512 * 1024 * 1024
MAX_FILESYSTEM_BYTES = 1181116006  # 1.1 GiB, including filesystem overhead


def read_env(path: Path) -> tuple[str, dict[str, str]]:
    if path.is_symlink():
        raise ValueError("The environment file must not be a symlink")
    original = path.read_text()
    result: dict[str, str] = {}
    for raw in original.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        match = re.fullmatch(r"([A-Z_][A-Z_0-9]*)=(.*)", line)
        if not match:
            raise ValueError("The environment file contains an unsupported line")
        key, value = match.groups()
        if key in result:
            raise ValueError(f"Duplicate environment setting: {key}")
        value = value.strip()
        if value.startswith('"'):
            value = json.loads(value)
        elif value.startswith("'") and value.endswith("'"):
            value = value[1:-1]
        else:
            value = re.split(r"\s+#", value, maxsplit=1)[0].rstrip()
        if not isinstance(value, str):
            raise ValueError(f"Invalid environment setting: {key}")
        result[key] = value
    return original, result


def https_origin(value: str) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
        or not re.fullmatch(r"[a-zA-Z0-9.-]+", parsed.hostname)
    ):
        raise ValueError("The public S3 endpoint must be an HTTPS origin without a path")
    parsed.port  # Reject malformed or out-of-range ports.
    return value.rstrip("/")


def validate_storage(path: Path) -> None:
    if path.is_symlink() or not path.is_dir() or not path.is_mount():
        raise ValueError("Recording data must be an existing dedicated mountpoint")
    data = os.statvfs(path)
    capacity = data.f_blocks * data.f_frsize
    if not MIN_FILESYSTEM_BYTES <= capacity <= MAX_FILESYSTEM_BYTES:
        raise ValueError("Recording filesystem must have a hard capacity of 512 MiB to 1.1 GiB")
    if not re.fullmatch(r"/[A-Za-z0-9_./-]+", str(path)):
        raise ValueError("Recording data path must be an absolute path without shell metacharacters")


def new_credentials() -> dict:
    return {
        "version": 1,
        "bucket": BUCKET,
        "app": {"accessKey": "IMONAPP" + secrets.token_hex(10).upper(), "secretKey": secrets.token_urlsafe(48)},
        "admin": {"accessKey": "IMONADMIN" + secrets.token_hex(10).upper(), "secretKey": secrets.token_urlsafe(48)},
    }


def validate_credentials(value: dict) -> None:
    if value.get("version") != 1 or value.get("bucket") != BUCKET:
        raise ValueError("Unsupported recording credentials file")
    for role in ("app", "admin"):
        credentials = value.get(role, {})
        if not re.fullmatch(r"[A-Z0-9]{20,64}", credentials.get("accessKey", "")):
            raise ValueError("Invalid stored recording access key")
        if not re.fullmatch(r"[A-Za-z0-9_-]{48,128}", credentials.get("secretKey", "")):
            raise ValueError("Invalid stored recording secret")
    if value["app"]["accessKey"] == value["admin"]["accessKey"] or value["app"]["secretKey"] == value["admin"]["secretKey"]:
        raise ValueError("Application and bootstrap identities must be distinct")


def s3_config(credentials: dict) -> dict:
    validate_credentials(credentials)
    account = {"id": "imon-recordings-account", "displayName": "IMON Meets recordings"}
    return {
        "accounts": [account],
        "identities": [
            {"name": "imon-recordings-bootstrap", "account": account, "credentials": [credentials["admin"]], "actions": ["Admin"]},
            {"name": "imon-recordings-app", "account": account, "credentials": [credentials["app"]], "actions": [f"Read:{BUCKET}", f"Write:{BUCKET}", f"List:{BUCKET}"]},
        ],
    }


def render_egress(template: str, env: dict[str, str]) -> str:
    key = env.get("LIVEKIT_API_KEY", "")
    secret = env.get("LIVEKIT_API_SECRET", "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", key) or not re.fullmatch(r"[A-Za-z0-9_+/=-]{32,256}", secret):
        raise ValueError("Set valid LIVEKIT_API_KEY and a strong LIVEKIT_API_SECRET first")
    result = template
    for name, value in (("LIVEKIT_API_KEY", key), ("LIVEKIT_API_SECRET", secret)):
        marker = f'"__{name}__"'
        if result.count(marker) != 1:
            raise ValueError("The public Egress template has unexpected placeholders")
        result = result.replace(marker, json.dumps(value))
    return result


def environment_values(credentials: dict, storage: Path, public: str, current: dict[str, str]) -> dict[str, str]:
    # Existing credentials are never silently replaced. Re-running uses the
    # same persisted identity, keeping already issued 60-second URLs valid.
    expected = {
        "S3_BUCKET": BUCKET,
        "S3_ENDPOINT": PRIVATE_ENDPOINT,
        "S3_ACCESS_KEY_ID": credentials["app"]["accessKey"],
        "S3_SECRET_ACCESS_KEY": credentials["app"]["secretKey"],
    }
    if any(current.get(key) and current[key] != value for key, value in expected.items()):
        raise ValueError("Existing S3 settings belong to another configuration; refusing to replace them")
    return {
        **expected,
        "S3_REGION": "us-east-1",
        "S3_PUBLIC_ENDPOINT": https_origin(public),
        "S3_FORCE_PATH_STYLE": "true",
        "RECORDING_DATA_PATH": str(storage),
        "RECORDING_RETENTION_DAYS": "3",
        "MAX_ACTIVE_RECORDINGS": "1",
        "RECORDING_ENABLED": "true" if current.get("RECORDING_ENABLED") == "true" else "false",
    }


def merge_environment(original: str, values: dict[str, str]) -> str:
    remaining = dict(values)
    lines = []
    for line in original.splitlines():
        match = re.fullmatch(r"\s*([A-Z_][A-Z_0-9]*)=.*", line)
        if match and match.group(1) in values:
            name = match.group(1)
            lines.append(f"{name}={remaining.pop(name)}")
        else:
            lines.append(line)
    if remaining:
        lines.append("# Private recording deployment, prepared locally without enabling capture")
        lines.extend(f"{key}={value}" for key, value in remaining.items())
    return "\n".join(lines) + "\n"


def atomic_private_write(path: Path, contents: str, uid: int, gid: int, mode: int = 0o600) -> None:
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise ValueError("Refusing a symlink or non-file private destination")
    fd, tmp = tempfile.mkstemp(prefix=".recording-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            os.fchmod(stream.fileno(), mode)
            os.fchown(stream.fileno(), uid, gid)
            stream.write(contents)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--storage-path", type=Path, default=Path("/home/sergey/.local/share/imonmeets-recordings"))
    parser.add_argument("--public-endpoint", required=True)
    parser.add_argument("--apply-env", action="store_true", help="Atomically merge app settings into .env; capture stays disabled until separately accepted")
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise ValueError("Run as root to set container-specific ownership of private files")
    root = Path(__file__).resolve().parent.parent
    env_path = args.env_file or root / ".env"
    original, env = read_env(env_path)
    validate_storage(args.storage_path)
    public = https_origin(args.public_endpoint)
    private = root / "deploy" / "recording-private"
    if private.is_symlink() or (private.exists() and not private.is_dir()):
        raise ValueError("Private configuration path must be a real directory")
    private.mkdir(mode=0o700, exist_ok=True)
    private.chmod(0o700)
    os.chown(private, 0, 0)
    credentials_path = private / "credentials.json"
    if credentials_path.is_symlink():
        raise ValueError("Private credentials must not be a symlink")
    credentials = json.loads(credentials_path.read_text()) if credentials_path.exists() else new_credentials()
    validate_credentials(credentials)
    egress = render_egress((root / "deploy" / "egress.yaml").read_text(), env)
    values = environment_values(credentials, args.storage_path, public, env)
    config = s3_config(credentials)
    # All validation happens before any identity or application setting changes.
    atomic_private_write(credentials_path, json.dumps(credentials, indent=2) + "\n", 0, 0)
    atomic_private_write(private / "admin.json", json.dumps({**credentials["admin"], "bucket": BUCKET, "endpoint": PRIVATE_ENDPOINT, "region": "us-east-1"}, indent=2) + "\n", 0, 0)
    atomic_private_write(private / "s3.json", json.dumps(config, indent=2) + "\n", 1000, 1000, 0o400)
    atomic_private_write(private / "egress.yaml", egress, 1001, 0, 0o400)
    atomic_private_write(private / "recording.env", "".join(f"{key}={value}\n" for key, value in values.items()), 0, 0)
    os.chown(args.storage_path, 1000, 1000)
    args.storage_path.chmod(0o700)
    if args.apply_env:
        owner = env_path.stat()
        atomic_private_write(env_path, merge_environment(original, values), owner.st_uid, owner.st_gid)
    print("Prepared private recording configuration. No credentials printed. Services were not started; capture was not enabled.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, json.JSONDecodeError):
        # Do not echo malformed environment/config values or their source lines.
        raise SystemExit("Recording preparation failed. Check mount size, file permissions, required LiveKit keys, public endpoint, and existing S3 configuration.")
