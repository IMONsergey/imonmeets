import asyncio
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from streaming_adapter import BackpressureError, StaleFrameError, TranslationStreamAdapter as BoundedAdapter, UnknownTrackError

class TranslationStreamAdapter(BoundedAdapter):
    """Port the original ten assertions to the explicit source-handle contract.

    This trusted test source allocates monotonic sequences and fixed duration;
    production has no identity-only submit path or compatibility fallback.
    """
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.handles = {}
        self.source_sequences = {}
        self.utterance_sequences = {}

    def register_track(self, participant_id, track_id, source, target):
        self.handles[participant_id, track_id] = super().register_track(
            participant_id, track_id, source, target, session=self.session)

    async def submit(self, participant_id, track_id, audio, **kwargs):
        key = participant_id, track_id
        utterance_id = kwargs.get("utterance_id")
        utterance_key = (*key, utterance_id)
        if utterance_id is not None and utterance_key in self.utterance_sequences:
            sequence = self.utterance_sequences[utterance_key]
        else:
            sequence = self.source_sequences.get(key, 0) + 1
            self.source_sequences[key] = sequence
            if utterance_id is not None:
                self.utterance_sequences[utterance_key] = sequence
        return await super().submit(self.handles.get(key), audio, sequence=sequence,
                                    duration_seconds=.1, **kwargs)

    def cancel_track(self, participant_id, track_id):
        return super().cancel_track(self.handles.get((participant_id, track_id)))

    def mark_tts_playback(self, playback_id):
        return super().mark_tts_playback(playback_id, session=self.session)

class FakeEngines:
    def __init__(self):
        self.gate = None
        self.calls = []
    async def asr(self, audio, language):
        self.calls.append(("asr", audio, language))
        if self.gate is not None:
            await self.gate.wait()
        return audio.decode()
    async def mt(self, text, source, target):
        self.calls.append(("mt", source, target))
        return f"{source}>{target}:{text}"
    async def tts(self, text, language):
        self.calls.append(("tts", language))
        return text.encode()

class AdapterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engines = FakeEngines()
        self.results = []
        self.adapter = TranslationStreamAdapter(
            self.engines.asr, self.engines.mt, self.engines.tts,
            queue_size=2, on_result=self.results.append
        )
        self.adapter.register_track("p1", "mic-1", "en", "ru")
        self.adapter.register_track("p2", "mic-2", "zh", "en")
        self.adapter.start()

    async def asyncTearDown(self):
        await self.adapter.close()

    async def test_routes_participant_track_and_language(self):
        a = await self.adapter.submit("p1", "mic-1", b"hello")
        b = await self.adapter.submit("p2", "mic-2", b"nihao")
        x, y = await asyncio.gather(a, b)
        self.assertEqual((x.participant_id, x.track_id, x.translated_text),
                         ("p1", "mic-1", "en>ru:hello"))
        self.assertEqual((y.participant_id, y.track_id, y.translated_text),
                         ("p2", "mic-2", "zh>en:nihao"))

    async def test_unknown_identity(self):
        with self.assertRaises(UnknownTrackError):
            await self.adapter.submit("p1", "other", b"x")

    async def test_backpressure(self):
        self.engines.gate = asyncio.Event()
        a = await self.adapter.submit("p1", "mic-1", b"1")
        await asyncio.sleep(0)
        b = await self.adapter.submit("p2", "mic-2", b"2")
        c = await self.adapter.submit("p1", "mic-1", b"3")
        with self.assertRaises(BackpressureError):
            await self.adapter.submit("p2", "mic-2", b"4")
        self.engines.gate.set()
        await asyncio.gather(a, b, c, return_exceptions=True)

    async def test_independent_utterances_on_one_track_preserve_order_and_negation(self):
        self.engines.gate = asyncio.Event()
        first = await self.adapter.submit("p1", "mic-1", b"Do not pay.")
        await asyncio.sleep(0)
        second = await self.adapter.submit("p1", "mic-1", b"The amount is twelve thousand.")
        self.engines.gate.set()
        a, b = await asyncio.gather(first, second)
        self.assertEqual([a.source_text, b.source_text],
                         ["Do not pay.", "The amount is twelve thousand."])
        self.assertEqual([r.source_text for r in self.results],
                         ["Do not pay.", "The amount is twelve thousand."])

    async def test_newer_revision_supersedes_only_same_utterance(self):
        self.engines.gate = asyncio.Event()
        old = await self.adapter.submit("p1", "mic-1", b"Draft amount 100.",
                                        utterance_id="u-1", revision=1)
        await asyncio.sleep(0)
        new = await self.adapter.submit("p1", "mic-1", b"Corrected amount 12000.",
                                        utterance_id="u-1", revision=2)
        self.engines.gate.set()
        old_result, new_result = await asyncio.gather(old, new, return_exceptions=True)
        self.assertIsInstance(old_result, StaleFrameError)
        self.assertEqual(new_result.source_text, "Corrected amount 12000.")
        self.assertEqual([r.source_text for r in self.results], ["Corrected amount 12000."])

    async def test_backpressure_does_not_cancel_existing_revision(self):
        gate = asyncio.Event()
        results = []
        async def gated_asr(audio, language):
            await gate.wait()
            return audio.decode()
        adapter = TranslationStreamAdapter(
            gated_asr, self.engines.mt, self.engines.tts,
            queue_size=1, on_result=results.append
        )
        adapter.register_track("p", "t", "en", "ru")
        adapter.start()
        original = await adapter.submit("p", "t", b"Do not pay.",
                                        utterance_id="u-original", revision=1)
        await asyncio.sleep(0)
        queued = await adapter.submit("p", "t", b"Another utterance.")
        with self.assertRaises(BackpressureError):
            await adapter.submit("p", "t", b"Replacement revision.",
                                 utterance_id="u-original", revision=2)
        gate.set()
        a, b = await asyncio.gather(original, queued)
        self.assertEqual([a.source_text, b.source_text],
                         ["Do not pay.", "Another utterance."])
        self.assertEqual([item.source_text for item in results],
                         ["Do not pay.", "Another utterance."])
        await adapter.close()

    async def test_caller_future_cancel_prevents_publication(self):
        self.engines.gate = asyncio.Event()
        future = await self.adapter.submit("p1", "mic-1", b"caller cancelled")
        await asyncio.sleep(0)
        self.assertTrue(future.cancel())
        self.engines.gate.set()
        await asyncio.sleep(0.03)
        self.assertTrue(future.cancelled())
        self.assertEqual(self.results, [])

    async def test_cancel_track_releases_queued_capacity_and_finishes_futures(self):
        self.engines.gate = asyncio.Event()
        active = await self.adapter.submit("p1", "mic-1", b"active")
        await asyncio.sleep(0)
        queued = await self.adapter.submit("p1", "mic-1", b"queued")
        self.adapter.cancel_track("p1", "mic-1")
        self.assertTrue(queued.cancelled())
        fresh = await self.adapter.submit("p1", "mic-1", b"fresh after cancel")
        self.engines.gate.set()
        active_result, fresh_result = await asyncio.gather(active, fresh, return_exceptions=True)
        self.assertTrue(isinstance(active_result, asyncio.CancelledError) or active.cancelled())
        self.assertEqual(fresh_result.source_text, "fresh after cancel")

    async def test_close_blocks_cancellation_resistant_engine_publication(self):
        started = asyncio.Event()
        release = asyncio.Event()
        results = []
        async def resistant_tts(text, language):
            started.set()
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                await release.wait()
                return b"late synthesized audio"
        adapter = TranslationStreamAdapter(
            self.engines.asr, self.engines.mt, resistant_tts,
            queue_size=1, on_result=results.append
        )
        adapter.register_track("p", "track", "en", "ru")
        adapter.start()
        future = await adapter.submit("p", "track", b"input")
        await started.wait()
        closing = asyncio.create_task(adapter.close())
        await asyncio.sleep(0)
        release.set()
        await closing
        await asyncio.sleep(0.03)
        self.assertTrue(future.cancelled())
        self.assertEqual(results, [])

    async def test_tts_loopback_suppressed(self):
        self.adapter.mark_tts_playback("output-1")
        self.assertIsNone(await self.adapter.submit("p1", "mic-1", b"echo",
                                                    playback_id="output-1"))
        future = await self.adapter.submit("p1", "mic-1", b"real")
        self.assertEqual((await future).source_text, "real")

if __name__ == "__main__":
    unittest.main()
