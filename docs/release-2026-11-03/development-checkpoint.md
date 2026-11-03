# Development checkpoint, 2026-11-03

This release branch integrates the mail, identity, rooms, moderation, payment,
recording reconciliation, model provenance, public information and ingress work.
The following final DATA changes add database authority binding and a durable
signed receiver high-water anchor. This checkpoint records implementation scope,
not production acceptance. No feature is declared commercially ready solely from
these source changes. The final verifier writes its exact source commit, results
and immutable image receipt outside the source tree so a later documentation
commit cannot silently change the identity of the tested build.

## Implemented in this candidate

- Durable mail delivery accounting, safe uncertain-send handling and reconciliation.
- Google-only password enrollment bound to verified email and current session;
  full OAuth sessions remain blocked until local MFA succeeds.
- Open-room quota, archive/restore, bounded list, office-NAT rate-limit behavior.
- Revoked participant identities, waiting admission and stale-generation handling;
  effective revocation requires signaling authorization and exclusive routing of
  signaling through the protected ingress, without a direct public bypass.
- Canonical payment/refund reconciliation with role/row locks and preserved later
  renewals; exact-generation recording reconciliation.
- Public home, about, help and not-found pages, reviewed-document publication gate,
  truthful account MFA status and mobile settings navigation.
- Separate-IPv4 standard HTTPS/WSS/TURN443 configuration preserving existing VPN
  bindings; real nginx/HAProxy routing and admission acceptance runners.
- Artifact hash provenance for analysis workers and summary launcher.
- Durable manual deletion intents, independent ACK before SQL, full replay before
  serving after restore, immutable DB journal authority, and receiver restart floor.
- Archive-bound immutable candidate build and mandatory receipt validation; release
  readiness ties evidence to exact release/configuration and refuses unknown gates.

The separate CPU translation experiment remains on its experimental branch. It is
not shipped as an accepted translation feature. Measured currency/negation errors,
streaming, listener audio and voice license/quality gates remain open.

## Deployment prerequisites and intentional behavior changes

Production startup intentionally requires a prepared persistent deletion journal,
an independently hosted receiver with verified TLS, exact enrolled genesis and
keys, and a database binding. An existing populated database cannot auto-enroll.
Use the reviewed baseline procedure in `../deletion-database-binding.md` with all
old writers stopped or fenced. Do not initialize replacement history to bypass a
restore error. Restore is offline; a checkpoint is not a distributed write lease.

Receiver storage requires explicit one-time initialization. Normal startup cannot
recreate a missing genesis or anchor. Keep its host, volume, history and operational
control independent from the application backup/restore operation. Coherent whole
volume rollback with an old valid anchor remains an operationally prohibited case,
not a failure that the same rolled-back volume can cryptographically detect.

The one-time identity migration revokes old MFA sessions and trusted devices while
preserving enrolled MFA secrets/recovery data. Verify the real owner's recovery
path and administrator access before applying that migration to production.

APP_URL, RTC, TURN, storage, TLS, OAuth and email delivery must be accepted on the
chosen canonical public names. Existing production still uses the prior image and
the :8443 website; no DNS, VPN, cloud credentials or paid resources were changed.

## Acceptance already observed before final integration

- Real LiveKit 1.13.11 signaling with two participants: 19 checks passed, including
  four ingress paths, kick/ban, old identity denial, generation rotation and API
  outage. Media establishment failed; `mediaAccepted=false` and TURN not accepted.
- Isolated actual PostgreSQL dump/restore replay of all four manual deletion types
  passed before the DB binding follow-up. The final verifier must repeat this with
  binding enabled and both explicit restore container settings.
- Prior API/web/SDK regression, browser scenarios, analysis worker Python tests,
  receiver tests and readiness/build-manifest validation passed in their documented
  scopes. Final combined source still requires its own complete verifier result.

## Remaining product and operational work

Production media/TURN, device/browser matrix, load and paid limits, private meeting
ACL decision/implementation, complete recording/retention lifecycle, physical media
cleanup, independent backup/monitor/receiver deployment, full disaster recovery,
real Google/email/payment provider acceptance, operator/legal texts and versioned
consent remain distinct gates. Full synchronous translation additionally requires
accepted streaming ASR/MT, terminology/numeric fidelity, voice provenance and rights,
TTS, listener audio behavior, quotas, cancellation and real meeting acceptance.

The task backlog retains original acceptance criteria and adds implementation
status without turning a local test pass into production readiness.

## Resumed integration and observed evidence

Desktop Commander access was restored on 2026-11-03. DATA and receiver/database
binding are now integrated. At source140dcc4, TypeScript/build, API121/121,
web19/19, SDK7/7, UI6/6 and56 receiver/release checks passed without skips,
including the actual old-dump replay and verified-TLS client/receiver test.
A disconnected tool stdout interrupted the first controller; continuation used
regular logs and did not change source to conceal a failing test.

The isolated HAProxy fixture was corrected for the non-root image under umask077;
production-generated configurations retain0600. At4a160ea all18 real routing
checks and36 backup/monitor/preparation tests passed. Production dependency audit
reported zero advisories. CI now enables the actual dump/restore scenario and
receiver/release tests instead of silently skipping the restore container path.

Strict synthetic audio/video passed over ICE/TCP in Chromium and Linux WebKit27.2
on the recorded core sources. Firefox155 did not establish media in that isolated
proxy/bridge setup. Installed-engine and failure receipts are retained. WebKit
is not a claim of Safari/macOS/iPhone acceptance; UDP/TURN remain unaccepted.

The receiver image at2daa920 passed9 actual-container checks with no public ports:
explicit initialization, immutable enrollment, non-root UID, exclusive writer
lock, signed append, restart continuity, missing intent/anchor rejection and
recovery of the retained fixture. Cleanup was verified. Its source and image
receipt are separate from proof of independent host deployment.

The account-agreement implementation frome819734 is integrated. It records exact
published document hashes only on explicit authenticated action; export/delete
and safe exit remain available. Public-commercial readiness now requires
LEGAL_ACCEPTANCE_REQUIRED=true, while closed preview defaults tofalse. Real legal
texts, guest/recording consent and deployment are still not accepted here.

The final combined commit must pass its own full verifier before app image build.
Keep final receipts outside this Git tree so recording results cannot silently
change the tested source identity.
