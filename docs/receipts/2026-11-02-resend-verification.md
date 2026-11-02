# IMON Meets Resend transport verification receipt

Date: 2026-11-02 UTC

## Scope and safety

- Branch: feature/imonmeets-auth-google-20261102
- Base auth commit: c1f0ebce266eaca323d121a93d63ff2f3e448ff1
- Main repository remained unchanged.
- No production deployment, active environment, DNS, Google OAuth credentials, user data or sessions changed.
- No external email was sent during this work. The previously delivered Resend test was not repeated.
- Registration remains disabled in the private staged configuration and active deployment was not modified.

## Implemented

- Added explicit Resend HTTPS selection alongside SMTP/capture.
- Canonicalized the recipient identically in both request payload and deterministic SHA-256 idempotency key.
- Added PostgreSQL im_email_deliveries ledger: idempotency key, recipient hash, state, provider message ID, HTTP status, coarse error kind and retry-after. No email body, verification URL, reset token or recipient plaintext is persisted.
- Atomic reservation before provider request. Accepted duplicates are no-ops. A pre-existing sending/uncertain state blocks replay. A failed ledger write blocks before HTTP. A failed post-acceptance update leaves unresolved state and blocks replay. This is fail-closed, not exactly-once delivery.
- Added redirect rejection, no-store, 10-second timeout, 429 Retry-After, 5xx/timeout uncertainty and permanent 4xx classification. No automatic retries.
- Added conservative Free-tier budgets: 45 per internal 24-hour global bucket, 45 per workspace 24-hour bucket, 1,000 per internal 30-day global bucket, and existing 5 per recipient/hour. The 30-day bucket ceiling is 1,000 so a 31-day calendar month cannot exceed 3,000. Configuration rejects higher Resend values.
- Preserved SMTP budget keys and SMTP behavior; the additional 30-day limit is Resend-only.
- Added mock transport tests and real PostgreSQL integration tests for concurrent reservation, accepted replay after pool restart, crash-left sending state, provider ID persistence, ledger failure, atomic daily/monthly budget and budget persistence after restart.

## Verification

Full verification job: 20261102T120333-848374854d

- State: succeeded
- Exit: 0
- Timed out: false
- Disk reserve breached: false
- Prettier: pass
- TypeScript API/web/E2E: pass
- Production web/API build: pass
- API tests: 60 passed, 0 failed, 0 skipped
- Web tests: 18 passed, 0 failed
- SDK tests: 7 passed, 0 failed
- Browser tests: 3 passed, 0 failed
- Total: 88 passed, 0 failed, 0 skipped
- Real PostgreSQL 17 tests ran against a temporary loopback-only database on port 55439, isolated schemas and tmpfs storage. The database was not production.
- Existing Vite warning remains: Join chunk exceeds 500 kB (693.36 kB); unrelated to this mail transport.

Earlier diagnostic jobs:

- 20261102T111441-08524284b8: failed due to test fixture/timing defects; superseded.
- 20261102T111650-f37fbbc766: failed due to the same fixture and a synchronization issue; superseded.
- 20261102T112104-af6ce7d676: succeeded, focused 11/11 Resend/PostgreSQL tests.
- 20261102T112319-4b8a299192: failed due to assertion ordering; superseded.
- 20261102T113713-f6b12fb516: failed due to an incorrect expected concurrency count; superseded.
- 20261102T113925-7eb38acdf7: succeeded before final test-name/key cleanup; superseded by the full job above.
- 20261102T114531-d03bb32b99: earlier succeeded, 88/88; the final full job above verifies after the final key-name correction.

## Private configuration

A mode-0600 pending configuration and mode-0600 rollback snapshot are stored outside Git under /home/sergey/.config/imonmeets-accounts/. The Resend API key is only read programmatically from its pre-approved private key file and is not included in this receipt, repository, logs or command output. The pending config has registration disabled and stricter Free-tier budgets. It has not been loaded into the active service.
