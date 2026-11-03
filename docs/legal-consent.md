# Explicit account agreement and privacy acknowledgement

This implementation records an authenticated user's explicit acceptance of the
published terms and separate acknowledgement of the published privacy notice.
It does not supply legal text, publish documents, choose a legal basis for
processing, imply consent to optional marketing or AI, or cover guest and
recording consent.

## Publication and exact content

The existing `PUBLIC_LEGAL_APPROVED=true` configuration, approved manifest path,
exact raw-byte `PUBLIC_LEGAL_MANIFEST_SHA256` and support address remain the
publication authority. Both documents share the reviewed manifest version.
Each public-document response also contains `kind`, `manifestSha256` and
`documentSha256`. The document checksum is SHA-256 of canonical UTF-8 JSON for
the exact published content envelope `{kind,version,publishedAt,operator,document}`:
object keys sort lexicographically; array order and string content are preserved.
It is a content checksum, not a checksum of HTTP framing or whitespace.

The consent review endpoint returns these same document identities and the
approved plain-text content. Raw HTML is never executed. Changing approved
manifest bytes invalidates prior acceptance even if an operator reuses a human
version label. Operators should publish a new descriptive version for revisions
and retain their approved original manifests with release records.

## Explicit action and evidence

`GET /api/me/legal-consent` and `/api/me` report the current status. Reading a
document, signup, login, migration and startup never create an acceptance or
archive row. No prior account is backfilled as having agreed.

`POST /api/me/legal-consent` requires a currently authenticated, verified account,
the normal same-origin check, both explicit actions and all current version/hash
fields. A client cannot supply the user ID or acceptance time. A stale version
or mismatched checksum returns `409 LEGAL_VERSION_CHANGED`; the UI reloads the
documents and clears both checkboxes, without submitting the new version.

The first valid POST archives the exact published document snapshot in
`im_legal_versions` and creates one `im_legal_acceptances` row for the user and
manifest. The transaction checks and locks the still-active account session.
Evidence records the server timestamp, immutable public version and hashes,
`terms_accepted=true`, `privacy_acknowledged=true`, and the action schema
`explicit-account-v1`. The two actions have different meanings: acceptance of
terms and acknowledgement of a privacy notice. This is not a blanket consent
to every possible use of personal data.

Concurrent/repeated identical POSTs return the same receipt and original time.
UPDATE triggers reject rewriting receipts and archived versions. The application
exposes no endpoint for editing them. This is trusted database evidence, not an
external digital signature or protection against a database administrator who
can disable triggers or rewrite backups.

## Optional enforcement and safe exit

`LEGAL_ACCEPTANCE_REQUIRED=false` is the compatibility default. Explicit voluntary
recording is available when approved documents exist. Set it to `true` only as
part of the approved launch configuration; startup then requires published,
approved documents. Compose forwards this value and the release/readiness legal
configuration hash includes it, invalidating receipts from a different mode.
The public/commercial launch checker also requires enforcement to be enabled;
fresh operational evidence cannot override `LEGAL_ACCEPTANCE_REQUIRED=false`.
Disabled enforcement is supported for a closed preview, not launch readiness.

When enabled, new state-changing business requests that authenticate an account
through the shared API user check require that account's receipt for the exact
current manifest. This is a server check. Creating a workspace, joining a room
as an authenticated account, accepting an invitation and starting other business
actions cannot be enabled by merely hiding the UI prompt. Normal workspace and
role checks still apply after acceptance; another user's receipt never grants
access or satisfies the requirement.

Read-only requests, DELETE operations, session revocation, ownership transfer,
closing rooms and stopping recordings remain available. Authentication, MFA,
password management, export and account deletion remain usable without accepting
a new edition. This permits safe departure and satisfies deletion prerequisites.
The UI links to personal data controls even for an account with no workspace.
The original invitation or return path survives the document review.

The gate does not perform server-side revocation of previously issued media/chat
capabilities or impose account receipt tracking on anonymous
guests. It is not proof of guest permission, recording consent or per-purpose AI
consent. Those are separate product and legal requirements.

The recordings page remains available with the document reminder so an owner
can stop and delete existing recordings before deleting a workspace/account.
Starting new processing still requires the current agreement on the server.

## Export, deletion and restore

Account export includes only the requesting user's receipts and their immutable
public document snapshots through a bounded keyset section. Deleting an account
cascades to its acceptance rows under the existing deletion/replay contract.
The archive of public documents has no account identifiers and can remain for
other users' receipts. No independent perpetual retention of personal acceptance
evidence is introduced. Owner review must still approve the actual retention,
backup, restore and operational policy.

The new tables are empty after migration; there is no startup or GET seed that
could interfere with the deletion-journal empty-database authority binding.
An old database restored without a recent acceptance row will request explicit
acceptance again rather than fabricate historical evidence.

## Validation

Meaningful API regressions cover no implicit evidence, exact publication hashes,
concurrent idempotency, immutability, malformed or stale payloads, CSRF, revoked
or unverified sessions, cross-account isolation, unchanged tenant checks,
enforcement, export and cascade deletion. The browser regression exercises the
production React bundle at 320px: blank controls, separate required actions,
literal HTML rendering, stale-version reset, data access without acceptance,
preserved invitation fragment and decline/signout. All fixtures use synthetic
documents and isolated accounts, with no public publication or real mail.
