import asyncio
import base64
import binascii
from contextlib import AsyncExitStack
from dataclasses import dataclass, asdict
import json
import re
import time
import uuid
from .config import PilotError, STT_URL, TTS_URL, validate_route


@dataclass
class Metrics:
    input_bytes: int = 0
    output_bytes: int = 0
    translated_chars: int = 0
    synthesis_streams: int = 0
    first_translation_ms: float | None = None
    first_audio_ms: float | None = None
    max_queue_age_ms: float = 0

    def receipt(self):
        return {**asdict(self), "input_seconds": self.input_bytes / 32000,
                "output_seconds": self.output_bytes / 48000,
                "timing_scope": "since_pipeline_start_not_listener_latency"}


def message(raw):
    if not isinstance(raw, str) or len(raw) > 1_048_576:
        raise PilotError("INVALID_PROVIDER_MESSAGE")
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        raise PilotError("INVALID_PROVIDER_MESSAGE") from None
    if not isinstance(data, dict):
        raise PilotError("INVALID_PROVIDER_MESSAGE")
    if data.get("error_code") or data.get("error_type"):
        # The provider's error_message can contain user text. Never log it.
        raise PilotError("SONIOX_PROVIDER_ERROR")
    return data


class Segmenter:
    """Only final translation tokens can enter speech. Partial tokens never do."""
    def __init__(self, target, limit):
        self.target, self.limit = target, limit
        self.text = ""
        self.born = None
        self.total = 0

    def take(self):
        if not self.text:
            return None
        item = (self.text, self.born)
        self.text, self.born = "", None
        return item

    def feed(self, tokens, now):
        if not isinstance(tokens, list) or len(tokens) > 4096:
            raise PilotError("INVALID_PROVIDER_TOKENS")
        result = []
        for token in tokens:
            if not isinstance(token, dict):
                raise PilotError("INVALID_PROVIDER_TOKEN")
            if token.get("is_final") is not True:
                continue
            text = token.get("text", "")
            if not isinstance(text, str):
                raise PilotError("INVALID_PROVIDER_TOKEN")
            if text in ("<end>", "<fin>"):
                item = self.take()
                if item:
                    result.append(item)
                continue
            if token.get("translation_status") != "translation":
                continue
            if token.get("language") != self.target:
                raise PilotError("UNEXPECTED_TRANSLATION_LANGUAGE")
            if not text:
                continue
            self.total += len(text)
            if self.total > self.limit:
                raise PilotError("TRANSLATED_TEXT_LIMIT")
            if self.born is None:
                self.born = now
            self.text += text
            if len(self.text) >= 240 or re.search(r"[.!?。！？؟]\s*$", self.text):
                result.append(self.take())
        return result


class SonioxPipeline:
    def __init__(self, settings, source, target, *, connector=None, clock=time.monotonic):
        validate_route(source, target)
        self.settings, self.source, self.target = settings, source, target
        self.connector, self.clock = connector, clock
        self.metrics = Metrics()
        self.used = False

    async def run(self, audio, on_audio, on_text=None):
        """16000 Hz mono PCM16 input -> 24000 Hz mono PCM16 output callbacks.

        The caller owns durable reservation, lifetime, consent and output storage.
        No retry or audio replay: uncertain network failures stop the pilot.
        """
        self.settings.require_enabled()
        if self.used:
            raise PilotError("PIPELINE_ALREADY_USED")
        self.used = True
        if self.connector is None:
            from websockets.asyncio.client import connect
            self.connector = connect
        started = self.clock()
        opts = dict(additional_headers={"Authorization": f"Bearer {self.settings.api_key}"},
                    open_timeout=8, close_timeout=2, max_size=1_048_576,
                    max_queue=8, ping_interval=20, ping_timeout=10, proxy=None)
        queue = asyncio.Queue(maxsize=8)
        segments = Segmenter(self.target, self.settings.max_text_chars)
        input_done = asyncio.Event()
        tasks = []
        async with AsyncExitStack() as stack:
            try:
                async with asyncio.timeout(self.settings.max_wall_seconds):
                    stt = await stack.enter_async_context(self.connector(STT_URL, **opts))
                    await stt.send(json.dumps({
                        "model": self.settings.stt_model, "audio_format": "pcm_s16le",
                        "sample_rate": 16000, "num_channels": 1,
                        "language_hints": [self.source], "language_hints_strict": True,
                        "enable_language_identification": True,
                        "enable_endpoint_detection": True, "max_endpoint_delay_ms": 500,
                        "translation": {"type": "one_way", "target_language": self.target},
                    }))

                    def enqueue(item):
                        if item is None:
                            return
                        try:
                            queue.put_nowait(item)
                        except asyncio.QueueFull:
                            raise PilotError("TRANSLATION_BACKLOG") from None

                    async def feed():
                        async for pcm in audio:
                            if not isinstance(pcm, bytes) or not pcm or len(pcm) % 2 or len(pcm) > 32000:
                                raise PilotError("INVALID_PCM_FRAME")
                            if self.metrics.input_bytes + len(pcm) > self.settings.max_input_seconds * 32000:
                                raise PilotError("INPUT_AUDIO_LIMIT")
                            self.metrics.input_bytes += len(pcm)
                            await stt.send(pcm)
                        await stt.send("")  # Empty TEXT, not empty binary.
                        input_done.set()

                    async def receive():
                        ended_at = None
                        while True:
                            try:
                                raw = await asyncio.wait_for(stt.recv(), 0.15)
                            except TimeoutError:
                                if segments.born is not None and self.clock() - segments.born >= 0.75:
                                    enqueue(segments.take())
                                if input_done.is_set():
                                    ended_at = ended_at or self.clock()
                                    if self.clock() - ended_at > 10:
                                        raise PilotError("STT_DRAIN_TIMEOUT")
                                continue
                            data = message(raw)
                            for item in segments.feed(data.get("tokens", []), self.clock()):
                                enqueue(item)
                            self.metrics.translated_chars = segments.total
                            if segments.total and self.metrics.first_translation_ms is None:
                                self.metrics.first_translation_ms = (self.clock() - started) * 1000
                            if segments.born is not None and self.clock() - segments.born >= 0.75:
                                enqueue(segments.take())
                            if data.get("finished") is True:
                                if not input_done.is_set():
                                    raise PilotError("STT_FINISHED_EARLY")
                                enqueue(segments.take())
                                await asyncio.wait_for(queue.put(None), self.settings.queue_seconds)
                                return

                    async def speak():
                        tts = None
                        while True:
                            try:
                                item = await asyncio.wait_for(queue.get(), 20)
                            except TimeoutError:
                                if tts is not None:
                                    await tts.send(json.dumps({"keep_alive": True}))
                                continue
                            if item is None:
                                return
                            text, born = item
                            age = self.clock() - born
                            self.metrics.max_queue_age_ms = max(self.metrics.max_queue_age_ms, age * 1000)
                            if age > self.settings.queue_seconds:
                                raise PilotError("STALE_TRANSLATION")
                            if on_text is not None:
                                await on_text(text)
                            if tts is None:
                                tts = await stack.enter_async_context(self.connector(TTS_URL, **opts))
                            stream_id = str(uuid.uuid4())
                            self.metrics.synthesis_streams += 1
                            await tts.send(json.dumps({
                                "stream_id": stream_id, "model": self.settings.tts_model,
                                "language": self.target, "voice": self.settings.voice,
                                "audio_format": "pcm_s16le", "sample_rate": 24000,
                            }))
                            await tts.send(json.dumps({"stream_id": stream_id, "text": text, "text_end": True}))
                            audio_ended = False
                            got_audio = False
                            async with asyncio.timeout(20):
                                while True:
                                    data = message(await tts.recv())
                                    if data.get("stream_id") != stream_id:
                                        raise PilotError("UNEXPECTED_TTS_STREAM")
                                    if data.get("audio"):
                                        if audio_ended:
                                            raise PilotError("AUDIO_AFTER_END")
                                        try:
                                            pcm = base64.b64decode(data["audio"], validate=True)
                                        except (ValueError, TypeError, binascii.Error):
                                            raise PilotError("INVALID_TTS_AUDIO") from None
                                        if len(pcm) % 2:
                                            raise PilotError("INVALID_TTS_AUDIO")
                                        if not got_audio and self.clock() - born > self.settings.queue_seconds:
                                            raise PilotError("STALE_TRANSLATION")
                                        if self.metrics.output_bytes + len(pcm) > self.settings.max_output_seconds * 48000:
                                            raise PilotError("OUTPUT_AUDIO_LIMIT")
                                        self.metrics.output_bytes += len(pcm)
                                        if pcm:
                                            got_audio = True
                                            if self.metrics.first_audio_ms is None:
                                                self.metrics.first_audio_ms = (self.clock() - started) * 1000
                                            await on_audio(pcm)
                                    if data.get("audio_end") is True:
                                        audio_ended = True
                                    if data.get("terminated") is True:
                                        if not audio_ended or not got_audio:
                                            raise PilotError("INCOMPLETE_TTS_STREAM")
                                        break

                    async def keepalive():
                        while True:
                            await asyncio.sleep(20)
                            if not input_done.is_set():
                                await stt.send('{"type":"keepalive"}')

                    # FIRST_EXCEPTION cancels siblings immediately on failure;
                    # successful feed/receive still allow the TTS drain to finish.
                    tasks = [asyncio.create_task(f()) for f in (feed, receive, speak)]
                    keeper = asyncio.create_task(keepalive())
                    tasks.append(keeper)
                    pending = set(tasks[:3])
                    while pending:
                        done, _ = await asyncio.wait(pending | {keeper}, return_when=asyncio.FIRST_COMPLETED)
                        for task in done:
                            task.result()
                            pending.discard(task)
                    return self.metrics
            except PilotError:
                raise
            except asyncio.CancelledError:
                raise
            except TimeoutError:
                raise PilotError("PIPELINE_TIMEOUT") from None
            except Exception:
                raise PilotError("PROVIDER_TRANSPORT_FAILED") from None
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
