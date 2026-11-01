# Launch readiness evidence

`scripts/check-launch-readiness.mjs` is a read-only report of the deployment
configuration and recorded acceptance evidence. It sends no email, creates no
payment, starts no call or load test, and changes no configuration. It does not
produce acceptance evidence itself or independently verify an operator's claims.

## Run on the current server

```sh
cd /home/sergey/imonmeets
sudo -n /opt/imon-runtime/node/bin/node scripts/check-launch-readiness.mjs \
  --env /home/sergey/imonmeets/.env \
  --state-dir /home/sergey/imonmeets/ops-state
```

Node 24 is required. The operator needs read access to the private environment and
evidence files. Output contains allowlisted checks, booleans and dependency codes,
never the SMTP credentials, addresses, endpoint URLs or raw evidence. Missing,
invalid, oversized or symlinked evidence files cannot make a gate pass. Each input
file is limited to 1 MiB.

| Result                  | Meaning                                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `serviceHealthy`        | Fresh local monitor, healthy API, media signaling, local database backup and disk; no reported aggregate failure                                                                                 |
| `publicLaunchReady`     | Healthy service plus accepted public account, external media, target capacity, independent alerting and automatic offsite recovery requirements; enabled optional features must also be accepted |
| `commercialLaunchReady` | Public launch requirements plus live merchant, fiscal configuration, approved terms and payment/cancellation/receipt acceptance                                                                  |

Closed registration and intentionally disabled billing, recording or AI do not
make a healthy preview an unhealthy service. They do not imply that public or
commercial launch is ready. A TCP signaling check is not a completed media call;
a supplied worker URL is not an accepted transcription system.

**Exit status is a service-health signal, not a launch approval:**

| Exit code | Meaning                                                                                                  |
| --------- | -------------------------------------------------------------------------------------------------------- |
| `0`       | `serviceHealthy:true`, or successful `--configuration-hashes` output; inspect launch booleans separately |
| `1`       | Service-health evidence is missing, stale or failing                                                     |
| `2`       | Invalid arguments, unreadable environment file or unexpected command failure                             |

The JSON `blockers` object separates `service`, `publicLaunch` and `commercial`
dependency codes. An intentionally disabled optional capability can appear among
commercial blockers without blocking a free public service.

## Files and flags

| Flag / default file                                 | Contract                                                                                                                                            |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--env PATH`; project `.env`                        | Private deployment environment; parsed without executing shell or changing the process environment                                                  |
| `--state-dir PATH`; project `ops-state`             | Directory for the default evidence files below                                                                                                      |
| `health.json` in the state directory                | Existing local monitor result: `checkedAt`, `ok`, and `checks.api`, `checks.mediaSignaling`, `checks.backup`, `checks.disk`, each with boolean `ok` |
| `mail-delivery-check.json` in the state directory   | `nonce`, `submittedAt`, `receivedAt`, `received:true`, and the matching SMTP `configurationHash`                                                    |
| `--acceptance PATH`; state `launch-acceptance.json` | Capability acceptance blocks described below                                                                                                        |
| `--offsite PATH`; state `offsite-status.json`       | Actual external receiver status: `checkedAt`, `backupCreatedAt`, `backupOk:true`, `automatic:true`, and 64-character lowercase hex `verifiedSha256` |
| `--alerts PATH`; state `alerts-status.json`         | Current independent monitor status: `checkedAt`, `ok:true`, `independentMonitor:true`, and matching alerts `configurationHash`                      |
| `--configuration-hashes`                            | Print only current capability hashes and exit; performs no acceptance and records nothing                                                           |

The command does not fetch a Mac status file automatically. Supply a current,
authentic copy of the external receiver's status via `--offsite` or the documented
default path. The same applies to the independent monitor status. Merely writing
a successful JSON object does not constitute testing or operating those systems.

With recording enabled, the offsite status must additionally contain
`recordingBackup.ok:true`. This status must come from the successful object mirror
verification, not just the database dump transfer. See
[recording backup and recovery](recording-backup.md).

## Acceptance artifact contract

Every capability block under `launch-acceptance.json` requires:

- `acceptedAt`: timestamp of the completed acceptance, with an explicit timezone.
- `configurationHash`: the corresponding hash from the environment actually tested.
- All applicable boolean assertions in the table, set to `true` only after their
  real acceptance. Omitted or false assertions do not pass.

| Capability      | Required assertions                                                                       |
| --------------- | ----------------------------------------------------------------------------------------- |
| `smtp`          | `senderAuthenticationVerified`, `verificationFlow`, `passwordResetFlow`, `invitationFlow` |
| `media`         | `realTwoPartyCall`, `externalNetwork`, `targetCapacity`                                   |
| `alerts`        | `independentMonitor`, `incidentDelivery`, `recoveryDelivery`                              |
| `recording`     | `startStop`, `privateDownload`, `deletion`, `retention`, `restore`                        |
| `transcription` | `realRecordingProcessed`, `qualityReviewed`, `deletion`, `resourceBudget`                 |
| `summary`       | `realRecordingProcessed`, `qualityReviewed`, `deletion`, `resourceBudget`                 |
| `billing`       | `paymentVerified`, `cancellationVerified`, `receiptVerified`                              |

SMTP additionally needs the received-message artifact above: the submitted nonce
must have been found in the destination inbox, and `receivedAt` must not precede
`submittedAt`. The existing mail submission checker intentionally writes
`received:false`; SMTP queue acceptance alone never proves inbox delivery.

Media acceptance must cover the actual advertised target, external network and
configured concurrent-room/participant budget. Enabling recording changes its
hash because it changes resource demand. The gate does not assert support for
every mobile network and does not require TCP 443 unless that network capability
is separately promised and tested.

Alerts require both tested delivery of an incident and recovery, and a fresh
working independent monitor. A notification arrangement that depends on an awake
Mac and an active user session does not meet `independentMonitor`.

Billing has separate configuration gates for `BILLING_ENABLED`, a numeric
`YOOKASSA_SHOP_ID`, a configured secret, `YOOKASSA_TEST_MODE=false`, fiscal VAT
configuration and `COMMERCIAL_TERMS_APPROVED=true`. None of these flags substitutes
for a real payment, cancellation and fiscal receipt acceptance.

## Freshness and configuration matching

All timestamps require `Z` or an explicit UTC offset. Future timestamps more than
five minutes ahead are rejected. Freshness windows are:

| Evidence                                          | Maximum age  |
| ------------------------------------------------- | ------------ |
| Local health and independent monitor status       | 10 minutes   |
| Offsite check and underlying database backup      | 2 hours each |
| Capability acceptance and mail submission/receipt | 30 days      |

Get the identifiers for a tested configuration without displaying its values:

```sh
sudo -n /opt/imon-runtime/node/bin/node scripts/check-launch-readiness.mjs \
  --env /home/sergey/imonmeets/.env --configuration-hashes
```

Each hash is SHA256 of the ordered JSON pairs `[field, value-or-empty-string]`.
It identifies configuration, not proof of acceptance, and contains no password or
secret-key inputs. A relevant configuration change invalidates the old evidence.

| Capability hash            | Environment fields                                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `smtp`                     | `APP_URL`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_FROM`                                                                 |
| `media`                    | `APP_URL`, `LIVEKIT_URL`, `LIVEKIT_PUBLIC_IP`, `MAX_ACTIVE_ROOMS`, `MAX_PARTICIPANTS_PER_ROOM`, `MAX_ACTIVE_RECORDINGS`, `RECORDING_ENABLED` |
| `alerts`                   | `APP_URL`                                                                                                                                    |
| `recording`                | `APP_URL`, `LIVEKIT_URL`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `RECORDING_RETENTION_DAYS`                                                |
| `billing`                  | `APP_URL`, `YOOKASSA_SHOP_ID`, `YOOKASSA_TEST_MODE`, `YOOKASSA_VAT_CODE`, `YOOKASSA_TAX_SYSTEM_CODE`, `BILLING_PRO_PRICE_KOPECKS`            |
| `transcription`, `summary` | `APP_URL`, `ANALYSIS_WORKER_URL`                                                                                                             |

Do not commit private environment or evidence files. Record actual acceptance
results only after completing the corresponding procedure, preserving enough
private supporting evidence to review the assertions later.

## Regression verification

```sh
node --test --test-isolation=none scripts/test-launch-readiness.mjs
PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-recording-backup.py
```

The readiness tests cover missing/stale/unrelated evidence, enabled but unaccepted
features, external media/capacity and independent alert gates, secret-free output
and read-only CLI behavior. The recording suite uses synthetic fixtures and real
OpenSSL encryption/decryption; it does not use customer recordings. These suites
are CI regressions, not evidence that production provider commissioning passed.
