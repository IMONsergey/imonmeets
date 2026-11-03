import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const OPAQUE = /^[A-Za-z0-9_-]{1,128}$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const RECORD_LIMIT = 16 * 1024;
const MAX_INTENTS = 10_000;
const MAX_BODY = 36 * 1024;
const ANCHOR_LIMIT = 2 * 1024 * 1024;
const ANCHOR_FILE = "high-water.json";
const ANCHOR_KIND = "deletion-witness-high-water";

export class WitnessError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.status = status;
  }
}
function required(ok, code = "INVALID_REQUEST", status = 400) {
  if (!ok) throw new WitnessError(code, status);
}
function object(value, names) {
  required(value && typeof value === "object" && !Array.isArray(value));
  required(Object.keys(value).sort().join(",") === [...names].sort().join(","));
}
function timestamp(value) {
  required(Number.isSafeInteger(value) && value > 0);
}
export function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value))
    return String(value);
  if (Array.isArray(value))
    return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key]))
        .join(",") +
      "}"
    );
  throw new WitnessError("INVALID_CANONICAL_VALUE");
}
export const digest = (value) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
function envelope(value, key, kind) {
  object(value, ["body", "mac"]);
  required(typeof value.mac === "string" && SHA.test(value.mac));
  const body = value.body;
  object(
    body,
    kind === "genesis"
      ? ["schema", "journalId", "createdAt"]
      : ["schema", "journalId", "id", "requestedAt", "actorId", "target"],
  );
  required(
    body.schema === 1 &&
      typeof body.journalId === "string" &&
      UUID.test(body.journalId),
  );
  if (kind === "genesis") timestamp(body.createdAt);
  else {
    timestamp(body.requestedAt);
    required(typeof body.id === "string" && UUID.test(body.id));
    required(typeof body.actorId === "string" && OPAQUE.test(body.actorId));
    const target = body.target;
    required(target && typeof target === "object");
    const fields = {
      account: ["kind", "accountId"],
      workspace: ["kind", "workspaceId"],
      recording: ["kind", "workspaceId", "recordingId"],
      analysis: ["kind", "workspaceId", "recordingId", "analysisId"],
    }[target.kind];
    required(Array.isArray(fields));
    if (target.kind === "recording" && Object.hasOwn(target, "egressId"))
      fields.push("egressId");
    object(target, fields);
    for (const field of fields.filter((field) => field !== "kind")) {
      if (field === "egressId") {
        required(
          target[field] === null ||
            (typeof target[field] === "string" &&
              /^EG_[A-Za-z0-9_-]{1,128}$/.test(target[field])),
        );
        continue;
      }
      required(
        typeof target[field] === "string" &&
          (field === "accountId" ? OPAQUE : UUID).test(target[field]),
      );
    }
    if (target.kind === "account") required(target.accountId === body.actorId);
  }
  required(Buffer.byteLength(canonicalJson(value)) + 1 <= RECORD_LIMIT);
  const expected = createHmac("sha256", key)
    .update(canonicalJson(body))
    .digest();
  required(
    timingSafeEqual(Buffer.from(value.mac, "hex"), expected),
    "INVALID_JOURNAL_MAC",
  );
  return value;
}
async function readPrivate(
  file,
  limit = RECORD_LIMIT,
  { synchronize = false, exactMode = false } = {},
) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    required(
      before.isFile() &&
        before.size > 0n &&
        before.size <= BigInt(limit) &&
        (before.mode & 0o077n) === 0n &&
        (!exactMode || (before.mode & 0o777n) === 0o600n),
      "INVALID_PRIVATE_FILE",
      503,
    );
    const buffer = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < buffer.length) {
      const result = await handle.read(
        buffer,
        count,
        buffer.length - count,
        count,
      );
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    // Imported files may have canonical bytes but no completed durability barrier.
    // Do not sign any authority/proof unless fsync of the exact read inode succeeds.
    if (synchronize) await handle.sync();
    const after = await handle.stat({ bigint: true });
    const named = await fs.lstat(file, { bigint: true });
    required(
      BigInt(count) === before.size &&
        count <= limit &&
        before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeNs === after.mtimeNs &&
        before.ctimeNs === after.ctimeNs &&
        named.isFile() &&
        !named.isSymbolicLink() &&
        named.dev === after.dev &&
        named.ino === after.ino &&
        named.size === after.size &&
        named.mtimeNs === after.mtimeNs &&
        named.ctimeNs === after.ctimeNs &&
        named.mode === after.mode &&
        (after.mode & 0o077n) === 0n &&
        (!exactMode || (after.mode & 0o777n) === 0o600n),
      "PRIVATE_FILE_CHANGED",
      503,
    );
    return buffer.subarray(0, count).toString("utf8");
  } finally {
    await handle.close();
  }
}
async function readRecord(file, limit = RECORD_LIMIT, options) {
  const raw = await readPrivate(file, limit, options);
  const parsed = JSON.parse(raw);
  required(
    raw === canonicalJson(parsed) + "\n",
    "NONCANONICAL_JOURNAL_RECORD",
    503,
  );
  return parsed;
}
async function syncDirectory(directory) {
  const handle = await fs.open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function publish(directory, filename, record) {
  const data = canonicalJson(record) + "\n";
  const temp = path.join(directory, ".pending-" + randomUUID());
  const destination = path.join(directory, filename);
  let handle;
  try {
    handle = await fs.open(
      temp,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await fs.link(temp, destination);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      required(
        (await readPrivate(destination)) === data,
        "IMMUTABLE_RECORD_CONFLICT",
        409,
      );
    }
    // The receipt can be signed only after file bytes and the published name are durable.
    await syncDirectory(directory);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temp).catch(() => {});
  }
}

function enrollment(config) {
  const {
    directory,
    journalId,
    genesisSha256,
    genesis,
    journalKey,
    signingKey,
  } = config;
  required(
    typeof directory === "string" &&
      path.isAbsolute(directory) &&
      path.resolve(directory) !== "/",
    "PRIVATE_DIRECTORY_REQUIRED",
    503,
  );
  required(
    typeof journalId === "string" &&
      UUID.test(journalId) &&
      typeof genesisSha256 === "string" &&
      SHA.test(genesisSha256) &&
      typeof journalKey === "string" &&
      journalKey.length >= 32,
    "INVALID_ENROLLMENT",
    503,
  );
  const privateKey = createPrivateKey(signingKey);
  required(
    privateKey.asymmetricKeyType === "ed25519",
    "ED25519_KEY_REQUIRED",
    503,
  );
  const publicKey = createPublicKey(privateKey);
  envelope(genesis, journalKey, "genesis");
  required(
    genesis.body.journalId === journalId && digest(genesis) === genesisSha256,
    "GENESIS_ENROLLMENT_MISMATCH",
    503,
  );
  return {
    ...config,
    directory: path.resolve(directory),
    privateKey,
    publicKey,
  };
}
async function privateDirectory(directory, original) {
  let ancestor = directory,
    selected;
  while (true) {
    const info = await fs.lstat(ancestor);
    required(
      info.isDirectory() && !info.isSymbolicLink(),
      "INVALID_STORAGE_DIRECTORY",
      503,
    );
    if (ancestor === directory) {
      selected = info;
      required((info.mode & 0o077) === 0, "STORAGE_DIRECTORY_NOT_PRIVATE", 503);
      if (original)
        required(
          info.dev === original.dev && info.ino === original.ino,
          "STORAGE_DIRECTORY_CHANGED",
          503,
        );
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  return selected;
}
function completeHead(journalId, genesisSha256, entries) {
  return {
    journalId,
    genesisSha256,
    entries: [...entries]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([id, sha256]) => ({ id, sha256 })),
  };
}
function makeAnchor(c, entries) {
  const head = completeHead(c.journalId, c.genesisSha256, entries);
  const body = {
    schema: 1,
    kind: ANCHOR_KIND,
    journalId: c.journalId,
    genesisSha256: c.genesisSha256,
    version: entries.size,
    headSha256: digest(head),
    entries: head.entries,
  };
  return {
    body,
    signature: sign(
      null,
      Buffer.from(canonicalJson(body)),
      c.privateKey,
    ).toString("base64url"),
  };
}
function validateAnchor(value, c) {
  try {
    object(value, ["body", "signature"]);
    const body = value.body;
    object(body, [
      "schema",
      "kind",
      "journalId",
      "genesisSha256",
      "version",
      "headSha256",
      "entries",
    ]);
    required(
      body.schema === 1 &&
        body.kind === ANCHOR_KIND &&
        body.journalId === c.journalId &&
        body.genesisSha256 === c.genesisSha256,
    );
    required(
      Number.isSafeInteger(body.version) &&
        body.version >= 0 &&
        body.version <= MAX_INTENTS &&
        Array.isArray(body.entries) &&
        body.entries.length === body.version &&
        typeof body.headSha256 === "string" &&
        SHA.test(body.headSha256),
    );
    const entries = new Map();
    let previous = "";
    for (const entry of body.entries) {
      object(entry, ["id", "sha256"]);
      required(
        typeof entry.id === "string" &&
          UUID.test(entry.id) &&
          entry.id > previous &&
          typeof entry.sha256 === "string" &&
          SHA.test(entry.sha256),
      );
      previous = entry.id;
      entries.set(entry.id, entry.sha256);
    }
    required(
      body.headSha256 ===
        digest(completeHead(c.journalId, c.genesisSha256, entries)),
    );
    required(
      typeof value.signature === "string" &&
        /^[A-Za-z0-9_-]{86}$/.test(value.signature),
    );
    const signature = Buffer.from(value.signature, "base64url");
    required(
      signature.toString("base64url") === value.signature &&
        verify(null, Buffer.from(canonicalJson(body)), c.publicKey, signature),
    );
    return { record: value, entries };
  } catch {
    throw new WitnessError("INVALID_HIGH_WATER_ANCHOR", 503);
  }
}
async function readAnchor(c) {
  return validateAnchor(
    await readRecord(path.join(c.directory, ANCHOR_FILE), ANCHOR_LIMIT, {
      synchronize: true,
      exactMode: true,
    }),
    c,
  );
}
async function replaceAnchor(c, entries) {
  const anchor = makeAnchor(c, entries);
  const data = canonicalJson(anchor) + "\n";
  required(
    Buffer.byteLength(data) <= ANCHOR_LIMIT,
    "HIGH_WATER_ANCHOR_TOO_LARGE",
    503,
  );
  const temporary = path.join(c.directory, ".pending-" + randomUUID());
  let handle;
  try {
    handle = await fs.open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    // Only this signed authority file is replaced. Intent and genesis files are immutable.
    await fs.rename(temporary, path.join(c.directory, ANCHOR_FILE));
    await syncDirectory(c.directory);
    return await readAnchor(c);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}

/** Explicit bootstrap only: an existing private empty volume, apart from its kernel lock. */
export async function initializeWitnessStorage(config) {
  const c = enrollment(config);
  const original = await privateDirectory(c.directory);
  for await (const entry of await fs.opendir(c.directory)) {
    required(
      entry.isFile() && !entry.isSymbolicLink() && entry.name === "writer.lock",
      "WITNESS_STORAGE_ALREADY_INITIALIZED_OR_NOT_EMPTY",
      503,
    );
    const info = await fs.lstat(path.join(c.directory, entry.name));
    required((info.mode & 0o077) === 0, "INVALID_PRIVATE_FILE", 503);
  }
  await publish(c.directory, "metadata.json", c.genesis);
  await privateDirectory(c.directory, original);
  await replaceAnchor(c, new Map());
  await privateDirectory(c.directory, original);
}

export async function createWitnessStore(config) {
  const c = enrollment(config);
  const { directory, journalId, genesisSha256, journalKey, privateKey } = c;
  const now = c.now || Date.now;
  const originalDirectory = await privateDirectory(directory);
  let knownAnchor;
  async function validateDurableSet() {
    await privateDirectory(directory, originalDirectory);
    const filenames = [];
    let metadataPresent = false,
      anchorPresent = false,
      seen = 0;
    for await (const entry of await fs.opendir(directory)) {
      required(
        ++seen <= MAX_INTENTS + 128 &&
          entry.isFile() &&
          !entry.isSymbolicLink(),
        "INVALID_STORAGE_CONTENTS",
        503,
      );
      if (
        entry.name === "writer.lock" ||
        /^\.pending-[a-f0-9-]{36}$/.test(entry.name)
      )
        continue;
      if (entry.name === "metadata.json") {
        metadataPresent = true;
        continue;
      }
      if (entry.name === ANCHOR_FILE) {
        anchorPresent = true;
        continue;
      }
      const matched = /^([a-f0-9-]{36})\.intent\.json$/.exec(entry.name);
      required(
        matched && UUID.test(matched[1]),
        "UNEXPECTED_STORAGE_FILE",
        503,
      );
      filenames.push([entry.name, matched[1]]);
    }
    // Normal startup must never turn a lost mount or missing anchor into a new enrollment.
    required(metadataPresent, "MISSING_DURABLE_GENESIS", 503);
    required(anchorPresent, "MISSING_HIGH_WATER_ANCHOR", 503);
    const storedGenesis = envelope(
      await readRecord(path.join(directory, "metadata.json"), RECORD_LIMIT, {
        synchronize: true,
      }),
      journalKey,
      "genesis",
    );
    required(
      digest(storedGenesis) === genesisSha256,
      "GENESIS_ENROLLMENT_MISMATCH",
      503,
    );
    let anchor = await readAnchor(c);
    if (knownAnchor) {
      for (const [id, hash] of knownAnchor.entries)
        required(
          anchor.entries.get(id) === hash,
          "HIGH_WATER_ANCHOR_ROLLED_BACK",
          503,
        );
    }
    const entries = new Map();
    for (const [filename, id] of filenames) {
      const record = await readRecord(
        path.join(directory, filename),
        RECORD_LIMIT,
        { synchronize: true },
      );
      const hash = digest(record);
      if (anchor.entries.has(id))
        required(
          anchor.entries.get(id) === hash,
          "DURABLE_INTENT_CHANGED",
          503,
        );
      try {
        envelope(record, journalKey, "intent");
      } catch {
        throw new WitnessError("INVALID_STORED_INTENT", 503);
      }
      required(
        record.body.id === id && record.body.journalId === journalId,
        "STORED_INTENT_MISMATCH",
        503,
      );
      entries.set(id, hash);
      required(entries.size <= MAX_INTENTS, "JOURNAL_CAPACITY_EXCEEDED", 503);
    }
    for (const [id, hash] of anchor.entries)
      required(entries.get(id) === hash, "DURABLE_INTENT_MISSING", 503);
    // Every verified existing/imported inode was synced above. Commit the names
    // before making a newly recovered union authoritative in the anchor.
    await syncDirectory(directory);
    await privateDirectory(directory, originalDirectory);
    if (entries.size > anchor.entries.size)
      anchor = await replaceAnchor(c, entries);
    // Recheck the durable authority even when no rewrite was needed, then retain
    // an in-process floor in addition to the signed on-disk restart floor.
    const checked = await readAnchor(c);
    required(
      digest(checked.record) === digest(anchor.record),
      "HIGH_WATER_ANCHOR_CHANGED",
      503,
    );
    await privateDirectory(directory, originalDirectory);
    await syncDirectory(directory);
    knownAnchor = checked;
    return entries;
  }
  // Recovery only unions authenticated extra files after every previous anchored
  // ID and exact digest has survived. It never shrinks a missing complete set.
  await validateDurableSet();
  let queue = Promise.resolve();
  const serial = (task) => {
    const result = queue.then(task, task);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  function proof(entries, nonce, intent) {
    required(typeof nonce === "string" && NONCE.test(nonce));
    const issuedAt = now();
    const body = {
      schema: 1,
      journalId,
      nonce,
      version: entries.size,
      headSha256: digest(completeHead(journalId, genesisSha256, entries)),
      issuedAt,
      expiresAt: issuedAt + 30_000,
      storage: "independent-durable",
      ...(intent || {}),
    };
    return {
      body,
      signature: sign(
        null,
        Buffer.from(canonicalJson(body)),
        privateKey,
      ).toString("base64url"),
    };
  }
  return {
    checkpoint(request) {
      object(request, ["journalId", "nonce"]);
      required(request.journalId === journalId, "UNENROLLED_JOURNAL", 403);
      required(typeof request.nonce === "string" && NONCE.test(request.nonce));
      return serial(async () =>
        proof(await validateDurableSet(), request.nonce),
      );
    },
    health() {
      return serial(async () => {
        await validateDurableSet();
        return { status: "ok" };
      });
    },
    append(request) {
      object(request, ["nonce", "genesis", "intent"]);
      required(typeof request.nonce === "string" && NONCE.test(request.nonce));
      envelope(request.genesis, journalKey, "genesis");
      const record = envelope(request.intent, journalKey, "intent");
      required(
        record.body.journalId === journalId &&
          digest(request.genesis) === genesisSha256,
        "UNENROLLED_JOURNAL",
        403,
      );
      const id = record.body.id,
        hash = digest(record);
      return serial(async () => {
        let entries = await validateDurableSet();
        const existing = entries.get(id);
        required(
          !existing || existing === hash,
          "IMMUTABLE_RECORD_CONFLICT",
          409,
        );
        required(
          existing || entries.size < MAX_INTENTS,
          "JOURNAL_CAPACITY_EXCEEDED",
          507,
        );
        if (!existing) {
          await publish(directory, id + ".intent.json", record);
          // This second validation durably anchors the union before the ACK.
          // A failure leaves a recoverable unacknowledged file, never a success.
          entries = await validateDurableSet();
        }
        required(entries.get(id) === hash, "DURABLE_INTENT_MISSING", 503);
        return proof(entries, request.nonce, {
          intentId: id,
          intentSha256: hash,
        });
      });
    },
  };
}

export function createWitnessServer(store, token) {
  required(
    typeof token === "string" && token.length >= 32,
    "STRONG_TOKEN_REQUIRED",
    503,
  );
  const expected = Buffer.from("Bearer " + token);
  let active = 0;
  const server = createServer(
    { maxHeaderSize: 8192 },
    async (request, response) => {
      const reply = (status, data) => {
        response.writeHead(status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(JSON.stringify(data));
      };
      const actual = Buffer.from(request.headers.authorization || "");
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      ) {
        reply(401, { error: "UNAUTHORIZED" });
        request.resume();
        return;
      }
      const health = request.method === "GET" && request.url === "/health";
      if (
        !health &&
        (request.method !== "POST" ||
          !["/intents", "/checkpoint"].includes(request.url))
      ) {
        reply(404, { error: "NOT_FOUND" });
        request.resume();
        return;
      }
      if (active >= 16) {
        reply(429, { error: "RECEIVER_BUSY" });
        request.resume();
        return;
      }
      active++;
      try {
        if (health) {
          reply(200, await store.health());
          return;
        }
        required(
          request.headers["content-type"]?.split(";")[0].trim() ===
            "application/json",
          "JSON_REQUIRED",
          415,
        );
        if (request.headers["content-length"])
          required(
            Number(request.headers["content-length"]) <= MAX_BODY,
            "REQUEST_TOO_LARGE",
            413,
          );
        const chunks = [];
        let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          required(length <= MAX_BODY, "REQUEST_TOO_LARGE", 413);
          chunks.push(chunk);
        }
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          throw new WitnessError("INVALID_JSON");
        }
        const proof = await (request.url === "/intents"
          ? store.append(body)
          : store.checkpoint(body));
        reply(200, proof);
      } catch (error) {
        reply(error instanceof WitnessError ? error.status : 503, {
          error:
            error instanceof WitnessError
              ? error.message
              : "DURABLE_STORAGE_UNAVAILABLE",
        });
        request.resume();
      } finally {
        active--;
      }
    },
  );
  server.maxConnections = 64;
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.setTimeout(10_000);
  return server;
}

async function main() {
  required(
    process.env.WITNESS_STORAGE_ROLE === "independent-durable",
    "EXPLICIT_STORAGE_ROLE_REQUIRED",
    503,
  );
  const directory = process.env.WITNESS_DIRECTORY || "/data";
  const genesis = await readRecord(process.env.WITNESS_GENESIS_PATH || "");
  const config = {
    directory,
    journalId: process.env.WITNESS_ALLOWED_JOURNAL_ID || "",
    genesisSha256: process.env.WITNESS_ALLOWED_GENESIS_SHA256 || "",
    genesis,
    journalKey: process.env.WITNESS_JOURNAL_KEY || "",
    signingKey: await readPrivate(process.env.WITNESS_SIGNING_KEY_FILE || ""),
  };
  required(
    process.argv.slice(2).every((arg) => arg === "--initialize") &&
      process.argv.slice(2).length <= 1,
    "INVALID_ARGUMENT",
    503,
  );
  if (process.argv.includes("--initialize")) {
    await initializeWitnessStorage(config);
    process.stdout.write(
      "Deletion receiver storage initialized; no listener started.\n",
    );
    return;
  }
  const store = await createWitnessStore(config);
  const server = createWitnessServer(
    store,
    process.env.WITNESS_API_TOKEN || "",
  );
  const port = Number(process.env.WITNESS_PORT || "3551");
  required(
    Number.isInteger(port) && port >= 1024 && port <= 65535,
    "INVALID_PORT",
    503,
  );
  server.listen(port, "127.0.0.1", () =>
    process.stdout.write(
      "Deletion receiver listening on loopback; independent-host acceptance is external.\n",
    ),
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => server.close(() => process.exit(0)));
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(() => {
    process.stderr.write(
      "DELETION_RECEIVER_NOT_STARTED: verify private storage, enrollment and keys.\n",
    );
    process.exitCode = 1;
  });
}
