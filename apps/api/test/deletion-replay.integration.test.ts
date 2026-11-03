import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../src/app.js";
import { harness, password } from "./suite-harness.js";
import {
  deletionTransaction,
  initializeDeletionJournal,
  loadDeletionConfig,
  openDeletionJournal,
} from "../src/deletion-journal.js";
import { replayDeletionJournal } from "../src/deletion-replay.js";

const enabled = !!process.env.TEST_DATABASE_URL;
async function fixture(t: TestContext, extra: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "imon-deletion-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = {
    DELETION_JOURNAL_DIR: directory,
    DELETION_JOURNAL_KEY: "synthetic-deletion-journal-key-only-20261103",
    RECORDING_ENABLED: "true",
    S3_BUCKET: "synthetic-recordings",
    S3_ACCESS_KEY_ID: "synthetic",
    S3_SECRET_ACCESS_KEY: "synthetic",
    S3_REGION: "us-east-1",
    ...extra,
  };
  const config = loadDeletionConfig(env);
  await initializeDeletionJournal(config);
  const journal = await openDeletionJournal(config);
  assert.ok(journal);
  const h = await harness(env);
  t.after(() => h.close());
  return { h, journal, directory, config };
}
async function recording(
  h: Awaited<ReturnType<typeof harness>>,
  workspaceId: string,
  roomId: string,
) {
  const id = randomUUID(),
    key = "recordings/" + workspaceId + "/" + id + ".mp4";
  await h.pool.query(
    "INSERT INTO im_recordings(id,workspace_id,room_id,status,object_key,size_bytes,ended_at,expires_at,egress_id) VALUES($1,$2,$3,'complete',$4,1024,now(),now()+interval '1 day','EG_synthetic_old_sidecar')",
    [id, workspaceId, roomId, key],
  );
  return { id, key };
}
async function addAnalysis(
  h: Awaited<ReturnType<typeof harness>>,
  workspaceId: string,
  recordingId: string,
  id = randomUUID(),
) {
  await h.pool.query(
    "INSERT INTO im_recording_analysis(recording_id,workspace_id,id,status,language,expires_at,result) VALUES($1,$2,$3,'complete','en',now()+interval '1 day',$4::jsonb)",
    [
      recordingId,
      workspaceId,
      id,
      JSON.stringify({
        text: "Synthetic private transcript",
        segments: [],
        language: "en",
        duration: 2,
        model: "historical-test-only",
      }),
    ],
  );
  return id;
}
function isolatedDumpArguments(h: Awaited<ReturnType<typeof harness>>) {
  const database = new URL(process.env.TEST_DATABASE_URL!);
  assert.equal(database.hostname, "127.0.0.1");
  assert.ok(
    Number(database.port) >= 1024,
    "only an explicitly mapped local disposable database is allowed",
  );
  assert.equal(database.pathname, "/imonmeets_test");
  const schema = /^-csearch_path=(im_suite_[a-f0-9]+)$/.exec(
    new URL(h.c.databaseUrl).searchParams.get("options") || "",
  )?.[1];
  assert.ok(schema, "only this test's isolated schema may be restored");
  const container = process.env.TEST_RESTORE_PG_CONTAINER;
  assert.ok(
    container && /^imonmeets-[a-z0-9-]*tests[a-z0-9-]*$/.test(container),
    "explicit disposable test-container name required",
  );
  return { schema, prefix: ["exec", "-i", container] };
}
function dockerInvocation(args: string[]) {
  return process.env.TEST_RESTORE_DOCKER_SUDO === "true"
    ? { command: "sudo", args: ["-n", "docker", ...args] }
    : { command: "docker", args };
}
async function restoreSql(prefix: string[], sql: string) {
  await new Promise<void>((resolve, reject) => {
    const invocation = dockerInvocation([
      ...prefix,
      "psql",
      "-U",
      "imonmeets_test",
      "-d",
      "imonmeets_test",
      "-v",
      "ON_ERROR_STOP=1",
    ]);
    const process = spawn(invocation.command, invocation.args, {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let error = "";
    process.stderr.setEncoding("utf8");
    process.stderr.on("data", (value: string) => {
      if (error.length < 4096) error += value;
    });
    const timer = setTimeout(() => {
      process.kill("SIGKILL");
      reject(new Error("Disposable restore exceeded timeout"));
    }, 20000);
    process.on("error", reject);
    process.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(new Error("Disposable restore failed: " + error));
    });
    process.stdin.on("error", reject);
    process.stdin.end(sql);
  });
}
test(
  "an actual old PostgreSQL dump cannot resurrect four manually deleted resource types",
  { skip: !enabled || !process.env.TEST_RESTORE_PG_CONTAINER, timeout: 60000 },
  async (t) => {
    const { h, journal, directory } = await fixture(t);
    const owner = await h.signup("journal-restore@example.test");
    const workspace = await h.workspace(owner.cookie);
    const room = await h.room(owner.cookie, workspace.id);
    const rec = await recording(h, workspace.id, room.id);
    await addAnalysis(h, workspace.id, rec.id);
    const { schema, prefix } = isolatedDumpArguments(h);
    const invocation = dockerInvocation([
      ...prefix,
      "pg_dump",
      "-U",
      "imonmeets_test",
      "-d",
      "imonmeets_test",
      "--schema=" + schema,
      "--no-owner",
      "--no-privileges",
    ]);
    const dumped = await promisify(execFile)(
      invocation.command,
      invocation.args,
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 20000 },
    );
    assert.ok(
      dumped.stdout.includes("CREATE TABLE"),
      "a real bounded pre-deletion dump was created",
    );
    const path = "/api/workspaces/" + workspace.id + "/recordings/" + rec.id;
    for (const [url, body] of [
      [path + "/transcript", undefined],
      [path, undefined],
      ["/api/workspaces/" + workspace.id, { password, confirmation: "DELETE" }],
      ["/api/me", { password, confirmation: "DELETE" }],
    ] as const) {
      const response = await h.request("DELETE", url, body, owner.cookie);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().deletion.state, "database_committed");
      assert.equal(
        response.json().deletion.independentAck,
        false,
        "local synthetic fixtures never claim offsite acknowledgement",
      );
    }
    const before = await journal.snapshot();
    assert.equal(before.version, 4);
    assert.deepEqual(
      new Set(before.intents.map((intent) => intent.body.target.kind)),
      new Set(["account", "workspace", "recording", "analysis"]),
    );
    assert.ok(
      before.intents.every((intent) => intent.state === "database_committed"),
    );
    const data = (
      await Promise.all(
        (await readdir(directory)).map((file) =>
          readFile(join(directory, file), "utf8"),
        ),
      )
    ).join("\n");
    assert.equal(data.includes(owner.email), false);
    assert.equal(data.includes("Synthetic private transcript"), false);
    await h.app.close();
    await h.pool.query('DROP SCHEMA "' + schema + '" CASCADE');
    await restoreSql(prefix, dumped.stdout);
    assert.equal(
      (await h.pool.query('SELECT id FROM "user" WHERE id=$1', [owner.id]))
        .rowCount,
      1,
      "old backup really resurrected the account before replay",
    );
    assert.equal(
      (
        await h.pool.query(
          "SELECT id FROM im_recording_analysis WHERE recording_id=$1",
          [rec.id],
        )
      ).rowCount,
      1,
    );
    const recovered = await createApp(h.c, {
      pool: h.pool,
      media: h.media,
      logger: false,
    });
    try {
      assert.equal(
        (await h.pool.query('SELECT id FROM "user" WHERE id=$1', [owner.id]))
          .rowCount,
        0,
        "startup replays before exposing an application instance",
      );
      assert.equal(
        (
          await h.pool.query("SELECT id FROM im_workspaces WHERE id=$1", [
            workspace.id,
          ])
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await h.pool.query("SELECT id FROM im_recordings WHERE id=$1", [
            rec.id,
          ])
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await h.pool.query(
            "SELECT id FROM im_recording_analysis WHERE recording_id=$1",
            [rec.id],
          )
        ).rowCount,
        0,
      );
      const denied = await recovered.inject({
        method: "GET",
        url: "/api/me",
        headers: { origin: h.c.appUrl, cookie: owner.cookie },
      });
      assert.equal(
        denied.statusCode,
        401,
        "restored old session cannot reach the recovered API",
      );
      assert.ok(
        h.deleted.includes(rec.key),
        "the recording object is removed through scoped private media cleanup",
      );
    } finally {
      await recovered.close();
    }
    const result = await replayDeletionJournal(h.pool, journal, h.media, h.c);
    assert.equal(result.replayed, 4);
    assert.equal(result.independentlyProtected, false);
    assert.equal(
      (await journal.snapshot()).headSha256,
      before.headSha256,
      "replay is idempotent and cannot rewrite journal authority",
    );
  },
);
test(
  "journal write failure prevents DB mutation and a later SQL rollback leaves an explicit pending intent",
  { skip: !enabled, timeout: 30000 },
  async (t) => {
    const { h, journal, directory } = await fixture(t);
    const user = await h.signup("journal-failure@example.test");
    const saved = directory + "-saved";
    await rename(directory, saved);
    await writeFile(directory, "not a journal directory", { mode: 0o600 });
    try {
      const result = await h.request(
        "DELETE",
        "/api/me",
        { password, confirmation: "DELETE" },
        user.cookie,
      );
      assert.equal(result.statusCode, 503, result.body);
      assert.equal(result.json().error.code, "DELETION_JOURNAL_UNAVAILABLE");
      assert.equal(
        (await h.pool.query('SELECT id FROM "user" WHERE id=$1', [user.id]))
          .rowCount,
        1,
      );
    } finally {
      await rm(directory, { force: true });
      await rename(saved, directory);
    }
    assert.equal((await journal.snapshot()).version, 0);
    await h.pool.query(
      "CREATE FUNCTION reject_synthetic_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic rollback after intent'; END $$",
    );
    await h.pool.query(
      'CREATE TRIGGER reject_synthetic_delete BEFORE DELETE ON "user" FOR EACH ROW EXECUTE FUNCTION reject_synthetic_delete()',
    );
    const pending = await h.request(
      "DELETE",
      "/api/me",
      { password, confirmation: "DELETE" },
      user.cookie,
    );
    assert.equal(pending.statusCode, 503, pending.body);
    assert.equal(pending.json().error.code, "DELETION_REQUEST_PENDING");
    assert.equal(
      (await h.pool.query('SELECT id FROM "user" WHERE id=$1', [user.id]))
        .rowCount,
      1,
    );
    const snapshot = await journal.snapshot();
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.intents[0]?.state, "pending");
    await h.pool.query('DROP TRIGGER reject_synthetic_delete ON "user"');
    await h.pool.query("DROP FUNCTION reject_synthetic_delete()");
    await h.app.close();
    await replayDeletionJournal(h.pool, journal, h.media, h.c);
    assert.equal(
      (await h.pool.query('SELECT id FROM "user" WHERE id=$1', [user.id]))
        .rowCount,
      0,
    );
    assert.equal(
      (await journal.snapshot()).intents[0]?.state,
      "database_committed",
    );
  },
);
test(
  "an independent receiver outage preserves the intent but never reaches the SQL mutation",
  { skip: !enabled, timeout: 30000 },
  async (t) => {
    const { h, journal, config } = await fixture(t);
    const user = await h.signup("journal-ack-outage@example.test");
    const request: typeof fetch = async () => {
      throw new Error("synthetic independent receiver outage");
    };
    const protectedJournal = await openDeletionJournal(
      {
        ...config,
        required: true,
        witnessUrl: "https://receiver.example.invalid",
        witnessToken: "synthetic-receiver-token-at-least-32",
        witnessPublicKey: "configured-but-never-used-during-outage",
      },
      request,
    );
    assert.ok(protectedJournal);
    let mutationReached = false;
    await assert.rejects(
      () =>
        deletionTransaction(h.pool, protectedJournal, async (db, record) => {
          await record({
            actorId: user.id,
            target: { kind: "account", accountId: user.id },
          });
          mutationReached = true;
          await db.query('DELETE FROM "user" WHERE id=$1', [user.id]);
        }),
      (error: unknown) =>
        (error as { code?: string }).code === "DELETION_REQUEST_PENDING",
    );
    assert.equal(mutationReached, false);
    assert.equal(
      (await h.pool.query('SELECT id FROM "user" WHERE id=$1', [user.id]))
        .rowCount,
      1,
    );
    assert.equal((await journal.snapshot()).intents[0]?.state, "pending");
    assert.equal(
      (await journal.snapshot()).intents[0]?.independentlyAcknowledged,
      false,
    );
  },
);
test(
  "workspace ownership is rechecked under the transaction lock before any intent is written",
  { skip: !enabled, timeout: 30000 },
  async (t) => {
    const { h, journal } = await fixture(t);
    const owner = await h.signup("journal-old-owner@example.test"),
      successor = await h.signup("journal-new-owner@example.test");
    const workspace = await h.workspace(owner.cookie);
    await h.pool.query(
      "INSERT INTO im_members(id,workspace_id,user_id,role) VALUES($1,$2,$3,'member')",
      [randomUUID(), workspace.id, successor.id],
    );
    const denied = await h.request(
      "DELETE",
      "/api/workspaces/" + workspace.id,
      { password, confirmation: "DELETE" },
      successor.cookie,
    );
    assert.equal(denied.statusCode, 403, denied.body);
    assert.equal((await journal.snapshot()).version, 0);
    const blocker = await h.pool.connect();
    let pending: ReturnType<typeof h.request> | undefined;
    try {
      await blocker.query("BEGIN");
      const pid = (await blocker.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid;
      await blocker.query(
        "SELECT id FROM im_workspaces WHERE id=$1 FOR NO KEY UPDATE",
        [workspace.id],
      );
      pending = h.request(
        "DELETE",
        "/api/workspaces/" + workspace.id,
        { password, confirmation: "DELETE" },
        owner.cookie,
      );
      let waiting = false;
      for (let attempt = 0; attempt < 400; attempt++) {
        if (
          (
            await h.pool.query(
              "SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) LIMIT 1",
              [pid],
            )
          ).rowCount
        ) {
          waiting = true;
          break;
        }
        await delay(5);
      }
      assert.ok(
        waiting,
        "the deletion must actually wait behind the ownership-changing lock",
      );
      await blocker.query(
        "UPDATE im_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2",
        [workspace.id, owner.id],
      );
      await blocker.query(
        "UPDATE im_members SET role='owner' WHERE workspace_id=$1 AND user_id=$2",
        [workspace.id, successor.id],
      );
      await blocker.query("COMMIT");
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
    }
    assert.ok(pending);
    const response = await pending;
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(
      (await journal.snapshot()).version,
      0,
      "a formerly authorized owner cannot create a deletion intent after losing ownership",
    );
    assert.equal(
      (
        await h.pool.query("SELECT id FROM im_workspaces WHERE id=$1", [
          workspace.id,
        ])
      ).rowCount,
      1,
    );
  },
);
test(
  "analysis replay preserves a later legitimate generation and refuses a mismatched recording object path",
  { skip: !enabled, timeout: 30000 },
  async (t) => {
    const { h, journal } = await fixture(t);
    const owner = await h.signup("journal-generation@example.test"),
      workspace = await h.workspace(owner.cookie),
      room = await h.room(owner.cookie, workspace.id);
    const rec = await recording(h, workspace.id, room.id);
    const old = await addAnalysis(h, workspace.id, rec.id);
    const deleted = await h.request(
      "DELETE",
      "/api/workspaces/" +
        workspace.id +
        "/recordings/" +
        rec.id +
        "/transcript",
      undefined,
      owner.cookie,
    );
    assert.equal(deleted.statusCode, 200, deleted.body);
    const newer = await addAnalysis(h, workspace.id, rec.id);
    assert.notEqual(old, newer);
    await h.app.close();
    await replayDeletionJournal(h.pool, journal, h.media, h.c);
    assert.equal(
      (
        await h.pool.query(
          "SELECT id FROM im_recording_analysis WHERE recording_id=$1",
          [rec.id],
        )
      ).rows[0].id,
      newer,
    );
    await journal.recordAuthorizedIntent({
      actorId: owner.id,
      target: {
        kind: "recording",
        workspaceId: workspace.id,
        recordingId: rec.id,
      },
    });
    await h.pool.query(
      "UPDATE im_recordings SET object_key='../unrelated-private-object' WHERE id=$1",
      [rec.id],
    );
    const count = h.deleted.length;
    await assert.rejects(
      () => replayDeletionJournal(h.pool, journal, h.media, h.c),
      /scope/,
    );
    assert.equal(
      h.deleted.length,
      count,
      "corrupt restored keys never become arbitrary S3 deletions",
    );
  },
);
test(
  "a restored account ownership conflict blocks startup replay instead of inventing a new owner",
  { skip: !enabled, timeout: 30000 },
  async (t) => {
    const { h, journal } = await fixture(t);
    const owner = await h.signup("journal-ownership-conflict@example.test"),
      workspace = await h.workspace(owner.cookie);
    // Represents an authorized deletion after a transfer absent from this older DB snapshot.
    const intent = await journal.recordAuthorizedIntent({
      actorId: owner.id,
      target: { kind: "account", accountId: owner.id },
    });
    await journal.markCommitted(intent);
    await h.app.close();
    await assert.rejects(
      () => replayDeletionJournal(h.pool, journal, h.media, h.c),
      /ownership-transfer history/,
    );
    assert.equal(
      (await h.pool.query('SELECT id FROM "user" WHERE id=$1', [owner.id]))
        .rowCount,
      1,
    );
    assert.equal(
      (
        await h.pool.query(
          "SELECT user_id FROM im_members WHERE workspace_id=$1 AND role='owner'",
          [workspace.id],
        )
      ).rows[0].user_id,
      owner.id,
    );
  },
);
