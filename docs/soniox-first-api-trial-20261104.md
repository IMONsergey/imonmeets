# First real Soniox API trial, 2026-11-04

The owner supplied a project API key after requesting the first bounded test. The key was installed privately outside Git. Authenticated model discovery returned HTTP 200 for `stt-rt-v6` and `tts-rt-v2`, including voice Adrian and RU/EN/ZH/AR coverage. No purchase, account-wide limit change or production deployment was performed.

**Result: the real audio pipeline is connected, but the initial quality trial failed.** Do not enable translated speech in ordinary meetings based on these runs. The trial configuration has been disabled again while retaining the key and durable reservations.

## Fixed transport defect

The first attempt timed out before sending any audio. DNS returned IPv6 addresses first; direct sequential TCP/TLS attempts took about 12 seconds to fall back to working IPv4. The 8-second WebSocket connection deadline therefore expired. Enabling Happy Eyeballs (`happy_eyeballs_delay=0.25`, `interleave=1`) made unauthenticated STT/TTS WebSocket handshakes complete in 0.656/0.613 seconds on this host. No host network, VPN, firewall or DNS configuration was changed. STT/TTS connection timeouts now have separate content-free error codes.

WAV evaluation now saves final original recognition in `transcription.jsonl`, separately from candidate text admitted to synthesis in `translation.jsonl`. Room mode does not persist either. This distinguishes ASR mistakes from translation mistakes. Source text and provider error details never enter ordinary console receipts.

## Input provenance

The test used the **first sentence in the existing pinned FLEURS selection**, ID1661, selected before provider execution, with one RU and one EN recording. No new examples were selected after seeing results.

Google FLEURS, https://huggingface.co/datasets/google/fleurs, CC-BY-4.0, revision `70bb2e84b976b7e960aa89f1c648e09c59f894dd`. Selection manifest SHA256: `caf155b7d8b440132295416f7d0ebd210061add74672e39d7e929dffb60ae62a`. Original WAV hashes matched the earlier experiment. Input conversion only changed the WAV encoding to PCM16 mono16k; no trimming or speech edits. See `evidence/soniox-api-trial-20261104.json` for hashes and receipts. The fourth run repeats RU solely to capture missing ASR diagnostics; it is not an independent sample.

## Actual outcomes

| Queue job | Direction | Outcome | Input / accepted output audio | First text / first audio |
| --- | --- | --- | --- | --- |
| 20261104T182842-3ad914d83e | RU→EN | Connection timeout, before audio | 0 / 0 seconds | none |
| 20261104T183251-72c1f4a1c6 | RU→EN | Pipeline completed; critical semantic error | 9.06 / 6.741 seconds | 6.068 / 7.900 seconds |
| 20261104T183537-a43d417b0c | EN→RU | STALE_TRANSLATION; poor candidate translation | 6.36 / 0 accepted seconds | 3.983 / none |
| 20261104T183650-22eac0c034 | RU→EN diagnostic repeat | Pipeline completed; same critical error | 9.06 / 6.656 seconds | 5.904 / 7.673 seconds |

Times start at pipeline initialization and are **not listener latency, phrase-relative delay, p95 or a production SLO**. EN→RU synthesis began but its first audio arrived after the 5-second segment deadline and was rejected; zero accepted output does not imply zero provider billing.

RU reference: “Он не назвал цифру для сокращений бюджетов, сказав, что они будут сделаны исходя из производительности экономики Китая.”

The diagnostic run recognized: “Он мне назвал цифру для сокращения бюджетов, сказав, что они будут сделаны исходя из производительности экономики Китая.” It translated the opening as “He gave me a figure for cutting budgets,” reversing the original negation. Both RU executions produced the same translated text. Earlier saved Whisper base and small outputs for the exact original audio hash retain “Он не назвал”. This establishes a regression against the reference on this specific recording, not a general ranking of providers.

EN source recognition retained the full original sentence: “He did not set a figure for the cuts, saying they will be made based on China's economic output.” The first admitted Russian segment was “Он не назвал сумму за срезы,”. This is an unsuitable translation of “cuts” in this example. Later translated segments were not admitted to synthesis after the timeout, so this file is not a complete translation transcript. No domain context or glossary was configured; broader conversational quality remains unknown.

## Validation and spending boundaries

The final code passed **23 tests, no skips**, queue job `20261104T183455-b6e08c55e2`, exit0. This includes separate source diagnostics, service-specific connection timeout reporting, actual local WebSocket transport and the isolated LiveKit audio fixture. The earlier22-test run predates source diagnostics and is not added to this count.

Four attempts reserved 200 US cents in the local ledger: two completed and two failed. The configured total reservation budget remains500 cents. **Reserved amounts are not an invoice.** Actual account charges/credits were not retrieved. Paid/API execution is now disabled; the installed key and the ledger are retained. No automatic retry, refund or budget reset was used.

No real Meets room, production admission, listener device, external TURN or RU↔ZH/AR provider trial was exercised. Voice naturalness has not been independently listened to and accepted.

## Next work

Keep the observed failures in the fixed regression set. Test an explicit domain context and alternative supported Soniox model/configuration only as separate recorded experiments, without manually repairing negation. Investigate Russian TTS cold-start/first-chunk time separately from STT and translation; do not silently increase the speech deadline to call it a pass. Establish an independent multi-speaker/critical-meaning sample before any live room trial. Full listener routing, entitlement, echo and capacity work remains open.
