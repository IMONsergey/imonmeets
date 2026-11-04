import argparse
import asyncio
import json
import hashlib
import os
from pathlib import Path
import time
import wave
from .budget import reserve
from .config import PilotError, ROUTES, Settings, load_private_env, validate_route
from .soniox import SonioxPipeline


def inspect_wav(path, settings):
    try:
        with wave.open(str(path), "rb") as audio:
            if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getcomptype()) != (1, 2, 16000, "NONE"):
                raise PilotError("WAV_MUST_BE_PCM16_MONO_16000")
            seconds = audio.getnframes() / 16000
            if not 0 < seconds <= settings.max_input_seconds:
                raise PilotError("WAV_DURATION_LIMIT")
            return seconds
    except (wave.Error, EOFError, OSError):
        raise PilotError("INVALID_WAV") from None


async def wav_frames(path):
    with wave.open(str(path), "rb") as audio:
        start, sent = time.monotonic(), 0
        while chunk := audio.readframes(1600):
            # Preserve real time instead of uploading an hour in a burst.
            await asyncio.sleep(max(0, start + sent / 32000 - time.monotonic()))
            yield chunk
            sent += len(chunk)


async def run_wav(args, settings, run_id):
    output = Path(args.output).resolve() / run_id
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    pipeline = SonioxPipeline(settings, args.source, args.target, speech=args.with_speech)
    status, error_code = "failed", None
    metrics = pipeline.metrics
    # Deliberate test artifacts only; ordinary room mode does not retain content.
    try:
        with (wave.open(str(output / "translated.wav"), "wb") as wav,
              (output / "translation.jsonl").open("x") as text,
              (output / "synthesis.jsonl").open("x") as spoken,
              (output / "transcription.jsonl").open("x") as original):
            wav.setparams((1, 2, 24000, 0, "NONE", "not compressed"))
            async def audio(pcm):
                wav.writeframesraw(pcm)
            async def transcript(chunk):
                text.write(json.dumps({"text": chunk}, ensure_ascii=False) + "\n")
            async def speech_transcript(chunk):
                spoken.write(json.dumps({"text": chunk}, ensure_ascii=False) + "\n")
            async def source_transcript(chunk):
                original.write(json.dumps({"text": chunk}, ensure_ascii=False) + "\n")
            await pipeline.run(wav_frames(args.input), audio, speech_transcript,
                               on_source=source_transcript, on_translation=transcript)
            status = "completed"
    except PilotError as error:
        error_code = str(error)
        raise
    except asyncio.CancelledError:
        error_code = "CANCELLED"
        raise
    finally:
        receipt = {"run_id": run_id, "status": status, "source": args.source,
                   "target": args.target, "provider": "soniox", "error_code": error_code,
                   "stt_model": settings.stt_model, "tts_model": settings.tts_model,
                   "endpoint_delay_ms": settings.endpoint_delay_ms, "ip_family": settings.ip_family,
                   "context_sha256": hashlib.sha256(json.dumps(settings.context, sort_keys=True).encode()).hexdigest() if settings.context else None,
                   **metrics.receipt()}
        (output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


def parser():
    p = argparse.ArgumentParser(description="Meets Soniox pilot; disabled by default")
    p.add_argument("--env-file", type=Path)
    sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser("check", help="Offline readiness check; never contacts provider")
    for command in ("wav", "room"):
        s = sub.add_parser(command)
        s.add_argument("--source", required=True, choices=("ru", "en", "zh", "ar"))
        s.add_argument("--target", required=True, choices=("ru", "en", "zh", "ar"))
        s.add_argument("--with-speech", action="store_true", help="Explicitly enable paid TTS; required for room audio")
        s.add_argument("--execute", action="store_true", help="Permit an enabled paid pilot")
        if command == "wav":
            s.add_argument("--input", required=True, type=Path)
            s.add_argument("--output", required=True, type=Path)
        else:
            s.add_argument("--grant-file", required=True, type=Path)
            s.add_argument("--source-identity", required=True)
    return p


def main(argv=None):
    os.umask(0o077)
    args = parser().parse_args(argv)
    try:
        env = dict(os.environ)
        if args.env_file:
            env.update(load_private_env(args.env_file))
        settings = Settings.from_env(env)
        if args.command == "check":
            print(json.dumps({"provider": "soniox", "enabled": settings.enabled,
                              "key_present": bool(settings.api_key), "voice": settings.voice,
                              "stt_model": settings.stt_model, "tts_model": settings.tts_model,
                              "context_present": bool(settings.context),
                              "endpoint_delay_ms": settings.endpoint_delay_ms, "ip_family": settings.ip_family,
                              "routes": sorted(ROUTES), "max_input_seconds": settings.max_input_seconds,
                              "max_output_seconds": settings.max_output_seconds,
                              "max_text_chars": settings.max_text_chars,
                              "reservation_cents": settings.reservation_cents,
                              "budget_cents": settings.budget_cents,
                              "network_calls": 0, "quality_accepted": False}))
            return 0
        validate_route(args.source, args.target)
        if args.command == "wav":
            inspect_wav(args.input, settings)
        else:
            from .livekit_bridge import JoinGrant
            grant = JoinGrant.read(args.grant_file)
        if not args.execute:
            print(json.dumps({"status": "dry_run", "provider": "soniox", "network_calls": 0,
                              "source": args.source, "target": args.target, "speech_enabled": args.with_speech}))
            return 0
        if args.command == "room" and not args.with_speech:
            raise PilotError("ROOM_REQUIRES_EXPLICIT_SPEECH")
        settings.require_enabled()
        with reserve(settings) as run_id:
            if args.command == "wav":
                result = asyncio.run(run_wav(args, settings, run_id))
            else:
                from .livekit_bridge import run_room
                metrics = asyncio.run(run_room(SonioxPipeline(settings, args.source, args.target),
                                               grant, args.source_identity))
                result = {"run_id": run_id, "status": "completed", **metrics.receipt()}
            print(json.dumps(result))
        return 0
    except KeyboardInterrupt:
        print(json.dumps({"status": "cancelled"}))
        return 130
    except PilotError as error:
        print(json.dumps({"status": "blocked", "code": str(error)}))
        return 2
    except Exception:
        # No credential, room token, transcript, filesystem contents or raw HTTP error.
        print(json.dumps({"status": "failed", "code": "PILOT_INTERNAL_ERROR"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
