# Production media client check, 2026-11-04

This is an operator-run acceptance check for the already deployed full source `17147a6203814b5ea81de3eea547452496b2a6eb`, image `sha256:5aac16d52549090301e8bc22d2fd423fd33dea986b5796e838680e5817bf2c29`. It does not deploy the image or verify its identity independently. The cutover coordinator must establish deployment identity first.

The client has not been run merely by installing this tooling. A real, disposable meeting URL and a separate explicit `--run` are required. Run only after the fenced cutover and bound-backup recovery gate have passed and production has reopened.

## Scope and limits

Two fresh Chromium guests join the real HTTPS application through its normal name form and normal API grant. Both publish synthetic audio and 640×360, 15 fps synthetic video. The runner does not use a data URL, a copied app, a signed production token, database access, organizer cookies, production secrets, or a test API. It reuses the existing real-media statistics probe.

The short `smoke` mode samples 10 seconds of advancing received audio bytes and decoded video frames in both guests. It has a 90-second overall deadline, plus up to 8 seconds for browser cleanup. It leaves the disposable room open for a later moderation check or organizer cleanup.

The `moderation` mode starts with the same media sample, then coordinates organizer UI actions: remove B, allow B to rejoin normally, block B, and end the meeting for everyone. It has a 180-second overall deadline, plus up to 8 seconds for cleanup. Each requested organizer acknowledgement has at most 45 seconds and still shares that overall deadline.

This check runs on the main host through public HTTPS/WSS ingress. It proves the selected real connection and bidirectional media; it does not establish external NAT, UDP-only, strict TURN relay, TURN on port 443, recording, mobile-browser, or capacity acceptance. Raw WebSocket replay checks prove handshake rejection, not an SDK reconnect scenario. Do not infer those broader results from a PASS.

## Prepare the disposable room

The coordinator creates a separate room in an existing workspace using Chrome. Give it a test-only name, permit guests, turn off the waiting room, and do not send invitations. Keep recording off and do not post chat. Do not use a room with other participants or existing activity.

The organizer can join this room in Chrome with camera and microphone disabled. The runner permits two synthetic guests and, optionally, this one organizer. More participants make the check fail.

On the main host use this worktree:

```text
/home/sergey/imonmeets-production-media-client-20261104
```

A private empty template already exists at:

```text
/home/sergey/.local/state/imonmeets-production-media-20261104/media.env.TEMPLATE
```

Create a new private file owned by `sergey`, mode `0600`, in the same `0700` directory. Fill only these four variables. The URL must be the exact canonical `https://meets.imon.world/join/<room-code>` with no query, fragment, or credentials. Never put the URL on a command line or print this env file.

```dotenv
MEDIA_TEST_ROOM_URL=
MEDIA_TEST_RUN_ID=smoke20261104a1
MEDIA_TEST_MODE=smoke
PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/google-chrome
```

Use a new run ID for every attempt. The runner refuses a reused result directory. The allowed run ID is 8–48 lowercase letters, digits, hyphens, or underscores, beginning with a letter or digit. Do not load the deployment `.env`; privileged variables are refused.

## Run the short check first

After the coordinator supplies the real room URL and authorizes this check, submit the normal queue job as `sergey`:

```sh
/home/sergey/.local/bin/imon-job submit \
  --cwd /home/sergey/imonmeets-production-media-client-20261104 \
  --timeout 110 \
  --env-file /home/sergey/.local/state/imonmeets-production-media-20261104/smoke.env \
  -- /opt/imon-runtime/node/bin/node scripts/verify-production-media-client.mjs --run
```

The job does not need sudo or Docker. Do not bypass the dispatcher. Queue waiting time is separate from the client deadline. Do not create another job because the first is still queued.

The runner writes private, token-free progress to:

```text
/home/sergey/.local/state/imonmeets-production-media-20261104/runs/<run-id>/status.json
/home/sergey/.local/state/imonmeets-production-media-20261104/runs/<run-id>/result.json
```

`two_peer_media_pass` means both guests had advancing real received audio and decoded video for the sample. The terminal `result.json` must also say `status: PASS` and `cleanupComplete: true`; the intermediate checkpoint alone is not the final acceptance result. A successful smoke receipt correctly sets `ownerMustCloseRoom: true` because leaving both browsers does not close the room.

## Coordinate moderation in Chrome

Create a second private `moderation.env` with the same disposable room URL, a new run ID such as `moderation20261104a1`, and `MEDIA_TEST_MODE=moderation`. The room can be the room left open by smoke. The browser contexts, guest identities, and run state are fresh. Submit it only when the organizer is ready to act:

```sh
/home/sergey/.local/bin/imon-job submit \
  --cwd /home/sergey/imonmeets-production-media-client-20261104 \
  --timeout 200 \
  --env-file /home/sergey/.local/state/imonmeets-production-media-20261104/moderation.env \
  -- /opt/imon-runtime/node/bin/node scripts/verify-production-media-client.mjs --run
```

Read the current `status.json`. Act only when it asks for the matching step, then run the acknowledgement immediately as `sergey`. The acknowledgement command only writes a private control file; it does not click, moderate, or make a network request. It binds the action to this run, its current checkpoint, and a fresh nonce. Do not pre-acknowledge or reuse an old control file.

| Current phase    | Organizer action in Chrome                                                                       | Acknowledge after the action succeeds       |
| ---------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `awaiting_kick`  | Find `IMON B moderation20261104a1` in the participant list and select **Удалить** for exactly B. | `--ack kick --run-id moderation20261104a1`  |
| `awaiting_ban`   | B has now rejoined with a fresh normal guest identity. Select **Заблокировать** for exactly B.   | `--ack ban --run-id moderation20261104a1`   |
| `awaiting_close` | Select **Завершить для всех** and accept **Завершить встречу для всех участников?**              | `--ack close --run-id moderation20261104a1` |

Each acknowledgement uses this full command, substituting only the shown action and actual run ID:

```sh
/opt/imon-runtime/node/bin/node \
  /home/sergey/imonmeets-production-media-client-20261104/scripts/verify-production-media-client.mjs \
  --ack kick --run-id moderation20261104a1
```

The runner verifies that B disconnects, the captured unexpired token is denied with 403 on all four signaling routes, and raw WebSocket handshakes cannot open. After a kick, B rejoins normally with a new identity. A must retain its peer connections and publish advancing audio/video during a separate three-second sample with B subscribed again; A is never rejoined by the runner. This avoids claiming frozen or subscriber-free adaptive video as a successful publishing test.

After a ban, B's same browser must receive `PARTICIPANT_BLOCKED` on a normal join attempt. After closing the room, A must disconnect and a normal join must receive `ROOM_CLOSED`. The runner does not call organizer moderation or room-close APIs itself.

## Results and cleanup

All guest grants and cookies stay in memory. The queue stores only the four client env variables in its private environment file; the room URL is an invitation and must remain private there. Result/checkpoint files contain only its SHA-256 hash, synthetic display names, media statistics, route status codes, and acceptance booleans. No trace, screenshot, saved browser profile, or storage-state file is created. Unexpected errors are reduced to fixed error codes before output.

Browser requests are limited to the canonical app/RTC origins; mutations are allowed only for the exact normal guest-join endpoint. A blocked unexpected mutation fails the check. The runner sends no meeting chat, starts no recording, creates no account, sends no email, and does not stop production services.

The cleanup attempts `browser.close` independently even if a context close hangs. A close rejection or eight-second timeout cannot produce PASS. The dispatcher retains its ordinary process-group lifecycle. If the job fails, inspect only its safe receipt/status and dispatcher result; do not dump process environments or browser logs. Close any surviving synthetic participants and the test room from the organizer UI. In all modes, `ownerMustCloseRoom: true` means the coordinator must close the room, or deliberately keep it open for the immediate next test.

Do not reuse the room for users after testing. Keep its closed history; this tooling does not delete it, recording data, or audit events. No email or invitation cleanup is required because neither was sent.

## Offline verification

These tests make no network calls and do not launch a browser. Run them through the queue after higher-priority recovery work:

```sh
/home/sergey/.local/bin/imon-job submit \
  --cwd /home/sergey/imonmeets-production-media-client-20261104 \
  --timeout 60 \
  -- /opt/imon-runtime/node/bin/node --test scripts/test-production-media-policy.mjs
```

They cover canonical scope and privileged-environment refusal, mutation restrictions, normal guest-grant checks, stale acknowledgements, real media counter progress, safe error output, and independent bounded browser cleanup. Application/API integration acceptance remains the existing exact-image release evidence; these client guards do not replace it.
