# Database authority binding for deletion recovery

The PostgreSQL database pins the exact deletion journal authority in the singleton
`im_deletion_journal_binding` row: the journal UUID and SHA-256 of canonical genesis
envelope bytes. The schema migration creates the table but never enrolls an
authority. Every backup taken after enrollment includes this row.

Application startup and the isolated replay CLI check this binding before an
independent checkpoint can be accepted or any deletion can be replayed. A fresh
empty local journal and a fresh receiver cannot authorize a populated database
that was backed up with another authority. A changed UUID or changed genesis
hash fails closed, including for an otherwise empty database. There is no
application or operator command that updates an existing binding.

## First enrollment

A new database can bind automatically only after all ordinary tables in its
current application schema are proven empty while locked against writes. The
only excluded metadata table is `im_identity_migrations`, which contains the
built-in migration marker. Unknown ordinary tables also participate in the
empty proof. Row security, foreign tables or materialized data prevent automatic
empty enrollment. Missing required tables fail with a migration prerequisite.
Migrations and application writers must not run concurrently with bootstrap.

An existing database with no binding requires a reviewed baseline decision.
This includes old backups created before the binding migration. Startup never
uses the absence of the row as permission to enroll a replacement authority.

For a planned one-time migration of an existing, authoritative database:

1. Stop or fence every application writer and suspend automated maintenance.
   Keep the restored or migrating application inaccessible throughout this work.
2. Preserve the complete existing deletion journal and enroll the independent
   receiver with its exact genesis. Do not initialize an empty replacement to
   resolve a missing-history error. If historical deletion obligations cannot
   be established, the restore remains blocked.
3. Apply database migrations separately and review the baseline inventory,
   deletion history, backup provenance and any prior removal obligations.
   Record approval of this exact baseline and retain the evidence separately.
4. With the prepared private configuration, run the explicit enrollment command,
   referring to the SHA-256 of that accepted evidence:

   ```sh
   node scripts/enroll-deletion-baseline.mjs --enroll-reviewed-baseline --approval-sha256 <accepted-baseline-evidence-sha256>
   ```

   The command requires a fresh independently signed complete-head checkpoint,
   stores the evidence hash in the new binding and refuses a different existing
   authority. It reports only completion, time and enrollment mode. The evidence
   hash is an operator's reference to an accepted decision, not a substitute for
   reviewing that decision or proof that a machine is physically independent.

5. Take a fresh post-enrollment database backup, then run offline replay and the
   external restore acceptance before reopening traffic.

The CLI cannot infer whether a database restored under an ordinary production
name was copied from an old backup. It must never be used to bypass a failed
restore by declaring a replacement empty journal to be a new baseline.

## Restore and concurrency boundary

Restore is an offline operation. Old writers and competing restore workers must
remain stopped or fenced until the complete journal has been independently
verified and replayed before serving. A fresh signed checkpoint proves the
observed journal head; it is not a distributed write lease. This code does not
claim safe online restore while an old application can still acknowledge new
deletions.

Database administrators can modify database content and binding rows; the
guard protects the normal restore/startup path, not a malicious administrator
who rewrites trusted state and deployment configuration. The journal HMAC
holder can create valid intent records. Independent append acknowledgements,
monotonic receiver history, offline restore procedures and deployment controls
remain separate requirements.

## Verification scope

`deletion-binding.integration.test.ts` checks concurrent empty initialization,
immutable UUID/genesis binding, rejection of nonempty unbound databases,
explicit baseline enrollment, fresh replacement journals rejected before proof,
lost pre-binding snapshots, non-user table content and row-security ambiguity.
The existing actual PostgreSQL dump/restore acceptance now also carries the
binding row through the pre-deletion snapshot. Both suites require the disposable
test PostgreSQL service and the normal bounded verifier.

These source changes do not by themselves close DATA-02 or REC-06. Independent
host deployment, production backups, all old writers fenced, retention/chat
expiry, pending media cleanup and external restore acceptance remain distinct
gates. Existing populated production databases will intentionally fail startup
until the reviewed enrollment prerequisite is fulfilled.
