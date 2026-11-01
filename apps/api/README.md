# IMON Meets API

Node 24, TypeScript, Fastify, PostgreSQL, Better Auth and LiveKit. Run from the repository root:

```sh
npm install
npm run migrate --workspace @imonmeets/api
npm run dev --workspace @imonmeets/api
npm run build --workspace @imonmeets/api
npm start --workspace @imonmeets/api
```

`dist/server.js` is the production entry point. Migration is a separate explicit command; the runtime never creates tables. The migration takes a PostgreSQL advisory lock and applies Better Auth programmatic migrations followed by the application schema. PostgreSQL permissions must allow schema changes for the migration role. Use a restricted runtime database role after deployment if desired.

The API binds `127.0.0.1:3540` by default. The web development server should proxy `/api` to that address; production serves `apps/web/dist` from the API when built. `APP_URL` is the browser origin and trusted Better Auth base URL, never the API's internal address. All state-changing browser requests require an exact matching Origin header. LiveKit webhook is exempt from browser origin checks and instead requires the LiveKit signed Authorization header against the exact raw body. Responses deny framing and use a no-referrer policy.

## Required configuration

| Variable                     | Meaning                                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`               | PostgreSQL connection URL, required                                                                                                                                |
| `BETTER_AUTH_SECRET`         | Random secret with at least 32 characters, required except explicit local dev mode                                                                                 |
| `ORIGIN_PROXY_SECRET`        | Optional secret of at least 32 characters for the authenticated Vercel proxy; required on all API routes except health when configured                             |
| `APP_URL`                    | Canonical browser origin; default `http://localhost:5173`; HTTPS required in production                                                                            |
| `NODE_ENV`                   | Set `production` in deployment                                                                                                                                     |
| `HOST`                       | Listener address, default `127.0.0.1`; container may use `0.0.0.0` behind loopback publishing                                                                      |
| `PORT`                       | Listener TCP port, default `3540`                                                                                                                                  |
| `DEV_ALLOW_UNVERIFIED_EMAIL` | Explicit `true` permits local sign-in and workspace access without verified mail; ignored in production. Does **not** waive verification for invitation acceptance |
| `REGISTRATION_ENABLED`       | Set `false` to disable new email/password registrations; default enabled                                                                                           |
| `EMAIL_DELIVERY_MODE`        | `capture` (default) for a private test inbox such as Mailpit, or `external` for an actual external mail provider                                                   |

Production requires HTTPS, a strong auth secret, and SMTP transport. Production capture mode also requires `REGISTRATION_ENABLED=false`; it is for a dedicated review account, not public registration. Email verification remains required in both production modes. Random media secret of at least 32 characters and WSS are checked when media is configured. Do not use sample credentials in production. No secrets belong in git or browser environment variables.

## Vercel same-origin proxy

Set `APP_URL` to one stable HTTPS frontend alias. Browser requests remain relative to `/api`; rewrite the full `/api/*` path to the backend over TLS. Preserve Origin, Cookie and all Set-Cookie headers, and retain `Cache-Control: no-store`. Existing Secure, HttpOnly, SameSite=Lax, host-only cookies work with this topology. Preview deployments on other origins must use their own isolated backend or the canonical frontend URL; do not trust every `*.vercel.app` origin.

When `ORIGIN_PROXY_SECRET` is configured, Vercel must overwrite `x-imon-proxy-secret` on outgoing API rewrites with the matching server-only environment secret. The API compares it with a timing-safe comparison. Requests without a matching secret return 403, including signed LiveKit webhooks that bypass Vercel; configure the LiveKit webhook URL through the canonical frontend rewrite. `/api/health` remains public for the internal Docker probe and exposes only readiness/configuration booleans. Never expose Mailpit or the database through these routes.

Only after authenticating this secret does the API accept a single valid IPv4/IPv6 address from `x-forwarded-for`, which Vercel documents as overwritten with the visitor IP on external rewrites. Lists, ports, zone identifiers, malformed/missing addresses and alternative IP headers fall back to the socket peer. Fastify `trustProxy` stays false. Both API rate limits and Better Auth's overwritten private `x-imon-client-ip` header use the same helper. Without the configured proxy secret all forwarding headers are ignored. See the official [Vercel rewrite guide](https://vercel.com/docs/routing/rewrites#restricting-your-origin-to-vercel-traffic) for the environment-backed request-header transform; keep the secret out of browser variables, logs and source control.

## Email

`SMTP_HOST`, `SMTP_FROM` enable mail transport. `SMTP_PORT` defaults to 587. `SMTP_SECURE=true` enables implicit TLS (usually port 465). `SMTP_USER` and `SMTP_PASSWORD` enable SMTP authentication. In production external mode, port 587/nonimplicit TLS transport requires STARTTLS and rejects a server that cannot upgrade. Nodemailer uses normal certificate validation. Password reset and verification are Better Auth standard flows, not application-owned credentials/session code. Local development without SMTP returns 503 for requests to send recovery or verification messages. Production sign-up requires email verification. No reset links or verification tokens are logged.

`GET /api/config` includes `emailDelivery: 'capture' | 'external'`; `emailConfigured` continues to mean only that SMTP transport settings exist. Capture mode means messages remain in an operator-only test inbox, and must never be presented as delivered to an external recipient. A review account must be verified through the normal Better Auth verification link from its dedicated capture mailbox; there is no bypass, administrative login, custom session or database verification shortcut. Production capture closes registration. External mode requires an actual sender/provider configuration and end-to-end delivery verification before enabling public registration. Invitation responses provide the existing manual `inviteUrl`; they never claim external delivery.

Workspace invitations store only a SHA-256 digest of a cryptographically random token, expire in seven days, and consume once transactionally after authenticated verified email ownership matches. `inviteUrl` is returned to the authorized inviter for manual delivery, with the token in the URL fragment. SMTP delivery is attempted when available; a delivery failure does not invalidate the manually usable link. Owners invite admins/members; admins invite members. Owners cannot be removed; admins cannot remove admins.

## Media

`LIVEKIT_URL` is the browser WebSocket endpoint. `LIVEKIT_INTERNAL_URL` optionally selects the API server's HTTP endpoint; otherwise derived from `LIVEKIT_URL`. `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` stay on the server. All three main media variables are necessary to enable calls. Without them joining returns a clear 503.

Room names use the opaque room database identifier. A join holds a PostgreSQL room lock through policy validation, explicit LiveKit room creation (including the participant ceiling), and issuance of a token with a five-minute initial TTL. Grants allow joining/publishing/subscribing/data in that single room, with no room administration or creation. A guest's response omits workspace and management identifiers. Authenticated cross-workspace guests only get the guest permissions of the secret room link.

**Self-hosted LiveKit must disable room auto-creation.** Closing persists `closed` before requesting LiveKit deletion; the shared room lock prevents concurrent joins recreating the room. Failed disconnections return 503 while the closed state stays durable. A background reconciler retries pending closed-room deletion every 30 seconds and at startup, including after process restart. Calling close again also retries. A five-minute initial JWT expiry is not a guarantee of participant revocation because LiveKit refreshes connected client tokens. Explicit room creation and disabled auto-creation provide the closure boundary. Rotation removes the old secret URL immediately for future grants, but already issued tokens and existing connections remain valid according to LiveKit semantics.

## Optional recordings

Set `RECORDING_ENABLED=true` only after an actual LiveKit Egress worker and private S3 compatible storage are ready. Required storage settings: `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. Optional `S3_ENDPOINT` and `S3_FORCE_PATH_STYLE=true` support self-hosted compatible storage. The API only declares recording configured when all required variables and media exist; configuration flags do not prove Egress worker health. Egress and API must both reach the configured storage endpoint.

Start reserves a `starting` record before the external call, with a database partial unique constraint preventing multiple active recordings in one room. Uncertain starts retain their `starting` reservation, blocking duplicate jobs until a signed webhook or Egress reconciliation resolves the outcome; stop transitions to `ending`; signed Egress webhooks finalize status and file size. The LiveKit webhook must be configured as `APP_URL/api/livekit/webhook` with the matching API key. Raw signed events are deduplicated by event ID, and late nonterminal events never resurrect terminal records. Object keys stay server-side. Downloads return **`{url}`**, an authenticated URL signed for 60 seconds, only after completed status. The bucket must be private. The resulting URL is a bearer capability valid for that short interval.

Recording and webhook state is durable. An external RPC timing out after Egress accepted the work is an operational uncertainty. The reconciler queries Egress every 30 seconds and associates known jobs; a reservation with no provable matching job remains blocked for operator review, rather than freeing the slot and risking duplicate recording. Inspect the Egress worker before clearing such a reservation. There is no external billing, AI, transcription or mock recording data.

## Verification

```sh
npm run typecheck --workspace @imonmeets/api
npm test --workspace @imonmeets/api
TEST_DATABASE_URL=postgres://... npm test --workspace @imonmeets/api
```

Integration tests create and drop a randomly named isolated PostgreSQL schema and use Better Auth migrations, real credentials, actual session cookies and application routes. The supplied test database role must create schemas. They cover registration/session lifecycle, strict Origin rejection, cross-tenant room access, role boundaries, invitation email mismatch/unverified ownership/replay, owner protection, link rotation, closed rooms, guest display names and five-minute JWT room grants. LiveKit room RPCs are stubbed in this API test; unsigned webhooks are rejected using the real verifier. Real two-browser media checks are a separate deployment acceptance gate. Tests are skipped explicitly when `TEST_DATABASE_URL` is absent; this is not a claim of database verification.
