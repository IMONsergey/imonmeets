# External audio/video and TURN/TLS verification

The external verifier is a commissioning tool. A local policy test does not establish external connectivity, working DNS, a certificate, an iPhone result or a commercial-service acceptance.

## Inputs

Use a second machine and a disposable guest-enabled meeting without waiting-room admission. The verifier joins two synthetic participants in each of two scenarios and sends one synthetic chat message per scenario. Do not point it at an existing customer meeting. No real camera or microphone is captured.

Set `MEDIA_TEST_ROOM_URL` privately to the disposable HTTPS invitation URL. Set `MEDIA_TEST_TURN_TLS_URL` to the expected TURN endpoint, including its port. The prepared public ingress uses:

```sh
MEDIA_TEST_TURN_TLS_URL='turns:turn.imon.world:443?transport=tcp' node scripts/verify-external-media.mjs
```

The room URL must already be present in the process environment; do not paste a private invitation into shared logs. The optional `PLAYWRIGHT_EXECUTABLE_PATH` selects an installed Chromium executable. Dependencies are the repository's pinned `@playwright/test` package.

The port is deliberately not inferred from the site URL. There is no fallback to 5349. Checking the older network layout requires an explicit `MEDIA_TEST_TURN_TLS_URL='turns:turn.imon.world:5349?transport=tcp'` and produces a 5349 receipt that cannot accept the 443 rollout.

## Required proof

Both scenarios must show two participant tiles and decodable video, deliver the synthetic message to the other participant, receive audio bytes and decode video frames in both browsers. Every connected peer must have a successful pair selected by its transport, with nonzero traffic in both directions.

In the restricted scenario, both constructors and later `setConfiguration` calls retain only the expected TURN/TLS hostname and port and force `iceTransportPolicy: relay`. The selected local candidate must match that endpoint and report a TLS/TCP relay transport. A matching unused candidate, another TURN hostname, legacy port, plain `turn:` URL, UDP transport, an empty peer list or an empty pair list cannot pass. Chrome's `prflx` label is accepted only with all those independent relay checks.

TURN URI components are validated separately in accordance with [RFC 7065](https://www.rfc-editor.org/rfc/rfc7065). Credentials, fragments and unrelated query parameters are rejected. A browser URI without the optional TCP parameter is accepted only for the exact `turns:` endpoint; the selected-route proof still requires TLS/TCP.

## Evidence and diagnostics

The result reports the expected TLS port, bounded counts and categorical connection/route states. It does not retain room URLs, candidate URLs, IP addresses, ICE credentials, page text, screenshots or traces. Failure diagnostics contain a stage and at most 16 peer-state entries. Raw Playwright errors are replaced because they may include an invitation URL or meeting text.

Offline regression command:

```sh
npm run test:external-media-policy
```

Those tests exercise endpoint validation, the serialized browser constructor/configuration wrapper, selected-pair collection and failure diagnostics with synthetic fixtures. They do not open a browser, join a room or send a network request. The CI receiver/release gates include the same test file.
