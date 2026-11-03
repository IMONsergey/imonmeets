#!/usr/bin/env python3
"""Apply the lexical gate to fixed saved outputs; no models, references or TTS."""
from __future__ import annotations
import collections
import dataclasses
import datetime
import hashlib
import json
import pathlib
import re
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from quality_gate import POLICY_VERSION, assess_translation
from run_mt40 import cgroup_limits, percentile

PINNED = {
    "ru-zh": "6a614c93f92e826255b35c14007ee7c39229d09e870ba555ce373b24ba458ada",
    "zh-ru": "c617fde08fbcceabbaab19adeba8e7fa08b42a2abcaa857614d9fc24d47b6102",
    "ru-ar": "a8fb710b2c7e7eedb28426db8caf9d6d28871507248655157bcbe614908d6a7c",
    "ar-ru": "84c881ec84027ebc9077694e2d3b76cbb6abcc3a341669c123e2d0a4dbd227f8",
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def meta(path):
    return {"path": str(path), "sha256": digest(path.read_bytes()), "mtime_ns": path.stat().st_mtime_ns}


def main():
    limits = cgroup_limits()
    out = ROOT / "data/quality_gate_20261103"
    out.mkdir(exist_ok=True)
    records, routes, durations = [], [], []
    for direction, expected in PINNED.items():
        path = ROOT / "data/mt40/opus-original-20261103" / (direction + ".jsonl")
        raw = path.read_bytes()
        if digest(raw) != expected:
            raise ValueError("Saved output changed: " + direction)
        source_language, target_language = direction.split("-")
        statuses, reasons, count = collections.Counter(), collections.Counter(), 0
        for line in raw.splitlines():
            row = json.loads(line)
            started = time.monotonic()
            assessment = assess_translation(row["input"], row["output"], source_language, target_language)
            seconds = time.monotonic() - started
            if assessment.speech_allowed:
                raise AssertionError("Experimental route received a voice grant")
            statuses[assessment.status] += 1
            reasons.update(assessment.reasons)
            durations.append(seconds)
            records.append({
                "direction": direction, "case_id": row["case_id"],
                "input_sha256": digest(row["input"].encode()),
                "candidate_sha256": digest(row["output"].encode()),
                "assessment": dataclasses.asdict(assessment), "speech_allowed": assessment.speech_allowed,
                "gate_wall_seconds": round(seconds, 9),
            })
            count += 1
        routes.append({"direction": direction, "cases": count, "raw_sha256": expected,
                       "statuses": dict(statuses), "reason_counts": dict(reasons), "speech_grants": 0})
    if len(records) != 218:
        raise AssertionError("Expected all 218 retained pivots")
    source_files = [
        "quality_gate.py", "streaming_adapter.py", "tests/test_quality_gate.py",
        "tests/test_streaming_adapter.py", "tests/test_lifecycle_bounds.py",
    ]
    full_paths = list((ROOT / "data/mt40/receipts").glob("imonmeets-mt-quality-gate-full-control-*.json"))
    if len(full_paths) != 1:
        raise AssertionError("Expected one coherent full control receipt")
    receipt_path = full_paths[0]
    receipt = json.loads(receipt_path.read_text())
    log = receipt_path.with_suffix(".log").read_text()
    match = re.search(r"Ran (\d+) tests in ([0-9.]+)s\s+OK", log)
    if receipt["exit_code"] != 0 or match is None or int(match[1]) != 121:
        raise AssertionError("Full source control suite has not passed")
    start_ns = int(datetime.datetime.fromisoformat(receipt["started_at"].replace("Z", "+00:00")).timestamp() * 1e9)
    sources = {relative: meta(ROOT / relative) for relative in source_files}
    if any(item["mtime_ns"] > start_ns for item in sources.values()):
        raise AssertionError("A tested source changed after full-suite start")
    payload = {
        "schema": 1, "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "policy_version": POLICY_VERSION, "saved_results_commit": "c4630044ffa325e40a4727546022b15c9336565d",
        "original_inference_code_commit": "edce77925eb3a892645643725924ac1c4d748940",
        "model_inference": False, "tts_inference": False, "production_changes": False,
        "source_text_is_saved_gold_text_not_new_asr": True,
        "reference_used_to_correct_text": False, "raw_outputs_modified": False,
        "scope": "Lexical diagnostics only; suspect frequency is not a model accuracy/false-positive measurement.",
        "rows": 218, "speech_grants": 0, "routes": routes, "assessments": records,
        "source_files": sources, "evaluator_source": meta(pathlib.Path(__file__)),
        "full_control_receipt": meta(receipt_path), "full_control_log": meta(receipt_path.with_suffix(".log")),
        "full_control_tests": int(match[1]), "full_control_seconds": float(match[2]),
        "observed_cgroup": limits,
        "gate_only_wall_seconds": {"p50": percentile(durations, .5), "p95": percentile(durations, .95),
                                   "max": max(durations), "total": sum(durations)},
        "performance_scope": "One saved text batch on shared CPU; not live pipeline latency, capacity or SLO.",
    }
    (out / "saved_outputs_assessments.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k: v for k, v in payload.items() if k not in ("assessments", "source_files")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
