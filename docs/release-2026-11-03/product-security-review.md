# Product, account, data and billing review, 2026-11-03

## Source and scope

Reviewed baseline: `ddd429bf92b889b8ed424e345cf80b4b3e620c34`, release/commercial-readiness-20261103. Work is isolated in `fix/product-recordings-20261103`. All server access in this review used Remote Desktop Commander on imon-workstation. Production, credentials, real accounts, mail delivery and payments were not changed.

This review inspected the current application handlers, identity/MFA implementation, role and tenant checks, recording lifecycle and history, account export/deletion, versioned agreement, payment reconciliation, SDK boundary, and the existing acceptance receipts. It does not reclassify historical source tests as an external acceptance of the deployed service. Media/network and simultaneous translation have separate reviews.

The original task inventory remains in [backlog.json](backlog.json). The entries below clarify its present implementation and acceptance boundaries; they do not replace its uncompleted tasks.

## Confirmed defect fixed in this branch

The recording-history endpoint fetched every nondeleted recording for a workspace with no row limit; the React page rendered that entire array. A team's history could therefore create an arbitrarily large response, database result and DOM. This was a measured defect, not an inferred capacity figure: a fresh regression on the unmodified baseline returned 205 rows where the first page was required to return 100.

Changes:

- Return at most 100 recordings and an additive `nextCursor`. Fetch 101 rows to determine whether another page exists.
- Use descending `(started_at,id)` order and a workspace-scoped ID anchor in PostgreSQL, retaining full timestamp precision and the ID tie-breaker. A soft-deleted last row remains a valid anchor. A cursor from another workspace selects no anchor or records.
- Add an index on `(workspace_id,started_at DESC,id DESC)` for nondeleted records through the normal additive migration.
- Add explicit “Показать еще”. A partial page count has a “+”; it is not presented as a total count.
- Keep already loaded pages during a later-page failure. Retry uses the same cursor.
- Refresh/delete and active-recording polling reload only pages the user has already requested. Requests are sequential, have normal client timeouts, and polling skips an active request. A refresh aborts a superseded request; obsolete responses cannot change a new workspace's page.
- Preserve the existing `recordings` array and row shape. The guest SDK has no recording-list method and requires no change.

The additive migration must be applied before the release is promoted. The current soft-delete storage contract is part of cursor stability; if a future retention migration physically removes recording rows while a workspace still exists, that migration must also revise the cursor format.

Verification records are saved separately under `/home/sergey/.local/state/imonmeets-commercial-20261103/product-recordings-review/`. The [final focused receipt](../verification/recording-history-pages-20261103.json) records the expected initial failure, passing API regression, full TypeScript verification, and passing production-bundle browser scenario including polling of expanded history. Test fixtures use a disposable loopback PostgreSQL service and unique schemas; browser requests are all intercepted.

## Current account and identity implementation

| Area                          | What exists in this source                                                                                                                                                                              | Remaining acceptance                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registration and verification | Better Auth credentials; verified email required outside development; explicit registration switch; mail request and actual transport budgets                                                           | Enable only after complete external signup, inbox verification, repeat-link, expiry, duplicate-email and outage scenarios on the canonical origin |
| Recovery and password changes | Reset flow revokes sessions; pending MFA and remembered-device grants are invalidated after password change/reset; provider work does not reveal account existence through synchronous recovery latency | Complete real reset delivery and recovery for the real owner; test old links, failed delivery and interrupted navigation                          |
| Google sign-in                | Exact-origin OAuth, verified provider email, registration switch, explicit same-email linking; no automatic linking to an existing account                                                              | Real Google OAuth client/consent/callback configuration and complete provider success/cancel/error flow on the chosen public name                 |
| Google-only sensitive actions | Email-proof password enrollment bound to user, verified email and initiating session; one-time proof; session/MFA challenge/trust-device revocation after adding the password                           | Verify with a real Google-only account and actual delivery; test recovery if the initiating browser session is lost                               |
| Local MFA                     | OAuth and password sign-in use the same local TOTP/backup-code gate; provisional full OAuth session is removed                                                                                          | Owner recovery and upgrade acceptance; real device/browser journey; stored recovery codes and support procedure                                   |
| Sessions                      | Listing, individual revocation, revoke-others, password-change revocation                                                                                                                               | Existing logged-in device matrix and migration logout/recovery acceptance                                                                         |
| Workspace authority           | Membership-scoped SQL; role changes and privileged mutations serialized with workspace locks; protected owner role                                                                                      | Continue mixed-role and concurrent-request acceptance on the exact deployed build, not only its isolated harness                                  |

Source anchors: `apps/api/src/auth.ts`, `auth-mfa.ts`, `identity.ts`, `identity-schema.ts`, `app.ts` (user/membership/lockWorkspace and account routes), `suite.ts` (password-confirmed sensitive operations).

The identity source receipt documents 35 isolated API tests, typechecks and a browser test with controlled OAuth/mail. It explicitly says real Google and real mail were not used: [identity-mail-verification-20261103.json](../identity-mail-verification-20261103.json). These controls are implemented; they should not be listed again as wholly missing features.

The one-time `unified-mfa-v1` migration deliberately revokes older MFA sessions and remembered-device grants. Before production migration the real owner's login/recovery path must be verified. The migration preserves enrolled factors and credential data.

## Privacy and data boundaries

### Workspace visibility is a product decision

All workspace members can read workspace room metadata, retained chat, recording listings, completed-recording downloads and retained transcripts. Managers control recording start/stop/delete and moderation. Guest access and waiting admission are separate controls. A room with guests disabled is limited to the workspace; it is not a meeting with an independent invitee-only ACL.

This behavior is explicit in the current code and documentation. It is not evidence of a broken tenant check: other workspaces remain separate. It does mean the first commercial offer must describe that visibility plainly. If private meetings within a company are required, implement an ACL that consistently governs room discovery, join, chat history, recordings, transcripts, export and invitation changes. Merely hiding a list row would not implement privacy.

Source anchors: baseline `app.ts:1778` and `app.ts:1999`, `suite.ts:453`, `analysis.ts:315`, and [room-lifecycle-and-moderation.md](../room-lifecycle-and-moderation.md).

### Export, deletion and restoration

Personal export already streams bounded keyset pages with backpressure and destroys a checked-out connection on aborted/timed-out queries. It excludes credential hashes, TOTP secrets, recovery codes and session tokens. It includes versioned agreement receipts and their exact archived documents.

Account deletion requires password confirmation, transfer/deletion of owned workspaces and resolution of pending payments. It removes the account's credentials, sessions, MFA state, contributions and access records, retires affected media, and preserves shared workspace content for its remaining members. Workspace deletion similarly blocks until recordings and unresolved payments are dealt with.

The candidate now has a durable signed deletion journal, an independently acknowledged receiver, database/genesis binding and offline replay before serve. This is a substantial implementation improvement over the old live image. Independent receiver deployment and a real full disaster-recovery run remain separate gates. Existing populated production cannot silently enroll an empty replacement journal.

A database backup does not recover MP4 bytes. A signed download already issued can live for its remaining 60 seconds; bytes already downloaded cannot be recalled. Deleting an S3 object in a versioned bucket may leave noncurrent versions. Retention must cover live objects, cached encrypted objects, destination copies, temporary files and database recovery bundles under their actual policies.

Source anchors: `account-export.ts`, `suite.ts:531`, `suite.ts:631`, `suite.ts:764`, `deletion-journal.ts`, `deletion-replay.ts`, `deletion-binding.ts`; [deletion-database-binding.md](../deletion-database-binding.md), [recording-backup.md](../recording-backup.md).

## Recording and post-meeting analysis

| Requirement           | Current implementation                                                                                            | Gate to close                                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Start and stop        | Durable capacity reservation; repeat-start blocked after uncertain Egress result; exact-generation reconciliation | Real Egress start/stop, long record, room close, process interruption and provider reconciliation after new ingress/deploy              |
| Access                | Workspace membership and private object storage; short-lived signed download; deleted/expired content blocked     | Actual S3/public hostname signing and unauthorized access test on final deployment                                                      |
| Retention             | Expiry timestamp, immediate logical withdrawal, leased physical cleanup with retry                                | Prove all operational copies expire/withdraw; show pending cleanup and restore behavior                                                 |
| Capacity              | Bounded encoding profile; global/workspace active limits; worker constraints                                      | Measured allowed duration, concurrency, quality and storage per plan, with supported failure behavior                                   |
| Backup                | Encrypted incremental recording backup, hash verification and withdrawal                                          | Fresh automatic offsite copy and successful nonempty restore independent of the main host                                               |
| Transcription/summary | Bounded private worker queue, cancellation/expiry checks, exact model artifact provenance                         | Real accepted recording-to-transcript/summary output with approved model artifacts, language accuracy, privacy and measured capacity    |
| Participant notice    | Recording status exists in product                                                                                | Explicitly accepted recording/guest notice and any required purpose-specific choices; account terms acknowledgement does not prove this |

The current recording backup code limits each object to 350 MiB, its server cache to 1 GiB and its manifest to 2,048 objects (`scripts/recording-backup.py:18-21`). Those are pilot implementation bounds, not approved paid storage quotas. The encoding profile is 1280x720 at 15 fps, video 1200 kbit/s and audio 64 kbit/s (`media.ts:112-125`). Limits should be published only after actual duration, storage and concurrency acceptance. The offsite Mac workflow cannot be represented as continuous protection while the Mac is asleep/offline.

Post-meeting transcription and summary are distinct from synchronous interpretation. A passed model-provenance test does not establish recognition/translation quality or commercial rights for a different voice/model.

## Payment implementation and outstanding work

The code has a YooKassa server adapter and an explicit 30-day purchase/renewal. It does not automatically charge a stored card. Amount and plan come from the server. Persisted order identity and canonical provider objects bind amount, currency, test mode, merchant, workspace and payer. Provider webhooks and return-page query strings alone cannot grant service. Uncertain create results reuse the original idempotency key and require operator reconciliation after their safe retry window.

Successful grants are applied once. Canonical full refunds revoke only the unused contribution for that order and preserve independent renewals. Stale responses cannot undo terminal local refund/cancellation state. Partial refunds are not automatically converted into a pro-rata service period; the business/support policy is still an owner decision.

Still required for selling this payment flow:

1. Actual seller/merchant account, permitted processing configuration and owner-approved receipt/tax settings.
2. Approved price, included capacity, purchased period, renewal description and refund/support policy.
3. Provider acceptance of success, cancellation, timeout/uncertain create, duplicate webhook, delayed webhook, renewal, full/partial refund and entitlement expiry on the exact release.
4. Confirmation that disabling checkout does not break existing paid access, and that reconciliation still has an operational path.
5. A measured cost model including calls, Egress, storage/backup, support and any optional translation. The default amount in config is not an approved price.

Source anchors: `billing.ts`, `payments.ts`, `payment-checks.ts`, `billing-schema.ts`, [payment-and-recording-reconciliation.md](../payment-and-recording-reconciliation.md). No real purchase/refund was performed during this review.

## Public documents, agreement, SDK and integration boundaries

The source contains public home/about/help and truthful disabled-feature states. Published terms/privacy documents require a reviewed manifest. The new authenticated agreement flow records exact published hashes only after explicit user choices. Reading, export, deletion and safe exit remain available without accepting a new edition. There is no fabricated historical acceptance for existing accounts.

Remaining work is actual approved operator/contact/support/document content, its publication, deployment enforcement, and separate guest/recording purposes. The source mechanism and its controlled tests do not approve the document text.

Guest SDK and iframe embedding already exist. The SDK omits account cookies, keeps room capabilities in memory and has bounded requests. Embedding restricts exact origins and uses an exact-window/origin/channel handshake. Full account pages stay unframeable. Accept each actual hosting origin, browser Permissions-Policy, admission/chat/media and leave/destroy cleanup on the final public endpoints.

Google login, calendar OAuth, corporate SSO, native mobile apps and post-meeting AI are separate capabilities. The current .ics calendar download is not a calendar-account integration. Optional capabilities can be excluded explicitly from an initial offer, but must not be advertised as completed.

Source anchors: `legal-consent.ts`, `legal-consent-schema.ts`, `public-information.ts`, `packages/sdk/index.js`, `packages/sdk/embed.js`, `embedding.ts`; [legal-consent.md](../legal-consent.md), [embedding-deployment.md](../embedding-deployment.md).

## Concrete continuation order

1. Integrate the focused recording-history and waiting-admission fixes with the release build fixes, then bind final tests to the resulting source/image rather than a predecessor.
2. Settle canonical external endpoints and Google identity setup; finish owner recovery and external email account journeys.
3. Establish independent deletion receiver/monitor/backup, enroll the existing database with reviewed history, and prove recovery before reopening with the new source.
4. Complete real media/TURN/browser/network and Egress/storage acceptance at the intended paid limits.
5. Resolve workspace-private meeting semantics and the recording participant flow; apply the resulting access/notice contract consistently.
6. Complete merchant/provider acceptance and publish approved service/support/data terms with correct versioned enforcement.
7. Accept post-meeting analysis, embedding and synchronous translation separately if they are included in the first sold product.

This branch does not assert that commercial readiness is complete. Its recording-history fix closes one demonstrated scalability defect; remaining gates above require their own evidence or explicit product decision.
