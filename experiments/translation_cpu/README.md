# CPU speech translation experiment

Isolated prototype for I’MON Meets, 2 November 2026. No production changes.

## Engines

- faster-whisper base multilingual, CPU INT8
- Argos Translate, with English pivot for Chinese/Arabic to Russian
- Piper voices: en_US-lessac-medium, ru_RU-ruslan-medium, zh_CN-huayan-medium, ar_JO-kareem-medium

Install in a Python 3.12 venv using `requirements.txt`, then run `python run.py prepare` followed by `python run.py bench` under the shared `imon-job` queue (1 CPU, 2 GiB RAM budget).

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
