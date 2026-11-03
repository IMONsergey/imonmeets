# CPU speech translation experiment

Isolated prototype for I’MON Meets, 2 November 2026. No production changes.

## Current evidence (3 November 2026)

The saved 40 common FLEURS sentence IDs and source TSVs are unchanged and committed. Six direct MT directions have actual model outputs in `data/mt40/opus-original-20261103/`; success means inference completed, not acceptable translation quality. Explicit sentence segmentation is evaluated separately on the same weights, including six frozen new holdout scenarios per direction. No amount, currency or negation is repaired after translation.

Actual selected audio is streamed from the official pinned test archives. The complete archive SHA-256 is verified against the pinned HF LFS object, but only the manifest-selected 40 WAVs per language are persisted. No Dataset Viewer/current-revision proxy is substituted. Audio hashes and exact frames/sample-rate are in `data/fleurs_subset/audio-*.json`.

See [measured results](RESULTS_2026-11-03.md), [continuation scope](CONTINUATION.md), and [artifact rights](LICENSE_MANIFEST.md). The real process workers in `real_engines.py` and `tools/model_worker.py` support local ASR and MT only. The current bounded adapter lifecycle and its separate control evidence are documented in [LIFECYCLE_2026-11-03.md](LIFECYCLE_2026-11-03.md). They do not supply TTS, a LiveKit integration, commercial acceptance or first-audio latency evidence.

## Historical engines (2 November)

- faster-whisper base multilingual, CPU INT8
- Argos Translate, with English pivot for Chinese/Arabic to Russian
- Piper voices: en_US-lessac-medium, ru_RU-ruslan-medium, zh_CN-huayan-medium, ar_JO-kareem-medium

These describe the historical synthetic benchmark. Do not rerun the legacy Piper preparation/benchmark as a commercially approved pipeline: its voice rights remain unresolved. The 3 November continuation uses verified original OPUS NPZ weights, real preserved FLEURS audio, and `tools/run_bounded.sh` under the shared verification lock (CPU1, RAM2GiB).

Results and generated WAVs: `data/` (ignored by Git).

## Measured end-to-end sequential processing (one CPU)

| Direction | Input audio | ASR | Translation | TTS | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| en to ru | 4.481 s | 3.061 s | 9.194 s cold | 3.846 s | 16.101 s |
| ru to en | 6.211 s | 3.320 s | 1.820 s | 3.554 s | 8.694 s |
| zh to ru | 5.016 s | 3.048 s | 1.388 s | 1.961 s | 6.397 s |
| ar to ru | 7.396 s | 3.111 s | 1.246 s | 2.139 s | 6.496 s |

Preparation job: `20261102T100703-47ab2a1138` (success). Full benchmark: `20261102T101959-7f47a12c49` (success after PyAV downgrade from 19 to 16.0.1).

## Warm benchmarks: base versus small

| Direction | base | small |
| --- | ---: | ---: |
| en to ru | 7.110 s | 12.912 s |
| ru to en | 6.293 s | 10.195 s |
| zh to ru | 7.498 s | 9.593 s |
| ar to ru | 6.599 s | 9.797 s |

Benchmark jobs: base `20261102T102809-983a79d489`, small `20261102T102834-9afb61b560`. Raw files: `data/results_base_warm.json`, `data/results_small_warm.json`. The previous cold test is `data/results.json`.

Small improved recognition of Chinese names and numbers, but English "Sergey" and Russian "цена" were still misrecognized. Arabic meaning remained unreliable even when translated from correct text. No measurements include first-streaming-chunk latency.

## Limitations

Synthetic Piper-produced sample phrases, not microphone input, real-time streaming or overlapping speakers. Model loads are excluded from pipeline totals; processing begins after the full input utterance. Names, numbers and meaning suffered errors. Chinese speech translation omitted the price; Arabic textual translation omitted most of the meaning. Each voice and translation-model license needs checking before commercial integration. Same-mic multi-speaker diarization and separate LiveKit tracks are untested.

## Isolated streaming contract and synthetic corpus (2 Nov 2026)

- `data/corpus.json` is a deterministic, text-only corpus. It covers names, amounts, currencies, decimal values, negation, silence, interruption, ASR/MT semantic cases and independent TTS prompts. It contains no audio recordings or personal voice samples.
- The three baseline failures are retained as open regressions: name/price confusion, Chinese amount loss, Arabic semantic loss. A passing adapter test does not close any model-quality regression.
- `LICENSE_MANIFEST.md` records the provenance and per-artifact license gate. The Piper runtime is GPL-3.0-or-later, while the voice assets remain separately assessed. The Russian Ruslan training corpus is CC BY-NC-SA 4.0; Huayan dataset license is unknown; Kareem dataset license is unresolved. None of those voices is approved for commercial deployment on current evidence.
- The original adapter was an isolated FIFO utterance contract. The current `streaming_adapter.py` adds explicit room-session/track handles, source-sequence replay protection, participant round-robin scheduling, active-plus-queued byte/audio-time budgets, queue/result deadlines, bounded playback/track state, and owned engine shutdown. Its experimental API deliberately requires the captured handle and monotonic source sequence; identity-only callbacks are not accepted. See the lifecycle document for usage, default bounds and evidence limits. TTS remains optional and commercially unaccepted.
- Fake-engine tests: run from the repository root with `/home/sergey/imonmeets-translation-cpu-20261102/.venv/bin/python -m unittest discover -s experiments/translation_cpu/tests -v` under `imon-job`. Baseline suite receipt: `20261102T153737-c8fd815f0d`, 10/10 passed. Independent-review regression suite: `20261102T161229-0b46f56db5`, 17/17 passed; repeated three times in receipt `20261102T161409-7a190ed158`, all 17/17 each run.
- The first test attempt exposed a cancellation-before-coroutine-start race and was cancelled after it stalled. Independent review then reproduced phrase loss, caller-cancel publication, stale queue reservations and late publication after close. Negative tests were added before the adapter redesign; the final suite and three repeated runs passed.

### Explicit non-goals / remaining integration work

No LiveKit event wiring, microphone chunk framing, VAD, diarization, jitter handling, sample-rate conversion, streaming codec buffering, browser output playback, production config or deployment. Room/participant/track lifecycle is now an explicit adapter contract, tested in isolation. The validated WAV entry point is whole-utterance PCM16 or IEEE-float32, mono/16kHz, not a live media decoder. The current playback suppression requires the room integration to register a stable playback token; acoustic echo cancellation is not implemented. Multiple human speakers sharing one microphone remain unsupported and unverified. No first-audio latency measurement exists. Do not present this adapter or current MT models as a working production translator.

### Replacement engine shortlist

- MT: Google MADLAD-400-3B-MT declares Apache 2.0 and supports 400+ languages, but 3B parameters exceed the current 2 GiB worker budget. Benchmark only on a larger isolated worker; quality and CPU latency remain unmeasured.
- TTS: Kokoro-82M v1.0 declares Apache-2.0 weights and its official v1.0 voice inventory covers eight languages including Mandarin Chinese (8 listed voices). No Russian or Arabic voices are listed. It is not a four-language replacement; check inference dependencies and exact voice/data terms separately.
- SeamlessM4T v2 is technically interesting but its model weights are CC-BY-NC 4.0, so exclude it from commercial product evaluation absent separate rights.
- Candidate evidence and URLs are in `LICENSE_MANIFEST.md`. No candidate was downloaded or installed.
