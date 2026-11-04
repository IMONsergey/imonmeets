# Soniox translation pilot

Prepared 2026-11-04 for Meets IMON. Soniox is the selected **first evaluation provider**. This is an operator-run pilot, disabled by default. It is not deployed and has not passed linguistic or production acceptance. No provider key, account purchase or paid call was used during preparation.

Latest: the owner later supplied a key and a real trial was run. The initial quality trial failed. A follow-up hardening and domain-context experiment is recorded in [quality iteration](soniox-quality-iteration-20261104.md). Persistent execution remains disabled; production quality is not accepted. See also [first real API trial](soniox-first-api-trial-20261104.md). The original offline preparation evidence below is historical.

## Scope

`apps/translation-worker` contains an isolated Python worker, a locked dependency set and a CLI. It receives PCM16/16 kHz mono, streams it to Soniox STT plus one-way translation, sends only final translated text to TTS, and emits PCM16/24 kHz mono. Supported pilot routes: RU→EN, EN→RU, RU→ZH, ZH→RU, RU→AR, AR→RU. Each run has exactly one source and one target language. The built-in voice is Adrian; no voice cloning.

Two entry points are available:

- `wav`: pace an existing test recording in real time and save source recognition, final translation and a receipt. Paid TTS is opt-in with `--with-speech`; the default paid diagnostic is text-only.
- `room`: subscribe only to one explicitly selected participant's microphone and publish one translated microphone track to LiveKit. Use a dedicated test room. All participants subscribing to the worker hear this target language. Existing original audio is still audible: use headphones and deliberately adjust the original track for the test. There is no listener language selector, per-listener routing, automatic volume ducking or echo cancellation in this change.

The bridge uses an **ordinary, revocable Meets room join grant**, with a distinct participant identity. It does not use LiveKit administrator credentials, mint production JWTs, bypass the waiting room, change ingress authorization or enable the old CPU speech path. Room closure, source departure/track replacement, worker disconnection/reconnection or an uncertain provider failure stops the pilot. No automatic reconnect, replay or provider fallback.

## Install and inspect without an API key

Use the existing `imon-job` queue for builds and tests on imon-workstation. Worktree for this preparation: `/home/sergey/imonmeets-soniox-20261104`, branch `feature/soniox-translation-pilot-20261104`. Do not switch or rebuild the production checkout.

```bash
/home/sergey/.local/bin/imon-job submit \
  --cwd /home/sergey/imonmeets-soniox-20261104/apps/translation-worker \
  --timeout 300 -- /usr/local/bin/uv sync --frozen

cd /home/sergey/imonmeets-soniox-20261104/apps/translation-worker
.venv/bin/python -m meets_translation.cli check
```

`check` performs zero network calls and prints only whether a key exists, never its value. A `wav` or `room` invocation without `--execute` validates local inputs and performs a dry run without network calls or budget reservation.

Python >=3.11,<3.14; verified using Python 3.13.18, websockets 17.4, livekit 1.2.0. The worker is not added to the production image, Docker Compose, autostart or application UI.

## After the owner obtains and authorizes a test API key

Keep the key in a private server-side file outside the checkout. Copy `.env.example`, set permissions to `600`, then set `SONIOX_API_KEY` and `MEETS_TRANSLATION_ENABLED=true` through a private editor or secret provisioning flow. Never paste the key into chat, a Git commit, command-line arguments, browser code or a receipt. The loader does not execute shell syntax.

Keep one absolute `MEETS_TRANSLATION_STATE_DIR` shared by all pilot runs on this host. Defaults:

| Control | Default |
| --- | --- |
| Input audio | At most 300 seconds |
| Output audio | At most 600 seconds |
| Translated text | At most 6,000 characters |
| Pipeline wall time | Input limit + 60 seconds |
| Pending translation | 8 segments; reject text older than 5 seconds before starting audio |
| Concurrent pilots | 1 per shared state directory |
| Reservation per attempted run | 50 US cents |
| Total reserved evaluation budget | 500 US cents |

The SQLite ledger reserves an attempt before network work and retains reservations after failure, cancellation or restart. **These are local admission reservations, not a guaranteed Soniox invoice cap.** Audio/text/time caps bound exposure; provider prices, rounding and account-wide use remain external. Review provider usage and available account spending controls before a paid run. Do not reset the ledger, change its directory or reduce reservations to evade a reached budget. Key enablement and `--execute` are both required.

The endpoints are fixed to the documented global Soniox hosts. Account-region eligibility, data processing/retention terms and pricing must be checked for the actual account before sending meeting content. Use consented test speech initially. The worker sends the selected source audio and translated text to Soniox.

## First paid run: recording

Prepare a consented PCM16, mono, 16 kHz WAV of 30-60 seconds. Include names, numbers, money, negation and a change of instruction. Input files are not uploaded anywhere during `check` or dry run.

```bash
cd /home/sergey/imonmeets-soniox-20261104/apps/translation-worker
.venv/bin/python -m meets_translation.cli \
  --env-file /PRIVATE_PATH/soniox.env \
  wav --source ru --target en \
  --input /PRIVATE_PATH/ru-test.wav --output /PRIVATE_PATH/soniox-results
```

After the owner authorizes paid execution, run the same command with `--execute` for text-only evaluation, or `--execute --with-speech` for speech evaluation, through `imon-job submit --cwd ... --timeout 420 -- .venv/bin/python ...`. The env file is loaded by the worker, not exposed on the command line. Use the returned job ID to inspect status; do not duplicate a slow job.

Each execution creates a fresh private directory containing `translated.wav`, `transcription.jsonl`, `translation.jsonl`, `synthesis.jsonl` and `receipt.json`. Text-only runs have an empty WAV and synthesis file and never open TTS. `transcription.jsonl` contains final source recognition; `translation.jsonl` retains all final target text received before termination; `synthesis.jsonl` records text admitted to synthesis, not proof that every chunk was played. An early failure can still leave an incomplete transcript. Receipts include stable error codes, model names, a context hash, connection/assembly/queue/TTS timing and received versus accepted audio bytes, including a late first chunk rejected by the freshness limit. Raw credentials, meeting context and provider error messages are not included in receipts. Check the receipt status before using a WAV. Keep test artifacts private and remove them when evaluation no longer needs them. Room mode does not persist source audio or translated text. Neither mode asserts anything about provider-side retention.

## Second paid run: a dedicated Meets test room

1. Create an explicitly designated test room through the normal Meets flow. Use headphones. Keep unrelated people and real meeting content out of the pilot.
2. Obtain a fresh, separate guest/participant grant for a visible translator participant using the ordinary `POST /api/rooms/:slug/join` flow with a name such as `Soniox translator [TEST]`. Preserve that guest's cookie across waiting-room requests. If pending, have the host approve it and resume the same admission flow with its waiting token; do not disable or bypass admission. Do not reuse a speaker's grant or create a service JWT. The app grant currently has a five-minute join lifetime, so obtain it immediately before connecting.
3. Save the joined response's `serverUrl`, `roomName`, `identity`, `token` to a private JSON file, mode `600`. Do not put it in the repository or chat. Extra fields from the normal joined response are ignored. Production host validation permits only `wss://rtc.imon.world`; loopback `ws` is reserved for local fixtures.
4. Select the speaker's exact current LiveKit participant identity from the normal room session. The worker's identity must differ. A speaker reconnect produces a new identity, so stop and obtain a fresh selection rather than replaying old audio.
5. Dry-run first, then add `--execute --with-speech` for the authorized trial:

```bash
.venv/bin/python -m meets_translation.cli \
  --env-file /PRIVATE_PATH/soniox.env \
  room --source ru --target en \
  --grant-file /PRIVATE_PATH/translator-join.json \
  --source-identity 'CURRENT_SOURCE_PARTICIPANT_IDENTITY'
```

Run execution through the queue with a finite 420-second job timeout. Stop the specific job or remove the translator participant to end it early. Confirm the worker left the room; remove its grant file. The API, DB authorization and external media/TURN path require a separate real-room acceptance run with the actual key. They were not exercised by the isolated fixture.

## Initial offline validation evidence (before the key)

| Check | Result on 2026-11-04 |
| --- | --- |
| Frozen environment preparation | `imon-job` 20261104T155400-773b551428, exit 0; lock generated and dependencies installed |
| Contract/admission controls | 19 unittest methods pass, including six route subcases, final-only speech, caps, cancellation, stream errors, private credentials, durable reservation and no-key dry run |
| Actual loopback WebSocket transport | PCM sent/received with auth header, end marker and complete TTS lifecycle, pass |
| Actual isolated LiveKit 1.13.11 | Synthetic microphone → local SFU → worker → fake Soniox WebSockets → local SFU → listener receives nonzero audio; worker leaves, pass |
| Full suite including isolated LiveKit | 21 tests, 0 skipped, `imon-job` 20261104T155623-0be2c4dc01, exit 0 |
| Real Soniox service, pronunciation and semantics | Not tested, no key or paid calls |
| Production ingress, physical devices, external TURN, listener latency | Not tested by this change |

The first isolated RTC run exposed an input-duration/buffer-boundary failure; the bridge now stops by exact PCM byte budget as well as wall time. The successful suite above is after this fix. Fake provider text/tone is deliberately synthetic and is not translation-quality evidence.

To repeat the current suite (35 active tests, isolated RTC skipped unless selected; 36 with isolated RTC):

```bash
/home/sergey/.local/bin/imon-job submit \
  --cwd /home/sergey/imonmeets-soniox-20261104/apps/translation-worker \
  --timeout 90 -- .venv/bin/python -m unittest discover -s tests -v
```

For isolated RTC, set `MEETS_TEST_LIVEKIT_BINARY` to a verified local LiveKit binary in the queued command. The preparation reused `/livekit-server` from the already cached `livekit/livekit-server:v1.13.11` image without starting its container. Fixture credentials are ephemeral; the server binds loopback ports and is terminated in `finally`. On this worktree the ignored test-only binary is in `ops-state/soniox-test/livekit-server`. No model weights, private credentials, audio, receipts or binaries are committed.

## Transport profile

`SONIOX_IP_FAMILY` defaults to `auto`. Use `ipv4` only for a host with a measured slow or broken dual-stack path; it changes this worker connection family, not system networking. Hostnames and normal TLS verification remain in use. It is not a guarantee against resolver or TTS connection stalls. Freshness is rechecked after connection and before a synthesis request, so expired text is rejected without asking for paid generation.

## Phrase boundaries and optional meeting context

Final text is assembled until a sentence boundary or provider endpoint. Periods require lookahead because provider tokens can split decimal values or abbreviations. There is no forced cut at 0.75 seconds or 240 characters. An explicitly original-language endpoint cannot flush a target phrase. Incomplete speech text older than five seconds stops with `INCOMPLETE_TRANSLATION_STALE`; it is not voiced as a fragment. These conservative boundaries can increase latency. Text-only diagnosis is not subject to speech freshness, but retains input/text/wall-time limits. Continuous empty provider messages cannot extend the ten-second drain deadline.

`SONIOX_ENDPOINT_DELAY_MS` defaults to the provider's 2000 ms setting, configurable between 500 and 3000. `SONIOX_STT_MODEL` defaults to `stt-rt-v6`; `stt-rt-v5` is available only for deliberate comparison and is deprecated by Soniox, scheduled for removal December 15, 2026. Do not adopt it as a lasting fix.

Optionally set `SONIOX_CONTEXT_FILE` to an absolute private JSON file (regular file, no symlink, mode 600, at most 16 KiB). Supported fields are `general` (up to eight key/value objects), `text` (up to 4000 characters), `terms` and `translation_terms` (up to 100 entries). The file is explicitly sent to Soniox once per session and its contents are excluded from diagnostics. Use actual meeting subject and supplied terminology, not guessed speech, reference answers or automatic negation corrections. No domain context is globally hardcoded.

Example of a domain-only evaluation context:

```json
{"general":[{"key":"domain","value":"Economics and government budgets"},{"key":"topic","value":"Public spending and economic indicators"}]}
```

A context tuned on a failing example does not establish general accuracy. Test held-out speech and every required language independently before enabling live speech.

## Acceptance still required

Start with RU→EN and EN→RU, then independently evaluate RU↔ZH and RU↔AR. Define Mandarin/simplified Chinese and the desired Arabic variety before judging coverage. For each direction compare meaning, names, numbers, currencies, negation and corrections, then listen for intelligibility and naturalness. A supported language code is not proof of acceptable quality.

Measure source speech to listener playback on physical clients, including cold start, pauses, interruptions, source removal, worker removal, provider outage and the spending limit. The receipt's first-text/first-audio times start at pipeline initialization; they are **not** end-to-end listener latency or a p95 SLO. Retain failures and exact model versions. Do not publish a quality percentage from these controls.

Production work after a successful provider trial: server-side translation entitlement, room/participant lifecycle orchestration, per-listener language/routing and original volume controls, echo/loop prevention with physical devices, independent multilingual semantic acceptance, capacity/usage accounting, privacy/retention/deletion and restart behavior. The CPU experimental pipeline remains gated off and is not an automatic fallback.

## Contract sources

Checked against official documentation on 2026-11-04:

- https://docs.soniox.com/stt/models
- https://docs.soniox.com/stt/concepts/context
- https://docs.soniox.com/stt/rt/endpoint-detection
- https://docs.soniox.com/api-reference/stt/websocket-api
- https://docs.soniox.com/api-reference/tts/websocket-api
- https://docs.soniox.com/tts/rt/connection-keepalive
- https://docs.soniox.com/translation/sts-translation
- https://docs.soniox.com/authentication/migrate-websocket-authentication
- https://docs.livekit.io/reference/python/livekit/rtc/audio_stream.html
- https://docs.livekit.io/reference/python/livekit/rtc/audio_source.html

STT uses `stt-rt-v6`; TTS uses `tts-rt-v2`. Both use the Authorization Bearer header. STT end-of-input is an empty text frame. TTS streams are sequential and complete only after `audio_end` and `terminated`; its idle keepalive is `{"keep_alive": true}`, distinct from STT's `{"type":"keepalive"}`. Re-check model availability and pricing when activating a key.
