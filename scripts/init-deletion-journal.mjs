import { apiRuntime } from "./api-runtime.mjs";
const { initializeDeletionJournal, loadDeletionConfig, openDeletionJournal } =
  await apiRuntime("deletion-journal");
if (process.argv.length !== 3 || process.argv[2] !== "--initialize")
  throw new Error(
    "Usage: node scripts/init-deletion-journal.mjs --initialize (private DELETION_JOURNAL_DIR/KEY environment)",
  );
await initializeDeletionJournal(loadDeletionConfig());
const journal = await openDeletionJournal(loadDeletionConfig());
const snapshot = await journal.snapshot();
// Export metadata.json directly through the private deployment channel for receiver enrollment.
console.log(
  JSON.stringify({
    initialized: true,
    empty: snapshot.version === 0,
    independentReceiverEnrolled: false,
  }),
);
