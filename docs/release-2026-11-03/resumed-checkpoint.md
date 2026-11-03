# IMON Meets resumed work — 3 November 2026

## Current state

The suspended conversation has been recovered against the actual Git repositories, provider dashboard, running services and offsite receiver. This checkpoint supersedes the previous statement that no small VPS had been purchased. It does not replace historical acceptance receipts.

| Area | Verified state |
| --- | --- |
| Public application | https://meets.imon.world:8443 |
| Deployed application revision | 9bb2dab7a9356c0d75a5743e8c7f25ef7c77ab46 |
| GitHub main | 8439524dd27f379a6cfad893a4a00cb916488455 |
| Previously accepted candidate | cfa4a1ca98abee30cedf0d4ecac89c1149d500a5 |
| Candidate application image | sha256:1e6f59040b58bb282b615380fabc6c76250209f2484b14a9a09f10ebc41326ce |
| Candidate witness image | sha256:ae3f45ca9f3eef2b127f3d59ea494fe601ef550cd8adec90bf93c3c29f20ad77 |
| Resumed integration before this documentation commit | 277edda08a210dc2cd8cc102c668adb82f249e54 |
| Actual deployment of the resumed integration | Not performed |

The cfa4a1ca controller receipt contains 21 successful stages. The receipt and all 21 output hashes were independently checked without rerunning the successful jobs. Its SHA256 is 2cfdbfa768f11690ecbdb6db7f7af9f317449cbb7780cf22c853e1c9f37a580c. Its status remains PASS_CANDIDATE_NOT_DEPLOYED, with deployed:false and commercialAcceptance:false.

The two resumed changes affect acceptance tooling and CI, not application runtime source. Their focused checks must not be described as a new full application-image acceptance.

## Code and GitHub continuity

Two reviewed changes are integrated in release/resumed-20261103:

1. Merged Compose preflight checks immutable app/migrate image identity, optional real image-inspect revision evidence, preservation of Resend configuration and limits, and the durable deletion-journal bind. It prints fixed diagnostic codes instead of private values. Original change: 933d1b0f2ebff97c683746d3d5f979fed89fd6ba; integrated change: 7b8e67d.
2. External media verification requires the exact expected TURN TLS endpoint. Port 443 is supported; 5349 requires an explicit legacy choice. It validates selected ICE pairs, nonempty peers, bidirectional traffic and received audio/video, and omits page text, raw ICE URLs and private meeting URLs from diagnostics. Original change: 8bb066aa89e4f1db54e07d505e479ae6b7206f74; integrated change: 277edda.

Focused isolated checks passed: 16 Compose preflight tests and 11 media-policy tests. Both original defects/negative cases were demonstrated before the fixes. Exact tested bytes were compared to the server copies. The combined CI file retains both new checks. The primary agent independently reran both suites against bytes matched to the merged worktree: 27/27 passed with no failures or skips; see ../verification/resumed-focused-20261103.json. No real meeting, provider message or paid API was invoked.

Existing Mac GitHub authentication was sufficient. No new deploy key or broader grant was created. These six branches were published atomically and verified through the GitHub connector:

- release/connect-ready-20261103
- release/resumed-20261103
- fix/compose-cutover-preflight-20261103
- fix/external-media-turn443-20261103
- fix/translation-quality-admission-20261103
- feature/imonmeets-translation-cpu-20261102

Main and production were not advanced. The translated-text branch is preserved separately and remains experimental.

### Additional isolated candidates

These later candidates remain on separate branches and are not integrated into release/resumed-20261103 or deployed:

| Branch | Commit | Focused evidence |
| --- | --- | --- |
| fix/google-oauth-scope-guard-20261103 | 34beb48afdc80d369d0242371e0cb2505c186cf5 | 6 pure tests and focused handler/provider verification passed |
| feature/edge-vps-ingress-20261103 | f5eb135d30c650b6a32c39a9d4c8bf124ec9ce19 | 17 pure edge-generator tests passed; runtime pending |

The primary agent independently repeated all 6 Google guard tests and all 17 edge tests successfully. These pure checks do not replace application-image or real-provider/network acceptance. The normal imon-job queue completed focused Google handler/provider job 20261103T124406-02299fe759 successfully at 2026-11-03T13:30:08.721634Z with exit code 0 and status PASS_FOCUSED_HANDLER_PROVIDER, bound to the exact 34beb48afdc80d369d0242371e0cb2505c186cf5 candidate and eight pinned source hashes. Its output SHA256 is 055b167b340bf86cb6ec25c62329cd6f1f3ed9cbf27efdad1773e1059096637f; see [the focused receipt](../verification/google-oauth-focused-20261103.json). This receipt retains productionChanges:false and externalProviderAcceptance:false.

The edge candidate prepares an external HAProxy on the already-paid VPS address, with original TLS streams forwarded through explicitly declared closed-tunnel endpoints to nginx and coturn on the primary host, plus a separate local witness TLS backend. It does not create the tunnel, select actual tunnel addresses, provide HTTP/ACME bootstrap, change DNS or start services. Real HAProxy/TLS routing, tunnel confinement and failure behavior, resource capacity and external TURN/media remain pending. Desktop Commander rejected a read-only Docker metadata command; runtime validation remains pending. The candidate does not establish that public port 443 is operational.

## Purchased witness VPS

The SKRIME account contains an active EPYC KVM Server 1G purchased on 3 November, quoted at EUR 1.49/month and expiring 3 December. Its own public IPv4 is 94.249.188.77. The transaction view contained exactly five rows; the EUR 1.49 debit on 3 November was a KVM Server Bestellung for this small VPS. No separate additional-IPv4 purchase was present.

The provider network table and the primary host's actual interfaces/routes each confirm one public IPv4 on the primary server: 94.249.186.240. The purchased VPS address is separate from that primary-server address. No new purchase was made. Evaluate the prepared edge alternative on the already-paid 94.249.188.77 before considering another IPv4 order; that alternative has not yet been accepted on a real network.

The new VPS was accessed using its existing provider-issued credential. No password was reset and no permanent SSH key was added. The temporary SSH control socket and helper on the Mac were removed after staging. The VPS remains STAGED_NOT_ENROLLED.

Actual host observations:

- Ubuntu 24.04; one virtual core, approximately 961 MiB RAM.
- Root filesystem approximately 8.7 GiB, with 6.4 GiB free before installing the runtime.
- No pre-existing Docker installation or IMON Meets service.
- Docker 29.1.3 and Compose 2.40.3 installed from the configured Ubuntu package repositories.
- Exact accepted witness image loaded without rebuilding it.
- Reviewed witness source, Dockerfile, Compose file and runbook staged under /opt/imonmeets-witness/releases/cfa4a1ca98abee30cedf0d4ecac89c1149d500a5.
- Empty durable data and private configuration directories prepared with mode 0700 and container UID 1000 ownership.

A resource-limited, network-disabled probe ran inside the exact image on this new host. It passed UID 1000 execution, file/directory fsync, atomic rename, hard links, private file mode and exclusive kernel flock. It removed only its own probe directory afterwards. The production data directory remained empty.

The host receipt at /opt/imonmeets-witness/commissioning-20261103.json is dated 2026-11-03T11:57:26.280840+00:00 and explicitly records:

- status: STAGED_NOT_ENROLLED
- storageProbe: PASS
- dataDirectoryEmpty: true
- productionConnected: false
- witnessStarted: false
- keysCreated: false
- publicListenerCreated: false

This establishes staging and filesystem capability on a separate VPS. It does not prove physical placement independence inside the provider, public TLS, enrolled authority, restart/restore acceptance or a functioning independent incident channel.

## Offsite backup receiver

The actual automatic Mac receiver was inspected. The database copy was fresh and hash-verified. A transient recording-sync failure was recorded at 11:49 UTC, but the installed error handling retained only CalledProcessError, so its historical curl/HTTP cause cannot honestly be reconstructed.

A targeted read of the existing exporter returned a fresh, complete, empty recording catalog with HTTP 200. The next ordinary scheduled cycle recovered at 2026-11-03T11:55:41.206057+00:00:

- ok:true
- backupOk:true
- recordingBackup.ok:true
- serverHealth.ok:true

No manual pull or monitor notification was triggered to obtain this recovery.

The installed recording-backup.py was still the older 350 MiB validator. It was atomically replaced with the exact already-tested cfa4a1ca helper while holding the existing pull lock and preserving the old helper for rollback, ownership and mode 0700.

Installed helper SHA256: bea6f233adb41d516b5e6d053b5f07d082831b5fdc87be0e0df2ae550d2bc07e.

Its hard per-object bound is now 512 MiB; total cache stays 1 GiB. Configuration, keys, encryption format, retention, scheduler, active pull.py and pull-recording-backup.py were unchanged. This update supports the difference between Egress's 350 MiB stop threshold and its bounded finalized output; it is not a 30-minute recording acceptance.

The latest ordinary scheduled cycle after the helper update was checked at 2026-11-03T12:06:40.612094Z, with backupCreatedAt 2026-11-03T12:00:09.627658Z:

- ok:true
- backupOk:true
- automatic:true
- recordingSyncOk:true

## Google OAuth setup

The user approved Google's policy acceptance. Create branding completed, followed by successful creation of the OAuth web client named IMON Meets Web. Its configured JavaScript origin is https://meets.imon.world and its redirect URI is https://meets.imon.world/api/auth/callback/google.

Transfer of the client's secret into the private Meets configuration has not been completed. Downloading the credential JSON could not be confirmed: the browser tool timed out during the download action, then Chrome disconnected. Two metadata-only inspections of recent files in the standard Downloads location found no matching new credential JSON. This does not establish that the browser downloaded nothing elsewhere. No client identifier or secret is recorded in this checkpoint.

Client creation and policy acceptance do not enable production Google sign-in. Focused candidate handler/provider verification has passed; credential transfer into private Meets configuration and a controlled real Google login against the final HTTPS origin remain incomplete.

## Live service and remaining commissioning gates

Fresh /api/health and /api/config responses returned HTTP 200 with database, media and recording configured. Registration, Google OAuth, billing, transcription and summary remain disabled. Existing external Resend configuration is present.

REG.RU access was restored and the actual imon.world zone was inspected read-only. The zone contains meets A 94.249.186.240; rtc, turn, recordings and witness records are absent. No DNS records were changed. meets.imon.world still resolves to the original primary address; rtc.imon.world, turn.imon.world and recordings.imon.world do not resolve. The primary TCP 443 remains occupied by the existing VPN, and it was not changed.

Next steps, in order:

1. Evaluate and runtime-validate the isolated edge candidate using the already-paid VPS IPv4 94.249.188.77 before considering any additional IPv4 purchase. Review actual tunnel addresses/routes, confinement and failure behavior, main-side TLS endpoints, witness co-location limits and the missing HTTP/ACME design. Preserve the primary server address, default route and VPN. Complete the applicable DNS/TLS work only after that review; the candidate alone does not resolve the public 443 blocker.
2. Establish the witness's intended DNS/TLS endpoint and approved durable authority/key custody. Preserve existing application credentials. Enroll only an actually reviewed writer-fenced legacy baseline; never use the earlier draft's hash as approval.
3. Render the complete candidate Compose configuration including the existing private runtime overlay and use the new static preflight before changing services.
4. Perform the controlled migration/deployment and actual independent witness/recovery acceptance. The old 9bb2dab image cannot resume write-capable operation after deletion-authority enrollment.
5. Complete the existing OAuth client credential transfer into private Meets configuration, include the reviewed isolated scope-guard candidate in the intended release and verify a controlled real Google login against the canonical final HTTPS origin and callback. Policy acceptance, client creation and focused handler/provider verification are complete; production Google sign-in remains disabled.
6. Run the updated external TURN443 audio/video/chat proof only in an authorized disposable room, followed by actual constrained-network/device checks.
7. Complete the still-missing long RoomComposite/S3 recording acceptance. Short WebEgress and padded 512 MiB crypto receipts do not prove 30 minutes of recording.
8. Resolve the remaining commercial identity/payment/legal and translation-quality/voice gates before enabling those features.

The shared workstation job policy remains one heavy job at a time with its existing limits. Focused pure tests used a separate scratch host; no extra workstation heavy worker was started.
