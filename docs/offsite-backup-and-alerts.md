# Automatic offsite backup and incident notifications

The Mac can pull the existing encrypted database recovery bundle over HTTPS. This
uses the API host's existing TLS listener on port 8443 and does not alter SSH,
the VPN listener on 443, or any unrelated service. The SSH transport is retained
for installations where it is available.

## What is transferred

The server exposes only the latest completed `imonmeets-*.dump.enc` archive. The
bundle is encrypted by `backup.sh` for the public certificate already installed
on the server. The private decryption key stays on the Mac. It contains the
PostgreSQL dump, its checksum/size/time manifest and the application's `.env`.
When present, `deploy/recording-private/credentials.json` is also included in
this encrypted recovery bundle so the app and administrative S3 identities can
be restored. It must be a regular file, not a symlink. These credentials are
never added to the unencrypted database dump or manifest.
The database bundle does not include recording objects, other applications, or a server image.
The current HTTP transfer limit is 512 MiB per encrypted bundle.

Recording objects use a separate, incremental encrypted mirror described in
[recording-backup.md](recording-backup.md). It preserves original deletion/expiry,
stores at most 1 GiB of ciphertext per side, and verifies both encrypted and
decrypted checksums without writing plaintext during ordinary checks. Enable it
with `"recordingBackups": true` only after deploying the worker and exporter.

On the Mac, the puller verifies TLS, decrypts into a mode 0600 temporary file,
validates the dump checksum and size, rejects a copy older than two hours or more
than five minutes in the future, and retains encrypted copies for 30 days.
Normal completion and handled errors remove plaintext. Abrupt process termination
or power loss can leave a private `.verify-*` file requiring cleanup. The private
recipient key must be preserved separately for recovery.

## Server installation

Run `sudo python3 scripts/install-offsite-export.py` from the repository. It
creates a dedicated random bearer at `/etc/imonmeets/offsite-token`, mode 0600,
copies the exporter to root-owned `/usr/local/lib/imonmeets/offsite-export-server.py`
and installs `imonmeets-offsite-export.service`. From a reviewed staging directory,
pass `--project /home/sergey/imonmeets` to select the existing repository.
The Python exporter listens only on `127.0.0.1:3542`. Its systemd sandbox mounts
only the project's `backups` and `ops-state` directories read-only under the
root-owned `/run/imonmeets-export`, mode 0700. It hides home directories,
including the plain `.env` and unrelated projects, drops capabilities, makes
the remaining filesystem read-only and denies non-loopback network access.
The dedicated runtime mount also avoids requiring a capability to traverse a
user's private home directory. The exporter does not relax that directory's
permissions.

Add this line only inside the existing IMON Meets API TLS server block:

```nginx
include /etc/nginx/snippets/imonmeets-offsite.conf;
```

The installer also creates the request-limit zone in
`/etc/nginx/conf.d/imonmeets-ops-rate.conf`. Run `sudo nginx -t` before reloading
nginx. Set `OFFSITE_EXPORT_ENABLED=true` in the server environment so
`scripts/prepare-public.mjs` preserves the include when regenerating configuration.
Do not add it to the RTC host or open a new public port.

All operations require the bearer:

| Path           | Response                                                              |
| -------------- | --------------------------------------------------------------------- |
| `/_ops/backup` | Latest completed encrypted archive, no arbitrary path selection       |
| `/_ops/health` | Timestamp and allowlisted boolean checks from local health monitoring |
| `/_ops/recordings` | Fresh encrypted-recording catalog, when recording backup is deployed |
| `/_ops/recordings/<sha256>.enc` | Only an unexpired ciphertext explicitly named in that catalog |

No query-string credentials, plaintext dump, token, `.env`, private key, other
file, write endpoint or remote shell is exposed. Requests without the correct
header return 401. Unknown paths and paths with a query string return 404.
The exporter rejects symlinks. Nginx and the exporter do not log bearer headers
or request paths.

## Mac installation

Preserve the existing private directory
`~/.local/state/imonmeets-backup`, its `recipient.key`, `recipient.pem`, and
encrypted `copies/`. Transfer the server's read-only bearer using an authorized
private channel without printing it. Update the mode 0600 `connection.json`:

```json
{
  "baseUrl": "https://YOUR-API-HOST:8443",
  "bearerToken": "PRIVATE_READ_ONLY_EXPORT_TOKEN",
  "notifications": false
}
```

Use the real hostname covered by the TLS certificate. `baseUrl` is an HTTPS
origin with no path, query, credentials or fragment. If a platform's default
certificate store lacks the issuer, `caFile` can point to an independently
verified public CA PEM. This is an additional trust bundle, never an option to
skip certificate or hostname verification.

Copy `pull-encrypted-backup.py`, `pull-recording-backup.py`, `recording-backup.py`,
and `install-mac-backup-monitor.py` into one private
staging directory on the Mac. Run the installer with the intended Python 3
interpreter:

```sh
python3 install-mac-backup-monitor.py --root /Users/USER/.local/state/imonmeets-backup
```

The installer checks a real pull/decryption/checksum first. It then enables
notifications and installs the per-user LaunchAgent
`world.imon.meets.backup-monitor`. The job runs when loaded and every five
minutes while the Mac is awake. A file lock prevents overlapping runs. The
job writes bounded structured status files instead of an ever-growing log.

Verify `launchctl print gui/UID/world.imon.meets.backup-monitor` and the private
`status.json`. A successful scheduled run has `automatic: true`, `backupOk: true`,
`transport: "https"`, a fresh `backupCreatedAt`, and a verified checksum.
The overall `ok` also requires a fresh, successful server health response.
When recording backup is enabled, it additionally requires
`recordingBackup.ok: true`. A database backup alone cannot satisfy that check.

## Alert behavior and limits

The Mac checks the API/database, the signaling TCP listener, the local backup and
free server disk through the sanitized endpoint. A lost network connection,
expired certificate, missing/faulty archive, stale monitoring file or failed
server check makes monitoring fail. Two consecutive failures trigger a macOS
notification, with a reminder at most every six hours while the incident
continues. The next successful check triggers one recovery notification.
Failed notification commands are retried at the next failed check.

The private `alert-state.json` records consecutive failures, active incident,
last accepted notification command and any notification error. An accepted
AppleScript command does not establish that the operating system displayed a
banner. Notifications must be allowed for the responsible macOS process and
Focus mode may affect presentation. Test a notification during commissioning.

This is an off-host monitor, but it depends on the Mac being awake, connected to
the internet and logged into the user session. It is not a 24-hour independent
SMS or email pager. The signaling test is not an end-to-end media call. Receiving
and verifying a dump is not a database restore; the separate scheduled restore
check remains necessary.

## Validation

```sh
python3 scripts/test-pull-encrypted-backup.py
python3 scripts/test-offsite-monitor.py
python3 scripts/test-recording-backup.py
```

The tests use synthetic fixtures. They check archive age/checksum/cleanup,
authorization and fixed export paths, symlink rejection, sanitized/stale health,
HTTPS-only transport without bearer arguments or redirects, and incident
debouncing/reminders/recovery/retry. Production readiness additionally requires
a real authenticated HTTPS pull, an automatically scheduled successful run,
an unauthorized request rejection and an actual notification test on the Mac.
