# Durable mail delivery and reconciliation

SMTP and Resend share `im_email_deliveries`. A logical message is the SHA-256 of normalized sender/recipient, subject and exact text. The ledger stores no message body or recipient address. SMTP uses the same digest as its Message-ID; Resend also receives it as Idempotency-Key.

The ledger reservation and recipient/day/30-day delivery budgets commit in one transaction immediately before contacting the provider. Duplicates do not consume another budget. Denied reservations roll back every budget. Public password-reset and verification requests retain a separate recipient request limit; nonexistent accounts cannot spend the shared delivery quota. Provider/ledger failures return the same public recovery response as unknown accounts.

## Meaning of states

- `sending`: durable reservation made, provider outcome not yet recorded. A two-minute lease prevents operator changes during the bounded transport attempt.
- `accepted`: provider accepted the request, not proof of inbox delivery. Replaying this logical mail is a no-op.
- `uncertain`: the request may have been accepted; no automatic retry is permitted.
- `rate_limited` or `rejected`: terminal for this logical message. No automatic retry occurs.
- `delivery_status`: `unknown`, `accepted`, `delivered`, `bounced`, or `complained`. Delivery/bounce/complaint requires separate reviewed provider evidence; acceptance alone never marks a message delivered.

An ambiguous SMTP result cannot be made exactly-once by a Message-ID alone. The conservative ledger blocks a second attempt even after a restart or a lost success update. An operator may resolve it as accepted or abandon it permanently; neither operation resends the message or refunds quota. A different legitimate recovery request can create a new token/message, subject to normal request and delivery limits.

## Operator workflow

Use an existing private application environment and the installed repository/runtime. Never pass keys, database credentials, message bodies or token-bearing URLs on the command line.

1. Run `node scripts/reconcile-mail.mjs --list`. This reads at most 50 unresolved rows, without recipients or message contents.
2. Review the provider's delivery event/log against the exact logical message and time. Record evidence privately and calculate its SHA-256. A missing log is not proof that a message was unsent. For accepted/delivery events, identify the provider's exact message ID. For an unresolvable outcome choose `abandoned`.
3. Prepare a private JSON file with `idempotencyKey`, `expectedVersion`, `action`, `operatorId`, `evidenceSha256`, and optionally `providerId` (required for acceptance unless already recorded). Allowed actions are `accepted`, `abandoned`, `delivered`, `bounced`, `complained`.
4. Run `node scripts/reconcile-mail.mjs --apply --file /private/reconciliation.json`. Active sends, stale versions, identifier mismatches, repeated/backward delivery transitions and invalid inputs are rejected. Each successful transition appends immutable reconciliation evidence and increments the ledger version in the same transaction.

There is no public reconciliation endpoint and no `retry`, `reset`, or delete-ledger operation. Provider webhook automation is not implied by this manual operator workflow.

## Explicit inbox acceptance check

`node scripts/check-mail-delivery.mjs --to YOUR_OWN_VERIFIED_MAILBOX --id STABLE_CHECK_ID` sends through the shared ledger and quota. Reuse exactly the same ID and mailbox after an interrupted attempt. It writes a private receipt including the provider, ledger key, submitted time and sender configuration hash, with `received: false`. Confirm the exact nonce in the destination inbox and inspect authentication headers before an operator changes the receipt into accepted evidence. This command was not run against real mailboxes during development.

## Development verification (2026-11-03)

Isolated PostgreSQL schema per test on the disposable local test container; no production DB or provider calls. All commands used the shared verification flock, Node 24, systemd CPUQuota=100%, MemoryMax=2G and bounded runtime.

- Before the fix: three focused tests failed for the expected MAIL-01 defects (unknown-recipient request budget, missing transport budget, concurrent last-slot race).
- After the fix: 19 mail unit/integration tests passed, including real PostgreSQL concurrency/restart, SMTP acceptance/uncertainty, anti-enumeration on exhausted quota, CAS reconciliation, active-lease refusal, replay prevention and no secret/body leakage.
