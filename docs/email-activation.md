# Activate real email delivery

Public registration must remain closed while `EMAIL_DELIVERY_MODE=capture`. That mode stores mail in a private test inbox and cannot deliver a confirmation to a customer's address.
Capture mode is now restricted to local capture hosts (`mailpit`, `localhost`, `127.0.0.1`, `::1`). A non-local SMTP host with capture mode is rejected at startup, so a misconfigured preview cannot silently send to external recipients.

The application already sends verification, recovery and invitation messages through Nodemailer with bounded timeouts, TLS verification and database-backed budgets. It requires the actual sender credentials and sender-domain configuration. Connecting Gmail as an assistant tool does not give the deployed server a durable SMTP identity.

## Configure privately

Set these values only in the server's private environment, never Git or browser-visible Vercel variables:

```dotenv
EMAIL_DELIVERY_MODE=external
REGISTRATION_ENABLED=false
SMTP_HOST=<provider SMTP host>
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=<dedicated service sender>
SMTP_PASSWORD=<SMTP credential>
SMTP_FROM=IMON Meets <verified service address>
```

Port 587 uses mandatory STARTTLS; port 465 uses `SMTP_SECURE=true`. Keep certificate validation enabled. Configure SPF, DKIM and DMARC using the exact records supplied by the sender's provider. Do not replace existing domain MX or SPF records belonging to another service without reviewing the existing zone.

## Verify delivery before opening signup

Run from the application environment:

```sh
IMON_ENV_FILE=/home/sergey/imonmeets/.env node scripts/check-mail-delivery.mjs --to YOUR_OWN_VERIFIED_MAILBOX
```

The script verifies the TLS SMTP connection, submits exactly one test message and records private evidence in `ops-state/mail-delivery-check.json`. It intentionally does not open registration. A successful SMTP submission is not proof that the recipient received the message.

Find the exact returned nonce in the destination inbox, inspect the sender and SPF/DKIM/DMARC authentication result, and confirm that the message is not quarantined. Then run an actual signup and verification through the deployed app, followed by password recovery and an invitation to an address controlled by the operator. Do not send these checks to customer addresses.

After successful end-to-end checks, set `REGISTRATION_ENABLED=true`, recreate only the application service and verify canonical `/api/config`. Retain a rollback to closed registration if delivery begins to fail. Never substitute `DEV_ALLOW_UNVERIFIED_EMAIL=true` for working delivery in production.

Current observed access at the start of this release: the project contained no external SMTP credentials, the opened Timeweb hosting page required sign-in, and the domain registrar page was unreachable from the connected browser. These are account/provider setup dependencies, not missing registration forms.
