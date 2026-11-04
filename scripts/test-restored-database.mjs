import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { apiRuntime } from "./api-runtime.mjs";
import {
  catalogSql,
  bindingSql,
  verifyRestoredDatabase,
  loadCanonicalAuthority,
  dockerReadOnlyQuery,
  hostAuthorityEnvironment,
} from "./check-restored-database.mjs";

const database = "imonmeets_restore_offline_test";
const authority = {
  journalId: "65ca3078-bc3f-4be1-82a2-965e04a3bcd0",
  genesisSha256: "a".repeat(64),
};
const binding = {
  singleton: 1,
  journal_id: authority.journalId,
  genesis_sha256: authority.genesisSha256,
  enrollment_mode: "reviewed-baseline",
  baseline_approval_sha256: "b".repeat(64),
  bound_at: "2026-11-04T11:45:00+00:00",
};
const tables = ["im_deletion_journal_binding", "im_future_table", "user"].map(
  (name) => ({
    name,
    kind: "r",
    columns: [{ name: "id", type: "text", notNull: true }],
    constraints: [],
    indexes: [],
    rowSecurity: false,
  }),
);
function fixture(change = {}) {
  const calls = [];
  const reference = structuredClone(tables),
    restored = structuredClone(tables);
  const liveBinding = structuredClone([binding]),
    restoredBinding = structuredClone([binding]);
  const state = { reference, restored, liveBinding, restoredBinding };
  Object.assign(state, change);
  const query = (target, sql) => {
    calls.push({ target, sql });
    if (sql === catalogSql)
      return {
        database: target,
        tables: state[target === "imonmeets" ? "reference" : "restored"],
      };
    if (sql === bindingSql)
      return state[target === "imonmeets" ? "liveBinding" : "restoredBinding"];
    assert.equal(target, database, "Live row counts must not be queried");
    assert.match(
      sql,
      /^SELECT json_build_object\('rows',count\(\*\)::text\) FROM public\."/,
    );
    return { rows: "0" };
  };
  return {
    state,
    calls,
    options: { database, query, loadAuthority: async () => authority },
  };
}
test("counts every dynamically discovered table and verifies current schema plus canonical binding", async () => {
  const f = fixture();
  const result = await verifyRestoredDatabase(f.options);
  assert.equal(result.status, "SQL_RESTORE_VERIFIED");
  assert.deepEqual(
    Object.keys(result.rowCounts),
    tables.map((t) => t.name),
  );
  assert.equal(result.rowCounts.im_future_table, "0");
  assert.equal(result.canonicalBindingMatched, true);
  assert.equal(result.servingAuthorized, false);
  assert.equal(result.replayPerformed, false);
});
test("rejects application/unsafe target names before any query", async () => {
  for (const target of [
    "imonmeets",
    "postgres",
    "imonmeets_restore_x;DROP DATABASE imonmeets",
  ]) {
    const f = fixture();
    await assert.rejects(
      verifyRestoredDatabase({ ...f.options, database: target }),
      /separately created/,
    );
    assert.equal(f.calls.length, 0);
  }
});
test("missing tables, changed columns, constraints and indexes cannot pass", async () => {
  const edits = [
    (s) => s.restored.pop(),
    (s) => {
      s.restored[0].columns[0].type = "integer";
    },
    (s) => {
      s.restored[0].constraints.push({ definition: "CHECK (false)" });
    },
    (s) => {
      s.restored[0].indexes.push("different index");
    },
  ];
  for (const edit of edits) {
    const f = fixture();
    edit(f.state);
    await assert.rejects(
      verifyRestoredDatabase(f.options),
      /differ from the current/,
    );
  }
});
test("rejects absent/duplicate binding, replacement authority and changed approval", async () => {
  for (const value of [
    [],
    [binding, binding],
    [{ ...binding, journal_id: "75ca3078-bc3f-4be1-82a2-965e04a3bcd0" }],
    [{ ...binding, baseline_approval_sha256: "c".repeat(64) }],
    [{ ...binding, bound_at: "2026-11-04T11:46:00+00:00" }],
  ]) {
    const f = fixture({ restoredBinding: value });
    await assert.rejects(
      verifyRestoredDatabase(f.options),
      /binding|required|authority|approval/i,
    );
  }
  const wrong = { ...binding, genesis_sha256: "c".repeat(64) };
  const f = fixture({ liveBinding: [wrong], restoredBinding: [wrong] });
  await assert.rejects(
    verifyRestoredDatabase(f.options),
    /HMAC-validated canonical/,
  );
});
test("legacy archive inspection requires explicit mode and never authorizes serving", async () => {
  const oldTables = structuredClone(
    tables.filter((t) => t.name !== "im_deletion_journal_binding"),
  );
  const f = fixture({ reference: oldTables, restored: oldTables });
  await assert.rejects(verifyRestoredDatabase(f.options), /legacy archives/);
  f.calls.length = 0;
  const result = await verifyRestoredDatabase({
    ...f.options,
    offlineInspection: true,
    loadAuthority: async () => {
      throw Error(
        "Must not enroll or use canonical authority in legacy inspection",
      );
    },
  });
  assert.equal(result.status, "OFFLINE_INSPECTION_ONLY");
  assert.equal(result.servingAuthorized, false);
  assert.equal(result.canonicalBindingMatched, false);
  assert.ok(
    f.calls.every(
      (call) => call.target === database && call.sql !== bindingSql,
    ),
  );
});
test("canonical authority uses actual HMAC verification and rejects tampered metadata and symlink env", async (t) => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "imon-restore-authority-"));
  await fs.chmod(dir, 0o700);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const api = await apiRuntime("deletion-journal"),
    journal = path.join(dir, "journal");
  const key = "synthetic-readonly-restore-test-key-at-least32";
  await api.initializeDeletionJournal({ directory: journal, key });
  const env = path.join(dir, "private.env");
  await fs.writeFile(
    env,
    "DELETION_JOURNAL_DIR=" + journal + "\nDELETION_JOURNAL_KEY=" + key + "\n",
    { mode: 0o600 },
  );
  const identity = await loadCanonicalAuthority(env);
  assert.match(identity.genesisSha256, /^[a-f0-9]{64}$/);
  const metadata = path.join(journal, "metadata.json");
  const value = JSON.parse(await fs.readFile(metadata, "utf8"));
  value.body.createdAt++;
  await fs.writeFile(metadata, api.canonicalJson(value) + "\n");
  await assert.rejects(loadCanonicalAuthority(env), /integrity/);
  const link = path.join(dir, "linked.env");
  await fs.symlink(env, link);
  await assert.rejects(loadCanonicalAuthority(link));
});
test("SQL adapter enforces read-only transactions and shell cleanup targets only its generated database", async (t) => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "imon-restore-shell-"));
  await fs.chmod(dir, 0o700);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const trace = path.join(dir, "trace.jsonl"),
    docker = path.join(dir, "docker"),
    fakeNode = path.join(dir, "fake-node");
  await fs.writeFile(
    docker,
    "#!/usr/bin/env node\n" +
      "const fs=require('node:fs');const args=process.argv.slice(2),input=fs.readFileSync(0,'utf8');fs.appendFileSync(process.env.IMON_RESTORE_TEST_TRACE,JSON.stringify({args,input})+'\\n');if(args.includes('psql'))console.log(JSON.stringify({rows:'4'}));if(args.includes('dropdb')&&process.env.IMON_RESTORE_TEST_DROP_FAIL)process.exit(5);\n",
    { mode: 0o700 },
  );
  await fs.writeFile(
    fakeNode,
    "#!/usr/bin/env node\nprocess.exit(Number(process.env.IMON_RESTORE_TEST_NODE_EXIT ?? 7));\n",
    {
      mode: 0o700,
    },
  );
  const originalPath = process.env.PATH,
    originalTrace = process.env.IMON_RESTORE_TEST_TRACE;
  process.env.PATH = dir + ":" + originalPath;
  process.env.IMON_RESTORE_TEST_TRACE = trace;
  try {
    assert.deepEqual(
      dockerReadOnlyQuery(database, "SELECT json_build_object('rows','4');"),
      { rows: "4" },
    );
    const first = JSON.parse((await fs.readFile(trace, "utf8")).trim());
    assert.match(first.input, /^BEGIN READ ONLY;/);
    assert.match(first.input, /statement_timeout='10s'/);
    assert.match(first.input, /ROLLBACK;/);
    const dump = path.join(dir, "synthetic.dump");
    await fs.writeFile(dump, "offline fake archive");
    const script = fileURLToPath(
      new URL("./restore-check.sh", import.meta.url),
    );
    const result = spawnSync("bash", [script, dump], {
      encoding: "utf8",
      input: "",
      env: { ...process.env, IMON_RESTORE_NODE: fakeNode },
    });
    assert.equal(result.status, 7, result.stderr);
    for (const originalExit of [0, 7]) {
      const failedCleanup = spawnSync("bash", [script, dump], {
        encoding: "utf8",
        input: "",
        env: {
          ...process.env,
          IMON_RESTORE_NODE: fakeNode,
          IMON_RESTORE_TEST_NODE_EXIT: String(originalExit),
          IMON_RESTORE_TEST_DROP_FAIL: "1",
        },
      });
      assert.equal(
        failedCleanup.status,
        originalExit || 1,
        failedCleanup.stderr,
      );
      assert.match(
        failedCleanup.stderr,
        /Cleanup failed for disposable database imonmeets_restore_/,
      );
    }
    const calls = (await fs.readFile(trace, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    const create = calls.find((call) => call.args.includes("createdb"));
    const drop = calls.find((call) => call.args.includes("dropdb"));
    assert.ok(create && drop);
    const created = create.args.at(-1);
    assert.match(created, /^imonmeets_restore_[0-9]+_[0-9]+$/);
    assert.equal(drop.args.at(-1), created);
    assert.notEqual(created, "imonmeets");
    assert.ok(
      calls.some(
        (call) =>
          call.args.includes("pg_restore") &&
          call.args.includes("--exit-on-error"),
      ),
    );
  } finally {
    process.env.PATH = originalPath;
    if (originalTrace === undefined) delete process.env.IMON_RESTORE_TEST_TRACE;
    else process.env.IMON_RESTORE_TEST_TRACE = originalTrace;
  }
});

test("effective Compose resolver maps the canonical container directory to its unique host bind", () => {
  const publicKey = generateKeyPairSync("ed25519").publicKey.export({
    type: "spki",
    format: "pem",
  });
  const model = {
    services: {
      app: {
        environment: {
          DELETION_JOURNAL_DIR: "/container/journal",
          DELETION_JOURNAL_KEY: "s".repeat(32),
          DELETION_WITNESS_PUBLIC_KEY: publicKey,
          DELETION_WITNESS_TOKEN: "t".repeat(32),
          GOOGLE_CLIENT_SECRET: "unrelated-must-not-be-selected",
        },
        volumes: [
          {
            type: "bind",
            target: "/container/journal",
            source: "/private/host/journal",
          },
        ],
      },
    },
  };
  const env = hostAuthorityEnvironment(model);
  assert.equal(env.DELETION_JOURNAL_DIR, "/private/host/journal");
  assert.equal(env.DELETION_WITNESS_PUBLIC_KEY, publicKey);
  assert.equal(env.GOOGLE_CLIENT_SECRET, undefined);
  for (const edit of [
    (m) => {
      delete m.services.app.environment.DELETION_JOURNAL_KEY;
    },
    (m) => {
      delete m.services.app.environment.DELETION_WITNESS_PUBLIC_KEY;
    },
    (m) => {
      m.services.app.volumes[0].type = "volume";
    },
    (m) => {
      m.services.app.volumes.push({ ...m.services.app.volumes[0] });
    },
    (m) => {
      m.services.app.volumes[0].target = "/different";
    },
  ]) {
    const invalid = structuredClone(model);
    edit(invalid);
    assert.throws(() => hostAuthorityEnvironment(invalid));
  }
});
