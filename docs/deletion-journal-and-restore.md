# Durable deletion journal and restore gate

## Status and deployment incompatibility

This change supplies the application foundation: strict immutable journal records outside PostgreSQL, an authenticated independent-receiver client, write-ahead acknowledgement, and replay before HTTP or background workers start. It does not establish that a receiver is physically independent, provision that receiver, back up its keys, prove immutable offsite retention, or certify a real disaster restore. DATA-02 remains open until those deployment and acceptance requirements are evidenced.

Production startup now requires a prepared journal, a strong stable journal key, the independent receiver and its pinned Ed25519 public key, a fresh complete-head proof, successful replay and media cleanup. Missing prerequisites intentionally prevent the new release from serving. Migrations must already have completed; the existing release compose migrate service supplies that ordering. Factory startup never silently initializes an empty journal or runs migrations.

The optional local development mode has no independent durability claim. It exists for reproducible isolated tests and cannot pass the production gate. A signature proves a configured key acknowledged a record; receiver topology, storage persistence and retention must be checked separately.

## Protocol and state

A journal has an immutable signed metadata.json and per-intent UUID files. Canonical envelopes contain body and HMAC-SHA256 mac; objects have recursively sorted keys and no whitespace, and files end with one newline. Records are bounded to 16 KiB, journals to 10,000 intents. Only server-generated UUID filenames and strict opaque resource identities are allowed. No user content, passwords, OAuth credentials, transcript text, email addresses, arbitrary file paths or arbitrary S3 keys enter the journal.

Each manual deletion follows this order while the existing authorization and ownership locks are held:

1. Check the current verified user, password where required, resource membership/ownership, and existing deletion preconditions.
2. Publish the immutable authorized intent, fsync the file and journal directory.
3. In production, send that exact intent to the independent receiver and verify its signed acknowledgement of that intent ID and content hash. The receiver must durably persist before replying.
4. Perform the database mutation and commit.
5. Publish a separate signed database_committed marker. This marker means exactly a committed DB mutation, not necessarily finished recording/media cleanup.

A recording response still reports deletionPending until object cleanup finishes. A saved intent is an irrevocable deletion request, not evidence that deletion finished. If SQL rolls back after intent persistence, the API returns DELETION_REQUEST_PENDING and preserves the request for a safe retry/replay. If external acknowledgement is unavailable, DB mutation does not begin. The same actor and canonical target reuse the same intent ID; a temporary outage cannot generate an endless chain of new IDs for one request.

Atomic publication uses a new private temporary file, fsync and an exclusive hard link: immutable names are never overwritten. Never-published temporary files cannot have authorized a DB mutation and are not replayed. Published records are validated on every snapshot. Missing/corrupt metadata, malformed files, unexpected names, symlinks, broad permissions, wrong HMAC, mismatched commit or acknowledgement records, and exceeded bounds close the gate.

A commit marker is outside the database and does not suppress replay: an old dump may precede that commit. Acknowledgement files prove a historical receiver acknowledgement; they never substitute for a fresh startup proof.

## Complete independent head

The exact head contract is:

    SHA256(canonicalJson({
      journalId,
      genesisSha256: SHA256(canonicalJson(genesisEnvelope)),
      entries: [{id, sha256: SHA256(canonicalJson(intentEnvelope))}, ...]
    }))

Entries are sorted by UUID; version is their count. Commit markers and cached acknowledgement files do not change the intent head. The receiver must enforce append-only identities, reject same ID with different content, persist its own complete set, and compute checkpoints from that durable set. An authenticated client cannot ask it to sign a supplied local head.

POST WITNESS_URL/intents accepts nonce, genesis and intent. It returns an Ed25519 signed body containing schema:1, journalId, nonce, version, headSha256, issuedAt, expiresAt, storage:independent-durable, intentId and intentSha256. Signatures are base64url; the nonce is a fresh 32-byte base64url value. The client requires the exact ID/hash before changing DB state.

POST WITNESS_URL/checkpoint accepts only journalId and nonce. Its signed body omits the per-intent fields and describes the receiver's latest durable set. The client requires identical count and head, a matching nonce, a valid pinned Ed25519 key, issuedAt within 30 seconds, and lifetime at most 60 seconds. A truncated but internally valid local journal cannot match the independently stored latest head.

During startup, previously authorized intents with an uncertain outbound attempt are resent using their original immutable ID/hash, then a fresh checkpoint is requested. No DB mutation occurs before that whole check passes. The read-only status command must call verifyIndependentCheckpoint(snapshot, {recoverPending:false}); it does not resend, replay or mutate the database. A missing local event is never silently removed from the external head: retrieve and verify the complete independently stored journal first.

These guarantees require the actual independent receiver's durable append-before-ack contract. A periodic mirror after DB deletion is insufficient. A signer that echoes values, an on-host service, an empty replacement journal, or restored stale copies of all acknowledged storage cannot prove independent durability.

## Replay before serving

createApp opens the configured journal and completes validation, independent-head verification and replay before creating Fastify or starting timers. No protected endpoint or background analysis worker can run through a failed restore gate.

Replay applies all authorized records in request order, regardless of local commit markers:

- Account: revoke the restored account and its sessions, grants, invitations, personal chat messages and identity challenges, following current deletion semantics. A restored ownership transfer or payment state that cannot be reconstructed authoritatively blocks recovery. The code never invents a successor or deletes an unrelated workspace.
- Workspace: close scoped restored media, remove scoped recording objects, then delete the restored workspace and dependent records. Unresolved payment state blocks recovery.
- Recording: derive the exact recordings/workspaceUUID/recordingUUID.mp4 key, compare it to any restored row, settle a still-writing Egress, remove the object and known Egress sidecar, and remove transcripts. The optional stored egressId permits sidecar cleanup even if the DB snapshot predates that recording row.
- Analysis: delete only the recorded analysis generation. A later legitimate re-analysis survives.

A pending intent whose resource ownership or access changed needs authoritative reconciliation; recovery fails closed. A committed intent records an already accepted DB deletion and is not reauthorized against an older snapshot. S3 errors, still-finishing Egress, unknown ownership/payment history, missing migrations, changed journal head, malformed stored object scope, or exceeded startup time/batch bounds keep HTTP closed.

Replay is idempotent. Media calls are bounded; cleanup failure is not reported as complete. The current bounded startup budget is two minutes, with ten-second individual media/SQL operations and five-second DB lock waits. Large restores must be rehearsed offline and may need a separately reviewed bounded batching mechanism; no automatic history compaction or event pruning is supplied here.

## Configuration and bootstrap

Required production inputs:

- DELETION_JOURNAL_DIR: absolute private directory on durable storage outside the database backup and rollback lifecycle.
- DELETION_JOURNAL_KEY: stable strong HMAC key, at least 32 characters, held outside PostgreSQL.
- DELETION_WITNESS_URL: configured HTTPS receiver base URL; redirects and URL credentials are rejected.
- DELETION_WITNESS_TOKEN: private bearer credential, at least 32 characters.
- DELETION_WITNESS_PUBLIC_KEY: pinned Ed25519 public PEM.
- DELETION_RESTORE_REQUIRED=true forces the production durability/replay checks outside NODE_ENV=production too.

Initialize a deliberately prepared empty 0700 directory using:

    node scripts/init-deletion-journal.mjs --initialize

The CLI refuses a non-empty directory. Export metadata.json through the private deployment channel and enroll its exact genesis hash in the independent receiver before first application startup. Keep app/witness keys, genesis identity, journal and receiver storage recovery instructions together in the approved disaster-recovery plan. Mount the journal persistently with create_host_path:false; changing code images or restoring PostgreSQL must not replace it.

Historical deletions before journal introduction are not retroactively recovered. Commercial adoption needs a reviewed new backup baseline and disposition of older backups that lack complete tombstones. Automatic expiry remains governed by persisted expiry timestamps and current retention checks; this foundation specifically records explicit manual account/workspace/recording/analysis deletions.

The isolated replay CLI accepts only a separately created imonmeets_restore_* database and requires the independent gate:

    node scripts/replay-deletion-journal.mjs --replay-isolated-restore

Never test recovery against the live application DB or use --replay as a way to initialize authority. For an actual restore, stop all writers, obtain the latest complete independent journal, restore into a separate DB/storage scope, run migrations, validate/replay, prove deleted resources remain inaccessible and files absent, then allow the new service to serve. Existing row-count-only restore scripts remain structural dump checks; they do not certify deletion-safe recovery.

## Acceptance and remaining gate

Focused tests use disposable local schemas, temporary journals, synthetic keys, mocked private media and the isolated test PostgreSQL container. They take a real pg_dump before deletion, delete all four resource types through the API, restore that old schema, verify resurrection occurred before replay, then verify removal and replay idempotency. Additional negatives cover file failure before DB mutation, receiver outage before SQL, durable pending requests after SQL rollback, concurrent ownership change, generation preservation, invalid S3 scope, signed but incomplete journal heads, and ambiguous restored ownership.

Production acceptance additionally needs the real receiver on a physically independent host/storage, durable-ack fault injection, complete journal recovery after local loss, the exact release-bound old-backup drill, media cleanup verification, monitoring of pending intents and storage capacity, and documented ownership/payment conflict recovery. Passing synthetic tests or possessing a fresh signature does not close those deployment requirements.

The real dump test additionally requires TEST_RESTORE_PG_CONTAINER to name the explicitly disposable local PostgreSQL test container (and TEST_DATABASE_URL for its local imonmeets_test database). It skips that one acceptance if the dedicated container is not provided; a skip is not a restore PASS. Other focused tests remain independent of Docker.

If the already authorized local test-container access requires sudo, TEST_RESTORE_DOCKER_SUDO=true uses exactly sudo -n docker for that named disposable container; it never changes socket permissions or group membership. The bounded acceptance here uses that existing route. Leave the flag unset when ordinary Docker access is already configured.

## Explicit retention coverage limit

The before-serving replay gate in this change covers the four recorded manual-deletion scopes. It does not claim synchronous replay of every automatic retention policy. Recording download and analysis paths already filter expired/deletion-requested resources; their physical cleanup and existing chat-retention sweep are separate jobs. This test receipt does not certify chat expiry before serving, removal of every automatically expired object, previously issued download URL revocation during a storage outage, backup expiry, object-version retention, or offsite backup erasure. A recording DB commit marker can therefore coexist with deletionPending while the scoped object cleanup retries. DATA-02 and REC-06 remain partial until the complete independent restore, retention and physical media/backup cleanup acceptance is recorded for the deployed release.
