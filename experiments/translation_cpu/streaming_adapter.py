"""Isolated async streaming orchestration adapter. No LiveKit/network integration."""
from __future__ import annotations

import asyncio
from collections import deque
from dataclasses import dataclass
from typing import Callable


class BackpressureError(RuntimeError):
    pass


class StaleFrameError(RuntimeError):
    pass


class UnknownTrackError(RuntimeError):
    pass


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
    utterance_id: str = ""
    revision: int = 1


@dataclass
class _Work:
    route: Route
    sequence: int
    session_generation: int
    utterance_id: str
    revision: int
    audio: bytes
    future: asyncio.Future
    cancelled: bool = False


class TranslationStreamAdapter:
    """FIFO utterance pipeline with per-utterance revisions and session cancellation.

    Each submit is an independent utterance unless the caller supplies an existing
    utterance_id with a higher revision. Track/session cancellation invalidates all
    utterances for that track. Cancelling the returned Future suppresses publication.
    """

    def __init__(self, asr, mt, tts, *, queue_size=4,
                 on_result: Callable[[TranslationResult], None] | None = None):
        if queue_size < 1:
            raise ValueError("queue_size must be positive")
        self._asr, self._mt, self._tts = asr, mt, tts
        self._queue: deque[_Work] = deque()
        self._queue_size = queue_size
        self._routes: dict[tuple[str, str], Route] = {}
        self._sequences: dict[tuple[str, str], int] = {}
        self._session_generations: dict[tuple[str, str], int] = {}
        self._latest_revisions: dict[tuple[str, str, str], int] = {}
        self._active_work: _Work | None = None
        self._active_task: asyncio.Task | None = None
        self._wake = asyncio.Event()
        self._playback_ids: set[str] = set()
        self._on_result = on_result
        self._worker: asyncio.Task | None = None
        self._closed = False

    def register_track(self, participant_id, track_id, source_language, target_language):
        if self._closed:
            raise RuntimeError("adapter is closed")
        if not all((participant_id, track_id, source_language, target_language)):
            raise ValueError("participant, track and language IDs are required")
        key = (participant_id, track_id)
        if key in self._routes:
            raise ValueError("track is already registered")
        self._routes[key] = Route(*key, source_language, target_language)
        self._sequences[key] = 0
        self._session_generations[key] = 0

    def mark_tts_playback(self, playback_id):
        if not playback_id:
            raise ValueError("playback_id is required")
        self._playback_ids.add(playback_id)

    async def submit(self, participant_id, track_id, audio, *, playback_id=None,
                     utterance_id=None, revision=1):
        if self._closed:
            raise RuntimeError("adapter is closed")
        key = (participant_id, track_id)
        route = self._routes.get(key)
        if route is None:
            raise UnknownTrackError(f"unregistered participant/track: {key}")
        if playback_id is not None and playback_id in self._playback_ids:
            return None
        if not audio:
            raise ValueError("audio frame must not be empty")
        if not isinstance(revision, int) or revision < 1:
            raise ValueError("revision must be a positive integer")
        seq = self._sequences[key] + 1
        if utterance_id is None:
            utterance_id = f"utterance-{seq}"
        if not isinstance(utterance_id, str) or not utterance_id:
            raise ValueError("utterance_id must be a non-empty string")
        revision_key = (*key, utterance_id)
        latest = self._latest_revisions.get(revision_key, 0)
        if revision <= latest:
            raise StaleFrameError(
                f"revision {revision} is not newer than {latest} for utterance {utterance_id}"
            )
        pending_other_utterances = sum(
            1 for item in self._queue
            if (item.route.participant_id, item.route.track_id, item.utterance_id) != revision_key
        )
        if pending_other_utterances >= self._queue_size:
            raise BackpressureError("translation queue is full")
        self._supersede_utterance(revision_key, revision)
        future = asyncio.get_running_loop().create_future()
        work = _Work(route, seq, self._session_generations[key], utterance_id,
                     revision, bytes(audio), future)
        self._queue.append(work)
        self._sequences[key] = seq
        self._latest_revisions[revision_key] = revision
        future.add_done_callback(lambda done, item=work: self._on_future_done(item, done))
        self._wake.set()
        return future

    def start(self):
        if self._closed:
            raise RuntimeError("adapter is closed")
        if self._worker is None:
            self._worker = asyncio.create_task(self._run())

    def cancel_track(self, participant_id, track_id):
        key = (participant_id, track_id)
        if key not in self._routes:
            raise UnknownTrackError(f"unregistered participant/track: {key}")
        self._session_generations[key] += 1
        self._cancel_queued(lambda item: (item.route.participant_id, item.route.track_id) == key)
        active = self._active_work
        if active is not None and (active.route.participant_id, active.route.track_id) == key:
            self._invalidate(active)
            task = self._active_task
            if task is not None:
                task.cancel()
        self._wake.set()

    async def close(self):
        if self._closed:
            return
        self._closed = True
        for key in self._session_generations:
            self._session_generations[key] += 1
        self._cancel_queued(lambda item: True)
        active = self._active_work
        if active is not None:
            self._invalidate(active)
        task = self._active_task
        if task is not None:
            task.cancel()
        self._wake.set()
        worker = self._worker
        if worker is not None:
            worker.cancel()
            # Do not await an engine that may suppress CancelledError indefinitely.
            # The closed/generation gate prevents any later stage or publication.

    def _on_future_done(self, work: _Work, future: asyncio.Future):
        if not future.cancelled():
            return
        work.cancelled = True
        self._remove_queued(work)
        if self._active_work is work and self._active_task is not None:
            self._active_task.cancel()
        self._wake.set()

    def _remove_queued(self, target: _Work):
        if not self._queue:
            return
        self._queue = deque(item for item in self._queue if item is not target)

    def _cancel_queued(self, predicate):
        kept = deque()
        for work in self._queue:
            if predicate(work):
                self._invalidate(work)
            else:
                kept.append(work)
        self._queue = kept

    def _supersede_utterance(self, revision_key, new_revision):
        def same_utterance(work):
            return (work.route.participant_id, work.route.track_id, work.utterance_id) == revision_key
        for work in tuple(self._queue):
            if same_utterance(work):
                self._invalidate(work, StaleFrameError(
                    f"utterance {work.utterance_id} superseded by revision {new_revision}"
                ))
                self._remove_queued(work)
        active = self._active_work
        if active is not None and same_utterance(active):
            self._invalidate(active, StaleFrameError(
                f"utterance {active.utterance_id} superseded by revision {new_revision}"
            ))
            if self._active_task is not None:
                self._active_task.cancel()

    @staticmethod
    def _invalidate(work: _Work, error: Exception | None = None):
        work.cancelled = True
        if not work.future.done():
            if error is None:
                work.future.cancel()
            else:
                work.future.set_exception(error)

    def _fresh(self, work: _Work):
        key = (work.route.participant_id, work.route.track_id)
        revision_key = (*key, work.utterance_id)
        return (
            not self._closed
            and not work.cancelled
            and not work.future.cancelled()
            and self._session_generations.get(key) == work.session_generation
            and self._latest_revisions.get(revision_key) == work.revision
        )

    async def _pipeline(self, work: _Work):
        try:
            if not self._fresh(work):
                raise StaleFrameError("utterance invalidated before ASR")
            source = await self._asr(work.audio, work.route.source_language)
            if not self._fresh(work):
                raise StaleFrameError("utterance invalidated after ASR")
            translated = await self._mt(source, work.route.source_language,
                                        work.route.target_language)
            if not self._fresh(work):
                raise StaleFrameError("utterance invalidated after MT")
            speech = await self._tts(translated, work.route.target_language)
            # Last gate is deliberately adjacent to the publication callback.
            if not self._fresh(work):
                raise StaleFrameError("utterance invalidated before publication")
            result = TranslationResult(
                work.route.participant_id, work.route.track_id, work.sequence,
                source, translated, speech, work.utterance_id, work.revision
            )
            if not self._fresh(work):
                raise StaleFrameError("session closed before publication")
            if self._on_result is not None:
                self._on_result(result)
            if not work.future.done():
                work.future.set_result(result)
        except asyncio.CancelledError:
            if not work.future.done():
                if self._closed or work.cancelled:
                    work.future.cancel()
                else:
                    work.future.cancel()
            raise
        except Exception as exc:
            if not work.future.done():
                work.future.set_exception(exc)

    async def _run(self):
        while not self._closed:
            if not self._queue:
                self._wake.clear()
                if not self._queue and not self._closed:
                    await self._wake.wait()
                continue
            work = self._queue.popleft()
            if not self._fresh(work):
                self._invalidate(work, StaleFrameError("utterance invalidated in queue"))
                continue
            task = asyncio.create_task(self._pipeline(work))
            self._active_work, self._active_task = work, task
            try:
                await task
            except asyncio.CancelledError:
                if self._closed:
                    raise
            finally:
                if self._active_task is task:
                    self._active_work, self._active_task = None, None
