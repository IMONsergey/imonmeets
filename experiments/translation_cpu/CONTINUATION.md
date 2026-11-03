# Translation continuation — 3 November 2026

## Starting checkpoint

- Branch: `feature/imonmeets-translation-cpu-20261102`.
- Starting commit: `de8e9c0a4f5038eed7a5df1c035ebc3020f74156`.
- Preserve the existing FLEURS 40 common sentence IDs; do not recreate selection.
- Preserved selection SHA-256: `caf155b7d8b440132295416f7d0ebd210061add74672e39d7e929dffb60ae62a`.
- Preserved installed-artifact evidence SHA-256: `facd8f99bb5fc2e4c05a7603303a7a209adf91d99deb34501476c0e9278591b0`.
- Source TSVs, selection, saved lineage and preparation scripts are checkpointed. Virtual environments, weights and generated audio stay out of Git.
- The selection scripts are retained for reproducibility, not rerun during this continuation.

## Execution boundary

Only isolated development and public model artifacts are authorized here. No production/configuration changes, private audio, paid API calls or NC voices.

All heavy downloads, conversion, inference and tests use the shared lock `/home/sergey/.local/state/imonmeets-commercial-20261103/verify.lock` outside a transient `systemd --user` unit with CPUQuota=100%, MemoryMax=2G, TasksMax=128, a finite RuntimeMaxSec and KillMode=control-group. Each direction checkpoints independently. The budget is not increased after failure.

## Evidence distinctions

The prior 17/17 adapter tests use fake engines; they establish control-flow behavior only. No FLEURS audio has been run and no MT40 inference result existed at the starting checkpoint. Existing synthetic benchmarks retain their known name, number, currency and Arabic meaning failures.

The current stage is real MT on saved gold transcripts plus authored critical contrasts. Record the exact input, output, source/target languages, target token, model/hash, runtime and error for each attempt. A model completing inference is not a quality PASS.

EN→ZH requires `>>cmn_Hans<<`; EN→AR requires `>>ara<<`. Same upstream weights after a wrapper or quantization change are not independent candidates.

## Next stages

1. Resolve the usable exact model artifact/license boundary and perform bounded MT40.
2. Review critical negation, number, currency, name and omission cases; leave failures open explicitly.
3. Run the already selected real ASR audio only after safely obtaining and hashing it.
4. Source commercially admissible TTS voices before real voice tests.
5. Connect real bounded engines and audio framing to the adapter and then isolated LiveKit integration.

Quality, rights, resource capacity and real browser acceptance are separate release gates. This checkpoint does not approve a commercial voice-translation launch.
