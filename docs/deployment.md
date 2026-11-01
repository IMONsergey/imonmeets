# Deployment and operations

## Default: isolated local staging

The checked-in Compose file is for loopback staging on a shared Linux host. It creates only the `imonmeets` project, its network, containers and database volume. It does not install a reverse proxy, take over TCP443, open the firewall or modify another application.

| Service                   | Host access                                | Persistence / purpose                                                      |
| ------------------------- | ------------------------------------------ | -------------------------------------------------------------------------- |
| Application               | `127.0.0.1:3540`                           | Stateless API and built client                                             |
| Mailpit                   | `127.0.0.1:3541`                           | Local verification/reset/invitation email testing                          |
| LiveKit signaling         | `127.0.0.1:7880`                           | API and WebSocket signaling                                                |
| LiveKit media             | `127.0.0.1:7881/tcp`, `127.0.0.1:7882/udp` | Host-browser media tests                                                   |
| PostgreSQL                | Internal only                              | `imonmeets_db-data` volume                                                 |
| Valkey (Redis-compatible) | Internal only                              | LiveKit coordination, disposable in this single-node staging configuration |

Generate `.env` with `node scripts/init-env.mjs`; the script refuses to overwrite an existing file. Never commit it, publish `docker compose config` output, include it in source archives or paste it into support tickets. `docker compose config --quiet` validates without displaying resolved credentials.

The database bootstrap administrator and the application login have separate random passwords. The API receives only `imonmeets_app` credentials. The application role owns its tables and can create schemas in its dedicated database, but cannot create roles/databases or become a superuser. `deploy/init-db.sh` runs only when the volume is first initialized. Changing its text does not migrate existing roles.

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps
curl --fail http://localhost:3540/api/health
```

Health verifies database/schema access; configuration flags do not prove that media, email or recording actually works. For service startup errors inspect only this project: `docker compose logs --tail 100 app livekit migrate`. Avoid publishing logs containing personal data.

## Public deployment without disturbing existing services

The current shared host already uses its public HTTPS port for another service. The default Compose deployment intentionally leaves it untouched. For a reliable public launch use either an additional public IP or a dedicated application/media edge host with available TCP443. Changing the unrelated service's port is not part of this project.

1. Choose application and media hostnames, configure DNS and trusted certificates.
2. Publish the API/client through HTTPS and LiveKit signaling through WSS with WebSocket forwarding. Set `APP_URL=https://...`, `LIVEKIT_URL=wss://...`, `APP_ENV=production`. Keep `LIVEKIT_INTERNAL_URL` private.
3. Replace `deploy/livekit.local.yaml` with the network-specific configuration. Advertise a reachable media address, publish the required media ports and configure TURN for restrictive networks. A hostname and HTTP proxy alone do not carry UDP media.
4. Retain `room.auto_create: false`. Only the application API may create rooms. Verify direct cached-token rejection after room deletion against the deployed LiveKit version.
5. Configure a real SMTP service with the correct sender. Mailpit is a local test inbox. Keep verification required and verify signup/recovery/invite delivery end to end.
6. Configure only the real trusted ingress CIDR/hop for Fastify and strip untrusted forwarding headers at ingress. Current `trustProxy:false` is appropriate for direct local requests; a proxy would otherwise make users share its rate-limit bucket. Do not enable blanket proxy trust.
7. Confirm secure cookies, redirect origins, request size/rate limits, readiness monitoring, disk capacity and backups.

Use the [official ports guide](https://docs.livekit.io/transport/self-hosting/ports-firewall/) and [deployment guide](https://docs.livekit.io/transport/self-hosting/deployment/) to design the exact media/TURN topology. Avoid blindly applying a sample that binds existing ports. For production the host UDP receive-buffer limit also needs review; the staging deployment does not change host-wide kernel settings.

### Remote inspection

SSH forwarding the app and Mailpit ports lets an operator inspect the interface and test account flows from a laptop. It does not establish a complete remote video path. Media testing uses separate headless Chrome contexts on the host with synthetic devices. With `rtc.advertise_internal_ip: true`, the verified media path uses the Docker bridge address over UDP; signaling stays on the loopback publication. This validates media integration, not real mobile hardware or external network behavior.

## Recording

`RECORDING_ENABLED=false` is the default. Recording requires a separate Egress worker, the same LiveKit Valkey/Redis-compatible coordination service, a media route reachable from the worker, a private S3-compatible bucket and matching server-side credentials. The included deployment has no Egress worker. A worker needs its own verified internal signaling/media route; the host-browser test does not establish Egress reachability.

Start from the [official Egress deployment documentation](https://docs.livekit.io/transport/self-hosting/egress/). The researched compatible release is `livekit/egress:v1.15.0`; pin and record its digest when deployed. Egress is resource intensive. A dedicated worker is preferable on this shared host; measure capacity and enforce a global recording admission limit before enabling recordings for customers. The current API prevents parallel active recordings in the same room, which is not a fleet-wide resource budget.

Configure LiveKit signed webhooks to `POST /api/livekit/webhook` using a known API key. The receiver requires the original raw body and validates its signature. Keep S3 storage private. Use short-lived download URLs from the application, not public object ACLs. The API returns `{url}` for authorized downloads; links expire after 60 seconds.

Verify start, active, stop, complete, failed, restart, duplicate/out-of-order webhook, worker outage and download authorization. An ambiguous start remains reserved until reconciled. If an RPC never reached the worker, automatic proof may be unavailable; review the Egress jobs, output key and bucket before manually repairing that recording row. Do not clear reservations blindly or free a slot while a job may still capture media.

## Backups and restore

```bash
bash scripts/backup.sh
```

The script writes a custom-format `pg_dump`, restricts local permissions and validates its catalog. Copy backups to an encrypted off-host destination with a defined retention policy. A backup on the same disk is not disaster recovery. Record media/object-store retention separately. Store encrypted secrets/config backups separately from source and data backups.

Restore first into an isolated database/Compose project. Inspect the dump before applying it:

```bash
docker compose exec -T db pg_restore --list < backups/FILE.dump
```

Run the provided restore drill against a real dump:

```bash
bash scripts/restore-check.sh backups/FILE.dump
```

It creates a uniquely named disposable database, restores with `--exit-on-error`, reads workspace/room counts and drops the temporary database on exit. It does not overwrite the application database. This drill passed on 2026-11-01; see [verification](verification.md).

For a real recovery, create a new empty target database, restore using the bootstrap administrator and check role ownership, migrations, login, room authorization and recording references. `pg_restore --clean` and volume deletion are destructive and must not be part of routine application startup. Test an actual recovery periodically; catalog inspection alone is not a successful restore drill.

## Upgrade and rollback

Take a database backup, review schema changes and pin the target commit/image. Build a new image and run migrations once, then replace the application service. Keep the prior image and commit available. Application rollback does not undo a schema migration; restore/reverse migration needs its own reviewed procedure. Do not run destructive schema changes automatically.

## Observability and capacity

Monitor registration/login failures, email delivery, database pool wait time, media connection success, reconnect rate, room/participant counts, RTP packet loss, TURN utilization, outbound bandwidth, Egress state, storage and disk. The current health endpoint is intentionally minimal. Load-test expected meeting sizes and concurrent rooms before choosing commercial limits. Resource caps in Compose protect the shared host, but are not a throughput guarantee.
