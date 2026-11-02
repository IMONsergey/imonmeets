# Activate real email delivery

Public registration must remain closed while `EMAIL_DELIVERY_MODE=capture`. That mode stores mail in a private test inbox and cannot deliver a confirmation to a customer's address.
Capture mode is now restricted to local capture hosts (`mailpit`, `localhost`, `127.0.0.1`, `::1`). A non-local SMTP host with capture mode is rejected at startup, so a misconfigured preview cannot silently send to external recipients.

The application sends verification, recovery and invitation messages through an explicitly selected transport: Nodemailer SMTP or Resend HTTPS. Both use bounded timeouts and database-backed budgets; the Resend path additionally uses a durable idempotency ledger and verified HTTPS/TLS defaults. A connected Gmail assistant account is not used as the server mail transport.

## Resend Free safeguards

The approved Resend Free account is limited to 3,000 messages/month and 100/day. Pay-as-you-go/overage switches are disabled; do not enable them or add a payment card.

The application uses a stricter local fail-closed budget through the existing PostgreSQL rate limiter: 45 sends per internal 24-hour bucket and 1,000 per internal 30-day bucket globally, plus 45 per workspace 24-hour bucket and the existing 5-per-recipient/hour guard. The daily bucket is half the provider daily cap, so a boundary overlap can reach at most 90 per rolling 24 hours. The 30-day bucket is one-third of the monthly cap; any 31-day calendar month can intersect at most three such buckets, so the application cannot exceed 3,000 messages in that month.

Select the transport explicitly with EMAIL_PROVIDER=resend and EMAIL_DELIVERY_MODE=external. The HTTPS API is https://api.resend.com/emails; sender is no-reply@notify.imon.world. The restricted Sending key is read from the private server environment as RESEND_API_KEY. Never put it in Git, browser configuration, shell arguments, logs or chat.

Each logical message gets a deterministic Idempotency-Key derived from the normalized recipient, sender, subject and message body. The key is a SHA-256 digest; reset/verification tokens are never logged. HTTP 429 is reported as rate-limited with Retry-After; 5xx, timeout and connection loss are marked uncertain. The transport never retries automatically. Any manual retry must use the exact same message payload and therefore the same idempotency key; an uncertain send must first be reconciled against the provider ledger.

Before the HTTPS request, the mailer atomically reserves that key in the PostgreSQL im_email_deliveries ledger. The ledger stores only the key hash, recipient hash, state, provider message ID, HTTP status and coarse error class; it never stores the message body, verification URL or reset token. A duplicate of an accepted logical message is a no-op. A row left in sending by a crash, or marked uncertain, blocks replay until reconciled. If Resend accepts a message but the process crashes before the provider ID is committed, the state remains unresolved; this is deliberately fail-closed, not an exactly-once guarantee. No automatic retry or blind duplicate is attempted.

## Configure privately

Set these values only in the server's private environment, never Git or browser-visible variables:

    EMAIL_DELIVERY_MODE=external
    EMAIL_PROVIDER=resend
    REGISTRATION_ENABLED=false
    RESEND_API_KEY=<restricted Sending key>
    SMTP_FROM=no-reply@notify.imon.world
    EMAILS_PER_DAY=45
    EMAILS_PER_WORKSPACE_DAY=45
    EMAILS_PER_30D_BUCKET=1000

The legacy SMTP settings remain available when EMAIL_PROVIDER=smtp; they are not used by the Resend HTTPS transport.

## Verify delivery before opening signup

The mail acceptance script sends a real test message. Do not run it unless the owner has explicitly approved the exact recipient and scenario. The previously accepted one-time Resend test is already recorded in the private operator ledger; do not repeat it.

Find the exact returned nonce in the destination inbox, inspect the sender and SPF/DKIM/DMARC authentication result, and confirm that the message is not quarantined. Then run an actual signup and verification through the deployed app, followed by password recovery and an invitation to an address controlled by the operator. Do not send these checks to customer addresses without separate consent.

After successful end-to-end checks, set REGISTRATION_ENABLED=true, recreate only the application service and verify canonical /api/config. Retain a rollback to closed registration if delivery begins to fail. Never substitute DEV_ALLOW_UNVERIFIED_EMAIL=true for working delivery in production.

Current observed access at the start of this release: the project contained no external SMTP credentials, the opened Timeweb hosting page required sign-in, and the domain registrar page was unreachable from the connected browser. These are account/provider setup dependencies, not missing registration forms.

## 2026-11-02 Resend HTTPS acceptance status

The private pending Resend HTTPS configuration and rollback snapshot are prepared outside the repository. The HTTPS mailer now uses a durable PostgreSQL idempotency ledger and fails closed on unresolved sends. The live deployment environment and running application have not been changed. The deployed release commit is an ancestor of the saved auth branch. The existing mailer is Nodemailer-only; the branch adds a separately selected Resend HTTPS transport.

The owner-approved one-time HTTPS test is recorded as accepted and delivered in the private ledger. It is not repeated. SMTP preflight timed out before AUTH/MAIL and is not used by this implementation. No DNS, firewall, VPN or network workaround is needed. Registration remains false.
