# Edge transport and HTTPS commissioning — 3 November 2026

Status: transport active with mutual handshake; canonical application cutover pending.

## Completed

The replacement Google client credential pair was checked against the existing client, canonical origin and callback, then saved in private server staging. It is not active in the old production application. No credential values or client-secret downloads are included in this repository.

The purchased edge VPS and the main application host now have a dedicated WireGuard peer pair. Only edge-originated TCP to main ports 5349, 8445 and 18080 is permitted inside it. Both guard services were checked before either link was started. The exact two main UFW allowances were applied; fresh evidence verified the mutual handshake, peer endpoints, /32 AllowedIPs, source-bound routes and MTU. Existing public/VPN listeners, default and unrelated routes/rules, unrelated firewall state and IP forwarding were preserved. Main application health returned HTTP 200 before and after activation. Boot enablement, live TCP/failure acceptance and public 443 are separate gates.

The application and existing VPN continue using their previous deployment. No new IPv4 order or paid service was created in this phase. The existing VPS includes the edge IPv4 used by this design.

## Evidence and limits

| Check | Result |
| --- | --- |
| Transport generator/lifecycle checks | 18 + 5 passed |
| Real disposable WireGuard namespace checks on edge | 14 passed, cleanup and host-network preservation passed |
| Actual two-host activation | Guard/link/handshake verified; live service-path confinement pending |
| HTTP/ACME/main bridge/witness/renewal focused checks | 51 passed |
| Native nginx syntax stage | All seven parsed; four full checks returned zero; three edge cases failed on unavailable edge IP binding |
| Native nginx service state after fixture attempt | Existing nginx active; public 8443 health HTTP 200; temporary loopback ports absent |
| CI image transfer refusal checks | 10 passed offline; real export and publication require this branch's successful CI |

The first namespace attempt failed during bare administrative link recovery. The kernel had removed the active private route. The reviewed recovery repeats only the exact source-bound peer route, keeping the terminal unreachable route and guard. The second attempt records the route state and passes; the first receipt is retained.

The native nginx attempt showed that the installed binary can attempt socket binds during `-t`. Its receipt does not claim a non-listening check or operational edge acceptance. No worker cycle, service start or reload was requested; synthetic fixtures were removed. The maintained verifier now requires explicit acknowledgement of test binds in an approved context.

See [transport evidence](../../verification/edge-transport-candidate-20261103.json), [live activation summary](../../verification/edge-transport-commissioning-20261103.json), [certificate checks](../verification/edge-certificates-20261103.json), and [native nginx observation](../verification/edge-certificates-nginx-syntax-20261103.json).

## Exact build path

Published application source f2cb148179ec7b8680056c95d942c10c85c7dfbb previously passed [CI 41663253741](https://github.com/IMONsergey/imonmeets/actions/runs/41663253741). Its small evidence artifact is not a deployable image.

A later build submitted through the mandatory main-host job queue failed because its NoNewPrivileges policy prevents sudo, while the ordinary user cannot access Docker. No queue policy, groups or Docker socket permissions were changed, and the old separate privileged controller was not used to bypass the queue.

This integration adds a bounded export of the image already built and checked by CI. Only a successful push to the exact release/edge-transport-acme-20261103 branch can publish a new candidate prerelease. The publisher is a separate job, downloads the exact artifact ID, runs its validator from a fresh exact-source checkout, compares image/source/archive/evidence identities and refuses an existing tag or release. It does not deploy, migrate, import credentials or enable features. See [candidate image transfer](../candidate-image-transfer.md).

## Remaining cutover work

Chrome disconnected during commissioning, so no DNS changes were attempted. Restore the explicitly selected browser connection before editing the domain zone or testing real Google sign-in.

Keep the meets A record on main during bootstrap. Prepare the four new DNS names and verify the edge HTTP challenge path, then issue the separate main and witness certificates and accept the actual protected TLS paths. The main challenge handler stays on loopback; the dedicated bridge owns the private address, preserving shared nginx startup independence.

At the controlled application transition, preserve existing mail/auth credentials and quotas; combine the final private runtime environment deliberately. Drain active calls/recordings, retire or guard the exact legacy RTC bypass, update recording-storage CORS as well as the application URL, and prevent the old TURN renewal dispatch from competing with the new certificate writer. Preserve the existing 8443 offsite/health routes.

Independent witness authority, reviewed writer-fenced legacy baseline, migration/recovery acceptance, canonical Google login and actual external media/long recording proof remain required. The old 9bb2dab application cannot resume write-capable operation after deletion-authority enrollment. Registration, billing and other launch switches remain closed until their own acceptance.
