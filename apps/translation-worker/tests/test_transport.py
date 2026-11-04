"""Real loopback WebSockets; optional isolated local LiveKit, no provider calls."""
import asyncio
import base64
from contextlib import asynccontextmanager
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import socket
import struct
import subprocess
import tempfile
import time
import unittest

from meets_translation.config import Settings, STT_URL
from meets_translation.livekit_bridge import JoinGrant, run_room
from meets_translation.soniox import SonioxPipeline


def tone(rate, frequency, seconds):
    return b"".join(struct.pack("<h", int(8000 * math.sin(2 * math.pi * frequency * i / rate)))
                    for i in range(int(rate * seconds)))


@asynccontextmanager
async def provider_fixture():
    from websockets.asyncio.client import connect
    from websockets.asyncio.server import serve
    counts = {"stt_bytes": 0, "tts_streams": 0, "authenticated": 0}

    async def handler(ws):
        if ws.request.headers.get("Authorization") != "Bearer local-fixture-only":
            await ws.close(code=1008)
            return
        counts["authenticated"] += 1
        if ws.request.path == "/stt":
            config = json.loads(await ws.recv())
            sent = False
            async for raw in ws:
                if raw == "":
                    await ws.send(json.dumps({"finished": True}))
                    return
                if isinstance(raw, bytes):
                    counts["stt_bytes"] += len(raw)
                    if not sent:
                        await ws.send(json.dumps({"tokens": [{"text": "Fixture speech.", "is_final": True,
                            "translation_status": "translation", "language": config["translation"]["target_language"]}]}))
                        sent = True
        else:
            async for raw in ws:
                data = json.loads(raw)
                if data.get("keep_alive"):
                    continue
                if "text" in data:
                    counts["tts_streams"] += 1
                    sid = data["stream_id"]
                    audio = tone(24000, 720, 1.0)
                    for offset in range(0, len(audio), 4800):
                        await ws.send(json.dumps({"stream_id": sid,
                            "audio": base64.b64encode(audio[offset:offset+4800]).decode(),
                            "audio_end": offset + 4800 >= len(audio)}))
                    await ws.send(json.dumps({"stream_id": sid, "terminated": True}))

    async with serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        def connector(url, **options):
            return connect(f"ws://127.0.0.1:{port}/" + ("stt" if url == STT_URL else "tts"), **options)
        yield connector, counts


class WebSocketTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_websockets_pcm_and_close(self):
        chunks = []
        async def source():
            for _ in range(5):
                yield b"\x00\x00" * 320
                await asyncio.sleep(0.01)
        async def sink(pcm): chunks.append(pcm)
        async with provider_fixture() as (connector, counts):
            pipeline = SonioxPipeline(Settings(enabled=True, api_key="local-fixture-only"), "ru", "en", connector=connector)
            metrics = await pipeline.run(source(), sink)
        self.assertEqual(counts, {"stt_bytes": 3200, "tts_streams": 1, "authenticated": 2})
        self.assertEqual(b"".join(chunks), tone(24000, 720, 1.0))
        self.assertEqual(metrics.output_bytes, 48000)


def free_port(kind=socket.SOCK_STREAM):
    with socket.socket(socket.AF_INET, kind) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def local_token(identity, key, secret):
    """Fixture JWT for the isolated local SFU only, never Meets production."""
    def enc(data):
        return base64.urlsafe_b64encode(json.dumps(data, separators=(",", ":")).encode()).decode().rstrip("=")
    now = int(time.time())
    body = enc({"alg": "HS256", "typ": "JWT"}) + "." + enc({
        "iss": key, "sub": identity, "nbf": now - 5, "exp": now + 120,
        "video": {"roomJoin": True, "room": "soniox-fixture", "canPublish": True, "canSubscribe": True},
    })
    return body + "." + base64.urlsafe_b64encode(hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest()).decode().rstrip("=")


@unittest.skipUnless(os.environ.get("MEETS_TEST_LIVEKIT_BINARY"), "isolated LiveKit binary not selected")
class LiveKitSmokeTests(unittest.IsolatedAsyncioTestCase):
    async def test_microphone_to_translation_to_listener(self):
        from livekit import rtc
        key, secret = "fixture", os.urandom(32).hex()
        port, tcp_port, udp_port = free_port(), free_port(), free_port(socket.SOCK_DGRAM)
        rooms, tasks, sources, streams = [], [], [], []
        with tempfile.TemporaryDirectory(prefix="meets-local-rtc-") as directory:
            config = Path(directory) / "livekit.yaml"
            config.write_text(f"port: {port}\nbind_addresses: [127.0.0.1]\nrtc:\n  tcp_port: {tcp_port}\n  udp_port: {udp_port}\n  node_ip: 127.0.0.1\n  use_external_ip: false\n  enable_loopback_candidate: true\nkeys:\n  {key}: {secret}\n")
            config.chmod(0o600)
            with (Path(directory) / "server.log").open("w") as log:
                proc = subprocess.Popen([os.environ["MEETS_TEST_LIVEKIT_BINARY"], "--config", str(config)], stdout=log, stderr=log)
                try:
                    for _ in range(80):
                        if proc.poll() is not None:
                            self.fail("isolated LiveKit did not start")
                        try:
                            _, writer = await asyncio.open_connection("127.0.0.1", port)
                            writer.close()
                            await writer.wait_closed()
                            break
                        except OSError:
                            await asyncio.sleep(0.1)
                    else:
                        self.fail("isolated LiveKit startup timeout")
                    url = f"ws://127.0.0.1:{port}"
                    source_room, listener = rtc.Room(), rtc.Room()
                    rooms.extend([source_room, listener])
                    heard = asyncio.Event()
                    received = [0]
                    @listener.on("track_subscribed")
                    def subscribed(track, publication, participant):
                        if participant.identity != "pilot":
                            return
                        self.assertEqual(publication.name, "meets-translation-en")
                        async def consume():
                            stream = rtc.AudioStream(track, sample_rate=24000, num_channels=1)
                            streams.append(stream)
                            async for event in stream:
                                received[0] += len(event.frame.data)
                                if max(map(abs, event.frame.data), default=0) > 500:
                                    heard.set()
                        tasks.append(asyncio.create_task(consume()))
                    await source_room.connect(url, local_token("source", key, secret))
                    await listener.connect(url, local_token("listener", key, secret))
                    audio_source = rtc.AudioSource(16000, 1, queue_size_ms=100)
                    sources.append(audio_source)
                    await source_room.local_participant.publish_track(
                        rtc.LocalAudioTrack.create_audio_track("source-mic", audio_source),
                        rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
                    async def feed():
                        data = tone(16000, 440, 0.02)
                        while True:
                            await audio_source.capture_frame(rtc.AudioFrame(data, 16000, 1, 320))
                    tasks.append(asyncio.create_task(feed()))
                    async with provider_fixture() as (connector, counts):
                        pipeline = SonioxPipeline(Settings(enabled=True, api_key="local-fixture-only", max_input_seconds=3, max_wall_seconds=20), "ru", "en", connector=connector)
                        grant = JoinGrant(url, "soniox-fixture", "pilot", local_token("pilot", key, secret))
                        metrics = await asyncio.wait_for(run_room(pipeline, grant, "source"), 25)
                        await asyncio.wait_for(heard.wait(), 2)
                    self.assertGreater(counts["stt_bytes"], 16000)
                    self.assertEqual(metrics.output_bytes, 48000)
                    self.assertGreater(received[0], 0)
                    self.assertFalse(any(p.identity == "pilot" for p in listener.remote_participants.values()))
                finally:
                    for task in tasks:
                        task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
                    for stream in streams:
                        await stream.aclose()
                    for source in sources:
                        source.clear_queue()
                        await source.aclose()
                    for room in rooms:
                        await room.disconnect()
                    proc.terminate()
                    try:
                        await asyncio.to_thread(proc.wait, timeout=3)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        await asyncio.to_thread(proc.wait)


if __name__ == "__main__":
    unittest.main()
