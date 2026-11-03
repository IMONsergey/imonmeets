#!/usr/bin/env python3
"""Two real ASR→MT calls and one cancellation through the bounded room adapter.

Uses the first already selected English clip and verified local model artifacts.
No new selection/download, TTS, network, model comparison or quality acceptance.
"""
from __future__ import annotations

import argparse
import asyncio
import datetime
import json
import os
import pathlib
import sys
import time

from fetch_opus_release import ROOT, atomic_json, sha256
from run_mt40 import LANGUAGES, SELECTION_SHA256, cgroup_limits

sys.path.insert(0, str(ROOT))
from real_engines import ASRProcessEngine, MTProcessEngine
from streaming_adapter import TranslationStreamAdapter, UnknownTrackError


async def until(predicate, seconds=3):
    async with asyncio.timeout(seconds):
        while not predicate():
            await asyncio.sleep(.005)


async def main(destination):
    destination = destination.resolve()
    allowed = (ROOT / "data/lifecycle").resolve()
    if not destination.is_relative_to(allowed) or destination == allowed:
        raise ValueError("A new run directory under data/lifecycle is required")
    destination.mkdir(parents=True, exist_ok=False)
    report = {
        "schema": 1, "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "cgroup_limits": cgroup_limits(), "status": "running", "model_quality_gate": "BLOCKED",
        "selection_sha256": SELECTION_SHA256, "results": [], "checks": {},
        "scope": "Whole-utterance real ASR/MT worker lifecycle through the room adapter. No TTS, LiveKit, first-audio latency or quality PASS.",
    }
    output = destination / "result.json"
    atomic_json(output, report)
    adapter = None
    try:
        subset = ROOT / "data/fleurs_subset"
        if sha256(subset / "selection_manifest.json") != SELECTION_SHA256:
            raise ValueError("Saved selection changed")
        selection = json.loads((subset / "selection_manifest.json").read_text())
        sentence = selection["sentences"][0]
        config = LANGUAGES["en"]
        clips = json.loads((subset / f"audio-{config}.json").read_text())["clips"]
        clip = next(item for item in clips if item["sentence_id"] == sentence["sentence_id"])
        if pathlib.Path(clip["file"]).name != clip["file"]:
            raise ValueError("Unsafe audio manifest filename")
        path = subset / "audio" / config / clip["file"]
        if sha256(path) != clip["sha256"]:
            raise ValueError("Pinned clip bytes changed")
        audio = path.read_bytes()
        python = ROOT.parents[1] / ".venv/bin/python"
        asr = ASRProcessEngine(python, "en", model="base")
        mt = MTProcessEngine(python, "en", "ru")
        publications = []
        adapter = TranslationStreamAdapter(asr, mt, room_id="isolated-lifecycle-smoke",
                                            on_result=publications.append, max_latency_seconds=45,
                                            max_queue_seconds=5)
        handle = adapter.register_track("fixture-participant", "fixture-mic", "en", "ru", session=adapter.session)

        async def translate(current, sequence, label):
            started = time.monotonic()
            future = await adapter.submit_wav(current, audio, sequence=sequence)
            result = await future
            report["results"].append({
                "label": label, "sentence_id": sentence["sentence_id"], "direction": "en-ru",
                "audio_sha256": clip["sha256"], "audio_seconds": clip["duration_seconds"],
                "actual_asr_text": result.source_text, "actual_mt_input": result.source_text,
                "translated_text": result.translated_text, "asr_worker": asr.last_result,
                "mt_worker": mt.last_result, "whole_utterance_wall_seconds": time.monotonic() - started,
                "session_generation": current.session.generation, "track_generation": current.generation,
                "audio_output_bytes": len(result.audio), "quality_status": "not-evaluated-in-lifecycle-test",
            })
            await until(lambda: adapter.stats["active"] == 0)
            atomic_json(output, report)
            print("REAL_ADAPTER_COMPLETED", label, flush=True)

        await translate(handle, 1, "before-cancel")
        pid = asr.stage.pid
        old = await adapter.submit_wav(handle, audio, sequence=2)
        await until(lambda: asr.stage.stats["active"] == 1)
        await asyncio.sleep(.1)
        if old.done():
            raise AssertionError("ASR finished before the intended cancellation point")
        queued = await adapter.submit_wav(handle, audio, sequence=3)
        cancel_started = time.monotonic()
        adapter.unregister_track(handle)
        await until(lambda: adapter.stats["active"] == 0)
        cancel_to_retired = time.monotonic() - cancel_started
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            reaped = True
        else:
            reaped = False
        if not reaped or not old.cancelled() or not queued.cancelled() or len(publications) != 1:
            raise AssertionError("Cancellation leaked a worker, queued request or publication")
        if adapter.stats["buffered_bytes"] != 0 or adapter.stats["revision_entries"] != 0:
            raise AssertionError("Cancelled reservations remain")
        report["checks"]["track_leave"] = {
            "worker_pid": pid, "worker_reaped": reaped, "active_and_queued_futures_cancelled": True,
            "cancel_to_retired_seconds": cancel_to_retired,
            "native_entry_evidence": "Stage ownership and live warm worker observed; native inference entry not separately instrumented.",
            "late_publications": 0, "remaining_buffered_bytes": adapter.stats["buffered_bytes"],
        }
        old_session = adapter.session
        adapter.reconnect(old_session)
        fresh = adapter.register_track("fixture-participant", "fixture-mic", "en", "ru", session=adapter.session)
        if adapter.unregister_track(handle) or await adapter.room_left(old_session):
            raise AssertionError("Stale leave affected replacement")
        try:
            await adapter.submit_wav(handle, audio, sequence=4)
        except UnknownTrackError:
            pass
        else:
            raise AssertionError("Stale audio was accepted")
        await translate(fresh, 1, "after-reconnect")
        pids = [asr.stage.pid, mt.stage.pid]
        await adapter.room_left(adapter.session)
        for worker_pid in pids:
            try:
                os.kill(worker_pid, 0)
            except ProcessLookupError:
                pass
            else:
                raise AssertionError("Idle worker remains after room leave")
        if len(publications) != 2 or adapter.stats["buffered_bytes"] != 0:
            raise AssertionError("Unexpected publication count or retained payload")
        report["checks"]["reconnect"] = {"old_handle_rejected": True, "stale_room_leave_ignored": True,
                                             "fresh_handle_completed": True}
        report["checks"]["room_leave"] = {"asr_and_mt_workers_reaped": True, "adapter_stats": adapter.stats,
                                             "asr_stats": asr.stage.stats, "mt_stats": mt.stage.stats}
        report["status"] = "control-checks-passed"
    except BaseException as error:
        report["status"] = "failed"
        report["error"] = {"type": type(error).__name__, "message": str(error)}
        raise
    finally:
        try:
            if adapter is not None:
                await adapter.close()
        except BaseException as cleanup_error:
            report["status"] = "failed"
            report["cleanup_error"] = {"type": type(cleanup_error).__name__, "message": str(cleanup_error)}
            raise
        finally:
            report["completed_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            atomic_json(output, report)
            print("LIFECYCLE_RESULT", str(output), report["status"], flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("destination", type=pathlib.Path)
    args = parser.parse_args()
    asyncio.run(main(args.destination))
