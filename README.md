# IMON Meets

Own your meeting experience: accounts, workspaces, scheduled rooms and real video meetings in a single self-hosted product.

**Status: version 0.1.0 passed local acceptance on 2026-11-01.** Registration, verified accounts, two-browser video/chat, permanent room closure and password recovery were exercised against the deployed services. The default deployment remains local to the server. Public DNS, HTTPS/WSS, TURN, external email and recording infrastructure need their own configuration and acceptance checks before customer launch. See [verification](docs/verification.md), [deployment](docs/deployment.md) and [launch roadmap](docs/roadmap.md).

![IMON Meets dashboard](docs/screenshots/dashboard-desktop.png)

[Mobile interface](docs/screenshots/dashboard-mobile.png) · [Actual two-browser test call](docs/screenshots/call-two-participants.png). The green video patterns are Chrome's synthetic camera feeds used by the automated test.

## Product

- Email/password accounts, email verification, password recovery and session management through Better Auth.
- Workspaces, owner/admin/member roles, invitations bound to verified email, member removal.
- Instant and scheduled rooms, descriptions, participant limits, guest links, link rotation and permanent room closure.
- Device preview, video/audio, screen sharing and meeting chat through LiveKit's real React components.
- Recording API, signed webhooks, persistent states and private S3 downloads when an Egress worker and storage are configured. Disabled by default; live capture/storage is a separate acceptance gate.
- Russian responsive interface, account and device settings, honest empty states.

Payment collection, subscription entitlements, persistent chat history, transcripts, AI summaries, calendar OAuth, SSO and waiting rooms are on the roadmap. The application does not claim to implement them yet.

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

Every application resource is checked against workspace membership. Guests get only a room-specific media grant. Invitation acceptance requires the matching verified address, an unexpired token and atomic one-time consumption. Mutating browser requests require the exact configured origin. Authentication is rate limited and uses HttpOnly session cookies; production requires HTTPS.

LiveKit is configured with `room.auto_create: false`. Only the API may create the media room after checking application state while holding its row lock. Closing a room persists closure, deletes its media room and retries failed deletion. This configuration is essential: self-hosted LiveKit does not automatically revoke a previously issued client token, and connected clients may receive refreshed tokens. A five-minute initial token lifetime is not a session revocation mechanism.

Recording states are reconciled using the Egress ID and exact output key. Unknown start outcomes retain their reservation for reconciliation/operator review. A signed webhook cannot arbitrarily mark another recording complete. Download links are private, authorized by workspace and expire after 60 seconds. Recording remains off until capacity, consent, storage and full lifecycle tests are complete.

## Documentation

- [Product and API contract](docs/spec.md)
- [Implementation plan](docs/implementation-plan.md)
- [Deployment, backup and recovery](docs/deployment.md)
- [Commercial launch roadmap](docs/roadmap.md)
- [Verification record](docs/verification.md)
- [Third-party components](THIRD_PARTY_NOTICES.md)

## License

The IMON application code is proprietary; see [LICENSE](LICENSE). Public visibility of this repository does not grant a redistribution license. Dependencies retain their own licenses. LiveKit and its main SDKs are Apache-2.0; React, Fastify and Better Auth use permissive licenses. Check the exact dependency inventory and notices before distributing a commercial build.
