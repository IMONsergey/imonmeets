# IMON Meets: Google auth production checkpoint

## Confirmed auth cutover

The auth release was deployed on **2026-11-04 at 12:34:58 MSK
(09:34:58Z)** to the canonical site **https://meets.imon.world**.

- Runtime source: `a3d816ff28cb4692d07c950d92642207a57f9a58`.
- Source tree: `140bbcfcce57d5b5f39c2188dde5a880d55bc62b`.
- Image activated at cutover: `sha256:9c4b8abe99d816d215152ad75405d5a0b549dbd510ddcd5a594b57d5b8321a87`.
- Previous image: `sha256:601b62bbf561c82cc369f7ff8e920320f0745b9acfb4c8872fd94e3df623879e`.
- Release branch: `release/google-auth-20261104`.
- Public health, configuration, login and registration routes returned HTTP 200.
- Public configuration reports Google OAuth configured, registration enabled,
  external email configured, media configured and recording configured.
  Configuration flags do not establish a new external media or recording acceptance.
- A live Google authorization-start request returned an accounts.google.com URL,
  the exact callback `https://meets.imon.world/api/auth/callback/google`,
  only `openid email profile` scopes, and a secure state cookie.
- The public Google button is present. The existing Google Cloud client was
  checked in the provider UI: origin `https://meets.imon.world` and redirect
  `https://meets.imon.world/api/auth/callback/google` match the canonical site.
- A real sign-in reached Google's account-owner device confirmation challenge.
  **The Google callback, account creation and authenticated new-account session
  remain unverified until the account owner completes that challenge.**

The sanitized deployment receipt is
[cutover.json](docs/reviewed-results/2026-11-04-google-auth/cutover.json).
It records the state at cutover; later account activity may change the counts below.

| Preserved object at cutover | Count |
| --------------------------- | ----: |
| Users                       |     7 |
| Auth accounts               |     7 |
| Sessions                    |    23 |
| Workspaces                  |     6 |
| Rooms                       |    18 |
| Members                     |     6 |
| Recording rows              |     2 |
| Invitations                 |     1 |

## Code included

This is a forward auth update from the existing `9bb2dab` runtime through
the earlier, independently scoped identity/mail line `15383e1`.

It includes durable mail delivery and quota accounting, verified Google account
linking, local MFA after OAuth, single-use password enrollment for Google-only
accounts, and strict identity-only Google permission requests. Noncanonical auth
paths are refused before endpoint-specific policy or provider forwarding.

The added auth commits are `e09ee88` (scope policy), `8c5cdc5` (canonical
paths), and `a3d816f` (explicit session-fixture type for strict tests).
The new schema is limited to mail reconciliation and identity enrollment/MFA
migration. The one-time identity migration revokes legacy MFA sessions and
challenges while preserving factors. There were zero MFA users at cutover.

No deletion/witness subsystem was introduced or disabled by this release.
The rehearsal and live cutover both reported no existing deletion binding in the
current database. The separate remote full candidate on
`release/edge-transport-acme-20261103` advanced from `194e704` to `17147a6`.
Its independent witness commissioning and wider product changes are not implied
by this auth deployment. Access to the existing witness server was restored;
HTTPS commissioning was in progress. No production witness binding or full
migration is certified by this checkpoint.

The additional `release/google-production-20261104` / `ae03115` candidate exists
only locally; its push was blocked by workflow permissions. It is not the
published full-release source.

## Build and checks

Runtime dependencies and the lockfile match `9bb2dab` and `1b52d61`.
No dependency upgrade was needed. The root package manifest adds only the
Google policy test command.

The runtime image was assembled with COPY-only instructions: verified existing
dependencies, newly compiled API/web output, licenses and an artifact manifest
on the pinned Node 24.21.0 image. No install command or network fetch was part
of image assembly. The saved recipe references a local dependency tag; before
reusing it, verify that tag resolves to the exact dependency image above.

- [Runtime recipe](docs/reviewed-results/2026-11-04-google-auth/runtime.Dockerfile)
- [Artifact hashes](docs/reviewed-results/2026-11-04-google-auth/artifact-manifest.json)
- Local bounded verification job: `20261104T090727-b8258688ea`, exit 0.
- Local checks: formatting, all TypeScript checks, API/web builds, 6 Google
  policy tests, 21 auth/mail tests, 18 web tests and 7 SDK tests passed.
  Two PostgreSQL-specific mail tests were skipped locally without a test DB.
- [GitHub Actions run 41805564357](https://github.com/IMONsergey/imonmeets/actions/runs/41805564357)
  passed for the exact runtime commit. Its PostgreSQL-backed API suite passed
  **78/78 with no skips**; web **18/18**, SDK **7/7**, readiness **14/14** and
  browser state/accessibility **4/4** also passed. All workflow steps succeeded,
  including the backup regressions and dependency audit.
- Vercel reported a successful build for the same source commit. This is
  separate from the primary server deployment.

Local OAuth issuer tests establish protocol and MFA behavior, not a real Google
provider login. Browser regression fixtures are also separate from live-account
acceptance.

## Verified follow-up candidate

The narrow follow-up source is
`44355fda9350b392dee12e7c8bf16ec50c6b5a35`, pushed to
`release/google-auth-20261104`. This candidate has not been deployed by these
verification steps, and no image was assembled for it by the reviewer.

- `ff38b27` counts open rooms for both quota enforcement and plan usage.
  Closing a room releases its slot while preserving history; concurrent creation
  remains protected by the workspace lock.
- `4bfe13e` stops local automatic admission immediately on cancellation, clears
  the persisted waiting grant, aborts polling/join requests and ignores late
  completions. Server cancellation is atomic for an unused ticket. A consumed
  ticket returns an honest HTTP 409; this narrow release does not revoke an
  already issued media token.
- `3787380` and `883c21c` replace the text G with unchanged official Google PNG
  assets and density selection. The official SVG and provenance are retained.
  Source PNG hashes and compiled asset bytes match. Live appearance verification
  remains pending publication.
- `44355fd` updates the existing concurrency fixture to count open rooms before
  reserving exactly one slot. Its strict `[200, 409]` assertion is preserved.

Schema, runtime configuration, dependency manifests, lockfile and workflow
files are unchanged from the deployed `a3d816f` source. Installed dependencies
were reused only after the lockfiles were compared byte-for-byte.

[The follow-up receipt](docs/reviewed-results/2026-11-04-google-auth/followup-verification.json)
records the exact source and compiled hashes. Local bounded job
`20261104T101010-8b97ef52fc` finished successfully at 10:23:34Z: changed-source
formatting, all TypeScript checks, **11 API checks**, **5 browser checks**
(the cancellation fixture and its four scenarios), API/web builds and PNG asset
copy identity passed, with no failures or skips.

[GitHub Actions run 41812430093](https://github.com/IMONsergey/imonmeets/actions/runs/41812430093)
passed for `44355fd`: API **83/83**, web **18/18**, SDK **7/7**, readiness
**14/14** and browser **9/9**, all without failures or skips. Every workflow step
succeeded. The frozen baseline quota job reproduced the bug in both pilot and
commercial modes: after closure, old usage was 2 instead of the expected 1.

[The scope and remaining limits](docs/release-2026-11-04/room-quota-waiting-cancellation.md)
record the unbounded room/history listings and the consumed-token cancellation
boundary. The larger full-release admission and deletion architecture was not
backported into this candidate.

## Migration, backup and rollback boundary

[The isolated rehearsal](docs/reviewed-results/2026-11-04-google-auth/rehearsal.json)
restored the current data into disposable PostgreSQL with no external network
or published ports. The candidate migration completed, core counts were
preserved, and both the candidate and previous image passed read-route checks
against the upgraded copy. Disposable containers were removed.

This certifies compatibility of the migrated snapshot and read routes only.
It does **not** certify rollback after new production Google accounts, password
enrollments or other auth writes. Do not use a blind old-image switch or restore
an old dump over subsequent user activity.

A fenced backup was captured before the live switch. The existing backup service
was then run once after cutover. Its
[post-cutover receipt](docs/reviewed-results/2026-11-04-google-auth/postcutover-backup.json)
reports success at 12:37:05 MSK, a verified dump catalog containing the new
identity/mail schema and an encrypted bundle. Decryption of that new bundle
was not tested by this run. No dumps, keys, credentials or private environment
files are included in the repository.

## Next verification and repository integration

1. Complete the Google account-owner challenge on the canonical site, then
   verify callback, authenticated session and onboarding. Check same-email
   linking, cancellation and existing-account access.
2. The local `1b52d61` deployment documents are already preserved through merge
   `79a964c`. They add three historical files under `docs/reviewed-results`.
3. The narrow `44355fd` candidate has successful local verification and CI.
   Review the selected deployment candidate and its exact runtime identity before
   changing main. Main was not pushed by the reviewer.
4. Continue full-release verification independently, including witness,
   network/media, recording and recovery acceptance. A verified narrow fallback
   remains available while that work proceeds.

At this follow-up checkpoint, remote main was `8439524`; local main was
`1b52d61`. Both the narrow and full candidates preserve local main in their
ancestry. Documentation commits do not change the deployed auth cutover identity
or the separately verified `44355fd` compiled artifacts above.
