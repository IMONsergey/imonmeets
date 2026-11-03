# Product API additions

This document describes implemented routes and configuration. A configured flag does not establish provider delivery, recording worker health, device compatibility, or load capacity. Run the explicit database migration before starting this release.

## Waiting room and meeting access

New rooms default to `waitingRoom: true`; existing rooms retain their previous direct-entry behavior after the additive migration. Owners, admins, and the room creator can enter without waiting. Other members and anonymous guests require approval when the waiting room is enabled.

| Route                                           | Request                           | Result / authority                            |
| ----------------------------------------------- | --------------------------------- | --------------------------------------------- |
| `POST /api/rooms/:slug/join`                    | `{name?,waitingToken?}`           | A joined grant or a waiting request           |
| `POST /api/rooms/:slug/waiting-status`          | `{waitingToken}`                  | `waiting`, `admitted`, `denied`, or `expired` |
| `DELETE /api/rooms/:slug/waiting`               | `{waitingToken}`                  | Cancels the caller's unconsumed request       |
| `GET /api/workspaces/:w/rooms/:r/waiting`       | None                              | Managers receive the current queue            |
| `PATCH /api/workspaces/:w/rooms/:r/waiting/:id` | `{decision:"admitted"\|"denied"}` | Managers decide a pending request             |

A waiting response contains `{status:"waiting",requestId,waitingToken,expiresAt}` and no media or chat credentials. Tokens are random 256-bit capabilities, stored only as SHA-256 hashes. They are bound to the room, media generation, authenticated user if present, and the approved display name. Waiting expires after 30 minutes; approval gives at most 10 minutes to join. Admission is consumed once, atomically with media grant issuance. At most 100 unexpired waiting requests are accepted per room.

A joined response adds `{status:"joined",chatToken,identity}` to the existing LiveKit grant. A client must not place waiting or chat capabilities in URLs, logs, analytics, or cross-origin messages. The guest SDK in `packages/sdk` follows this contract and keeps credentials in memory.

Rotating a room link, enabling its waiting room, or turning off guest access retires the previous LiveKit room generation. Current participants must reconnect. A failed external disconnect produces `mediaPending:true`; the retirement queue retries independently. Old namespaces are never reused. LiveKit `room.auto_create: false` remains mandatory.

## Persistent chat

In-call `GET` and `POST /api/rooms/:slug/chat` require the `X-Imon-Room-Session` header returned by a successful join. Authenticated chat grants additionally require that same account's valid application session. A token from another room or generation does not authorize access. Closing the room disables in-call guest reads and writes. Workspace members can still read retained history through `GET /api/workspaces/:w/rooms/:r/chat`.

POST accepts only `{text,clientId}`. The server supplies the author name and identity; a UUID `clientId` deduplicates retry submissions for that participant. Text is plain text, 1 to 4,000 characters. The sender budget is 30 writes/minute. Each room has a 100,000-message ceiling plus time-based retention.

GET initially returns the latest 100 messages in chronological order, with `{messages,nextCursor,hasEarlier,hasMore}`. `?before=<id>` reads older history; `?after=<id>` reads new messages. Cursors are decimal PostgreSQL bigint IDs, and only one direction is accepted per request. A page does not silently claim to be the entire history.

`CHAT_RETENTION_DAYS` defaults to 90, with an allowed effective range of 1 to 365 days. Expired messages are filtered on reads and removed by the minute maintenance cycle. Browser polling should use at least three-second intervals to remain within request admission budgets.

## Authenticator MFA

Better Auth's TOTP plugin is enabled with verified enrollment and encrypted backup codes. It requires no external messaging provider. Existing sessions are invalidated when enrollment is completed or MFA is disabled; the newly rotated enrollment session remains valid. Password change/reset also invalidates outstanding MFA challenges and trusted-device records.

| Route under `/api/auth/two-factor` | Body                       | Purpose                                                                           |
| ---------------------------------- | -------------------------- | --------------------------------------------------------------------------------- |
| `/enable`                          | `{password,method:"totp"}` | Returns `totpURI` and recovery codes; does not enable MFA until code verification |
| `/verify-totp`                     | `{code,trustDevice:false}` | Verifies enrollment or completes a pending login                                  |
| `/verify-backup-code`              | `{code,trustDevice:false}` | Uses one recovery code once                                                       |
| `/generate-backup-codes`           | `{password}`               | Replaces previous recovery codes                                                  |
| `/disable`                         | `{password}`               | Disables MFA and rotates the session                                              |

Email/password sign-in can return `{twoFactorRedirect:true}` instead of an authenticated user. The client must complete the second factor before entering the application. An account-wide failed-verification limit applies in addition to the shared IP and Better Auth endpoint budgets. Secrets and recovery codes must not be sent to telemetry.

## Account export, ownership, and deletion

- `GET /api/me/export` downloads personal profile, membership, authorized created-room metadata, authenticated chat contributions, audit events, and payment history. Password hashes, MFA secrets, backup codes, session tokens, and provider credentials are excluded. The response streams the same JSON shape through bounded 500-row keyset pages with backpressure. Aborting the download destroys any checked-out query connection and stops subsequent pages. Concurrent changes may appear between pages; this is a personal export, not a database snapshot.
- `POST /api/workspaces/:w/transfer-ownership` takes `{memberId,password}`. Only the owner can transfer to an existing verified member. The previous owner becomes an admin; the one-owner invariant is enforced in a transaction.
- `DELETE /api/workspaces/:w` takes `{password,confirmation:"DELETE"}`. Only the owner can delete. Recorded files must already be stopped and deleted. Unresolved payments block deletion. Meetings close and their media generations retire before the database workspace is removed; an incomplete external disconnect is reported for retry.
- `DELETE /api/me` takes `{password,confirmation:"DELETE"}`. Owned workspaces must first be transferred or deleted. Unresolved payments must be settled. Sessions, credential accounts, MFA data, personal chat contributions, pending invitations, and join access records are removed. Shared rooms are reassigned to their workspace owner. Affected live rooms are retired; a pending disconnect is reported explicitly.

Deleting an account does not erase joint workspace content that belongs to the remaining team. A minimal payment ledger retains immutable provider/order references, pseudonymous former user/workspace IDs, amounts, and service periods for reconciliation. It contains no card data, mailbox contents, or stored payer email. Provider-side accounting retention is a separate operational/legal policy.

Database backup expiration is controlled by the backup service, not this endpoint. In particular, an endpoint must not promise seven-day erasure while off-host copies have a longer retention period. This release candidate implements a durable deletion journal, independently acknowledged receiver, database/genesis binding and offline replay before reopening a restored service. The older deployed image and the independent receiver's actual deployment are separate acceptance states. Follow `docs/deletion-database-binding.md`; an existing populated database cannot silently enroll an empty replacement history.

## Recording retention and deletion

`GET /api/workspaces/:w/recordings` returns at most 100 records with the existing `recordings` array and an additive `nextCursor`. Pass that cursor as `?before=<id>` to read the next page. Ordering uses the exact database `(started_at,id)` pair, including its timestamp precision. A soft-deleted anchor remains usable; a foreign workspace's cursor cannot reveal an anchor or its records. The UI loads further history only on request and preserves expanded pages during refresh and cleanup.

`RECORDING_RETENTION_DAYS` defaults to 14, capped at 365. A recording receives a durable expiration time. Complete and failed recordings can be removed by an owner, admin, or room creator using `DELETE /api/workspaces/:w/recordings/:id`.

Deletion marks the row first. Downloads and transcript reads then fail immediately, while a leased cleanup process deletes the object. Storage failures keep the deletion pending with bounded backoff; they do not restore user access. Successful object removal hides the row from normal lists and overview counts. Existing signed download URLs expire within 60 seconds and cannot retract bytes already downloaded.

`S3_ENDPOINT` is the internal endpoint used by Egress and object deletion. `S3_PUBLIC_ENDPOINT` optionally supplies a different HTTPS endpoint for browser downloads. The latter falls back to `S3_ENDPOINT`. The bucket must remain private. On a versioned S3 bucket, a normal `DeleteObject` creates a delete marker; the operator must separately configure noncurrent-version expiration or use a nonversioned recording bucket. The API does not claim to remove retained object versions or provider backups.

## Billing and service periods

Billing uses YooKassa through a server-only adapter. The product supports an explicit 30-day purchase/renewal, not automatic card charging. The customer never supplies the amount. The server's configured price, currency, plan, workspace, payer account, and persisted order UUID are bound into the order and verified against a separately fetched provider object before access is granted.

| Route                                          | Body / result                                                                                      |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET /api/workspaces/:w/plan`                  | Current plan, limits, usage, paid expiry, checkout availability, and owner-visible payment history |
| `POST /api/workspaces/:w/payments`             | Owner-only `{planId:"pro",requestId:<UUID>}`; returns `{payment}`                                  |
| `POST /api/workspaces/:w/payments/:id/refresh` | Owner-only reconciliation; returns `{payment}`                                                     |
| `POST /api/billing/yookassa/webhook`           | Provider event; its payment object is fetched independently before applying changes                |

The browser retains `requestId` while retrying. The server also reuses an unresolved order even if a browser loses that value. A provider timeout is ambiguous and must not create another charge. Creation is retried with the same server UUID for at most 20 hours; older unknown outcomes require operator reconciliation before a new order can be opened. Webhook bodies and return URL query strings are never proof of payment.

A successful canonical payment grants one 30-day contribution exactly once. Paid access remains valid when checkout is temporarily disabled. Full refunds revoke only the unused contribution belonging to that order and preserve independent renewals. Terminal refund/cancellation states cannot be undone by a stale response. Partial refunds remain an operator-managed policy; this release does not issue refunds or automatically prorate a partial refund into a new service period.

Quotas apply to room creation, admitted members, configured per-room participant capacity, and recording reservations. Existing members and calls are not terminated solely because a paid period expires. Limits on a newly allocated media room are enforced by LiveKit; changing an existing room's participant capacity requires a new media generation. Global infrastructure ceilings remain independent of a workspace's plan.

### Billing variables

| Variable                    | Default | Purpose                                                                                  |
| --------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| `BILLING_ENABLED`           | false   | Opens checkout only if the provider configuration is also valid                          |
| `BILLING_MODE`              | pilot   | `commercial` keeps base/paid quotas active independently of checkout availability        |
| `YOOKASSA_SHOP_ID`          | empty   | Merchant account identifier                                                              |
| `YOOKASSA_SECRET_KEY`       | empty   | Server-only merchant key                                                                 |
| `YOOKASSA_TEST_MODE`        | true    | Must match the canonical provider object's test flag                                     |
| `BILLING_PRO_PRICE_KOPECKS` | 149000  | Server-defined amount for 30 days; a configuration default, not an approved public price |
| `YOOKASSA_VAT_CODE`         | empty   | Merchant-confirmed receipt VAT code                                                      |
| `YOOKASSA_TAX_SYSTEM_CODE`  | empty   | Optional merchant-confirmed tax system                                                   |
| `COMMERCIAL_TERMS_APPROVED` | false   | Live checkout additionally requires this operator flag and receipt configuration         |
| `BILLING_FREE_ROOMS`        | 20      | Base-plan room ceiling                                                                   |
| `BILLING_FREE_MEMBERS`      | 10      | Base-plan member ceiling                                                                 |
| `BILLING_FREE_PARTICIPANTS` | 25      | Base-plan participant ceiling                                                            |
| `MAX_ROOMS_PER_WORKSPACE`   | 200     | Pilot/pro room ceiling                                                                   |
| `MAX_MEMBERS_PER_WORKSPACE` | 100     | Pilot/pro member ceiling                                                                 |
| `MAX_PARTICIPANTS_PER_ROOM` | 100     | Pilot/pro participant ceiling, subject to room validation                                |
| `MAX_ACTIVE_RECORDINGS`     | 2       | Global recording ceiling and pro workspace ceiling                                       |

An operator must complete merchant onboarding, determine receipt/tax values and the approved service terms, configure the canonical webhook URL, and verify a real provider flow before setting live mode. Those account/business decisions cannot be replaced by an enabled frontend button.

## Transcript and AI-summary integration

A manager can explicitly enqueue a completed recording for transcription. The API keeps a bounded, leased queue, preserves the recording's access and retention boundary, and discards results for deleted/expired recordings. Existing completed results remain readable while processing is disabled.

| Variable                 | Default | Purpose                                                                               |
| ------------------------ | ------- | ------------------------------------------------------------------------------------- |
| `TRANSCRIPTION_ENABLED`  | false   | Enables requests only when recording storage and private worker access are configured |
| `AI_SUMMARY_ENABLED`     | false   | Independently enables optional summaries                                              |
| `ANALYSIS_WORKER_URL`    | empty   | Private CPU worker origin, never a URL supplied by a meeting participant              |
| `ANALYSIS_WORKER_SECRET` | empty   | Shared bearer secret of at least 32 characters                                        |

Routes are `GET`, `POST`, and `DELETE /api/workspaces/:w/recordings/:id/transcript`. POST accepts `{language:"auto"|"ru"|"en",summary:boolean}`; reads return `{job:null|...}`. The root implementation in `apps/analysis-worker` reads only exact recording object keys from private storage, uses a locally provisioned speech model, and optionally calls a separately provisioned private summarizer. Current worker bounds are 512 MiB, one hour of media, and one active job. Preprovision the pinned model files; the worker runs with model downloads disabled.

No calendar OAuth, corporate SSO, native mobile client, or browser iframe account embedding is implemented by these routes. The guest SDK supports a custom meeting UI through a controlled API proxy; full account pages retain their framing prohibition.

## Verification record

The isolated PostgreSQL suite exercises real Better Auth migrations, sessions, password reauthentication, TOTP enrollment and recovery, the guest SDK waiting-room/chat contract, tenant boundaries, revoked generations, account/workspace deletion, object-cleanup retry, and canonical payment reconciliation with a controlled provider transport. Those tests do not replace real SMTP delivery, payment-provider acceptance, Egress output inspection, network/device acceptance, or load measurement.
