# Routine SQL restore inspection

The scheduled restore check verifies a disposable SQL restore. It does not authorize a restored database to serve users.

## What is verified

`check-latest-restore.sh` verifies the selected local dump digest. `restore-check.sh` creates a unique `imonmeets_restore_*` database in the existing `imonmeets` Compose PostgreSQL service, restores the entire archive with `pg_restore --exit-on-error`, and removes only that generated database on exit. A failed cleanup makes an otherwise successful command fail; an earlier failure keeps its original exit status.

`check-restored-database.mjs` then:

- Discovers every ordinary or partitioned public table, without a fixed table-count assumption.
- Compares the restored table inventory, columns, defaults, constraints, indexes and row-security flag with the current application database.
- Requires exactly one existing deletion-journal binding and compares its complete row, including its binding timestamp, with the current database.
- Verifies the binding identity against the HMAC-validated canonical local journal. Opening that journal also validates its existing records and signed acknowledgements; the configured independent receiver public key is retained for this check.
- Reads a row count from every discovered restored table. It does not compare backup row counts with a running database whose contents may legitimately have changed.

Both production-reference and restored-data queries run in explicit read-only transactions with statement and lock timeouts. Database creation, archive restore and cleanup apply only to the generated disposable database. The Compose project is explicitly `imonmeets`.

## Installed configuration and activation

The default authority resolver uses the repository project directory, its `.env`, and the installed five Compose layers: `compose.yml`, `compose.public.yml`, `compose.turn.yml`, `compose.recording.yml`, and `/etc/imonmeets/compose-meets-runtime.yml`. The merged configuration is captured privately and never printed. Only deletion-authority fields are selected. The canonical container directory must map to exactly one explicit absolute host bind; missing keys or an ambiguous/non-bind mount fail the check.

The main `.env` alone is insufficient: deployed authority values come from the private runtime overlay. No additional service environment pointer is required. The optional `envPath` argument to the exported loader is only for an explicit isolated fixture; the scheduled CLI uses the effective installed Compose configuration.

The existing `imonmeets-restore-check.service` calls `/home/sergey/imonmeets/scripts/check-latest-restore.sh`, which calls the repository's `restore-check.sh`. Fast-forwarding that checkout activates these scripts for the next scheduled run without changing the unit. This does not by itself prove that the service has run successfully after activation.

The wrapper prefers the installed `/opt/imon-runtime/node/bin/node` where available. `api-runtime.mjs` loads an existing compiled module or otherwise source via `tsx`; verification receipts must identify the actual resolution. On the reviewed November 4 deployment the deletion-journal compiled module is absent, so the resolver uses the unchanged application source.

## Explicit offline inspection

For a legacy unbound archive, an operator may deliberately run `restore-check.sh ARCHIVE --inspect-unbound-offline`. It restores and counts the disposable copy only, skips current-schema and canonical-authority acceptance, and reports `OFFLINE_INSPECTION_ONLY` with `servingAuthorized: false`. It never creates a binding or enrolls a baseline.

## Proof limits

This routine does not certify that application migrations are complete independently of the current production schema. That belongs to the release migration gate. It does not certify historical deletions, request a fresh independent signed checkpoint, replay deletions, recover pending intents, start the application, or call media/storage providers. A complete-head and replay workflow remains a separate prerequisite before serving any restored database. Local journal opening is read-only and its fetch implementation rejects network use.

A successful core verifier receipt is not evidence of shell cleanup or a scheduled service execution. Keep the command exit status and cleanup evidence alongside the result.

## Standalone validation

Run the offline regression suite through the approved queue:

```sh
imon-job submit --cwd /home/sergey/imonmeets --timeout 120 -- node --test scripts/test-restored-database.mjs
```

The suite covers dynamic inventory, schema drift, complete binding and timestamp mismatches, actual synthetic metadata HMAC verification, effective Compose host mapping, read-only SQL, and shell failure/cleanup behavior through a fake Docker executable. It does not run Docker, access production data or invoke services.

For an actual restored-copy check, a separately reviewed administrative preparation can restore the already verified archive into a bounded isolated PostgreSQL fixture. An unprivileged queued driver then calls the same core verifier with a read-only connection to that fixture and pinned current-schema/binding metadata, plus a private read-only canonical journal copy. This checks the core against a real whole-archive restore; it must not be described as executing the scheduled production unit. Remove the exact disposable database/container, fixture secrets and completed job environment snapshot after retaining sanitized receipts.
