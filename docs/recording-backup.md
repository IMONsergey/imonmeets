# Encrypted offsite recording backup

This is an incremental mirror of completed, unexpired recordings. It complements
the database recovery bundle; it does not copy the live PostgreSQL volume or the
SeaweedFS filesystem. Both the database bundle and the recording mirror are needed
to recover a complete service. Recording retention is not extended by backup.

## Data and limits

The server worker selects `complete` recordings with no `deleted_at` or
`deletion_requested_at`, and a future expiry. It derives a missing expiry from
the existing application's configured retention. Every catalog entry includes
the recording ID, exact S3 object key, original expiry, plaintext size/SHA256 and
ciphertext size/SHA256. Titles, chat messages and signed URLs are not included.

Each S3 object streams through OpenSSL CMS AES-256 encryption into a mode 0600
temporary ciphertext. Plaintext is hashed in memory, never written to a file.
Only the public recipient certificate is used on the server. The private key
stays on the Mac. After size checks and successful encryption, the ciphertext
is atomically renamed to its SHA256 filename. Failed and interrupted writes are
cleaned on the next run under the worker lock.

The dedicated `backups/recordings` cache is bounded to 1 GiB of encrypted objects,
including conservatively reserved CMS overhead. A single source object is limited
to 350 MiB, matching the pilot recording limit. The worker checks free space and
requires at least 64 MiB beyond the incoming object's declared size. A catalog
is limited to 2 MiB and 2,048 records. This creates at most approximately 1 GiB of
additional server data, not another plaintext archive on every run. Unchanged
objects are reused; only their hashes and eligibility are checked again.

Deletion requests withdraw cached objects before a new transfer starts. The
worker re-reads database eligibility after transfers, so a deletion occurring
during a transfer cannot publish that recording. Only a complete catalog counts
as a successful snapshot; an in-progress catalog permits withdrawals but the Mac
reports backup failure until a complete catalog is available. If a new recording
appears during collection, the next run includes it.

## Deployment

1. Preserve the existing `/etc/imonmeets/backup-recipient.pem` and matching Mac
   `recipient.key` / `recipient.pem`. Do not generate a replacement key pair as
   part of an ordinary upgrade.
2. Run the worker as the existing project operator with Docker access:

   ```sh
   python3 scripts/recording-backup.py \
     --project /home/sergey/imonmeets \
     --recipient /etc/imonmeets/backup-recipient.pem
   ```

3. Re-run `scripts/install-offsite-export.py` from the updated checkout and check
   `nginx -t` before reloading. It installs the helper alongside the exporter and
   adds the two recording routes to the existing TLS include. No extra listener,
   Docker socket access, source credentials, writable mount or network permission
   is added to the exporter. Its existing read-only `backups` mount is sufficient.
4. Install the separate worker timer from the checked checkout:

   ```sh
   sudo python3 scripts/install-recording-backup.py --project /home/sergey/imonmeets
   ```

   The installer preserves the existing certificate and application configuration,
   installs a root-owned worker under `/usr/local/lib/imonmeets`, and creates
   `imonmeets-recording-backup.service` / `.timer`. It validates a real first run
   under systemd and a fresh complete catalog before enabling the five-minute
   timer. The worker has a 20-minute process deadline, 256 MiB memory limit, 50%
   CPU quota and a read-only host filesystem except the project's backup
   directory. It uses the existing Docker socket to execute only the fixed
   PostgreSQL query and S3 GET logic inside the running application container.
   Its generated units do not restart Docker, the application or other timers.
   No change to the existing hourly database backup is required.

   Verify `systemctl status imonmeets-recording-backup.timer` and
   `systemctl show imonmeets-recording-backup.service -p Result -p ExecMainStatus`.
   A successful empty snapshot establishes operation of the worker/catalog only;
   acceptance of media recovery still requires a nonempty recording.

5. On the Mac, install the updated `pull-encrypted-backup.py`,
   `pull-recording-backup.py`, `recording-backup.py`, and
   `install-mac-backup-monitor.py`. In the existing private `connection.json`, set
   `"recordingBackups": true`. Preserve the existing origin, bearer and keys.
   The installer copies both helpers and requires the first recording sync to
   succeed before installing the scheduled job.

The authenticated endpoints are:

| Route                                      | Result                                                         |
| ------------------------------------------ | -------------------------------------------------------------- |
| `GET /_ops/recordings`                     | Fresh catalog of completed encrypted recording copies          |
| `GET /_ops/recordings/<cipher-sha256>.enc` | Only a ciphertext named in that fresh catalog, still unexpired |

The same existing read-only bearer is sent only in the Authorization header.
The routes reject query strings, arbitrary paths, missing objects and symlinks.
Nginx access logging is disabled for these locations. The exporter does not log
request targets or headers. A catalog older than ten minutes fails closed, and
individual expired objects disappear from responses immediately even before the
next worker cleanup.

## Mac verification and recovery

The Mac verifies TLS without following redirects. Ciphertext downloads have a
known Content-Length and a matching transfer bound. Files are committed only
after both the ciphertext hash and decrypted plaintext hash/size match. Normal
verification streams decryption into a bounded hash calculation without creating
a plaintext file. Private key/certificate files must have no group/other access.
Only encrypted objects and the private catalog persist under `recordings/`.

Each recording-object download allows 1,800 seconds by default, so a larger MP4
can cross a slower connection. An integer `recordingTransferTimeoutSeconds` in
the private `connection.json` may set that bound from 60 to 3,600 seconds. The
database bundle, health and recording-catalog requests retain their 240-second
limits. The curl subprocess deadline is ten seconds beyond the selected transfer
limit. Redirects remain disabled and the bearer is provided only through stdin.
The Mac installer's first acceptance run is bounded to two hours with recording
backup enabled (650 seconds otherwise). Very slow or repeatedly interrupted
connections may still fail; a timeout is reported as a failed backup, never as
successful protection. Later runs reuse completed verified ciphertexts.

`status.json` includes a `recordingBackup` result. Its failure makes overall
monitoring fail even when the database backup and ordinary server health pass.
The Mac rechecks the source catalog after downloads and removes withdrawn copies
before reporting success. An interrupted new transfer never replaces a known
good existing ciphertext and leaves no usable partial object.

Explicitly restoring one recording creates a mode 0600 file only after plaintext
verification. Existing destination files are never overwritten:

```sh
python3 pull-recording-backup.py \
  --root /Users/USER/.local/state/imonmeets-backup \
  --restore-id RECORDING_UUID \
  --output /Users/USER/private-recovery/recording.mp4
```

Recovery uses a locally catalogued object even if the original server
has been unavailable for more than ten minutes. Freshness applies to online
synchronization, while recovery always enforces original object expiry, rejects
future catalogs, and checks size, hashes, key permissions and destination. During disaster recovery, reconcile
post-snapshot deletion requests before making restored data available again.
The tool restores a private file; it never uploads or publishes it automatically.
Failure to download a different new object does not prevent recovery of an existing
verified one. The global sync remains unsuccessful until the complete mirror is
current, while explicit recovery verifies the selected object independently.

## Deletion, retention and availability boundaries

This mirror deliberately keeps no historical MP4 generations. A confirmed
deletion withdraws the object at the next worker run, then removes the Mac copy
at the next successful sync. An original expiry is enforced by the exporter,
local cleanup and recovery code; it is never reset to the backup date. The Mac
also removes locally expired copies before attempting network access, so an
ordinary connection failure does not prevent scheduled expiry cleanup.
This cleanup runs before the database backup request too, and continues for an
existing mirror even if future recording downloads are disabled in configuration.

These are scheduled operations, not synchronous deletion across disconnected
devices. A sleeping or offline Mac cannot erase a newly deleted object until it
runs again. If it remains powered off past expiry, physical ciphertext can remain
on disk until the next run; the recovery command refuses expired records. The
independent backup key is needed for disaster recovery, so this is not remote
cryptographic erasure. Do not promise instant removal from offline backups.

If the Mac is not available during a recording's entire retention period, that
recording can expire before being copied. The five-minute worker and Mac schedule
reduce this window but do not make the Mac a continuously available backup host.
An always-on independent destination remains the way to remove that dependency.

The encrypted database recovery bundles have their separate retention policy;
this feature changes only MP4 retention. Restoring an old database must not
resurrect removed/expired MP4 objects. Never treat a database row alone as proof
that its media remains recoverable.

## Verification

```sh
python3 scripts/test-recording-backup.py
python3 scripts/test-pull-encrypted-backup.py
python3 scripts/test-offsite-monitor.py
```

The recording tests run actual OpenSSL encryption, decryption and file recovery
on synthetic binary fixtures. They cover incremental reuse, size/capacity limits,
hash tampering, key permissions, authenticated fixed paths, no token in a URL or
process arguments, interrupted transfer cleanup, source deletion during server or
Mac transfer, expiry during a network failure and refusal of withdrawn recovery.
Commissioning also requires a real server snapshot, authenticated HTTPS transfer,
Mac decryption and restore checksum, scheduled status, and confirmed withdrawal.
