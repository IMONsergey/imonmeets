# Operations: TURN, backups and recovery

This runbook describes the supplied configuration and scripts. It does not establish that a component has passed acceptance. The release verification record is the authority for executed checks. At this revision, encrypted local backup and disposable database restore have been verified. A manually transferred encrypted copy was decrypted and checksum-verified on the Mac on 2026-11-01; automatic off-host pulling is still being investigated. One successful manual copy does not establish continuing disaster recovery protection.

## Shared-host boundaries

The existing VPN keeps public TCP 443. IMON uses native Nginx on TCP 8443 for upstream API/WSS, port 80 for ACME challenges, and direct LiveKit media on TCP 7881/UDP 7882. PostgreSQL, Valkey and the captured-email inbox remain private. See [the Vercel topology](vercel-review.md).

The optional relay binds only `LIVEKIT_PUBLIC_IP`, with UDP 3478, TLS/TCP 5349 and UDP relay allocations 49160–49259. Plain TCP 3478 and TCP relay endpoints are disabled. Peer restrictions allow only the configured SFU public IP. Firewall rules must account for the relay range and replies; inspect the actual listeners and packet path before acceptance. The TURN container uses host networking, so Compose `ports` is not its exposure boundary.

**TLS on 5349 does not solve networks that allow only TCP 443.** A separate suitable address/edge is needed for that case; do not move or replace the VPN. Acceptance needs a real client with UDP blocked and a nominated relay candidate carrying media. A TLS handshake alone is insufficient. Refer to the [LiveKit ports guide](https://docs.livekit.io/transport/self-hosting/ports-firewall/) and [coturn configuration](https://github.com/coturn/coturn/blob/4.18.0/examples/etc/turnserver.conf).

## Enable the optional relay

Use an existing private server `.env`, outside version control. Non-secret settings are:

```dotenv
APP_ENV=production
APP_URL=https://imonmeets.vercel.app
COMPOSE_FILE=compose.yml:compose.public.yml:compose.turn.yml
LIVEKIT_PUBLIC_IP=YOUR_SERVER_IPV4
PUBLIC_API_HOST=YOUR_API_HOSTNAME
PUBLIC_MEDIA_HOST=YOUR_MEDIA_HOSTNAME
TLS_CERT_NAME=imonmeets-preview
LIVEKIT_URL=wss://YOUR_MEDIA_HOSTNAME:8443
TURN_UID=1000
TURN_GID=1000
REGISTRATION_ENABLED=false
EMAIL_DELIVERY_MODE=capture
RECORDING_ENABLED=false
DEV_ALLOW_UNVERIFIED_EMAIL=false
```

Supply a random `TURN_SHARED_SECRET` of at least 32 base64url characters privately. This is shared only between LiveKit and coturn. The browser receives temporary relay credentials, not the shared secret. Choose positive UID/GID values deliberately; the generator assigns ownership to those IDs, matching both containers. The operator running certificate generation needs access to the Let's Encrypt private key, normally through root. Never print the resolved Compose configuration or private generated files.

From the deployment checkout, after the valid API/media certificate and base public config exist:

```bash
node --env-file=.env scripts/prepare-public.mjs
sudo node --env-file=.env scripts/prepare-turn.mjs
docker compose config --quiet
docker compose up -d --build livekit turn
```

If UFW is already the host's firewall, add these narrowly scoped rules with the actual public IPv4 before testing an external client. Do not reset the firewall or change existing service rules:

```bash
sudo ufw allow in proto tcp to YOUR_SERVER_IPV4 port 5349 comment 'IMON Meets TURN TLS'
sudo ufw allow in proto udp to YOUR_SERVER_IPV4 port 3478 comment 'IMON Meets TURN UDP'
sudo ufw allow in proto udp to YOUR_SERVER_IPV4 port 49160:49259 comment 'IMON Meets TURN relay'
```

Direct media also needs the existing TCP 7881 and UDP 7882 rules. An operator using a provider firewall or another host firewall must apply equivalent scoped rules there. Local TLS success does not prove that packets can reach the listener from the internet.

`deploy/turn-private/` contains the copied certificate key, coturn secret and LiveKit relay settings. Its directory is `0700`; files are `0600`. It is excluded from Git and Docker build contexts. The TURN image copies the pinned upstream binary without its file capabilities so it can run on unprivileged ports with all capabilities dropped. The override selects its private LiveKit configuration automatically.

Installing the operations hooks below enables certificate refresh. The TURN hook checks the selected certificate lineage, regenerates matching TLS material and restarts only the relay service. This restart interrupts current relay allocations; check reconnection behavior. For secret rotation, regenerate the full TURN configuration and update both services together; certificate-only regeneration is not a secret-rotation procedure.

## Local operations timers

The host needs Docker Compose, Node 24, Python 3, OpenSSL, `flock`, systemd, Nginx and Certbot. Install from the final deployment path; generated units contain that absolute path.

```bash
sudo python3 scripts/install-ops.py
systemctl list-timers 'imonmeets-*'
sudo systemctl start imonmeets-backup.service
sudo systemctl start imonmeets-health.service
sudo systemctl start imonmeets-restore-check.service
```

| Job     | Schedule                              | What success establishes                                                                                               |
| ------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Backup  | Hourly, with up to 120 seconds jitter | Local custom-format database dump and readable dump catalog; encrypted bundle too, when a recipient certificate exists |
| Health  | Every two minutes                     | API/database readiness, local TCP signaling socket, local dump freshness/size and available disk                       |
| Restore | Sunday 04:00, host timezone           | Latest dump checksum, restore into a new disposable database, basic table reads and cleanup                            |

Inspect `systemctl status imonmeets-backup.service imonmeets-health.service imonmeets-restore-check.service` and `ops-state/health.json`. Health does not establish media connectivity, TURN allocation, email delivery or off-host backup success. These timers do not themselves send incident alerts. A failed service or stale status needs an operator or an existing monitoring system to act on it. Restore has a 30-minute timeout; other jobs have five minutes.

`scripts/backup.sh` keeps seven days locally by default. To change this, set `BACKUP_RETENTION_DAYS` in the backup service environment using a systemd override, between 2 and 365. Adding it only to Compose `.env` does not export it to the Python retention process. Backups consume the shared host's disk; watch both absolute free space and growth.

## Encrypted off-host copies on the operator's Mac

Keep the receiving directory outside the repository and restrict it to the operator. It needs Python 3 and an OpenSSL executable that supports `cms`. Copy the pull script into that private directory. Its configuration and key files are resolved relative to the script, not the current shell directory.

| Receiver file              | Purpose                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| `pull-encrypted-backup.py` | The supplied receiver script                                                             |
| `connection.json`          | SSH destination, for example `{"destination":"backup-user@SERVER_HOSTNAME"}`             |
| `id_ed25519`               | Dedicated private SSH key authorized only for the backup export                          |
| `known_hosts`              | Independently verified server host key; strict checking is enabled                       |
| `recipient.key`            | Private CMS decryption key; retain on the Mac and in a separate secure recovery location |
| `recipient.pem`            | Corresponding public X.509 recipient certificate                                         |

The private directory should be `0700` and configuration/private keys `0600`. **Only the public recipient certificate** is installed on the server at `/etc/imonmeets/backup-recipient.pem`. The server does not need the decryption key. SSH export must use a dedicated restricted key/forced command that returns only the completed encrypted backup. It must not grant a general shell, forwarding or plaintext `.env`/dump access. This repository's pull script expects the remote command `backup`; provisioning and verifying that restricted export is a separate operator step, currently pending acceptance.

The server encrypts the database dump, its checksum manifest and recovery `.env` using OpenSSL CMS before exporting the archive. Run the receiver from its private installation:

```bash
python3 /ABSOLUTE/PRIVATE/DIRECTORY/pull-encrypted-backup.py
```

Each SSH fetch and OpenSSL decryption has a 300-second timeout. Verification uses a temporary plaintext file created with `0600`; it is deleted on normal completion and handled errors. It is not a memory-only operation, and forced termination/power loss may leave a `.verify-*` file to remove after confirming no receiver is active. Keep the Mac's storage protected accordingly.

Successful verification requires matching dump SHA-256 and size, a nonempty recovery configuration, and a timezone-aware creation timestamp no older than **two hours**, with at most **five minutes** of future clock skew. The receiver retains encrypted copies for 30 days. Failure writes `ok:false`, retains the previous successful filename and exits nonzero. Check both `status.json` freshness and `backupCreatedAt`; an old status file does not prove the receiver still runs. Schedule the receiver explicitly with the operator's existing scheduler; the Linux installer does not install a Mac launch agent. A sleeping/offline Mac cannot fetch backups.

The receiver checks archive integrity; it does not restore PostgreSQL. Periodically decrypt a selected copy into a private isolated recovery directory, inspect its manifest, recreate required database roles/configuration, and perform a disposable restore plus login/authorization checks. Never extract over the live deployment or replace its database as a routine test. See [deployment and recovery](deployment.md#backups-and-restore).

Offline source validation, requiring no server or credentials:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-pull-encrypted-backup.py
```

## Customer-launch switches

Keep registration closed while email is captured privately. Before enabling it, configure real external SMTP, set `EMAIL_DELIVERY_MODE=external`, and verify actual verification, recovery and invitation delivery. A configured SMTP hostname is not proof of delivery.

Keep recording off until a real Egress worker, private object storage, participant notification/consent, retention and full lifecycle acceptance exist. `MAX_ACTIVE_RECORDINGS` defaults to 2 and is an application-wide admission cap; it is not a measured capacity guarantee. Load-test the shared host and recording worker before choosing a customer limit. TURN on 5349, additional interface features and encrypted backup scripts do not remove the remaining acceptance gates in the [roadmap](roadmap.md).
