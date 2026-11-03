# Installed-engine LiveKit acceptance — 2026-11-03

## Result

| Engine and environment | Actual result | Accepted scope |
|---|---|---|
| Chromium / Google Chrome, previous run | PASS_MEDIA_AND_SIGNALING, 19 checks | Synthetic audio/video over ICE/TCP; see livekit-media-20261103.md |
| Linux WebKit 27.2, installed revision 2359 | PASS_MEDIA_AND_SIGNALING, 19 checks | Synthetic audio/video over ICE/TCP plus unchanged admission negatives |
| Firefox 155.0, installed revision 1543 | FAIL before media, both tested profiles | Signaling was reached; no media acceptance |

These are separate runs, not a summed count of unique tests. Linux WebKit is **not** Safari on macOS or iPhone. Its emulated user-agent string does not change the platform actually tested.

Only existing binaries were used. The workspace's default Playwright paths pointed to a missing cache under the RDC home directory; the usable installed binaries were found in `/home/sergey/.cache/ms-playwright`. The installed-engine probe records exact paths, versions and available media APIs. No browser, OS package or image was downloaded or installed.

## Linux WebKit evidence

Run `mediawebkit20261103w1` passed all 19 checks. Both peers decoded VP8 video carrying the opposite publisher's black/white signature and received the expected distinct Opus tones. Native RTP statistics additionally reported 206,400 and 249,120 decoded audio samples, and 9 and 12 decoded video frames at the later stats snapshot. The earlier HTML video snapshots contained 2 and 5 frames; these observations are at different instants.

The spectral peaks were 703.125 Hz for the 660 Hz source and 421.875 Hz for the 440 Hz source, within the pre-existing distinct-tone test tolerance. This is transport/content evidence, not a speech-quality, clock-accuracy or listening-quality assessment. Both selected pairs used TCP and DTLS was connected. WebKit did not expose the remote address in getStats; the receipt leaves it null rather than inventing a value. UDP, TURN and external networks remain unaccepted.

The same runtime verified all four signal paths, targeted kick/ban, revoked original and newly signed identity tokens, fresh API grants, generation rotation, waiting without a join token and fail-closed API outage. `chromiumFlagsUsed=false`. Both inner and outer cleanup completed.

## Firefox limit and retained failures

The first attempted Firefox run (`mediafirefox20261103f1`) stopped **before launching the browser**. Separate port-zero allocation batches had returned the same TCP number for public TLS and media TCP. HAProxy refused to bind; no existing listener was stopped. The runner now allocates all eight TCP endpoints in one batch while every reservation socket remains open and asserts uniqueness. This is a fixture fix, not a Firefox failure.

The actual Firefox run `mediafirefox20261103f2` reached real `/rtc/v1` signaling but failed before media. It exposed local candidates and the expected remote host-loopback candidates, without a selected working ICE pair. Native transport counters were zero and ICE/DTLS failed. Its receipt stays FAIL.

Mozilla documents that Firefox normally excludes loopback ICE/STUN addresses. One explicitly authorized retry therefore set only `media.peerconnection.ice.loopback=true` in the fresh disposable profile. This setting was recorded in `mediafirefox20261103f3`; no user browser settings were changed. **The retry also failed to establish the peer connection.** The preference alone is not a complete explanation or fix for this fixture's Firefox transport failure. The retained native candidate/transport stats and server logs are the evidence; a narrower final root cause has not been proven.

The bounded Firefox investigation stops here. Firefox media and its subsequent moderation scenarios are not marked PASS, and these local proxy/bridge results are not evidence that the production product fails in every Firefox network environment. A further investigation should distinguish the native Firefox ICE behavior, the loopback/proxy setup and the Docker return path before changing application behavior.

Primary references: [Mozilla loopback ICE/STUN restriction](https://bugzilla.mozilla.org/show_bug.cgi?id=1969449) and [Mozilla WebRTC proxy/loopback discussion](https://bugzilla.mozilla.org/show_bug.cgi?id=1863984).

## Runner changes and safeguards

`IMON_BROWSER_ENGINE` selects `chromium` (default), `firefox` or `webkit`. `IMON_BROWSER_EXECUTABLE` optionally selects an already-installed binary. Chromium's launch arguments are restricted to Chromium. Firefox's only additional preference is the explicitly documented test-only loopback preference. A trusted click unlocks the fixture AudioContext instead of passing Chromium autoplay flags to other engines.

For Firefox/WebKit, a private Node HTTP CONNECT proxy binds only to 127.0.0.1. It accepts only the fixture's exact app/RTC TLS destination and exact owned media TCP port, connects them to 127.0.0.1 and rejects every other destination without dialing it. This maps synthetic hostnames without changing DNS, hosts files, VPN or production services. Proxy sockets are explicitly destroyed during cleanup.

Native stats dictionaries differ by engine. The runner always requires actual decoded remote waveform, the correct remote video signature, incoming audio/video RTP bytes and a succeeded selected/nominated ICE pair. If a decoded-sample/frame counter or DTLS state is exposed, its required value is also asserted. An absent optional field is preserved as null, never converted into a fabricated count or success state. All signaling and negative authorization assertions remain unchanged.

The runner records actual engine/version, chosen executable, fixture ports, Firefox preferences and its own SHA-256 in new receipts. The shell wrapper forwards only those explicit engine variables into the bounded unit. It continues to use the common verification lock, 1 CPU / 2 GiB / 256 tasks limits, host-loopback services and ownership-checked outer cleanup. Receipts stay outside Git during runtime; these evidence copies were added deliberately after completion.

## Reproduction

Set the authorized disposable `TEST_DATABASE_URL` first. The Chromium default is unchanged. The additional installed-engine invocations are:

```sh
IMON_ISOLATED_LIVEKIT_ACCEPTANCE=1 \
IMON_BROWSER_ENGINE=webkit \
IMON_BROWSER_EXECUTABLE=/home/sergey/.cache/ms-playwright/webkit-2359/pw_run.sh \
./scripts/test-livekit-admission.sh

IMON_ISOLATED_LIVEKIT_ACCEPTANCE=1 \
IMON_BROWSER_ENGINE=firefox \
IMON_BROWSER_EXECUTABLE=/home/sergey/.cache/ms-playwright/firefox-1543/firefox/firefox \
./scripts/test-livekit-admission.sh
```

In a separate core checkout, also set `IMON_INGRESS_GENERATOR` to the integrated checkout's generator. The Firefox invocation currently reproduces an unresolved failure; it is not a recommended production configuration.

Core source HEAD for these runs was `a111d6f04a25888ab4dd48a32520d3f3b0e252a3`. The Firefox f2/WebKit w1 runner SHA-256 was `772bfb1cc09d06333a02d3ee8e1150fc7101ed7f86f5a5248939bea4b7dad8ca`; the final Firefox-only preference and extra receipt identity fields were added afterward. The final runner SHA-256 is `54c09ff4dfaf4b0b0afda9d36dfecc65648a0bcffbe87eb2fd24da71870967f7`, matching f3's self-recorded hash. WebKit was not rerun for that Firefox-only change. Chromium's prior AV receipt remains the earlier test revision; the integrated release still needs its own final default-engine run.

All attempts retained their original results and completed owned-resource cleanup. The probe and four runtime receipts are saved alongside this report. No real camera, microphone, recording, email, payment, user session, external callback or production modification was involved.
