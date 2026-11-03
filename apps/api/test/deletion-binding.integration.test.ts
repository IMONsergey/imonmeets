import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { harness } from "./suite-harness.js";
import {
  initializeDeletionJournal,
  loadDeletionConfig,
  openDeletionJournal,
} from "../src/deletion-journal.js";
import {
  ensureDeletionJournalBinding,
  enrollReviewedDeletionBaseline,
} from "../src/deletion-binding.js";
import { replayDeletionJournal } from "../src/deletion-replay.js";

const enabled = !!process.env.TEST_DATABASE_URL;
async function journalFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "imon-binding-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = {
    DELETION_JOURNAL_DIR: directory,
    DELETION_JOURNAL_KEY: "synthetic-binding-key-never-deployed-20261103",
  };
  const config = loadDeletionConfig(env);
  await initializeDeletionJournal(config);
  const journal = await openDeletionJournal(config);
  assert.ok(journal);
  return { journal, env };
}
async function databaseFixture(t: TestContext) {
  const h = await harness();
  t.after(() => h.close());
  return h;
}
test(
  "a migrated database proven empty is pinned once and its journal authority cannot change",
  { skip: !enabled, timeout: 30000 },
  async (t) => {
    const h = await databaseFixture(t),
      { journal } = await journalFixture(t);
    const [first, concurrent] = await Promise.all([
      ensureDeletionJournalBinding(h.pool, journal.identity),
      ensureDeletionJournalBinding(h.pool, journal.identity),
    ]);
    assert.deepEqual(
      concurrent,
      first,
      "concurrent first starts produce one immutable authority binding",
    );
    assert.equal(first.enrollment_mode, "empty-database");
    assert.equal(first.journal_id, journal.identity.journalId);
    assert.equal(first.genesis_sha256, journal.identity.genesisSha256);
    assert.equal(first.baseline_approval_sha256, null);
    assert.deepEqual(
      await ensureDeletionJournalBinding(h.pool, journal.identity),
      first,
    );
    await assert.rejects(
      () =>
        ensureDeletionJournalBinding(h.pool, {
          ...journal.identity,
          journalId: randomUUID(),
        }),
      /authority mismatch/,
    );
    await assert.rejects(
      () =>
        ensureDeletionJournalBinding(h.pool, {
          ...journal.identity,
          genesisSha256: "f".repeat(64),
        }),
      /authority mismatch/,
    );
    await assert.rejects(
      () =>
        enrollReviewedDeletionBaseline(
          h.pool,
          { ...journal.identity, journalId: randomUUID() },
          "a".repeat(64),
        ),
      /authority mismatch/,
    );
    assert.equal(
      (
        await h.pool.query(
          "SELECT count(*)::int AS n FROM im_deletion_journal_binding",
        )
      ).rows[0].n,
      1,
    );
  },
);
test(
  "a nonempty pre-journal database refuses startup until an explicit reviewed baseline is enrolled",
  { skip: !enabled, timeout: 30000 },
  async (t) => {
    const h = await databaseFixture(t),
      { journal } = await journalFixture(t);
    const user = await h.signup("baseline-review@example.test");
    await assert.rejects(
      () => ensureDeletionJournalBinding(h.pool, journal.identity),
      /reviewed baseline enrollment/,
    );
    assert.equal(
      (
        await h.pool.query(
          "SELECT count(*)::int AS n FROM im_deletion_journal_binding",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (await h.pool.query('SELECT id FROM "user" WHERE id=$1', [user.id]))
        .rowCount,
      1,
    );
    await assert.rejects(
      () =>
        enrollReviewedDeletionBaseline(
          h.pool,
          journal.identity,
          "not-an-approved-sha",
        ),
      /evidence SHA256/,
    );
    const binding = await enrollReviewedDeletionBaseline(
      h.pool,
      journal.identity,
      "a".repeat(64),
    );
    assert.equal(binding.enrollment_mode, "reviewed-baseline");
    assert.equal(binding.baseline_approval_sha256, "a".repeat(64));
    assert.deepEqual(
      await ensureDeletionJournalBinding(h.pool, journal.identity),
      binding,
    );
  },
);
test(
  "fresh empty local and external journals cannot replace the authority restored with a populated database",
  { skip: !enabled, timeout: 30000 },
  async (t) => {
    const h = await databaseFixture(t),
      original = await journalFixture(t),
      replacement = await journalFixture(t);
    await ensureDeletionJournalBinding(h.pool, original.journal.identity);
    const user = await h.signup("binding-kept-in-backup@example.test");
    const workspace = await h.workspace(user.cookie);
    let checkpointContacted = false;
    replacement.journal.verifyIndependentCheckpoint = async () => {
      checkpointContacted = true;
      return true;
    };
    await h.app.close();
    await assert.rejects(
      () => replayDeletionJournal(h.pool, replacement.journal, h.media, h.c),
      /authority mismatch/,
    );
    assert.equal(
      checkpointContacted,
      false,
      "mismatched database authority is rejected before any fresh external proof can legitimize it",
    );
    const newConfig = { ...h.c, deletionJournal: replacement.journal.config };
    await assert.rejects(
      () =>
        createApp(newConfig, { pool: h.pool, media: h.media, logger: false }),
      /authority mismatch/,
    );
    assert.equal(
      (await h.pool.query('SELECT id FROM "user" WHERE id=$1', [user.id]))
        .rowCount,
      1,
    );
    assert.equal(
      (
        await h.pool.query("SELECT id FROM im_workspaces WHERE id=$1", [
          workspace.id,
        ])
      ).rowCount,
      1,
    );
    const binding = (
      await h.pool.query(
        "SELECT journal_id,genesis_sha256 FROM im_deletion_journal_binding",
      )
    ).rows[0];
    assert.equal(binding.journal_id, original.journal.identity.journalId);
    assert.equal(
      binding.genesis_sha256,
      original.journal.identity.genesisSha256,
    );
  },
);
test(
  "losing a binding in an old populated snapshot fails closed and does not mint a replacement",
  { skip: !enabled, timeout: 30000 },
  async (t) => {
    const h = await databaseFixture(t),
      { journal } = await journalFixture(t);
    await ensureDeletionJournalBinding(h.pool, journal.identity);
    const user = await h.signup("binding-old-schema@example.test");
    await h.pool.query("DELETE FROM im_deletion_journal_binding");
    await h.app.close();
    await assert.rejects(
      () => replayDeletionJournal(h.pool, journal, h.media, h.c),
      /reviewed baseline enrollment/,
    );
    assert.equal(
      (
        await h.pool.query(
          "SELECT count(*)::int AS n FROM im_deletion_journal_binding",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (await h.pool.query('SELECT id FROM "user" WHERE id=$1', [user.id]))
        .rowCount,
      1,
    );
  },
);
test(
  "empty-database proof covers non-user tables and refuses row-security ambiguity",
  { skip: !enabled, timeout: 30000 },
  async (t) => {
    const h = await databaseFixture(t),
      { journal } = await journalFixture(t);
    await h.pool.query(
      "CREATE TABLE im_binding_nonuser_test(value text NOT NULL)",
    );
    await h.pool.query(
      "INSERT INTO im_binding_nonuser_test(value) VALUES('synthetic-existing-data')",
    );
    await assert.rejects(
      () => ensureDeletionJournalBinding(h.pool, journal.identity),
      /reviewed baseline enrollment/,
    );
    await h.pool.query("DELETE FROM im_binding_nonuser_test");
    await h.pool.query(
      "ALTER TABLE im_binding_nonuser_test ENABLE ROW LEVEL SECURITY",
    );
    await assert.rejects(
      () => ensureDeletionJournalBinding(h.pool, journal.identity),
      /empty-database proof/,
    );
    await h.pool.query(
      "ALTER TABLE im_binding_nonuser_test DISABLE ROW LEVEL SECURITY",
    );
    assert.equal(
      (await ensureDeletionJournalBinding(h.pool, journal.identity))
        .enrollment_mode,
      "empty-database",
    );
  },
);
