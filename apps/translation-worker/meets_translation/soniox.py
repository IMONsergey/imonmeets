import asyncio
import base64
import binascii
from contextlib import AsyncExitStack
from dataclasses import dataclass, asdict, field
import json
import re
import time
import socket
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
    stt_connect_ms: float | None = None
    tts_connect_ms: float | None = None
    first_source_ms: float | None = None
    input_finished_ms: float | None = None
    stt_finished_ms: float | None = None
    speech_enabled: bool = True
    synthesis: list = field(default_factory=list)

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
    """Preserve final text. Never cut a sentence merely because a timer expired.

    Periods need lookahead: token boundaries may split decimals or abbreviations.
    Explicit endpoints and end-of-input can flush an otherwise ambiguous tail.
    The caller bounds incomplete text by age and total character limits.
    """
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

    def ready(self):
        # Only unambiguous non-period sentence punctuation can flush without
        # lookahead. A trailing period is retained until endpoint/next text.
        return bool(re.search(r"[!?。！？؟]\s*$", self.text))

    def boundary_before(self, text):
        if not self.text or not text or not text[0].isspace():
            return False
        tail = self.text.rstrip()
        if not tail.endswith("."):
            return False
        word = tail.split()[-1]
        # Conservative: initials, short abbreviations and numeric tails wait
        # for a provider endpoint. Never invent punctuation or corrected words.
        return len(word) > 4 and word.count(".") == 1 and not word[-2].isdigit()

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
                # An explicitly original-language endpoint is not a target
                # endpoint. Unlabelled markers are session endpoint markers.
                if token.get("translation_status") != "original":
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
            if self.boundary_before(text):
                result.append(self.take())
            if self.born is None:
                self.born = now
            self.text += text
            if self.ready():
                result.append(self.take())
        return result


class SonioxPipeline:
    def __init__(self, settings, source, target, *, connector=None, clock=time.monotonic, speech=True):
        validate_route(source, target)
        self.settings, self.source, self.target = settings, source, target
        self.connector, self.clock = connector, clock
        self.speech = speech
        self.metrics = Metrics(speech_enabled=speech)
        self.used = False

    async def run(self, audio, on_audio, on_text=None, *, on_source=None, on_translation=None):
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
                    max_queue=8, ping_interval=20, ping_timeout=10, proxy=None,
                    happy_eyeballs_delay=0.25, interleave=1)
        if self.settings.ip_family == "ipv4":
            # Per-worker choice for hosts with a broken IPv6/DNS path. Keep
            # hostname resolution and TLS verification; never pin provider IPs.
            opts["family"] = socket.AF_INET
        queue = asyncio.Queue(maxsize=8)
        segments = Segmenter(self.target, self.settings.max_text_chars)
        input_done = asyncio.Event()
        input_ended_at = None
        tasks = []
        async with AsyncExitStack() as stack:
            try:
                async with asyncio.timeout(self.settings.max_wall_seconds):
                    async def open_connection(url, service):
                        connected_at = self.clock()
                        try:
                            connection = await stack.enter_async_context(self.connector(url, **opts))
                            setattr(self.metrics, service.lower() + "_connect_ms",
                                    (self.clock() - connected_at) * 1000)
                            return connection
                        except TimeoutError:
                            raise PilotError(f"{service}_CONNECT_TIMEOUT") from None

                    stt = await open_connection(STT_URL, "STT")
                    stt_config = {
                        "model": self.settings.stt_model, "audio_format": "pcm_s16le",
                        "sample_rate": 16000, "num_channels": 1,
                        "language_hints": [self.source], "language_hints_strict": True,
                        "enable_language_identification": True,
                        "enable_endpoint_detection": True,
                        "max_endpoint_delay_ms": self.settings.endpoint_delay_ms,
                        "translation": {"type": "one_way", "target_language": self.target},
                    }
                    if self.settings.context is not None:
                        stt_config["context"] = self.settings.context
                    await stt.send(json.dumps(stt_config))

                    def enqueue(item):
                        if item is None or not self.speech:
                            return
                        try:
                            queue.put_nowait((*item, self.clock()))
                        except asyncio.QueueFull:
                            raise PilotError("TRANSLATION_BACKLOG") from None

                    async def feed():
                        nonlocal input_ended_at
                        async for pcm in audio:
                            if not isinstance(pcm, bytes) or not pcm or len(pcm) % 2 or len(pcm) > 32000:
                                raise PilotError("INVALID_PCM_FRAME")
                            if self.metrics.input_bytes + len(pcm) > self.settings.max_input_seconds * 32000:
                                raise PilotError("INPUT_AUDIO_LIMIT")
                            self.metrics.input_bytes += len(pcm)
                            await stt.send(pcm)
                        await stt.send("")  # Empty TEXT, not empty binary.
                        input_ended_at = self.clock()
                        self.metrics.input_finished_ms = (input_ended_at - started) * 1000
                        input_done.set()

                    async def receive():
                        while True:
                            now = self.clock()
                            if input_ended_at is not None and now - input_ended_at > 10:
                                raise PilotError("STT_DRAIN_TIMEOUT")
                            if self.speech and segments.born is not None and now - segments.born > self.settings.queue_seconds:
                                raise PilotError("INCOMPLETE_TRANSLATION_STALE")
                            try:
                                raw = await asyncio.wait_for(stt.recv(), 0.15)
                            except TimeoutError:
                                continue
                            data = message(raw)
                            ready = segments.feed(data.get("tokens", []), self.clock())
                            if on_translation is not None:
                                translated = "".join(t.get("text", "") for t in data.get("tokens", [])
                                    if t.get("is_final") is True
                                    and t.get("translation_status") == "translation"
                                    and t.get("text") not in ("<end>", "<fin>"))
                                if translated:
                                    await on_translation(translated)
                            original = "".join(t.get("text", "") for t in data.get("tokens", [])
                                if t.get("is_final") is True
                                and t.get("translation_status") != "translation"
                                and t.get("text") not in ("<end>", "<fin>"))
                            if original:
                                if self.metrics.first_source_ms is None:
                                    self.metrics.first_source_ms = (self.clock() - started) * 1000
                                if on_source is not None:
                                    await on_source(original)
                            self.metrics.translated_chars = segments.total
                            if segments.total and self.metrics.first_translation_ms is None:
                                self.metrics.first_translation_ms = (self.clock() - started) * 1000
                            for item in ready:
                                enqueue(item)
                            if data.get("finished") is True:
                                if not input_done.is_set():
                                    raise PilotError("STT_FINISHED_EARLY")
                                self.metrics.stt_finished_ms = (self.clock() - started) * 1000
                                enqueue(segments.take())
                                if self.speech:
                                    await asyncio.wait_for(queue.put(None), self.settings.queue_seconds)
                                return

                    async def speak():
                        if not self.speech:
                            return
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
                            text, born, queued_at = item
                            dequeued_at = self.clock()
                            age = dequeued_at - born
                            trace = {"index": len(self.metrics.synthesis) + 1,
                                     "chars": len(text), "assembly_ms": (queued_at - born) * 1000,
                                     "queue_wait_ms": (dequeued_at - queued_at) * 1000,
                                     "text_age_at_dequeue_ms": age * 1000,
                                     "request_ms": None, "first_chunk_ms": None,
                                     "first_chunk_text_age_ms": None, "completion_ms": None,
                                     "received_audio_bytes": 0, "accepted_audio_bytes": 0,
                                     "status": "pending"}
                            self.metrics.synthesis.append(trace)
                            self.metrics.max_queue_age_ms = max(self.metrics.max_queue_age_ms, age * 1000)
                            if age > self.settings.queue_seconds:
                                trace["status"] = "stale_before_request"
                                raise PilotError("STALE_TRANSLATION")
                            if on_text is not None:
                                await on_text(text)
                            if tts is None:
                                tts = await open_connection(TTS_URL, "TTS")
                            stream_id = str(uuid.uuid4())
                            self.metrics.synthesis_streams += 1
                            requested_at = self.clock()
                            trace["request_ms"] = (requested_at - started) * 1000
                            trace["status"] = "requested"
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
                                        trace["received_audio_bytes"] += len(pcm)
                                        if pcm and trace["first_chunk_ms"] is None:
                                            trace["first_chunk_ms"] = (self.clock() - requested_at) * 1000
                                            trace["first_chunk_text_age_ms"] = (self.clock() - born) * 1000
                                        if pcm and not got_audio and self.clock() - born > self.settings.queue_seconds:
                                            trace["status"] = "stale_first_chunk"
                                            raise PilotError("STALE_TRANSLATION")
                                        if self.metrics.output_bytes + len(pcm) > self.settings.max_output_seconds * 48000:
                                            raise PilotError("OUTPUT_AUDIO_LIMIT")
                                        self.metrics.output_bytes += len(pcm)
                                        trace["accepted_audio_bytes"] += len(pcm)
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
                                        trace["status"] = "completed"
                                        trace["completion_ms"] = (self.clock() - requested_at) * 1000
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
