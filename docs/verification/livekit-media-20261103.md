# Isolated LiveKit audio/video acceptance — 2026-11-03

## Accepted result

**PASS_MEDIA_AND_SIGNALING: 19 checks. Both synthetic audio and video accepted over ICE/TCP. UDP and TURN are not accepted by this result.**

The final run `mediaaudio20261103d1` used actual LiveKit 1.13.11, the actual core API with a disposable PostgreSQL schema, nginx authorization subrequests, pinned HAProxy, and two real Chromium SDK peers. The admission checks did not change. The runner now fails on any media failure; it no longer falls back to a signaling-only PASS.

| Received evidence | Peer A | Peer B |
|---|---:|---:|
| Remote source tone | 660 Hz | 440 Hz |
| Measured spectral peak | 656.25 Hz | 445.3125 Hz |
| Decoded audio samples | 60,480 | 60,480 |
| Audio RTP payload bytes | 4,864 | 4,856 |
| Decoded VP8 frames | 2 | 3 |
| Video RTP payload bytes | 1,168 | 1,363 |
| Transport | ICE/TCP, DTLS connected | ICE/TCP, DTLS connected |

The audio sources are browser oscillators, not microphones. Remote tracks use the SDK attach/playback path with muted output, while a Web Audio analyser measures the decoded remote waveform. The FFT resolution is 23.4375 Hz; the two expected frequencies are distinct. RMS, expected frequency, RTP payload and nonzero decoded sample counts are all asserted. Speakers are not exercised.

The video sources are 160×90 canvases at 2 fps, not cameras or screen capture. Each publisher carries a different two-bit black/white signature. Both receivers decoded the other participant's expected signature; the observed marker pixels were exactly black and white. The test also asserts RTP bytes and at least two decoded frames in each direction.

All four signaling routes, targeted kick/ban, original and freshly signed revoked identities, room generation rotation, waiting admission without a JWT and API-outage fail-closed responses passed again while the initial peers were real media connections. All owned containers, schema and private files were removed: `cleanupVerified=true`, `outerCleanupVerified=true`.

## Cause of the earlier failure and controlled comparison

The earlier fixture combined Docker bridge networking, advertised host-loopback addresses and `rtc.enable_loopback_candidate=true`. That option also collects loopback candidates **inside the container**, where 127.0.0.1 is a different network endpoint from the host-published address.

The diagnostic control `mediadiag20261103a1` reproduced the failure. Browser SDP had the intended host-loopback UDP/TCP candidates, and LiveKit logs showed actual incoming STUN requests from the Docker bridge gateway to a loopback-backed candidate. Reverse binding requests expired. Thus, signaling authorization and arrival of the initial ICE requests were working; the failure was beyond the ingress gate.

Changing the sole transport-configuration setting to `enable_loopback_candidate=false` in `mediadiag20261103b1` preserved the image, SDK, bridge, host-loopback published ports and media assertions. Both peers then decoded VP8 frames. Native getStats showed succeeded, nominated TCP pairs and connected DTLS. This isolates the container-loopback candidate setting as the cause of the fixture's complete connection failure. The detailed explanation of the return path is supported by the ICE logs, not a packet capture.

UDP pairs still lacked successful responses in these local bridge runs. **The successful correction establishes working TCP media; it does not demonstrate that UDP was repaired.** No public port, host firewall, network namespace, production LiveKit, DNS or VPN setting was changed.

## Fixture validation and failed experiments retained

The next audio/video attempt (`mediaaudio20261103c1`) stopped at a newly added exact-RGB tolerance check. A decoded green channel was 160 instead of the source's 138, although video frames and audio RTP were arriving. Exact RGB matching was an inappropriate transport assertion across a lossy codec and color conversion.

The final fixture encodes an unambiguous achromatic two-bit signature instead. It retains the requirement to decode the correct other participant's content, as well as strict RTP, frame, sample and spectral assertions. No signaling result or packet count alone can produce a media PASS. All four receipts are retained alongside this report, including the unsuccessful control and unsuccessful RGB-fixture attempt; neither is relabeled as PASS.

## Scope and reproduction

Use `scripts/test-livekit-admission.sh` with `TEST_DATABASE_URL` set to the authorized disposable database and `IMON_ISOLATED_LIVEKIT_ACCEPTANCE=1`. The wrapper takes the shared `verify.lock`, limits the verifier to 1 CPU / 2 GiB / 256 tasks / 600 seconds, and performs outer cleanup even after failure. LiveKit remains limited to 0.5 CPU / 256 MiB; HAProxy to 0.1 CPU / 64 MiB. All published services bind to host 127.0.0.1. No model, browser or image download is performed.

In this separate core worktree, `IMON_INGRESS_GENERATOR` pointed to `/home/sergey/imonmeets-release-20261103/scripts/prepare-ingress443.mjs`. An integrated checkout uses its own generator by default. The real exports `ingressConfig`, `renderIngress` and `haproxy:3.0-alpine@sha256:f06f6cc1c25c7071e62d955d8e67a33d6935066ced8fac496cdd0ad9ffdd17f3` are reused, with temporary certificate paths, domains, one-time secrets and loopback-only layout overrides. The completed final invocation ran through a detached wrapper with regular-file stdout/stderr, so the RDC transport did not own its output pipe.

This is a short synthetic same-host acceptance. It does not accept UDP, TURN/TLS443, external NATs, hardware microphones/cameras, screen sharing, Safari/mobile browsers, prolonged calls, load capacity or end-user UI flow. CSP is bypassed only in the disposable fixture. There are no real users, existing browser sessions, emails, payments, recordings or external callbacks.

The previous `livekit-admission-20261103.json` remains historical evidence for the earlier signaling-only run. The new receipt supersedes that media limitation only for the explicit ICE/TCP synthetic audio/video scope above.

## Evidence identity

- Core HEAD during the final run: `3181ce3245d5e3bb6f6eff629081fbaa20658746` (application source unchanged by this test-only change).
- Executed runner SHA-256 after formatting: `4d4a49441bf6896fb92c24f8a5736005cb0c8ba23923b70b99b992bd2247f47a`.
- Ingress generator SHA-256: `9999b614d95e81662613a738163fb1fe0168b951c2ac5cc9eb537edd759bc866`.
- Node: `v24.21.0`.
- LiveKit image: `sha256:25cd902de7cacbd5f1f779f6a6ac1eae20ba8f56b0935934ce6b0ab80d1e3d20`.
- HAProxy: `haproxy:3.0-alpine@sha256:f06f6cc1c25c7071e62d955d8e67a33d6935066ced8fac496cdd0ad9ffdd17f3`.
- Start: `2026-11-03T08:26:05.846Z`; completion: `2026-11-03T08:26:23.582Z`.

Primary configuration reference: [LiveKit configuration sample](https://github.com/livekit/livekit/blob/v1.13.11/config-sample.yaml). The exact local image's binary version was checked at runtime; the result does not infer the deployed server version from a moving documentation branch.
