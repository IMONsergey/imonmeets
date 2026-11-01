# IMON Meets Implementation Plan

> Execute with subagent-driven-development and verification-before-completion. User delegated architecture and implementation; do not pause for design approval.

**Goal:** Deliver the first usable self-hosted IMON Meets release and commit it to the supplied GitHub repository.

**Architecture:** React client, Fastify API, Better Auth, PostgreSQL, LiveKit SFU, optional Egress and S3 storage.

**Tech Stack:** TypeScript, React/Vite, Node 24, PostgreSQL, Docker Compose.

**Spec:** docs/spec.md

## Global Constraints

No secrets in git. Tenant isolation on every resource. No fake product data or nonfunctional controls. Russian copy without U+0451 or em dash. Existing server applications and TCP 443 remain untouched. Integration credentials live server-side. Public release requires HTTPS/email/TURN decisions. Explicit user delegation authorizes building and pushing the new repository.

## Review Focus

Credential/session safety, invitation email ownership, role boundaries, closed-room and guest access, media JWT privileges, recording lifecycle, cross-tenant access, responsive UI and honest deployment readiness.

## Tasks

1. Foundation: repository, architecture, API contract, root workspace configuration, reproducible dependency lock.
2. Backend: authentication, migrations, workspaces/members/invitations, rooms, media integration, recordings, meaningful tests. Owner: API implementer. Files: apps/api/** only.
3. Frontend: polished complete application against the contract. Owner: frontend implementer. Files: apps/web/** only.
4. Deployment: isolated containers, environment validation, backup/restore/runbook, CI, commercial implementation backlog. Owner: root, with deployment reviewer.
5. Integration: install, strict type checks, build, real database/API tests, browser smoke and two-client media check. Fix observed defects.
6. Review: independent security/product review; fix material findings; publish verified repository and handoff with exact limitations.

## Rulings

- Independent API and client directories may be implemented in parallel under the fixed API contract. Root integrates them and owns shared files.
- Initial staging is loopback-only because existing VPN owns public HTTPS. No destructive port takeover.
- Use PostgreSQL-backed Better Auth with programmatic migrations in a separate migration command; runtime does not silently mutate schema.
