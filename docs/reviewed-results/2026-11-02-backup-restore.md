# IMON Meets backup and restore receipt

**Host:** imon-workstation (94.249.186.240)
**Date:** 2026-11-02 UTC

## Database

Latest post-deployment backup:

- File: /home/sergey/imonmeets/backups/imonmeets-20261102T132246Z.dump
- Size: 68,177 bytes
- Mode/owner: 0600, root:root
- SHA-256: 0f351a3c9f576a567c270f539606d06b9e653cc38c486ce30e383b216e14da50
- The digest matches root-only backups/latest.json.
- Backup service result: success, exit 0, started 13:22:46 UTC, completed 13:22:47 UTC.

Restore drill:

- Existing imonmeets-restore-check.service ran at 13:22:48 UTC and completed 13:22:51 UTC, result success, exit 0.
- Restored into a disposable database, not the live database.
- Verified counts: 6 workspaces, 18 rooms, 7 users, 7 accounts, 6 memberships, 1 invitation.
- Disposable database cleanup succeeded.
- No production database restore/overwrite was performed.

Earlier verified offsite encrypted backup worker and Mac backup monitor reported successful automatic HTTPS backup. The offsite copy is distinct from Vercel.

## Recordings

- Recording path: /home/sergey/.local/share/imonmeets-recordings
- Directory size at inspection: approximately 2.3 MB.
- Manifest: /home/sergey/imonmeets/backups/recordings/manifest.json
- Manifest says complete=true, objects=0. There were no eligible real recording objects in the catalog at this time.
- Recording worker timer/service is active and its last run succeeded.
- Synthetic recording encryption/decryption/recovery suite: 15/15 passed (job 20261102T122211-f2a47bce79).
- No real media object existed for an actual recording restore drill. Do not interpret the synthetic suite as proof that a non-empty recording backup can be restored.
- No recording files were moved, deleted or overwritten.

## Safety

No docker volume was removed. No down -v command was run. No database dump was restored over the active DB. The current DB volume remains imonmeets_db-data.
