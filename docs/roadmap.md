# Product roadmap and commercial release gates

## Product focus

The first market is an agency or small delivery team that meets with clients. The valuable workflow is a client/project room with controlled guest access, useful meeting artifacts and clear follow-up. A generic free video room alone is not a sufficient commercial differentiator.

## Working foundation

Accounts and verified email; workspaces and roles; invitation management; instant/scheduled rooms; guest access; live video/audio/screensharing/chat; device preview; permanent room closure; optional recording integration. The product is self-hosted and does not require a paid LiveKit Cloud account.

## Public pilot

1. Assign a real application hostname and a media/TURN hostname on suitable ingress. Preserve existing services.
2. Configure external SMTP, sender identity and delivery diagnostics. Replace the local-only Mailpit delivery setting.
3. Set production mode, secure cookies, HTTPS/WSS, controlled reverse-proxy trust and registration policy.
4. Test two unrelated networks, UDP blocked/TURN fallback, mobile Safari, reconnection, permission denial, screen sharing and long meetings.
5. Set workspace/user/room/participant quotas, abuse controls, monitoring, backups, retention and incident ownership. Current numeric room limits are technical caps, not subscription enforcement.
6. Validate actual recording capacity separately. Use a dedicated Egress worker where possible and cap concurrent recordings before enabling the feature.
7. Agree on data retention, customer terms, privacy notice and explicit visible recording consent. Choose applicable jurisdictions based on actual customers and hosting.

## First paid package

Choose a single billing provider after legal entity, customer geography, settlement currency and tax requirements are known. Implement organization-level entitlements, idempotent signed payment webhooks, invoice state, cancellation/refund handling and usage counters. Never grant plans from client-submitted payment results. Prefer predictable base limits with measured media/recording overages. Do not promise unlimited recording or participants.

Track active meeting minutes, participant minutes, outbound traffic, peak rooms, TURN relay traffic, Egress minutes, storage and support load. Price from measured costs. The current code does not charge customers or fabricate subscription status.

## Differentiation after a reliable pilot

- Client and project spaces with external guest policies.
- Searchable authorized recording library with retention controls.
- Transcripts and editable meeting summaries with links to source timestamps.
- Decisions and action items assigned to real workspace members.
- Calendar integration and recurring meetings with timezone handling.
- Scoped API keys, signed outgoing webhooks and an embedding API.
- SSO, audit exports and organization administration for larger customers.

Persistent chat, collaborative documents/whiteboards and project management each add a separate product/data model. Add them when the core meeting workflow justifies their maintenance cost. Browser meeting chat is currently ephemeral.

## Acceptance standard

A feature is shipped only when its real dependency is configured, permissions are tested, failed/processing/empty states are usable, and operations can recover it. Configuration flags alone are not proof of service health. No billing, AI, recording or availability guarantee is made from a UI placeholder.
