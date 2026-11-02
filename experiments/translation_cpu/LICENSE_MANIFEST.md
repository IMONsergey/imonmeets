# Translation experiment: provenance and license gate

Snapshot: 2026-11-02. This is an evidence ledger, not legal advice or a commercial-use approval.

## Runtime components

| Component | Observed version / artifact | Upstream license evidence | Commercial gate |
|---|---|---|---|
| faster-whisper | 1.2.1 | Upstream repository publishes MIT license: https://github.com/SYSTRAN/faster-whisper/blob/master/LICENSE | Code license appears permissive. Pin exact wheel hash and model snapshot revision before release. |
| Whisper weights | Systran faster-whisper base and small multilingual snapshots are cached locally | OpenAI states original Whisper code and weights are MIT: https://github.com/openai/whisper#license ; model card: https://github.com/openai/whisper/blob/main/model-card.md | Cached converted model revisions and exact hashes have not yet been recorded. Do not assume the upstream statement alone establishes provenance of each cached conversion. |
| Argos Translate | 1.11.0 | Upstream repository says dual MIT or CC0: https://github.com/argosopentech/argos-translate | This covers the library, not automatically every downloaded language package. |
| Argos language packs | Local package directories include en↔ru, en↔zh, zh→en, ar↔en | Package index describes downloadable model archives: https://github.com/argosopentech/argospm-index | Exact archive versions, hashes, training-data provenance and per-model license were not captured. Commercial clearance: UNKNOWN. |
| Piper runtime | 1.8.0 | Upstream Piper source license is MIT: https://github.com/rhasspy/piper/blob/master/LICENSE.md | Runtime code license does not grant rights to the voice datasets or trained weights. |

## Exact Piper voices

| Voice | Official model-card evidence | Finding | Decision |
|---|---|---|---|
| en_US-lessac-medium | https://huggingface.co/rhasspy/piper-voices/blob/main/en/en_US/lessac/medium/MODEL_CARD | Model card links the Lessac Blizzard 2013 dataset license: https://www.cstr.ed.ac.uk/projects/blizzard/2013/lessac_blizzard2013/license.html . The actual license terms and downstream trained-weight grant have not been independently adjudicated here. | Hold for legal review; not approved. |
| ru_RU-ruslan-medium | https://huggingface.co/rhasspy/piper-voices/blob/v1.0.0/ru/ru_RU/ruslan/medium/MODEL_CARD | Dataset license explicitly links CC BY-NC-SA 4.0: https://creativecommons.org/licenses/by-nc-sa/4.0/ . | Not suitable for commercial deployment under the stated non-commercial restriction unless separate permission is obtained. |
| zh_CN-huayan-medium | https://huggingface.co/rhasspy/piper-voices/blob/main/zh/zh_CN/huayan/medium/MODEL_CARD | Model card says dataset license is Unknown. Dataset: https://github.com/PlayVoice/HuaYan_TTS . | Not approved; replace or obtain written rights. |
| ar_JO-kareem-medium | https://github.com/rhasspy/piper-samples/blob/master/samples/ar/ar_JO/kareem/medium/MODEL_CARD | Model card says dataset license: "See URL"; dataset: https://github.com/AliMokhammad/arabicttstrain/ . The dataset license and rights to redistributed trained weights remain unverified. | Not approved; replace or obtain written rights. |

## Required evidence before any model is shipped

1. Pin repository commit / model revision, archive URL, file SHA-256 and package version for every artifact actually loaded.
2. Preserve the exact license text and model card alongside the artifact.
3. Verify rights for training data, derived weights, redistribution, commercial SaaS inference and attribution obligations.
4. Do not equate a repository-level MIT badge with a dataset or individual voice license.
5. Unknown or non-commercial artifacts remain excluded from production.

## Evidence boundary

The local inventory shows Piper ONNX files for all four named voices, Whisper base/small cache directories, and Argos package directories. The local inventory alone does not establish exact model revisions, SHA-256 values, or complete license grants. No production deployment or model download was performed as part of this manifest.

## Candidate replacements to evaluate, not yet integrated

| Layer | Candidate | Evidence | Fit / blocker |
|---|---|---|---|
| MT | Google MADLAD-400-3B-MT | Model card declares Apache 2.0 and 400+ languages: https://huggingface.co/google/madlad400-3b-mt | Best licensing/coverage candidate to benchmark for EN/RU/ZH/AR. 3B parameters are far beyond the current 2 GiB budget; evaluate only on a separately budgeted larger worker. CPU latency and quality on our corpus are unmeasured. |
| TTS | hexgrad/Kokoro-82M v1.0 | Model card declares Apache-2.0 weights and lists English as the model language: https://huggingface.co/hexgrad/Kokoro-82M/blob/ed43a87ac78103dc9af46d33fc9f4414951c9493/README.md | Plausible English-only TTS candidate, not a four-language replacement. The published inference path includes espeak-ng (GPLv3 dependency); preserve notices and check distribution implications. Exact voice pack / pronunciation quality still require tests. |
| Speech-to-speech | Meta SeamlessM4T v2 / SeamlessStreaming | Official repository states the model weights are CC-BY-NC 4.0: https://github.com/facebookresearch/seamless_communication/blob/main/README.md | Not a commercial product candidate under current license; exclude. |

No candidate was installed or downloaded. Do not equate Apache/MIT model weights with third-party dataset, voice, dependency or trademark clearance. No confirmed single local model currently meets all four language directions, TTS quality, commercial rights and the 2 GiB CPU budget. A practical next step is a separately isolated MADLAD MT quality/latency benchmark on a machine with adequate RAM, while keeping TTS modular and sourcing commercially cleared native voices per language.
