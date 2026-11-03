# Edge transport and HTTPS commissioning: 3 November 2026

Status: the dedicated private transport is active, tested and enabled on both hosts. The verified CI image is downloaded on main. Canonical HTTPS and application cutover remain pending.

This is an operations checkpoint based on immutable release source `05cc907784afe09c156026cc822d3f6bf08bd4c3`. The operations-only branch updates evidence and documentation. It does not change that release, its image, application code, installed transport helpers or the live application.

## Completed

The replacement Google client credential pair was checked against the existing client, canonical origin and callback, then saved in private server staging. It is not active in the old production application. No credential values or downloaded client-secret files are included in this repository. Google policy acceptance is already recorded; a replacement client or another secret download is not needed.

The already purchased edge VPS and main application host now have a dedicated WireGuard peer pair. Inside it, only edge-originated TCP to main ports 5349, 8445 and 18080 is permitted. Both guard services were checked before either link was started. The exact two main UFW allowances were applied. Fresh evidence verified the mutual handshake, endpoints, peer /32 AllowedIPs, source-bound routes and MTU. Existing public/VPN listeners, default and unrelated routes/rules, unrelated firewall state and IP forwarding were preserved.

The separate real-host TCP and stop/restart suite passed all eight checks. Main observed the expected private source on all three permitted ports; an extra listening port and an incorrect source were denied. Stopping only the owned edge transport unit retained the guard and terminal unreachable route. Unbound clients failed closed. Restarting that unit restored all three paths with the correct source. Temporary echo processes and listeners were removed, with no cleanup errors. Main application health returned HTTP 200 and status `ok` before and after this work.

Only `imon-meets-transport.service` was enabled at boot on both hosts. The link and guard services are active, their dependencies are verified and `NoNewPrivileges` remains enabled. No reboot was performed; cold-boot acceptance remains pending.

The application and existing VPN retain their previous deployment. No new IPv4 order or paid service was created during this phase. The existing VPS includes the edge IPv4 used by this design.

## Evidence and limits

| Check | Result |
| --- | --- |
| Transport generator/lifecycle checks | 18 + 5 passed |
| Real disposable WireGuard namespace checks on edge | Second run: 14 passed; cleanup and host-network preservation passed |
| Actual two-host transport | Handshake, three approved TCP paths, denied source/port, unit stop and recovery passed |
| Actual private transport proof | 8 checks passed; temporary listeners removed |
| Transport autostart | Dedicated unit active and enabled on both hosts; cold boot not tested |
| HTTP/ACME/main bridge/witness/renewal focused checks | 51 passed |
| Native nginx syntax stage | All seven parsed; four full checks returned zero; three edge cases failed on unavailable edge IP binding |
| Native nginx state after fixture attempt | Existing nginx active; public 8443 health HTTP 200; temporary loopback ports absent |
| Integrated CI for exact release source | Run 41680113351 completed successfully, including image publication |
| CI image transfer on main | All nine assets, archive, manifest, image and source identities verified; queued job succeeded |
| Application deployment | Previous application still active; new image has not been imported or deployed |

The first namespace attempt failed during bare administrative link recovery. The kernel had removed the active private route. The reviewed recovery repeats only the exact source-bound peer route, preserving the terminal unreachable route and guard. The second attempt passed; the first receipt is retained. Live recovery uses the dedicated unit's normal stop/start.

The native nginx attempt showed that the installed binary can attempt socket binds during `-t`. Its receipt does not claim a non-listening test or operational edge acceptance. No worker cycle, service start or reload was requested; synthetic fixtures were removed. The maintained verifier requires explicit acknowledgement of test binds in an approved context. No further host nginx tests were performed after that observation.

See [transport status](../../verification/edge-transport-candidate-20261103.json), [initial live commissioning](../../verification/edge-transport-commissioning-20261103.json), [real-host TCP and autostart proof](../../verification/edge-transport-live-private-tcp-proof-20261103.json), [certificate checks](../verification/edge-certificates-20261103.json), [native nginx observation](../verification/edge-certificates-nginx-syntax-20261103.json), and [candidate image transfer](../../verification/candidate-image-transfer-20261103.json).

## Verified build and transfer

Release source: [`05cc907784afe09c156026cc822d3f6bf08bd4c3`](https://github.com/IMONsergey/imonmeets/commit/05cc907784afe09c156026cc822d3f6bf08bd4c3).

- [Successful CI run 41680113351](https://github.com/IMONsergey/imonmeets/actions/runs/41680113351).
- [Immutable candidate prerelease and nine assets](https://github.com/IMONsergey/imonmeets/releases/tag/candidate-05cc907784afe09c156026cc822d3f6bf08bd4c3).
- Image ID: `sha256:b6057fb8c0824423dc4825a439a73fb1e8e0f228e9f9dabd0fe0c20328b51ab1`.
- Archive: 110,737,913 bytes; SHA-256 `7f0202c3f1410b78fb6039b8125ffe146078f824cc78e23b92142a4cbba61b84`.
- Transfer manifest SHA-256: `55c9d4167c39c1c580da651021b58e9843468b065ced6615de1e74b5e06b0c25`.

An earlier build submitted through the mandatory main-host job queue failed because its `NoNewPrivileges` policy prevents sudo and the ordinary user cannot access Docker. No queue policy, groups or Docker socket permissions were changed. The old separate privileged controller was not used to bypass the queue.

The accepted release exports the image already built and checked by CI. Its separate publisher validates exact source/image/archive/evidence identities and refuses an existing candidate tag or release. The Git tag and release were read back and match the source above.

Main downloaded the nine public release assets through one ordinary-user job, `20261103T171305-ce4bac91c2`. The job finished successfully at `2026-11-03T17:13:14Z`, with no timeout or disk-reserve breach. The downloader checked every asset's exact size and SHA-256, then ran the exact-source transfer validator. It did not use Docker or root privileges. The downloaded image is ready for the next controlled deployment step; download acceptance does not imply Docker import, application migration or runtime acceptance.

The successful download does not resolve the queue's lack of Docker access. A resource-intensive image import still needs a reviewed path consistent with the mandatory queue and its existing restrictions. Do not infer that the archive is loaded, or repeat the failed privileged build through another launcher.

## Next action and remaining cutover work

The explicitly selected Chrome connection was unavailable at `2026-11-03T17:11:13Z`: the browser tool reported no connected originating browser instance. Restore Chrome's connection to this chat before editing the domain zone and testing real Google sign-in. The new Google secret is already privately staged; do not request another download.

No DNS changes have been made in this commissioning phase. Keep the meets A record on main during bootstrap. Prepare the four new DNS names and verify the edge HTTP challenge path, then issue the separate main and witness certificates and accept the actual protected TLS paths. The main challenge handler stays on loopback; the dedicated bridge owns the private address so shared nginx startup stays independent of the tunnel.

At the controlled application transition, use the immutable source/image above and preserve existing mail/auth credentials and quotas. Reconcile the private runtime staging into the deliberate final environment before activation. Obtain fresh backup/recovery evidence, drain active calls and recordings, retire or guard the exact legacy RTC bypass, update recording-storage CORS as well as application URLs, and prevent the old TURN renewal dispatch from competing with the new certificate writer. Preserve the existing 8443 offsite and health routes.

Independent witness authority, a freshly reviewed writer-fenced legacy baseline, migration/recovery acceptance, canonical Google login and actual external media/long-recording proof remain required. The old `9bb2dab` application cannot resume write-capable operation after deletion-authority enrollment. Registration, billing and other launch switches remain closed until their own acceptance.

Public 443, TURN protocol, PROXY v2 application behavior, cold boot, witness enrollment and commercial readiness are not accepted by the transport proof or by the CI image transfer.
