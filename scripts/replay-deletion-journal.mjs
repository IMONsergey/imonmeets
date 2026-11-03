import { apiRuntime } from "./api-runtime.mjs";
import { Pool } from "pg";
if (
  process.argv.length !== 3 ||
  process.argv[2] !== "--replay-isolated-restore"
)
  throw new Error(
    "Usage: node scripts/replay-deletion-journal.mjs --replay-isolated-restore (private isolated restore configuration)",
  );
const [
  { loadConfig },
  { openDeletionJournal },
  { replayDeletionJournal },
  { createMedia },
] = await Promise.all(
  ["config", "deletion-journal", "deletion-replay", "media"].map(apiRuntime),
);
const config = loadConfig();
// Operator confirmation is purpose-bound; startup uses the same replay automatically.
const target = new URL(config.databaseUrl);
if (!/^imonmeets_restore_[a-zA-Z0-9_]+$/.test(target.pathname.slice(1)))
  throw new Error(
    "Replay CLI accepts only a separately created imonmeets_restore_* database",
  );
if (!config.deletionJournal.required)
  throw new Error(
    "Restore replay CLI requires DELETION_RESTORE_REQUIRED=true and an independent receiver",
  );
const journal = await openDeletionJournal(config.deletionJournal);
if (!journal) throw new Error("Deletion journal is required");
const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
try {
  const result = await replayDeletionJournal(
    pool,
    journal,
    createMedia(config),
    config,
  );
  console.log(
    JSON.stringify({
      checkedAt: new Date().toISOString(),
      replayComplete: true,
      independentlyProtected: result.independentlyProtected,
      appliedIntents: result.replayed,
    }),
  );
} finally {
  await pool.end();
}
