#!/usr/bin/env python3
"""Run controls + tiny real lifecycle smoke inside the required bounded cgroup.

The launcher must hold the shared verify.lock and redirect output to a regular
file. It must set CPUQuota=100%, MemoryMax=2G, TasksMax=256, RuntimeMaxSec=240,
KillMode=control-group. A detached launcher keeps RDC disconnection harmless.
"""
import argparse
import datetime
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
BASE = "ff685fbc9b9dcc3b39efe48dd21b9bb1b6e65c4d"


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def git(*args):
    return subprocess.check_output(["git", "-C", str(REPO), *args], text=True).strip()


def main(run_id):
    if not re.fullmatch(r"[a-zA-Z0-9-]{1,100}", run_id):
        raise ValueError("Invalid run id")
    destination = ROOT / "data/lifecycle" / run_id
    destination.mkdir(parents=True, exist_ok=True)
    receipt = destination / "verification.json"
    if receipt.exists():
        raise ValueError("Never overwrite an existing verification receipt")
    cgroup = next(line.split("::", 1)[1] for line in pathlib.Path("/proc/self/cgroup").read_text().splitlines() if line.startswith("0::"))
    control = pathlib.Path("/sys/fs/cgroup") / cgroup.lstrip("/")
    limits = {name: (control / name).read_text().strip() for name in ("cpu.max", "memory.max", "pids.max")}
    if limits != {"cpu.max": "100000 100000", "memory.max": "2147483648", "pids.max": "256"}:
        raise RuntimeError(f"Unexpected resource cgroup: {limits}")
    raw_prefix = "experiments/translation_cpu/data"
    raw_exclusion = ":(exclude)experiments/translation_cpu/data/lifecycle/**"
    if git("diff", "--name-only", BASE, "--", raw_prefix, raw_exclusion):
        raise RuntimeError("Existing raw experiment evidence changed")
    files = ["streaming_adapter.py", "process_stage.py", "real_engines.py",
             "tests/test_streaming_adapter.py", "tests/test_process_stage.py",
             "tests/test_lifecycle_bounds.py", "tests/test_worker_lifecycle.py",
             "tools/run_adapter_lifecycle_smoke.py", "tools/verify_lifecycle.py"]
    record = {
        "schema": 1, "run_id": run_id, "started_at": now(), "status": "running",
        "source_base_commit": git("rev-parse", "HEAD"), "expected_base": BASE,
        "preserved_raw_tree": git("rev-parse", BASE + ":" + raw_prefix),
        "source_sha256": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in files},
        "cgroup": cgroup, "observed_limits": limits,
        "scope": "Experimental lifecycle/control verification; model quality and commercial voice gates remain blocked.",
        "production_changes": False, "model_downloads": False, "tts": False,
    }

    def save():
        temporary = receipt.with_suffix(".tmp")
        temporary.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n")
        temporary.replace(receipt)

    save()
    exit_code = 1
    try:
        suite = unittest.defaultTestLoader.discover(str(ROOT / "tests"))
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        record["unit_tests"] = {"run": result.testsRun, "failures": len(result.failures),
                                 "errors": len(result.errors), "skipped": len(result.skipped)}
        save()
        if not result.wasSuccessful() or result.skipped:
            raise RuntimeError("Control/contract regression suite did not completely pass")
        smoke = subprocess.run([sys.executable, str(ROOT / "tools/run_adapter_lifecycle_smoke.py"),
                                str(destination / "real-smoke")], timeout=150, check=False)
        record["real_smoke_exit_code"] = smoke.returncode
        if smoke.returncode:
            raise RuntimeError("Real adapter lifecycle smoke failed")
        record["real_smoke_result_sha256"] = hashlib.sha256((destination / "real-smoke/result.json").read_bytes()).hexdigest()
        changed = git("diff", "--name-only", BASE, "--", raw_prefix, raw_exclusion)
        if changed:
            raise RuntimeError("Existing raw experiment evidence changed during verification")
        record["existing_raw_evidence_unchanged"] = True
        current = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in files}
        if current != record["source_sha256"]:
            raise RuntimeError("Lifecycle source changed during verification")
        record["source_unchanged_during_verification"] = True
        record["status"] = "control-checks-passed"
        exit_code = 0
    except BaseException as error:
        record["status"] = "failed"
        record["error"] = {"type": type(error).__name__, "message": str(error)}
        print("VERIFICATION_FAILED", type(error).__name__, str(error), flush=True)
    finally:
        record["completed_at"] = now()
        for name in ("memory.peak", "memory.events", "cpu.stat", "pids.peak"):
            path = control / name
            if path.exists():
                record[name] = path.read_text().strip()
        save()
        print("VERIFICATION_RECEIPT", str(receipt), record["status"], flush=True)
    return exit_code


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("run_id")
    raise SystemExit(main(parser.parse_args().run_id))
