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
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import {
  canonicalJson,
  digest,
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
