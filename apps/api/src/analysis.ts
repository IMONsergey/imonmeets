import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { transaction } from "./db.js";
import { assert, canManage } from "./policy.js";
import { requireBudget } from "./limits.js";
import type { SuiteDependencies } from "./suite.js";

export { analysisSchema } from "./analysis-schema.js";

const MAX_RESULT_BYTES = 2 * 1024 * 1024;
export const ANALYSIS_TIMEOUT_MS = 90 * 60 * 1000;
export const WORKER_BUSY_DELAYS_MS = [1000, 2000, 5000, 10000, 20000, 30000];

export class AnalysisWorkerBusyError extends Error {
  constructor() {
    super("Analysis worker busy");
    this.name = "AnalysisWorkerBusyError";
  }
}

const modelDigest = z.string().regex(/^[a-f0-9]{64}$/);
const artifactSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_./-]+$/)
      .refine((path) =>
        path
          .split("/")
          .every((part) => part !== "" && part !== "." && part !== ".."),
      ),
    sha256: modelDigest,
    bytes: z
      .number()
      .int()
      .positive()
      .max(16 * 1024 * 1024 * 1024),
  })
  .strict();
export const analysisProvenanceSchema = z
  .object({
    schema: z.literal(1),
    manifestSha256: modelDigest,
    whisper: z
      .object({
        sha256: modelDigest,
        files: z
          .array(artifactSchema)
          .min(3)
          .max(128)
          .refine(
            (files) =>
              new Set(files.map((file) => file.path)).size === files.length &&
              ["model.bin", "config.json", "tokenizer.json"].every((name) =>
                files.some((file) => file.path === name),
              ),
          ),
      })
      .strict(),
    summary: z
      .object({
        sha256: modelDigest,
        bytes: z
          .number()
          .int()
          .min(24)
          .max(16 * 1024 * 1024 * 1024),
      })
      .strict()
      .optional(),
  })
  .strict();

export const analysisResultSchema = z.object({
  text: z.string().max(500_000),
  segments: z
    .array(
      z
        .object({
          start: z.number().finite().min(0),
          end: z.number().finite().min(0),
          text: z.string().max(10_000),
        })
        .refine((s) => s.end >= s.start),
    )
    .max(20_000),
  language: z.string().min(2).max(16),
  duration: z.number().finite().min(0).max(3600),
  model: z.string().min(1).max(160),
  summary: z.string().max(30_000).optional(),
  summaryModel: z.string().max(160).optional(),
  // Historical rows may predate provenance. New worker results must pass the gate below.
  provenance: analysisProvenanceSchema.optional(),
});

/** New results require measured identities bound to this release's approved manifest. */
export function verifyAnalysisProvenance(
  value: unknown,
  expectedManifest: string,
  summaryRequested: boolean,
) {
  const result = analysisResultSchema.parse(value);
  const provenance = result.provenance;
  if (
    !/^[a-f0-9]{64}$/.test(expectedManifest) ||
    !provenance ||
    provenance.manifestSha256 !== expectedManifest
  )
    throw new Error("Analysis model manifest mismatch");
  const files = [...provenance.whisper.files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => ({
      bytes: file.bytes,
      path: file.path,
      sha256: file.sha256,
    }));
  const measuredInventory = createHash("sha256")
    .update(JSON.stringify(files))
    .digest("hex");
  if (
    provenance.whisper.sha256 !== measuredInventory ||
    result.model !== "faster-whisper-sha256-" + measuredInventory
  )
    throw new Error("Analysis model identity mismatch");
  if (
    provenance.summary
      ? result.summaryModel !== "gguf-sha256-" + provenance.summary.sha256
      : result.summaryModel !== undefined
  )
    throw new Error("Analysis summary identity mismatch");
  if (
    summaryRequested &&
    result.text.trim() &&
    (!result.summary?.trim() || !provenance.summary)
  )
    throw new Error("Verified summary is missing");
  if (
    !summaryRequested &&
    (result.summary !== undefined || provenance.summary || result.summaryModel)
  )
    throw new Error("Unexpected summary processing");
  return result;
}

export async function readAnalysisResponse(response: Response) {
  if (!response.ok || !response.body)
    throw new Error("Analysis worker unavailable");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESULT_BYTES) {
        await reader.cancel();
        throw new Error("Analysis result too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return analysisResultSchema.parse(
    JSON.parse(Buffer.concat(chunks).toString("utf8")),
  );
}

/**
 * Native HTTP has no fetch/Undici five-minute response-header deadline.
 * Both socket inactivity and total duration are explicitly bounded. Redirects
 * are never followed, and provider bodies cannot escape into logs or API errors.
 */
export async function requestAnalysis(
  workerUrl: string,
  secret: string,
  job: {
    jobId: string;
    objectKey: string;
    language: string;
    summary: boolean;
  },
  signal: AbortSignal,
  timeoutMs = ANALYSIS_TIMEOUT_MS,
) {
  signal.throwIfAborted();
  const url = new URL("/transcribe", workerUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Invalid analysis worker URL");
  const body = JSON.stringify(job);
  return new Promise<z.infer<typeof analysisResultSchema>>(
    (resolve, reject) => {
      let settled = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const finish = (
        error?: Error,
        value?: z.infer<typeof analysisResultSchema>,
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (error) reject(error);
        else resolve(value!);
      };
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          method: "POST",
          signal,
          agent: false,
          maxHeaderSize: 8192,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            Authorization: "Bearer " + secret,
            Connection: "close",
          },
        },
        (response) => {
          const status = response.statusCode ?? 500;
          const limit = status === 200 ? MAX_RESULT_BYTES : 4096;
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > limit) {
              const error = new Error("Analysis result too large");
              finish(error);
              request.destroy(error);
              response.destroy();
            } else chunks.push(chunk);
          });
          response.once("aborted", () =>
            finish(new Error("Analysis response interrupted")),
          );
          response.once("error", () =>
            finish(new Error("Analysis worker unavailable")),
          );
          response.once("end", () => {
            if (settled) return;
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if (status === 503 && value?.error === "WORKER_BUSY")
                return finish(new AnalysisWorkerBusyError());
              if (status !== 200)
                return finish(new Error("Analysis worker unavailable"));
              finish(undefined, analysisResultSchema.parse(value));
            } catch {
              finish(new Error("Invalid analysis response"));
            }
          });
        },
      );
      request.once("error", (error) => finish(error));
      const timeout = () =>
        request.destroy(new Error("Analysis request timed out"));
      request.setTimeout(timeoutMs, timeout);
      deadline = setTimeout(timeout, timeoutMs);
      deadline.unref();
      request.end(body);
    },
  );
}

/** Temporary worker occupancy never fails the next queued job immediately. */
export async function retryBusyWorker<T>(
  request: () => Promise<T>,
  signal: AbortSignal,
  pause: (milliseconds: number, signal: AbortSignal) => Promise<void> = (
    milliseconds,
    currentSignal,
  ) => delay(milliseconds, undefined, { signal: currentSignal, ref: false }),
) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      return await request();
    } catch (error) {
      const wait = WORKER_BUSY_DELAYS_MS[attempt];
      if (!(error instanceof AnalysisWorkerBusyError) || wait === undefined)
        throw error;
      await pause(wait, signal);
    }
  }
}

/** Opt-in analysis of existing recordings. All processing endpoints are private. */
export async function registerAnalysis(
  app: FastifyInstance,
  d: SuiteDependencies,
) {
  const { c, pool, user, lockWorkspace, membership, audit, limiter } = d;
  const route =
    "/api/workspaces/:workspaceId/recordings/:recordingId/transcript";
  const params = (value: unknown) =>
    z
      .object({
        workspaceId: z.string().min(1).max(128),
        recordingId: z.string().min(1).max(128),
      })
      .parse(value);

  app.get(route, async (req) => {
    const u = (await user(req))!,
      { workspaceId, recordingId } = params(req.params);
    await membership(workspaceId, u.id);
    const rec = (
      await pool.query(
        "SELECT id FROM im_recordings WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL AND deletion_requested_at IS NULL AND (expires_at IS NULL OR expires_at>now())",
        [recordingId, workspaceId],
      )
    ).rows[0];
    assert(
      rec,
      404,
      "RECORDING_NOT_FOUND",
      "Запись не найдена или срок хранения истек.",
    );
    const row = (
      await pool.query(
        "SELECT * FROM im_recording_analysis WHERE recording_id=$1 AND workspace_id=$2 AND expires_at>now()",
        [recordingId, workspaceId],
      )
    ).rows[0];
    return {
      job: row
        ? {
            id: row.id,
            status: row.status,
            createdAt: row.created_at,
            completedAt: row.completed_at,
            error: row.error,
            withSummary: row.with_summary,
            ...(row.status === "complete" && row.result
              ? analysisResultSchema.parse(row.result)
              : {}),
          }
        : null,
    };
  });

  app.post(route, async (req) => {
    const u = (await user(req))!,
      { workspaceId, recordingId } = params(req.params);
    const body = z
      .object({
        language: z.enum(["auto", "ru", "en"]).default("auto"),
        summary: z.boolean().default(false),
      })
      .strict()
      .parse(req.body ?? {});
    assert(
      c.transcriptionConfigured,
      503,
      "TRANSCRIPTION_UNAVAILABLE",
      "Сервис расшифровки пока не подключен.",
    );
    assert(
      !body.summary || c.summaryConfigured,
      503,
      "SUMMARY_UNAVAILABLE",
      "Сервис AI-резюме пока не подключен.",
    );
    const result = await transaction(pool, async (db) => {
      const member = await lockWorkspace(db, workspaceId, u.id);
      const rec = (
        await db.query(
          "SELECT r.*,room.created_by FROM im_recordings r JOIN im_rooms room ON room.id=r.room_id WHERE r.id=$1 AND r.workspace_id=$2 FOR UPDATE OF r",
          [recordingId, workspaceId],
        )
      ).rows[0];
      assert(
        rec &&
          !rec.deleted_at &&
          !rec.deletion_requested_at &&
          (!rec.expires_at || new Date(rec.expires_at).getTime() > Date.now()),
        404,
        "RECORDING_NOT_FOUND",
        "Запись не найдена или срок хранения истек.",
      );
      assert(
        canManage(member.role, rec.created_by, u.id),
        403,
        "FORBIDDEN",
        "Только организатор может запускать обработку записи.",
      );
      assert(
        rec.status === "complete",
        409,
        "RECORDING_NOT_READY",
        "Дождитесь завершения записи.",
      );
      assert(
        Number(rec.size_bytes) > 0 &&
          Number(rec.size_bytes) <= 512 * 1024 * 1024,
        409,
        "ANALYSIS_FILE_LIMIT",
        "Обработка доступна для записей до 512 МБ.",
      );
      const existing = (
        await db.query(
          "SELECT * FROM im_recording_analysis WHERE recording_id=$1 FOR UPDATE",
          [recordingId],
        )
      ).rows[0];
      if (
        existing &&
        existing.status !== "failed" &&
        new Date(existing.expires_at).getTime() > Date.now()
      )
        return { id: existing.id, status: existing.status };
      await requireBudget(limiter, `analysis:${workspaceId}`, 10, 86400, db);
      await requireBudget(limiter, "analysis:global", 50, 86400, db);
      await db.query("SELECT pg_advisory_xact_lock(73621921)");
      const pending = (
        await db.query(
          "SELECT count(*)::int AS n FROM im_recording_analysis WHERE status IN ('queued','running')",
        )
      ).rows[0].n;
      assert(
        pending < 20,
        429,
        "ANALYSIS_QUEUE_FULL",
        "Очередь обработки заполнена. Повторите позже.",
      );
      const id = randomUUID();
      await db.query(
        "INSERT INTO im_recording_analysis(recording_id,workspace_id,id,requested_by,status,language,with_summary,expires_at) VALUES($1,$2,$3,$4,'queued',$5,$6,COALESCE($7,now()+($8*interval '1 day'))) ON CONFLICT(recording_id) DO UPDATE SET id=EXCLUDED.id,requested_by=EXCLUDED.requested_by,status='queued',language=EXCLUDED.language,with_summary=EXCLUDED.with_summary,created_at=now(),completed_at=NULL,result=NULL,error=NULL,attempts=0,lease_id=NULL,lease_until=NULL,expires_at=EXCLUDED.expires_at",
        [
          recordingId,
          workspaceId,
          id,
          u.id,
          body.language,
          body.summary,
          rec.expires_at,
          c.recordingRetentionDays,
        ],
      );
      await audit(
        db,
        workspaceId,
        u.id,
        "recording.analysis_requested",
        recordingId,
      );
      return { id, status: "queued" };
    });
    void tick();
    return { job: result };
  });

  app.delete(route, async (req) => {
    const u = (await user(req))!,
      { workspaceId, recordingId } = params(req.params);
    const deletedId = await transaction(pool, async (db) => {
      const member = await lockWorkspace(db, workspaceId, u.id);
      const rec = (
        await db.query(
          "SELECT r.id,room.created_by FROM im_recordings r JOIN im_rooms room ON room.id=r.room_id WHERE r.id=$1 AND r.workspace_id=$2 FOR UPDATE OF r",
          [recordingId, workspaceId],
        )
      ).rows[0];
      assert(rec, 404, "RECORDING_NOT_FOUND", "Запись не найдена.");
      assert(
        canManage(member.role, rec.created_by, u.id),
        403,
        "FORBIDDEN",
        "Недостаточно прав.",
      );
      const deleted = await db.query(
        "DELETE FROM im_recording_analysis WHERE recording_id=$1 AND workspace_id=$2 RETURNING id",
        [recordingId, workspaceId],
      );
      await audit(
        db,
        workspaceId,
        u.id,
        "recording.analysis_deleted",
        recordingId,
      );
      return deleted.rows[0]?.id as string | undefined;
    });
    // Only cancel the deleted generation; a concurrently retried job has a new ID.
    if (deletedId && active?.job.id === deletedId) {
      active.invalidated = true;
      active.controller.abort();
    }
    return { ok: true };
  });

  type AnalysisJob = {
    id: string;
    recording_id: string;
    object_key: string;
    language: string;
    with_summary: boolean;
    lease_id: string;
  };
  type ActiveJob = {
    job: AnalysisJob;
    controller: AbortController;
    invalidated: boolean;
  };
  let stopped = false;
  let active: ActiveJob | undefined;
  let processing: Promise<void> | undefined;
  let maintaining: Promise<void> | undefined;

  // This sweep must run while the worker is occupied. Its short renewable lease
  // also permits recovery after a crashed API, without a two-hour queue stall.
  async function maintain() {
    try {
      await pool.query(
        "DELETE FROM im_recording_analysis a WHERE a.expires_at<=now() OR EXISTS(SELECT 1 FROM im_recordings r WHERE r.id=a.recording_id AND (r.deleted_at IS NOT NULL OR r.deletion_requested_at IS NOT NULL OR r.expires_at<=now()))",
      );
      const running = active;
      if (stopped || !running || running.controller.signal.aborted) return;
      const valid = await pool.query(
        "UPDATE im_recording_analysis a SET lease_until=now()+interval '2 minutes' WHERE a.id=$1 AND a.lease_id=$2 AND a.status='running' AND a.expires_at>now() AND EXISTS(SELECT 1 FROM im_recordings r WHERE r.id=a.recording_id AND r.deleted_at IS NULL AND r.deletion_requested_at IS NULL AND (r.expires_at IS NULL OR r.expires_at>now())) RETURNING a.id",
        [running.job.id, running.job.lease_id],
      );
      if (!valid.rowCount && active === running) {
        running.invalidated = true;
        running.controller.abort();
      }
    } catch {
      // Do not process private media without being able to revalidate its lease.
      active?.controller.abort();
      if (!stopped) app.log.warn("Recording analysis maintenance unavailable");
    }
  }
  function sweep(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (maintaining) return maintaining;
    maintaining = maintain().finally(() => {
      maintaining = undefined;
    });
    return maintaining;
  }
  async function requeue(job: AnalysisJob) {
    await pool.query(
      "UPDATE im_recording_analysis a SET status='queued',attempts=GREATEST(attempts-1,0),lease_id=NULL,lease_until=NULL,error=NULL WHERE a.id=$1 AND a.lease_id=$2 AND a.status='running' AND a.expires_at>now() AND EXISTS(SELECT 1 FROM im_recordings r WHERE r.id=a.recording_id AND r.deleted_at IS NULL AND r.deletion_requested_at IS NULL AND (r.expires_at IS NULL OR r.expires_at>now()))",
      [job.id, job.lease_id],
    );
  }
  async function processNext() {
    let job: AnalysisJob | undefined;
    let running: ActiveJob | undefined;
    try {
      await sweep();
      if (stopped || !c.transcriptionConfigured) return;
      job = await transaction(pool, async (db) => {
        await db.query("SELECT pg_advisory_xact_lock(73621922)");
        await db.query(
          "UPDATE im_recording_analysis SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,error=CASE WHEN attempts>=3 THEN 'Обработка не завершилась. Можно повторить запрос.' ELSE NULL END,lease_id=NULL,lease_until=NULL WHERE status='running' AND lease_until<now()",
        );
        if (
          (
            await db.query(
              "SELECT 1 FROM im_recording_analysis WHERE status='running' AND lease_until>now() LIMIT 1",
            )
          ).rowCount
        )
          return undefined;
        const row = (
          await db.query(
            "SELECT a.*,r.object_key FROM im_recording_analysis a JOIN im_recordings r ON r.id=a.recording_id WHERE a.status='queued' AND a.expires_at>now() AND r.deleted_at IS NULL AND r.deletion_requested_at IS NULL AND (r.expires_at IS NULL OR r.expires_at>now()) AND r.status='complete' ORDER BY a.created_at LIMIT 1 FOR UPDATE OF a SKIP LOCKED",
          )
        ).rows[0];
        if (!row) return undefined;
        row.lease_id = randomUUID();
        await db.query(
          "UPDATE im_recording_analysis SET status='running',attempts=attempts+1,lease_id=$2,lease_until=now()+interval '2 minutes',error=NULL WHERE id=$1",
          [row.id, row.lease_id],
        );
        return row as AnalysisJob;
      });
      if (!job) return;
      if (stopped) {
        await requeue(job);
        return;
      }
      running = { job, controller: new AbortController(), invalidated: false };
      active = running;
      await sweep();
      running.controller.signal.throwIfAborted();
      const current = running;
      const result = await retryBusyWorker(
        () =>
          requestAnalysis(
            c.analysis.workerUrl,
            c.analysis.workerSecret,
            {
              jobId: current.job.id,
              objectKey: current.job.object_key,
              language: current.job.language,
              summary: current.job.with_summary,
            },
            current.controller.signal,
          ),
        current.controller.signal,
      );
      verifyAnalysisProvenance(
        result,
        c.analysis.modelManifestSha256,
        job.with_summary,
      );
      if (job.with_summary && !result.summary)
        throw new Error("Summary missing");
      await pool.query(
        "UPDATE im_recording_analysis SET status='complete',result=$3::jsonb,completed_at=now(),lease_id=NULL,lease_until=NULL,error=NULL WHERE id=$1 AND lease_id=$2 AND status='running' AND expires_at>now() AND EXISTS(SELECT 1 FROM im_recordings r WHERE r.id=recording_id AND r.deleted_at IS NULL AND r.deletion_requested_at IS NULL AND (r.expires_at IS NULL OR r.expires_at>now()))",
        [job.id, job.lease_id, JSON.stringify(result)],
      );
    } catch (error) {
      if (job) {
        if (stopped) await requeue(job).catch(() => {});
        else if (!running?.invalidated)
          await pool
            .query(
              "UPDATE im_recording_analysis SET status='failed',error=$3,lease_id=NULL,lease_until=NULL WHERE id=$1 AND lease_id=$2 AND status='running'",
              [
                job.id,
                job.lease_id,
                error instanceof AnalysisWorkerBusyError
                  ? "Обработчик занят. Повторите запрос позже."
                  : "Не удалось обработать запись. Повторите позже.",
              ],
            )
            .catch(() => {});
      }
      // Intentionally omit worker URLs, secrets, file keys and transcript text from logs.
      if (!stopped && !running?.invalidated)
        app.log.warn("Recording analysis did not complete");
    } finally {
      if (active === running) active = undefined;
    }
  }
  function tick(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (processing) return processing;
    processing = processNext().finally(() => {
      processing = undefined;
    });
    return processing;
  }
  const timer = setInterval(() => {
    void sweep();
    void tick();
  }, 5_000);
  timer.unref();
  app.addHook("onReady", async () => {
    void tick();
  });
  // preClose runs before app onClose hooks can close the shared database pool.
  app.addHook("preClose", async () => {
    stopped = true;
    clearInterval(timer);
    active?.controller.abort();
    await Promise.all([processing, maintaining]);
  });
}
