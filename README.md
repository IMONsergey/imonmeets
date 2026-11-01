# IMON Meets

Own your meeting experience: accounts, workspaces, scheduled rooms and real video meetings in a single self-hosted product.

**Public review:** [imonmeets.vercel.app](https://imonmeets.vercel.app), with a dedicated review account. Public signup is closed while external email is being configured. See the [Vercel deployment guide](docs/vercel-review.md) for topology and access limitations.

**Status: published preview, code release [5880571](https://github.com/IMONsergey/imonmeets/commit/5880571d0f639e2a8aaeddbf8c7cfcdc749c1c8f), 2026-11-01.** [GitHub CI passed](https://github.com/IMONsergey/imonmeets/actions/runs/41307413745), Vercel production is READY, the backend migration is applied, and the public API is healthy. This release adds waiting-room admission, persistent chat, TOTP MFA, account data controls, plan enforcement, recording retention and optional payment/analysis integrations. Recording is enabled with private S3 storage and three-day retention; its full lifecycle passed isolated acceptance with real Egress and S3. The public-deployment review passed, including guest admission, two-party media, chat, calendar export and closed-room token rejection. The real recording lifecycle also passed against the published deployment: UI start/stop, private MP4, authorized full/range download, anonymous-access denial, zero remaining S3 objects and confirmed database cleanup. Public registration remains closed pending external email delivery. Payment collection, transcription and AI summaries remain disabled. Start with the [Russian product guide](docs/product-guide.ru.md) and the [release audit](docs/release-audit-2026-11-01.md) for evidence and current limits.

The latest backup, `imonmeets-20261101T124303Z.dump` for `5880571`, was automatically copied to the Mac over verified HTTPS with a matching SHA256. Private decryption confirmed the S3 recovery credentials and exact release in `.env`; temporary plaintext was removed. A real PostgreSQL restore passed for the preceding post-migration backup `122832Z`; the latest backup was not separately restored. **The current operations monitor reports a disk warning:** 9.32 GiB free at 12:43 UTC is below the unchanged 10% threshold. API, media and backup checks pass, but overall monitoring is false because of disk headroom. Recording objects are not included in the offsite database/configuration backup. AI models remain undeployed and their combined resource budget is unverified.

Final storage inspection found small Egress JSON manifests left after MP4 deletion. Release `5880571` disables new manifests and adds exact legacy-manifest cleanup with retry semantics. The repeat production recording test passed with one observed MP4, no observed manifests, zero remaining objects and confirmed database cleanup. See the release audit for the test scope and evidence.

## Product

- Email/password accounts, email verification, password recovery and session management through Better Auth; TOTP MFA with locally generated QR codes and one-use recovery codes.
- Workspaces, renaming, owner/admin/member roles, owner-controlled role changes, invitations bound to verified email, ownership transfer and guarded workspace deletion.
- Account profile and password settings, individual session revocation, sign-out of other sessions, personal data export and password-confirmed account deletion.
- Instant and scheduled rooms, descriptions, participant limits, guest links, link rotation and permanent room closure. New rooms enable a waiting room by default, with organizer admission, rejection and guest cancellation.
- Calendar export (.ics) with UTC event times, local timezone display and safe text handling.
- Independent camera/microphone preview, microphone level indication, video/audio, screen sharing, participant roster and moderator microphone muting through LiveKit's real React components.
- PostgreSQL-backed meeting chat with retry-safe sending, pagination, post-call history and retention. Messages survive a new media session after a page reload.
- Recording API, signed webhooks, persistent states, private S3 downloads, deletion and retention. Enabled on the published preview with a three-day retention limit; the real Egress/S3 lifecycle passed both isolated acceptance and repeat acceptance through the public production alias. New installations keep recording disabled by default until their own worker/storage checks pass.
- Optional private CPU transcription and local AI summaries, with explicit opt-in, bounded jobs, cancellation, retention and text export. The implementation is present; AI is currently off.
- Current plan and usage, server-enforced limits and durable payment entitlements. Optional YooKassa checkout supports manual 30-day renewal and server-verified payment status; collection stays disabled until a merchant account is configured.
- A source-distributed [embedding SDK](packages/sdk/README.md) for guest admission and persistent chat, to combine with a custom LiveKit meeting view. It is not yet published to npm.
- Russian responsive interface, account and device settings, honest empty states.

Calendar OAuth and enterprise SSO remain on the roadmap. Automatic recurring charges are not implemented; renewal is manual. Registration reopening, live payments and AI execution require their provider or worker acceptance before being advertised as available. Recording is enabled on the current preview; its published-deployment acceptance is tracked in the release audit. See the [feature and API reference](apps/api/FEATURES.md) for implemented behavior and configuration gates.

## Architecture

```mermaid
flowchart TD
  UI[React client] --> API[Fastify API]
  UI --> RTC[LiveKit media]
  API --> AUTH[Better Auth]
  AUTH --> DB[PostgreSQL]
  API --> DB
  API --> RTC
  RTC --> EG[Optional Egress]
  EG --> S3[Private object storage]
```

TypeScript monorepo: `apps/web` (React/Vite), `apps/api` (Fastify/Better Auth/PostgreSQL), `deploy` (isolated services), `tests/e2e` (browser acceptance). LiveKit manages real-time media; the application owns identities, organizations, access and product workflows. No media API secret is exposed to the browser.

## Start on a development server

Requirements: Docker Engine, Docker Compose v2, Node 24 for secret generation.

```bash
git clone https://github.com/IMONsergey/imonmeets.git
cd imonmeets
node scripts/init-env.mjs
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

On that host, open **http://localhost:3540**. Verification emails appear in the local SMTP inbox at **http://localhost:3541**. Mailpit captures mail for testing; it does not deliver messages to external recipients. The generated `.env` has private permissions and is ignored by Git.

Host port publications bind loopback. LiveKit advertises loopback and its internal Docker bridge address; the verified media path runs directly from host Chrome to the container over UDP, while signaling uses loopback. For this two-participant test, both browsers run on the server host. Forwarding only the web port from another computer is sufficient to inspect the interface, but does not forward WebRTC media. See the public networking section before sharing meeting links.

The Compose project uses its own network and persistent Postgres volume, publishes no database/Redis ports, limits resources and runs the API as a non-root user. Migrations run as a separate one-shot service before the API starts. Do not use `docker compose down -v` on a deployment containing data.

## Development

```bash
npm ci --ignore-scripts
npm run typecheck
npm run build
npm test
```

The API needs the variables documented in [apps/api/README.md](apps/api/README.md). `DATABASE_URL` is injected by Compose. For development outside Compose, supply a connection to a dedicated Postgres database and run `npm run migrate` before starting. `APP_URL=http://localhost:5173` matches the Vite frontend; the API listens on port 3540 and Vite proxies `/api`.

```bash
npm run dev:api
npm run dev:web
```

For an isolated integration run, set `TEST_DATABASE_URL`. Tests create and drop a uniquely named schema, not the application schema. The test role needs permission to create schemas in the dedicated database.

```bash
TEST_DATABASE_URL=postgres://user:password@localhost:5432/imonmeets_test npm test
```

Browser acceptance expects the built app, LiveKit and local Mailpit to be running. It creates disposable test accounts and rooms. Use a test deployment.

```bash
npx playwright install chromium
npm run test:e2e
# With an already installed Google Chrome on the server:
PLAYWRIGHT_CHANNEL=chrome npm run test:e2e
```

## Access and security decisions

Every application resource is checked against workspace membership. Guest media and chat grants are scoped to the admitted room session; waiting requests do not receive a media grant. Invitation acceptance requires the matching verified address, an unexpired token and atomic one-time consumption. Mutating browser requests require the exact configured origin. Authentication is rate limited and uses HttpOnly session cookies; production requires HTTPS.

LiveKit is configured with `room.auto_create: false`. Only the API may create the media room after checking application state while holding its row lock. Closing a room persists closure, retires its media room and retries failed deletion with a durable queue. Removing a member rotates affected room generations and guest links, so previously issued grants cannot rejoin the replacement room. This disconnects all participants in affected rooms; they need the new link. A new guest link still grants anonymous guest access when enabled. This configuration is essential: self-hosted LiveKit does not automatically revoke a previously issued client token, and connected clients may receive refreshed tokens. A five-minute initial token lifetime is not a session revocation mechanism.

Recording states are reconciled using the Egress ID and exact output key. Unknown start outcomes retain their reservation for reconciliation/operator review. A signed webhook cannot arbitrarily mark another recording complete. Download links are private, authorized by workspace and expire after 60 seconds. Recording is enabled on the current published preview. Full-cycle Egress/S3 acceptance passed both in isolation and after publication, including anonymous-access denial, zero remaining S3 objects and confirmed database cleanup. Short media load checks do not establish commercial capacity.

## Documentation

- [Russian product guide](docs/product-guide.ru.md)
- [API setup and configuration](apps/api/README.md)
- [Admission, MFA, data controls, billing and analysis API](apps/api/FEATURES.md)
- [Embedding SDK and integration boundary](packages/sdk/README.md)
- [Product and API contract](docs/spec.md)
- [Implementation plan](docs/implementation-plan.md)
- [Deployment, backup and recovery](docs/deployment.md)
- [Vercel review deployment](docs/vercel-review.md)
- [Commercial launch roadmap](docs/roadmap.md)
- [Verification record](docs/verification.md)
- [Published release audit and remaining dependencies](docs/release-audit-2026-11-01.md)
- [Earlier hardening audit](docs/audit-remediation-2026-11-01.md)
- [TURN, automated backup and operations](docs/operations.md)
- [External email activation](docs/email-activation.md)
- [Offsite backups and emergency alerts](docs/offsite-backup-and-alerts.md)
- [Recording deployment and acceptance](docs/recording-deployment.md)
- [Private recording storage](docs/recording-storage.md)
- [Third-party components](THIRD_PARTY_NOTICES.md)

## License

The IMON application code is proprietary; see [LICENSE](LICENSE). Public visibility of this repository does not grant a redistribution license. Dependencies retain their own licenses. LiveKit and its main SDKs are Apache-2.0; React, Fastify and Better Auth use permissive licenses. Check the exact dependency inventory and notices before distributing a commercial build.
