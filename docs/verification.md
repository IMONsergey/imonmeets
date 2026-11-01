# Verification record

Executed on **2026-11-01** against version **0.1.0**, using Node 24.21.0, PostgreSQL 17, pinned LiveKit 1.13.11 and host Google Chrome. These results establish a working local pilot. They do not establish public-network readiness or capacity.

## Executed checks

| Check                                        | Result                           | Evidence and scope                                                                                                                                                     |
| -------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                          | Passed                           | Strict API source, API tests, web application and browser test types.                                                                                                  |
| `npm run build`                              | Passed                           | Production React/Vite assets and compiled Fastify API. The lazy-loaded call bundle exceeds Vite's 500 kB advisory; this is a performance follow-up, not a build error. |
| `TEST_DATABASE_URL=... npm test`             | 6 passed, 0 failed, 0 skipped    | Real PostgreSQL in a disposable schema, unit policies and recording state/correlation tests.                                                                           |
| `PLAYWRIGHT_CHANNEL=chrome npm run test:e2e` | 2 passed, 0 failed, 29.3 seconds | Real deployed API, SMTP capture, LiveKit signaling and media. Separate browser contexts use synthetic cameras and microphones.                                         |
| `npm audit --omit=dev`                       | 0 known vulnerabilities reported | Dependency database snapshot at execution time; not a security certification.                                                                                          |
| Docker Compose startup                       | Passed                           | Database and Valkey health gates, one-shot migrations, application readiness. Application uses a separate non-superuser database role.                                 |
| Backup catalog and disposable restore        | Passed                           | A real custom-format dump restored successfully into a new temporary database; 2 workspaces and 2 rooms were read back, then the temporary database was removed.       |

## API coverage

The integration scenario exercises real Better Auth registration, sessions and logout; workspace isolation; role enforcement; verified invitation email ownership, expiration and one-time consumption; link rotation and durable room closure; and ten simultaneous authorized joins. Media grants are verified using the actual SDK, including the initial 300-second expiry and absence of administration/room-creation grants.

Recording checks exercise real signed raw webhook bodies, rejected signatures, duplicate and reordered delivery, exact output-key correlation, monotonic terminal states and authorization of recording controls. Media/Egress RPC calls are stubbed in these API tests. No recording-to-S3 result is claimed.

The isolated-schema test initializes Better Auth before creating its tables, so an initial missing-table diagnostic is expected before migrations run. The final assertions and migrated application pass. Fastify currently reports a deprecation advisory for its logging configuration; the API is pinned to version 5.

## Browser acceptance

1. Register through the interface, open the verification message from local Mailpit and verify the account.
2. Create a workspace and scheduled room; confirm a newly issued media token can connect.
3. Join as the authenticated organizer and as a guest in separate browser contexts. Each context renders two video feeds; received video frames and inbound audio bytes are present in browser WebRTC statistics.
4. Send a chat message from the organizer and observe it in the guest's chat.
5. Close the room for everyone, observe the guest disconnect, reject the next API join with `ROOM_CLOSED`, and reject direct reconnection with the previously valid cached media token.
6. Check the dashboard at a 390-pixel mobile viewport for horizontal overflow.
7. Recover a second verified account through the interface and a captured reset email. The previous session becomes unauthorized, the old password is rejected and the new password works.

The nominated media connection includes direct UDP traffic from the host to LiveKit's internal Docker bridge address. The loopback signaling endpoint is not a public deployment. Test screenshots contain synthetic accounts and camera feeds:

- [Desktop dashboard](screenshots/dashboard-desktop.png)
- [Mobile dashboard](screenshots/dashboard-mobile.png)
- [Two-participant call and chat](screenshots/call-two-participants.png)

## Reproduction

Use the commands in the root README with a dedicated test deployment. Integration tests create and drop a unique database schema. Browser tests create persistent disposable accounts/workspaces/rooms, so do not run them against customer data. See [deployment](deployment.md) for the backup and restore commands.

The checked-in GitHub workflow runs install, types, build, PostgreSQL tests and the production-dependency audit. Browser acceptance is a separate host test; it is not represented as running in that CI job.

## Outside the current local acceptance environment

External SMTP delivery, public DNS/HTTPS/WSS, TURN and restrictive networks, physical microphones/cameras, real screen capture, mobile Safari, prolonged/loaded meetings and actual Egress recording to private S3 need separate operational acceptance. Recording remains disabled. Payments, subscription entitlements, AI, persistent chat, calendar OAuth, SSO and waiting rooms are future product work, not implemented capabilities.
