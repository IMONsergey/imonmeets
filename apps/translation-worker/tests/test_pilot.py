import asyncio
import base64
from contextlib import closing, redirect_stdout
from dataclasses import replace
import io
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import wave

from meets_translation.budget import reserve
from meets_translation.cli import main, inspect_wav
from meets_translation.config import PilotError, ROUTES, Settings, STT_URL, TTS_URL, load_private_env
from meets_translation.livekit_bridge import JoinGrant
from meets_translation.soniox import Segmenter, SonioxPipeline, message


def final(text="Hello.", language="en", **kwargs):
    return dict(text=text, language=language, is_final=True, translation_status="translation", **kwargs)


class FakeSocket:
    def __init__(self, kind, tokens, tts_reply=None):
        self.kind, self.tokens, self.tts_reply = kind, tokens, tts_reply
        self.sent, self.closed = [], False
        self.responses = asyncio.Queue()
        self.text_received = asyncio.Event()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        self.closed = True

    async def send(self, raw):
        self.sent.append(raw)
        if self.kind == "stt" and raw == "":
            self.responses.put_nowait(json.dumps({"tokens": self.tokens, "finished": True}))
        elif self.kind == "tts":
            data = json.loads(raw)
            if "text" in data:
                self.text_received.set()
                sid = data["stream_id"]
                replies = self.tts_reply(sid) if self.tts_reply else [
                    {"stream_id": sid, "audio": base64.b64encode(b"\x01\x00" * 480).decode(), "audio_end": True},
                    {"stream_id": sid, "terminated": True},
                ]
                for reply in replies:
                    self.responses.put_nowait(json.dumps(reply))

    async def recv(self):
        return await self.responses.get()


class FakeProvider:
    def __init__(self, tokens=None, tts_reply=None):
        self.stt = FakeSocket("stt", tokens if tokens is not None else [final()])
        self.tts = FakeSocket("tts", [], tts_reply)
        self.calls = []

    def connect(self, url, **options):
        self.calls.append((url, options))
        return self.stt if url == STT_URL else self.tts


async def frames(*chunks):
    for chunk in chunks or (b"\x00\x00" * 320,):
        yield chunk


class PipelineTests(unittest.IsolatedAsyncioTestCase):
    async def run_pipeline(self, provider, settings=None, source="ru", target="en", chunks=None):
        output, text = [], []
        async def audio(pcm): output.append(pcm)
        async def transcript(value): text.append(value)
        pipeline = SonioxPipeline(settings or Settings(enabled=True, api_key="TEST_KEY"),
                                  source, target, connector=provider.connect)
        await pipeline.run(chunks or frames(), audio, transcript)
        return pipeline, output, text

    async def test_six_routes_auth_eos_and_audio(self):
        for source, target in ROUTES:
            with self.subTest(source=source, target=target):
                provider = FakeProvider([final(language=target)])
                pipeline, audio, text = await self.run_pipeline(provider, source=source, target=target)
                self.assertEqual(text, ["Hello."])
                self.assertEqual(sum(map(len, audio)), 960)
                self.assertEqual(provider.stt.sent[-1], "")
                config = json.loads(provider.stt.sent[0])
                self.assertNotIn("api_key", config)
                self.assertEqual(config["translation"]["target_language"], target)
                self.assertEqual(provider.calls[0][1]["additional_headers"]["Authorization"], "Bearer TEST_KEY")
                self.assertEqual([url for url, _ in provider.calls], [STT_URL, TTS_URL])
                self.assertTrue(provider.stt.closed and provider.tts.closed)
                self.assertEqual(pipeline.metrics.synthesis_streams, 1)

    async def test_only_final_translations_are_spoken(self):
        provider = FakeProvider([
            {**final("Wrong partial."), "is_final": False},
            {**final("Original."), "translation_status": "original"},
            final("Correct "), final("translation."), final("<end>"),
        ])
        _, _, text = await self.run_pipeline(provider)
        self.assertEqual(text, ["Correct translation."])

    async def test_source_diagnostics_keep_final_original_separate(self):
        provider = FakeProvider([
            {**final("Wrong partial."), "is_final": False, "translation_status": "original"},
            {**final("Original."), "translation_status": "original"},
            final("Translation."), final("<end>"),
        ])
        original, translated = [], []
        async def on_source(text): original.append(text)
        async def on_text(text): translated.append(text)
        async def on_audio(pcm): pass
        pipeline = SonioxPipeline(Settings(enabled=True, api_key="test"), "ru", "en", connector=provider.connect)
        await pipeline.run(frames(), on_audio, on_text, on_source=on_source)
        self.assertEqual(original, ["Original."])
        self.assertEqual(translated, ["Translation."])

    async def test_empty_translation_never_opens_tts(self):
        provider = FakeProvider([])
        _, audio, _ = await self.run_pipeline(provider)
        self.assertFalse(audio)
        self.assertEqual(len(provider.calls), 1)

    async def test_disabled_and_missing_key_make_no_calls(self):
        for settings in (Settings(), Settings(enabled=True)):
            provider = FakeProvider()
            with self.assertRaises(PilotError):
                await self.run_pipeline(provider, settings)
            self.assertFalse(provider.calls)

    async def test_connection_timeouts_identify_service_without_retry(self):
        class TimeoutConnection:
            async def __aenter__(self):
                raise TimeoutError("private transport detail")
            async def __aexit__(self, *args):
                pass
        for url, service in ((STT_URL, "STT"), (TTS_URL, "TTS")):
            with self.subTest(service=service):
                provider = FakeProvider()
                connect = provider.connect
                attempts = []
                def connector(current, **options):
                    attempts.append(current)
                    return TimeoutConnection() if current == url else connect(current, **options)
                provider.connect = connector
                with self.assertRaisesRegex(PilotError, f"^{service}_CONNECT_TIMEOUT$"):
                    await self.run_pipeline(provider)
                self.assertEqual(attempts.count(url), 1)

    async def test_unexpected_language_stops_before_tts(self):
        provider = FakeProvider([final(language="ar")])
        with self.assertRaisesRegex(PilotError, "UNEXPECTED_TRANSLATION_LANGUAGE"):
            await self.run_pipeline(provider)
        self.assertEqual(len(provider.calls), 1)
        self.assertTrue(provider.stt.closed)

    async def test_text_and_input_limits(self):
        cases = [
            (Settings(enabled=True, api_key="x", max_text_chars=3), frames(), "TRANSLATED_TEXT_LIMIT"),
            (Settings(enabled=True, api_key="x", max_input_seconds=1), frames(b"\x00" * 32000, b"\x00\x00"), "INPUT_AUDIO_LIMIT"),
            (Settings(enabled=True, api_key="x"), frames(b"x"), "INVALID_PCM_FRAME"),
        ]
        for settings, chunks, error in cases:
            with self.subTest(error=error), self.assertRaisesRegex(PilotError, error):
                await self.run_pipeline(FakeProvider(), settings, chunks=chunks)

    async def test_output_limit(self):
        provider = FakeProvider(tts_reply=lambda sid: [{"stream_id": sid, "audio": base64.b64encode(b"\x00" * 48002).decode()}])
        with self.assertRaisesRegex(PilotError, "OUTPUT_AUDIO_LIMIT"):
            await self.run_pipeline(provider, Settings(enabled=True, api_key="x", max_output_seconds=1))

    async def test_stream_protocol_failures_close_without_retry(self):
        cases = [
            (lambda sid: [{"stream_id": "wrong", "terminated": True}], "UNEXPECTED_TTS_STREAM"),
            (lambda sid: [{"stream_id": sid, "terminated": True}], "INCOMPLETE_TTS_STREAM"),
            (lambda sid: [{"stream_id": sid, "audio": "!!!"}], "INVALID_TTS_AUDIO"),
            (lambda sid: [{"error_code": 400, "error_message": "secret transcript TEST_KEY"}], "SONIOX_PROVIDER_ERROR"),
            (lambda sid: [{"stream_id": sid, "audio_end": True}, {"stream_id": sid, "audio": "AQE="}], "AUDIO_AFTER_END"),
        ]
        for reply, code in cases:
            with self.subTest(code=code):
                provider = FakeProvider(tts_reply=reply)
                with self.assertRaisesRegex(PilotError, "^" + code + "$"):
                    await self.run_pipeline(provider)
                self.assertEqual(len(provider.calls), 2)
                self.assertTrue(provider.stt.closed and provider.tts.closed)

    async def test_backlog_fails_closed(self):
        provider = FakeProvider([token for _ in range(9) for token in (final("Sentence."), final("<end>"))])
        with self.assertRaisesRegex(PilotError, "TRANSLATION_BACKLOG"):
            await self.run_pipeline(provider)

    async def test_cancellation_closes_sockets_and_stops_audio(self):
        provider = FakeProvider(tts_reply=lambda sid: [])
        task = asyncio.create_task(self.run_pipeline(provider))
        await asyncio.wait_for(provider.tts.text_received.wait(), 1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(provider.stt.closed and provider.tts.closed)
        self.assertEqual(len(provider.calls), 2)

    async def test_pipeline_cannot_be_replayed(self):
        provider = FakeProvider([])
        pipeline, _, _ = await self.run_pipeline(provider)
        with self.assertRaisesRegex(PilotError, "PIPELINE_ALREADY_USED"):
            await pipeline.run(frames(), None)


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name)
        self.settings = Settings(state_dir=self.path / "state", reservation_cents=50, budget_cents=100)

    def tearDown(self):
        self.temp.cleanup()

    def test_failed_attempt_stays_reserved_across_restarts(self):
        with self.assertRaisesRegex(RuntimeError, "failure"), reserve(self.settings):
            raise RuntimeError("failure")
        with reserve(self.settings):
            pass
        with self.assertRaisesRegex(PilotError, "BUDGET_EXHAUSTED"), reserve(self.settings):
            pass
        with closing(sqlite3.connect(self.settings.state_dir / "reservations.sqlite3")) as db:
            self.assertEqual(db.execute("SELECT status FROM attempts ORDER BY rowid").fetchall(), [("failed",), ("completed",)])

    def test_concurrent_pilot_is_blocked_before_reservation(self):
        with reserve(self.settings):
            with self.assertRaisesRegex(PilotError, "PILOT_ALREADY_RUNNING"), reserve(self.settings):
                pass
        with closing(sqlite3.connect(self.settings.state_dir / "reservations.sqlite3")) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM attempts").fetchone()[0], 1)

    def test_env_private_and_not_executed(self):
        path = self.path / "secret.env"
        path.write_text("SONIOX_API_KEY=$(never-execute)\n")
        path.chmod(0o600)
        self.assertEqual(load_private_env(path)["SONIOX_API_KEY"], "$(never-execute)")
        path.chmod(0o644)
        with self.assertRaisesRegex(PilotError, "PRIVATE"):
            load_private_env(path)

    def test_env_symlink_rejected(self):
        path = self.path / "secret.env"
        path.write_text("SONIOX_API_KEY=x\n")
        path.chmod(0o600)
        link = self.path / "link"
        link.symlink_to(path)
        with self.assertRaises(PilotError):
            load_private_env(link)

    def test_grant_private_and_host_allowlisted(self):
        path = self.path / "join.json"
        data = dict(serverUrl="wss://rtc.imon.world", roomName="test", identity="pilot", token="private")
        path.write_text(json.dumps(data))
        path.chmod(0o600)
        self.assertNotIn("private", repr(JoinGrant.read(path)))
        for url in ("wss://other.example", "wss://rtc.imon.world@other.example", "wss://rtc.imon.world?token=x"):
            data["serverUrl"] = url
            path.write_text(json.dumps(data))
            with self.assertRaises(PilotError):
                JoinGrant.read(path)

    def test_check_is_offline_and_redacts_key(self):
        output = io.StringIO()
        with patch.dict(os.environ, {"SONIOX_API_KEY": "DO_NOT_PRINT_THIS"}, clear=True), redirect_stdout(output):
            self.assertEqual(main(["check"]), 0)
        value = output.getvalue()
        self.assertNotIn("DO_NOT_PRINT_THIS", value)
        self.assertEqual(json.loads(value)["network_calls"], 0)

    def test_wav_format_and_dry_run_no_ledger(self):
        path = self.path / "input.wav"
        with wave.open(str(path), "wb") as wav:
            wav.setparams((1, 2, 16000, 0, "NONE", "none"))
            wav.writeframes(b"\x00" * 3200)
        output = io.StringIO()
        with patch.dict(os.environ, {"MEETS_TRANSLATION_STATE_DIR": str(self.settings.state_dir)}, clear=True), redirect_stdout(output):
            self.assertEqual(main(["wav", "--source", "ru", "--target", "en", "--input", str(path), "--output", str(self.path / "out")]), 0)
        self.assertEqual(json.loads(output.getvalue())["status"], "dry_run")
        self.assertFalse(self.settings.state_dir.exists())
        self.assertFalse((self.path / "out").exists())

    def test_no_raw_provider_error_or_secret_in_receipt(self):
        with self.assertRaises(PilotError) as caught:
            message('{"error_type":"bad","error_message":"SENSITIVE"}')
        self.assertNotIn("SENSITIVE", str(caught.exception))
        self.assertNotIn("PRIVATE_KEY", repr(Settings(api_key="PRIVATE_KEY")))


if __name__ == "__main__":
    unittest.main()
