import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  canonicalJson,
  initializeDeletionJournal,
  loadDeletionConfig,
  openDeletionJournal,
  verifyWitnessProof,
  type DeletionConfig,
  type DeletionIntentInput,
  type JournalSnapshot,
  type StoredIntent,
} from "../src/deletion-journal.js";

const TEST_KEY = "synthetic-deletion-journal-key-for-unit-tests-only";
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const NONCE = randomBytes(32).toString("base64url");
const witness = generateKeyPairSync("ed25519");
const witnessPublicKey = witness.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const hash = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
const noFetch: typeof fetch = async () => {
  throw new Error("Unit test attempted an external request");
};

async function privateRoot(t: TestContext) {
  const root = await fs.mkdtemp(join(tmpdir(), "imon-deletion-journal-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}
function config(directory: string): DeletionConfig {
  return {
    directory,
    key: TEST_KEY,
    required: false,
    witnessUrl: "",
    witnessToken: "",
    witnessPublicKey: "",
  };
}
async function fixture(t: TestContext) {
  const root = await privateRoot(t);
  const c = config(join(root, "journal"));
  await initializeDeletionJournal(c);
  let networkCalls = 0;
  const request: typeof fetch = async () => {
    networkCalls++;
    throw new Error("Local-only journal attempted an external request");
  };
  const journal = await openDeletionJournal(c, request);
  assert.ok(journal);
  return { root, config: c, journal, networkCalls: () => networkCalls };
}
function account(actorId = "test-account"): DeletionIntentInput {
  return { actorId, target: { kind: "account", accountId: actorId } };
}
async function readJson(file: string) {
  return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
}
function envelope(body: unknown, key = TEST_KEY) {
  return {
    body,
    mac: createHmac("sha256", key).update(canonicalJson(body)).digest("hex"),
  };
}
// The synthetic receiver signs the flat protocol body independently of the
// production canonicalJson implementation. No network or real signing key is used.
function proof(
  snapshot: JournalSnapshot,
  overrides: Record<string, unknown> = {},
) {
  const body: Record<string, unknown> = {
    schema: 1,
    journalId: snapshot.journalId,
    nonce: NONCE,
    version: snapshot.version,
    headSha256: snapshot.headSha256,
    issuedAt: NOW,
    expiresAt: NOW + 30_000,
    storage: "independent-durable",
    ...overrides,
  };
  const payload = JSON.stringify(
    Object.fromEntries(
      Object.keys(body)
        .sort()
        .map((key) => [key, body[key]]),
    ),
  );
  return {
    body,
    signature: sign(null, Buffer.from(payload), witness.privateKey).toString(
      "base64url",
    ),
  };
}

test("canonical protocol bytes sort keys and reject values outside the signed subset", () => {
  assert.equal(
    canonicalJson({ z: [2, { b: "текст", a: true }], a: null }),
    '{"a":null,"z":[2,{"a":true,"b":"текст"}]}',
  );
  for (const invalid of [
    undefined,
    NaN,
    Infinity,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    () => 1,
  ]) {
    assert.throws(() => canonicalJson(invalid));
  }
});

test("configuration keeps production journal mandatory and opening never auto-initializes", async (t) => {
  assert.equal(
    loadDeletionConfig({
      NODE_ENV: "production",
      DELETION_RESTORE_REQUIRED: "false",
    }).required,
    true,
  );
  assert.equal(
    loadDeletionConfig({ DELETION_RESTORE_REQUIRED: "true" }).required,
    true,
  );
  assert.equal(loadDeletionConfig({ NODE_ENV: "development" }).required, false);
  assert.equal(await openDeletionJournal(config(""), noFetch), undefined);
  await assert.rejects(
    openDeletionJournal({ ...config(""), required: true }, noFetch),
  );
  const root = await privateRoot(t);
  const missing = join(root, "missing");
  await assert.rejects(openDeletionJournal(config(missing), noFetch));
  await assert.rejects(fs.lstat(missing), { code: "ENOENT" });
});

test("initialization is explicit, private, immutable and accepts only an empty directory", async (t) => {
  const root = await privateRoot(t);
  const directory = join(root, "journal");
  await fs.mkdir(directory, { mode: 0o700 });
  const c = config(directory);
  await initializeDeletionJournal(c);
  const metadata = join(directory, "metadata.json");
  const original = await fs.readFile(metadata, "utf8");
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(metadata)).mode & 0o777, 0o600);
  assert.equal(original, canonicalJson(JSON.parse(original)) + "\n");
  await assert.rejects(initializeDeletionJournal(c));
  assert.equal(await fs.readFile(metadata, "utf8"), original);
  const journal = await openDeletionJournal(c, noFetch);
  assert.ok(journal);
  const snapshot = await journal.snapshot();
  assert.equal(snapshot.version, 0);
  assert.deepEqual(snapshot.intents, []);

  const nonempty = join(root, "nonempty");
  await fs.mkdir(nonempty, { mode: 0o700 });
  await fs.writeFile(join(nonempty, "keep"), "existing-data", { mode: 0o600 });
  await assert.rejects(initializeDeletionJournal(config(nonempty)));
  assert.equal(
    await fs.readFile(join(nonempty, "keep"), "utf8"),
    "existing-data",
  );
  await assert.rejects(fs.lstat(join(nonempty, "metadata.json")), {
    code: "ENOENT",
  });
});

test("invalid initialization paths and weak keys fail before creating a directory", async (t) => {
  const root = await privateRoot(t);
  const outside = join(root, "must-not-create");
  const relativePath = relative(process.cwd(), outside);
  await assert.rejects(initializeDeletionJournal(config(relativePath)));
  await assert.rejects(fs.lstat(outside), { code: "ENOENT" });
  const weak = join(root, "weak");
  await assert.rejects(
    initializeDeletionJournal({ ...config(weak), key: "x".repeat(31) }),
  );
  await assert.rejects(fs.lstat(weak), { code: "ENOENT" });
});

test("authorized intent persists before a separate idempotent commit marker without changing its head", async (t) => {
  const f = await fixture(t);
  const genesisBytes = await fs.readFile(
    join(f.config.directory, "metadata.json"),
    "utf8",
  );
  const started = Date.now();
  const stored = await f.journal.recordAuthorizedIntent(account());
  assert.equal(stored.state, "pending");
  assert.equal(stored.independentlyAcknowledged, false);
  assert.ok(
    stored.body.requestedAt >= started && stored.body.requestedAt <= Date.now(),
  );
  assert.equal(stored.body.schema, 1);
  assert.equal(stored.body.actorId, "test-account");
  const intentPath = join(f.config.directory, stored.body.id + ".intent.json");
  const raw = await fs.readFile(intentPath, "utf8");
  const saved = JSON.parse(raw) as unknown;
  assert.equal(raw, canonicalJson(saved) + "\n");
  assert.equal(stored.sha256, hash(saved));
  assert.equal((await fs.stat(intentPath)).mode & 0o777, 0o600);
  const pending = await f.journal.snapshot();
  const metadata = JSON.parse(genesisBytes) as unknown;
  assert.equal(
    pending.headSha256,
    hash({
      journalId: pending.journalId,
      genesisSha256: hash(metadata),
      entries: [{ id: stored.body.id, sha256: stored.sha256 }],
    }),
  );
  await assert.rejects(
    f.journal.markCommitted({ ...stored, sha256: "0".repeat(64) }),
  );
  await f.journal.markCommitted(stored);
  const marker = join(f.config.directory, stored.body.id + ".committed.json");
  const firstMarker = await fs.readFile(marker, "utf8");
  const firstStat = await fs.stat(marker, { bigint: true });
  await f.journal.markCommitted(stored);
  assert.equal(await fs.readFile(marker, "utf8"), firstMarker);
  assert.equal((await fs.stat(marker, { bigint: true })).ino, firstStat.ino);
  assert.equal(await fs.readFile(intentPath, "utf8"), raw);
  assert.equal(
    await fs.readFile(join(f.config.directory, "metadata.json"), "utf8"),
    genesisBytes,
  );
  const committed = await f.journal.snapshot();
  assert.equal(committed.version, 1);
  assert.equal(committed.headSha256, pending.headSha256);
  assert.equal(committed.intents[0]!.state, "database_committed");
  assert.equal(await f.journal.verifyIndependentCheckpoint(committed), false);
  assert.equal(f.networkCalls(), 0);
  const reopened = await openDeletionJournal(f.config, noFetch);
  assert.ok(reopened);
  assert.deepEqual(await reopened.snapshot(), committed);
});

test("concurrent writers retain every immutable intent and deterministic ASCII-sorted head", async (t) => {
  const f = await fixture(t);
  const second = await openDeletionJournal(f.config, noFetch);
  assert.ok(second);
  const workspaceId = randomUUID();
  const recordingId = randomUUID();
  const inputs: DeletionIntentInput[] = [
    account("actor-0"),
    { actorId: "actor-1", target: { kind: "workspace", workspaceId } },
    {
      actorId: "actor-2",
      target: { kind: "recording", workspaceId, recordingId },
    },
    {
      actorId: "actor-3",
      target: {
        kind: "analysis",
        workspaceId,
        recordingId,
        analysisId: randomUUID(),
      },
    },
    ...Array.from({ length: 8 }, (_, i) => account("parallel-" + i)),
  ];
  const stored = await Promise.all(
    inputs.map((input, index) =>
      (index % 2 ? second : f.journal).recordAuthorizedIntent(input),
    ),
  );
  const snapshot = await f.journal.snapshot();
  assert.equal(snapshot.version, inputs.length);
  assert.equal(
    new Set(snapshot.intents.map((x) => x.body.id)).size,
    inputs.length,
  );
  assert.deepEqual(
    snapshot.intents.map((x) => x.body.id),
    stored.map((x) => x.body.id).sort(),
  );
  const genesis = await readJson(join(f.config.directory, "metadata.json"));
  assert.equal(
    snapshot.headSha256,
    hash({
      journalId: snapshot.journalId,
      genesisSha256: hash(genesis),
      entries: stored
        .map((x) => ({ id: x.body.id, sha256: x.sha256 }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    }),
  );
  assert.ok(
    snapshot.intents.every(
      (x) => !x.independentlyAcknowledged && x.state === "pending",
    ),
  );
  assert.equal(f.networkCalls(), 0);
});

test("unsafe identifiers, cross-account deletion and injected fields cannot publish intents or traverse paths", async (t) => {
  const f = await fixture(t);
  const invalid: unknown[] = [
    { actorId: "../actor", target: { kind: "account", accountId: "../actor" } },
    {
      actorId: "actor",
      target: { kind: "account", accountId: "someone-else" },
    },
    {
      actorId: "actor",
      target: { kind: "workspace", workspaceId: "../../outside" },
    },
    {
      actorId: "actor",
      target: {
        kind: "recording",
        workspaceId: randomUUID(),
        recordingId: "../../outside",
      },
    },
    {
      actorId: "actor",
      target: {
        kind: "analysis",
        workspaceId: randomUUID(),
        recordingId: randomUUID(),
        analysisId: "../../outside",
      },
    },
    { ...account(), journalId: randomUUID(), requestedAt: 0 },
  ];
  for (const input of invalid) {
    await assert.rejects(
      f.journal.recordAuthorizedIntent(input as DeletionIntentInput),
    );
  }
  assert.equal((await f.journal.snapshot()).version, 0);
  const stored = await f.journal.recordAuthorizedIntent(account());
  const sentinel = join(f.root, "outside");
  await fs.writeFile(sentinel, "must-remain", { mode: 0o600 });
  const forged: StoredIntent = {
    ...stored,
    body: { ...stored.body, id: "../../outside" },
  };
  await assert.rejects(f.journal.markCommitted(forged));
  assert.equal(await fs.readFile(sentinel, "utf8"), "must-remain");
});

test("corruption, wrong key, noncanonical bytes and oversized records fail closed", async (t) => {
  await t.test("wrong HMAC key", async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      openDeletionJournal(
        { ...f.config, key: "another-strong-test-key".repeat(2) },
        noFetch,
      ),
    );
  });
  await t.test("authenticated body tampering", async (t) => {
    const f = await fixture(t);
    const stored = await f.journal.recordAuthorizedIntent(account());
    const file = join(f.config.directory, stored.body.id + ".intent.json");
    const saved = JSON.parse(await fs.readFile(file, "utf8"));
    saved.body.actorId = "changed-actor";
    saved.body.target.accountId = "changed-actor";
    await fs.writeFile(file, canonicalJson(saved) + "\n");
    await assert.rejects(f.journal.snapshot());
  });
  await t.test("noncanonical serialization", async (t) => {
    const f = await fixture(t);
    const file = join(f.config.directory, "metadata.json");
    const saved = await readJson(file);
    await fs.writeFile(file, JSON.stringify(saved, null, 2) + "\n");
    await assert.rejects(openDeletionJournal(f.config, noFetch));
  });
  await t.test("bounded record size", async (t) => {
    const f = await fixture(t);
    await fs.writeFile(
      join(f.config.directory, "metadata.json"),
      Buffer.alloc(16 * 1024 + 1, 32),
    );
    await assert.rejects(openDeletionJournal(f.config, noFetch));
  });
  await t.test("nonprivate record mode", async (t) => {
    const f = await fixture(t);
    await fs.chmod(join(f.config.directory, "metadata.json"), 0o644);
    await assert.rejects(openDeletionJournal(f.config, noFetch));
  });
});

test("journal directory, ancestor and record symlinks are rejected", async (t) => {
  const f = await fixture(t);
  const alias = join(f.root, "alias");
  await fs.symlink(f.config.directory, alias);
  await assert.rejects(
    openDeletionJournal({ ...f.config, directory: alias }, noFetch),
  );
  const linkedParent = join(f.root, "linked-parent");
  await fs.symlink(f.root, linkedParent);
  await assert.rejects(
    openDeletionJournal(
      {
        ...f.config,
        directory: join(linkedParent, "journal"),
      },
      noFetch,
    ),
  );
  const stored = await f.journal.recordAuthorizedIntent(account());
  const intentPath = join(f.config.directory, stored.body.id + ".intent.json");
  const saved = await fs.readFile(intentPath);
  const external = join(f.root, "external-record.json");
  await fs.writeFile(external, saved, { mode: 0o600 });
  await fs.unlink(intentPath);
  await fs.symlink(external, intentPath);
  await assert.rejects(f.journal.snapshot());
});

test("unknown files and orphan or foreign commit markers cannot be accepted", async (t) => {
  await t.test("unexpected file", async (t) => {
    const f = await fixture(t);
    await fs.writeFile(join(f.config.directory, "unrecognized.json"), "{}\n", {
      mode: 0o600,
    });
    await assert.rejects(f.journal.snapshot());
  });
  await t.test("orphan authenticated marker", async (t) => {
    const f = await fixture(t);
    const snapshot = await f.journal.snapshot();
    const id = randomUUID();
    await fs.writeFile(
      join(f.config.directory, id + ".committed.json"),
      canonicalJson(
        envelope({
          schema: 1,
          journalId: snapshot.journalId,
          intentId: id,
          intentSha256: "0".repeat(64),
          committedAt: Date.now(),
          phase: "database_committed",
        }),
      ) + "\n",
      { mode: 0o600 },
    );
    await assert.rejects(f.journal.snapshot());
  });
  await t.test(
    "foreign journal marker with matching intent ID and digest",
    async (t) => {
      const f = await fixture(t);
      const stored = await f.journal.recordAuthorizedIntent(account());
      await fs.writeFile(
        join(f.config.directory, stored.body.id + ".committed.json"),
        canonicalJson(
          envelope({
            schema: 1,
            journalId: randomUUID(),
            intentId: stored.body.id,
            intentSha256: stored.sha256,
            committedAt: Date.now(),
            phase: "database_committed",
          }),
        ) + "\n",
        { mode: 0o600 },
      );
      await assert.rejects(f.journal.markCommitted(stored));
      await assert.rejects(f.journal.snapshot());
    },
  );
});

test("a valid fresh independently signed checkpoint matches the full local head", async (t) => {
  const f = await fixture(t);
  await f.journal.recordAuthorizedIntent(account());
  const snapshot = await f.journal.snapshot();
  const value = proof(snapshot);
  const accepted = verifyWitnessProof(
    value,
    snapshot,
    NONCE,
    witnessPublicKey,
    NOW,
  );
  assert.equal(accepted.journalId, snapshot.journalId);
  assert.equal(accepted.version, 1);
  assert.equal(accepted.headSha256, snapshot.headSha256);
  assert.equal(accepted.storage, "independent-durable");
});

test("signed checkpoints reject wrong journal, nonce, head, count, clock window and storage claim", async (t) => {
  const f = await fixture(t);
  await f.journal.recordAuthorizedIntent(account());
  const snapshot = await f.journal.snapshot();
  const invalid = [
    { journalId: randomUUID() },
    { nonce: "Z".repeat(43) },
    { headSha256: "0".repeat(64) },
    { version: snapshot.version + 1 },
    { issuedAt: NOW - 30_001, expiresAt: NOW + 1 },
    { issuedAt: NOW + 30_001, expiresAt: NOW + 59_000 },
    { issuedAt: NOW - 1000, expiresAt: NOW },
    { issuedAt: NOW + 2, expiresAt: NOW + 1 },
    { issuedAt: NOW, expiresAt: NOW + 60_001 },
    { storage: "same-local-disk" },
    { schema: 2 },
  ];
  for (const patch of invalid) {
    assert.throws(() =>
      verifyWitnessProof(
        proof(snapshot, patch),
        snapshot,
        NONCE,
        witnessPublicKey,
        NOW,
      ),
    );
  }
  const forged = proof(snapshot);
  forged.signature =
    (forged.signature[0] === "A" ? "B" : "A") + forged.signature.slice(1);
  assert.throws(() =>
    verifyWitnessProof(forged, snapshot, NONCE, witnessPublicKey, NOW),
  );
  const wrongKey = generateKeyPairSync("ed25519")
    .publicKey.export({ type: "spki", format: "pem" })
    .toString();
  assert.throws(() =>
    verifyWitnessProof(proof(snapshot), snapshot, NONCE, wrongKey, NOW),
  );
  const wrongAlgorithm = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    .publicKey.export({ type: "spki", format: "pem" })
    .toString();
  assert.throws(() =>
    verifyWitnessProof(proof(snapshot), snapshot, NONCE, wrongAlgorithm, NOW),
  );
});

test("an append acknowledgement cannot substitute for a complete checkpoint proof", async (t) => {
  const f = await fixture(t);
  const stored = await f.journal.recordAuthorizedIntent(account());
  const snapshot = await f.journal.snapshot();
  assert.throws(() =>
    verifyWitnessProof(
      proof(snapshot, {
        intentId: stored.body.id,
        intentSha256: stored.sha256,
      }),
      snapshot,
      NONCE,
      witnessPublicKey,
      NOW,
    ),
  );
  assert.throws(() =>
    verifyWitnessProof(
      proof(snapshot, {
        intentId: stored.body.id,
      }),
      snapshot,
      NONCE,
      witnessPublicKey,
      NOW,
    ),
  );
});

test("a truncated but individually valid local journal fails against the signed latest external head", async (t) => {
  const f = await fixture(t);
  await f.journal.recordAuthorizedIntent(account("kept-account"));
  const omitted = await f.journal.recordAuthorizedIntent(
    account("omitted-account"),
  );
  const complete = await f.journal.snapshot();
  const latestProof = proof(complete);
  assert.equal(complete.version, 2);
  // Simulate an older/incomplete restored copy. Every remaining local HMAC is valid.
  await fs.unlink(join(f.config.directory, omitted.body.id + ".intent.json"));
  const reopened = await openDeletionJournal(f.config, noFetch);
  assert.ok(reopened);
  const incomplete = await reopened.snapshot();
  assert.equal(incomplete.version, 1);
  assert.notEqual(incomplete.headSha256, complete.headSha256);
  assert.throws(() =>
    verifyWitnessProof(latestProof, incomplete, NONCE, witnessPublicKey, NOW),
  );
  assert.equal(f.networkCalls(), 0);
});
