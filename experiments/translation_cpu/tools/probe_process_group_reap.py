#!/usr/bin/env python3
"""Deterministic audit probe. No child is spawned and no OS signal is sent.

It records whether ProcessStage signals a numeric process group after wait()
returns success. This demonstrates the missing ownership boundary, not actual
PID reuse or an observed unrelated-process termination on this machine.
"""
import asyncio
import hashlib
import json
from pathlib import Path
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from process_stage import ProcessStage

async def main():
    class ReapedProcess:
        pid = 123456789
        reaped = False
        async def wait(self):
            self.reaped = True
            return 0
    process = ReapedProcess()
    stage = ProcessStage([sys.executable])
    stage._process = process
    signals = []
    def record_signal(pgid, sig):
        signals.append({"pgid": pgid, "signal": sig.name, "wait_already_returned": process.reaped})
    with patch("process_stage.os.killpg", record_signal):
        await stage._stop()
    record = {
        "schema": 1,
        "scope": "deterministic fake process, mocked killpg; no OS signal or model inference",
        "source_sha256": hashlib.sha256((ROOT / "process_stage.py").read_bytes()).hexdigest(),
        "signals": signals,
        "signal_after_successful_wait": any(item["wait_already_returned"] for item in signals),
        "actual_pid_reuse_observed": False,
        "finding": "OPEN: group identity is not retained after leader wait; prevent numeric PGID reuse before cleanup",
    }
    target = ROOT / "data" / "review_20261103" / "process_group_reap_probe.json"
    target.parent.mkdir(exist_ok=True)
    if target.exists():
        raise RuntimeError("Refusing to overwrite audit evidence")
    target.write_text(json.dumps(record, indent=2) + "\n")
    print(json.dumps(record, indent=2))

if __name__ == "__main__":
    asyncio.run(main())
