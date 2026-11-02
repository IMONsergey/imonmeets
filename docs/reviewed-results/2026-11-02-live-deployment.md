# IMON Meets live deployment receipt

**Date:** 2026-11-02 UTC
**Public URL:** https://meets.imon.world:8443
**Target host:** imon-workstation, 94.249.186.240
**Vercel:** retained, not deleted or redeployed
**Old host:** 201.34.145.204 excluded; no changes made there.

## Live runtime identity

- Running container: imonmeets-app-1
- Running image tag: imonmeets-app:9bb2dab-preview
- Running image ID: sha256:601b62bbf561c82cc369f7ff8e920320f0745b9acfb4c8872fd94e3df623879e
- Source commit: 9bb2dab7a9356c0d75a5743e8c7f25ef7c77ab46
- Runtime state: running, Docker health healthy
- App listener: loopback 127.0.0.1:3540
- Database: existing PostgreSQL container and volume imonmeets_db-data; no volume migration/replacement.
- LiveKit, Egress, TURN, Redis, SeaweedFS and recordings storage remain on the same host and were not recreated.
- Candidate image was built once from the verified commit and deployed in-place with docker compose up -d --no-deps app. No database restore or volume operation was part of deployment.

## Public origin and TLS

- Runtime APP_URL: https://meets.imon.world:8443
- EMBED_ALLOWED_ORIGINS contains:
  - https://imon.agency
  - https://imonmeets.vercel.app
  - https://meets.imon.world:8443
- DNS A record: meets.imon.world -> 94.249.186.240, confirmed by both authoritative REG.RU nameservers and public resolver.
- Listener: existing nginx HTTPS ingress on TCP 8443. VPN listener on TCP 443 was not changed.
- Certificate: /etc/letsencrypt/live/meets-imon-world/fullchain.pem
- SAN: DNS:meets.imon.world
- Issuer: Let's Encrypt YE2
- Validity: 2026-11-02 12:01:20 UTC through 2027-01-31 12:01:19 UTC.
- certbot.timer is enabled and active.
- Dedicated Certbot deploy hook: /etc/letsencrypt/renewal-hooks/deploy/imonmeets-reload-nginx; it reloads nginx only when meets.imon.world is renewed.
- HTTP-01 dry run succeeded before issuance; real certificate issuance succeeded.

## Trusted ingress

- New vhost: /etc/nginx/conf.d/meets.imon.world.conf
- Private trusted-header include: /etc/nginx/snippets/meets-proxy-trust.conf (root:root, mode 0600).
- Vhost injects the trusted X-Imon-Proxy-Secret from the private include and overwrites forwarding headers using the TCP peer ($remote_addr), trusted host, HTTPS scheme and port 8443. Forwarded and alternate client identity header are cleared.
- The trusted include is applied inside /api/ and /embed/ locations; public root/static requests do not receive privileged proxy headers.
- Client-supplied forged X-Imon-Proxy-Secret and X-Forwarded-For were tested; /api/config still returned 200 with the trusted server-side header.
- Existing imonmeets-public.conf and imonmeets-ops-rate.conf were byte-for-byte unchanged.
- Direct app listener remains loopback-only.

## Live verification

All checks below were performed with normal certificate verification, without -k:

| Check                                             | Result                                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| GET /api/health                                   | 200, DB/media/recording configured                                                               |
| GET /api/config                                   | 200                                                                                              |
| GET /                                             | 200                                                                                              |
| /rooms, /settings, /team, /recordings             | 200 SPA fallback                                                                                 |
| /login, /register, /verify-email, /reset-password | 200 SPA fallback                                                                                 |
| /join/abcdefghijklmnop                            | 200 SPA fallback                                                                                 |
| JS/CSS/runtime assets                             | 200                                                                                              |
| Unknown /api/no-such-route                        | 404 API response, not SPA fallback                                                               |
| Anonymous /api/auth/get-session                   | 200, null session                                                                                |
| RTC HTTPS ingress                                 | TLS valid, route responds                                                                        |
| Unauthenticated WebSocket handshake to LiveKit    | 401 no permissions to access the room; this proves routing/TLS, not authenticated room/media E2E |
| Registration                                      | disabled                                                                                         |
| Google OAuth                                      | not configured                                                                                   |

The owner separately reviewed the rendered /login page visually. No external mail, registration, password reset, invitation, paid API or customer action was performed during cutover.

## Email runtime

- EMAIL_DELIVERY_MODE=external, EMAIL_PROVIDER=resend.
- Sender: no-reply@notify.imon.world.
- emailConfigured=true, emailVerificationRequired=true.
- Local Free-tier budgets: 45 global/day, 45/workspace/day, 1,000 per 30-day bucket; existing 5 per recipient/hour guard remains.
- API key is supplied from a private mode-0600 environment file outside Git. No key or token is included in this receipt.
- im_email_deliveries table exists. Row count after deployment is zero, confirming no new mail was sent.
- The previously delivered single test email was not repeated.
- Real registration/reset/invitation email delivery has not been exercised since cutover. No claim of end-to-end email delivery is made.

## Database and recordings backups

- Latest DB dump after deployment: /home/sergey/imonmeets/backups/imonmeets-20261102T132246Z.dump
- Size: 68,177 bytes, mode 0600.
- SHA-256 matches root-only /home/sergey/imonmeets/backups/latest.json.
- Backup service completed successfully at 2026-11-02 13:22:47 UTC.
- Restore drill completed successfully at 13:22:51 UTC in a disposable database; active DB was not overwritten. Restored counts:
  - workspaces: 6
  - rooms: 18
  - users: 7
  - accounts: 7
  - memberships: 6
  - invitations: 1
- The restore-check script removed the disposable database after verification.
- Earlier offsite encrypted backup worker and Mac backup monitor reported success; Vercel was not used as a backup.
- Recording manifest: /home/sergey/imonmeets/backups/recordings/manifest.json, complete=true, objects=0. Recording worker succeeds but there are no eligible real recording objects to restore. The recording recovery synthetic suite passed 15/15; this is not a real-media restore drill. Recording directory remains at /home/sergey/.local/share/imonmeets-recordings (about 2.3 MB); no files were moved or deleted.

## Rollback assets and safe rollback

Private cutover snapshot directory (all files mode 0600 unless script mode 0700):

/home/sergey/.config/imonmeets-accounts/cutover-20261102T124640Z/

Contains:

- env.before: exact deployment env before cutover, private.
- env.after-staged: private staged env after origin/image/provider changes.
- imonmeets-public.conf.before, imonmeets-ops-rate.conf.before, imonmeets-offsite.conf.before: exact prior nginx configuration.
- meets.imon.world.conf.after, meets-proxy-trust.conf.after, compose-meets-runtime.yml.after: current added route/overlay snapshots.
- app-container-inspect.before.json: old container metadata.
- old-image.txt: previous image identity.
- candidate-image.txt: deployed candidate identity.
- imonmeets-preview-cert.before.pem: prior public cert export.
- rollback-app-image.sh: executable mode-0700 app-only rollback helper.

Previous app image:

- Tag: imonmeets-app:91aae88
- Image ID: sha256:d9b156546d1c9fd23bc4d268316be66ba59d3841d63a3c25be4e9c3b8c761962

Rollback helper path:

/home/sergey/.config/imonmeets-accounts/cutover-20261102T124640Z/rollback-app-image.sh

It switches only the app container back to imonmeets-app:91aae88, retains APP_URL=https://meets.imon.world:8443, keeps registration disabled and sets mail delivery to capture (the previous image does not implement the new Resend transport). It uses --no-deps app; it does not stop/recreate PostgreSQL, LiveKit, TURN, recordings, or Redis.

Important: do not restore an old database dump as part of app rollback. The new migration added im_email_deliveries additively; old code can ignore this table. Keep current DB and all data created since cutover. Do not run docker compose down -v.

After app-only rollback, the new ingress can continue proxying to the old app because the existing trusted proxy secret is retained. Keep the new APP_URL and origin allowlist unless deliberately reverting DNS/certificate as a separate planned action.

## Vercel rollback caveat

The Vercel project/deployment was retained. Its vercel.json still serves the Vite frontend and rewrites /api/* and /embed/* to the new server's sslip.io HTTPS API ingress, adding the configured proxy secret. Therefore Vercel is a preserved frontend/deployment rollback surface, but not an independent old backend runtime: its API calls currently reach the same updated app/database on 94.249.186.240. Reverting only the Vercel deployment will not restore the old backend. A full backend rollback requires the private app-only rollback helper above (or a separately prepared backend runtime and DB).

## Outstanding

- Google OAuth client is not configured; /api/config reports googleOAuthConfigured=false. The Browser connector could not access the local Google Cloud tab because the originating browser context was unavailable. This does not block the live site. User must open this same ChatGPT conversation in the browser with the connected Browser extension enabled before local-tab automation can continue.
- Registration remains closed.
- No real email delivery scenario was sent or tested after cutover.
- Authenticated LiveKit room/WebRTC and actual media playback require a real authenticated session and are not claimed as E2E-verified.
