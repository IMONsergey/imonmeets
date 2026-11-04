"""One source / one target pilot using an ordinary, revocable Meets join grant."""
import asyncio
from dataclasses import dataclass, field
import json
from pathlib import Path
import stat
from urllib.parse import urlsplit
from .config import PilotError


@dataclass(frozen=True)
class JoinGrant:
    url: str
    room_name: str
    identity: str
    token: str = field(repr=False)

    @classmethod
    def read(cls, path: Path):
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 32768:
            raise PilotError("JOIN_GRANT_MUST_BE_PRIVATE")
        try:
            data = json.loads(path.read_text())
            grant = cls(data["serverUrl"], data["roomName"], data["identity"], data["token"])
        except (ValueError, KeyError, TypeError):
            raise PilotError("INVALID_JOIN_GRANT") from None
        if not all(isinstance(v, str) and v for v in (grant.url, grant.room_name, grant.identity, grant.token)):
            raise PilotError("INVALID_JOIN_GRANT")
        url = urlsplit(grant.url)
        if url.username or url.password or url.query or url.fragment:
            raise PilotError("INVALID_LIVEKIT_URL")
        if not ((url.scheme == "wss" and url.hostname == "rtc.imon.world") or
                (url.scheme == "ws" and url.hostname in ("127.0.0.1", "localhost"))):
            raise PilotError("UNAPPROVED_LIVEKIT_HOST")
        return grant


async def run_room(pipeline, grant, source_identity):
    from livekit import rtc
    if source_identity == grant.identity or not source_identity:
        raise PilotError("INVALID_SOURCE_PARTICIPANT")
    pipeline.settings.require_enabled()
    room = rtc.Room()
    output = None
    incoming = None
    task = None
    terminal = asyncio.Event()
    selected = asyncio.get_running_loop().create_future()
    reason = ["ROOM_DISCONNECTED"]
    bound_sid = [None]

    def stop(code):
        reason[0] = code
        terminal.set()

    @room.on("track_subscribed")
    def subscribed(track, publication, participant):
        if participant.identity != source_identity:
            publication.set_subscribed(False)
            return
        if publication.source != rtc.TrackSource.SOURCE_MICROPHONE or track.kind != rtc.TrackKind.KIND_AUDIO:
            publication.set_subscribed(False)
            return
        if publication.name.startswith("meets-translation-"):
            stop("TRANSLATION_LOOP_REJECTED")
            return
        if bound_sid[0] is not None and bound_sid[0] != publication.sid:
            stop("SOURCE_TRACK_CHANGED")
        elif not selected.done():
            bound_sid[0] = publication.sid
            selected.set_result(track)

    def subscribe(publication, participant):
        if (participant.identity == source_identity and
            publication.source == rtc.TrackSource.SOURCE_MICROPHONE):
            if bound_sid[0] is not None and bound_sid[0] != publication.sid:
                stop("SOURCE_TRACK_CHANGED")
                return
            publication.set_subscribed(True)

    room.on("track_published", subscribe)

    @room.on("track_unsubscribed")
    def unsubscribed(track, publication, participant):
        if participant.identity == source_identity and publication.sid == bound_sid[0]:
            stop("SOURCE_TRACK_ENDED")

    @room.on("participant_disconnected")
    def left(participant):
        if participant.identity == source_identity:
            stop("SOURCE_LEFT")

    room.on("disconnected", lambda *_: stop("ROOM_DISCONNECTED"))
    room.on("reconnecting", lambda *_: stop("ROOM_RECONNECTING"))
    stop_task = asyncio.create_task(terminal.wait())
    try:
        async with asyncio.timeout(pipeline.settings.max_wall_seconds + 20):
            await asyncio.wait_for(room.connect(grant.url, grant.token,
                                                options=rtc.RoomOptions(auto_subscribe=False)), 10)
            if room.name != grant.room_name or room.local_participant.identity != grant.identity:
                raise PilotError("JOIN_GRANT_ROOM_MISMATCH")
            for participant in room.remote_participants.values():
                for publication in participant.track_publications.values():
                    subscribe(publication, participant)
            done, _ = await asyncio.wait({selected, stop_task}, timeout=15,
                                         return_when=asyncio.FIRST_COMPLETED)
            if stop_task in done:
                raise PilotError(reason[0])
            if selected not in done:
                raise PilotError("SOURCE_MICROPHONE_NOT_FOUND")
            incoming = rtc.AudioStream(selected.result(), capacity=50,
                                       sample_rate=16000, num_channels=1, frame_size_ms=20)
            output = rtc.AudioSource(24000, 1, queue_size_ms=200)
            local_track = rtc.LocalAudioTrack.create_audio_track(
                f"meets-translation-{pipeline.target}", output)
            await room.local_participant.publish_track(local_track, rtc.TrackPublishOptions(
                source=rtc.TrackSource.SOURCE_MICROPHONE))

            async def audio():
                start = asyncio.get_running_loop().time()
                remaining = pipeline.settings.max_input_seconds * 32000
                async for event in incoming:
                    if terminal.is_set():
                        raise PilotError(reason[0])
                    if asyncio.get_running_loop().time() - start >= pipeline.settings.max_input_seconds:
                        return
                    pcm = event.frame.data.tobytes()[:remaining]
                    if pcm:
                        remaining -= len(pcm)
                        yield pcm
                    if remaining == 0:
                        return

            async def publish(pcm):
                for offset in range(0, len(pcm), 960):
                    if terminal.is_set():
                        raise PilotError(reason[0])
                    chunk = pcm[offset:offset + 960]
                    await asyncio.wait_for(output.capture_frame(rtc.AudioFrame(
                        chunk, 24000, 1, len(chunk) // 2)), 2)

            task = asyncio.create_task(pipeline.run(audio(), publish))
            done, _ = await asyncio.wait({task, stop_task}, return_when=asyncio.FIRST_COMPLETED)
            if stop_task in done:
                raise PilotError(reason[0])
            metrics = task.result()
            await asyncio.wait_for(output.wait_for_playout(), 3)
            return metrics
    except asyncio.CancelledError:
        raise
    except PilotError:
        raise
    except TimeoutError:
        raise PilotError("LIVEKIT_PILOT_TIMEOUT") from None
    except Exception:
        raise PilotError("LIVEKIT_PILOT_FAILED") from None
    finally:
        terminal.set()
        stop_task.cancel()
        if task is not None:
            task.cancel()
        await asyncio.gather(*[t for t in (stop_task, task) if t is not None], return_exceptions=True)
        if output is not None:
            output.clear_queue()
            await output.aclose()
        if incoming is not None:
            await incoming.aclose()
        await room.disconnect()
