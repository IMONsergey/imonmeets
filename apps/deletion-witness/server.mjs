import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import {
  createHash,
  createHmac,
  createPrivateKey,
  randomUUID,
  sign,
  timingSafeEqual,
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
async function readPrivate(file, limit = RECORD_LIMIT) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    required(
      before.isFile() &&
        before.size > 0 &&
        before.size <= limit &&
        (before.mode & 0o077) === 0,
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
    const after = await handle.stat();
    required(
      count === before.size &&
        count <= limit &&
        before.ino === after.ino &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs,
      "PRIVATE_FILE_CHANGED",
      503,
    );
    return buffer.subarray(0, count).toString("utf8");
  } finally {
    await handle.close();
  }
}
async function readRecord(file) {
  const raw = await readPrivate(file);
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

export async function createWitnessStore({
  directory,
  journalId,
  genesisSha256,
  genesis,
  journalKey,
  signingKey,
  now = Date.now,
}) {
  required(
    path.isAbsolute(directory) && path.resolve(directory) !== "/",
    "PRIVATE_DIRECTORY_REQUIRED",
    503,
  );
  let ancestor = path.resolve(directory);
  while (true) {
    const info = await fs.lstat(ancestor);
    required(
      info.isDirectory() && !info.isSymbolicLink(),
      "INVALID_STORAGE_DIRECTORY",
      503,
    );
    if (ancestor === path.resolve(directory))
      required((info.mode & 0o077) === 0, "STORAGE_DIRECTORY_NOT_PRIVATE", 503);
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  required(
    UUID.test(journalId) && SHA.test(genesisSha256) && journalKey.length >= 32,
    "INVALID_ENROLLMENT",
    503,
  );
  const privateKey = createPrivateKey(signingKey);
  required(
    privateKey.asymmetricKeyType === "ed25519",
    "ED25519_KEY_REQUIRED",
    503,
  );
  envelope(genesis, journalKey, "genesis");
  required(
    genesis.body.journalId === journalId && digest(genesis) === genesisSha256,
    "GENESIS_ENROLLMENT_MISMATCH",
    503,
  );
  const entries = new Map();
  let metadataPresent = false,
    seen = 0;
  for await (const entry of await fs.opendir(directory)) {
    required(
      ++seen <= MAX_INTENTS + 128 && entry.isFile() && !entry.isSymbolicLink(),
      "INVALID_STORAGE_CONTENTS",
      503,
    );
    if (entry.name === "writer.lock") continue;
    if (/^\.pending-[a-f0-9-]{36}$/.test(entry.name)) continue; // Never acknowledged before atomic publication.
    if (entry.name === "metadata.json") {
      metadataPresent = true;
      const stored = envelope(
        await readRecord(path.join(directory, entry.name)),
        journalKey,
        "genesis",
      );
      required(
        digest(stored) === genesisSha256,
        "GENESIS_ENROLLMENT_MISMATCH",
        503,
      );
      continue;
    }
    const matched = /^([a-f0-9-]{36})\.intent\.json$/.exec(entry.name);
    required(matched && UUID.test(matched[1]), "UNEXPECTED_STORAGE_FILE", 503);
    const record = envelope(
      await readRecord(path.join(directory, entry.name)),
      journalKey,
      "intent",
    );
    required(
      record.body.id === matched[1] && record.body.journalId === journalId,
      "STORED_INTENT_MISMATCH",
      503,
    );
    entries.set(record.body.id, digest(record));
    required(entries.size <= MAX_INTENTS, "JOURNAL_CAPACITY_EXCEEDED", 503);
  }
  required(
    metadataPresent || entries.size === 0,
    "MISSING_GENESIS_WITH_EXISTING_INTENTS",
    503,
  );
  await publish(directory, "metadata.json", genesis);
  const originalDirectory = await fs.lstat(directory);
  async function validateDurableSet() {
    const currentDirectory = await fs.lstat(directory);
    required(
      currentDirectory.isDirectory() &&
        !currentDirectory.isSymbolicLink() &&
        currentDirectory.dev === originalDirectory.dev &&
        currentDirectory.ino === originalDirectory.ino &&
        (currentDirectory.mode & 0o077) === 0,
      "STORAGE_DIRECTORY_CHANGED",
      503,
    );
    required(
      digest(await readRecord(path.join(directory, "metadata.json"))) ===
        genesisSha256,
      "GENESIS_ENROLLMENT_MISMATCH",
      503,
    );
    let found = 0,
      total = 0;
    for await (const entry of await fs.opendir(directory)) {
      required(
        ++total <= MAX_INTENTS + 128 &&
          entry.isFile() &&
          !entry.isSymbolicLink(),
        "INVALID_STORAGE_CONTENTS",
        503,
      );
      if (
        entry.name === "writer.lock" ||
        entry.name === "metadata.json" ||
        /^\.pending-[a-f0-9-]{36}$/.test(entry.name)
      )
        continue;
      const matched = /^([a-f0-9-]{36})\.intent\.json$/.exec(entry.name);
      required(
        matched && entries.has(matched[1]),
        "UNEXPECTED_STORAGE_FILE",
        503,
      );
      required(
        digest(await readRecord(path.join(directory, entry.name))) ===
          entries.get(matched[1]),
        "DURABLE_INTENT_CHANGED",
        503,
      );
      found++;
    }
    required(found === entries.size, "DURABLE_INTENT_MISSING", 503);
  }
  let queue = Promise.resolve();
  const serial = (task) => {
    const result = queue.then(task, task);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const head = () => ({
    journalId,
    genesisSha256,
    entries: [...entries]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([id, sha256]) => ({ id, sha256 })),
  });
  function proof(nonce, intent) {
    required(typeof nonce === "string" && NONCE.test(nonce));
    const issuedAt = now();
    const body = {
      schema: 1,
      journalId,
      nonce,
      version: entries.size,
      headSha256: digest(head()),
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
      return serial(async () => {
        await validateDurableSet();
        await syncDirectory(directory);
        return proof(request.nonce);
      });
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
        await validateDurableSet();
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
        try {
          await publish(directory, id + ".intent.json", record);
        } catch (error) {
          // A name may have been published before a directory fsync failed.
          // Remember only these exact authenticated bytes, return no success,
          // and require a successful fsync on the next proof/retry.
          try {
            if (
              digest(
                await readRecord(path.join(directory, id + ".intent.json")),
              ) === hash
            )
              entries.set(id, hash);
          } catch {}
          throw error;
        }
        entries.set(id, hash);
        return proof(request.nonce, { intentId: id, intentSha256: hash });
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
  const store = await createWitnessStore({
    directory,
    journalId: process.env.WITNESS_ALLOWED_JOURNAL_ID || "",
    genesisSha256: process.env.WITNESS_ALLOWED_GENESIS_SHA256 || "",
    genesis,
    journalKey: process.env.WITNESS_JOURNAL_KEY || "",
    signingKey: await readPrivate(process.env.WITNESS_SIGNING_KEY_FILE || ""),
  });
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
