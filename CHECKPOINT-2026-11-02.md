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
5. Recheck runtime Vercel/server env variable *names and presence only*, never reveal values. OAuth client creation and credentials require owner action; do not create or modify OAuth clients.
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
