# Independent deletion receiver

This is a separately deployed receiver for the deletion-journal protocol. Its
source and isolated tests are preparation. No independent host, DNS name, TLS
certificate, real signing key or operational service is provisioned by this code.
The `storage: independent-durable` signature is an assertion by the enrolled
operator and key. A signature alone cannot establish physical independence.

## Safety contract

The application writes an authenticated local deletion intent, obtains an exact
durable acknowledgement from this receiver, and only then changes the database.
The receiver validates strict schemas, the HMAC, the enrolled journal ID and the
canonical genesis hash. It publishes immutable files with an exclusive hard link
after syncing the file, then syncs the directory before returning an Ed25519
signature. Retrying identical ID/bytes is idempotent; replacement bytes return HTTP 409.

The checkpoint request contains only the journal ID and a fresh 32-byte nonce.
The receiver computes the complete head from its own stored intents. It never
echoes a caller-supplied version or hash. Checkpoints and authenticated health
checks reread the durable set; missing files, modified bytes, unexpected files,
symlinks and a replaced storage directory fail closed. It signs a 30-second proof.
The API client verifies the public key, nonce, lifetime, journal, count and hash.

All targets are opaque IDs. Optional recording `egressId` is restricted to the
`EG_` server-ID syntax; arbitrary storage paths are forbidden. Intents contain
actor/account/workspace identifiers, so this directory is sensitive operational
data. HTTP responses, errors and process logs do not contain intent content,
credentials or private key material. This service never sends email or makes
payment, object-storage or application API calls.

## Deployment prerequisites

Use a host and persistent storage with a failure domain independent of the
application, database and their ordinary backup. Preserve all acknowledged
intents across application restores. Never restore this journal to an older
snapshot alongside the application. Define separate backup, disk monitoring,
access control and a controlled recovery process for this receiver.

Enroll the exact exported `metadata.json` as the private `genesis.json`, its
canonical SHA256 and journal UUID before starting the application. This permits
the initial version-zero checkpoint before any deletion. Supply the existing
journal HMAC key, a dedicated bearer token and a separate Ed25519 private key;
enroll only its public key in the application. Keys are operator inputs, not
generated or committed here. Files must be mode 0600; storage and private
directories must be mode 0700 and owned by the container's node UID 1000.

Build `apps/deletion-witness/Dockerfile` from the reviewed exact Git archive, using
the pinned Node image and full `VCS_REF`, then set `WITNESS_IMAGE` to its immutable
image ID. Verify `/usr/bin/flock` exists in that image. The entry point takes a
kernel advisory lock for the complete process lifetime; a second writer exits,
and a crash releases the lock. Do not invoke `server.mjs` directly against a live
shared directory. `createWitnessStore` is an internal single-writer API for tests.

`compose.deletion-witness.yml` is standalone. Do not merge it with the application
Compose file or deploy it on the same host as proof of independence. It uses a
host network only to bind a fixed loopback listener 127.0.0.1:3551. Place an actual
TLS reverse proxy on that independent host, require valid HTTPS at the application
client, block public access to the loopback port, and disable request-body and
authorization logging. No certificate validation bypass is supported by the
application client. The compose file requires an explicit storage-role setting;
setting it is not itself acceptance evidence.

## Restore and operation

The receiver stores a complete canonical `metadata.json` and `<id>.intent.json`
set. A controlled operator can copy these mode 0600 files to a new journal
directory for restore. There is deliberately no public download/list/delete
endpoint. Existing local `.ack.json`/`.committed.json` state is handled by the
application restore procedure, not fabricated by this receiver. After importing
the complete journal, obtain a fresh independently signed checkpoint and run
the application's deletion replay before HTTP serving. Test recovery from an
older database snapshot that predates the deletion, including media objects.

There is a hard limit of 10000 intents per enrolled journal, 16KiB per record,
36KiB per HTTP request, 16 simultaneous requests and 64 connections. Reaching the
limit blocks new deletion acknowledgements; it never silently discards history.
Journal rotation/archival is not implemented and requires a separately reviewed
continuity protocol before this limit is approached. Full-set verification is
bounded but linear; measure latency on the intended disk and data size.

A receiver outage blocks acknowledgement of new deletions; it must not turn into
an unjournaled database deletion. The UI must distinguish pending or failed
deletion from a completed operation. Temporary `.pending-*` files were not
acknowledged before publication and can be reviewed during offline maintenance.
The receiver neither erases original data itself nor proves object-storage
cleanup, legal retention, offsite restore or complete disaster recovery.

## Isolated acceptance

Run `node --test apps/deletion-witness/test.mjs` with Node 24. Fixtures create only
temporary directories, local ephemeral keys and a loopback HTTP server. They
check enrolled empty state, exact append/retry, conflicts, concurrent append and
restart, missing/changed files, directory replacement, schema and HMAC failures,
symlink/permission failures, bounded authenticated HTTP and verifiable signatures.
The independent-host deployment and live restore acceptance remain separate.

For the application status gate, run `node scripts/check-deletion-journal.mjs --env <private-env-file> --output <private-state-dir>/deletion-status.json`. This only verifies the local snapshot against a fresh independently signed checkpoint. It never delivers pending intents, replays deletions or mutates the database. Launch readiness requires this status to be at most five minutes old, bound to the exact release/configuration, and separate external acceptance of old-backup replay and physical independence.
