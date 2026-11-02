# IMON Meets auth continuation checkpoint

- Date: 2026-11-02 07:53 CET
- Base repository: `/home/sergey/imonmeets`
- Base HEAD: `8439524dd27f379a6cfad893a4a00cb916488455` (`main`, clean at inspection)
- Isolated worktree: `/home/sergey/imonmeets-auth-google-20261102`
- Branch: `feature/imonmeets-auth-google-20261102`
- Worktree base HEAD: same as above; no application source changes made yet.
- Worktree uses a local `node_modules` symlink excluded via `.git/info/exclude` (not a tracked change).

## Inspected

- `docs/continuation-2026-11-01.md`
- `docs/email-activation.md`
- `apps/api/src/auth.ts`
- `apps/api/src/config.ts`
- `apps/api/src/app.ts` (public config response)
- `apps/web/src/pages/Auth.tsx`
- `apps/web/src/api.ts` (Config type)
- `package.json`, `apps/api/package.json`
- `.env` key names only; values/secrets were not read or printed.

## Confirmed state

- Better Auth 1.7.14 is the existing auth system. Email/password, verification, recovery, TOTP, rate limiting and session handling already exist.
- Google social provider is not configured in `createAuth`.
- `REGISTRATION_ENABLED` and `EMAIL_DELIVERY_MODE` are configurable; production rejects capture mode with open registration.
- `docs/email-activation.md` requires external SMTP delivery, owner-controlled recipient inbox verification, SPF/DKIM/DMARC checks, then a real signup/verification/recovery/invitation E2E before opening registration.
- `.env` key names do not include SMTP credentials. No secret values were inspected.
- Existing auth UI supports email/password, verification, recovery, TOTP and sign-out. No Google action exists.
- Live disk: 290G total, 83G used, 208G free (29%). RAM: 62Gi total, 54Gi available.
- Existing app worktree has no active Comand process session. Main is clean.

## Jobs and resource coordination

- `dc138692-e482-414f-acf7-5480fda5fc5f`: reconnaissance command timed out at its 30s cap because it searched parent directories recursively. It was stopped/confirmed; do not retry that command.
- Server process snapshot showed active heavy Comand 0.8 verification: `/home/sergey/.local/bin/imon-job run 20261102T065005-d484ae6a1c`, executing `npm run verify` in `/home/sergey/Projects/comand-0.8.0`. Do not launch heavy ImonMeets builds/E2E until this job releases the single heavy slot. Do not duplicate it.
- `fb9679f5-264c-4da9-8fc7-763f59170132`: scoped docs/config inspection succeeded.
- `b70198a0-4094-4032-99f0-ed6165133765`: isolated worktree creation and UI inspection succeeded.
- `d43f9a9a-c695-4b36-b492-96f2a8f9483d`: Config/public API and API package inspection succeeded.

## Next steps

1. Read remaining relevant API/web auth code and config tests, and inspect current preview deployment behavior without changing production.
2. Add optional Google credentials/config to `loadConfig` and Better Auth `socialProviders.google`; require Google's verified email and disable implicit account linking so existing accounts cannot be silently linked. Keep explicit linking flow separate and authenticated.
3. Expose only a boolean Google-enabled flag via `/api/config`; add Google button and robust callback/cancel/error UI in `Auth.tsx` using Better Auth's existing `/api/auth` endpoint.
4. Add unit/browser tests for configured/unconfigured provider, redirect/cancel/error, closed registration, existing accounts, protected routes and logout. Do not run heavy suites until Comand heavy slot is free.
5. Recheck runtime Vercel/server env variable _names and presence only_, never reveal values. OAuth client creation and credentials require owner action; do not create or modify OAuth clients.
6. SMTP remains an external blocker. Choose a sender provider with owner approval, then configure credentials privately and DNS records from provider instructions. Do not open registration or send unapproved external mail.
7. Do not publish a new preview or alter public permissions without the required owner confirmation. Existing preview is `https://imonmeets.vercel.app`.

## Implementation update (07:47 CET)

- Added optional Google OAuth configuration (`GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`) with all-or-nothing validation; public config exposes only a boolean.
- Added Better Auth Google social provider with verified-email requirement and registration gate.
- Added explicit account-linking policy (`disableImplicitLinking`, same-email only) and UI in account security settings; no implicit merging.
- Added login/register Google entry, callback error/cancel messaging, and mock browser coverage for login/cancel/link status.
- Added API config tests for disabled, partial, and complete Google credentials.
- Added `docs/google-oauth.md` with exact callback origin/URI and private environment steps.
- First `imon-job` verification attempt `20261102T074332-2ddd2a06df` failed during web typecheck: mock request variable control-flow typing (now fixed) and missing qrcode packages in the existing base node_modules. Restored the exact lockfile versions qrcode 1.5.4 and @types/qrcode 1.5.6 into the isolated worktree only from local npm cache; no package manifests or lockfiles changed.
- Next verification must rerun the queued `scripts/verify-google-auth.sh` via imon-job; prior attempt did not reach build/tests.
- Restored the lockfile dependency dijkstrajs 1.0.3 into the isolated worktree after the second queued build identified it missing from the base node_modules. This was also restored from local npm cache; no manifest or lockfile was changed.
- The latest browser mock now also covers the mobile viewport, account_not_linked callback messaging, and the Google sign-up request when registration is enabled.

## Final implementation and verification checkpoint (2026-11-02 08:05 UTC)

- Worktree branch: feature/imonmeets-auth-google-20261102
- Base HEAD: 8439524dd27f379a6cfad893a4a00cb916488455
- Main repository /home/sergey/imonmeets was not modified. No production service, database, user, session, DNS record, OAuth client, external permission or public deployment was changed.
- Worktree source changes are still uncommitted and isolated. No secret values were read or added.

### Implemented

- Optional Google OAuth env pair, validated all-or-nothing: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET.
- Both variables are passed through compose.yml; .env.example contains blank placeholders.
- Better Auth Google provider requires a verified provider email and respects REGISTRATION_ENABLED.
- Implicit account linking is disabled; explicit linking is same-email only and requires an authenticated, email-verified IMON Meets session.
- Public /api/config exposes only googleOAuthConfigured boolean, never credentials.
- Login/register UI has Google action, loading/error states, cancel and callback error messages.
- Settings > Security shows Google link state and provides explicit link flow.
- Mock browser tests cover Google login initiation while signup is closed, Google signup request when open, cancel/error callback messaging, explicit linking, linked state and mobile viewport.
- Production capture email mode rejects a non-local SMTP host, preventing accidental external delivery while in capture mode.
- Added docs/google-oauth.md; updated docs/email-activation.md.

### Final verification

Heavy verification was submitted and completed through the existing single-slot imon-job queue:

- Job ID: 20261102T080319-3c7d6df318
- State: succeeded, exit code 0, timed out false, disk reserve not breached.
- Prettier: all selected source/docs/config files pass.
- TypeScript: API, web and E2E typecheck pass.
- Production build: web and API pass. Existing Vite warning remains: Join chunk is 693.36 kB (>500 kB); not caused by this auth change.
- API tests: 31 passed, 0 failed, 9 skipped (integration cases requiring external services/test DB).
- Web API tests: 18/18.
- SDK tests: 7/7.
- Browser tests: 3/3, including the updated mock Google auth and account-linking scenario.
- git diff --check: pass.

Earlier queued attempts 20261102T074332-2ddd2a06df, 20261102T074911-0df6e26530, 20261102T075935-7019ec45bc, and 20261102T080147-ab0e81f851 failed for recoverable test-environment/dependency or test-fixture reasons; the final successful job above includes the corrected fixtures and capture-host guard. Do not repeat those attempts.

### Runtime configuration presence only (no secret values inspected)

- APP_URL: https://imonmeets.vercel.app
- EMAIL_DELIVERY_MODE: capture
- REGISTRATION_ENABLED: false
- GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET: absent/empty
- SMTP_HOST: set and classified as local capture host
- SMTP_PORT: 1025
- SMTP_FROM: set
- SMTP_USER, SMTP_PASSWORD: absent/empty
- Current SMTP configuration is a local capture sink, not verified external delivery. The capture-host guard now enforces this.
- SPF/DKIM/DMARC for a production sender were not validated because no external sender/provider has been selected.

### Exact Google Console values

For current APP_URL=https://imonmeets.vercel.app and Better Auth basePath=/api/auth:

- Authorized JavaScript origin: https://imonmeets.vercel.app
- Authorized redirect URI: https://imonmeets.vercel.app/api/auth/callback/google

No wildcard/ephemeral preview origins. The app's post-login callbackURL is a separate same-origin route.

### Remaining owner-controlled steps

1. Create a Google OAuth Web application client and add the exact origin and redirect URI above.
2. Store GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the private API .env; never browser/Vercel-public variables or Git.
3. Choose a real SMTP provider, configure private host/port/TLS/auth/from settings and provider-issued SPF/DKIM/DMARC records.
4. Run IMON_ENV_FILE=/home/sergey/imonmeets/.env node scripts/check-mail-delivery.mjs --to YOUR_OWN_VERIFIED_MAILBOX, inspect actual receipt and authentication headers, then perform real signup, verification and recovery tests.
5. Only after successful real E2E should the owner change to EMAIL_DELIVERY_MODE=external and REGISTRATION_ENABLED=true, then restart only the API service.

The existing public URL https://imonmeets.vercel.app is unchanged and still serves the existing deployment; this branch has not been published. Real Google OAuth and external SMTP E2E remain unverified until owner-controlled setup is complete.

## Independent review follow-up: backend linking guard and OAuth protocol tests (2026-11-02 08:35 UTC)

An independent read-only review identified that the earlier Settings UI required a verified local email, but the API did not enforce the same precondition on POST /api/auth/link-social. This was a genuine defense-in-depth gap; it did not establish an account-takeover exploit because Better Auth still required an authenticated session and enforced provider-side verified email and same-email linking.

### Changes in this follow-up

- Added an API-layer guard before forwarding POST /api/auth/link-social to Better Auth.
- The server now resolves the current Better Auth session itself; missing session returns 401 AUTH_REQUIRED.
- The server rejects a local account whose session user.emailVerified is false with 403 EMAIL_NOT_VERIFIED.
- The guard runs regardless of whether the browser UI was used; direct endpoint POSTs are covered.
- Added a narrow auth injection seam to createApp so endpoint behavior can be tested with a deterministic mock auth handler without requiring a production database.
- Added negative endpoint tests for anonymous and unverified direct POSTs. Both assert the Better Auth handler is never called. Added positive endpoint test for a verified local session.
- Added a local-only mock OpenID Connect issuer test with openid/email/profile scopes. It exercises OAuth state cookie generation, callback, session issuance, state/code replay rejection, and Better Auth's disableSignUp behavior when REGISTRATION_ENABLED=false. The local mock is explicitly not a Google E2E test.
- Tied the mock provider's disableSignUp setting to loadConfig(...).registrationEnabled, rather than a hardcoded test boolean.
- Updated docs/google-oauth.md to document the server-side linking guard and accurately describe the local mock issuer tests.

### Focused test result

- Direct focused run: apps/api/test/auth-google.test.ts
- 4 tests passed, 0 failed, 0 skipped.
- Includes 2 direct endpoint-negative scenarios within one test, verified endpoint success, local OAuth state/callback/replay, and disabled-registration callback rejection.

### Full queued verification after follow-up

- imon-job ID: 20261102T083332-c1fefc5e1a
- State: succeeded, exit code 0, timeout false, disk reserve not breached.
- Prettier: passed.
- TypeScript API/web/E2E: passed.
- Production web/API build: passed. Existing Vite Join chunk warning >500 kB remains unchanged.
- API tests: 35 passed, 0 failed, 9 integration skips.
- Web API tests: 18 passed, 0 failed.
- SDK tests: 7 passed, 0 failed.
- Browser tests: 3 passed, 0 failed.
- git diff --check: passed before commit.

No production services, credentials, accounts, DNS or deployments were changed. The main repository remains unchanged. All follow-up work is committed on feature/imonmeets-auth-google-20261102. The worktree is clean; the commit has not been pushed.

## Resend HTTPS transport and deployment continuation (2026-11-02 12:10 UTC)

### Final verified code state

- Worktree: /home/sergey/imonmeets-auth-google-20261102
- Branch: feature/imonmeets-auth-google-20261102
- Base auth commit before Resend changes: c1f0ebce266eaca323d121a93d63ff2f3e448ff1
- Main repo /home/sergey/imonmeets remains at 8439524dd27f379a6cfad893a4a00cb916488455, clean and unchanged.
- Full final verification: imon-job 20261102T120333-848374854d, succeeded, exit 0, timed_out=false, diskReserveBreached=false.
- Formatting, API/web/E2E typecheck, web/API production build all passed.
- Tests: API 60/60, web 18/18, SDK 7/7, browser 3/3; total 88 passed, 0 failed, 0 skipped.
- The API run included actual PostgreSQL integration against a temporary local PostgreSQL 17 container, loopback-only port 55439, tmpfs data directory, dedicated database and randomly isolated schemas. No production DB was accessed.
- Existing Vite warning: Join bundle 693.36 kB (>500 kB); build succeeds, warning predates this change.
- Detailed receipt: docs/receipts/2026-11-02-resend-verification.md.

### Resend implementation

- Explicit EMAIL_PROVIDER=resend / EMAIL_DELIVERY_MODE=external selects HTTPS API; SMTP and local capture remain available as separate modes.
- Request and idempotency key use the same normalized recipient. Sender is trimmed consistently.
- PostgreSQL table im_email_deliveries is added via the existing migrate service. It stores only idempotency hash, recipient hash, state, provider ID, HTTP status and coarse error details; no message body or auth tokens.
- Reservation is committed before HTTP. Accepted duplicate -> no-op. Existing sending/uncertain -> unresolved error and no replay. A failed ledger reservation prevents HTTP. A failed provider-ID persistence after HTTP leaves a fail-closed unresolved record. This is explicitly not an exactly-once guarantee.
- HTTPS uses redirect rejection, no-store, platform TLS verification, 10-second timeout, no automatic retries; handles 429, 5xx/408, other 4xx and malformed success responses.
- Free budgets: 45 global/24h, 45 workspace/24h, 1,000 global/30d, existing 5 per recipient/hour. 1,000/30d ensures <=3,000 across a 31-day calendar month; 45/24h ensures <=90 in any rolling 24h. Resend config rejects larger limits. SMTP behavior retains original budget keys; 30-day cap is Resend-only.
- A private pending environment and private rollback snapshot exist under /home/sergey/.config/imonmeets-accounts/, both mode 0600. Key values are never printed. Pending config: Resend HTTPS, no-reply@notify.imon.world, registration false, 45 daily, 45 workspace daily, 1,000 per 30d. The active /home/sergey/imonmeets/.env and running deployment were not changed.
- No external mail was sent; the prior delivered test was not repeated.

### New owner-approved hosting target (not yet modified)

User approved moving the full ImonMeets project to the user's own servers while preserving Vercel for rollback. Requested public URL: https://meets.imon.world.

Reported topology to verify independently before changing:

- Main host: imon-workstation, 94.249.186.240, 64 GB class; app/API and frontend image reportedly serve on 127.0.0.1:3540.
- Existing Postgres named volume: imonmeets_db-data.
- LiveKit UDP/TCP ports: 7880/7881/7882; TURN 3478/5349.
- Recordings: /home/sergey/.local/share/imonmeets-recordings.
- Edge host: imonvpn-03, 201.34.145.204, nginx :443 already serves Apcosys/Comand/node/VPN. Preserve every existing vhost and VPN/Comand/Telegram service. Never modify port 443 on the main host; it is used by VPN.
- Mac SSH alias imon-vpn-origin through imon-vpn-relay reportedly works.
- Planned edge-only meets.imon.world vhost, DNS A record to 201.34.145.204, TLS certificate, and a separate loopback-only tunnel from edge port 13540 to main host 3540.
- Create a dedicated, least-privilege service identity for only this tunnel. Do not extend existing Comand identity.
- Do not migrate between servers. Main app/DB/media remain on main host. Preserve media URLs for now.
- Set public app origin and embed allowed origin to https://meets.imon.world; Google callback becomes https://meets.imon.world/api/auth/callback/google.
- Keep Vercel project/deployment unchanged for rollback.
- Before any production change, prove DB backup and restore in a disposable isolated DB; separately verify recordings backup/restore. Save old image and exact config privately. No down -v, no restoring over active DB.
- No DNS/firewall/production change until current backup and restore state has been proven. Keep registration false. No external emails during migration.
- Main host 443 is used by VPN; do not touch it.
- Edge must strip client-supplied forwarding/proxy-secret headers and set trusted values. Do not trust direct client headers. Use a dedicated per-route identity/token stored privately only if app ingress can safely distinguish edge from Vercel rollback. Do not broaden the Comand key.

### Google Cloud/browser blocker

- User explicitly requested use of Browser tool in this ordinary chat to open the user's local Google Cloud tab and complete the existing project OAuth client.
- Browser list_tabs failed: Browser access requires the originating browser context. Open ChatGPT in the browser with the connected extension and try again.
- RDC device inventory shows MacBook-Pro-erdc.local online, but this is not Browser tab-control capability. Do not claim that the Mac browser was controlled.
- User reported Google account session is already open in Cloud, OMNEXE Music, selected account fenomenos360@gmail.com; parent cloud console returned Site Unavailable.
- Reported project exists: name ImonMeets, project ID imonmeets, organization/parent fenomenos-org. Verify through the user's existing local Browser context when available; do not create a duplicate project/client.
- User approved OAuth web client with basic openid email profile and private server-side secret storage. Do not ask for passwords in chat. If local Browser context remains unavailable, report this exact blocker and leave the console step for the owner; never claim access.
- No Google credentials, Cloud settings or OAuth clients were created/changed during this work.

### Immediate continuation sequence

1. Verify clean commit HEAD and receipt/checkpoint after this update.
2. Verify backup inventory, latest DB backup and successful restore in disposable DB; separately verify recording copy/restore. Do not modify live volumes.
3. Inspect main host identity, current Docker containers/images/volumes, listening sockets, app health and running compose configuration without dumping secrets.
4. Inspect edge host via approved Mac SSH relay; inventory nginx vhosts/certificates/ports and active services read-only. Preserve Apcosys, Comand, node and VPN.
5. Verify DNS current record for meets.imon.world without changing it. Prepare isolated vhost/tunnel config and dedicated least-privilege identity. Apply only after backups and routing validation.
6. Keep Vercel active for rollback. Do not publish, alter Google credentials, send mail or open registration during cutover.
7. Browser Google Cloud remains blocked until Browser extension supplies an originating browser context. Do not substitute remote desktop GUI without the requested Browser capability.

## Direct new-server hosting investigation (2026-11-02 12:40 UTC)

### Ownership/scope update

The owner superseded the previously discussed edge-server route. The old edge 201.34.145.204 is excluded entirely; do not configure, modify or rely on it. The owner independently wrote the temporary DNS A record meets.imon.world -> 201.34.145.204 in REG.RU at 12:16:36 UTC and is the DNS writer for correcting it to the new main server. No DNS changes were made by this work. The current DNS lookup from the Mac still resolves 201.34.145.204.

The approved target is only the main server imon-workstation at 94.249.186.240, while Vercel remains intact for rollback. No edge host, VPN, nginx, DNS, live app environment, app container, DB volume, LiveKit, TURN or user data was changed.

### Current live server verified

- Host: imon-workstation; IPv4 94.249.186.240; IPv6 2a14:7c0:1002:1b50::.
- RAM 62 GiB, available ~54 GiB; disk 290 GB, free ~198 GB at inspection.
- Existing app: imonmeets-app-1, healthy, image imonmeets-app:91aae88, loopback 127.0.0.1:3540.
- PostgreSQL: imonmeets-db-1, volume imonmeets_db-data.
- Redis, LiveKit, TURN, Egress, SeaweedFS recording storage all running.
- Existing RTC public endpoint remains wss://imonmeets-rtc.94-249-186-240.sslip.io:8443; TURN/LiveKit media endpoints were not changed.
- Existing rollback images remain: imonmeets-app:495ce92, imonmeets-app:c42f3f1, imonmeets-app:suite-candidate, imonmeets-app:rollback-64b4419, and currently active imonmeets-app:91aae88.
- Main repo remains clean at 8439524dd27f379a6cfad893a4a00cb916488455. Auth/mail branch remains clean at 9bb2dab7a9356c0d75a5743e8c7f25ef7c77ab46.

### Backups and restore acceptance

- Latest DB dump: backups/imonmeets-20261102T120042Z.dump, 66,534 bytes; mode 0600; SHA256 verified against root-only latest.json.
- Hourly imonmeets-backup.timer active; latest service run succeeded at 12:00:42 UTC.
- Existing offsite encrypted backup worker succeeded repeatedly. Mac automatic backup monitor reported ok=true, automatic=true, backupOk=true, transport=https, database snapshot 12:00:43 UTC, fresh server health.
- An unprivileged restore-check attempt failed because backup directory is root-owned mode 0700. This was not a DB restore failure. Re-ran the existing imonmeets-restore-check.service with its existing privileged unit; it succeeded at 12:20:25 UTC.
- Actual restore into disposable DB succeeded and returned: 6 workspaces, 18 rooms, 7 users, 7 accounts, 6 memberships, 1 invitation. Disposable DB was dropped by the script. Active DB volume was not restored over or changed.
- Recording worker timer is active and last run succeeded, but the source/catalog contains zero eligible recordings. Mac status also says recording backup ok with 0 recordings. Therefore no real recording object could be restored; the synthetic OpenSSL encryption/decryption/recovery suite passed 15/15. This is a real data-availability limitation, not proof of a nonempty media restore.
- Recording files remain in /home/sergey/.local/share/imonmeets-recordings; no copy/move/delete performed.

### HTTPS ingress on the new server: observed constraints

- IPv4 TCP 443 is occupied by Docker proxy to VPN bridge 172.30.77.3:443 (amnezia-xray); xray process is live. Do not touch it.
- UDP 443 is unrelated and does not provide HTTPS.
- IPv6 exists, but IPv6-only web access is not an adequate public route for all users.
- A working IPv4 HTTPS listener already exists on 94.249.186.240:8443 via nginx. It was externally verified from the Mac with normal TLS certificate validation: existing sslip.io /api/health returned HTTP 200.
- Current cert /etc/letsencrypt/live/imonmeets-preview/fullchain.pem is valid until 2027-01-30, but SANs only cover imonmeets-api.94-249-186-240.sslip.io and imonmeets-rtc.94-249-186-240.sslip.io. It does not cover meets.imon.world.
- Existing port-80 ACME webroot is /var/lib/imonmeets-acme; current HTTP vhost only names the sslip.io API/RTC names. A new meets SAN and matching HTTP-01 vhost/server_name are required after owner DNS points to 94.249.186.240.
- Current 8443 API vhost only routes /api/, /embed/ and offsite operations; root / returns 404. A full-site vhost must proxy frontend root and all needed paths to 127.0.0.1:3540.
- Current app has ORIGIN_PROXY_SECRET set, Fastify trustProxy=false, and requires X-Imon-Proxy-Secret on API/embed paths (except health). Current 8443 API proxy does not set this header; its /api/config returns 403, while /api/health returns 200.
- Correct trusted ingress design must: store the backend proxy secret only in a root-owned private nginx include; unconditionally overwrite X-Imon-Proxy-Secret with that trusted value; overwrite X-Forwarded-For with $remote_addr (never pass client-supplied XFF); clear client-supplied alternate identity headers; set Host, Origin and X-Forwarded-Proto explicitly. Do not pass through a client-supplied proxy-secret header. Keep direct app port 3540 loopback-only.
- No nginx changes were made.

### Candidate image built without deployment

- Candidate built from clean commit 9bb2dab7a9356c0d75a5743e8c7f25ef7c77ab46.
- Tag: imonmeets-app:9bb2dab-preview
- Image ID: sha256:601b62bbf561c82cc369f7ff8e920320f0745b9acfb4c8872fd94e3df623879e
- OCI revision label matches commit.
- Docker multi-stage production build succeeded; no dependency vulnerabilities reported by npm audit.
- Existing Vite warning remains: Join chunk 693.36 kB (>500 kB).
- Candidate image is not deployed or running. Current app remains on imonmeets-app:91aae88 and healthy.
- First build through imon-job 20261102T122921-87e97acad6 failed immediately because imon-job restricted runner has no Docker socket permission. The same build was then run once through the authorized root Docker path and succeeded; no duplicate build was made.
- The temporary PostgreSQL mail-test container created for prior verification (imonmeets-mailer-test-pg) was removed. No other container was stopped.

### Direct-route decision: requires owner selection before changes

The only already-working dual-stack-independent HTTPS ingress identified on the new server is port 8443. Proposed user-facing origin, if the owner accepts the nonstandard port:

- Site: https://meets.imon.world:8443
- APP_URL=https://meets.imon.world:8443
- Embed allowed origin should include https://meets.imon.world:8443, retaining https://imon.agency and https://imonmeets.vercel.app during rollback/compatibility.
- Google authorized JavaScript origin: https://meets.imon.world:8443
- Google authorized redirect URI: https://meets.imon.world:8443/api/auth/callback/google
- Better Auth callback origin is same host and port.
- Keep REGISTRATION_ENABLED=false.
- Keep LIVEKIT_URL, LIVEKIT_INTERNAL_URL, TURN endpoints and media URL settings unchanged for initial cutover.
- Vercel deployment and its current APP_URL/config remain unchanged for rollback.
- Resend remains staged only; no email sent and no active mail transport change.

Standard https://meets.imon.world on IPv4 port 443 is unavailable without changing the VPN listener or obtaining another IPv4 address. The owner has explicitly prohibited changing VPN and excluded the old edge host. Therefore the 8443 URL needs explicit owner acceptance before any DNS-dependent cert, nginx, APP_URL or origin changes. No such changes have been made.

### Google Browser blocker

Attempt to use Browser list_tabs in this ordinary chat failed with exact error: Browser access requires the originating browser context. Open ChatGPT in the browser with the connected extension and try again. The Mac is visible as an RDC device, but RDC access is not Browser tab control. No Google Console page was accessed and no OAuth client/secret was created. Minimal user action: open this same ChatGPT conversation in the browser with the ChatGPT Browser extension connected/enabled, then ask to continue; do not send passwords or OAuth secrets in chat.

### Latest jobs

- 20261102T120333-848374854d: full mail/auth verification, succeeded, 88 passed, 0 skipped.
- 20261102T121221-a8b4df966c: unprivileged restore-check attempt, failed due to root-only backups/latest.json; superseded by successful privileged service below.
- 20261102T121838-13d1d01747: sudo inside imon-job runner failed because NoNewPrivileges prevents sudo; no restore action occurred.
- imonmeets-restore-check.service: successful privileged actual DB restore at 12:20:25 MSK; exit 0.
- 20261102T122211-f2a47bce79: synthetic recording-backup suite, succeeded, 15/15.
- 20261102T122921-87e97acad6: image build via restricted imon-job failed due missing Docker socket; one direct privileged Docker build succeeded.
- No active heavy job at checkpoint. No unresolved command was repeated.

### Next safe steps

1. Wait for owner to accept https://meets.imon.world:8443 or choose another public routing approach that does not touch VPN 443 or old edge.
2. Owner completes DNS correction; verify A record points to 94.249.186.240 before requesting ACME certificate.
3. Back up exact nginx config/cert state privately; prepare a dedicated meets TLS vhost on 8443, SAN certificate and safe proxy header injection. Preserve existing API/RTC/offsite paths and existing sslip names.
4. Validate nginx config and HTTPS using a temporary hosts override before public cutover. No production config reload until explicit cutover approval.
5. Stage private env delta and rollback; keep registration false, Resend inactive, Vercel unchanged.
6. Apply APP_URL/embed origins only after 8443 URL is accepted and the vhost passes TLS/header checks.
7. Browser OAuth setup remains blocked until the Browser extension supplies the originating browser context; then reuse existing Google Cloud project, do not create a duplicate.
