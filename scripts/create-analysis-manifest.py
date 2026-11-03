#!/usr/bin/env python3
"""Offline inventory of already obtained model files. Does not select/download models."""
import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "analysis-worker"))
from provenance import inventory, plain_path, read_digest, relative_path, REQUIRED_WHISPER


def create_manifest(root, whisper, summary=None):
    root = plain_path(root)
    directory = plain_path(root / relative_path(whisper))
    names = inventory(directory)
    if not REQUIRED_WHISPER <= names:
        raise RuntimeError("Whisper model, config and local tokenizer are required")
    files = []
    for name in sorted(names):
        measured, info = read_digest(directory / name)
        files.append({"path": name, "sha256": measured, "bytes": info[2]})
    result = {"schema": 1, "whisper": {"directory": whisper, "files": files}, "summary": None}
    if summary:
        relative_path(summary)
        path = plain_path(root / summary)
        measured, info = read_digest(path)
        with path.open("rb") as stream:
            if info[2] < 24 or stream.read(4) != b"GGUF":
                raise RuntimeError("Summary artifact must be a GGUF file")
        result["summary"] = {"path": summary, "sha256": measured, "bytes": info[2]}
    return (json.dumps(result, indent=2, sort_keys=True) + "\n").encode()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--whisper", required=True, help="relative directory containing complete local Whisper files")
    parser.add_argument("--summary", help="relative GGUF filename; omit for transcription only")
    args = parser.parse_args()
    raw = create_manifest(args.models, args.whisper, args.summary)
    output = plain_path(args.models) / "analysis-manifest.json"
    # Never replace a manifest of an existing release.
    with output.open("xb") as target:
        target.write(raw)
        target.flush()
        os.fsync(target.fileno())
    print(json.dumps({"manifestSha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw), "downloads": False}))
