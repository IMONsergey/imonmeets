#!/usr/bin/env python3
"""Verify saved RU pivots without inference; never edit the preserved corpus or raw output."""
from __future__ import annotations
import datetime
import hashlib
import json
import math
import pathlib
import subprocess
from run_mt40 import ROOT, RUN_ID, TARGET_TOKENS, cases_for, cgroup_limits

DIRECTIONS = ("ru-zh", "zh-ru", "ru-ar", "ar-ru")
EXPECTED_SOURCE = "edce77925eb3a892645643725924ac1c4d748940"
TIMING_CONTRACT = ("second_hop_seconds is new inference; historical_first_hop_plus_new_second_hop_seconds "
                   "sums separately measured stages and is NOT continuous end-to-end latency.")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_meta(path):
    data = path.read_bytes()
    stat = path.stat()
    return {"path": str(path), "bytes": len(data), "sha256": digest(data), "mtime_ns": stat.st_mtime_ns}


def raw_rows(path):
    rows = []
    for line_number, raw in enumerate(path.read_bytes().splitlines(keepends=True), 1):
        if raw.strip():
            rows.append((json.loads(raw), {"line_number": line_number, "raw_jsonl_line_sha256": digest(raw)}))
    return rows


def stats(values):
    ordered = sorted(values)
    def pct(p):
        return round(ordered[max(0, math.ceil(p * len(ordered)) - 1)], 6)
    return {"p50": pct(.5), "p95": pct(.95), "max": max(ordered), "sum": round(sum(ordered), 6)}


def main():
    out = ROOT / "data/ru_pivot_20261103"
    preflight_path = out / "preflight.json"
    pre = json.loads(preflight_path.read_text())
    assert pre["source_commit"] == EXPECTED_SOURCE
    repo = ROOT.parents[1]
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    subprocess.run(["git", "merge-base", "--is-ancestor", EXPECTED_SOURCE, head], cwd=repo, check=True)
    for relative, expected in pre["preserved_tracked_files"].items():
        observed = file_meta(repo / relative)
        assert observed["sha256"] == expected["sha256"], ("preserved file changed", relative)
        assert observed["bytes"] == expected["bytes"]
    historical = {}
    for direction, expected in pre["historical_first_hop_files"].items():
        observed = file_meta(pathlib.Path(expected["path"]))
        assert observed["sha256"] == expected["sha256"], ("historical first hop changed", direction)
        assert observed["mtime_ns"] == expected["mtime_ns"], ("historical source mtime changed", direction)
        historical[direction] = observed

    directory = ROOT / "data/mt40" / RUN_ID
    provenance = ROOT / "data/provenance/opus"
    chains, summaries = [], []
    for direction in DIRECTIONS:
        source, target = direction.split("-")
        first_direction, second_direction = source + "-en", "en-" + target
        first_path, second_path = directory / (first_direction + ".jsonl"), directory / (direction + ".jsonl")
        first_meta, second_meta = file_meta(first_path), file_meta(second_path)
        assert first_meta["sha256"] == pre["routes"][direction]["first_outputs"]["sha256"]
        first_rows = raw_rows(first_path)
        first = {r["case_id"]: (r, loc) for r, loc in first_rows}
        assert len(first) == len(first_rows), ("duplicate first-hop case", first_direction)
        second_rows = raw_rows(second_path)
        second = {r["case_id"]: (r, loc) for r, loc in second_rows}
        assert len(second) == len(second_rows), ("duplicate new case", direction)
        cases = cases_for(direction)
        assert set(second) == {case["case_id"] for case in cases}, ("coverage mismatch", direction)
        conversions = [json.loads((provenance / (d + ".conversion.json")).read_text())
                       for d in (first_direction, second_direction)]
        model_chain = [c["model_sha256"] for c in conversions]
        stage_summary_path = directory / (direction + ".summary.json")
        stage = json.loads(stage_summary_path.read_text())
        assert stage["output_sha256"] == second_meta["sha256"]
        assert stage["errors"] == 0
        assert stage["successful_inference"] == stage["recorded_cases"] == len(cases)
        limits = stage["cgroup_limits"]
        assert limits["cpu_max"] == "100000 100000" and limits["memory_max"] == 2147483648
        assert limits["pids_max"] == "128"
        receipt_paths = list((ROOT / "data/mt40/receipts").glob("imonmeets-mt-ru-pivot-" + direction + "-*.json"))
        assert len(receipt_paths) == 1, ("expected one completed bounded invocation", direction)
        receipt_path = receipt_paths[0]
        receipt = json.loads(receipt_path.read_text())
        assert receipt["exit_code"] == 0 and receipt["runtime_max_seconds"] == 180
        assert receipt["cpu_quota"] == "100%" and receipt["memory_max_bytes"] == 2147483648
        assert receipt["tasks_max"] == 128 and receipt["kill_mode"] == "control-group"
        assert receipt["lock"] == "/home/sergey/.local/state/imonmeets-commercial-20261103/verify.lock"
        assert receipt["command"] == [pre["runtime_python"], str(ROOT / "tools/run_mt40.py"), direction]
        assert limits["cgroup"].endswith("/" + receipt["unit"] + ".service")
        log_path = receipt_path.with_suffix(".log")
        assert "DIRECTION_COMPLETE " in log_path.read_text()
        receipt_start = datetime.datetime.fromisoformat(receipt["started_at"].replace("Z", "+00:00"))
        receipt_end = datetime.datetime.fromisoformat(receipt["finished_at"])
        current_chains = []
        for case in cases:
            old, old_loc = first[case["case_id"]]
            new, new_loc = second[case["case_id"]]
            assert old["status"] == new["status"] == "ok"
            assert old["input"] == new["input"] == case["input"]
            assert new["reference"] == case["reference"]
            assert new["mt_input"] == old["output"], ("not actual first-hop output", direction, case["case_id"])
            assert new["model_chain"] == model_chain and old["model_sha256"] == model_chain[0]
            assert new["model_sha256"] == model_chain[1]
            assert new["source_archive_sha256"] == conversions[1]["source_archive_sha256"]
            assert old["target_token"] == TARGET_TOKENS.get(first_direction)
            assert new["target_token"] == TARGET_TOKENS.get(second_direction)
            assert new["config_id"] == stage["config_id"]
            assert new["selection_sha256"] == pre["preserved_tracked_files"][
                "experiments/translation_cpu/data/fleurs_subset/selection_manifest.json"]["sha256"]
            for field in ("direction", "output", "model_sha256", "inference_seconds", "target_token"):
                assert new["first_hop"][field] == old[field]
            for row in (old, new):
                assert 0 < row["input_tokens"] <= 512 and 0 < row["output_tokens"] <= 512
            expected_sum = round(old["inference_seconds"] + new["inference_seconds"], 6)
            assert abs(new["pipeline_mt_seconds"] - expected_sum) <= 0.000001
            began = datetime.datetime.fromisoformat(new["started_at"])
            assert receipt_start <= began <= receipt_end
            chain = {
                "direction": direction, "case_id": case["case_id"], "kind": case["kind"],
                "input": case["input"], "input_sha256": digest(case["input"].encode()),
                "reference": case["reference"], "first_hop_direction": first_direction,
                "actual_first_hop_output": old["output"], "first_hop_output_sha256": digest(old["output"].encode()),
                "second_hop_direction": second_direction, "actual_second_hop_input": new["mt_input"],
                "second_hop_input_sha256": digest(new["mt_input"].encode()),
                "output": new["output"], "output_sha256": digest(new["output"].encode()),
                "model_chain": model_chain,
                "first_hop_source_archive_sha256": conversions[0]["source_archive_sha256"],
                "second_hop_source_archive_sha256": conversions[1]["source_archive_sha256"],
                "first_hop_target_token": old["target_token"], "second_hop_target_token": new["target_token"],
                "first_hop_input_tokens": old["input_tokens"], "first_hop_output_tokens": old["output_tokens"],
                "second_hop_input_tokens": new["input_tokens"], "second_hop_output_tokens": new["output_tokens"],
                "historical_first_hop_started_at": old["started_at"], "new_second_hop_started_at": new["started_at"],
                "historical_first_hop_seconds": old["inference_seconds"],
                "second_hop_seconds": new["inference_seconds"],
                "historical_first_hop_plus_new_second_hop_seconds": expected_sum,
                "first_hop_file": {**first_meta, **old_loc},
                "historical_first_hop_file": historical[first_direction],
                "new_second_hop_file": {**second_meta, **new_loc},
                "new_second_hop_config_id": new["config_id"], "bounded_unit": receipt["unit"],
                "quality_status": "unreviewed; see separate assistant review, not native acceptance",
            }
            current_chains.append(chain)
        chains.extend(current_chains)
        summaries.append({
            "direction": direction, "cases": len(cases),
            "fleurs": sum(c["kind"] == "fleurs_gold_text" for c in cases),
            "authored": sum(c["kind"] != "fleurs_gold_text" for c in cases),
            "second_hop_seconds": stats([c["second_hop_seconds"] for c in current_chains]),
            "historical_first_hop_seconds": stats([c["historical_first_hop_seconds"] for c in current_chains]),
            "historical_first_hop_plus_new_second_hop_seconds": stats([
                c["historical_first_hop_plus_new_second_hop_seconds"] for c in current_chains]),
            "new_model_load_seconds": stage["model_load_seconds_this_invocation"],
            "max_rss_kib": stage["max_rss_kib"], "runtime_versions": stage["versions"],
            "observed_cgroup_limits": limits, "model_chain": model_chain,
            "second_target_token": TARGET_TOKENS.get(second_direction),
            "raw_output": second_meta, "stage_summary": file_meta(stage_summary_path),
            "receipt": file_meta(receipt_path), "log": file_meta(log_path),
            "invocation_started_at": receipt["started_at"], "invocation_finished_at": receipt["finished_at"],
            "invocation_wall_including_lock_and_launch_seconds": round((receipt_end - receipt_start).total_seconds(), 6),
        })
    assert len(chains) == 218 and sum(s["fleurs"] for s in summaries) == 160
    chain_path = out / "chains.jsonl"
    chain_path.write_text("".join(json.dumps(c, ensure_ascii=False) + "\n" for c in chains))
    report = {
        "schema": 1, "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "verification_head": head, "inference_source_commit": EXPECTED_SOURCE,
        "preserved_tracked_files_verified": len(pre["preserved_tracked_files"]),
        "new_results_verified": len(chains), "fleurs_results": 160, "authored_results": 58,
        "all_bindings_verified": True, "verification_cgroup": cgroup_limits(), "timing_contract": TIMING_CONTRACT,
        "continuous_end_to_end_timing": False, "quality_accepted": False,
        "asr_run": False, "tts_run": False, "livekit_run": False, "new_downloads": False,
        "raw_outputs_rewritten": False, "verifier_source": file_meta(pathlib.Path(__file__)), "preflight": file_meta(preflight_path),
        "chain_ledger": file_meta(chain_path), "routes": summaries,
    }
    (out / "verification.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k: v for k, v in report.items() if k not in ("routes",)}, ensure_ascii=False))
    for summary in summaries:
        print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
