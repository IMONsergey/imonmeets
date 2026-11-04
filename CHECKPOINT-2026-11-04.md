# IMON Meets: Google auth production checkpoint

## Confirmed state

The auth release was deployed on **2026-11-04 at 12:34:58 MSK
(09:34:58Z)** to the canonical site **https://meets.imon.world**.

- Runtime source: `a3d816ff28cb4692d07c950d92642207a57f9a58`.
- Source tree: `140bbcfcce57d5b5f39c2188dde5a880d55bc62b`.
- Running image: `sha256:9c4b8abe99d816d215152ad75405d5a0b549dbd510ddcd5a594b57d5b8321a87`.
- Previous image: `sha256:601b62bbf561c82cc369f7ff8e920320f0745b9acfb4c8872fd94e3df623879e`.
- Release branch: `release/google-auth-20261104`.
- Public health, configuration, login and registration routes returned HTTP 200.
- Public configuration reports Google OAuth configured, registration enabled,
  external email configured, media configured and recording configured.
  Configuration flags do not establish a new external media or recording acceptance.
- A live Google authorization-start request returned an accounts.google.com URL,
  the exact callback `https://meets.imon.world/api/auth/callback/google`,
  only `openid email profile` scopes, and a secure state cookie.
- The public Google button is present. **An actual Google account callback and
  authenticated new-account session had not yet been verified at this checkpoint.**

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
current database. The remote broader release remains separate on
`release/edge-transport-acme-20261103` / `194e704`; its independent witness
commissioning and wider product changes are not implied by this auth deployment.
The additional `release/google-production-20261104` / `ae03115` candidate exists
only locally; its push was blocked by workflow permissions.

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

1. Complete an actual Google account flow on the canonical site: provider
   authorization, callback, authenticated session and onboarding. Then check
   same-email linking behavior, cancellation and existing-account access.
2. Preserve the local `1b52d61` deployment documents when integrating this branch.
   They add only three historical files under `docs/reviewed-results`.
3. Push the narrow release plus these receipts and require its CI to pass.
   Review that runtime input bytes still match `a3d816f` and that no workflow or
   full-release changes entered the branch. Then update main by fast-forward.
4. Continue the full product release independently, including its witness,
   network/media, recording and recovery acceptance.

At checkpoint preparation, remote main was `8439524`; local main was
`1b52d61`. Main had not been updated. Subsequent documentation and integration
commits do not change the deployed runtime source identity above.
