# Public pages, support and approved documents

The application now has a public homepage, `/about`, `/help`, `/privacy` and `/terms`. Signed-in users retain their dashboard at `/`. Unknown routes render a dedicated 404 page and return HTTP404 when served by the API. Legal pages do not require an account.

The homepage advertises the implemented meeting workflow. Optional recording/analysis features are conditional on capability flags. It does not advertise real-time translation as a released feature. Help explains workspace-wide history visibility and the difference between a waiting room and private history.

`SUPPORT_EMAIL` is a plain operator-approved contact address, without a display name or headers. `SUPPORT_HOURS` is optional public text, at most200 characters. A closed signup page offers the configured contact and a help link. No contact address is invented when this configuration is absent.

## Publish legal text

The repository intentionally contains no purportedly approved legal entity, address, contract or privacy text. Supply the actual reviewed documents in a UTF-8 JSON file with this structure:

```json
{
  "schema": 1,
  "version": "2026-11-03.1",
  "publishedAt": "2026-11-03T00:00:00Z",
  "operator": {
    "name": "ACTUAL_REVIEWED_OPERATOR_NAME",
    "registration": "ACTUAL_REVIEWED_REGISTRATION",
    "address": "ACTUAL_REVIEWED_ADDRESS"
  },
  "privacy": {
    "title": "Политика обработки данных",
    "sections": [
      { "heading": "REVIEWED_HEADING", "paragraphs": ["REVIEWED_TEXT"] }
    ]
  },
  "terms": {
    "title": "Условия использования",
    "sections": [
      { "heading": "REVIEWED_HEADING", "paragraphs": ["REVIEWED_TEXT"] }
    ]
  }
}
```

This is a format example, not publishable text. Required business inputs are the seller/operator and registration, actual contact and support hours, launch markets, payment/refund model, storage locations and subprocessors, retention and user deletion process, workspace access policy, recording/AI notices and approved limits. Legal review must cover the actual deployed services.

After owner approval, mount the reviewed file read-only in the application container and set `PUBLIC_LEGAL_MANIFEST_PATH` to that path, `PUBLIC_LEGAL_MANIFEST_SHA256` to the SHA256 of its exact bytes, and `PUBLIC_LEGAL_APPROVED=true`. Set the real `SUPPORT_EMAIL`. An approved but missing, modified, oversized or structurally invalid file prevents application startup. If approval is absent, drafts are not read or returned.

Content is rendered as plain React text; the manifest cannot inject HTML. `/api/config` exposes only version, publication time, checksum, operator name and contact. `/api/public-documents/privacy` and `/api/public-documents/terms` return the approved document. Without approved content these endpoints return404 and the public page clearly states that the document is not published and commercial sales are not open.

The launch checker requires document approval, exact checksum and support contact, plus fresh acceptance tied to the exact release and configuration. The `legal` receipt records `publiclyReachable`, `operatorVerified`, `dataFlowsReviewed` and `termsReviewed`; simply setting an approval flag is insufficient. Changes to the manifest or contact invalidate that evidence. Existing payment approval is a separate gate.

Publication does not yet record per-user agreement acceptance. If the approved commercial model requires acceptance at signup/checkout, bind the actual document version and hash to that event before enabling sales; do not backfill historical agreement from publication alone.
