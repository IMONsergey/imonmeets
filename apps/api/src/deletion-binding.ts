import type { Pool, PoolClient } from "pg";
import { transaction } from "./db.js";

export type DeletionAuthority = { journalId: string; genesisSha256: string };
type Binding = {
  journal_id: string;
  genesis_sha256: string;
  enrollment_mode: "empty-database" | "reviewed-baseline";
  baseline_approval_sha256: string | null;
};
type Table = { name: string; kind: string; row_security: boolean };
const BINDING_TABLE = "im_deletion_journal_binding";
// This table contains only a built-in schema upgrade marker, never application/user data.
const SCHEMA_METADATA = new Set(["im_identity_migrations"]);
const REQUIRED_TABLES = [
  "user",
  "im_workspaces",
  "im_members",
  "im_rooms",
  "im_recordings",
  "im_recording_analysis",
  BINDING_TABLE,
];
const quote = (identifier: string) =>
  '"' + identifier.replaceAll('"', '""') + '"';

function validateAuthority(authority: DeletionAuthority) {
  if (
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(
      authority.journalId,
    ) ||
    !/^[a-f0-9]{64}$/.test(authority.genesisSha256)
  )
    throw new Error("Invalid deletion-journal authority");
}
function matching(existing: Binding, authority: DeletionAuthority) {
  if (
    existing.journal_id !== authority.journalId ||
    existing.genesis_sha256 !== authority.genesisSha256
  )
    throw new Error(
      "Database deletion-journal authority mismatch; a new journal cannot replace backup history",
    );
  return existing;
}
async function lockedBinding(db: PoolClient, authority: DeletionAuthority) {
  validateAuthority(authority);
  await db.query("SET LOCAL statement_timeout='15s'");
  await db.query("SET LOCAL lock_timeout='5s'");
  const namespace = (await db.query("SELECT current_schema() AS name")).rows[0]
    ?.name as string | undefined;
  if (!namespace)
    throw new Error("Deletion authority requires a migrated database schema");
  const tables = (
    await db.query<Table>(
      "SELECT c.relname AS name,c.relkind::text AS kind,c.relrowsecurity AS row_security FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p','m','f') ORDER BY c.relname",
      [namespace],
    )
  ).rows;
  if (
    tables.length > 256 ||
    REQUIRED_TABLES.some(
      (name) =>
        !tables.some(
          (table) => table.name === name && ["r", "p"].includes(table.kind),
        ),
    )
  )
    throw new Error(
      "Apply database migrations before binding deletion authority",
    );
  const relation = quote(namespace) + "." + quote(BINDING_TABLE);
  // Concurrent startups/enrollment serialize here. The row is never updated or replaced.
  await db.query("LOCK TABLE " + relation + " IN EXCLUSIVE MODE");
  const existing = (
    await db.query<Binding>(
      "SELECT journal_id,genesis_sha256,enrollment_mode,baseline_approval_sha256 FROM " +
        relation +
        " WHERE singleton=1",
    )
  ).rows[0];
  if (existing)
    return {
      relation,
      namespace,
      tables,
      existing: matching(existing, authority),
    };
  return { relation, namespace, tables, existing: undefined };
}
async function lockAndProveEmpty(
  db: PoolClient,
  namespace: string,
  tables: Table[],
) {
  const application = tables.filter(
    (table) => table.name !== BINDING_TABLE && !SCHEMA_METADATA.has(table.name),
  );
  // Hidden rows, foreign data, or materialized data cannot establish a fresh empty database.
  if (
    application.some(
      (table) => table.row_security || !["r", "p"].includes(table.kind),
    )
  )
    throw new Error(
      "An empty-database proof is unavailable; a reviewed baseline enrollment is required",
    );
  if (application.length)
    await db.query(
      "LOCK TABLE " +
        application
          .map((table) => quote(namespace) + "." + quote(table.name))
          .join(",") +
        " IN SHARE MODE",
    );
  for (const table of application) {
    const relation = quote(namespace) + "." + quote(table.name);
    if (
      (
        await db.query<{ present: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM " + relation + " LIMIT 1) AS present",
        )
      ).rows[0]?.present
    )
      throw new Error(
        "Existing database has no deletion authority binding; explicit reviewed baseline enrollment is required",
      );
  }
}
async function insertBinding(
  db: PoolClient,
  relation: string,
  authority: DeletionAuthority,
  mode: Binding["enrollment_mode"],
  approval: string | null,
) {
  const result = await db.query<Binding>(
    "INSERT INTO " +
      relation +
      "(singleton,journal_id,genesis_sha256,enrollment_mode,baseline_approval_sha256) VALUES(1,$1,$2,$3,$4) RETURNING journal_id,genesis_sha256,enrollment_mode,baseline_approval_sha256",
    [authority.journalId, authority.genesisSha256, mode, approval],
  );
  return result.rows[0]!;
}

/** No non-empty database or existing binding is silently re-enrolled at startup. */
export async function ensureDeletionJournalBinding(
  pool: Pool,
  authority: DeletionAuthority,
): Promise<Binding> {
  return transaction(pool, async (db) => {
    const state = await lockedBinding(db, authority);
    if (state.existing) return state.existing;
    await lockAndProveEmpty(db, state.namespace, state.tables);
    return insertBinding(db, state.relation, authority, "empty-database", null);
  });
}

/**
 * Operator-only bootstrap for a reviewed new baseline of a pre-journal database.
 * It cannot rotate an existing authority and is never called by application startup.
 * A fresh independent proof and approval evidence are required by the CLI.
 */
export async function enrollReviewedDeletionBaseline(
  pool: Pool,
  authority: DeletionAuthority,
  approvalSha256: string,
): Promise<Binding> {
  if (!/^[a-f0-9]{64}$/.test(approvalSha256))
    throw new Error("An accepted baseline evidence SHA256 is required");
  return transaction(pool, async (db) => {
    const state = await lockedBinding(db, authority);
    if (state.existing) return state.existing;
    // Enrollment must be performed with old writers stopped/fenced; locks make the binding point atomic.
    const relations = state.tables.filter(
      (table) =>
        table.name !== BINDING_TABLE && ["r", "p"].includes(table.kind),
    );
    if (relations.length)
      await db.query(
        "LOCK TABLE " +
          relations
            .map((table) => quote(state.namespace) + "." + quote(table.name))
            .join(",") +
          " IN SHARE MODE",
      );
    return insertBinding(
      db,
      state.relation,
      authority,
      "reviewed-baseline",
      approvalSha256,
    );
  });
}
