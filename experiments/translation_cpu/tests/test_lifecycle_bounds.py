"""Control/resource assertions. These engines do not establish speech quality."""
import asyncio
import gc
import io
import struct
import sys
import time
import tracemalloc
import unittest
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from streaming_adapter import (
    BackpressureError, DeadlineError, EngineShutdownError, StaleFrameError,
    TranslationStreamAdapter, UnknownTrackError,
)
from process_stage import StageCleanupError


def float_wav(samples, *, frame_count=None, extra=b""):
    data = struct.pack("<" + "f" * len(samples), *samples)
    fmt = struct.pack("<HHIIHHH", 3, 1, 16000, 64000, 4, 32, 0)
    fact = struct.pack("<I", len(samples) if frame_count is None else frame_count)
    body = b"WAVE" + b"fmt " + struct.pack("<I", len(fmt)) + fmt
    body += b"fact" + struct.pack("<I", len(fact)) + fact
    body += b"data" + struct.pack("<I", len(data)) + data + extra
    return b"RIFF" + struct.pack("<I", len(body)) + body


async def eventually(predicate, timeout=2):
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(.001)


class Engines:
    def __init__(self):
        self.calls = []
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.block = False

    async def asr(self, audio, language):
        self.calls.append(("asr", audio))
        self.started.set()
        if self.block:
            await self.release.wait()
        return audio.decode()

    async def mt(self, text, source, target):
        self.calls.append(("mt", text))
        return text

    async def tts(self, text, language):
        self.calls.append(("tts", text))
        return text.encode()


class BoundsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.adapters = []
        self.participants = {}

    async def asyncTearDown(self):
        for adapter in self.adapters:
            try:
                await adapter.close()
            except EngineShutdownError:
                # The one hostile-engine test explicitly asserts and releases it.
                self.assertIsNotNone(adapter.stats["failure"])

    def make(self, **kwargs):
        engines = Engines()
        results = []
        adapter = TranslationStreamAdapter(engines.asr, engines.mt, engines.tts,
                                           on_result=results.append, **kwargs)
        self.adapters.append(adapter)
        return adapter, engines, results

    def track(self, adapter, participant="p", track="t"):
        key = id(adapter), adapter.session, participant
        captured = self.participants.get(key)
        if not adapter.is_current_participant(captured):
            captured = adapter.register_participant(participant, session=adapter.session)
            self.participants[key] = captured
        return adapter.register_track(captured, track, "en", "ru")

    async def submit(self, adapter, handle, sequence, data=b"a", duration=.1, **kwargs):
        return await adapter.submit(handle, data, sequence=sequence, duration_seconds=duration, **kwargs)

    async def idle(self, adapter):
        await eventually(lambda: adapter.stats["active"] == 0 and adapter.stats["queued"] == 0)

    async def test_admission_validates_bytes_duration_sequence_and_deadline(self):
        adapter, engines, _ = self.make(max_utterance_bytes=4, max_utterance_seconds=.2)
        handle = self.track(adapter)
        cases = [
            (b"", .1, 1, ValueError), (bytearray(b"a"), .1, 1, ValueError),
            (b"12345", .1, 1, BackpressureError), (b"a", .3, 1, BackpressureError),
            (b"a", 0, 1, ValueError), (b"a", float("nan"), 1, ValueError),
            (b"a", float("inf"), 1, ValueError), (b"a", .1, True, ValueError),
            (b"a", .1, 2**53, ValueError),
        ]
        for audio, duration, sequence, error in cases:
            with self.subTest(audio=audio, duration=duration, sequence=sequence):
                with self.assertRaises(error):
                    await self.submit(adapter, handle, sequence, audio, duration)
        with self.assertRaises(DeadlineError):
            await self.submit(adapter, handle, 1, deadline=asyncio.get_running_loop().time() - 1)
        self.assertEqual(engines.calls, [])
        self.assertEqual(adapter.stats["buffered_bytes"], 0)
        self.assertEqual(adapter.stats["revision_entries"], 0)

    async def test_wav_admission_derives_real_duration_and_rejects_false_metadata(self):
        adapter, engines, _ = self.make(max_buffered_audio_seconds=.15)
        engines.block = True
        handle, other = self.track(adapter), self.track(adapter, "other")
        stream = io.BytesIO()
        with wave.open(stream, "wb") as writer:
            writer.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
            writer.writeframes(b"\0\0" * 1600)
        audio = stream.getvalue()
        active = await adapter.submit_wav(handle, audio, sequence=1)
        await engines.started.wait()
        self.assertAlmostEqual(adapter.stats["buffered_audio_seconds"], .1)
        with self.assertRaises(BackpressureError):
            await adapter.submit_wav(other, audio, sequence=1)
        with self.assertRaises(ValueError):
            await adapter.submit_wav(other, audio, sequence=1, duration_seconds=.001)
        with self.assertRaises(ValueError):
            await adapter.submit_wav(other, audio[:-2], sequence=1)
        adapter.cancel_track(handle)
        await self.idle(adapter)
        self.assertTrue(active.cancelled())

    async def test_bound_engine_methods_close_their_shared_owner_once(self):
        class Owned(Engines):
            closes = 0
            async def close(self):
                self.closes += 1
        owned = Owned()
        adapter = TranslationStreamAdapter(owned.asr, owned.mt, owned.tts)
        self.adapters.append(adapter)
        future = await self.submit(adapter, self.track(adapter), 1)
        await future
        await adapter.close()
        await adapter.close()
        self.assertEqual(owned.closes, 1)

    async def test_float_wav_matches_saved_fleurs_format_without_conversion(self):
        adapter, engines, _ = self.make()
        engines.block = True
        handle = self.track(adapter)
        audio = float_wav([0.0, .1, -.2] * 1600)
        active = await adapter.submit_wav(handle, audio, sequence=1)
        await engines.started.wait()
        self.assertIs(engines.calls[0][1], audio)
        self.assertAlmostEqual(adapter.stats["buffered_audio_seconds"], .3)
        adapter.cancel_track(handle)
        await self.idle(adapter)
        self.assertTrue(active.cancelled())

    async def test_wav_parser_rejects_ambiguous_nonfinite_or_mismatched_payload(self):
        adapter, engines, _ = self.make()
        handle = self.track(adapter)
        cases = [float_wav([float("nan")]), float_wav([float("inf")]),
                 float_wav([0.0], frame_count=2), float_wav([0.0])[:-1],
                 float_wav([0.0], extra=b"data" + struct.pack("<I", 4) + b"\0" * 4),
                 float_wav([0.0], extra=(b"JUNK" + struct.pack("<I", 0)) * 65)]
        for audio in cases:
            with self.subTest(bytes=len(audio)):
                with self.assertRaises(ValueError):
                    await adapter.submit_wav(handle, audio, sequence=1)
        self.assertEqual(engines.calls, [])
        self.assertEqual(adapter.stats["buffered_bytes"], 0)

    async def test_native_cleanup_failure_closes_adapter_admission(self):
        adapter, engines, results = self.make()
        async def failed_cleanup(*args):
            raise StageCleanupError("retirement is unproven")
        adapter._asr = failed_cleanup
        handle = self.track(adapter)
        future = await self.submit(adapter, handle, 1)
        with self.assertRaises(StageCleanupError):
            await future
        await adapter.close()
        self.assertTrue(adapter.stats["closed"])
        self.assertEqual(adapter.stats["buffered_bytes"], 0)
        with self.assertRaises(RuntimeError):
            await self.submit(adapter, handle, 2)
        self.assertEqual(engines.calls, [])
        self.assertEqual(results, [])

    async def test_cancelled_active_bytes_are_reserved_until_acknowledged(self):
        started, release = asyncio.Event(), asyncio.Event()
        async def resistant(audio, language):
            started.set()
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                await release.wait()
                return audio.decode()
        adapter, engines, results = self.make(max_buffered_bytes=8)
        adapter._asr = resistant
        one, two = self.track(adapter), self.track(adapter, "other")
        active = await self.submit(adapter, one, 1, b"1234")
        await started.wait()
        queued = await self.submit(adapter, two, 1, b"5678")
        with self.assertRaises(BackpressureError):
            await self.submit(adapter, two, 2)
        queued.cancel()
        await eventually(lambda: adapter.stats["buffered_bytes"] == 4)
        adapter.cancel_track(one)
        self.assertTrue(active.cancelled())
        self.assertEqual(adapter.stats["buffered_bytes"], 4)
        with self.assertRaises(BackpressureError):
            await self.submit(adapter, two, 2, b"12345678")
        release.set()
        await self.idle(adapter)
        self.assertEqual(adapter.stats["buffered_bytes"], 0)
        self.assertEqual(adapter.stats["revision_entries"], 0)
        self.assertEqual(results, [])
        self.assertEqual(engines.calls, [])

    async def test_audio_time_budget_counts_active_and_queued(self):
        adapter, engines, _ = self.make(max_buffered_audio_seconds=.3)
        engines.block = True
        one, two = self.track(adapter), self.track(adapter, "other")
        active = await self.submit(adapter, one, 1, duration=.2)
        await engines.started.wait()
        queued = await self.submit(adapter, two, 1, duration=.1)
        with self.assertRaises(BackpressureError):
            await self.submit(adapter, two, 2, duration=.01)
        self.assertAlmostEqual(adapter.stats["buffered_audio_seconds"], .3)
        engines.release.set()
        await asyncio.gather(active, queued)
        await self.idle(adapter)
        self.assertAlmostEqual(adapter.stats["buffered_audio_seconds"], 0)

    async def test_byte_rejection_preserves_existing_active_revision(self):
        adapter, engines, results = self.make(max_buffered_bytes=4)
        engines.block = True
        handle = self.track(adapter)
        original = await self.submit(adapter, handle, 1, b"keep", utterance_id="same")
        await engines.started.wait()
        with self.assertRaises(BackpressureError):
            await self.submit(adapter, handle, 1, b"edit", utterance_id="same", revision=2)
        self.assertFalse(original.done())
        engines.release.set()
        self.assertEqual((await original).source_text, "keep")
        self.assertEqual([item.source_text for item in results], ["keep"])

    async def test_participant_cap_cannot_be_bypassed_with_more_tracks(self):
        adapter, engines, _ = self.make(queue_size=4, max_pending_per_participant=2)
        engines.block = True
        handles = [self.track(adapter, "same", f"t{i}") for i in range(3)]
        other = self.track(adapter, "other")
        active = await self.submit(adapter, handles[0], 1)
        await engines.started.wait()
        queued = await self.submit(adapter, handles[1], 1)
        with self.assertRaises(BackpressureError):
            await self.submit(adapter, handles[2], 1)
        admitted = await self.submit(adapter, other, 1)
        engines.release.set()
        await asyncio.gather(active, queued, admitted)

    async def test_round_robin_participants_and_source_order(self):
        adapter, engines, results = self.make(queue_size=6, max_pending_per_participant=4)
        engines.block = True
        a, b, c = [self.track(adapter, p) for p in ("a", "b", "c")]
        futures = [await self.submit(adapter, a, 1, b"a1")]
        await engines.started.wait()
        for handle, sequence, text in [(a, 2, b"a2"), (a, 3, b"a3"), (b, 1, b"b1"),
                                       (b, 2, b"b2"), (c, 1, b"c1"), (c, 2, b"c2")]:
            futures.append(await self.submit(adapter, handle, sequence, text))
        engines.release.set()
        await asyncio.gather(*futures)
        self.assertEqual([item.source_text for item in results], ["a1", "b1", "c1", "a2", "b2", "c2", "a3"])

    async def test_queued_expiry_releases_budget_while_another_call_is_active(self):
        adapter, engines, _ = self.make(max_queue_seconds=.04, max_latency_seconds=2)
        engines.block = True
        one, two = self.track(adapter), self.track(adapter, "other")
        active = await self.submit(adapter, one, 1, b"active")
        await engines.started.wait()
        queued = await self.submit(adapter, two, 1, b"expired")
        with self.assertRaises(DeadlineError):
            await asyncio.wait_for(queued, .5)
        self.assertFalse(active.done())
        self.assertEqual(adapter.stats["buffered_bytes"], len(b"active"))
        self.assertEqual(engines.calls, [("asr", b"active")])
        engines.release.set()
        await active

    async def test_queued_revision_does_not_reset_age_or_reorder_utterance(self):
        adapter, engines, results = self.make(queue_size=3, max_pending_per_participant=3, max_queue_seconds=.08)
        engines.block = True
        active_track, handle = self.track(adapter, "active"), self.track(adapter)
        active = await self.submit(adapter, active_track, 1, b"active")
        await engines.started.wait()
        original = await self.submit(adapter, handle, 1, b"old")
        second = await self.submit(adapter, handle, 2, b"second")
        await asyncio.sleep(.035)
        revised = await self.submit(adapter, handle, 1, b"corrected", revision=2)
        with self.assertRaises(StaleFrameError):
            await original
        engines.release.set()
        await asyncio.gather(active, revised, second)
        self.assertEqual([item.source_text for item in results], ["active", "corrected", "second"])

        # Independent expiry assertion: a revision gets only the remaining age.
        adapter2, engines2, _ = self.make(max_queue_seconds=.08)
        engines2.block = True
        a, h = self.track(adapter2, "active"), self.track(adapter2)
        running = await self.submit(adapter2, a, 1)
        await engines2.started.wait()
        first = await self.submit(adapter2, h, 1)
        original_expiry = adapter2._queue[0].queue_expires
        await asyncio.sleep(.035)
        replacement = await self.submit(adapter2, h, 1, revision=2)
        self.assertEqual(adapter2._queue[0].queue_expires, original_expiry)
        with self.assertRaises(StaleFrameError):
            await first
        with self.assertRaises(DeadlineError):
            await replacement
        engines2.release.set()
        await running

    async def test_stage_boundary_deadline_stops_non_yielding_late_return(self):
        adapter, engines, results = self.make(max_latency_seconds=.01)
        async def briefly_blocking(audio, language):
            time.sleep(.025)
            return "late"
        adapter._asr = briefly_blocking
        future = await self.submit(adapter, self.track(adapter), 1)
        with self.assertRaises(DeadlineError):
            await future
        await self.idle(adapter)
        self.assertEqual(engines.calls, [])
        self.assertEqual(results, [])

    async def test_late_return_after_cancel_is_gated_at_every_stage(self):
        for stage in ("asr", "mt", "tts"):
            with self.subTest(stage=stage):
                adapter, engines, results = self.make()
                started, release = asyncio.Event(), asyncio.Event()
                async def resistant(*args):
                    started.set()
                    try:
                        await asyncio.Future()
                    except asyncio.CancelledError:
                        await release.wait()
                        return b"late" if stage == "tts" else "late"
                setattr(adapter, f"_{stage}", resistant)
                handle = self.track(adapter)
                future = await self.submit(adapter, handle, 1)
                await started.wait()
                adapter.unregister_track(handle)
                release.set()
                await self.idle(adapter)
                self.assertTrue(future.cancelled())
                self.assertEqual(results, [])
                stages = [name for name, *_ in engines.calls]
                self.assertEqual(stages, {"asr": [], "mt": ["asr"], "tts": ["asr", "mt"]}[stage])

    async def test_old_track_leave_cannot_remove_replacement_same_ids(self):
        adapter, engines, results = self.make()
        engines.block = True
        old = self.track(adapter)
        future = await self.submit(adapter, old, 1, b"old")
        await engines.started.wait()
        self.assertTrue(adapter.unregister_track(old))
        replacement = self.track(adapter)
        self.assertFalse(adapter.unregister_track(old))
        self.assertFalse(adapter.cancel_track(old))
        with self.assertRaises(UnknownTrackError):
            await self.submit(adapter, old, 2)
        fresh = await self.submit(adapter, replacement, 1, b"fresh")
        engines.release.set()
        self.assertEqual((await fresh).source_text, "fresh")
        self.assertTrue(future.cancelled())
        self.assertTrue(adapter.is_current(replacement))
        self.assertEqual([item.source_text for item in results], ["fresh"])

    async def test_reconnect_rejects_old_registration_leave_submit_and_output(self):
        adapter, engines, results = self.make()
        engines.block = True
        old_session, old = adapter.session, self.track(adapter)
        active = await self.submit(adapter, old, 1, b"old")
        await engines.started.wait()
        queued = await self.submit(adapter, old, 2, b"queued")
        new_session = adapter.reconnect(old_session)
        with self.assertRaises(StaleFrameError):
            adapter.register_track(old.participant, "t", "en", "ru")
        with self.assertRaises(StaleFrameError):
            adapter.register_participant("p", session=old_session)
        new = self.track(adapter)
        self.assertEqual(adapter.participant_left(old.participant), 0)
        self.assertFalse(await adapter.room_left(old_session))
        self.assertFalse(adapter.disconnect(old_session))
        self.assertIs(adapter.session, new_session)
        with self.assertRaises(UnknownTrackError):
            await self.submit(adapter, old, 3)
        fresh = await self.submit(adapter, new, 1, b"fresh")
        engines.release.set()
        self.assertEqual((await fresh).track_handle.session, new_session)
        self.assertTrue(active.cancelled())
        self.assertTrue(queued.cancelled())
        self.assertEqual([item.source_text for item in results], ["fresh"])

    async def test_participant_leave_removes_all_its_tracks_only(self):
        adapter, engines, results = self.make(queue_size=3)
        engines.block = True
        a, b, other = self.track(adapter, "p", "a"), self.track(adapter, "p", "b"), self.track(adapter, "other")
        active = await self.submit(adapter, a, 1, b"a")
        await engines.started.wait()
        queued = await self.submit(adapter, b, 1, b"b")
        surviving = await self.submit(adapter, other, 1, b"survive")
        self.assertEqual(adapter.participant_left(a.participant), 2)
        self.assertEqual(adapter.stats["tracks"], 1)
        engines.release.set()
        await surviving
        self.assertTrue(active.cancelled())
        self.assertTrue(queued.cancelled())
        self.assertEqual([item.source_text for item in results], ["survive"])

    async def test_uncooperative_engine_quarantines_one_buffer_and_fails_closed(self):
        started, release = asyncio.Event(), asyncio.Event()
        async def resistant(*args):
            started.set()
            while not release.is_set():
                try:
                    await release.wait()
                except asyncio.CancelledError:
                    pass
            return "late"
        adapter, _, results = self.make(cancellation_grace_seconds=.025)
        adapter._asr = resistant
        handle = self.track(adapter)
        future = await self.submit(adapter, handle, 1, b"held")
        await started.wait()
        started_at = asyncio.get_running_loop().time()
        with self.assertRaises(EngineShutdownError):
            await adapter.close()
        self.assertLess(asyncio.get_running_loop().time() - started_at, .5)
        self.assertTrue(future.cancelled())
        self.assertTrue(adapter.stats["closed"])
        self.assertEqual(adapter.stats["buffered_bytes"], 4)
        for i in range(50):
            with self.assertRaises(RuntimeError):
                await self.submit(adapter, handle, i + 2)
        self.assertEqual(sum(task.get_name() == "translation-pipeline" for task in asyncio.all_tasks()), 1)
        release.set()
        await self.idle(adapter)
        self.assertEqual(adapter.stats["buffered_bytes"], 0)
        self.assertEqual(results, [])

    async def test_history_stays_constant_after_many_completed_utterances(self):
        adapter, engines, results = self.make()
        handle = self.track(adapter)
        tracemalloc.start()
        try:
            for sequence in range(1, 1201):
                data = f"{sequence:08d}".encode() + b"x" * 4096
                future = await self.submit(adapter, handle, sequence, data)
                await future
                await self.idle(adapter)
                engines.calls.clear()
                results.clear()
                if sequence == 100:
                    gc.collect()
                    baseline = tracemalloc.get_traced_memory()[0]
            del future, data
            await asyncio.sleep(0)
            gc.collect()
            retained = tracemalloc.get_traced_memory()[0] - baseline
            self.assertLess(retained, 200_000)
        finally:
            tracemalloc.stop()
        self.assertEqual(adapter.stats["revision_entries"], 0)
        self.assertEqual(adapter.stats["buffered_bytes"], 0)
        self.assertEqual(adapter.stats["tracks"], 1)
        with self.assertRaises(StaleFrameError):
            await self.submit(adapter, handle, 1, revision=999)

    async def test_track_and_playback_metadata_are_bounded(self):
        adapter, _, _ = self.make(max_tracks=2, max_participants=1,
                                  max_playback_ids=2, playback_ttl_seconds=.02)
        first, second = self.track(adapter, "p", "a"), self.track(adapter, "p", "b")
        with self.assertRaises(BackpressureError):
            self.track(adapter, "p", "c")
        adapter.unregister_track(second)
        with self.assertRaises(BackpressureError):
            self.track(adapter, "other")
        adapter.unregister_track(first)
        for i in range(1000):
            handle = self.track(adapter, "p", f"track-{i}")
            adapter.unregister_track(handle)
        self.assertEqual(adapter.stats["tracks"], 0)
        for token in ("one", "two"):
            adapter.mark_tts_playback(token, session=adapter.session)
        with self.assertRaises(BackpressureError):
            adapter.mark_tts_playback("three", session=adapter.session)
        await asyncio.sleep(.03)
        adapter.mark_tts_playback("three", session=adapter.session)
        self.assertEqual(adapter.stats["playback_ids"], 1)
        adapter.reconnect(adapter.session)
        self.assertEqual(adapter.stats["playback_ids"], 0)


if __name__ == "__main__":
    unittest.main()
