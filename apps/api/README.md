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

## Admission, security and account administration

Run the explicit migration before deploying this release. It adds shared PostgreSQL admission counters, media generations/retirement jobs, a minimal room-access ledger and membership-revocation markers. There is no Redis dependency for application authentication limits. Both Better Auth's atomic `customStorage.consume` and API request admission use PostgreSQL counters. Application auth traffic is limited to 30 requests/minute per IP; joins to 20/minute; other API traffic to 300/minute. Better Auth's stricter endpoint rules remain in effect. Keys normalize IPv6 to a /64 and hash identifying values before storage. If admission storage is unavailable, requests fail closed with 503. Expired counters are removed by maintenance; this is a cost/abuse ceiling, not a subscription system.

SMTP admission is reserved before Better Auth enters signup's database transaction, avoiding a nested pool checkout in its email callback. Recipients have a five-message/hour budget, and all SMTP requests share a daily budget. SMTP connection/greeting/socket timeouts are 10/10/20 seconds. A delivery attempt may consume budget even if the provider fails; manual invitation links remain usable. Server-only trusted provisioning that calls Better Auth directly must establish its own controlled admission; it is not a public registration bypass.

| Variable                    | Default | Purpose                                                                                      |
| --------------------------- | ------- | -------------------------------------------------------------------------------------------- |
| `MAX_WORKSPACES_PER_USER`   | 10      | Owned workspaces per user                                                                    |
| `MAX_ROOMS_PER_WORKSPACE`   | 200     | Total rooms in a workspace, including closed rooms                                           |
| `MAX_MEMBERS_PER_WORKSPACE` | 100     | Members admitted to a workspace                                                              |
| `MAX_PENDING_INVITATIONS`   | 100     | Unexpired, unconsumed workspace invitations                                                  |
| `INVITATIONS_PER_USER_HOUR` | 20      | Invitations created by one user per hour                                                     |
| `EMAILS_PER_WORKSPACE_DAY`  | 100     | Workspace invitation delivery/admission budget per day                                       |
| `EMAILS_PER_DAY`            | 500     | Global SMTP admission budget per day                                                         |
| `MAX_ACTIVE_ROOMS`          | 20      | Actual concurrently allocated LiveKit rooms; checked under a global PostgreSQL advisory lock |
| `MAX_ACTIVE_RECORDINGS`     | 2       | Global starting/active/ending recording reservations                                         |

Workspace/room creation is additionally limited to 10/30 creations per user per hour. Resource admission and authority checks run under consistent workspace-first transaction locks. Membership removal, role edits and room management therefore cannot rely on a stale pretransaction role. Changing `maxParticipants` after a room has issued its first grant returns 409 `ROOM_CAPACITY_LOCKED`; create a new room for a different capacity. Quotas are deliberately finite and require operator adjustment or data lifecycle work at their ceiling. They do not promise unlimited usage.

### Sessions and roles

- `GET /api/sessions` returns `{sessions:[{id,createdAt,updatedAt,expiresAt,ipAddress,userAgent,current}]}` for the authenticated verified user. It never exposes session tokens.
- `DELETE /api/sessions/:id` revokes that user's other session through Better Auth. The current session returns 409; use normal sign-out for it.
- `POST /api/sessions/revoke-others` revokes all other sessions through Better Auth.
- `PATCH /api/workspaces/:workspaceId` with `{name}` permits owner/admin rename and returns `{workspace}`.
- `PATCH /api/workspaces/:workspaceId/members/:memberId` with `{role:'admin'|'member'}` permits only the owner to change a nonowner role and returns `{member}`.
- `GET /api/security-events?before=<id>` returns that user's recorded events; owner/admin `GET /api/workspaces/:workspaceId/audit?before=<id>` returns workspace events. Both return `{events,nextCursor}`, at most 100 rows. Authentication outcomes exclude credentials, URL query tokens and response cookies. A complete compliance event/retention product is not implied.

Password changes through the public auth handler force `revokeOtherSessions:true`, irrespective of the submitted optional flag. Password-reset session revocation remains enabled. This governs application sessions; it is not a claim that every logout/password change independently revokes previously issued media grants.

### Membership removal and media access reset

Removing a member deletes every pending invitation for their email. Creating a fresh invitation replaces earlier pending invitations to that address, and acceptance consumes siblings atomically. A later deliberate new invitation may restore membership.

`DELETE /api/workspaces/:workspaceId/members/:memberId` returns `{ok:true,affectedRooms,accessReset,mediaPending}`. For rooms where that user received an authenticated grant, the transaction advances a persisted media generation, rotates the guest URL and queues retirement of the old LiveKit namespace. Existing callers in those affected rooms must rejoin; guests need the newly shared link. Other rooms are unaffected. The room-access ledger and legacy join audit identify affected rooms. Old namespaces are never reused after restart. **LiveKit room auto-creation must remain disabled.**

Retirement jobs are durably leased with `FOR UPDATE SKIP LOCKED`, ordered by next attempt, processed four at a time, and retried with bounded exponential backoff. A request attempts at most one batch; background cycles process up to twelve jobs independently of Egress reconciliation. `mediaPending:true` means application revocation is persisted but external disconnection is still pending; it must not be described as completed. Room closure likewise persists first and returns 503 when its media retirement remains pending.

An authenticated removed member cannot obtain new workspace grants. This is not a permanent personal ban from a guest-enabled public room: someone with a newly shared guest URL may still join anonymously under that room policy.

### Meeting moderation and recording limits

Managers (owner/admin/room creator) can `GET /api/workspaces/:workspaceId/rooms/:roomId/participants` for `{participants:[{identity,name,isGuest,microphoneMuted,cameraEnabled,screenSharing}]}` and `PATCH /api/workspaces/:workspaceId/rooms/:roomId/participants/:identity/microphone` with `{muted:true}`. The latter mutes published microphone tracks and returns `{ok:true}`. It never remotely unmutes a microphone or claims an individual participant ban.

Recording reservation and external start are serialized against room closure and generation changes. The recorded media namespace is snapshotted, preventing callbacks for an old generation from attaching to a new call. Closed/revoked requests canceled before contacting Egress become failed; uncertain external outcomes retain their reservation for reconciliation. Both legacy and modern Egress request output formats use exact private object-key correlation. `LIMIT_REACHED` with a matching output remains downloadable as complete with a duration-limit warning; absent/mismatched output fails. This release does not invent proof of nonexistence for an unobservable Egress job: unresolved reservations still require operator investigation and must not be cleared blindly.
