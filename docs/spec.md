# IMON Meets: product and implementation contract

Date: 2026-11-01. Owner: IMON. Status: implementation.

## Decision

Build an independent React and TypeScript product on LiveKit. Use Fastify, PostgreSQL and Better Auth. LiveKit and its SDKs are Apache-2.0; the product code remains proprietary unless the owner deliberately chooses a public license. The repository is currently public, so it must contain no secrets or private customer data.

OpenVidu Meet was a sound research candidate. Direct LiveKit integration better fits this specific empty repository, a shared 16 GB server, a custom interface and future embedding. It avoids running a second administrative application and a separate MongoDB database. Recording is an optional worker and must never pretend to work without an Egress service and object storage.

## First working release

Real email/password registration, login/logout, verification and recovery through Better Auth. Organizations with owner/admin/member roles, invitations, room creation/scheduling, guest links, device preview, real LiveKit video/audio/screenshare/chat, room closure, member management, recording integration and a useful settings page. All data comes from the backend. Empty states are honest. No fake participants, invoices, recordings, subscriptions or AI output.

Russian interface, no letter U+0451 and no em dash. Restrained light application interface with a dark call surface, warm orange accent, strong typography, keyboard and mobile support. No externally hosted fonts.

## Boundaries

Application data is always scoped to workspace membership. Guest links authorize only joining the indicated room. Browser code never receives LiveKit API secrets, SMTP credentials or object storage keys. LiveKit tokens expire after five minutes and have only the necessary room-level grants. Owner/admin or room creator may manage the room. Guests never gain room administration. Closing rooms prevents new grants and disconnects participants through the server API. Rotation invalidates future use of the old guest URL; existing client grants are not a strict revocation boundary because LiveKit can refresh connected sessions. Closure instead relies on auto_create:false and durable room deletion.

Use Better Auth for credentials and sessions. Do not implement a password hashing scheme or session format. Production requires HTTPS, strong auth/media secrets and working email. Development can explicitly permit unverified users; invitations still require verified email ownership. Any endpoint that changes state validates request origin. Rate limit authentication and guest entry. Use parameterized SQL and transactional membership/invitation changes.

Deploy in an isolated Compose project on the user's server. Existing VPN owns public TCP 443. Do not replace it or change unrelated applications. Initial application and media signaling bind loopback. Public HTTPS, DNS and TURN are a separate deployment step requiring a suitable hostname/ingress. Test real two-participant WebRTC locally before claiming calls work.

## API contract

All dates are ISO 8601, identifiers strings. Errors: `{error: {code: string, message: string}}`. JSON request bodies, same-origin cookies. API responses use camelCase. Better Auth has its own standard error envelope.

- `/api/auth/*`: Better Auth standard handlers. Email sign-up/sign-in, sign-out, get-session, request-password-reset, reset-password, send-verification-email, verify-email.
- `GET /api/config`: `{appName, registrationEnabled, emailVerificationRequired, emailConfigured, mediaConfigured, recordingConfigured}`. Configuration booleans only.
- `GET /api/health`: readiness, no secrets.
- `GET /api/me`: `{user: {id,name,email,emailVerified}, workspaces: Workspace[]}`. `Workspace = {id,name,role:'owner'|'admin'|'member',createdAt}`.
- `POST /api/workspaces` body `{name}` -> `{workspace}`; creator becomes owner atomically.
- `GET /api/workspaces/:workspaceId/overview` -> `{rooms: Room[], membersCount, recordingsCount}`.
- `GET /api/workspaces/:workspaceId/rooms` -> `{rooms}`.
- `POST /api/workspaces/:workspaceId/rooms` body `{title,description?,startsAt?: string|null,durationMinutes?,allowGuests?,maxParticipants?}` -> `{room}`.
- `PATCH /api/workspaces/:workspaceId/rooms/:roomId` optional same fields -> `{room}`. Creator/admin/owner only.
- `POST /api/workspaces/:workspaceId/rooms/:roomId/close` -> `{room}`; cannot reopen.
- `POST /api/workspaces/:workspaceId/rooms/:roomId/rotate-link` -> `{room}`.
- `Room = {id,workspaceId,slug,title,description,startsAt:string|null,durationMinutes,allowGuests,maxParticipants,status:'open'|'closed',createdBy,createdAt}`.
- `GET /api/rooms/:slug` -> `{room: {title,description,startsAt,durationMinutes,allowGuests,maxParticipants,status},canManage:boolean,workspaceId?:string,roomId?:string}`. Room visible to a member or, if guests enabled, anyone with the secret slug.
- `POST /api/rooms/:slug/join` body `{name?:string}` -> `{token,serverUrl,roomName,canManage,roomId?,workspaceId?}`. Member or anonymous allowed guest only. Require explicit display name for anonymous users. Refuse closed rooms and unconfigured media.
- `GET /api/workspaces/:workspaceId/members` -> `{members: [{id,userId,name,email,role}], invitations: [{id,email,role,expiresAt}]}`. Only owner/admin see invitation list.
- `POST /api/workspaces/:workspaceId/invitations` body `{email,role:'admin'|'member'}` -> `{invitation, inviteUrl?:string}`. Owner may invite admin; admin may invite member. Link may be shown to inviter for manual delivery but accepting always requires a verified matching email. SMTP sends when configured. Token stored as hash, seven day expiry.
- `DELETE /api/workspaces/:workspaceId/invitations/:invitationId` -> `{ok:true}`.
- `POST /api/invitations/accept` body `{token}` -> `{workspace}`. Matching verified email and atomic one-time token consumption required.
- `DELETE /api/workspaces/:workspaceId/members/:memberId` -> `{ok:true}`. Admin/owner policy, owner cannot be removed; cannot remove another admin unless owner.
- `GET /api/workspaces/:workspaceId/recordings` -> `{recordings: Recording[]}`.
- `POST /api/workspaces/:workspaceId/rooms/:roomId/recordings` -> `{recording}`. Manage permission; 503 if Egress/storage disabled. State persisted before work. Only one active recording per room.
- `POST /api/workspaces/:workspaceId/recordings/:recordingId/stop` -> `{recording}`.
- `GET /api/workspaces/:workspaceId/recordings/:recordingId/download` -> short-lived authenticated redirect to private object storage as `{url}`.
- `Recording = {id,roomId,roomTitle,status:'starting'|'active'|'ending'|'complete'|'failed',startedAt,endedAt:string|null,sizeBytes:number|null,error:string|null,canManage?:boolean}`.
- `POST /api/livekit/webhook`: raw-body signature verification; update recording states and audit events idempotently. Never trust unsigned JSON.

## Frontend routes

`/` dashboard (or redirect login), `/login`, `/register`, `/forgot-password`, `/reset-password?token=...`, `/verify-email`, `/rooms`, `/recordings`, `/team`, `/settings`, `/join/:slug`, `/invite#token=...`. Persist selected workspace only as an ID; all permissions checked server-side. Workspace creation screen if none. React client may use Better Auth client or standard documented endpoints. Fetch uses credentials. Actual SDK PreJoin + LiveKitRoom + VideoConference.

## Deferred commercial rollout

Payment provider, legal terms/privacy/recording consent text, SSO, calendar OAuth, durable transcripts, AI decisions/action items, recurring meetings, waiting room moderation, per-tenant subscription entitlements and metered invoicing. Document the backlog without selling unsupported features. Built-in hard technical ceilings are not a billing system. Publish no pricing promises until real usage measurements.

## Verification

Build and strict TypeScript. Test registration/session lifecycle, origin rejection, tenant isolation, owner/admin/member authorization, guest policy/closed rooms, invitation mismatch and replay, token grants, and signed webhook rejection. Integration tests use an isolated database. UI smoke tests cover account, workspace, room and guest join. At least two browser contexts must connect to self-hosted LiveKit and exchange media or data. Public network/TURN/Safari testing remains separate from a localhost check.
