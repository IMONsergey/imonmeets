import asyncio
from dataclasses import replace
import json
import unittest
import tempfile
import socket
from pathlib import Path

from meets_translation.config import Settings, PilotError, STT_URL, load_context
from meets_translation.cli import parser
from meets_translation.soniox import Segmenter, SonioxPipeline
from test_pilot import FakeProvider, final, frames


class SegmentationTests(unittest.TestCase):
    def test_decimal_and_abbreviation_survive_arbitrary_token_boundaries(self):
        for language, phrase in (("en", "Dr. Smith owes 12.50 dollars."),
                                 ("ru", "Цена 12,50 руб. за штуку."),
                                 ("zh", "价格12.50元。"),
                                 ("ar", "السعر 12.50 دولار؟")):
            with self.subTest(language=language):
                s = Segmenter(language, 200)
                parts = []
                for i, char in enumerate(phrase):
                    parts.extend(s.feed([final(char, language)], i / 10))
                parts.extend(s.feed([final("<end>", language)], 9))
                self.assertEqual([t for t, _ in parts], [phrase])

    def test_source_endpoint_does_not_cut_target_midword(self):
        s = Segmenter("en", 100)
        self.assertFalse(s.feed([final("The productiv")], 0))
        self.assertFalse(s.feed([{**final("<end>"), "translation_status": "original"}], 1))
        self.assertFalse(s.feed([final("ity increased.")], 2))
        self.assertEqual(s.feed([final("<end>")], 3), [("The productivity increased.", 0)])

    def test_no_fixed_length_or_age_cut_in_middle_of_phrase(self):
        s = Segmenter("en", 1000)
        self.assertFalse(s.feed([final("word " * 60)], 0))
        self.assertFalse(s.feed([final("keeps going")], 3))
        self.assertEqual(s.total, 311)
        self.assertEqual(s.take()[0], "word " * 60 + "keeps going")

    def test_lookahead_preserves_all_characters(self):
        s = Segmenter("en", 200)
        self.assertFalse(s.feed([final("First sentence.")], 0))
        self.assertEqual(s.feed([final(" Second sentence.")], 1), [("First sentence.", 0)])
        self.assertEqual(s.take(), (" Second sentence.", 1))

    def test_cli_speech_is_explicit_and_model_endpoint_are_validated(self):
        args = parser().parse_args(["wav", "--source", "ru", "--target", "en", "--input", "x", "--output", "y"])
        self.assertFalse(args.with_speech)
        self.assertEqual(Settings.from_env({}).endpoint_delay_ms, 2000)
        for env in ({"SONIOX_ENDPOINT_DELAY_MS": "499"}, {"SONIOX_ENDPOINT_DELAY_MS": "3001"},
                    {"SONIOX_STT_MODEL": "stt-unknown"}, {"SONIOX_IP_FAMILY": "guess"}):
            with self.assertRaises(PilotError):
                Settings.from_env(env)


class HardeningTests(unittest.IsolatedAsyncioTestCase):
    async def test_text_only_collects_translation_without_tts(self):
        provider = FakeProvider([final("Text."), final("<end>")])
        texts, speech = [], []
        async def text(chunk): texts.append(chunk)
        async def audio(chunk): speech.append(chunk)
        pipeline = SonioxPipeline(Settings(enabled=True, api_key="test"), "ru", "en",
                                  connector=provider.connect, speech=False)
        await pipeline.run(frames(), audio, on_translation=text)
        self.assertEqual(texts, ["Text."])
        self.assertFalse(speech)
        self.assertEqual([url for url, _ in provider.calls], [STT_URL])
        self.assertEqual(pipeline.metrics.synthesis_streams, 0)
        self.assertFalse(pipeline.metrics.speech_enabled)

    async def test_late_tts_records_latency_and_keeps_translation_but_no_audio(self):
        now = [0.0]
        provider = FakeProvider([final("Full translation."), final("<end>")])
        recv = provider.tts.recv
        async def late_recv():
            now[0] = 6.0
            return await recv()
        provider.tts.recv = late_recv
        texts, outputs = [], []
        async def text(chunk): texts.append(chunk)
        async def audio(chunk): outputs.append(chunk)
        pipeline = SonioxPipeline(Settings(enabled=True, api_key="test"), "ru", "en",
                                  connector=provider.connect, clock=lambda: now[0])
        with self.assertRaisesRegex(PilotError, "^STALE_TRANSLATION$"):
            await pipeline.run(frames(), audio, on_translation=text)
        self.assertEqual(texts, ["Full translation."])
        self.assertFalse(outputs)
        trace = pipeline.metrics.synthesis[0]
        self.assertEqual(trace["first_chunk_ms"], 6000)
        self.assertEqual(trace["first_chunk_text_age_ms"], 6000)
        self.assertEqual(trace["status"], "stale_first_chunk")
        self.assertGreater(trace["received_audio_bytes"], 0)
        self.assertEqual(trace["accepted_audio_bytes"], 0)

    async def test_continuous_empty_messages_cannot_evade_drain_deadline(self):
        now = [0.0]
        provider = FakeProvider([])
        async def forever():
            await asyncio.sleep(0)
            now[0] += 1
            return '{"tokens": []}'
        provider.stt.recv = forever
        pipeline = SonioxPipeline(Settings(enabled=True, api_key="test"), "ru", "en",
                                  connector=provider.connect, clock=lambda: now[0], speech=False)
        with self.assertRaisesRegex(PilotError, "^STT_DRAIN_TIMEOUT$"):
            await pipeline.run(frames(), None)
        self.assertTrue(provider.stt.closed)
        self.assertEqual(len(provider.calls), 1)

    async def test_incomplete_phrase_stops_without_speaking_fragment(self):
        now = [0.0]
        provider = FakeProvider([])
        count = 0
        async def partial():
            nonlocal count
            await asyncio.sleep(0)
            count += 1
            now[0] += 1
            return json.dumps({"tokens": [final("He did not yet")] if count == 1 else []})
        provider.stt.recv = partial
        pipeline = SonioxPipeline(Settings(enabled=True, api_key="test"), "ru", "en",
                                  connector=provider.connect, clock=lambda: now[0])
        with self.assertRaisesRegex(PilotError, "^INCOMPLETE_TRANSLATION_STALE$"):
            await pipeline.run(frames(), None)
        self.assertEqual(len(provider.calls), 1)
        self.assertTrue(provider.stt.closed)


class ContextTests(unittest.TestCase):
    def test_private_context_schema_caps_and_repr(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "context.json"
            value = {"general": [{"key": "domain", "value": "PRIVATE_TOPIC"}],
                     "terms": ["IMON"], "translation_terms": [{"source": "term", "target": "слово"}]}
            path.write_text(json.dumps(value))
            path.chmod(0o600)
            settings = Settings.from_env({"SONIOX_CONTEXT_FILE": str(path)})
            self.assertEqual(settings.context, value)
            self.assertNotIn("PRIVATE_TOPIC", repr(settings))
            path.chmod(0o644)
            with self.assertRaises(PilotError):
                load_context(path)
            path.chmod(0o600)
            for invalid in ({"unknown": []}, {"general": [{"key": "domain"}]},
                            {"terms": [1]}, {"text": "x" * 4001}, {"terms": ["x"] * 101}):
                path.write_text(json.dumps(invalid))
                with self.assertRaises(PilotError):
                    load_context(path)


class ContextTransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_only_explicit_context_reaches_provider(self):
        for context in (None, {"general": [{"key": "domain", "value": "economics"}]}):
            provider = FakeProvider([])
            p = SonioxPipeline(Settings(enabled=True, api_key="test", context=context), "ru", "en",
                               connector=provider.connect, speech=False)
            await p.run(frames(), None)
            config = json.loads(provider.stt.sent[0])
            if context is None:
                self.assertNotIn("context", config)
            else:
                self.assertEqual(config["context"], context)


class NetworkProfileTests(unittest.IsolatedAsyncioTestCase):
    async def test_ipv4_is_explicit_and_never_pins_provider_addresses(self):
        for family in ("auto", "ipv4"):
            provider = FakeProvider([])
            p = SonioxPipeline(Settings(enabled=True, api_key="test", ip_family=family), "ru", "en",
                               connector=provider.connect, speech=False)
            await p.run(frames(), None)
            url, opts = provider.calls[0]
            self.assertEqual(url, STT_URL)
            if family == "ipv4":
                self.assertEqual(opts["family"], socket.AF_INET)
            else:
                self.assertNotIn("family", opts)
            self.assertNotIn("host", opts)
            self.assertNotIn("ssl", opts)
