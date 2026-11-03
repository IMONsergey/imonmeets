"""Bounded, room-scoped utterance orchestration; no LiveKit/network/TTS engine.

One adapter owns its engine instances. Identity/sequence/duration are supplied by
the trusted room/audio boundary, not by untrusted browser metadata. Every callback
captures its RoomSession/TrackHandle so events from a previous connection cannot
act on a replacement track. Publication is a synchronous, generation-gated hook.
"""
from __future__ import annotations

import asyncio
import inspect
import math
import struct
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from typing import Callable

from process_stage import StageCleanupError
from quality_gate import QualityAssessment, assess_translation


class BackpressureError(RuntimeError):
    pass


class StaleFrameError(RuntimeError):
    pass


class UnknownTrackError(RuntimeError):
    pass


class DeadlineError(TimeoutError):
    pass


class EngineShutdownError(RuntimeError):
    pass


@dataclass(frozen=True, eq=False)
class RoomSession:
    room_id: str
    generation: int


@dataclass(frozen=True, eq=False)
class ParticipantHandle:
    session: RoomSession
    participant_id: str
    generation: int


@dataclass(frozen=True, eq=False)
class TrackHandle:
    session: RoomSession
    participant_id: str
    track_id: str
    source_language: str
    target_language: str
    generation: int
    participant: ParticipantHandle


@dataclass(frozen=True)
class TranslationResult:
    participant_id: str
    track_id: str
    sequence: int
    source_text: str
    translated_text: str
    audio: bytes
    utterance_id: str
    revision: int
    track_handle: TrackHandle
    quality: QualityAssessment

    @property
    def speech_blocked(self):
        return not self.quality.speech_allowed


@dataclass
class _TrackState:
    handle: TrackHandle
    last_sequence: int = 0


@dataclass
class _Work:
    handle: TrackHandle
    sequence: int
    utterance_id: str
    revision: int
    audio: bytes
    duration_seconds: float
    deadline: float
    queue_expires: float
    future: asyncio.Future
    invalidated: asyncio.Event = field(default_factory=asyncio.Event)
    cancelled: bool = False
    released: bool = False


def _positive(value, name, *, integer=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be positive and finite")
    if not math.isfinite(value) or value <= 0 or (integer and not isinstance(value, int)):
        raise ValueError(f"{name} must be positive and finite")
    return value


def _identifier(value, name):
    if not isinstance(value, str) or not value or len(value) > 128:
        raise ValueError(f"{name} must contain 1..128 characters")
    return value


def _wav_duration(audio, max_seconds):
    """A bounded whitelist for whole RIFF WAV, preserving the exact input bytes."""
    if len(audio) < 44 or audio[:4] != b"RIFF" or audio[8:12] != b"WAVE":
        raise ValueError("Expected little-endian RIFF/WAVE")
    if struct.unpack_from("<I", audio, 4)[0] + 8 != len(audio):
        raise ValueError("Truncated or trailing RIFF bytes")
    offset, chunks = 12, 0
    fmt = data = fact = None
    while offset < len(audio):
        chunks += 1
        if chunks > 64 or offset + 8 > len(audio):
            raise ValueError("WAV chunk limit/header")
        tag, size = struct.unpack_from("<4sI", audio, offset)
        start, end = offset + 8, offset + 8 + size
        if end + (size % 2) > len(audio):
            raise ValueError("Truncated WAV chunk")
        if tag == b"fmt ":
            if fmt is not None or data is not None or size not in (16, 18):
                raise ValueError("Ambiguous or unsupported WAV format chunk")
            if size == 18 and struct.unpack_from("<H", audio, start + 16)[0] != 0:
                raise ValueError("WAV format extensions are not supported")
            fmt = struct.unpack_from("<HHIIHH", audio, start)
        elif tag == b"data":
            if fmt is None or data is not None:
                raise ValueError("Expected one WAV data chunk after format")
            data = (start, end)
        elif tag == b"fact":
            if fact is not None or size != 4:
                raise ValueError("Ambiguous WAV frame-count chunk")
            fact = struct.unpack_from("<I", audio, start)[0]
        offset = end + (size % 2)
    if fmt is None or data is None:
        raise ValueError("Missing WAV format/data")
    encoding, channels, rate, byte_rate, alignment, bits = fmt
    if channels != 1 or rate != 16000 or (encoding, bits) not in ((1, 16), (3, 32)):
        raise ValueError("Only mono 16kHz PCM16 or IEEE-float32 WAV is accepted")
    if alignment != bits // 8 or byte_rate != rate * alignment:
        raise ValueError("Inconsistent WAV block/byte rate")
    size = data[1] - data[0]
    if not size or size % alignment:
        raise ValueError("Incomplete WAV samples")
    frames = size // alignment
    if fact is not None and fact != frames:
        raise ValueError("WAV fact/data frame-count mismatch")
    duration = frames / rate
    if duration > max_seconds:
        raise ValueError("WAV duration limit")
    if encoding == 3 and any(not math.isfinite(value[0]) for value in struct.iter_unpack("<f", memoryview(audio)[data[0]:data[1]])):
        raise ValueError("WAV samples must be finite")
    return duration


class TranslationStreamAdapter:
    """Single active pipeline, fair participant queue and bounded retained state.

    New utterances require a strictly increasing source sequence per track handle.
    A higher revision may replace only an unfinished utterance with that sequence.
    Completed sequences remain stale without retaining a growing utterance-ID map.
    Byte/audio budgets include cancelled active work until its coroutine is reaped.
    TTS is optional and subject to quality/route admission. Current routes have
    no voice grant: the result contains marked experimental text and audio=b"".
    """

    def __init__(self, asr, mt, tts=None, *, room_id="isolated", queue_size=4,
                 max_buffered_bytes=6 * 1024 * 1024,
                 max_buffered_audio_seconds=60, max_utterance_bytes=3 * 1024 * 1024,
                 max_utterance_seconds=30, max_pending_per_participant=2,
                 max_queue_seconds=3, max_latency_seconds=15,
                 max_tracks=32, max_participants=16, max_playback_ids=128,
                 playback_ttl_seconds=60, cancellation_grace_seconds=1,
                 on_result: Callable[[TranslationResult], None] | None = None):
        integer_limits = {
            "queue_size": queue_size, "max_buffered_bytes": max_buffered_bytes,
            "max_utterance_bytes": max_utterance_bytes,
            "max_pending_per_participant": max_pending_per_participant,
            "max_tracks": max_tracks, "max_participants": max_participants,
            "max_playback_ids": max_playback_ids,
        }
        for name, value in integer_limits.items():
            _positive(value, name, integer=True)
        for name, value in {
            "max_buffered_audio_seconds": max_buffered_audio_seconds,
            "max_utterance_seconds": max_utterance_seconds,
            "max_queue_seconds": max_queue_seconds,
            "max_latency_seconds": max_latency_seconds,
            "playback_ttl_seconds": playback_ttl_seconds,
            "cancellation_grace_seconds": cancellation_grace_seconds,
        }.items():
            _positive(value, name)
        if not callable(asr) or not callable(mt) or (tts is not None and not callable(tts)):
            raise TypeError("Explicit ASR/MT and optional TTS callables are required")
        if on_result is not None and (not callable(on_result) or inspect.iscoroutinefunction(on_result)):
            raise TypeError("on_result must be synchronous")
        self._asr, self._mt, self._tts = asr, mt, tts
        self._room_id = _identifier(room_id, "room_id")
        self._generation = 0
        self._session = None
        self._tracks: dict[tuple[str, str], _TrackState] = {}
        self._participants: dict[str, ParticipantHandle] = {}
        self._queue: deque[_Work] = deque()
        self._ready_participants: deque[str] = deque()
        self._last_participant = None
        self._revisions: dict[tuple[int, int], _Work] = {}
        self._playback_ids: OrderedDict[str, float] = OrderedDict()
        self._limits = integer_limits
        self._max_audio_seconds = max_buffered_audio_seconds
        self._max_utterance_seconds = max_utterance_seconds
        self._max_queue_seconds = max_queue_seconds
        self._max_latency_seconds = max_latency_seconds
        self._playback_ttl_seconds = playback_ttl_seconds
        self._cancellation_grace = cancellation_grace_seconds
        self._buffered_bytes = 0
        self._buffered_audio_seconds = 0.0
        self._active_work = None
        self._active_task = None
        self._wake = asyncio.Event()
        self._deadline_wake = asyncio.Event()
        self._on_result = on_result
        self._worker = None
        self._watchdog = None
        self._close_task = None
        self._engine_closers = set()
        self._closed = False
        self._failure = None
        self.connect()

    @property
    def session(self):
        return self._session

    @property
    def stats(self):
        return {
            "queued": len(self._queue), "active": int(self._active_work is not None),
            "buffered_bytes": self._buffered_bytes,
            "buffered_audio_seconds": self._buffered_audio_seconds,
            "revision_entries": len(self._revisions), "tracks": len(self._tracks),
            "participants": len(self._participants),
            "playback_ids": len(self._playback_ids), "closed": self._closed,
            "connected": self._session is not None, "failure": self._failure,
        }

    def _signal(self):
        self._wake.set()
        self._deadline_wake.set()

    def connect(self):
        if self._closed:
            raise RuntimeError("adapter is closed")
        if self._session is not None:
            raise RuntimeError("disconnect the current session before connecting")
        self._generation += 1
        self._session = RoomSession(self._room_id, self._generation)
        return self._session

    def is_current(self, handle):
        if self._closed or not isinstance(handle, TrackHandle) or handle.session is not self._session:
            return False
        state = self._tracks.get((handle.participant_id, handle.track_id))
        return state is not None and state.handle is handle and self.is_current_participant(handle.participant)

    def is_current_participant(self, participant):
        return (
            not self._closed and isinstance(participant, ParticipantHandle)
            and participant.session is self._session
            and self._participants.get(participant.participant_id) is participant
        )

    def register_participant(self, participant_id, *, session):
        if self._closed:
            raise RuntimeError("adapter is closed")
        if session is None or session is not self._session:
            raise StaleFrameError("registration belongs to a disconnected room session")
        _identifier(participant_id, "participant_id")
        if participant_id in self._participants:
            raise ValueError("participant connection is already registered")
        if len(self._participants) >= self._limits["max_participants"]:
            raise BackpressureError("participant limit")
        self._generation += 1
        participant = ParticipantHandle(session, participant_id, self._generation)
        self._participants[participant_id] = participant
        return participant

    def register_track(self, participant, track_id, source_language, target_language):
        if self._closed:
            raise RuntimeError("adapter is closed")
        if not self.is_current_participant(participant):
            raise StaleFrameError("track registration belongs to a previous participant connection")
        participant_id = participant.participant_id
        values = [participant_id, track_id, source_language, target_language]
        for value, name in zip(values, ["participant_id", "track_id", "source_language", "target_language"]):
            _identifier(value, name)
        key = (participant_id, track_id)
        if key in self._tracks:
            raise ValueError("track is already registered")
        if len(self._tracks) >= self._limits["max_tracks"]:
            raise BackpressureError("track limit")
        self._generation += 1
        handle = TrackHandle(participant.session, *values, self._generation, participant)
        self._tracks[key] = _TrackState(handle)
        return handle

    def cancel_track(self, handle):
        if not self.is_current(handle):
            return False
        self._cancel_matching(lambda work: work.handle is handle)
        return True

    def unregister_track(self, handle):
        if not self.cancel_track(handle):
            return False
        del self._tracks[(handle.participant_id, handle.track_id)]
        return True

    def participant_left(self, participant):
        if not self.is_current_participant(participant):
            return 0
        handles = [state.handle for state in self._tracks.values()
                   if state.handle.participant is participant]
        for handle in handles:
            self.unregister_track(handle)
        del self._participants[participant.participant_id]
        return len(handles)

    def disconnect(self, session):
        if session is None or session is not self._session:
            return False
        self._session = None
        self._cancel_matching(lambda work: True)
        self._tracks.clear()
        self._participants.clear()
        self._playback_ids.clear()
        self._last_participant = None
        return True

    def reconnect(self, session):
        if not self.disconnect(session):
            raise StaleFrameError("reconnect belongs to a previous room session")
        return self.connect()

    async def room_left(self, session):
        if session is None or session is not self._session:
            return False
        await self.close()
        return True

    def mark_tts_playback(self, playback_id, *, session):
        if self._closed or session is None or session is not self._session:
            raise StaleFrameError("playback belongs to a disconnected room session")
        _identifier(playback_id, "playback_id")
        now = asyncio.get_running_loop().time()
        self._expire_playback(now)
        if playback_id not in self._playback_ids and len(self._playback_ids) >= self._limits["max_playback_ids"]:
            raise BackpressureError("playback token limit")
        self._playback_ids[playback_id] = now + self._playback_ttl_seconds
        self._signal()

    def _expire_playback(self, now):
        for playback_id, expires in tuple(self._playback_ids.items()):
            if expires <= now:
                del self._playback_ids[playback_id]

    async def submit_wav(self, handle, audio, *, sequence, **kwargs):
        """Validated PCM16 or float32, mono/16kHz whole-WAV boundary for ASR.

        The lower-level submit() takes duration from a trusted decoded framer.
        This entry point derives it from bounded WAV bytes, never caller metadata.
        It is not a streaming decoder, VAD or browser media ingress.
        """
        if self._closed:
            raise RuntimeError("adapter is closed")
        if not self.is_current(handle):
            raise UnknownTrackError("unknown or disconnected track handle")
        if not isinstance(audio, bytes) or not audio or len(audio) > self._limits["max_utterance_bytes"]:
            raise ValueError("WAV byte limit/type")
        if "duration_seconds" in kwargs:
            raise ValueError("WAV duration is derived from its verified frames")
        duration = _wav_duration(audio, self._max_utterance_seconds)
        return await self.submit(handle, audio, sequence=sequence, duration_seconds=duration, **kwargs)

    async def submit(self, handle, audio, *, sequence, duration_seconds,
                     playback_id=None, utterance_id=None, revision=1, deadline=None):
        if self._closed:
            raise RuntimeError("adapter is closed")
        if not self.is_current(handle):
            raise UnknownTrackError("unknown or disconnected track handle")
        loop = asyncio.get_running_loop()
        now = loop.time()
        self._expire(now)
        if playback_id is not None and playback_id in self._playback_ids:
            return None
        if not isinstance(audio, bytes) or not audio:
            raise ValueError("audio must be non-empty immutable bytes")
        _positive(duration_seconds, "duration_seconds")
        _positive(sequence, "sequence", integer=True)
        _positive(revision, "revision", integer=True)
        if sequence > 2**53 - 1 or revision > 2**31 - 1:
            raise ValueError("sequence/revision exceeds protocol integer limit")
        if len(audio) > self._limits["max_utterance_bytes"] or duration_seconds > self._max_utterance_seconds:
            raise BackpressureError("utterance byte/audio-time limit")
        if deadline is None:
            deadline = now + self._max_latency_seconds
        if isinstance(deadline, bool) or not isinstance(deadline, (int, float)) or not math.isfinite(deadline):
            raise ValueError("deadline must be a finite local monotonic time")
        deadline = min(deadline, now + self._max_latency_seconds)
        if deadline <= now:
            raise DeadlineError("utterance deadline already expired")
        if utterance_id is None:
            utterance_id = f"utterance-{sequence}"
        _identifier(utterance_id, "utterance_id")
        revision_key = (handle.generation, sequence)
        previous = self._revisions.get(revision_key)
        state = self._tracks[(handle.participant_id, handle.track_id)]
        if previous is None:
            if sequence <= state.last_sequence:
                raise StaleFrameError("completed/cancelled or out-of-order source sequence")
        elif previous.cancelled or previous.future.done():
            raise StaleFrameError("completed/cancelled source sequence")
        elif previous.utterance_id != utterance_id or revision <= previous.revision:
            raise StaleFrameError("revision must advance the same unfinished utterance")

        # Admission is transactional: a rejected replacement cannot cancel the old
        # phrase. Active cancelled buffers remain reserved until actual retirement.
        displaced = previous if previous is not None and previous is not self._active_work else None
        pending = [work for work in self._queue if work is not displaced]
        if len(pending) >= self._limits["queue_size"]:
            raise BackpressureError("translation queue count limit")
        retained = pending + ([self._active_work] if self._active_work is not None else [])
        if sum(work.handle.participant_id == handle.participant_id for work in retained) >= self._limits["max_pending_per_participant"]:
            raise BackpressureError("participant pending limit")
        freed_bytes = len(displaced.audio) if displaced is not None else 0
        freed_seconds = displaced.duration_seconds if displaced is not None else 0
        if self._buffered_bytes - freed_bytes + len(audio) > self._limits["max_buffered_bytes"]:
            raise BackpressureError("buffered byte limit")
        if self._buffered_audio_seconds - freed_seconds + duration_seconds > self._max_audio_seconds + 1e-9:
            raise BackpressureError("buffered audio-time limit")
        insert_at = len(self._queue)
        queue_expires = min(deadline, now + self._max_queue_seconds)
        if previous is not None:
            # Revisions retain the utterance's original age and source position.
            # Continuous partial updates cannot postpone expiry or reorder words.
            deadline = min(deadline, previous.deadline)
            queue_expires = min(queue_expires, previous.queue_expires)
            if displaced is not None:
                insert_at = self._queue.index(displaced)
            else:
                insert_at = next((index for index, item in enumerate(self._queue)
                                  if item.handle.participant_id == handle.participant_id), len(self._queue))
            self._invalidate(previous, StaleFrameError(f"superseded by revision {revision}"))
            self._remove_queued(previous)
        future = loop.create_future()
        work = _Work(handle, sequence, utterance_id, revision, audio, duration_seconds,
                     deadline, queue_expires, future)
        self._queue.insert(insert_at, work)
        self._buffered_bytes += len(audio)
        self._buffered_audio_seconds += duration_seconds
        self._revisions[revision_key] = work
        state.last_sequence = max(state.last_sequence, sequence)
        self._refresh_ready()
        future.add_done_callback(lambda done, item=work: self._on_future_done(item, done))
        self.start()
        self._signal()
        return future

    def start(self):
        if self._closed:
            raise RuntimeError("adapter is closed")
        if self._worker is None:
            self._worker = asyncio.create_task(self._run(), name="translation-queue")
            self._watchdog = asyncio.create_task(self._watch_deadlines(), name="translation-deadlines")

    def _on_future_done(self, work, future):
        if future.cancelled() and not work.released:
            self._invalidate(work)
            self._remove_queued(work)
            self._signal()

    def _refresh_ready(self):
        owners = list(dict.fromkeys(work.handle.participant_id for work in self._queue))
        self._ready_participants = deque(owner for owner in self._ready_participants if owner in owners)
        for owner in owners:
            if owner not in self._ready_participants:
                self._ready_participants.append(owner)

    def _next(self):
        if len(self._ready_participants) > 1 and self._ready_participants[0] == self._last_participant:
            self._ready_participants.rotate(-1)
        owner = self._ready_participants.popleft()
        work = next(work for work in self._queue if work.handle.participant_id == owner)
        self._queue.remove(work)
        if any(item.handle.participant_id == owner for item in self._queue):
            self._ready_participants.append(owner)
        self._last_participant = owner
        return work

    def _release(self, work):
        if work.released:
            return
        work.released = True
        self._buffered_bytes -= len(work.audio)
        self._buffered_audio_seconds = max(0.0, self._buffered_audio_seconds - work.duration_seconds)
        work.audio = b""
        revision_key = (work.handle.generation, work.sequence)
        if self._revisions.get(revision_key) is work:
            del self._revisions[revision_key]
        self._signal()

    def _remove_queued(self, work):
        if work in self._queue:
            self._queue.remove(work)
            self._release(work)
            self._refresh_ready()

    def _invalidate(self, work, error=None):
        if not work.cancelled:
            work.cancelled = True
            work.invalidated.set()
            if self._active_work is work and self._active_task is not None:
                self._active_task.cancel()
        if not work.future.done():
            if error is None:
                work.future.cancel()
            else:
                work.future.set_exception(error)

    def _cancel_matching(self, predicate):
        for work in tuple(self._queue):
            if predicate(work):
                self._invalidate(work)
                self._remove_queued(work)
        if self._active_work is not None and predicate(self._active_work):
            self._invalidate(self._active_work)
        self._signal()

    def _expire(self, now):
        self._expire_playback(now)
        for work in tuple(self._queue):
            if min(work.queue_expires, work.deadline) <= now:
                self._invalidate(work, DeadlineError("utterance expired in queue"))
                self._remove_queued(work)
        if self._active_work is not None and self._active_work.deadline <= now:
            self._invalidate(self._active_work, DeadlineError("active utterance deadline exceeded"))

    def _fresh(self, work):
        if work.deadline <= asyncio.get_running_loop().time():
            self._invalidate(work, DeadlineError("utterance deadline exceeded at stage boundary"))
        return (
            not work.cancelled and not work.future.done() and self.is_current(work.handle)
            and self._revisions.get((work.handle.generation, work.sequence)) is work
        )

    async def _pipeline(self, work):
        try:
            if not self._fresh(work):
                return
            source = await self._asr(work.audio, work.handle.source_language)
            if not self._fresh(work):
                return
            translated = await self._mt(source, work.handle.source_language, work.handle.target_language)
            if not self._fresh(work):
                return
            quality = assess_translation(source, translated, work.handle.source_language,
                                         work.handle.target_language)
            if not self._fresh(work):
                return
            speech = b""
            if quality.speech_allowed and self._tts is not None:
                speech = await self._tts(translated, work.handle.target_language)
            if not self._fresh(work):
                return
            result = TranslationResult(work.handle.participant_id, work.handle.track_id,
                                       work.sequence, source, translated, speech,
                                       work.utterance_id, work.revision, work.handle, quality)
            if self._on_result is not None:
                returned = self._on_result(result)
                if inspect.isawaitable(returned):
                    if inspect.iscoroutine(returned):
                        returned.close()
                    elif isinstance(returned, asyncio.Future):
                        returned.cancel()
                    raise TypeError("on_result must not return an awaitable")
            if not work.future.done():
                work.future.set_result(result)
        except asyncio.CancelledError:
            if not work.future.done():
                work.future.cancel()
            raise
        except Exception as error:
            if not work.future.done():
                work.future.set_exception(error)
            if isinstance(error, StageCleanupError):
                self._failure = "native worker retirement unproven"
                self._begin_close()

    def _retire_active(self, work, task):
        if task.done():
            if not task.cancelled():
                task.exception()
            self._release(work)
            if self._active_task is task:
                self._active_work, self._active_task = None, None

    async def _run(self):
        while not self._closed:
            self._expire(asyncio.get_running_loop().time())
            if not self._queue:
                self._wake.clear()
                await self._wake.wait()
                continue
            work = self._next()
            task = asyncio.create_task(self._pipeline(work), name="translation-pipeline")
            self._active_work, self._active_task = work, task
            self._deadline_wake.set()
            invalidated = asyncio.create_task(work.invalidated.wait())
            try:
                await asyncio.wait({task, invalidated}, return_when=asyncio.FIRST_COMPLETED)
                if not task.done():
                    done, _ = await asyncio.wait({task}, timeout=self._cancellation_grace)
                    if not done:
                        self._failure = "engine did not acknowledge cancellation within grace"
                        task.add_done_callback(lambda done, item=work: self._retire_active(item, done))
                        self._begin_close()
                        return
            finally:
                invalidated.cancel()
                await asyncio.gather(invalidated, return_exceptions=True)
                self._retire_active(work, task)

    async def _watch_deadlines(self):
        while not self._closed:
            now = asyncio.get_running_loop().time()
            self._expire(now)
            deadlines = [min(work.queue_expires, work.deadline) for work in self._queue]
            if self._active_work is not None and not self._active_work.cancelled:
                deadlines.append(self._active_work.deadline)
            deadlines.extend(self._playback_ids.values())
            self._deadline_wake.clear()
            try:
                if deadlines:
                    await asyncio.wait_for(self._deadline_wake.wait(), max(0, min(deadlines) - now))
                else:
                    await self._deadline_wake.wait()
            except asyncio.TimeoutError:
                pass

    def _begin_close(self):
        self._closed = True
        self._session = None
        self._cancel_matching(lambda work: True)
        self._tracks.clear()
        self._participants.clear()
        self._playback_ids.clear()
        if self._close_task is None:
            self._close_task = asyncio.create_task(self._finish_close(), name="translation-close")
            # The owner may observe a watchdog-triggered failure only later via
            # stats/close. Retrieve its exception without hiding it from close().
            self._close_task.add_done_callback(lambda done: None if done.cancelled() else done.exception())

    async def _finish_close(self):
        if self._worker is not None:
            await asyncio.wait({self._worker}, timeout=self._cancellation_grace + .5)
        if self._watchdog is not None:
            self._watchdog.cancel()
            await asyncio.gather(self._watchdog, return_exceptions=True)
        seen = set()
        for engine in (self._asr, self._mt, self._tts):
            owner = getattr(engine, "__self__", engine)
            if owner is None or id(owner) in seen:
                continue
            seen.add(id(owner))
            closer = getattr(owner, "close", None)
            if closer is not None:
                async def close_engine(method=closer):
                    await method()
                self._engine_closers.add(asyncio.create_task(close_engine()))
        errors = []
        if self._engine_closers:
            done, pending = await asyncio.wait(self._engine_closers, timeout=self._cancellation_grace + .5)
            for task in done:
                if task.cancelled() or task.exception() is not None:
                    errors.append("engine close failed")
            for task in pending:
                task.cancel()
                task.add_done_callback(lambda done: None if done.cancelled() else done.exception())
            if pending:
                errors.append("engine close deadline exceeded")
            self._engine_closers = pending
        if self._active_task is not None and not self._active_task.done():
            errors.append("cancel-resistant pipeline remains quarantined")
        if self._worker is not None and not self._worker.done():
            errors.append("queue worker did not stop")
        if errors:
            self._failure = "; ".join(errors)
            raise EngineShutdownError(self._failure)

    async def close(self):
        if self._close_task is None:
            self._begin_close()
        await asyncio.shield(self._close_task)
