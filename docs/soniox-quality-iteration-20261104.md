# Soniox quality and latency iteration, 2026-11-04

The pilot now preserves phrase boundaries, supports text-only diagnosis and explicit meeting context, and measures connection, assembly, queue and synthesis timing separately. Domain context restored the two specific meaning failures on the same known RU/EN example. Live speech is still **not accepted**: the final correct RU translation could not be voiced within the unchanged five-second text-freshness limit because TTS connection establishment took 5.324 seconds.

## Scope and provenance

The owner requested continued improvements after the first API trial. Six additional bounded calls used the same private key and shared ledger. No production deployment, merge, live room, new account, purchase or billing settings change. The persistent enable flag stayed false; the ignored operator runner enabled only its individual bounded job in memory. Caps remained 60 seconds input, 120 seconds output, 1200 translated characters, 50 US cents reservation per attempt and 500 US cents total.

These are repeated tuning trials of FLEURS sentence ID 1661 in RU (9.06 seconds) and EN (6.36 seconds), **not independent held-out examples**. Source selection, revision, license and original audio hashes are retained in [initial evidence](evidence/soniox-api-trial-20261104.json). The same PCM16 conversions were reused without trimming. Public-source attribution: Google FLEURS, CC-BY-4.0, revision `70bb2e84b976b7e960aa89f1c648e09c59f894dd`.

Implementation checkpoints: `bb9d0a497b98fb9a4b250d8deeb09c7770b4ba8b` adds boundaries, context and diagnostics; `7131583eb0f8b346031d30c402db8dec21184a00` adds the explicit IPv4 profile. The first three calls ran the development worktree based on `364b71e`, with the hardening changes before optional context loading was added. Context text-only calls ran `bb9d0a4`; the last speech call ran `7131583`. A subsequent control fix rejects text that expires during TTS connection before sending a synthesis request; that fix has offline regression coverage but was not followed by another paid call.

## Actual API results

Every call used a 2000 ms endpoint setting. Default models remain `stt-rt-v6` and `tts-rt-v2`, voice Adrian.

| Job | Route and configuration | Observed result |
| --- | --- | --- |
| 20261104T190421-3ef43ddccb | RU→EN, v6, no context, speech | Completed technically, but ASR still changed negation to "мне". One complete 117-character synthesis stream, 6.400 seconds output. |
| 20261104T190509-a033308df6 | EN→RU, v6, no context, speech | Completed technically; wrong "сумму за срезы" remained. One 103-character stream, 5.973 seconds output. |
| 20261104T190545-c55fc55652 | RU→EN, v5, text only | Retained negation, but introduced another imprecision about production capacity and economy. Diagnostic comparison only: v5 is deprecated and scheduled for removal on December 15, 2026. |
| 20261104T190759-ec89c7e644 | RU→EN, v6, domain context, text only | ASR retained "Он не назвал"; translation retained "He did not give a figure". 122 characters, no TTS connection. |
| 20261104T190901-336ac12539 | EN→RU, v6, domain context, text only | Translation used "Он не назвал сумму сокращений" and economic indicators. 107 characters, no TTS connection. |
| 20261104T191215-653aa8bf86 | RU→EN, v6, domain context, speech, IPv4 | Same corrected target text, but `STALE_TRANSLATION`. Received 12,288 PCM bytes, accepted zero. The stream can still incur provider usage. |

Domain context contained only two metadata entries: economics/government budgets and public spending/economic indicators, written in the source language. It did not contain the source reference sentence, target answer, negation correction or a hand-picked translation for "cuts". This is still tuning on known failures, not proof of generalization. Context is an optional private JSON file supplied by an operator; it is never globally imposed on unrelated meetings.

Exact receipts, output text and artifact hashes are in [safe evidence JSON](evidence/soniox-quality-iteration-20261104.json). Private audio/JSONL artifacts remain in the operator state directory, not Git.

## Latency findings

For the first two speech runs, TTS request-to-first-PCM was 347.5 ms and 390.6 ms. Phrase assembly took 3.499 and 2.526 seconds. STT connection establishment took 5.586 and 0.600 seconds. First accepted audio was 15.358 and 7.490 seconds **since pipeline initialization**, not source-to-listener latency. These two observations do not establish a latency distribution or SLA.

A separate no-key DNS probe (`20261104T191001-907744f7c6`) observed one AF_UNSPEC lookup at 10.032 seconds; subsequent IPv4-only lookups were 0.47–1.27 ms, with cache/order effects uncontrolled. An explicit per-worker IPv4 setting was added, retaining hostname DNS and normal TLS verification. No system resolver, route or VPN was changed, and no provider IP was pinned.

IPv4 was not a complete cure. On the last speech run, STT connection was 339 ms, but TTS connection still took 5324 ms. Assembly took 3502 ms, and the first PCM arrived 343 ms after the synthesis request, at a total text age of 9168 ms. The five-second freshness control rejected it. This does not identify which subphase of TTS connection caused the stall. The latest fix rechecks age after connection, before sending synthesis configuration/text, avoiding such an already-expired synthesis request. Prepare/reuse connections earlier and isolate DNS/TCP/TLS/WebSocket phases before another live-audio trial; do not increase the deadline merely to make a test pass.

## Controls and remaining acceptance

The forced 0.75-second and 240-character cuts are removed. Decimal values, short abbreviations, token fragments and explicitly original-language endpoint markers have regressions. Conservative target boundaries can add latency; long incomplete phrases stop rather than being voiced. Text-only mode records final source and target streams separately; speech requires `--with-speech`. All received final translation is retained up to termination, including when synthesis fails; `synthesis.jsonl` is separate from `translation.jsonl`. No recognition words are automatically rewritten.

Final suite: 36 tests, zero skipped, including real loopback WebSockets and isolated LiveKit with synthetic audio, job `20261104T191418-da8765d94e`. This includes the post-connection expiry regression. No live product room, physical microphone/listener, external TURN, Mandarin/Arabic quality, naturalness assessment, held-out corpus or load acceptance has been performed.

Ledger after all trials: ten reservations, seven completed and three failed, 500 of 500 US cents reserved. **Reservations are not the provider invoice**; actual billed usage/credits were not retrieved. No ledger reset or automatic retry. Further paid calls are blocked by the existing local cap. Key retained, private file mode 600, persistent `enabled=false`, server worker profile `ipv4`. Development and unpaid checks can continue without raising this cap.

Next: evaluate held-out speech with actual meeting topics; investigate and pre-establish TTS connection; then measure physical source-to-listener delay and listener routing in a dedicated room. Soniox remains an evaluation provider. The old CPU speech path remains disabled and is not an automatic fallback.

Official contracts checked: https://docs.soniox.com/stt/concepts/context, https://docs.soniox.com/stt/rt/endpoint-detection, https://docs.soniox.com/stt/models.
