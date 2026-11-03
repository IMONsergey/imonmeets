import { Pool } from "pg";
import { apiRuntime } from "./api-runtime.mjs";

if (
  process.argv.length !== 5 ||
  process.argv[2] !== "--enroll-reviewed-baseline" ||
  process.argv[3] !== "--approval-sha256" ||
  !/^[a-f0-9]{64}$/.test(process.argv[4])
)
  throw new Error(
    "Usage: node scripts/enroll-deletion-baseline.mjs --enroll-reviewed-baseline --approval-sha256 <accepted-baseline-evidence-sha256>",
  );
if (!process.env.DATABASE_URL)
  throw new Error("Private DATABASE_URL is required");
const [
  { loadDeletionConfig, openDeletionJournal },
  { enrollReviewedDeletionBaseline },
] = await Promise.all([
  apiRuntime("deletion-journal"),
  apiRuntime("deletion-binding"),
]);
const config = loadDeletionConfig();
const journal = await openDeletionJournal(config);
if (!journal) throw new Error("Prepared deletion journal is required");
const snapshot = await journal.snapshot();
if (
  !(await journal.verifyIndependentCheckpoint(snapshot, {
    recoverPending: false,
  }))
)
  throw new Error(
    "A fresh independent complete-head proof is required before baseline enrollment",
  );
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
try {
  const binding = await enrollReviewedDeletionBaseline(
    pool,
    journal.identity,
    process.argv[4],
  );
  console.log(
    JSON.stringify({
      checkedAt: new Date().toISOString(),
      bound: true,
      mode: binding.enrollment_mode,
      authorityRotation: false,
    }),
  );
} finally {
  await pool.end();
}
