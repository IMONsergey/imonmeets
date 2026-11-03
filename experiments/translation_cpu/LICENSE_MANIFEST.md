# Translation experiment: provenance and license gate

Original snapshot: 2026-11-02; explicit artifact evidence updated 2026-11-03. This is an evidence ledger, not legal advice or commercial launch approval.

## Runtime components

| Component | Observed version / artifact | Upstream license evidence | Commercial gate |
|---|---|---|---|
| faster-whisper | 1.2.1 | Upstream repository publishes MIT license: https://github.com/SYSTRAN/faster-whisper/blob/master/LICENSE | Code license appears permissive. Pin exact wheel hash and model snapshot revision before release. |
| Whisper weights | Systran faster-whisper base and small multilingual snapshots are cached locally | OpenAI states original Whisper code and weights are MIT: https://github.com/openai/whisper#license ; model card: https://github.com/openai/whisper/blob/main/model-card.md | Exact cached revisions and per-file SHA-256 are recorded in `data/lineage/installed_artifacts.json` and reverified before real ASR. The model-byte identity is distinct from a product quality approval. |
| Argos Translate | 1.11.0 | Upstream repository says dual MIT or CC0: https://github.com/argosopentech/argos-translate | This covers the library, not automatically every downloaded language package. |
| Argos language packs | Local package directories include en↔ru, en↔zh, zh→en, ar↔en | Package index describes downloadable model archives: https://github.com/argosopentech/argospm-index | Installed versions, metadata/README hashes and model hashes are preserved in `data/lineage/installed_artifacts.json`. Exact weight grant/lineage remains incomplete; per-pack decisions and complete README evidence are in `data/provenance/argos/`. Not selected for new inference. |
| Piper runtime | Installed `piper-tts` 1.8.0; local wheel metadata and official PyPI release agree | **GPL-3.0-or-later** in wheel metadata, PyPI 1.8.0 and OHF-Voice/piper1-gpl v1.8.0 source: https://pypi.org/project/piper-tts/1.8.0/ ; https://github.com/OHF-Voice/piper1-gpl/blob/639388b6317fc4731e91d53da42aea68fd4166ff/setup.py | Corrected from the obsolete archived `rhasspy/piper` MIT reference. This is the Piper runtime/package license only; each voice/model file and its training data must be assessed separately. No legal conclusion about the combined distribution is made. |

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

The local inventory shows Piper ONNX files for all four named voices, Whisper base/small cache directories, and Argos package directories. Saved inventory establishes observed artifact revisions/hashes; it does not automatically establish every license grant. The 3 November section below records the new official OPUS artifacts actually downloaded. No production deployment was performed.

## Candidate replacements to evaluate, not yet integrated

| Layer | Candidate | Evidence | Fit / blocker |
|---|---|---|---|
| MT | Google MADLAD-400-3B-MT | Model card declares Apache 2.0 and 400+ languages: https://huggingface.co/google/madlad400-3b-mt | Best licensing/coverage candidate to benchmark for EN/RU/ZH/AR. 3B parameters are far beyond the current 2 GiB budget; evaluate only on a separately budgeted larger worker. CPU latency and quality on our corpus are unmeasured. |
| TTS | hexgrad/Kokoro-82M v1.0 | Model card declares Apache-2.0 weights; v1.0 release table lists 8 languages and 54 voices: https://huggingface.co/hexgrad/Kokoro-82M ; voice inventory: https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md | Correction: not English-only. The published voice inventory explicitly includes Mandarin Chinese (8 voices). It lists no Russian or Arabic voices, so RU/AR support is not established. Model/voice inventory does not prove pronunciation quality on our corpus or resolve separate dataset/dependency obligations. The model page also labels its task as English; validate actual per-language support before selecting it. |
| Speech-to-speech | Meta SeamlessM4T v2 / SeamlessStreaming | Official repository states the model weights are CC-BY-NC 4.0: https://github.com/facebookresearch/seamless_communication/blob/main/README.md | Not a commercial product candidate under current license; exclude. |

At the 2 November snapshot no replacement candidate had been downloaded. The 3 November OPUS continuation below supersedes that historical status. Do not equate a repository badge with third-party dataset, voice, dependency or trademark clearance. No confirmed single local model currently meets all four language directions, TTS quality, commercial rights and the 2 GiB CPU budget. A practical next step is a separately isolated MADLAD MT quality/latency benchmark on a machine with adequate RAM, while keeping TTS modular and sourcing commercially cleared native voices per language.

## Piper runtime versus voice artifacts

The installed `piper-tts==1.8.0` wheel metadata was independently inspected on the experiment host and reported `License: GPL-3.0-or-later` and homepage `OHF-voice/piper1-gpl`. The official PyPI 1.8.0 record and the versioned OHF source metadata agree. The previous MIT statement based on the archived `rhasspy/piper` repository was incorrect and is withdrawn. Do not use the archived repository license to characterize the 1.8.0 runtime.

This runtime finding does not change the per-voice evidence above. The four cached ONNX voice artifacts remain separate model/voice assets with separate training-data and redistribution questions. No voice is cleared merely because the runtime's source license is known. The metadata result is an observation of the installed package, not a complete bill-of-materials or a legal opinion on the combined application.

## Kokoro v1.0 language correction

The official model card's v1.0 row lists 8 languages / 54 voices. Its official `VOICES.md` inventory splits English into American and British voice groups, then lists Japanese, Mandarin Chinese, Spanish, French, Hindi, Italian and Brazilian Portuguese: eight languages in total. Mandarin has eight listed voices. The inventory does not list Russian or Arabic voices. The model card's task badge is English; do not infer production-grade support for every listed language from the release count alone.

Sources:
- PyPI release and wheel metadata: https://pypi.org/project/piper-tts/1.8.0/
- Piper v1.8.0 source metadata: https://github.com/OHF-Voice/piper1-gpl/blob/639388b6317fc4731e91d53da42aea68fd4166ff/setup.py
- Kokoro model card: https://huggingface.co/hexgrad/Kokoro-82M
- Kokoro voice inventory: https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md

## 3 November: exact original OPUS artifacts and voice findings

Six direct CPU MT paths use official original Marian NPZ releases: EN↔RU, EN↔ZH, EN↔AR. The actual archive contains the CC-BY-4.0 legal text. `data/provenance/opus/sources.json` binds the official model-card/source README revision to each release URL; `*.download.json` records archive bytes/SHA-256; `*.conversion.json` records each NPZ/tokenizer/vocabulary/converted file SHA-256 and the INT8 conversion. The six release LICENSE files are preserved. Attribution: University of Helsinki Language Technology Research Group / OPUS-MT; Tiedemann and Thottingal (2020), and the source release listed for each direction. Changes: conversion from Marian NPZ to CTranslate2 INT8; original training weights are not retrained.

The HF EN→AR card's original 2020-07-03 archive returned HTTP404. The preserved failure receipt and source record document the switch to the official standard-transformer `eng-ara/opus-2021-02-23` release, pinned by Tatoeba-Challenge README commit `5509af44a74016748c26f41ab164b64f48445f3f`. It requires `>>ara<<`; EN→ZH requires `>>cmn_Hans<<`. No unsupported assertion that this is the same checkpoint as the broken HF link is made.

No archive shell script, remote model code or pickle checkpoint was executed. NPZ arrays are loaded with pickle disabled; archives reject traversal/symlinks and only the required model files are extracted. The original OPUS grant covers the loaded originals; the HF Apache badges are not silently substituted for the archive's CC-BY license. Old Argos packages are not treated as independent competitors to unknown identical OPUS source weights.

The original Lessac2013 data licence was read directly at https://www.cstr.ed.ac.uk/projects/blizzard/2013/lessac_blizzard2013/license.html (saved SHA-256 `90daa40c39c81f11a54e6b87dec472620ff2110141f4eb34f87924491e6b218b`). Its Research Purposes definition explicitly excludes commercial development and commercial speech synthesis/recognition services. This is a data licence finding; downstream trained-weight rights need their own valid chain of permission. The Piper repository MIT badge alone does not resolve this chain.

Newly inspected Russian Denis/Dmitri cards declare CC0 datasets but explicitly identify Lessac as their finetuning base. Irina declares an unknown dataset licence. Kareem points at `AliMokhammad/arabicttstrain`; the observed repository root has no LICENSE and its GitHub licence metadata is null. Full cards/primary terms are in `data/provenance/tts_candidates/`. No new voice was downloaded or synthesized; no NC/unknown voice is approved by this continuation. The live TTS gate remains open rather than substituting an unapproved voice.
