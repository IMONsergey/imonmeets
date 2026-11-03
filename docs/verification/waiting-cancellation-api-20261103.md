# Waiting cancellation: exact server grant revocation

Date: 2026-11-03. Base release: `ddd429bf92b889b8ed424e345cf80b4b3e620c34`. Client cancellation fix: `d8101a32effd55e89c54f0a539a92d9588828c71`. This evidence covers the server change layered over that client commit. Receipts record the source HEAD plus SHA-256 of each changed source/test file, because verification ran before the server commit.

## Confirmed defect

The former DELETE waiting handler updated only an unused ticket and returned success regardless. Once a concurrent join consumed the ticket, cancellation left its chat session and media JWT valid. A real PostgreSQL lock barrier reproduces this interleaving: join holds the admission locks while signing its grant, DELETE reaches a blocked database operation, then join commits and cancellation completes. The old implementation still authorizes the issued JWT with HTTP204 rather than the required403.

The separate client fix stops local entry immediately. This server change establishes what a successful cancellation means if the server already issued a grant.

## Resulting behavior

- The same transaction that consumes a waiting ticket stores its exact `issued_identity`.
- Cancellation locks workspace, room, and ticket in the same order as join. It either denies an unused ticket or sees the grant committed by the concurrent join.
- It revokes only that room, media generation, and identity. A sibling grant belonging to another tab of the same guest browser remains valid.
- It queues exact participant removal durably and drains only that identity. No room generation rotation or room-wide deletion is used.
- Uncertain media removal returns503 `WAITING_CANCELLATION_PENDING`; credential revocation remains committed and retry work remains durable.
- Disabled signaling protection returns503 `WAITING_REVOCATION_UNAVAILABLE` for a consumed grant. It does not claim to enforce revocation of a signed JWT through an unprotected SFU.
- Existing consumed tickets with no identity mapping return409 `WAITING_CANCELLATION_UNVERIFIED`. Migration is additive; identity is never guessed from a name, account, or guest cookie.
- An explicitly supplied waiting ticket is always validated, even after waiting-room policy is disabled. An unrelated ticket in a different open room now returns403. A new explicit request without that old ticket still follows that room's current policy. The existing suite regression was strengthened to assert both sides of this intentional contract change.

## Verification and retained failures

All database tests used unique disposable schemas in the already-existing isolated PostgreSQL fixture. Media RPC was mocked. Each runner used the shared verification lock, one test worker, CPU100%, MemoryMax2G, and TasksMax256. No production data, real meeting, microphone, camera, email, payment, or external account was involved.

| Phase | Result | Interpretation |
|---|---|---|
| `api-red` | 3/3 tests failed | Old consumed-ticket revoke, true concurrent join/cancel, and uncertain removal semantics failed the required assertions |
| `api-policy-red` | 5/6 passed, policy-change case failed | Disabling the waiting room silently ignored a supplied ticket and detached its issued grant |
| `api-final` | Focused6/6; typecheck failed | A test-only optional deferred callback needed explicit narrowing; fixed with an assertion |
| `api-final2` | Focused6/6; complete root typecheck passed; existing6/7 | Existing test expected an unrelated ticket to be ignored in an open room; strengthened to assert rejection plus a successful explicit new no-ticket join |
| `api-final3` | Focused6/6; API typecheck passed; existing7/7 | Final changed source and tests match the SHA-256 values in the receipt; zero skipped tests |

Final focused coverage: exact issued JWT and newly signed same-identity JWT denied; chat session denied; sibling same-browser grant preserved; real PostgreSQL concurrent join/cancel; cancel before admission; uncertain removal and successful retry; policy change; legacy unmapped ticket; disabled signaling enforcement; ownership/room isolation and idempotency.

The existing seven tests cover strict signaling/moderation, durable kick/ban and retries, room quota/archive/pagination, waiting/SDK/chat/tenant isolation, MFA, recording retention/cleanup, account lifecycle, and complete streamed data export. This is a targeted regression set, not the entire API suite.

Raw logs contain the fixture's pre-migration BetterAuth missing-table diagnostic and Fastify FSTDEP023 deprecation warning. Those warnings were retained. They do not erase the passing test results or constitute a warning-free production boot check.

Evidence: [all phases](waiting-cancellation-api-20261103/), [final receipt](waiting-cancellation-api-20261103/api-final3/receipt.json), [focused output](waiting-cancellation-api-20261103/api-final3/focused.log), [existing regression output](waiting-cancellation-api-20261103/api-final3/api-regression.log), [full root typecheck](waiting-cancellation-api-20261103/api-final2/typecheck.log).

## Remaining live acceptance

API tests prove stored revocation, authorization decisions, lock ordering, and precise RPC intent. They do not prove that an actual connected LiveKit participant was disconnected. A separate test-only extension to `scripts/test-livekit-admission.mjs` uses the existing isolated LiveKit/browser fixture to require real disconnect, a surviving sibling, and original/refreshed JWT rejection through all four public signaling paths. At this commit that live extension has not run; its runtime result must be recorded separately.

External TURN/TLS443, physical Safari/iPhone/Android, Firefox media acceptance, long-duration capacity, and production ingress isolation remain separate commercial gates. A configuration flag alone does not establish that the direct SFU signaling port is inaccessible.
