# IMON Meets implementation ledger

2026-11-01: Empty public repository confirmed. Local isolated branch feat/platform-foundation initialized. Remote device imon-workstation inspected read-only. Node 24 and Docker available. Public 443 is occupied by VPN; application deployment must remain isolated.

Ruling: React + Fastify + Better Auth + PostgreSQL + direct LiveKit selected for this repository and shared server. See spec.md.

Ruling: User explicitly delegated choices and requested implementation in this repository. No design-approval stop. Existing services are out of scope.

Completed: foundation, API and frontend implementation, isolated deployment, focused independent review and local acceptance. Version 0.1.0 is ready for source publication; public networking and customer-launch work remain in the roadmap.

## Interface scan

| Tasks            | Shared contract                              | Decision                                                    |
| ---------------- | -------------------------------------------- | ----------------------------------------------------------- |
| Foundation/API   | npm workspaces and scripts                   | Root owns lockfile; API owns apps/api only                  |
| Foundation/Web   | build paths and package scripts              | Root owns root package; Web owns apps/web only              |
| API/Web          | JSON types, auth and route contract          | docs/spec.md is authority; changes coordinated through root |
| API/Deployment   | env, Postgres migrations, internal media URL | Deployment uses actual exported config names                |
| Web/Deployment   | browser media URL and API origin             | Same-origin API; separate loopback WebSocket media endpoint |
| Verification/All | actual source and service behavior           | No completion claims before execution                       |
| Foundation       | spec and plan agree                          | No implementation approval pause after explicit delegation  |
| API              | tests cover permission and media boundaries  | Cross-tenant/guest/closed room checks required              |
| Web              | actual backend and real UI states            | No seeded demo metrics                                      |
| Deployment       | shared host and public443 conflict           | Isolated project and loopback bindings                      |
| Review           | verify fixed implementation                  | Independent final review and focused fixes                  |

Ruling: self-hosted LiveKit refreshes existing client JWTs; a five-minute initial JWT expiry does not guarantee revocation. Set room.auto_create=false, explicitly create open rooms under a DB row lock, close durably and retry media deletion. Verify that cached tokens cannot recreate deleted rooms.

## Executed acceptance

- Strict types for application and tests, production build and dependency audit passed (0 known production-dependency vulnerabilities reported).
- Real PostgreSQL integration and unit tests: 6 passed, none skipped. Includes tenant/role boundaries, invitations, concurrent joins and signed recording webhooks.
- Real browser acceptance: 2 passed. Verified signup, workspace/room creation, two-participant synthetic audio/video, chat, durable close/cached-token rejection and password recovery with old-session invalidation.
- Local media uses loopback signaling and direct host-to-container UDP via an advertised Docker bridge candidate. No public ingress was added.
- Backup restored into a new disposable database successfully; temporary database removed afterward.
- Recording remains disabled pending a real Egress worker, private storage, capacity limits and complete lifecycle acceptance.

See verification.md for exact scope and remaining checks. Screenshots show synthetic test accounts, not seeded production activity.
