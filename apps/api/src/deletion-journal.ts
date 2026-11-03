import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify,
} from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { transaction } from "./db.js";
import { ApiError } from "./policy.js";

const MAX_RECORD_BYTES = 16 * 1024;
const MAX_INTENTS = 10_000;
const uuid = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const opaque = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("account"), accountId: opaque }).strict(),
  z.object({ kind: z.literal("workspace"), workspaceId: uuid }).strict(),
  z
    .object({
      kind: z.literal("recording"),
      workspaceId: uuid,
      recordingId: uuid,
      egressId: z
        .string()
        .regex(/^EG_[A-Za-z0-9_-]{1,128}$/)
        .nullable()
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("analysis"),
      workspaceId: uuid,
      recordingId: uuid,
      analysisId: uuid,
    })
    .strict(),
]);
export const deletionInputSchema = z
  .object({ actorId: opaque, target: targetSchema })
  .strict()
  .refine(
    (input) =>
      input.target.kind !== "account" ||
      input.target.accountId === input.actorId,
    "Only self-account deletion can be recorded",
  );
export type DeletionIntentInput = z.infer<typeof deletionInputSchema>;
const genesisSchema = z
  .object({ schema: z.literal(1), journalId: uuid, createdAt: timestamp })
  .strict();
const intentSchema = z
  .object({
    schema: z.literal(1),
    journalId: uuid,
    id: uuid,
    requestedAt: timestamp,
    actorId: opaque,
    target: targetSchema,
  })
  .strict()
  .refine(
    (input) =>
      input.target.kind !== "account" ||
      input.target.accountId === input.actorId,
  );
const committedSchema = z
  .object({
    schema: z.literal(1),
    journalId: uuid,
    intentId: uuid,
    intentSha256: sha256,
    committedAt: timestamp,
    phase: z.literal("database_committed"),
  })
  .strict();
type IntentBody = z.infer<typeof intentSchema>;
type Envelope<T> = { body: T; mac: string };
export type StoredIntent = {
  body: IntentBody;
  sha256: string;
  state: "pending" | "database_committed";
  independentlyAcknowledged: boolean;
};
export type JournalSnapshot = {
  journalId: string;
  version: number;
  headSha256: string;
  intents: StoredIntent[];
};
export type DeletionConfig = {
  directory: string;
  key: string;
  required: boolean;
  witnessUrl: string;
  witnessToken: string;
  witnessPublicKey: string;
};
export function loadDeletionConfig(
  env: NodeJS.ProcessEnv = process.env,
): DeletionConfig {
  return {
    directory: env.DELETION_JOURNAL_DIR || "",
    key: env.DELETION_JOURNAL_KEY || "",
    required:
      env.NODE_ENV === "production" || env.DELETION_RESTORE_REQUIRED === "true",
    witnessUrl: env.DELETION_WITNESS_URL || "",
    witnessToken: env.DELETION_WITNESS_TOKEN || "",
    witnessPublicKey: env.DELETION_WITNESS_PUBLIC_KEY || "",
  };
}

/** Canonical subset: strict schemas below contain only finite integers, strings, arrays and objects. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value))
    return String(value);
  if (Array.isArray(value))
    return "[" + value.map(canonicalJson).join(",") + "]";
  if (typeof value === "object" && value) {
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ":" +
            canonicalJson((value as Record<string, unknown>)[key]),
        )
        .join(",") +
      "}"
    );
  }
  throw new Error("Invalid canonical journal value");
}
const digest = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
const signed = <T>(body: T, key: string): Envelope<T> => ({
  body,
  mac: createHmac("sha256", key).update(canonicalJson(body)).digest("hex"),
});
function validateEnvelope<T>(
  value: unknown,
  schema: z.ZodType<T>,
  key: string,
): Envelope<T> {
  const envelope = z
    .object({ body: schema, mac: sha256 })
    .strict()
    .parse(value);
  const expected = signed(envelope.body, key).mac;
  if (
    !timingSafeEqual(
      Buffer.from(envelope.mac, "hex"),
      Buffer.from(expected, "hex"),
    )
  )
    throw new Error("Deletion journal integrity check failed");
  return envelope;
}
async function secureDirectory(directory: string) {
  if (!isAbsolute(directory) || resolve(directory) === "/")
    throw new Error("Deletion journal requires an absolute private directory");
  let current = resolve(directory);
  for (;;) {
    const info = await fs.lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error("Deletion journal symlinks are forbidden");
    if (current === resolve(directory) && (info.mode & 0o077) !== 0)
      throw new Error("Deletion journal directory must be private");
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
async function readRecord(path: string): Promise<unknown> {
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size < 1 ||
      before.size > MAX_RECORD_BYTES ||
      (before.mode & 0o077) !== 0
    )
      throw new Error("Invalid deletion journal record");
    const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      length > MAX_RECORD_BYTES ||
      length !== before.size ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("Deletion journal record changed");
    const raw = buffer.subarray(0, length).toString("utf8");
    const value: unknown = JSON.parse(raw);
    if (raw !== canonicalJson(value) + "\n")
      throw new Error("Deletion journal record is not canonical");
    return value;
  } finally {
    await handle.close();
  }
}
async function syncDirectory(directory: string) {
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
async function publish(directory: string, name: string, value: unknown) {
  const data = canonicalJson(value) + "\n";
  if (Buffer.byteLength(data) > MAX_RECORD_BYTES)
    throw new Error("Deletion journal record exceeds limit");
  const temporary = join(directory, ".tmp-" + randomUUID());
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
    // link is atomic and refuses replacement; rename would overwrite an immutable record.
    await fs.link(temporary, join(directory, name));
    await syncDirectory(directory);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}
export async function initializeDeletionJournal(
  config: DeletionConfig,
): Promise<void> {
  if (
    !config.directory ||
    !isAbsolute(config.directory) ||
    resolve(config.directory) === "/" ||
    config.key.length < 32
  )
    throw new Error(
      "Deletion journal initialization requires an absolute private directory and strong key",
    );
  await fs
    .mkdir(config.directory, { mode: 0o700 })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  await secureDirectory(config.directory);
  for await (const _entry of await fs.opendir(config.directory))
    throw new Error(
      "Deletion journal initialization refuses a non-empty directory",
    );
  await publish(
    config.directory,
    "metadata.json",
    signed(
      { schema: 1, journalId: randomUUID(), createdAt: Date.now() },
      config.key,
    ),
  );
}
const proofBodySchema = z
  .object({
    schema: z.literal(1),
    journalId: uuid,
    nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    version: z.number().int().min(0).max(MAX_INTENTS),
    headSha256: sha256,
    issuedAt: timestamp,
    expiresAt: timestamp,
    storage: z.literal("independent-durable"),
    intentId: uuid.optional(),
    intentSha256: sha256.optional(),
  })
  .strict()
  .refine(
    (body) =>
      (body.intentId === undefined) === (body.intentSha256 === undefined),
  );
const proofSchema = z
  .object({
    body: proofBodySchema,
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict();
type WitnessProof = z.infer<typeof proofSchema>;
function signedProof(value: unknown, publicKey: string): WitnessProof {
  const proof = proofSchema.parse(value);
  const key = createPublicKey(publicKey);
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !verify(
      null,
      Buffer.from(canonicalJson(proof.body)),
      key,
      Buffer.from(proof.signature, "base64url"),
    )
  )
    throw new Error(
      "Independent deletion acknowledgement signature is invalid",
    );
  return proof;
}
function freshProof(
  value: unknown,
  journalId: string,
  nonce: string,
  publicKey: string,
  now: number,
) {
  const proof = signedProof(value, publicKey);
  const body = proof.body;
  if (
    body.journalId !== journalId ||
    body.nonce !== nonce ||
    Math.abs(body.issuedAt - now) > 30_000 ||
    body.expiresAt <= now ||
    body.expiresAt <= body.issuedAt ||
    body.expiresAt - body.issuedAt > 60_000
  )
    throw new Error(
      "Independent deletion acknowledgement is stale or unrelated",
    );
  return proof;
}
export function verifyWitnessProof(
  value: unknown,
  snapshot: JournalSnapshot,
  nonce: string,
  publicKey: string,
  now = Date.now(),
) {
  const proof = freshProof(value, snapshot.journalId, nonce, publicKey, now);
  if (
    proof.body.intentId ||
    proof.body.version !== snapshot.version ||
    proof.body.headSha256 !== snapshot.headSha256
  )
    throw new Error(
      "Independent deletion journal head does not match the complete local journal",
    );
  return proof.body;
}
async function witnessRequest(
  config: DeletionConfig,
  endpoint: "intents" | "checkpoint",
  body: unknown,
  request: typeof fetch,
) {
  if (
    !config.witnessUrl ||
    config.witnessToken.length < 32 ||
    !config.witnessPublicKey
  )
    throw new Error("Independent deletion receiver is not configured");
  const url = new URL(config.witnessUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Deletion receiver requires a configured HTTPS origin");
  url.pathname = url.pathname.replace(/\/$/, "") + "/" + endpoint;
  const response = await request(url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(5000),
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + config.witnessToken,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok || !response.body)
    throw new Error("Independent deletion receiver did not acknowledge");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_RECORD_BYTES) {
        await reader.cancel();
        throw new Error("Deletion acknowledgement exceeds limit");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export class DeletionIntentPendingError extends Error {
  constructor(readonly intent: StoredIntent) {
    super(
      "Authorized deletion intent is saved; independent acknowledgement is pending",
    );
  }
}

export class DeletionJournal {
  private writeQueue: Promise<unknown> = Promise.resolve();
  constructor(
    readonly config: DeletionConfig,
    private genesis: Envelope<z.infer<typeof genesisSchema>>,
    private request: typeof fetch,
  ) {}
  get identity() {
    return {
      journalId: this.genesis.body.journalId,
      genesisSha256: digest(this.genesis),
    };
  }
  get directory() {
    return this.config.directory;
  }
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(task, task);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  async snapshot(): Promise<JournalSnapshot> {
    await secureDirectory(this.directory);
    const genesis = validateEnvelope(
      await readRecord(join(this.directory, "metadata.json")),
      genesisSchema,
      this.config.key,
    );
    if (digest(genesis) !== digest(this.genesis))
      throw new Error("Deletion journal identity changed");
    const records = new Map<string, Envelope<IntentBody>>();
    const committed = new Map<string, z.infer<typeof committedSchema>>();
    const acknowledgements = new Map<string, WitnessProof>();
    let count = 0;
    for await (const entry of await fs.opendir(this.directory)) {
      if (
        ++count > MAX_INTENTS * 3 + 101 ||
        !entry.isFile() ||
        entry.isSymbolicLink()
      )
        throw new Error("Invalid deletion journal directory");
      if (entry.name === "metadata.json") continue;
      if (/^\.tmp-[a-f0-9-]{36}$/.test(entry.name)) continue; // Never published/acknowledged, so it could not authorize a DB mutation.
      const matched = /^([a-f0-9-]{36})\.(intent|committed|ack)\.json$/.exec(
        entry.name,
      );
      if (!matched) throw new Error("Unexpected deletion journal file");
      const id = uuid.parse(matched[1]);
      const value = await readRecord(join(this.directory, entry.name));
      if (matched[2] === "intent") {
        const record = validateEnvelope(value, intentSchema, this.config.key);
        if (
          record.body.id !== id ||
          record.body.journalId !== genesis.body.journalId
        )
          throw new Error("Deletion intent belongs to another journal");
        records.set(id, record);
      } else if (matched[2] === "committed") {
        const record = validateEnvelope(
          value,
          committedSchema,
          this.config.key,
        );
        if (
          record.body.intentId !== id ||
          record.body.journalId !== genesis.body.journalId
        )
          throw new Error("Deletion commit belongs to another journal");
        committed.set(id, record.body);
      } else {
        const proof = signedProof(value, this.config.witnessPublicKey);
        if (
          proof.body.intentId !== id ||
          proof.body.journalId !== genesis.body.journalId
        )
          throw new Error(
            "Deletion acknowledgement belongs to another journal",
          );
        acknowledgements.set(id, proof);
      }
    }
    if (records.size > MAX_INTENTS)
      throw new Error(
        "Deletion journal requires an accepted archival migration",
      );
    for (const [id, marker] of committed)
      if (!records.has(id) || marker.intentSha256 !== digest(records.get(id)))
        throw new Error("Deletion commit has no matching authorized intent");
    for (const [id, proof] of acknowledgements)
      if (
        !records.has(id) ||
        proof.body.intentSha256 !== digest(records.get(id))
      )
        throw new Error(
          "Deletion acknowledgement has no matching authorized intent",
        );
    const ids = [...records.keys()].sort();
    const entries = ids.map((id) => ({ id, sha256: digest(records.get(id)) }));
    return {
      journalId: genesis.body.journalId,
      version: entries.length,
      headSha256: digest({
        journalId: genesis.body.journalId,
        genesisSha256: digest(genesis),
        entries,
      }),
      intents: ids.map((id) => ({
        body: records.get(id)!.body,
        sha256: digest(records.get(id)),
        state: committed.has(id) ? "database_committed" : "pending",
        independentlyAcknowledged: acknowledgements.has(id),
      })),
    };
  }
  async recordAuthorizedIntent(
    input: DeletionIntentInput,
  ): Promise<StoredIntent> {
    return this.serial(async () => {
      const parsed = deletionInputSchema.parse(input);
      const snapshot = await this.snapshot();
      const previous = snapshot.intents.find(
        (intent) =>
          intent.body.actorId === parsed.actorId &&
          canonicalJson(intent.body.target) === canonicalJson(parsed.target),
      );
      let envelope: Envelope<IntentBody>;
      let stored: StoredIntent;
      if (previous) {
        envelope = validateEnvelope(
          await readRecord(
            join(this.directory, previous.body.id + ".intent.json"),
          ),
          intentSchema,
          this.config.key,
        );
        stored = previous;
      } else {
        if (snapshot.version >= MAX_INTENTS)
          throw new Error("Deletion journal capacity gate is closed");
        const body: IntentBody = {
          schema: 1,
          journalId: snapshot.journalId,
          id: randomUUID(),
          requestedAt: Date.now(),
          ...parsed,
        };
        envelope = signed(body, this.config.key);
        await publish(this.directory, body.id + ".intent.json", envelope);
        stored = {
          body,
          sha256: digest(envelope),
          state: "pending",
          independentlyAcknowledged: false,
        };
      }
      if (
        (this.config.required || this.config.witnessUrl) &&
        !stored.independentlyAcknowledged
      ) {
        try {
          await this.acknowledge(envelope);
        } catch {
          throw new DeletionIntentPendingError(stored);
        }
        stored = { ...stored, independentlyAcknowledged: true };
      }
      return stored;
    });
  }
  private async acknowledge(envelope: Envelope<IntentBody>) {
    const nonce = randomBytes(32).toString("base64url");
    const value = await witnessRequest(
      this.config,
      "intents",
      { nonce, genesis: this.genesis, intent: envelope },
      this.request,
    );
    const proof = freshProof(
      value,
      envelope.body.journalId,
      nonce,
      this.config.witnessPublicKey,
      Date.now(),
    );
    if (
      proof.body.version < 1 ||
      proof.body.intentId !== envelope.body.id ||
      proof.body.intentSha256 !== digest(envelope)
    )
      throw new Error(
        "Independent deletion receiver did not persist this intent",
      );
    const name = envelope.body.id + ".ack.json";
    try {
      await publish(this.directory, name, proof);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = signedProof(
        await readRecord(join(this.directory, name)),
        this.config.witnessPublicKey,
      );
      if (
        existing.body.journalId !== envelope.body.journalId ||
        existing.body.intentId !== envelope.body.id ||
        existing.body.intentSha256 !== digest(envelope)
      )
        throw new Error("Deletion acknowledgement collision");
    }
  }
  async markCommitted(intent: StoredIntent): Promise<void> {
    return this.serial(async () => {
      const stored = validateEnvelope(
        await readRecord(
          join(this.directory, uuid.parse(intent.body.id) + ".intent.json"),
        ),
        intentSchema,
        this.config.key,
      );
      if (
        digest(stored) !== intent.sha256 ||
        stored.body.journalId !== this.genesis.body.journalId
      )
        throw new Error("Unknown deletion intent");
      const name = intent.body.id + ".committed.json";
      try {
        const existing = validateEnvelope(
          await readRecord(join(this.directory, name)),
          committedSchema,
          this.config.key,
        );
        if (
          existing.body.intentSha256 !== intent.sha256 ||
          existing.body.intentId !== intent.body.id ||
          existing.body.journalId !== this.genesis.body.journalId
        )
          throw new Error("Deletion commit mismatch");
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      try {
        await publish(
          this.directory,
          name,
          signed(
            {
              schema: 1,
              journalId: stored.body.journalId,
              intentId: intent.body.id,
              intentSha256: intent.sha256,
              committedAt: Date.now(),
              phase: "database_committed",
            },
            this.config.key,
          ),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = validateEnvelope(
          await readRecord(join(this.directory, name)),
          committedSchema,
          this.config.key,
        );
        if (
          existing.body.journalId !== this.genesis.body.journalId ||
          existing.body.intentId !== intent.body.id ||
          existing.body.intentSha256 !== intent.sha256
        )
          throw new Error("Deletion commit collision");
      }
    });
  }
  async verifyIndependentCheckpoint(
    snapshot: JournalSnapshot,
    options: { recoverPending?: boolean } = {},
  ): Promise<boolean> {
    if (!this.config.required && !this.config.witnessUrl) return false;
    // Recover uncertain producer attempts using the original immutable ID/hash.
    // These requests were authorized before they entered the local journal.
    for (const intent of options.recoverPending ? snapshot.intents : []) {
      if (intent.independentlyAcknowledged) continue;
      await this.serial(async () => {
        const envelope = validateEnvelope(
          await readRecord(
            join(this.directory, intent.body.id + ".intent.json"),
          ),
          intentSchema,
          this.config.key,
        );
        if (digest(envelope) !== intent.sha256)
          throw new Error("Pending deletion intent changed");
        await this.acknowledge(envelope);
      });
    }
    const nonce = randomBytes(32).toString("base64url");
    const proof = await witnessRequest(
      this.config,
      "checkpoint",
      { journalId: snapshot.journalId, nonce },
      this.request,
    );
    verifyWitnessProof(proof, snapshot, nonce, this.config.witnessPublicKey);
    return true;
  }
}
export async function openDeletionJournal(
  config: DeletionConfig,
  request: typeof fetch = fetch,
): Promise<DeletionJournal | undefined> {
  if (!config.directory) {
    if (config.required)
      throw new Error(
        "Production startup requires the independent deletion journal",
      );
    return undefined;
  }
  if (config.key.length < 32)
    throw new Error("Deletion journal key is not configured");
  await secureDirectory(config.directory);
  const genesis = validateEnvelope(
    await readRecord(join(config.directory, "metadata.json")),
    genesisSchema,
    config.key,
  );
  const journal = new DeletionJournal(config, genesis, request);
  await journal.snapshot();
  return journal;
}

/** Call record only after all authorization/precondition checks, while their DB locks remain held. */
export async function deletionTransaction<T>(
  pool: Pool,
  journal: DeletionJournal | undefined,
  operation: (
    db: PoolClient,
    record: (input: DeletionIntentInput) => Promise<void>,
  ) => Promise<T>,
): Promise<{
  value: T;
  deletion?: {
    requestId: string;
    state: "database_committed";
    independentAck: boolean;
  };
}> {
  let intent: StoredIntent | undefined;
  try {
    const value = await transaction(pool, async (db) =>
      operation(db, async (input) => {
        if (!journal) return;
        if (intent)
          throw new Error(
            "Only one deletion intent is permitted per transaction",
          );
        try {
          intent = await journal.recordAuthorizedIntent(input);
        } catch (error) {
          if (error instanceof DeletionIntentPendingError) {
            intent = error.intent;
            throw new ApiError(
              503,
              "DELETION_REQUEST_PENDING",
              "Запрос на удаление сохранен. Независимое подтверждение пока не получено, данные пока не изменены. Повторите запрос.",
            );
          }
          throw new ApiError(
            503,
            "DELETION_JOURNAL_UNAVAILABLE",
            "Запрос удаления пока не завершен: не получено надежное подтверждение журнала. Данные пока не изменены. Повторите запрос.",
          );
        }
      }),
    );
    if (!intent || !journal) return { value };
    await journal.markCommitted(intent);
    return {
      value,
      deletion: {
        requestId: intent.body.id,
        state: "database_committed",
        independentAck: intent.independentlyAcknowledged,
      },
    };
  } catch (error) {
    if (intent)
      throw new ApiError(
        503,
        "DELETION_REQUEST_PENDING",
        "Запрос на удаление сохранен, но завершение пока не подтверждено. Повторите запрос или обратитесь в поддержку.",
      );
    throw error;
  }
}
