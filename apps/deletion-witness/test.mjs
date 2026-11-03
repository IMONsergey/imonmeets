import test from "node:test";
import assert from "node:assert/strict";
import {
  createHmac,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  verify,
} from "node:crypto";
import * as fs from "node:fs/promises";
import { fstatSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  digest,
  initializeWitnessStorage,
  createWitnessStore,
  createWitnessServer,
} from "./server.mjs";

const key = "isolated-test-journal-key-never-deployed-20261103";
const token = "isolated-test-receiver-token-never-deployed-20261103";
const nonce = () => randomBytes(32).toString("base64url");
const wrap = (body) => ({
  body,
  mac: createHmac("sha256", key).update(canonicalJson(body)).digest("hex"),
});
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "imon-witness-test-"));
  await fs.chmod(directory, 0o700);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const pair = generateKeyPairSync("ed25519");
  const genesis = wrap({
    schema: 1,
    journalId: randomUUID(),
    createdAt: Date.now(),
  });
  const config = {
    directory,
    journalId: genesis.body.journalId,
    genesisSha256: digest(genesis),
    genesis,
    journalKey: key,
    signingKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
  };
  await initializeWitnessStorage(config);
  const store = await createWitnessStore(config);
  const intent = (target) =>
    wrap({
      schema: 1,
      journalId: config.journalId,
      id: randomUUID(),
      requestedAt: Date.now(),
      actorId: "synthetic_user",
      target: target || { kind: "account", accountId: "synthetic_user" },
    });
  return { directory, pair, genesis, config, store, intent };
}
function checkProof(proof, publicKey, expectedNonce) {
  assert.equal(
    verify(
      null,
      Buffer.from(canonicalJson(proof.body)),
      publicKey,
      Buffer.from(proof.signature, "base64url"),
    ),
    true,
  );
  assert.equal(proof.body.nonce, expectedNonce);
  assert.equal(proof.body.storage, "independent-durable");
  assert.ok(
    proof.body.expiresAt > Date.now() &&
      proof.body.expiresAt - proof.body.issuedAt <= 60_000,
  );
}

test("enrolled empty journal has a verifiable checkpoint before the first deletion", async (t) => {
  const f = await fixture(t),
    n = nonce();
  const proof = await f.store.checkpoint({
    journalId: f.config.journalId,
    nonce: n,
  });
  checkProof(proof, f.pair.publicKey, n);
  assert.equal(proof.body.version, 0);
  assert.equal(
    proof.body.headSha256,
    digest({
      journalId: f.config.journalId,
      genesisSha256: digest(f.genesis),
      entries: [],
    }),
  );
  assert.equal(
    (await fs.stat(path.join(f.directory, "metadata.json"))).mode & 0o777,
    0o600,
  );
  await assert.rejects(
    createWitnessStore({ ...f.config, genesisSha256: "a".repeat(64) }),
    /GENESIS_ENROLLMENT_MISMATCH/,
  );
});

test("durable append is idempotent; a reused ID cannot replace approved bytes", async (t) => {
  const f = await fixture(t),
    record = f.intent(),
    n = nonce();
  const first = await f.store.append({
    nonce: n,
    genesis: f.genesis,
    intent: record,
  });
  checkProof(first, f.pair.publicKey, n);
  assert.equal(first.body.intentSha256, digest(record));
  assert.equal(first.body.version, 1);
  assert.equal(
    await fs.readFile(
      path.join(f.directory, record.body.id + ".intent.json"),
      "utf8",
    ),
    canonicalJson(record) + "\n",
  );
  const second = await f.store.append({
    nonce: nonce(),
    genesis: f.genesis,
    intent: record,
  });
  assert.equal(second.body.version, 1);
  assert.equal(second.body.headSha256, first.body.headSha256);
  await assert.rejects(
    f.store.append({
      nonce: nonce(),
      genesis: f.genesis,
      intent: wrap({
        ...record.body,
        requestedAt: record.body.requestedAt + 1,
      }),
    }),
    /IMMUTABLE_RECORD_CONFLICT/,
  );
});

test("concurrent intents survive receiver restart and contribute to the complete head", async (t) => {
  const f = await fixture(t);
  const records = [
    f.intent(),
    f.intent({
      kind: "recording",
      workspaceId: randomUUID(),
      recordingId: randomUUID(),
      egressId: "EG_synthetic_123",
    }),
  ];
  const proofs = await Promise.all(
    records.map((intent) =>
      f.store.append({ nonce: nonce(), genesis: f.genesis, intent }),
    ),
  );
  assert.deepEqual(proofs.map((p) => p.body.version).sort(), [1, 2]);
  const reopened = await createWitnessStore(f.config);
  const proof = await reopened.checkpoint({
    journalId: f.config.journalId,
    nonce: nonce(),
  });
  const entries = records
    .map((record) => ({ id: record.body.id, sha256: digest(record) }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  assert.equal(proof.body.version, 2);
  assert.equal(
    proof.body.headSha256,
    digest({
      journalId: f.config.journalId,
      genesisSha256: digest(f.genesis),
      entries,
    }),
  );
  assert.equal(proof.body.intentId, undefined);
});

test("missing or corrupted durable files cannot be hidden by a cached in-memory head", async (t) => {
  const f = await fixture(t),
    record = f.intent();
  await f.store.append({ nonce: nonce(), genesis: f.genesis, intent: record });
  const target = path.join(f.directory, record.body.id + ".intent.json");
  await fs.unlink(target);
  await assert.rejects(
    f.store.checkpoint({ journalId: f.config.journalId, nonce: nonce() }),
    /DURABLE_INTENT_MISSING/,
  );
  await fs.writeFile(
    target,
    canonicalJson(wrap({ ...record.body, actorId: "changed" })) + "\n",
    { mode: 0o600 },
  );
  await assert.rejects(
    f.store.checkpoint({ journalId: f.config.journalId, nonce: nonce() }),
    /DURABLE_INTENT_CHANGED/,
  );
  await assert.rejects(createWitnessStore(f.config));
});

test("directory replacement and unexpected files fail closed", async (t) => {
  const f = await fixture(t);
  const old = f.directory + "-old";
  t.after(() => fs.rm(old, { recursive: true, force: true }));
  await fs.rename(f.directory, old);
  await fs.mkdir(f.directory, { mode: 0o700 });
  await assert.rejects(
    f.store.checkpoint({ journalId: f.config.journalId, nonce: nonce() }),
    /STORAGE_DIRECTORY_CHANGED/,
  );
  await fs.writeFile(path.join(f.directory, "unexpected.txt"), "test", {
    mode: 0o600,
  });
  await assert.rejects(createWitnessStore(f.config), /UNEXPECTED_STORAGE_FILE/);
});

test("invalid MAC, foreign journals, traversal, extra fields and non-self account deletes are rejected", async (t) => {
  const f = await fixture(t),
    record = f.intent();
  for (const intent of [
    { ...record, mac: "0".repeat(64) },
    wrap({ ...record.body, journalId: randomUUID() }),
    wrap({ ...record.body, id: "../../escape" }),
    wrap({ ...record.body, extra: "not allowed" }),
    wrap({
      ...record.body,
      target: { kind: "account", accountId: "other_user" },
    }),
    wrap({
      ...record.body,
      target: {
        kind: "recording",
        workspaceId: randomUUID(),
        recordingId: randomUUID(),
        egressId: "../../path",
      },
    }),
  ]) {
    await assert.rejects(async () =>
      f.store.append({ nonce: nonce(), genesis: f.genesis, intent }),
    );
  }
  await assert.rejects(async () =>
    f.store.checkpoint({
      journalId: f.config.journalId,
      nonce: nonce(),
      headSha256: "a".repeat(64),
    }),
  );
  assert.equal(
    (await fs.readdir(f.directory)).filter((name) =>
      name.endsWith(".intent.json"),
    ).length,
    0,
  );
});

test("symlinked or permissive private records are rejected on restart", async (t) => {
  const f = await fixture(t);
  const metadata = path.join(f.directory, "metadata.json");
  await fs.chmod(metadata, 0o644);
  await assert.rejects(createWitnessStore(f.config), /INVALID_PRIVATE_FILE/);
  await fs.chmod(metadata, 0o600);
  const target = path.join(f.directory, randomUUID() + ".intent.json");
  await fs.symlink(metadata, target);
  await assert.rejects(
    createWitnessStore(f.config),
    /INVALID_STORAGE_CONTENTS/,
  );
});

test("HTTP receiver authenticates, bounds input and returns a signed actual durable acknowledgement", async (t) => {
  const f = await fixture(t),
    server = createWitnessServer(f.store, token);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = "http://127.0.0.1:" + server.address().port;
  const post = (route, body, auth = token) =>
    fetch(origin + route, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + auth,
      },
      body: JSON.stringify(body),
    });
  assert.equal((await post("/checkpoint", {}, "incorrect")).status, 401);
  assert.equal((await post("/unknown", {})).status, 404);
  assert.equal(
    (
      await post("/checkpoint", {
        journalId: f.config.journalId,
        nonce: nonce(),
        echoHead: "forged",
      })
    ).status,
    400,
  );
  assert.equal(
    (await post("/checkpoint", { padding: "x".repeat(37 * 1024) })).status,
    413,
  );
  const n = nonce(),
    record = f.intent({
      kind: "analysis",
      workspaceId: randomUUID(),
      recordingId: randomUUID(),
      analysisId: randomUUID(),
    });
  const response = await post("/intents", {
    nonce: n,
    genesis: f.genesis,
    intent: record,
  });
  assert.equal(response.status, 200);
  const proof = await response.json();
  checkProof(proof, f.pair.publicKey, n);
  assert.equal(proof.body.intentSha256, digest(record));
  assert.equal(JSON.stringify(proof).includes(key), false);
  assert.equal(JSON.stringify(proof).includes(token), false);
  assert.equal(JSON.stringify(proof).includes("synthetic_user"), false);
});

test("signed private high-water anchor is durable before each acknowledgement", async (t) => {
  const f = await fixture(t),
    anchorPath = path.join(f.directory, "high-water.json");
  const initialRaw = await fs.readFile(anchorPath, "utf8"),
    initial = JSON.parse(initialRaw);
  assert.equal(initialRaw, canonicalJson(initial) + "\n");
  assert.equal(initial.body.kind, "deletion-witness-high-water");
  assert.equal(initial.body.version, 0);
  assert.deepEqual(initial.body.entries, []);
  assert.equal(initial.body.genesisSha256, f.config.genesisSha256);
  assert.equal(
    verify(
      null,
      Buffer.from(canonicalJson(initial.body)),
      f.pair.publicKey,
      Buffer.from(initial.signature, "base64url"),
    ),
    true,
  );
  assert.equal((await fs.stat(anchorPath)).mode & 0o777, 0o600);
  const record = f.intent();
  const ack = await f.store.append({
    nonce: nonce(),
    genesis: f.genesis,
    intent: record,
  });
  const current = JSON.parse(await fs.readFile(anchorPath, "utf8"));
  assert.equal(current.body.version, ack.body.version);
  assert.equal(current.body.headSha256, ack.body.headSha256);
  assert.deepEqual(current.body.entries, [
    { id: record.body.id, sha256: digest(record) },
  ]);
  assert.equal(
    verify(
      null,
      Buffer.from(canonicalJson(current.body)),
      f.pair.publicKey,
      Buffer.from(current.signature, "base64url"),
    ),
    true,
  );
});

test("restart cannot shrink an anchored set or replace a missing intent with a different extra", async (t) => {
  const f = await fixture(t),
    first = f.intent(),
    second = f.intent(),
    extra = f.intent();
  for (const intent of [first, second])
    await f.store.append({ nonce: nonce(), genesis: f.genesis, intent });
  const anchorPath = path.join(f.directory, "high-water.json"),
    original = await fs.readFile(anchorPath, "utf8");
  await fs.unlink(path.join(f.directory, first.body.id + ".intent.json"));
  await fs.writeFile(
    path.join(f.directory, extra.body.id + ".intent.json"),
    canonicalJson(extra) + "\n",
    { mode: 0o600 },
  );
  await assert.rejects(createWitnessStore(f.config), /DURABLE_INTENT_MISSING/);
  await assert.rejects(f.store.health(), /DURABLE_INTENT_MISSING/);
  await assert.rejects(
    f.store.checkpoint({ journalId: f.config.journalId, nonce: nonce() }),
    /DURABLE_INTENT_MISSING/,
  );
  assert.equal(
    await fs.readFile(anchorPath, "utf8"),
    original,
    "failed recovery cannot shrink or rewrite authority",
  );
  // Restoring the exact missing bytes allows a monotonic union, including the
  // authenticated crash-extra; the imported inode is synced by startup.
  await fs.writeFile(
    path.join(f.directory, first.body.id + ".intent.json"),
    canonicalJson(first) + "\n",
    { mode: 0o600 },
  );
  const restored = await createWitnessStore(f.config);
  const complete = await restored.checkpoint({
    journalId: f.config.journalId,
    nonce: nonce(),
  });
  assert.equal(complete.body.version, 3);
});

test("missing whole storage or a replacement empty mount never auto-initializes", async (t) => {
  const f = await fixture(t),
    record = f.intent();
  await f.store.append({ nonce: nonce(), genesis: f.genesis, intent: record });
  await fs.rm(f.directory, { recursive: true });
  await assert.rejects(createWitnessStore(f.config));
  await assert.rejects(fs.lstat(f.directory), { code: "ENOENT" });
  await fs.mkdir(f.directory, { mode: 0o700 });
  await assert.rejects(createWitnessStore(f.config), /MISSING_DURABLE_GENESIS/);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test("missing anchor or genesis fails closed during operation and restart", async (t) => {
  for (const filename of ["high-water.json", "metadata.json"]) {
    await t.test(filename, async (t) => {
      const f = await fixture(t),
        record = f.intent();
      await f.store.append({
        nonce: nonce(),
        genesis: f.genesis,
        intent: record,
      });
      await fs.unlink(path.join(f.directory, filename));
      await assert.rejects(createWitnessStore(f.config), /MISSING_/);
      await assert.rejects(f.store.health(), /MISSING_/);
      await assert.rejects(
        f.store.checkpoint({ journalId: f.config.journalId, nonce: nonce() }),
        /MISSING_/,
      );
      await assert.rejects(
        f.store.append({
          nonce: nonce(),
          genesis: f.genesis,
          intent: f.intent(),
        }),
        /MISSING_/,
      );
      await assert.rejects(fs.lstat(path.join(f.directory, filename)), {
        code: "ENOENT",
      });
      await assert.rejects(
        initializeWitnessStorage(f.config),
        /ALREADY_INITIALIZED_OR_NOT_EMPTY/,
      );
    });
  }
});

test("wrong signing key and a tampered lower anchor cannot authorize restart", async (t) => {
  const f = await fixture(t),
    record = f.intent(),
    anchorPath = path.join(f.directory, "high-water.json");
  await f.store.append({ nonce: nonce(), genesis: f.genesis, intent: record });
  const original = await fs.readFile(anchorPath, "utf8");
  const different = generateKeyPairSync("ed25519");
  await assert.rejects(
    createWitnessStore({
      ...f.config,
      signingKey: different.privateKey.export({ type: "pkcs8", format: "pem" }),
    }),
    /INVALID_HIGH_WATER_ANCHOR/,
  );
  assert.equal(await fs.readFile(anchorPath, "utf8"), original);
  const tampered = JSON.parse(original);
  tampered.body.entries = [];
  tampered.body.version = 0;
  tampered.body.headSha256 = digest({
    journalId: f.config.journalId,
    genesisSha256: f.config.genesisSha256,
    entries: [],
  });
  await fs.writeFile(anchorPath, canonicalJson(tampered) + "\n");
  await assert.rejects(
    createWitnessStore(f.config),
    /INVALID_HIGH_WATER_ANCHOR/,
  );
  await assert.rejects(
    f.store.checkpoint({ journalId: f.config.journalId, nonce: nonce() }),
    /INVALID_HIGH_WATER_ANCHOR/,
  );
});

test("anchor must be a bounded private canonical regular file", async (t) => {
  await t.test("permissions", async (t) => {
    const f = await fixture(t);
    await fs.chmod(path.join(f.directory, "high-water.json"), 0o644);
    await assert.rejects(createWitnessStore(f.config), /INVALID_PRIVATE_FILE/);
  });
  await t.test("size", async (t) => {
    const f = await fixture(t);
    await fs.writeFile(
      path.join(f.directory, "high-water.json"),
      Buffer.alloc(2 * 1024 * 1024 + 1, 32),
    );
    await assert.rejects(createWitnessStore(f.config), /INVALID_PRIVATE_FILE/);
  });
  await t.test("symlink", async (t) => {
    const f = await fixture(t);
    await fs.unlink(path.join(f.directory, "high-water.json"));
    await fs.symlink(
      path.join(f.directory, "metadata.json"),
      path.join(f.directory, "high-water.json"),
    );
    await assert.rejects(
      createWitnessStore(f.config),
      /INVALID_STORAGE_CONTENTS/,
    );
  });
});

test("valid unanchored crash files are synced and unioned before proof, with idempotent retry", async (t) => {
  const f = await fixture(t),
    first = f.intent(),
    second = f.intent();
  // Deliberately copied without fsync: startup must sync the exact inode and the
  // directory before it publishes an anchor or acknowledges this stored intent.
  await fs.writeFile(
    path.join(f.directory, first.body.id + ".intent.json"),
    canonicalJson(first) + "\n",
    { mode: 0o600 },
  );
  assert.equal(
    JSON.parse(
      await fs.readFile(path.join(f.directory, "high-water.json"), "utf8"),
    ).body.version,
    0,
  );
  const reopened = await createWitnessStore(f.config);
  const ack = await reopened.append({
    nonce: nonce(),
    genesis: f.genesis,
    intent: first,
  });
  assert.equal(ack.body.version, 1);
  assert.equal(ack.body.intentSha256, digest(first));
  assert.equal(
    JSON.parse(
      await fs.readFile(path.join(f.directory, "high-water.json"), "utf8"),
    ).body.version,
    1,
  );
  await fs.writeFile(
    path.join(f.directory, second.body.id + ".intent.json"),
    canonicalJson(second) + "\n",
    { mode: 0o600 },
  );
  const complete = await reopened.checkpoint({
    journalId: f.config.journalId,
    nonce: nonce(),
  });
  assert.equal(complete.body.version, 2);
  assert.equal(
    JSON.parse(
      await fs.readFile(path.join(f.directory, "high-water.json"), "utf8"),
    ).body.headSha256,
    complete.body.headSha256,
  );
  const bad = f.intent();
  bad.mac = "0".repeat(64);
  await fs.writeFile(
    path.join(f.directory, bad.body.id + ".intent.json"),
    canonicalJson(bad) + "\n",
    { mode: 0o600 },
  );
  await assert.rejects(createWitnessStore(f.config), /INVALID_STORED_INTENT/);
  assert.equal(
    JSON.parse(
      await fs.readFile(path.join(f.directory, "high-water.json"), "utf8"),
    ).body.version,
    2,
  );
});

test("CLI bootstrap is explicit and refuses to reset existing storage", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "imon-witness-cli-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "store");
  await fs.mkdir(directory, { mode: 0o700 });
  const pair = generateKeyPairSync("ed25519"),
    genesis = wrap({
      schema: 1,
      journalId: randomUUID(),
      createdAt: Date.now(),
    });
  const genesisPath = path.join(root, "genesis.json"),
    signingPath = path.join(root, "key.pem");
  await fs.writeFile(genesisPath, canonicalJson(genesis) + "\n", {
    mode: 0o600,
  });
  await fs.writeFile(
    signingPath,
    pair.privateKey.export({ type: "pkcs8", format: "pem" }),
    { mode: 0o600 },
  );
  const env = {
    ...process.env,
    WITNESS_STORAGE_ROLE: "independent-durable",
    WITNESS_DIRECTORY: directory,
    WITNESS_GENESIS_PATH: genesisPath,
    WITNESS_ALLOWED_JOURNAL_ID: genesis.body.journalId,
    WITNESS_ALLOWED_GENESIS_SHA256: digest(genesis),
    WITNESS_JOURNAL_KEY: key,
    WITNESS_SIGNING_KEY_FILE: signingPath,
    WITNESS_API_TOKEN: token,
  };
  const script = fileURLToPath(new URL("./server.mjs", import.meta.url));
  const missing = spawnSync(process.execPath, [script], {
    env,
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(missing.status, 1);
  assert.deepEqual(await fs.readdir(directory), []);
  const initialized = spawnSync(process.execPath, [script, "--initialize"], {
    env,
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(initialized.status, 0);
  assert.match(initialized.stdout, /initialized; no listener started/);
  assert.deepEqual((await fs.readdir(directory)).sort(), [
    "high-water.json",
    "metadata.json",
  ]);
  const reset = spawnSync(process.execPath, [script, "--initialize"], {
    env,
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(reset.status, 1);
});

test("failure to fsync an existing imported inode prevents anchor advancement and every proof", async (t) => {
  const f = await fixture(t),
    record = f.intent();
  const filename = path.join(f.directory, record.body.id + ".intent.json");
  await fs.writeFile(filename, canonicalJson(record) + "\n", { mode: 0o600 });
  const anchorPath = path.join(f.directory, "high-water.json"),
    before = await fs.readFile(anchorPath, "utf8");
  const probe = await fs.open(filename, "r");
  const identity = await probe.stat({ bigint: true });
  const prototype = Object.getPrototypeOf(probe),
    originalSync = prototype.sync;
  await probe.close();
  prototype.sync = async function (...args) {
    const current = fstatSync(this.fd, { bigint: true });
    if (current.dev === identity.dev && current.ino === identity.ino)
      throw new Error("SYNTHETIC_INODE_FSYNC_FAILURE");
    return originalSync.apply(this, args);
  };
  try {
    await assert.rejects(
      createWitnessStore(f.config),
      /SYNTHETIC_INODE_FSYNC_FAILURE/,
    );
    await assert.rejects(
      f.store.checkpoint({ journalId: f.config.journalId, nonce: nonce() }),
      /SYNTHETIC_INODE_FSYNC_FAILURE/,
    );
    await assert.rejects(
      f.store.append({ nonce: nonce(), genesis: f.genesis, intent: record }),
      /SYNTHETIC_INODE_FSYNC_FAILURE/,
    );
    assert.equal(await fs.readFile(anchorPath, "utf8"), before);
  } finally {
    prototype.sync = originalSync;
  }
  const recovered = await createWitnessStore(f.config);
  assert.equal(
    (
      await recovered.checkpoint({
        journalId: f.config.journalId,
        nonce: nonce(),
      })
    ).body.version,
    1,
  );
});
