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
after syncing the file, then syncs the directory. Before returning any ACK it
atomically replaces and syncs a private Ed25519-signed `high-water.json` anchor
containing the complete sorted `{id, sha256}` set, its version, head hash, journal
ID and genesis hash. Retrying identical ID/bytes is idempotent; replacement bytes
return HTTP 409. The anchor is bounded to 2 MiB for at most 10000 entries.

The checkpoint request contains only the journal ID and a fresh 32-byte nonce.
The receiver computes the complete head from its own stored intents. It never
echoes a caller-supplied version or hash. Checkpoints and authenticated health
checks reread the durable set; missing files, modified bytes, unexpected files,
symlinks and a replaced storage directory fail closed. The exact verified inodes
of existing or imported metadata, anchor and intent files are fsynced before
authority/proof; directory fsync alone is not treated as proof that copied file
bytes are durable. Fsync failures are fatal to that operation. It signs a
30-second proof.
The API client verifies the public key, nonce, lifetime, journal, count and hash.

All targets are opaque IDs. Optional recording `egressId` is restricted to the
`EG_` server-ID syntax; arbitrary storage paths are forbidden. Intents contain
actor/account/workspace identifiers, so this directory is sensitive operational
data. HTTP responses, errors and process logs do not contain intent content,
credentials or private key material. This service never sends email or makes
payment, object-storage or application API calls.

## Explicit initialization and restart floor

Normal startup never creates storage, genesis or an anchor. Bootstrap an already
mounted, existing private empty directory explicitly with `--initialize`, under
the same single-writer kernel lock used for the service. An empty private
`writer.lock` may already exist. Initialization writes the enrolled genesis and
a signed version-zero anchor, then exits without listening. Repeating it against
any initialized or nonempty store fails; it cannot repair a missing anchor by
resetting history. For an operator working from this checkout with the documented
private environment already loaded, the bootstrap invocation is:

```sh
flock -n "$WITNESS_DIRECTORY/writer.lock" node apps/deletion-witness/server.mjs --initialize
```

With the standalone Compose deployment and its reviewed private environment,
the image forwards the same explicit bootstrap argument through its kernel lock:

```sh
docker compose --env-file /path/to/private/witness.env -f compose.deletion-witness.yml run --rm witness --initialize
```

Use this only for the new enrolled empty volume, before starting the service.
The image's ordinary startup does not initialize storage. The isolated
`scripts/test-deletion-witness-image.py` acceptance builds an immutable receiver
image from a clean Git archive and checks argument forwarding, non-root ownership,
exclusive writer lock, signed append, restart continuity and missing-history
failure using synthetic keys and no public ports. It does not establish that a
host or storage volume is independent of the application.

A restart verifies the anchor signature with the public key derived from the
configured Ed25519 private key, plus the exact pinned journal/genesis. Every
anchored ID and digest must still exist unchanged. Missing genesis, missing or
invalid anchor, a different signing key, missing/changed anchored intents, or an
empty replacement mount abort startup. Health, checkpoint and append apply the
same checks during operation. Do not run initialization as a recovery response
to missing storage; recover the correctly enrolled complete store instead.

A crash after publishing an intent but before publishing its anchor can leave
extra unanchored files. Recovery accepts only schema-valid, HMAC-authenticated
extras for the same journal, and only if every previous anchored ID/digest is
still present. It fsyncs those exact file inodes and their directory, persists the
monotonic union in a new anchor, fsyncs the atomic replacement, and only then
issues a proof or retry ACK. Invalid extras fail closed. Pending temporary files
carry no authority and do not replace an anchored entry. A crash during initial
bootstrap may leave incomplete storage; normal startup does not finish or reset
that partial initialization automatically.

This anchor detects file loss or changed bytes relative to the retained signed
floor. It is not an external monotonic counter: a coherent rollback of the entire
store, including an older valid signed anchor and every corresponding old file,
cannot be detected by that same volume after a process restart. Such rollback is
forbidden operationally and still requires independent durable storage and a
controlled recovery policy. Replacing a lost store with a new enrollment does not
prove that old deletions did not exist.

## Trust boundary

This receiver verifies the application's HMAC and therefore holds the journal
HMAC key as well as its dedicated bearer token and separate Ed25519 signing key.
It is a trusted holder of intent-authentication secrets, not merely opaque
storage. Compromise can forge valid intent MACs as well as witness signatures;
physical separation alone does not remove that authority. Do not claim a receiver
signature proves origin against a compromised receiver, or silently replace HMAC
validation with bearer-only opaque storage. No wire-format or trust-model change
is introduced here. Restrict receiver administrators, credentials and backups;
separate-host and disaster-recovery acceptance remain operator gates.

## Deployment prerequisites

Use a host and persistent storage with a failure domain independent of the
application, database and their ordinary backup. Preserve all acknowledged
intents across application restores. Never restore this journal to an older
snapshot alongside the application. Define separate backup, disk monitoring,
access control and a controlled recovery process for this receiver.

Enroll the exact exported `metadata.json` as the private `genesis.json`, its
canonical SHA256 and journal UUID, then explicitly initialize its private store
before starting the application. This permits
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

The receiver stores canonical `metadata.json`, the signed `high-water.json`, and
the complete `<id>.intent.json` set, all mode 0600. Receiver recovery must preserve
all three together without rolling back the anchor. For application-journal
recovery, a controlled operator copies only the enrolled `metadata.json` and
complete intent set; `high-water.json` is receiver authority and is not an
application-journal record. There is deliberately no public download/list/delete
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
Additional cases cover explicit CLI initialization, missing whole storage, lost
anchor/genesis, loss followed by restart, invalid/wrong-key anchors, bounded
anchor files, and safe monotonic crash-extra recovery with idempotent retry.
The independent-host deployment and live restore acceptance remain separate.

For the application status gate, run `node scripts/check-deletion-journal.mjs --env <private-env-file> --output <private-state-dir>/deletion-status.json`. This only verifies the local snapshot against a fresh independently signed checkpoint. It never delivers pending intents, replays deletions or mutates the database. Launch readiness requires this status to be at most five minutes old, bound to the exact release/configuration, and separate external acceptance of old-backup replay and physical independence.
