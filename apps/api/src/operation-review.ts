import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient, QueryResultRow } from "pg";
import { z } from "zod";
import type { EgressInfo } from "livekit-server-sdk";
import { transaction } from "./db.js";
import { assert, ApiError } from "./policy.js";
import { requireBudget } from "./limits.js";
import {
  applyRecordingInfo,
  matchesRecording,
  matchingOutput,
  recordingTransition,
} from "./recordings.js";
import type { SuiteDependencies } from "./suite.js";

export const reviewIntent = z.object({
  apply: z.boolean().default(false),
  version: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  previewAuditId: z
    .string()
    .regex(/^[1-9][0-9]{0,18}$/)
    .refine((value) => BigInt(value) <= 9223372036854775807n)
    .optional(),
});
export type ReviewIntent = z.infer<typeof reviewIntent>;
export function reviewVersion(state: unknown) {
  return createHash("sha256")
    .update(
      JSON.stringify(state, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    )
    .digest("hex");
}
export async function reviewAudit(
  db: PoolClient,
  workspaceId: string,
  actorId: string,
  kind: "payment" | "recording",
  resourceId: string,
  stage: "preview" | "applied",
  version: string,
) {
  const result = await db.query(
    "INSERT INTO im_audit(workspace_id,actor_id,event,resource_id,reconciliation_version) VALUES($1,$2,$3,$4,$5) RETURNING id",
    [
      workspaceId,
      actorId,
      kind + ".reconciliation." + stage,
      resourceId,
      version,
    ],
  );
  return { auditId: String(result.rows[0].id), version };
}
export async function assertReview(
  db: PoolClient,
  workspaceId: string,
  actorId: string,
  kind: "payment" | "recording",
  resourceId: string,
  intent: ReviewIntent,
  version: string,
) {
  assert(
    intent.previewAuditId && intent.version,
    400,
    "REVIEW_REQUIRED",
    "Сначала получите предварительную сверку.",
  );
  const prior = await db.query(
    "SELECT 1 FROM im_audit WHERE id=$1 AND workspace_id=$2 AND actor_id=$3 AND resource_id=$4 AND event=$5 AND reconciliation_version=$6 AND created_at>now()-interval '15 minutes'",
    [
      intent.previewAuditId,
      workspaceId,
      actorId,
      resourceId,
      kind + ".reconciliation.preview",
      version,
    ],
  );
  assert(
    intent.version === version && prior.rowCount,
    409,
    "REVIEW_CHANGED",
    "Состояние изменилось или предварительная сверка истекла. Получите новую сверку.",
  );
}
function recordingState(row: QueryResultRow, info: EgressInfo) {
  const transition = recordingTransition(row.status, info, row.object_key);
  const file = matchingOutput(info, row.object_key);
  return {
    local: {
      id: row.id,
      status: row.status,
      egressId: row.egress_id,
      mediaName: row.media_name,
      objectKeyHash: reviewVersion(row.object_key),
      sizeBytes: row.size_bytes === null ? null : String(row.size_bytes),
    },
    canonical: {
      egressId: info.egressId,
      mediaName: info.roomName,
      status: info.status,
      outputMatches: true,
      sizeBytes: file ? String(file.size) : null,
      nextStatus: transition?.status ?? row.status,
    },
  };
}
function assertRecording(
  row: QueryResultRow | undefined,
  info: EgressInfo,
  egressId: string,
) {
  assert(
    row && !row.deleted_at,
    404,
    "RECORDING_NOT_FOUND",
    "Запись не найдена.",
  );
  assert(
    ["starting", "active", "ending"].includes(row.status),
    409,
    "RECORDING_ALREADY_TERMINAL",
    "Состояние записи уже завершено. Повторное изменение запрещено.",
  );
  assert(
    typeof row.media_name === "string" &&
      (row.media_name === row.room_id ||
        new RegExp("^" + row.room_id + "-g[1-9][0-9]*$").test(row.media_name)),
    409,
    "RECORDING_GENERATION_UNKNOWN",
    "Поколение медиакомнаты не подтверждено. Нужна сверка журналов оператора.",
  );
  assert(
    info.egressId === egressId &&
      (!row.egress_id || row.egress_id === egressId) &&
      info.roomName === row.media_name &&
      matchesRecording(info, row.object_key),
    409,
    "RECORDING_MISMATCH",
    "Задание записи не совпадает с сохраненной комнатой и файлом.",
  );
  assert(
    recordingTransition(row.status, info, row.object_key),
    409,
    "RECORDING_STATE_UNCONFIRMED",
    "Состояние задания не позволяет подтвердить переход записи.",
  );
}
/** Owner-only repair of an existing reservation. Never starts/stops an external job or infers failure from absence. */
export async function registerOperationReview(
  app: FastifyInstance,
  d: SuiteDependencies,
) {
  const { c, pool, media, user, membership, lockWorkspace, limiter } = d;
  app.post(
    "/api/workspaces/:workspaceId/recordings/:recordingId/reconcile",
    async (req) => {
      const u = (await user(req))!;
      const p = z
        .object({
          workspaceId: z.string().min(1).max(128),
          recordingId: z.uuid(),
        })
        .parse(req.params);
      const b = reviewIntent
        .extend({ egressId: z.string().regex(/^EG_[A-Za-z0-9_-]{1,120}$/) })
        .strict()
        .parse(req.body);
      const m = await membership(p.workspaceId, u.id);
      assert(
        m.role === "owner",
        403,
        "FORBIDDEN",
        "Сверка доступна владельцу рабочего пространства.",
      );
      const row = (
        await pool.query(
          "SELECT * FROM im_recordings WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL",
          [p.workspaceId, p.recordingId],
        )
      ).rows[0];
      assert(row, 404, "RECORDING_NOT_FOUND", "Запись не найдена.");
      assert(
        c.mediaConfigured,
        503,
        "MEDIA_UNAVAILABLE",
        "Медиасервис не подключен.",
      );
      await requireBudget(limiter, "recording-review:user:" + u.id, 12, 3600);
      await requireBudget(
        limiter,
        "recording-review:workspace:" + p.workspaceId,
        24,
        3600,
      );
      await requireBudget(limiter, "recording-review:global", 60, 60);
      let jobs: EgressInfo[];
      try {
        jobs = await media.egress.listEgress({ egressId: b.egressId });
      } catch {
        throw new ApiError(
          503,
          "RECORDING_CHECK_PENDING",
          "Медиасервис не подтвердил состояние записи. Резервирование сохранено.",
        );
      }
      const matching = jobs.filter((job) => job.egressId === b.egressId);
      assert(
        matching.length === 1,
        503,
        "RECORDING_CHECK_PENDING",
        "Задание записи не найдено однозначно. Это не подтверждает отсутствие записи; резервирование сохранено.",
      );
      const info = matching[0]!;
      assertRecording(row, info, b.egressId);
      return transaction(pool, async (db) => {
        const fresh = await lockWorkspace(db, p.workspaceId, u.id);
        assert(fresh.role === "owner", 403, "FORBIDDEN", "Недостаточно прав.");
        const current = (
          await db.query(
            "SELECT * FROM im_recordings WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
            [p.workspaceId, p.recordingId],
          )
        ).rows[0];
        assertRecording(current, info, b.egressId);
        const state = recordingState(current, info),
          version = reviewVersion(state);
        if (b.apply) {
          await assertReview(
            db,
            p.workspaceId,
            u.id,
            "recording",
            p.recordingId,
            b,
            version,
          );
          const updated = await applyRecordingInfo(db, current, info);
          const receipt = await reviewAudit(
            db,
            p.workspaceId,
            u.id,
            "recording",
            p.recordingId,
            "applied",
            version,
          );
          return {
            mode: "applied",
            ...receipt,
            recording: {
              id: updated.id,
              status: updated.status,
              sizeBytes: updated.size_bytes,
            },
          };
        }
        const receipt = await reviewAudit(
          db,
          p.workspaceId,
          u.id,
          "recording",
          p.recordingId,
          "preview",
          version,
        );
        return { mode: "preview", ...receipt, ...state };
      });
    },
  );
}
