# Analysis model provenance

## Guarantee and boundaries

The worker no longer reports hardcoded repository names or revision strings. Every new result identifies the exact measured Whisper inventory and, when used, the actual measured GGUF. API acceptance is bound to the release's ANALYSIS_MODEL_MANIFEST_SHA256. A missing or invalid expected digest disables transcription configuration. Historical database results remain readable, but receive no retroactive provenance claim.

This is an integrity contract for the deployed private services, not remote attestation against a compromised host. The operator-approved manifest, immutable worker/summary images, private network, and read-only model volume form the trust boundary. Hashes identify bytes; they do not establish licensing, source authenticity, language quality, or sufficient performance. Faster Whisper's runtime and bundled VAD are supplied by the built worker image; this manifest specifically inventories the Whisper directory and optional summary GGUF, not every transitive runtime file.

No real model was downloaded or loaded during the synthetic verification described in the receipt. No live acceptance, model quality, image digest selection, registry verification, or commercial readiness is claimed by these tests.

## Manifest

The UTF-8 file is /models/analysis-manifest.json by default. The release sets its exact SHA256 separately in ANALYSIS_MODEL_MANIFEST_SHA256. ANALYSIS_MODEL_MANIFEST_PATH can select another absolute location. Model paths in the JSON are relative to the manifest's directory. Schema 1 has exactly these keys:

- schema: 1.
- whisper: directory and files; each file has path, sha256, bytes.
- summary: null for ASR-only, or one artifact with path, sha256, bytes.

The full Whisper directory is inventoried, including configuration and tokenizer. model.bin, config.json and tokenizer.json are mandatory so tokenizer lookup cannot fall back to a remote model. Include preprocessor_config.json and vocabulary files whenever the selected model supplies them. Unlisted files, duplicate entries or JSON fields, symlinks, traversal, missing files, size/digest mismatch, and a writable model mount fail closed. Files are streamed in bounded chunks; the manifest is capped at 256 KiB and inventories at 128 files. Identity is SHA256 of the canonical sorted measured inventory, not a label copied from environment configuration.

Prepare a new release directory containing already reviewed model files. The offline generator creates a new manifest and refuses to overwrite an existing release:

    python3 scripts/create-analysis-manifest.py --models /prepared/release --whisper whisper-model --summary summary.gguf

Omit --summary for transcription-only. Review and retain source/revision/license evidence separately. Store the emitted manifest digest in the private release configuration, mount that exact directory read-only at /models, and use the same digest in API, worker and summarizer. WHISPER_MODEL_PATH is optional legacy configuration; if set, it must match the manifest path exactly. A model change requires a new directory, manifest digest, release acceptance, and service restart.

## Loading and summary service contract

Whisper files are hashed before any private recording is fetched or model library imported. The loader receives only the verified directory and local_files_only=True. File identity/timestamps and exact inventory are checked before and after loading and after processing. A changed artifact invalidates the result. GET /health reports files-verified and whisperLoaded:false: this per-job worker does not pretend that its HTTP parent has a loaded Whisper model.

The summary service must use summary_launcher.py from Dockerfile.summarizer, without an entrypoint/command override. It verifies the same manifest and actual GGUF, opens and rehashes the GGUF, keeps that file descriptor across exec, and passes only that descriptor as llama.cpp --model. The --alias is derived from the measured hash: gguf-sha256-<digest>. Arbitrary server arguments and LLAMA_ARG_* overrides are not passed to the child. A read-only volume is required; host-side mutation remains outside the trusted deployment contract and detected metadata changes fail processing.

Before/after summary generation the worker requires a loaded /health response and a single /v1/models entry matching the verified alias. Every completion requests and checks that same model identity. Redirects are refused. If no speech was recognized, the explanatory static note has no summaryModel and no summary artifact provenance claim.

Upstream documentation underlying this contract:

- [llama.cpp server API](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md): health distinguishes loading/ready; models exposes the loaded model; alias sets its API identity.
- [Faster Whisper model loader](https://github.com/SYSTRAN/faster-whisper/blob/master/faster_whisper/transcribe.py): a directory loads locally and a missing tokenizer can trigger pretrained fallback.
- [Faster Whisper local conversion](https://github.com/SYSTRAN/faster-whisper#model-conversion): tokenizer and preprocessor configuration accompany converted model files.

The deployment must pin the actual upstream revision/digest whose behavior has been accepted. Current upstream documentation is not a substitute for testing the chosen binary.

## Deployment hooks

Base compose.yml remains owned by the release workflow. Optional compose.analysis.yml defines the private worker; add compose.summary.yml only for summaries. Neither service publishes a host port. Both have explicit CPU/memory/process limits, read-only root filesystem and models, bounded tmpfs and logs, dropped capabilities, and no-new-privileges.

Required release inputs:

- PYTHON_IMAGE: official Python image with @sha256 digest.
- LLAMA_SERVER_IMAGE for summaries: official ghcr.io/ggml-org/llama.cpp server image with @sha256 digest and /app/llama-server.
- ANALYSIS_WORKER_IMAGE and SUMMARY_WORKER_IMAGE: immutable locally built release images, retained with actual image IDs/digests.
- ANALYSIS_MODELS_PATH, ANALYSIS_MODEL_MANIFEST_SHA256, ANALYSIS_WORKER_SECRET.
- API ANALYSIS_WORKER_URL=http://analysis-worker:8090 and the same secret/digest; private recording S3 fields.
- TRANSCRIPTION_ENABLED and, only after accepted summary deployment, AI_SUMMARY_ENABLED.

Before building, run scripts/check-analysis-images.py (add --summary when needed) with the approved image environment. This checks official namespaces and digest-pinned syntax only; it makes no registry calls and explicitly does not certify a fabricated digest. Release acceptance must resolve the exact approved digest, bind built image IDs to the code commit, confirm the launcher is the entrypoint, and confirm the read-only mount/private endpoint. The base image and compiled binary must be accepted together; this change does not invent or select an upstream digest.

## Acceptance

Synthetic tests cover a previously accepted model.bin with a wrong manifest, refusal before S3/model access, measured result identity, corrupted/missing/extra artifacts, read-only enforcement, traversal/symlinks/duplicate fields, mutation at loader construction, descriptor-bound GGUF launch, override stripping, service loading/alias mismatch, completion mismatch, redirects, and the truthful health state. API tests require the configured digest and consistent measured inventory, persist provenance, and fail mismatched/legacy new responses.

Live acceptance still requires the real selected artifacts and image, cold load, a real recording, saved result provenance, service restart/mismatch tests, and the approved performance/quality/licensing checks. Do not mark that gate passed from synthetic tests alone.
