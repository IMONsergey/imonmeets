#!/usr/bin/env python3
"""Validate immutable official image references without pulling/building images."""
import argparse
import json
import os
import re


def validate_images(values, summary=False):
    python = values.get("PYTHON_IMAGE", "")
    if not re.fullmatch(r"(?:docker\.io/library/)?python(?::[A-Za-z0-9_.-]+)?@sha256:[a-f0-9]{64}", python):
        raise ValueError("PYTHON_IMAGE must be an official Python image pinned by digest")
    if summary and not re.fullmatch(r"ghcr\.io/ggml-org/llama\.cpp(?::server[A-Za-z0-9_.-]*)?@sha256:[a-f0-9]{64}", values.get("LLAMA_SERVER_IMAGE", "")):
        raise ValueError("LLAMA_SERVER_IMAGE must be an official ggml-org server image pinned by digest")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--summary", action="store_true")
    args = parser.parse_args()
    try:
        validate_images(os.environ, summary=args.summary)
    except ValueError as error:
        raise SystemExit(str(error))
    print(json.dumps({"imageReferenceGate": "pass", "registryResolution": "not-performed", "imagesBuilt": False}))
