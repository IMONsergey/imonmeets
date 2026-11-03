# Deployment preflight and legacy deletion enrollment — 3 November 2026

Status: **prepared, not executed**. Preserve existing user data. No production image, database row, service, private key, DNS record or provider account was changed by this preparation.

## Exact candidate

| Item | Verified identity |
| --- | --- |
| Accepted application source | d46de552200c87c16b4d8c604170c47f113cde54 |
| Accepted application image | sha256:ec25cafb5f5be514c03bede9087c077f4d8dd26f89468c1a6e5f565267255734 |
| Accepted witness image | sha256:c94dd473816d7fbdfee9d8595c0cf6cb3b4195024ad100f8e33ef7e1b03d5077 |
| Candidate receipt SHA256 | c6742b7586fbfe4d43d4d5d8833e4c4d589e9c47fe78291347c0034a72facfff |
| Running application image | sha256:601b62bbf561c82cc369f7ff8e920320f0745b9acfb4c8872fd94e3df623879e |
| Running image revision | 9bb2dab7a9356c0d75a5743e8c7f25ef7c77ab46 |
| Running Compose project/directory | imonmeets / /home/sergey/imonmeets |

The candidate has 20 successful verification steps, including real media cancellation, actual installed-package inventory and nine real receiver-image checks. Do not repeat those gates merely to prepare deployment. Any later application-source change, including the separate REC-09 fix, requires its own exact-source/image acceptance; these identities remain the historical d46de552 candidate.

This ops branch changes only deployment manifests, their focused config regression, CI registration and the runbook/evidence. The accepted application and witness images remain unchanged. The accepted source checkout is `/home/sergey/imonmeets-audit-followup-20261103`.

**The old 9bb2dab image is not a valid write-capable rollback after deletion-authority enrollment.** It does not enforce the new journal/witness protocol. Resuming it would permit unjournaled deletions. After enrollment, keep maintenance fencing until a journal-aware application passes startup; use a separately reviewed compatible fallback or roll forward. Do not erase the binding, replace the journal or lower production-mode checks to make an old image start.

## Observed blockers and existing data

PostgreSQL observations used the existing application's role, `REPEATABLE READ READ ONLY`, a five-second statement timeout and one-second lock timeout. No row contents, emails, credentials or deletion target identifiers were printed.

| Observation | Result |
| --- | --- |
| Database/schema/role | imonmeets/public/imonmeets_app |
| Ordinary tables | 23; no foreign/materialized/RLS ambiguity in inspected schema |
| Users/workspaces/members/rooms | 7 / 6 / 6 / 18 |
| Recording/analysis rows | 2 / 0 |
| Deletion-authority binding table | Absent |
| Identity migration marker table | Absent |
| Email-verified accounts | 7 of 7 |
| MFA-enabled accounts | 0 of 7 |
| Workspace owners | 6; all email-verified; none MFA-enabled |
| Sessions affected by one-time MFA revocation | 0 at 10:25 UTC |
| Retained deletion audit events | workspace.deleted: 3; recording.deletion_requested: 2 |

Five retained audit rows do not prove a complete deletion history or completed media deletion. The populated database cannot use automatic empty-database enrollment.

A second read-only snapshot at 10:39 UTC found all three historically deleted workspace targets absent and both remaining recording rows marked deletion-requested and deleted. No recording row was starting, active or ending. Those database flags do not prove removal from every object version, cache or backup. A private review draft exists at `/home/sergey/.local/state/imonmeets-deployment-preflight-20261103/legacy-baseline-review-draft.json`, mode 0600, SHA256 `84e5168121df3d00db715c83619e91ca8ce0bf746fd9917c9e2604743bdd9e8d`. It is explicitly **DRAFT_NOT_APPROVED_NOT_FENCED**, with enrollment disabled. Its hash must not be passed as accepted baseline approval. Repeat and reconcile the snapshot at the actual writer fence.

The running app has no deletion configuration or journal mount. Presence-only inspection of the known private `.env` also found no configured `DELETION_*` or `GOOGLE_CLIENT_*` values. This is not permission to replace an authority found elsewhere during commissioning.

The private `.env` alone omits `RESEND_API_KEY`, but the existing runtime overlay supplies it: effective app configuration has `EMAIL_PROVIDER=resend`, `EMAIL_DELIVERY_MODE=external`, a nonempty `RESEND_API_KEY` and `SMTP_FROM`. Their values were not printed. Therefore this preflight does **not** establish missing mail credentials. Preserve the existing private references and verify actual sender ownership, delivery and reconciliation. Candidate `loadConfig` refuses external Resend without a key and sender, so a bare `.env` reconstruction would break startup.

The live Compose project records five overlays: `compose.yml`, `compose.public.yml`, `compose.turn.yml` and `compose.recording.yml` from `/home/sergey/imonmeets`, followed by `/etc/imonmeets/compose-meets-runtime.yml`. The final private overlay must be reviewed by the deployment operator; do not blindly carry its old image/config pinning into the candidate. Assert the fully merged **app and migrate** image identities and allowlisted effective configuration without printing secrets. Reading `.env` alone cannot establish the merged configuration.

`OFFSITE_EXPORT_ENABLED=true` exists in the private host environment. Its absence from the app container is not evidence that the exporter is disabled: it is a deployment-generator setting.

## Existing backup and monitor contour

| Existing application-host service | Fresh observation |
| --- | --- |
| Hourly database backup | Successful run at 10:01 UTC on 3 November |
| Recording backup | Successful run at 10:15 UTC |
| Health timer | Successful run at 10:17 UTC |
| Offsite exporter | Active since 2 November |
| Structural restore check | Successful run on 2 November |

The documented offsite destination is the owner's Mac, with private state at `~/.local/state/imonmeets-backup`, recipient private key and encrypted copies. Its monitor runs every five minutes while awake and logged in. This is an existing architecture, not a newly established access channel.

A fresh Mac automatic pull/decryption result, delivered incident/recovery notification and current recording-mirror proof were not observed. Local timer success cannot substitute for them. The existing exporter serves authenticated fixed backup/health/recording endpoints; its read-only token is distinct from future witness credentials.

An elevated general Python metadata read of root-owned `ops-state`/`backups` was rejected by Remote Desktop Commander. It was not retried through another privileged interpreter. This preflight therefore does not invent private manifest hashes or claim fresh independent backup success from inaccessible files.

No independent witness endpoint/authority was found in the running app or known private environment. A second IP on the existing EPYC server does not create an independent witness host.

## Minimal receiver VPS requirements; no purchase made

| Requirement | Proposed input |
| --- | --- |
| Compute | Practical initial host: 1 vCPU / 1 GiB RAM; container remains capped at 0.5 CPU / 256 MiB / 64 PIDs |
| Disk | Persistent POSIX filesystem with hard links, atomic replace, file/directory fsync and kernel flock; 10 GiB host disk is an initial allowance, not accepted backup capacity |
| Ownership | Data/private directories 0700, files 0600, container node UID 1000 |
| Concurrency | Exactly one receiver writer using the supplied image entrypoint/kernel lock |
| Network | Valid HTTPS origin on 443; receiver only on 127.0.0.1:3551 |
| Isolation | Separate host/storage failure domain; no application-host mounted disk or ephemeral serverless filesystem |
| Recovery | Preserve metadata, signed high-water anchor and every acknowledged intent together; never roll receiver storage back with the app/DB |
| Operations | Disk/capacity and pending-ACK monitoring, key recovery custody, external availability checks |
| Image transfer | Approved registry/provider workflow for the exact tested image; preserve image/source identity |

Protocol caps: 10,000 intents, 16 KiB per record and a 2 MiB signed anchor. They are finite refusal boundaries, not throughput/SLA measurements. Rotation is not implemented.

If the VPS also stores backups, size that storage from measured archive size × transfer cadence × retention plus headroom. A 512 MiB per-archive transfer ceiling and thirty-day retention do not imply ten GiB is sufficient. Existing Mac-based decryption requires its existing recipient private key; never silently replace it or claim new-host decryption without it.

A monitor colocated with the receiver shares that host's outage. This does not establish a separate 24-hour incident-delivery channel.

## Private inputs and custody

No real values are included in the repository.

| Input | Scope and action |
| --- | --- |
| Existing auth/DB/media/S3 credentials | Preserve existing private application configuration; no incidental rotation |
| Mail credential and verified sender | Preserve existing effective Resend credential/sender references; verify ownership, delivery and reconciliation |
| `DELETION_JOURNAL_HOST_DIR` | Deliberately prepared durable application-host directory outside DB backup/rollback lifecycle |
| `DELETION_JOURNAL_KEY` / `WITNESS_JOURNAL_KEY` | Same stable HMAC key held by app and trusted receiver; reuse an existing authority if found |
| `DELETION_WITNESS_TOKEN` / `WITNESS_API_TOKEN` | Dedicated private app-to-receiver credential; never reuse offsite-export token |
| Ed25519 signing private key | Receiver private directory only; approved recovery custody |
| `DELETION_WITNESS_PUBLIC_KEY` | Matching public PEM pinned by app |
| Journal UUID/canonical genesis SHA256 | Derived from exact initialized metadata, never invented or substituted |
| `DELETION_WITNESS_URL` | Actual HTTPS endpoint with valid certificate, no URL credentials or redirects |
| Baseline approval SHA256 | Hash of accepted fenced baseline evidence, not this planning document |
| Existing backup recipient private key | Preserve Mac/recovery custody; any relocation/rotation needs a concrete custody plan |

The team can prepare cryptographic parameters, permissions, unique fixtures, exact-image pinning, draft documents and nonmutating checks without a new product choice.

Actual owner inputs concern a priced VPS/order, ownership that cannot be verified, retention/custody of old backups and unresolved historical-removal facts. Existing user authorization may cover technical migration; `--approval-sha256` does not itself impose another permission conversation. An authorized operator must nevertheless review and record the concrete baseline. An arbitrary hash is not evidence, and missing history must not be invented.

## Legacy baseline procedure: preserve current data

The conservative plan adopts a new authoritative baseline of the current database and establishes an automatic-restore boundary. It does not fabricate historical deletion intents.

1. **Prepare before fencing.** Preserve and validate effective mail configuration, complete the approved independent receiver/TLS/storage setup, preserve old image/config and prepare the exact candidate environment plus corrected overlays. Validate merged app/migrate images and required paths without creating them implicitly.
2. **Inventory old backups without erasing them.** Record archive identities, times/checksums and custodians with authorized tooling. Preserve encrypted archives. Mark pre-journal/pre-baseline backups as offline-only and ineligible for automatic serving; historical recovery requires reconciliation.
3. **Review legacy removals privately.** For the three workspace deletions and two recording deletion requests, confirm deleted workspaces remain absent, recording requests reach the required physical/media/backup lifecycle state, and identify any other obligations. Audit events may be incomplete. Retain evidence and caveats.
4. **Fence every writer at a concrete maintenance boundary.** Stop new admission, safely drain calls/recordings, stop the old app and suspend relevant maintenance. Verify no old replica/job remains. Do not abruptly stop active Egress instead of finalizing capture. Record the fence and keep public serving closed.
5. **Take and verify a pre-change recovery backup.** Preserve old image/config and database recovery bundle, including existing recording credentials. Do not overwrite previous backups.
6. **Run migrations once from the accepted image.** Use the full reviewed Compose configuration and immutable image already present. Migrations create the binding table but never enroll it. Review the full schema and data effects: the one-time MFA migration revokes legacy MFA sessions/challenges (the current affected count is zero and must be rechecked at the fence); refund amount and mail-delivery status backfills update applicable rows; new legal-consent immutability triggers and moderation/identity/deletion schema are installed. It is not a purely additive no-data-change migration.
7. **Prepare the exact first authority.** Only if no prior authority/history exists, explicitly initialize an intentionally prepared empty application journal. Transfer authorized genesis and private credentials through the approved channel. Explicitly initialize the exact receiver empty volume once, then start its ordinary service. Normal restart must never use `--initialize`.
8. **Require a real fresh complete-head proof.** Verify signing key, journal/genesis identity and HTTPS; separately verify host/storage independence and persistence. An on-host signer or ephemeral filesystem is insufficient.
9. **Accept the fenced baseline record.** Include DB inventory/backup provenance, removal review, older-backup policy, writer fence, journal/genesis, receiver evidence, exact image/config hashes, reviewer and time. Hash the accepted immutable record.
10. **Enroll once.** Execute the explicit reviewed-baseline CLI against the intended current database with the prepared config and accepted evidence hash. It requires fresh independent proof, inserts the immutable binding and refuses a different authority. Same-authority idempotency is not permission to enroll an old restored snapshot as a new baseline.
11. **Take a post-enrollment backup.** Verify it contains the binding and can be decrypted/restored under the intended custody. Preserve earlier archives under the restricted policy.
12. **Exercise isolated recovery.** Restore a separately scoped `imonmeets_restore_*` database, keep the latest complete journal/receiver, migrate and replay before serving. Verify deleted resources cannot reappear and media cleanup completes. Do not rehearse against the live DB or use `pg_restore --clean` there.
13. **Start the new app behind the fence.** Journal/binding validation and replay must finish before HTTP/background work. Verify release identity, private health, account access, room authorization and required provider/media behavior.
14. **Open public traffic after acceptance.** Keep fresh release/config-bound deletion and launch-readiness evidence. Re-enable reviewed maintenance and observe failures, pending deletions and receiver capacity.

Stopping one app is not a distributed lease. Verify all writers are fenced; enrollment's database locks only make its local binding point atomic.

## Concrete operator command shapes

These commands were not run against production. They become executable only with the complete reviewed configuration and operation approval.

Resolve relative mounts deliberately against the existing production project directory. Review all five existing overlays plus the corrected deletion overlay; preserve intended routing/recording settings and current private credential references. The old private runtime overlay may override candidate image/environment fields. Replace or adapt that overlay deliberately and assert the final resolved app and migrate image/digest/revision before running either. Do not print the full resolved configuration, which contains secrets.

```sh
task_source=/home/sergey/imonmeets-audit-followup-20261103
task_ops=/home/sergey/imonmeets-deployment-preflight-20261103
task_env=/path/to/reviewed-private-candidate.env
task_evidence=/path/to/new-private-deployment-evidence
```

Private candidate identity:

```dotenv
APP_IMAGE=sha256:ec25cafb5f5be514c03bede9087c077f4d8dd26f89468c1a6e5f565267255734
RELEASE_COMMIT=d46de552200c87c16b4d8c604170c47f113cde54
RELEASE_IMAGE_DIGEST=sha256:ec25cafb5f5be514c03bede9087c077f4d8dd26f89468c1a6e5f565267255734
```

From the clean accepted source checkout, generate the manifest with its accepted build receipt:

```sh
node scripts/create-release-manifest.mjs \
  --image sha256:ec25cafb5f5be514c03bede9087c077f4d8dd26f89468c1a6e5f565267255734 \
  --env "$task_env" \
  --build-receipt /home/sergey/.local/state/imonmeets-commercial-20261103/combined-acceptance-controller-20261103/runs/candidate-d46de552200c-20261103T094925Z-4a98542e/app-image/build-receipt.json \
  --sudo-docker \
  --output "$task_evidence/release-manifest.json"
```

The runtime image contains compiled API modules but no operator `scripts/` directory. For operator CLIs mount exact accepted scripts read-only at `/app/scripts` into a one-off instance of the accepted image. `api-runtime.mjs` then resolves the image's exact compiled module. Do not rebuild/pull a mutable tag to obtain a missing script.

The following command shapes use `compose` as shorthand for the full explicitly reviewed project/env/file argument list, not a supplied executable alias:

```text
compose run --rm --no-deps -T --volume <accepted-scripts>:/app/scripts:ro app \
  node scripts/init-deletion-journal.mjs --initialize

compose run --rm --no-deps -T --volume <accepted-scripts>:/app/scripts:ro app \
  node scripts/enroll-deletion-baseline.mjs --enroll-reviewed-baseline \
  --approval-sha256 <accepted-fenced-baseline-record-sha256>
```

One-off `run` does not publish service ports unless requested; do not request them. Init/enroll are mutations and belong only at their numbered steps.

On the independent host, use the corrected standalone witness Compose file and exact transferred witness image identity. Initialization is the explicit `run --rm witness --initialize`; ordinary restart uses `up` without that argument.

After explicit migration/enrollment and gated health verification, replace only the app with `up -d --no-build --no-deps app`. Keep DB, LiveKit, recording and unrelated listener topology unchanged unless their separate plan explicitly changes them.

## Rollback decision table

| Failure point | Safe response |
| --- | --- |
| Before writer fence/migration | Leave old deployment serving; discard only unused prepared artifacts |
| After fence, before migration/binding | Preserve evidence/backups; resume unchanged old deployment after reviewing aborted operation |
| After migration, before binding/new writes | Review schema, billing/mail backfills, legal triggers and one-time auth changes before any fallback; resuming writers invalidates fenced baseline review |
| After binding or any acknowledged new deletion | Keep maintenance closed; preserve binding/journal/receiver; use reviewed journal-aware image or roll forward |
| Database restore after adoption | Restore into separate scope, verify latest independent journal and replay before serving; never roll journal/receiver backward |
| Receiver unavailable/missing history | Recover the exact complete authority/store; never replace it with an empty journal |
| Bad public route/config only | Roll back that config while retaining journal-aware app/authority; do not revert to 9bb to undo ingress |

Do not delete backups, change encryption recipients, rotate journal/signing authority, alter unrelated listener/VPN settings or buy infrastructure as incidental cleanup.

## Focused Compose fix and verification scope

The nine accepted receiver-image checks used `docker run`, not the standalone Compose renderer. Original YAML rendered:

```json
{"tmpfs":["/tmp:size=8m","mode=1777"]}
```

The second item is not an absolute mount target. Both witness binds and the app journal bind also rendered with `create_host_path:true`, contradicting deliberate existing-storage preparation.

This branch quotes the single `/tmp:size=8m,mode=1777` mount and sets long bind syntax with `create_host_path:false`. The regression executes installed Compose with synthetic inputs and `/dev/null` env-file; it never starts containers. It is also registered in CI. Targeted results and source hashes are retained in the companion receipt. Installed Compose 2.40.3 omits `create_host_path:false` from canonical JSON because false is the long-bind default; the test treats an omitted key as false. The original short syntax explicitly renders true and fails all three affected assertions. This checks actual rendered semantics rather than requiring a default key that the renderer does not emit.

Verification: four tests, three expected baseline failures, then four passing tests with no errors/skips; bounded cgroup 1 CPU / 2 GiB / 64 PIDs under the shared verification lock. The untouched private receipt SHA256 is `5d8f399059bdbcdecdd965a65164155407a67a4faf34dc485b3eff48fe42ebdc`. A sanitized copy is tracked at `docs/verification/deletion-compose-20261103.json`. Independent read-only review found no blocking defect in the manifests, regression or legacy-enrollment sequence.

This preparation does not claim a deployed release, independent-host acceptance, new paid infrastructure, complete historical reconstruction, fresh Mac offsite proof, legal approval, commercial capacity or provider delivery success.


## Source and evidence map

- `docs/deletion-database-binding.md` — existing-database enrollment and immutable authority.
- `docs/deletion-journal-and-restore.md` — startup/replay order and historical limits.
- `docs/deletion-witness.md` — durable storage, keys, complete-head proof and receiver caps.
- `scripts/enroll-deletion-baseline.mjs`, `scripts/init-deletion-journal.mjs`, `scripts/check-deletion-journal.mjs` — actual operator interfaces.
- `scripts/api-runtime.mjs`, `Dockerfile` — runtime module resolution and operator-script mount requirement.
- `apps/api/src/migrate.ts` and schema modules — schema, backfill, trigger and one-time identity effects.
- `compose.yml`, `compose.deletion.yml`, `compose.deletion-witness.yml` — exact deployment inputs.
- `docs/verification/deletion-compose-20261103.json` — focused RED-to-GREEN evidence and tested source hashes.
- `docs/verification/deployment-preflight-20261103.json` — safe live inventory/config presence and baseline-draft summary; no credential values or deletion target IDs.
