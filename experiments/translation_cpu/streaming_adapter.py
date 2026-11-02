"""Isolated async streaming orchestration adapter. No LiveKit/network integration."""
from __future__ import annotations
import asyncio
from dataclasses import dataclass
from typing import Callable

class BackpressureError(RuntimeError): pass
class StaleFrameError(RuntimeError): pass
class UnknownTrackError(RuntimeError): pass

@dataclass(frozen=True)
class Route:
    participant_id: str
    track_id: str
    source_language: str
    target_language: str

@dataclass(frozen=True)
class TranslationResult:
    participant_id: str
    track_id: str
    sequence: int
    source_text: str
    translated_text: str
    audio: bytes

@dataclass
class _Work:
    route: Route
    sequence: int
    generation: int
    audio: bytes
    future: asyncio.Future

class TranslationStreamAdapter:
    """Bounded single-worker pipeline with per-track freshness and cancellation."""
    def __init__(self, asr, mt, tts, *, queue_size=4, on_result: Callable | None=None):
        if queue_size < 1: raise ValueError("queue_size must be positive")
        self._asr, self._mt, self._tts = asr, mt, tts
        self._queue = asyncio.Queue(maxsize=queue_size)
        self._routes, self._sequences, self._generations, self._active = {}, {}, {}, {}
        self._playback_ids = set()
        self._on_result, self._worker, self._closed = on_result, None, False

    def register_track(self, participant_id, track_id, source_language, target_language):
        if self._closed: raise RuntimeError("adapter is closed")
        if not all((participant_id, track_id, source_language, target_language)):
            raise ValueError("participant, track and language IDs are required")
        key = (participant_id, track_id)
        if key in self._routes: raise ValueError("track is already registered")
        self._routes[key] = Route(*key, source_language, target_language)
        self._sequences[key], self._generations[key] = 0, 0

    def mark_tts_playback(self, playback_id):
        if not playback_id: raise ValueError("playback_id is required")
        self._playback_ids.add(playback_id)

    async def submit(self, participant_id, track_id, audio, *, playback_id=None):
        if self._closed: raise RuntimeError("adapter is closed")
        key = (participant_id, track_id)
        route = self._routes.get(key)
        if route is None: raise UnknownTrackError(f"unregistered participant/track: {key}")
        if playback_id is not None and playback_id in self._playback_ids: return None
        if not audio: raise ValueError("audio frame must not be empty")
        if self._queue.full(): raise BackpressureError("translation queue is full")
        seq = self._sequences[key] + 1
        future = asyncio.get_running_loop().create_future()
        self._queue.put_nowait(_Work(route, seq, self._generations[key], bytes(audio), future))
        self._sequences[key] = seq
        return future

    def start(self):
        if self._closed: raise RuntimeError("adapter is closed")
        if self._worker is None: self._worker = asyncio.create_task(self._run())

    def cancel_track(self, participant_id, track_id):
        key = (participant_id, track_id)
        if key not in self._routes: raise UnknownTrackError(f"unregistered participant/track: {key}")
        self._generations[key] += 1
        task = self._active.get(key)
        if task is not None: task.cancel()

    async def close(self):
        if self._closed: return
        self._closed = True
        for task in tuple(self._active.values()): task.cancel()
        if self._worker is not None:
            self._worker.cancel()
            try: await self._worker
            except asyncio.CancelledError: pass
        while not self._queue.empty():
            work = self._queue.get_nowait()
            if not work.future.done(): work.future.cancel()
            self._queue.task_done()

    def _fresh(self, work):
        key = (work.route.participant_id, work.route.track_id)
        return self._generations.get(key) == work.generation and self._sequences.get(key) == work.sequence

    async def _pipeline(self, work):
        key = (work.route.participant_id, work.route.track_id)
        try:
            if not self._fresh(work): raise StaleFrameError("frame superseded before ASR")
            source = await self._asr(work.audio, work.route.source_language)
            if not self._fresh(work): raise StaleFrameError("frame superseded after ASR")
            translated = await self._mt(source, work.route.source_language, work.route.target_language)
            if not self._fresh(work): raise StaleFrameError("frame superseded after MT")
            speech = await self._tts(translated, work.route.target_language)
            if not self._fresh(work): raise StaleFrameError("frame superseded during TTS")
            result = TranslationResult(work.route.participant_id, work.route.track_id,
                                       work.sequence, source, translated, speech)
            if self._on_result is not None: self._on_result(result)
            if not work.future.done(): work.future.set_result(result)
        except asyncio.CancelledError:
            if not work.future.done(): work.future.cancel()
            raise
        except Exception as exc:
            if not work.future.done(): work.future.set_exception(exc)
        finally:
            self._active.pop(key, None)

    async def _run(self):
        while True:
            work = await self._queue.get()
            key = (work.route.participant_id, work.route.track_id)
            try:
                if not self._fresh(work):
                    if not work.future.done(): work.future.set_exception(StaleFrameError("frame superseded in queue"))
                    continue
                task = asyncio.create_task(self._pipeline(work))
                self._active[key] = task
                try:
                    await task
                except asyncio.CancelledError:
                    # A task cancelled before its coroutine first runs cannot settle its future itself.
                    if not work.future.done(): work.future.cancel()
                    if self._closed: raise
            finally:
                self._queue.task_done()
