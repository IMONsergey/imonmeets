#!/usr/bin/env python3
"""Build an immutable candidate from a clean Git archive with bounded RUN steps.

Uses the installed legacy builder explicitly. No production containers, settings,
DNS, credentials or databases are read or changed. A receipt is not deployment.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import uuid


def command(args, cwd=None, timeout=30):
    return subprocess.run(args, cwd=cwd, check=True, capture_output=True,
                          text=True, timeout=timeout).stdout.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True)
    options = parser.parse_args()
    source = Path(__file__).resolve().parents[1]
    commit = command(["git", "rev-parse", "HEAD"], cwd=source)
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise RuntimeError("Expected a full Git commit")
    if command(["git", "status", "--porcelain"], cwd=source):
        raise RuntimeError("Commit all candidate source changes before building")
    output = Path(options.output_dir).resolve()
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    os.chmod(output, 0o700)
    scope = "imonmeets-candidate-" + uuid.uuid4().hex
    docker = ["sudo", "-n", "docker"]
    tag = "imonmeets-app:candidate-" + commit
    log_path = output / "build.log"
    started = datetime.now(timezone.utc).isoformat()
    observed = {}
    process = None

    def owned_containers():
        ids = command(docker + ["ps", "-aq", "--filter", "label=world.imon.build.scope=" + scope])
        return ids.splitlines() if ids else []

    def cleanup_owned():
        for container in owned_containers():
            command(docker + ["rm", "-f", container])

    try:
        with tempfile.TemporaryDirectory(prefix="imonmeets-build-") as temp:
            work = Path(temp)
            archive = work / "source.tar"
            context = work / "context"
            context.mkdir(mode=0o700)
            command(["git", "archive", "--format=tar", "--output=" + str(archive), commit], cwd=source)
            archive_hash = hashlib.sha256(archive.read_bytes()).hexdigest()
            # Only a local, clean, committed repository is archived. Ignored and
            # untracked private deployment files never enter the Docker context.
            command(["tar", "-xf", str(archive), "-C", str(context)])
            if (context / ".env").exists() or (context / ".git").exists():
                raise RuntimeError("Unexpected private metadata in source archive")
            args = ["sudo", "-n", "env", "DOCKER_BUILDKIT=0", "docker", "build",
                    "--cpu-period=100000", "--cpu-quota=100000",
                    "--memory=2g", "--memory-swap=2g", "--force-rm",
                    "--build-arg", "VCS_REF=" + commit,
                    "--build-arg", "BUILD_SCOPE=" + scope,
                    "--iidfile", str(output / "image-id.txt"),
                    "--tag", tag, str(context)]
            with log_path.open("x") as log:
                os.chmod(log_path, 0o600)
                process = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT)
                deadline = time.monotonic() + 900
                while process.poll() is None:
                    if time.monotonic() >= deadline:
                        raise RuntimeError("Candidate build exceeded the 15 minute deadline")
                    for container in owned_containers():
                        if container in observed:
                            continue
                        try:
                            info = json.loads(command(docker + ["inspect", container]))[0]
                        except subprocess.CalledProcessError:
                            # Legacy builder may remove a finished step between
                            # listing and inspection. The next live step is checked.
                            continue
                        limits = info["HostConfig"]
                        actual = {key: limits.get(key) for key in ["CpuPeriod", "CpuQuota", "Memory", "MemorySwap"]}
                        if actual != {"CpuPeriod": 100000, "CpuQuota": 100000,
                                      "Memory": 2147483648, "MemorySwap": 2147483648}:
                            raise RuntimeError("Docker RUN step resource bounds were not applied")
                        observed[container] = actual
                    time.sleep(1)
                if process.returncode:
                    raise RuntimeError("Candidate build failed; inspect the private build.log")
            image_id = (output / "image-id.txt").read_text().strip()
            if not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
                raise RuntimeError("Docker did not return an immutable image ID")
            info = json.loads(command(docker + ["image", "inspect", image_id]))[0]
            labels = info["Config"].get("Labels") or {}
            if labels.get("org.opencontainers.image.revision") != commit or labels.get("world.imon.build.scope") != scope:
                raise RuntimeError("Built image labels do not match the archived source")
            if not observed:
                raise RuntimeError("No bounded RUN step was observed; build acceptance is incomplete")
            receipt = {"schema": 1, "startedAt": started,
                       "completedAt": datetime.now(timezone.utc).isoformat(),
                       "sourceCommit": commit, "sourceArchiveSha256": archive_hash,
                       "imageId": image_id, "imageTag": tag, "imageCreatedAt": info["Created"],
                       "builder": "installed Docker legacy builder (DOCKER_BUILDKIT=0)",
                       "observedRunStepLimits": observed,
                       "productionChanges": False, "deployed": False,
                       "acceptance": "build-only; migrations and external capabilities not accepted"}
            receipt_path = output / "build-receipt.json"
            receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
            os.chmod(receipt_path, 0o600)
            print(json.dumps(receipt), flush=True)
    except Exception:
        if process is not None and process.poll() is None:
            cleanup_owned()
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        raise
    finally:
        cleanup_owned()


if __name__ == "__main__":
    main()
