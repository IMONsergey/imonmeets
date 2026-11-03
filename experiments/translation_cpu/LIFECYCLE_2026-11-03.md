# TR-11 / TR-12: bounded experimental worker lifecycle

This change starts at `ff685fbc9b9dcc3b39efe48dd21b9bb1b6e65c4d`. It improves the
executable orchestration boundary of the isolated translator. It does not approve
the translator, a model, TTS voice, live media integration or commercial release.
The saved MT40, heldout, ASR40, process-pipeline outputs and source selection are
preserved. Current semantic/number/currency failures in `RESULTS_2026-11-03.md`
remain open.

## Confirmed gaps addressed

The old adapter bounded the number of queued utterances only. It retained every
utterance revision and playback token, had no room/participant/track replacement
contract, used one global FIFO, and returned from close without awaiting the
worker or closing owned ASR/MT processes. `ProcessStage` bounded each request and
request count, but did not separately limit aggregate retained input bytes or
queue age, and close explicitly cancelled only the active caller.

The current implementation provides:

- Identity-bound `RoomSession`, `ParticipantHandle` and `TrackHandle` objects. Old unregister,
  participant-leave, room-leave and audio callbacks cannot act on a new connection
  or on a new track with the same participant/track IDs. There is no identity-only
  compatibility path in production code.
- A monotonically increasing source sequence per track, plus revision for an
  unfinished utterance. Completed/cancelled source sequences stay stale using a
  single per-track high-water counter; no completed-utterance history grows.
- Admission by queue count, total resident bytes, total audio duration and
  per-participant count. The resource reservation includes active buffers and
  remains until cancellation is acknowledged. Rejected revisions leave the
  previous phrase untouched. Accepted revisions retain original age and source
  position rather than prolonging their lifetime indefinitely.
- Participant round-robin scheduling. FIFO order is preserved within each
  participant, including across its tracks; rotating a track ID cannot bypass the
  participant admission cap. There is one active pipeline, not one per speaker.
- Queue-age and whole-result deadlines. Queued expiry releases its reservation
  while another participant is active. Active expiry cancels the current engine.
  Freshness/deadline checks after every engine await block the next stage and
  publication if an engine returns too late.
- Bounded track, participant and playback-token state. Tokens expire; a full
  unexpired token set rejects further registration instead of silently evicting
  echo suppression state.
- Owned engine shutdown. Room leave/close invalidates acceptance synchronously,
  cancels queued and active work, waits for worker retirement, and closes each
  distinct engine owner once. Cancellation of a close caller does not abandon the
  owned cleanup operation. A deliberate text-only path uses `tts=None` and returns
  `audio=b""`.
- Real subprocess close cancels every admitted caller, drains their reservations,
  terminates the owned process group and reaps its leader. An expired/cancelled
  queued stage request cannot kill another active request's worker. Existing
  bounded output parsing, response IDs, offline environment and spawn-ownership
  protection remain in place. If final wait/reap fails, the process handle and
  native reservation remain quarantined, admission closes permanently, queued
  callers are cancelled, and no replacement can spawn. A later close may retry
  cleanup; reservations release only after successful reap.

## Defaults and interpretation

| Boundary | Default |
| --- | ---: |
| Queued utterances, excluding the one active | 4 |
| Pending utterances per authenticated participant, including active | 2 |
| Total resident source audio, active + queued | 6 MiB |
| Total resident source duration, active + queued | 60 s |
| One source utterance | 3 MiB / 30 s |
| Queue age | 3 s |
| Whole-result deadline from admission | 15 s |
| Cancellation acknowledgement grace | 1 s |
| Registered tracks / participants | 32 / 16 |
| Playback tokens / token TTL | 128 / 60 s |
| ProcessStage pending requests, including active | 4 |
| ProcessStage aggregate serialized input reservations | 8 MiB |
| ProcessStage queue age / whole-request deadline | 10 s / 45 s |
| ProcessStage input / output response cap | 4 MiB / 128 KiB |

These are safety bounds, not a claimed service-level objective or a demonstrated
speaker capacity. A process reservation includes a conservative envelope allowance;
the aggregate stage cap counts UTF-8 bytes, not characters. Source-audio counters
exclude model weights and caller-owned returned results. The verification cgroup
bounds all processes together: one CPU, 2 GiB memory, 256 tasks and finite runtime.
Prior benchmark cgroup receipts with 128 tasks remain unchanged.

The room boundary must bind participant identity to the authenticated connection.
It must assign monotonic sequences in capture order and capture the original
session/track handle in each callback. Re-looking up a current handle by ID in an
old callback would discard the protection supplied by this API.

`submit_wav()` verifies bounded whole-utterance WAV bytes: mono PCM16 or finite IEEE-float32, 16 kHz,
positive frame count, one data chunk, consistent RIFF/chunk lengths, block/byte
rates and optional fact count, at most 64 chunks, complete declared frames and
duration within the cap. Its
duration is computed from the bytes and cannot be overridden with caller metadata.
The lower-level `submit(..., duration_seconds=...)` is for a trusted decoded audio
framer and control fixtures; browser-provided duration must not be forwarded as
authoritative. Neither method implements microphone chunk framing, VAD, resampling,
streaming codec decoding or acoustic echo cancellation.

## API and integration boundary

```python
adapter = TranslationStreamAdapter(asr_engine, mt_engine, room_id="isolated-room")
session = adapter.session
participant = adapter.register_participant("participant", session=session)
track = adapter.register_track(participant, "microphone", "en", "ru")
try:
    pending = await adapter.submit_wav(track, verified_wav_bytes, sequence=1)
    result = await pending
    # result.audio is empty: this instance has no TTS engine.
finally:
    await adapter.close()
```

The room integration must call `unregister_track(captured_track)` for a track
unsubscribe, `participant_left(captured_participant)` for participant
departure, and `await room_left(captured_session)` for final room departure.
`disconnect(captured_session)` invalidates the connection; `reconnect(captured_session)`
atomically invalidates it and returns a new session for fresh registration. A warm
idle model process may be retained across a logical reconnect; an in-flight old
request is cancelled and retired before any new pipeline starts. Final room leave
closes both idle and busy engine processes.

The `on_result` hook must be synchronous. It is called only after the adjacent
freshness/deadline gate. A future async LiveKit publisher must have its own bounded
outbox and check `adapter.is_current(result.track_handle)` immediately before a
network send. Creating an unbounded detached task in the callback is outside this
contract. No such publisher is included or accepted by this change.

Callers receive `BackpressureError`, `DeadlineError`, `StaleFrameError`, or a
cancelled future as appropriate. The future room UI must show an explicit expired
or unavailable segment; this implementation does not silently rewrite, truncate or
repair amounts, negation or translated text.

## Cancellation-resistant engines

An arbitrary Python coroutine cannot be forcibly terminated inside its event
loop. If it ignores cancellation beyond the grace period, the adapter closes
admission, cancels all other work and quarantines at most its single active buffer.
`close()` reports `EngineShutdownError` while the coroutine remains alive; it does
not claim successful reclamation. No new pipeline is started to accumulate blocked
tasks. If the coroutine later returns, it is barred from publication and its buffer
is released. A coroutine that monopolizes the event-loop thread without yielding
requires the enclosing process/cgroup watchdog; asyncio alone cannot interrupt it.

The supplied `ASRProcessEngine` and `MTProcessEngine` use `ProcessStage`, so native
work is stopped through process-group termination instead of trusting a cancelled
Python future. Their owned processes are part of the bounded verification unit.
The original 19 adapter/process checks are retained; the ten original adapter
scenarios use a test-only source helper to allocate explicit handles and sequences.

## Verification and evidence classification

`tests/test_lifecycle_bounds.py` covers limits, active-versus-queued accounting,
transactional revision rejection, unchanged revision age/order, per-participant
fairness, source-sequence replay protection, stale room/track callbacks, late
returns at each stage, hostile cancellation quarantine, validated WAV duration,
owner shutdown and metadata bounds. Its memory regression completes 1,200 distinct
payloads, clears caller-owned outputs, checks zero internal reservations and
revision entries, and checks retained Python allocation drift after warmup.

`tests/test_worker_lifecycle.py` uses the real ASR/MT engine wrappers and actual
JSON-lines OS subprocesses with a tiny explicitly labelled protocol fixture. It
checks process reuse/shutdown, ASR track leave, MT reconnect, active deadline,
queued expiry without killing another owner, aggregate UTF-8 admission, cancellation
during OS spawn, close-caller cancellation, failed-reap quarantine/retry, and a descendant that outlives its
parent's SIGTERM. These tests prove control behavior, not model quality.

`tools/run_adapter_lifecycle_smoke.py` separately uses the first preserved English
FLEURS selection and the verified local base ASR / OPUS EN→RU workers. It records
real ASR output, the exact MT input/output, model hashes, elapsed time and two
successful text-only adapter completions around a cancellation/reconnect. The
cancelled warm ASR request is observed as owned by `ProcessStage`; native inference
entry is not separately instrumented. It checks PID reaping, cancelled queued work,
no cancelled publication, stale-handle rejection, fresh reconnection and final
idle-worker shutdown. It never replaces the original MT40/ASR40 quality evidence.

`tools/verify_lifecycle.py RUN_ID` runs the complete experiment unit suite and that
small real smoke, validates the actual cgroup limits, records source SHA-256 values
and memory/CPU counters, and checks existing tracked raw evidence against the base
commit. Its launcher must hold the shared verification lock **outside** systemd,
detach from the remote tool pipe, redirect stdin to `/dev/null`, and write stdout /
stderr to a regular log. Use a new `data/lifecycle/RUN_ID/` for each attempt; failed
attempts are retained. The script refuses to overwrite a verification receipt.

The complete remote receipt and real smoke result are stored separately under
`data/lifecycle/`. Read their exact status and source hashes before treating a run
as verified. A successful control receipt leaves `model_quality_gate: BLOCKED`.

## Historical bounded verification before participant review

The final run is `data/lifecycle/lifecycle-20261103t085141z-1429281/`:

- `verification.json`: **87/87 tests, 0 failures/errors/skips**, then a successful
  real adapter lifecycle smoke. Source hashes match at both ends of the run;
  existing tracked raw evidence matches the starting commit.
- `real-smoke/result.json`: the original selected English sentence **1661**,
  **6.36 seconds**, original WAV SHA-256
  `8a90dfd1aebb2b9c8315d8293c720223d7436079ace5299ad30a3ba552915081`.
  Real base ASR and OPUS EN→RU completed through the adapter before cancellation
  and after fresh registration/reconnect. Exact transcript, MT input/output,
  model provenance and hashes are in the result.
- Whole-utterance completion wall times: **5.370605 s** and **4.041728 s**. They
  include worker loading where needed and start after the full WAV is available.
  These two lifecycle traces are neither a latency distribution nor a live
  speech/first-audio measurement or an independent model comparison.
- Track unsubscribe cancelled both active and queued futures. The observed warm
  ASR worker was reaped **0.036306 s** after invalidation; native entry was not
  separately instrumented. No cancelled utterance was published. Old handles and
  the old room-leave callback were rejected; the new handle completed.
- Final room leave reaped both ASR and MT workers. Queued/active count, source
  bytes/audio duration, revision/track/playback entries and both engine pending
  byte counters were all **zero**; the adapters/stages were closed, not quarantined.
- Observed cgroup: `cpu.max=100000 100000`, `memory.max=2147483648`,
  `pids.max=256`. Peak memory was **788,766,720 bytes (752.23 MiB)**, peak task
  count **19**, with **0 OOM / OOM-kill / memory-max events**. The shared lock was
  outside the finite 240-second systemd unit. The entire run completed in about
  29 seconds; detached launcher exit code was **0**.

The final source passed 31 newly added regressions plus the original 56 experiment
checks. The real worker smoke downloaded nothing and produced no synthesized
speech. The final result continues to state `model_quality_gate: BLOCKED`.

## Still open

TR-11/TR-12 are implemented at the isolated adapter/process boundary. Wiring actual
LiveKit event callbacks, browser/microphone ingress, a bounded network publication
queue, native multilingual human acceptance, commercial TTS voices and realistic
speaker-load/first-audio measurements remain separate work. Current MT numerical,
currency, negation and Chinese boundary failures are unchanged. No production
service, deployment setting, model file, saved selection or historical benchmark
output is changed by this lifecycle work.

### Retained first verification attempt

`data/lifecycle/lifecycle-20261103t084316z-1353554/` records 83/83 unit checks,
0 failures/errors/skips, followed by a failed real smoke **before any model
inference**. The initial PCM16-only WAV boundary rejected the preserved FLEURS
IEEE-float32 WAV (sentence 1661, original bytes unchanged). The bounded parser now
accepts that verified format and tests nonfinite samples, duplicate/truncated data
and mismatched frame counts. The failed attempt remains visible; it is not a model
quality result. Independent review also identified the previously unproven reap
edge; a real-child test with fault-injected wait timeout now proves quarantine,
reservation retention, no replacement admission and later cleanup recovery.

## Independent participant review

The review based on 6813ad9 identified a stale-participant-leave defect within the
same room session. Room-session identity alone did not identify a specific
participant connection. The current API requires a separately registered
`ParticipantHandle` for track registration and participant leave. Keep the same
participant token during microphone replacement, capture it in every callback,
and obtain a new one only for a new authenticated participant connection. There
is no current-ID lookup or identity-only leave fallback. Idle participants count
towards the participant cap and explicit leave/disconnect/close removes them.

The negative reproducer failed before the change, then six new regression tests
and the complete 93-test control suite passed under CPU1/RAM2GiB. The prior real
model smoke remains historical evidence; it was not rerun for this API change.
See `COMMERCIAL_REVIEW_2026-11-03.md` and the `participant-*` receipts for exact
results and scope. That independent review also identified an OPEN process-group
ownership issue: `_stop()` can signal a numeric PGID after leader wait/reap.
The ordinary descendant test does not prove safety against PGID reuse. No claim
of complete native-process ownership acceptance is made while that issue remains.
