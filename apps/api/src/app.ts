import {
  publicInformationSummary,
  publishedDocument,
  isApplicationPage,
} from "./public-information.js";
import { openDeletionJournal } from "./deletion-journal.js";
import { replayDeletionJournal } from "./deletion-replay.js";
import Fastify, { type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import staticPlugin from "@fastify/static";
import { fromNodeHeaders } from "better-auth/node";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { TrackSource } from "livekit-server-sdk";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  createAuth,
  createMailer,
  MailDeliveryError,
  drainAuthTasks,
} from "./auth.js";
import { registerIdentityRoutes } from "./identity.js";
import {
  legalConsentStatus,
  requireLegalAcceptance,
  registerLegalConsent,
} from "./legal-consent.js";
import type { Config } from "./config.js";
import { createPool, transaction } from "./db.js";
import {
  ApiError,
  assert,
  canManage,
  canInvite,
  canRemove,
  validOrigin,
  type Role,
} from "./policy.js";
import { createMedia, type Media } from "./media.js";
import { applyRecordingInfo, matchesRecording } from "./recordings.js";
import { postgresLimiter, requireBudget, type RateLimiter } from "./limits.js";
import { mediaRoomName } from "./media.js";
import { clientIp, proxySecretMatches, rateLimitIp } from "./proxy.js";
import { registerSuite, admissionForJoin, createChatSession } from "./suite.js";
import { registerAnalysis } from "./analysis.js";
import { registerBilling, workspaceLimits } from "./billing.js";
import { registerOperationReview } from "./operation-review.js";
import {
  assertRoomUnblocked,
  participantModeration,
  registerModeration,
  roomVisitorKey,
} from "./moderation.js";
import { framePolicy, isEmbedPath } from "./embedding.js";

type Row = QueryResultRow;
type User = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  twoFactorEnabled?: boolean | null;
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const slug = () => randomBytes(24).toString("base64url");
const roomFields = z
  .object({
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().max(4000).optional(),
    startsAt: z.iso.datetime({ offset: true }).nullable().optional(),
    durationMinutes: z.number().int().min(5).max(1440).optional(),
    allowGuests: z.boolean().optional(),
    waitingRoom: z.boolean().optional(),
    maxParticipants: z.number().int().min(2).max(100).optional(),
  })
  .strict();
const roomJson = (r: Row) => ({
  id: r.id,
  workspaceId: r.workspace_id,
  slug: r.slug,
  title: r.title,
  description: r.description,
  startsAt: r.starts_at,
  durationMinutes: r.duration_minutes,
  allowGuests: r.allow_guests,
  waitingRoom: r.waiting_room,
  guestAdmissionRequired: Boolean(r.guest_admission_required),
  maxParticipants: r.max_participants,
  status: r.status,
  createdBy: r.created_by,
  createdAt: r.created_at,
  archivedAt: r.archived_at ?? null,
});
const recordingJson = (r: Row) => ({
  id: r.id,
  roomId: r.room_id,
  roomTitle: r.room_title,
  status: r.status,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
  error: r.error,
  expiresAt: r.expires_at ?? null,
  deletionPending: Boolean(r.deletion_requested_at && !r.deleted_at),
  deletedAt: r.deleted_at ?? null,
  hasTranscript: Boolean(r.has_transcript),
});
const workspaceJson = (r: Row) => ({
  id: r.id,
  name: r.name,
  role: r.role,
  createdAt: r.created_at,
});
const invitationJson = (r: Row) => ({
  id: r.id,
  email: r.email,
  role: r.role,
  expiresAt: r.expires_at,
});
function params(r: FastifyRequest) {
  return r.params as Record<string, string>;
}
export async function createApp(
  c: Config,
  options: {
    pool?: Pool;
    media?: Media;
    logger?: boolean;
    limiter?: RateLimiter;
    paymentRequest?: typeof fetch;
    auth?: ReturnType<typeof createAuth>;
    sendMail?: ReturnType<typeof createMailer>;
  } = {},
) {
  const pool = options.pool || createPool(c.databaseUrl),
    sendMail = options.sendMail ?? createMailer(c, pool),
    auth = options.auth || createAuth(c, pool, sendMail),
    media = options.media || createMedia(c),
    limiter = options.limiter ?? postgresLimiter(pool);
  // Migrations are the release entrypoint prerequisite. Recover deletions before any listener or timer.
  const deletionJournal = await openDeletionJournal(c.deletionJournal);
  if (deletionJournal)
    await replayDeletionJournal(pool, deletionJournal, media, c);
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 1024 * 1024,
    trustProxy: false,
    disableRequestLogging: true,
  });
  await app.register(rateLimit, {
    global: false,
    keyGenerator: (req) => rateLimitIp(clientIp(req, c.originProxySecret)),
    errorResponseBuilder: () =>
      new ApiError(
        429,
        "RATE_LIMIT",
        "Слишком много запросов. Повторите позже.",
      ),
  });
  app.setErrorHandler((e, req, reply) => {
    if (req.url.split("?")[0] === "/api/internal/livekit/authorize")
      return reply
        .code(
          e instanceof ApiError && [401, 403].includes(e.status)
            ? e.status
            : 503,
        )
        .send();
    if (e instanceof ApiError) {
      if (e.retryAfter) reply.header("Retry-After", String(e.retryAfter));
      return reply
        .code(e.status)
        .send({ error: { code: e.code, message: e.message } });
    }
    if (e instanceof z.ZodError)
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Проверьте поля запроса.",
        },
      });
    if ((e as { code?: string }).code === "23505")
      return reply.code(409).send({
        error: { code: "CONFLICT", message: "Такая запись уже существует." },
      });
    if ((e as { statusCode?: number }).statusCode === 429)
      return reply.code(429).send({
        error: { code: "RATE_LIMIT", message: "Слишком много запросов." },
      });
    const statusCode = (e as { statusCode?: number }).statusCode;
    if (statusCode === 413 || statusCode === 415)
      return reply.code(statusCode).send({
        error: {
          code:
            statusCode === 413 ? "PAYLOAD_TOO_LARGE" : "UNSUPPORTED_MEDIA_TYPE",
          message:
            statusCode === 413
              ? "Слишком большой запрос."
              : "Неподдерживаемый формат запроса.",
        },
      });
    if ((e as { statusCode?: number }).statusCode === 400)
      return reply.code(400).send({
        error: { code: "INVALID_REQUEST", message: "Некорректный запрос." },
      });
    if (
      ["55P03", "57014", "40001", "40P01"].includes(
        (e as { code?: string }).code ?? "",
      )
    )
      return reply
        .code(503)
        .header("Retry-After", "2")
        .send({
          error: {
            code: "RETRY_REQUIRED",
            message: "Запрос занят другой операцией. Повторите позже.",
          },
        });
    req.log.error({ err: e }, "Request failed");
    return reply.code(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "Не удалось выполнить запрос.",
      },
    });
  });
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0]!;
    const framing = framePolicy(path, c.embedAllowedOrigins);
    reply.header("X-Content-Type-Options", "nosniff");
    if (!framing.enabled) reply.header("X-Frame-Options", "DENY");
    reply.header("Content-Security-Policy", framing.policy);
    reply.header("Referrer-Policy", "no-referrer");
    if (path.startsWith("/api/") || isEmbedPath(path))
      reply.header("Cache-Control", "no-store");
    if (
      c.originProxySecret &&
      (path.startsWith("/api/") || isEmbedPath(path)) &&
      path !== "/api/health"
    )
      assert(
        proxySecretMatches(req, c.originProxySecret),
        403,
        "PROXY_REJECTED",
        "Доступ через этот адрес не разрешен.",
      );
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
      !["/api/livekit/webhook", "/api/billing/yookassa/webhook"].includes(
        req.url.split("?")[0]!,
      )
    ) {
      assert(
        validOrigin(req.headers.origin, c.appUrl),
        403,
        "ORIGIN_REJECTED",
        "Источник запроса не разрешен.",
      );
    }
    if (
      path.startsWith("/api/") &&
      path !== "/api/health" &&
      path !== "/api/livekit/webhook"
    ) {
      const ip = rateLimitIp(clientIp(req, c.originProxySecret));
      try {
        const budget = path.startsWith("/api/auth/")
          ? { key: "auth", max: 30 }
          : path.endsWith("/join")
            ? { key: "join-ip", max: 600 }
            : { key: "api-ip", max: 6000 };
        const result = await limiter.consume(
          `${budget.key}:${ip}`,
          budget.max,
          60,
        );
        if (!result.allowed) {
          reply.header("Retry-After", String(result.retryAfter ?? 60));
          throw new ApiError(
            429,
            "RATE_LIMIT",
            "Слишком много запросов. Повторите позже.",
          );
        }
      } catch (e) {
        if (e instanceof ApiError) throw e;
        throw new ApiError(
          503,
          "LIMITER_UNAVAILABLE",
          "Сервис временно недоступен. Повторите позже.",
        );
      }
    }
  });
  function authHeaders(req: FastifyRequest) {
    const headers = fromNodeHeaders(req.headers);
    headers.set("x-imon-client-ip", clientIp(req, c.originProxySecret));
    return headers;
  }
  // A coarse IP ceiling handles anonymous abuse. Verified users and room
  // capabilities receive their own budgets so an office NAT is not one user.
  const budgetedUsers = new WeakSet<FastifyRequest>();
  async function user(
    req: FastifyRequest,
    required = true,
  ): Promise<User | null> {
    const headers = fromNodeHeaders(req.headers);
    headers.set("x-imon-client-ip", clientIp(req, c.originProxySecret));
    const session = await auth.api.getSession({ headers });
    assert(!required || session, 401, "UNAUTHENTICATED", "Войдите в аккаунт.");
    if (!session) return null;
    assert(
      c.dev || session.user.emailVerified,
      403,
      "EMAIL_UNVERIFIED",
      "Подтвердите адрес почты.",
    );
    if (!budgetedUsers.has(req)) {
      await requireBudget(limiter, `api-user:${session.user.id}`, 300, 60);
      budgetedUsers.add(req);
    }
    await requireLegalAcceptance(pool, c, session.user.id, req);
    return session.user;
  }
  async function membership(
    workspaceId: string,
    userId: string,
    db: Pool | PoolClient = pool,
  ) {
    const r = await db.query(
      "SELECT * FROM im_members WHERE workspace_id=$1 AND user_id=$2",
      [workspaceId, userId],
    );
    assert(
      r.rows[0],
      404,
      "WORKSPACE_NOT_FOUND",
      "Рабочее пространство не найдено.",
    );
    return r.rows[0] as Row & { role: Role };
  }
  async function lockWorkspace(
    db: PoolClient,
    workspaceId: string,
    userId: string,
  ) {
    const found = await db.query(
      "SELECT id FROM im_workspaces WHERE id=$1 FOR NO KEY UPDATE",
      [workspaceId],
    );
    assert(
      found.rowCount,
      404,
      "WORKSPACE_NOT_FOUND",
      "Рабочее пространство не найдено.",
    );
    return membership(workspaceId, userId, db);
  }
  async function retireMedia(db: PoolClient, room: Row) {
    await db.query(
      "INSERT INTO im_media_retirements(name,workspace_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [
        mediaRoomName(room as { id: string; media_generation: number }),
        room.workspace_id,
      ],
    );
  }
  async function drainRetirements(
    workspaceId?: string,
    maxJobs = 12,
    onlyName?: string,
  ) {
    if (!c.mediaConfigured) return false;
    const jobs = await transaction(pool, async (db) => {
      const rows = await db.query(
        "SELECT name FROM im_media_retirements WHERE next_attempt_at<=now() AND ($1::text IS NULL OR workspace_id=$1) AND ($3::text IS NULL OR name=$3) ORDER BY next_attempt_at,name LIMIT $2 FOR UPDATE SKIP LOCKED",
        [workspaceId ?? null, maxJobs, onlyName ?? null],
      );
      for (const row of rows.rows)
        await db.query(
          "UPDATE im_media_retirements SET attempts=attempts+1,next_attempt_at=now()+interval '60 seconds' WHERE name=$1",
          [row.name],
        );
      return rows.rows;
    });
    for (let i = 0; i < jobs.length; i += 4)
      await Promise.all(
        jobs.slice(i, i + 4).map(async (job) => {
          try {
            try {
              await media.rooms.deleteRoom(job.name);
            } catch (e) {
              if ((e as { code?: string }).code !== "not_found") throw e;
            }
            await transaction(pool, async (db) => {
              await db.query(
                "UPDATE im_rooms SET media_closed=true WHERE status='closed' AND CASE WHEN media_generation=0 THEN id ELSE id||'-g'||media_generation END=$1",
                [job.name],
              );
              await db.query("DELETE FROM im_media_retirements WHERE name=$1", [
                job.name,
              ]);
            });
          } catch {
            await pool.query(
              "UPDATE im_media_retirements SET next_attempt_at=now()+LEAST(600,power(2,LEAST(attempts,8))*5)*interval '1 second',last_error='LiveKit room deletion failed' WHERE name=$1",
              [job.name],
            );
          }
        }),
      );
    return !(
      await pool.query(
        "SELECT 1 FROM im_media_retirements WHERE ($1::text IS NULL OR workspace_id=$1) AND ($2::text IS NULL OR name=$2) LIMIT 1",
        [workspaceId ?? null, onlyName ?? null],
      )
    ).rowCount;
  }
  async function scopedRoom(
    workspaceId: string,
    roomId: string,
    db: Pool | PoolClient = pool,
    lock = false,
  ) {
    const r = await db.query(
      `SELECT * FROM im_rooms WHERE workspace_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`,
      [workspaceId, roomId],
    );
    assert(r.rows[0], 404, "ROOM_NOT_FOUND", "Встреча не найдена.");
    return r.rows[0];
  }
  async function audit(
    db: Pool | PoolClient,
    workspaceId: string | null,
    actorId: string | null,
    event: string,
    resourceId: string | null,
  ) {
    await db.query(
      "INSERT INTO im_audit(workspace_id,actor_id,event,resource_id) VALUES($1,$2,$3,$4)",
      [workspaceId, actorId, event, resourceId],
    );
  }
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    config: { rateLimit: false },
    handler: async (req, reply) => {
      if (
        !c.emailConfigured &&
        (req.url.includes("request-password-reset") ||
          req.url.includes("send-verification-email"))
      )
        throw new ApiError(
          503,
          "EMAIL_UNAVAILABLE",
          "Отправка почты не настроена.",
        );
      if (
        req.url.split("?")[0] === "/api/auth/change-password" &&
        req.body &&
        typeof req.body === "object"
      )
        req.body = { ...req.body, revokeOtherSessions: true };
      const authPath = req.url.split("?")[0]!;
      assert(
        !authPath.includes("%"),
        400,
        "INVALID_AUTH_PATH",
        "Некорректный путь запроса.",
      );
      if (
        c.emailConfigured &&
        req.method === "POST" &&
        [
          "/api/auth/sign-up/email",
          "/api/auth/send-verification-email",
          "/api/auth/request-password-reset",
        ].includes(authPath) &&
        !(authPath === "/api/auth/sign-up/email" && !c.registrationEnabled)
      ) {
        const candidate = z
          .object({ email: z.email().max(254) })
          .safeParse(req.body);
        if (candidate.success)
          await requireBudget(
            limiter,
            `email-request:${candidate.data.email.toLowerCase()}`,
            5,
            3600,
          );
      }
      const headers = fromNodeHeaders(req.headers);
      headers.set("x-imon-client-ip", clientIp(req, c.originProxySecret));
      if (req.method === "POST" && authPath === "/api/auth/link-social") {
        const linkingSession = await auth.api.getSession({ headers });
        assert(
          linkingSession,
          401,
          "AUTH_REQUIRED",
          "Войдите в аккаунт, чтобы привязать внешний вход.",
        );
        assert(
          linkingSession.user.emailVerified,
          403,
          "EMAIL_NOT_VERIFIED",
          "Сначала подтвердите почту существующего аккаунта.",
        );
      }
      const sensitiveAction = [
        "/api/auth/two-factor/verify-totp",
        "/api/auth/two-factor/disable",
        "/api/auth/change-password",
        "/api/auth/reset-password",
      ].includes(authPath);
      const previousSession = sensitiveAction
        ? await auth.api.getSession({ headers })
        : null;
      const oldSessionIds =
        previousSession &&
        [
          "/api/auth/two-factor/verify-totp",
          "/api/auth/two-factor/disable",
        ].includes(authPath)
          ? (
              await pool.query('SELECT id FROM "session" WHERE "userId"=$1', [
                previousSession.user.id,
              ])
            ).rows.map((row) => row.id)
          : [];
      let passwordResetUser: string | undefined;
      if (
        authPath === "/api/auth/reset-password" &&
        req.body &&
        typeof req.body === "object" &&
        "token" in req.body &&
        typeof req.body.token === "string"
      )
        passwordResetUser = (
          await pool.query(
            'SELECT value FROM "verification" WHERE identifier=$1',
            [`reset-password:${req.body.token}`],
          )
        ).rows[0]?.value;
      const response = await auth.handler(
        new Request(new URL(req.url, c.appUrl), {
          method: req.method,
          headers,
          ...(req.body ? { body: JSON.stringify(req.body) } : {}),
        }),
      );
      reply.code(response.status);
      response.headers.forEach((value, key) => {
        if (key !== "set-cookie") reply.header(key, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) reply.header("set-cookie", cookies);
      const body = await response.text();
      if (response.ok && previousSession && oldSessionIds.length) {
        const currentUser = (
          await pool.query(
            'SELECT "twoFactorEnabled" FROM "user" WHERE id=$1',
            [previousSession.user.id],
          )
        ).rows[0];
        if (
          authPath === "/api/auth/two-factor/disable" ||
          (!previousSession.user.twoFactorEnabled &&
            currentUser?.twoFactorEnabled)
        ) {
          await pool.query(
            'DELETE FROM "session" WHERE "userId"=$1 AND id=ANY($2::text[])',
            [previousSession.user.id, oldSessionIds],
          );
          await pool.query(
            `DELETE FROM "verification" WHERE value=$1 AND (identifier LIKE '2fa-%' OR identifier LIKE 'trust-device-%')`,
            [previousSession.user.id],
          );
        }
      }
      if (
        response.ok &&
        ["/api/auth/change-password", "/api/auth/reset-password"].includes(
          authPath,
        )
      ) {
        const changedId = previousSession?.user.id ?? passwordResetUser;
        if (changedId)
          await pool.query(
            `DELETE FROM "verification" WHERE value=$1 AND (identifier LIKE '2fa-%' OR identifier LIKE 'trust-device-%')`,
            [changedId],
          );
      }
      const action = req.url.split("?")[0]!.slice("/api/auth/".length);
      if (
        [
          "sign-in/email",
          "sign-up/email",
          "sign-out",
          "change-password",
          "reset-password",
          "verify-email",
          "send-verification-email",
          "request-password-reset",
          "two-factor/enable",
          "two-factor/verify-totp",
          "two-factor/verify-backup-code",
          "two-factor/disable",
          "two-factor/generate-backup-codes",
        ].includes(action)
      ) {
        let actorId: string | null = null;
        try {
          const parsed = JSON.parse(body) as { user?: { id?: unknown } };
          if (typeof parsed.user?.id === "string") actorId = parsed.user.id;
        } catch {}
        try {
          await audit(
            pool,
            null,
            actorId,
            `auth.${action}.${response.status}`,
            null,
          );
        } catch (e) {
          req.log.error({ err: e }, "Authentication audit write failed");
        }
      }
      return reply.send(body);
    },
  });
  app.get("/api/public-documents/:kind", async (req, reply) => {
    const kind = (req.params as { kind: string }).kind;
    const docs = c.publicInformation.documents;
    if (!docs || (kind !== "privacy" && kind !== "terms"))
      return reply.code(404).send({
        error: { code: "NOT_FOUND", message: "Документ еще не опубликован." },
      });
    reply.header("Cache-Control", "no-cache");
    return publishedDocument(c.publicInformation, kind);
  });
  registerIdentityRoutes(app, { c, pool, auth, limiter, sendMail });
  registerLegalConsent(app, { c, pool, auth, limiter });
  app.get("/api/config", async () => ({
    publicInformation: publicInformationSummary(c.publicInformation),
    appName: "IMON Meets",
    embedAllowedOrigins: c.embedAllowedOrigins,
    registrationEnabled: c.registrationEnabled,
    emailVerificationRequired: !c.dev,
    emailConfigured: c.emailConfigured,
    emailDelivery: c.emailDelivery,
    googleOAuthConfigured: c.googleOAuthConfigured,
    mediaConfigured: c.mediaConfigured,
    recordingConfigured: c.recordingConfigured,
    waitingRoomConfigured: true,
    persistentChatConfigured: true,
    participantModerationConfigured: c.livekit.signalingAuthEnabled,
    mfaConfigured: true,
    recordingRetentionDays: c.recordingRetentionDays,
    chatRetentionDays: c.chatRetentionDays,
    billingEnabled: c.billingConfigured,
    transcriptionConfigured: c.transcriptionConfigured,
    summaryConfigured: c.summaryConfigured,
  }));
  // Public SDK code may be imported by an allowed host. Account/API responses
  // never opt into CORS; the iframe talks to its own origin without cookies.
  app.addHook("onSend", async (req, reply, payload) => {
    const path = req.url.split("?")[0]!;
    if (isEmbedPath(path)) reply.header("Cache-Control", "no-store");
    if (
      ["GET", "HEAD"].includes(req.method) &&
      /^\/sdk\/v1\/(?:embed|embed-protocol|index)\.js$/.test(path)
    ) {
      reply.header("Access-Control-Allow-Origin", "*");
      reply.header("Cache-Control", "public, max-age=300");
    }
    return payload;
  });
  app.get("/api/health", async (_req, reply) => {
    try {
      await pool.query(
        'SELECT (SELECT 1 FROM im_workspaces LIMIT 1),(SELECT 1 FROM "user" LIMIT 1),(SELECT 1 FROM "session" LIMIT 1),(SELECT 1 FROM "account" LIMIT 1),(SELECT 1 FROM "verification" LIMIT 1),(SELECT 1 FROM im_rate_limits LIMIT 1)',
      );
      return {
        status: "ok",
        database: true,
        mediaConfigured: c.mediaConfigured,
        recordingConfigured: c.recordingConfigured,
      };
    } catch {
      return reply.code(503).send({ status: "unavailable", database: false });
    }
  });
  app.get("/api/me", async (req) => {
    const u = (await user(req))!;
    const r = await pool.query(
      "SELECT w.*,m.role FROM im_workspaces w JOIN im_members m ON m.workspace_id=w.id WHERE m.user_id=$1 ORDER BY w.created_at",
      [u.id],
    );
    return {
      user: {
        id: u.id,
        name: u.name,
        email: u.email,
        emailVerified: u.emailVerified,
        twoFactorEnabled: Boolean(u.twoFactorEnabled),
      },
      workspaces: r.rows.map(workspaceJson),
      legalConsent: await legalConsentStatus(pool, c, u.id),
    };
  });
  app.get("/api/security-events", async (req) => {
    const u = (await user(req))!;
    const query = z
      .object({ before: z.coerce.number().int().positive().optional() })
      .parse(req.query);
    const rows = (
      await pool.query(
        'SELECT id,event,resource_id AS "resourceId",created_at AS "createdAt" FROM im_audit WHERE actor_id=$1 AND ($2::bigint IS NULL OR id<$2) ORDER BY id DESC LIMIT 100',
        [u.id, query.before ?? null],
      )
    ).rows;
    return {
      events: rows,
      nextCursor: rows.length === 100 ? String(rows.at(-1)!.id) : null,
    };
  });
  app.get("/api/workspaces/:workspaceId/audit", async (req) => {
    const u = (await user(req))!,
      { workspaceId } = params(req),
      m = await membership(workspaceId!, u.id);
    assert(m.role !== "member", 403, "FORBIDDEN", "Недостаточно прав.");
    const query = z
      .object({ before: z.coerce.number().int().positive().optional() })
      .parse(req.query);
    const rows = (
      await pool.query(
        'SELECT id,actor_id AS "actorId",event,resource_id AS "resourceId",created_at AS "createdAt" FROM im_audit WHERE workspace_id=$1 AND ($2::bigint IS NULL OR id<$2) ORDER BY id DESC LIMIT 100',
        [workspaceId, query.before ?? null],
      )
    ).rows;
    return {
      events: rows,
      nextCursor: rows.length === 100 ? String(rows.at(-1)!.id) : null,
    };
  });
  app.get("/api/sessions", async (req) => {
    const u = (await user(req))!,
      current = await auth.api.getSession({
        headers: authHeaders(req),
      });
    const rows = await pool.query(
      'SELECT id,"createdAt","updatedAt","expiresAt","ipAddress","userAgent" FROM "session" WHERE "userId"=$1 AND "expiresAt">now() ORDER BY "createdAt" DESC',
      [u.id],
    );
    return {
      sessions: rows.rows.map((row) => ({
        ...row,
        current: row.id === current?.session.id,
      })),
    };
  });
  app.post("/api/sessions/revoke-others", async (req) => {
    const u = (await user(req))!;
    await auth.api.revokeOtherSessions({
      headers: authHeaders(req),
    });
    await audit(pool, null, u.id, "auth.sessions_revoked", u.id);
    return { ok: true };
  });
  app.delete("/api/sessions/:id", async (req) => {
    const u = (await user(req))!,
      current = await auth.api.getSession({
        headers: authHeaders(req),
      });
    const row = (
      await pool.query(
        'SELECT id,token FROM "session" WHERE id=$1 AND "userId"=$2',
        [params(req).id, u.id],
      )
    ).rows[0];
    assert(row, 404, "SESSION_NOT_FOUND", "Сеанс не найден.");
    assert(
      row.id !== current?.session.id,
      409,
      "CURRENT_SESSION",
      "Для завершения текущего сеанса выйдите из аккаунта.",
    );
    await auth.api.revokeSession({
      headers: authHeaders(req),
      body: { token: row.token },
    });
    await audit(pool, null, u.id, "auth.session_revoked", row.id);
    return { ok: true };
  });
  app.patch("/api/workspaces/:workspaceId", async (req) => {
    const u = (await user(req))!,
      { workspaceId } = params(req),
      body = z
        .object({ name: z.string().trim().min(1).max(100) })
        .strict()
        .parse(req.body);
    return transaction(pool, async (db) => {
      const m = await lockWorkspace(db, workspaceId!, u.id);
      assert(m.role !== "member", 403, "FORBIDDEN", "Недостаточно прав.");
      const row = (
        await db.query(
          "UPDATE im_workspaces SET name=$2 WHERE id=$1 RETURNING *",
          [workspaceId, body.name],
        )
      ).rows[0];
      await audit(db, workspaceId!, u.id, "workspace.updated", workspaceId!);
      return { workspace: workspaceJson({ ...row, role: m.role }) };
    });
  });
  app.patch("/api/workspaces/:workspaceId/members/:memberId", async (req) => {
    const u = (await user(req))!,
      { workspaceId, memberId } = params(req),
      body = z
        .object({ role: z.enum(["admin", "member"]) })
        .strict()
        .parse(req.body);
    return transaction(pool, async (db) => {
      const m = await lockWorkspace(db, workspaceId!, u.id);
      assert(
        m.role === "owner",
        403,
        "FORBIDDEN",
        "Только владелец может менять роли.",
      );
      const target = (
        await db.query(
          "SELECT * FROM im_members WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [workspaceId, memberId],
        )
      ).rows[0];
      assert(target, 404, "MEMBER_NOT_FOUND", "Участник не найден.");
      assert(
        target.role !== "owner",
        403,
        "OWNER_PROTECTED",
        "Нельзя менять роль владельца.",
      );
      await db.query(
        "UPDATE im_members SET role=$3 WHERE workspace_id=$1 AND id=$2",
        [workspaceId, memberId, body.role],
      );
      await audit(db, workspaceId!, u.id, "member.role_changed", memberId!);
      const row = (
        await db.query(
          'SELECT m.id,m.user_id AS "userId",u.name,u.email,m.role FROM im_members m JOIN "user" u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.id=$2',
          [workspaceId, memberId],
        )
      ).rows[0];
      return { member: row };
    });
  });
  app.post("/api/workspaces", async (req) => {
    const u = (await user(req))!,
      b = z
        .object({ name: z.string().trim().min(1).max(100) })
        .strict()
        .parse(req.body);
    return transaction(pool, async (db) => {
      await db.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [u.id]);
      const count = await db.query(
        "SELECT count(*)::int AS n FROM im_members WHERE user_id=$1 AND role='owner'",
        [u.id],
      );
      assert(
        count.rows[0].n < c.limits.workspaces,
        409,
        "WORKSPACE_LIMIT",
        "Достигнут лимит рабочих пространств.",
      );
      await requireBudget(limiter, `workspace-create:${u.id}`, 10, 3600, db);
      const id = randomUUID();
      const r = await db.query(
        "INSERT INTO im_workspaces(id,name) VALUES($1,$2) RETURNING *",
        [id, b.name],
      );
      await db.query(
        "INSERT INTO im_members(id,workspace_id,user_id,role) VALUES($1,$2,$3,'owner')",
        [randomUUID(), id, u.id],
      );
      await db.query(
        "INSERT INTO im_workspace_plans(workspace_id) VALUES($1)",
        [id],
      );
      await audit(db, id, u.id, "workspace.created", id);
      return { workspace: workspaceJson({ ...r.rows[0], role: "owner" }) };
    });
  });
  app.get("/api/workspaces/:workspaceId/overview", async (req) => {
    const u = (await user(req))!,
      { workspaceId } = params(req);
    await membership(workspaceId!, u.id);
    const [rooms, members, recordings] = await Promise.all([
      pool.query(
        "SELECT * FROM im_rooms WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY created_at DESC LIMIT 100",
        [workspaceId],
      ),
      pool.query(
        "SELECT count(*)::int AS n FROM im_members WHERE workspace_id=$1",
        [workspaceId],
      ),
      pool.query(
        "SELECT count(*)::int AS n FROM im_recordings WHERE workspace_id=$1 AND deleted_at IS NULL",
        [workspaceId],
      ),
    ]);
    return {
      rooms: rooms.rows.map(roomJson),
      membersCount: members.rows[0].n,
      recordingsCount: recordings.rows[0].n,
    };
  });
  app.get("/api/workspaces/:workspaceId/rooms", async (req) => {
    const u = (await user(req))!,
      { workspaceId } = params(req);
    await membership(workspaceId!, u.id);
    const query = z
      .object({
        view: z.enum(["all", "open", "closed", "archived"]).default("all"),
        q: z.string().trim().max(160).optional(),
        before: z.uuid().optional(),
      })
      .strict()
      .parse(req.query);
    const result = await pool.query(
      `SELECT * FROM im_rooms WHERE workspace_id=$1
       AND ($2='all' OR ($2='archived' AND archived_at IS NOT NULL) OR ($2 IN ('open','closed') AND status=$2 AND archived_at IS NULL))
       AND ($3::text IS NULL OR strpos(lower(title),lower($3))>0)
       AND ($4::text IS NULL OR (created_at,id)<(SELECT created_at,id FROM im_rooms WHERE workspace_id=$1 AND id=$4))
       ORDER BY created_at DESC,id DESC LIMIT 101`,
      [workspaceId, query.view, query.q || null, query.before ?? null],
    );
    const page = result.rows.slice(0, 100);
    return {
      rooms: page.map(roomJson),
      nextCursor: result.rows.length > 100 ? page.at(-1)!.id : null,
      roomsQuotaBasis: "open",
    };
  });
  app.post("/api/workspaces/:workspaceId/rooms", async (req) => {
    const u = (await user(req))!,
      { workspaceId } = params(req);
    await membership(workspaceId!, u.id);
    const b = roomFields.parse(req.body);
    return transaction(pool, async (db) => {
      await lockWorkspace(db, workspaceId!, u.id);
      const planLimits = await workspaceLimits(db, c, workspaceId!);
      const count = await db.query(
        "SELECT count(*)::int AS n FROM im_rooms WHERE workspace_id=$1 AND status='open'",
        [workspaceId],
      );
      assert(
        count.rows[0].n < planLimits.rooms,
        409,
        "ROOM_LIMIT",
        "Достигнут лимит открытых комнат. Завершите одну из встреч, чтобы создать новую.",
      );
      await requireBudget(limiter, `room-create:${u.id}`, 30, 3600, db);
      assert(
        (b.maxParticipants ?? Math.min(25, planLimits.participants)) <=
          planLimits.participants,
        409,
        "PLAN_PARTICIPANT_LIMIT",
        "Превышен лимит участников вашего тарифа.",
      );
      const r = await db.query(
        "INSERT INTO im_rooms(id,workspace_id,slug,title,description,starts_at,duration_minutes,allow_guests,max_participants,created_by,waiting_room) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",
        [
          randomUUID(),
          workspaceId,
          slug(),
          b.title,
          b.description ?? "",
          b.startsAt ?? null,
          b.durationMinutes ?? 60,
          b.allowGuests ?? true,
          b.maxParticipants ?? Math.min(25, planLimits.participants),
          u.id,
          b.waitingRoom ?? true,
        ],
      );
      await audit(db, workspaceId!, u.id, "room.created", r.rows[0].id);
      return { room: roomJson(r.rows[0]) };
    });
  });
  app.patch("/api/workspaces/:workspaceId/rooms/:roomId", async (req) => {
    const u = (await user(req))!,
      { workspaceId, roomId } = params(req),
      m = await membership(workspaceId!, u.id),
      b = roomFields.partial().parse(req.body);
    const mutation = await transaction(pool, async (db) => {
      const currentMember = await lockWorkspace(db, workspaceId!, u.id);
      const r = await scopedRoom(workspaceId!, roomId!, db, true);
      assert(
        canManage(currentMember.role, r.created_by, u.id),
        403,
        "FORBIDDEN",
        "Недостаточно прав.",
      );
      assert(r.status === "open", 409, "ROOM_CLOSED", "Встреча закрыта.");
      assert(
        b.maxParticipants === undefined ||
          b.maxParticipants === r.max_participants ||
          !r.media_started,
        409,
        "ROOM_CAPACITY_LOCKED",
        "Лимит участников нельзя менять после начала звонка. Создайте новую комнату.",
      );
      const planLimits = await workspaceLimits(db, c, workspaceId!);
      assert(
        (b.maxParticipants ?? r.max_participants) <= planLimits.participants,
        409,
        "PLAN_PARTICIPANT_LIMIT",
        "Превышен лимит участников вашего тарифа.",
      );
      const result = await db.query(
        "UPDATE im_rooms SET title=$3,description=$4,starts_at=$5,duration_minutes=$6,allow_guests=$7,max_participants=$8,waiting_room=$9 WHERE workspace_id=$1 AND id=$2 RETURNING *",
        [
          workspaceId,
          roomId,
          b.title ?? r.title,
          b.description ?? r.description,
          b.startsAt === undefined ? r.starts_at : b.startsAt,
          b.durationMinutes ?? r.duration_minutes,
          b.allowGuests ?? r.allow_guests,
          b.maxParticipants ?? r.max_participants,
          b.waitingRoom ?? r.waiting_room,
        ],
      );
      const tightened =
        (b.waitingRoom === true && !r.waiting_room) ||
        (b.allowGuests === false && r.allow_guests);
      if (tightened) {
        await retireMedia(db, r);
        result.rows[0] = (
          await db.query(
            "UPDATE im_rooms SET media_generation=media_generation+1,media_started=false WHERE id=$1 RETURNING *",
            [roomId],
          )
        ).rows[0];
      }
      await audit(db, workspaceId!, u.id, "room.updated", roomId!);
      return { room: roomJson(result.rows[0]), accessReset: tightened };
    });
    const mediaPending =
      mutation.accessReset && c.mediaConfigured
        ? !(await drainRetirements(workspaceId, 4))
        : false;
    return { ...mutation, mediaPending };
  });
  app.post(
    "/api/workspaces/:workspaceId/rooms/:roomId/rotate-link",
    async (req) => {
      const u = (await user(req))!,
        { workspaceId, roomId } = params(req),
        m = await membership(workspaceId!, u.id);
      const mutation = await transaction(pool, async (db) => {
        const currentMember = await lockWorkspace(db, workspaceId!, u.id);
        const r = await scopedRoom(workspaceId!, roomId!, db, true);
        assert(
          canManage(currentMember.role, r.created_by, u.id),
          403,
          "FORBIDDEN",
          "Недостаточно прав.",
        );
        const result = await db.query(
          "UPDATE im_rooms SET slug=$3,media_generation=media_generation+1,media_started=false WHERE workspace_id=$1 AND id=$2 RETURNING *",
          [workspaceId, roomId, slug()],
        );
        await retireMedia(db, r);
        await audit(db, workspaceId!, u.id, "room.link_rotated", roomId!);
        return { room: roomJson(result.rows[0]) };
      });
      const mediaPending = c.mediaConfigured
        ? !(await drainRetirements(workspaceId, 4))
        : false;
      return { ...mutation, accessReset: true, mediaPending };
    },
  );
  app.post("/api/workspaces/:workspaceId/rooms/:roomId/close", async (req) => {
    const u = (await user(req))!,
      { workspaceId, roomId } = params(req),
      m = await membership(workspaceId!, u.id);
    // Room lock serializes close with grant issuance. Persist closed even if media fails; retry close disconnects again.
    const room = await transaction(pool, async (db) => {
      const currentMember = await lockWorkspace(db, workspaceId!, u.id);
      const r = await scopedRoom(workspaceId!, roomId!, db, true);
      assert(
        canManage(currentMember.role, r.created_by, u.id),
        403,
        "FORBIDDEN",
        "Недостаточно прав.",
      );
      const result = await db.query(
        "UPDATE im_rooms SET status='closed' WHERE workspace_id=$1 AND id=$2 RETURNING *",
        [workspaceId, roomId],
      );
      await retireMedia(db, r);
      await audit(db, workspaceId!, u.id, "room.closed", roomId!);
      return result.rows[0];
    });
    if (
      c.mediaConfigured &&
      !(await drainRetirements(
        workspaceId,
        4,
        mediaRoomName(room as { id: string; media_generation: number }),
      ))
    )
      throw new ApiError(
        503,
        "MEDIA_DISCONNECT_PENDING",
        "Встреча закрыта. Отключение участников ожидает повторной попытки.",
      );
    return { room: roomJson(room) };
  });
  for (const action of ["archive", "unarchive"] as const) {
    app.post(
      `/api/workspaces/:workspaceId/rooms/:roomId/${action}`,
      async (req) => {
        const u = (await user(req))!,
          { workspaceId, roomId } = params(req);
        return transaction(pool, async (db) => {
          const m = await lockWorkspace(db, workspaceId!, u.id);
          const room = await scopedRoom(workspaceId!, roomId!, db, true);
          assert(
            canManage(m.role, room.created_by, u.id),
            403,
            "FORBIDDEN",
            "Недостаточно прав.",
          );
          assert(
            room.status === "closed",
            409,
            "ROOM_NOT_CLOSED",
            "Сначала завершите встречу. Архив сохраняет историю и записи.",
          );
          const result = await db.query(
            `UPDATE im_rooms SET archived_at=${action === "archive" ? "COALESCE(archived_at,now())" : "NULL"} WHERE id=$1 RETURNING *`,
            [room.id],
          );
          await audit(
            db,
            workspaceId!,
            u.id,
            `room.${action === "archive" ? "archived" : "unarchived"}`,
            room.id,
          );
          return { room: roomJson(result.rows[0]) };
        });
      },
    );
  }
  async function roomAccess(
    req: FastifyRequest,
    db: Pool | PoolClient = pool,
    lock = false,
    resolvedUser?: User | null,
  ) {
    const u =
        resolvedUser === undefined ? await user(req, false) : resolvedUser,
      { slug: roomSlug } = params(req);
    const result = await db.query(
      `SELECT * FROM im_rooms WHERE slug=$1${lock ? " FOR UPDATE" : ""}`,
      [roomSlug],
    );
    const r = result.rows[0];
    assert(r && !r.archived_at, 404, "ROOM_NOT_FOUND", "Встреча не найдена.");
    const m = u
      ? (
          await db.query(
            "SELECT role FROM im_members WHERE workspace_id=$1 AND user_id=$2",
            [r.workspace_id, u.id],
          )
        ).rows[0]
      : undefined;
    if (u && !m) {
      const removed = await db.query(
        "SELECT 1 FROM im_removed_members WHERE workspace_id=$1 AND user_id=$2",
        [r.workspace_id, u.id],
      );
      assert(
        !removed.rowCount,
        403,
        "MEMBERSHIP_REVOKED",
        "Доступ к пространству отозван.",
      );
    }
    assert(m || r.allow_guests, 404, "ROOM_NOT_FOUND", "Встреча не найдена.");
    return { u, r, m, manage: canManage(m?.role, r.created_by, u?.id) };
  }
  app.get("/api/rooms/:slug", async (req) => {
    const { r, m, manage } = await roomAccess(req);
    return {
      room: {
        title: r.title,
        description: r.description,
        startsAt: r.starts_at,
        durationMinutes: r.duration_minutes,
        allowGuests: r.allow_guests,
        waitingRoom: r.waiting_room || r.guest_admission_required,
        maxParticipants: r.max_participants,
        status: r.status,
      },
      canManage: manage,
      ...(m ? { workspaceId: r.workspace_id, roomId: r.id } : {}),
    };
  });
  app.post(
    "/api/rooms/:slug/join",
    { config: { rateLimit: false } },
    async (req, reply) => {
      const b = z
        .object({
          name: z.string().trim().min(1).max(100).optional(),
          waitingToken: z
            .string()
            .regex(/^[A-Za-z0-9_-]{43}$/)
            .optional(),
        })
        .strict()
        .parse(req.body ?? {});
      assert(
        c.mediaConfigured,
        503,
        "MEDIA_UNAVAILABLE",
        "Видеосвязь пока не настроена.",
      );
      const joiningUser = await user(req, false);
      const guestKeyHash = joiningUser
        ? undefined
        : roomVisitorKey(req, reply, c.appUrl.startsWith("https://"));
      await requireBudget(
        limiter,
        `join-subject:${joiningUser?.id ?? guestKeyHash}`,
        20,
        60,
      );
      return transaction(pool, async (db) => {
        const discovered = (
          await db.query("SELECT workspace_id FROM im_rooms WHERE slug=$1", [
            params(req).slug,
          ])
        ).rows[0];
        assert(discovered, 404, "ROOM_NOT_FOUND", "Встреча не найдена.");
        await db.query(
          "SELECT id FROM im_workspaces WHERE id=$1 FOR NO KEY UPDATE",
          [discovered.workspace_id],
        );
        const { u, r, m, manage } = await roomAccess(
          req,
          db,
          true,
          joiningUser,
        );
        assert(r.status === "open", 409, "ROOM_CLOSED", "Встреча закрыта.");
        assert(u || b.name, 400, "NAME_REQUIRED", "Укажите ваше имя.");
        await assertRoomUnblocked(db, r.id, u?.id ?? null, guestKeyHash);
        const admission = await admissionForJoin(
          db,
          {
            ...r,
            waiting_room: r.waiting_room || (!m && r.guest_admission_required),
          },
          u,
          manage,
          u?.name || b.name!,
          b.waitingToken,
          limiter,
          guestKeyHash,
        );
        const admittedGuestKey = admission.guestKeyHash ?? guestKeyHash;
        await assertRoomUnblocked(db, r.id, u?.id ?? null, admittedGuestKey);
        if (admission.pending) return admission.pending;
        const identity = u
          ? `user:${u.id}:${randomUUID()}`
          : `guest:${randomUUID()}`;
        const planLimits = await workspaceLimits(db, c, r.workspace_id);
        await db.query("SELECT pg_advisory_xact_lock(73621906)");
        let token: string;
        try {
          token = await media.token(
            mediaRoomName(r as { id: string; media_generation: number }),
            identity,
            admission.name,
            Math.min(r.max_participants, planLimits.participants),
          );
        } catch {
          throw new ApiError(
            503,
            "MEDIA_UNAVAILABLE",
            "Сервер видеосвязи недоступен. Повторите позже.",
          );
        }
        await db.query("UPDATE im_rooms SET media_started=true WHERE id=$1", [
          r.id,
        ]);
        if (u)
          await db.query(
            "INSERT INTO im_room_access(room_id,user_id) VALUES($1,$2) ON CONFLICT(room_id,user_id) DO UPDATE SET last_granted_at=now()",
            [r.id, u.id],
          );
        await audit(
          db,
          r.workspace_id,
          u?.id ?? null,
          "room.join_granted",
          r.id,
        );
        const chatToken = await createChatSession(
          db,
          r,
          u,
          identity,
          admission.name,
          admittedGuestKey,
        );
        if (admission.requestId)
          await db.query(
            "UPDATE im_waiting_requests SET used_at=now() WHERE id=$1",
            [admission.requestId],
          );
        return {
          status: "joined",
          token,
          chatToken,
          identity,
          serverUrl: c.livekit.url,
          roomName: mediaRoomName(
            r as { id: string; media_generation: number },
          ),
          canManage: manage,
          ...(m ? { roomId: r.id, workspaceId: r.workspace_id } : {}),
        };
      });
    },
  );
  app.get(
    "/api/workspaces/:workspaceId/rooms/:roomId/participants",
    async (req) => {
      const u = (await user(req))!,
        { workspaceId, roomId } = params(req);
      return transaction(pool, async (db) => {
        const m = await lockWorkspace(db, workspaceId!, u.id),
          r = await scopedRoom(workspaceId!, roomId!, db, true);
        assert(
          canManage(m.role, r.created_by, u.id),
          403,
          "FORBIDDEN",
          "Недостаточно прав.",
        );
        assert(
          c.mediaConfigured,
          503,
          "MEDIA_UNAVAILABLE",
          "Видеосвязь не настроена.",
        );
        let participants: Awaited<
          ReturnType<typeof media.rooms.listParticipants>
        >;
        try {
          participants = await media.rooms.listParticipants(
            mediaRoomName(r as { id: string; media_generation: number }),
          );
        } catch (e) {
          if ((e as { code?: string }).code === "not_found") participants = [];
          else
            throw new ApiError(
              503,
              "MEDIA_UNAVAILABLE",
              "Сервер видеосвязи недоступен.",
            );
        }
        const moderation = await participantModeration(
          db,
          r,
          u,
          m.role,
          c.livekit.signalingAuthEnabled,
        );
        return {
          moderationConfigured: c.livekit.signalingAuthEnabled,
          blocked: moderation.blocked,
          participants: participants.map((p) => ({
            identity: p.identity,
            name: p.name,
            isGuest: moderation.permissions.get(p.identity)?.isGuest ?? true,
            canRemove:
              moderation.permissions.get(p.identity)?.canRemove ?? false,
            microphoneMuted: !p.tracks.some(
              (t) => t.source === TrackSource.MICROPHONE && !t.muted,
            ),
            cameraEnabled: p.tracks.some(
              (t) => t.source === TrackSource.CAMERA && !t.muted,
            ),
            screenSharing: p.tracks.some(
              (t) => t.source === TrackSource.SCREEN_SHARE && !t.muted,
            ),
          })),
        };
      });
    },
  );
  app.patch(
    "/api/workspaces/:workspaceId/rooms/:roomId/participants/:identity/microphone",
    async (req) => {
      const u = (await user(req))!,
        { workspaceId, roomId, identity } = params(req);
      z.object({ muted: z.literal(true) })
        .strict()
        .parse(req.body);
      return transaction(pool, async (db) => {
        const m = await lockWorkspace(db, workspaceId!, u.id),
          r = await scopedRoom(workspaceId!, roomId!, db, true);
        assert(
          canManage(m.role, r.created_by, u.id),
          403,
          "FORBIDDEN",
          "Недостаточно прав.",
        );
        assert(
          c.mediaConfigured,
          503,
          "MEDIA_UNAVAILABLE",
          "Видеосвязь не настроена.",
        );
        assert(r.status === "open", 409, "ROOM_CLOSED", "Встреча закрыта.");
        try {
          const name = mediaRoomName(
              r as { id: string; media_generation: number },
            ),
            participant = await media.rooms.getParticipant(name, identity!);
          for (const track of participant.tracks.filter(
            (t) => t.source === TrackSource.MICROPHONE && !t.muted,
          ))
            await media.rooms.mutePublishedTrack(
              name,
              identity!,
              track.sid,
              true,
            );
        } catch (e) {
          if ((e as { code?: string }).code === "not_found")
            throw new ApiError(
              404,
              "PARTICIPANT_NOT_FOUND",
              "Участник не найден.",
            );
          throw new ApiError(
            503,
            "MEDIA_UNAVAILABLE",
            "Не удалось отключить микрофон.",
          );
        }
        await audit(
          db,
          workspaceId!,
          u.id,
          "participant.microphone_muted",
          roomId!,
        );
        return { ok: true };
      });
    },
  );
  app.get("/api/workspaces/:workspaceId/members", async (req) => {
    const u = (await user(req))!,
      { workspaceId } = params(req),
      m = await membership(workspaceId!, u.id);
    const members = await pool.query(
      'SELECT m.id,m.user_id AS "userId",u.name,u.email,m.role FROM im_members m JOIN "user" u ON u.id=m.user_id WHERE m.workspace_id=$1 ORDER BY u.name',
      [workspaceId],
    );
    const invitations =
      m.role === "member"
        ? []
        : (
            await pool.query(
              "SELECT * FROM im_invitations WHERE workspace_id=$1 AND consumed_at IS NULL AND expires_at>now() ORDER BY expires_at",
              [workspaceId],
            )
          ).rows.map(invitationJson);
    return { members: members.rows, invitations };
  });
  app.post("/api/workspaces/:workspaceId/invitations", async (req) => {
    const u = (await user(req))!,
      { workspaceId } = params(req),
      b = z
        .object({
          email: z
            .email()
            .max(254)
            .transform((s) => s.toLowerCase()),
          role: z.enum(["admin", "member"]),
        })
        .strict()
        .parse(req.body);
    const token = slug();
    const result = await transaction(pool, async (db) => {
      // Serialize role changes and invite creation on workspace to prevent stale authority.
      await db.query(
        "SELECT id FROM im_workspaces WHERE id=$1 FOR NO KEY UPDATE",
        [workspaceId],
      );
      const m = await membership(workspaceId!, u.id, db);
      assert(
        canInvite(m.role, b.role),
        403,
        "FORBIDDEN",
        "Недостаточно прав для приглашения.",
      );
      const existing = await db.query(
        'SELECT 1 FROM im_members m JOIN "user" u ON u.id=m.user_id WHERE m.workspace_id=$1 AND lower(u.email)=$2',
        [workspaceId, b.email],
      );
      assert(
        !existing.rowCount,
        409,
        "ALREADY_MEMBER",
        "Этот пользователь уже в команде.",
      );
      await requireBudget(
        limiter,
        `invite-user:${u.id}`,
        c.limits.inviteHourly,
        3600,
        db,
      );
      await requireBudget(
        limiter,
        `invite-workspace:${workspaceId}`,
        c.limits.emailDaily,
        86400,
        db,
      );
      const count = await db.query(
        "SELECT count(*)::int AS n FROM im_invitations WHERE workspace_id=$1 AND consumed_at IS NULL AND expires_at>now()",
        [workspaceId],
      );
      assert(
        count.rows[0].n < c.limits.invitations,
        409,
        "INVITATION_LIMIT",
        "Достигнут лимит приглашений.",
      );
      await db.query(
        "DELETE FROM im_invitations WHERE workspace_id=$1 AND email=$2 AND consumed_at IS NULL",
        [workspaceId, b.email],
      );
      const r = await db.query(
        "INSERT INTO im_invitations(id,workspace_id,email,role,token_hash,expires_at,created_by) VALUES($1,$2,$3,$4,$5,now()+interval '7 days',$6) RETURNING *",
        [randomUUID(), workspaceId, b.email, b.role, hash(token), u.id],
      );
      await audit(db, workspaceId!, u.id, "invitation.created", r.rows[0].id);
      return r.rows[0];
    });
    const inviteUrl = `${c.appUrl}/invite#token=${token}`;
    let emailDelivery:
      | "not_configured"
      | "accepted"
      | "uncertain"
      | "rejected"
      | "rate_limited"
      | "ledger" = "not_configured";
    if (c.emailConfigured) {
      try {
        await sendMail(
          b.email,
          "Приглашение в IMON Meets",
          `Вас пригласили в рабочее пространство. Войдите с адресом ${b.email}, подтвердите почту и откройте ссылку: ${inviteUrl}`,
        );
        emailDelivery = "accepted";
      } catch (e) {
        emailDelivery = e instanceof MailDeliveryError ? e.kind : "uncertain";
        req.log.error(
          { kind: emailDelivery },
          "Invitation email delivery failed",
        );
      }
    }
    return { invitation: invitationJson(result), inviteUrl, emailDelivery };
  });
  app.delete(
    "/api/workspaces/:workspaceId/invitations/:invitationId",
    async (req) => {
      const u = (await user(req))!,
        { workspaceId, invitationId } = params(req);
      return transaction(pool, async (db) => {
        await db.query(
          "SELECT id FROM im_workspaces WHERE id=$1 FOR NO KEY UPDATE",
          [workspaceId],
        );
        const m = await membership(workspaceId!, u.id, db),
          r = await db.query(
            "SELECT * FROM im_invitations WHERE id=$1 AND workspace_id=$2",
            [invitationId, workspaceId],
          );
        assert(
          r.rows[0],
          404,
          "INVITATION_NOT_FOUND",
          "Приглашение не найдено.",
        );
        assert(
          canInvite(m.role, r.rows[0].role),
          403,
          "FORBIDDEN",
          "Недостаточно прав.",
        );
        await db.query(
          "DELETE FROM im_invitations WHERE id=$1 AND workspace_id=$2",
          [invitationId, workspaceId],
        );
        await audit(
          db,
          workspaceId!,
          u.id,
          "invitation.revoked",
          invitationId!,
        );
        return { ok: true };
      });
    },
  );
  app.post("/api/invitations/accept", async (req) => {
    const u = (await user(req))!,
      b = z
        .object({ token: z.string().min(24).max(200) })
        .strict()
        .parse(req.body);
    assert(
      u.emailVerified,
      403,
      "EMAIL_UNVERIFIED",
      "Для принятия приглашения подтвердите почту.",
    );
    return transaction(pool, async (db) => {
      const discovered = (
        await db.query(
          "SELECT workspace_id FROM im_invitations WHERE token_hash=$1",
          [hash(b.token)],
        )
      ).rows[0];
      assert(
        discovered,
        404,
        "INVITATION_INVALID",
        "Приглашение недействительно или истекло.",
      );
      await db.query(
        "SELECT id FROM im_workspaces WHERE id=$1 FOR NO KEY UPDATE",
        [discovered.workspace_id],
      );
      const r = await db.query(
          "SELECT * FROM im_invitations WHERE token_hash=$1 FOR UPDATE",
          [hash(b.token)],
        ),
        inv = r.rows[0];
      assert(
        inv &&
          !inv.consumed_at &&
          new Date(inv.expires_at).getTime() > Date.now(),
        404,
        "INVITATION_INVALID",
        "Приглашение недействительно или истекло.",
      );
      assert(
        inv.email.toLowerCase() === u.email.toLowerCase(),
        403,
        "INVITATION_EMAIL_MISMATCH",
        "Войдите с адресом, на который отправлено приглашение.",
      );
      const count = await db.query(
        "SELECT count(*)::int AS n FROM im_members WHERE workspace_id=$1",
        [inv.workspace_id],
      );
      const existing = await db.query(
        "SELECT 1 FROM im_members WHERE workspace_id=$1 AND user_id=$2",
        [inv.workspace_id, u.id],
      );
      assert(
        existing.rowCount ||
          count.rows[0].n <
            (await workspaceLimits(db, c, inv.workspace_id)).members,
        409,
        "MEMBER_LIMIT",
        "Достигнут лимит участников пространства.",
      );
      await db.query(
        "DELETE FROM im_removed_members WHERE workspace_id=$1 AND user_id=$2",
        [inv.workspace_id, u.id],
      );
      await db.query(
        "INSERT INTO im_members(id,workspace_id,user_id,role) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,user_id) DO NOTHING",
        [randomUUID(), inv.workspace_id, u.id, inv.role],
      );
      await db.query(
        "UPDATE im_invitations SET consumed_at=now() WHERE workspace_id=$1 AND email=$2 AND consumed_at IS NULL",
        [inv.workspace_id, inv.email],
      );
      const w = await db.query(
        "SELECT w.*,m.role FROM im_workspaces w JOIN im_members m ON m.workspace_id=w.id WHERE w.id=$1 AND m.user_id=$2",
        [inv.workspace_id, u.id],
      );
      await audit(db, inv.workspace_id, u.id, "invitation.accepted", inv.id);
      return { workspace: workspaceJson(w.rows[0]) };
    });
  });
  app.delete("/api/workspaces/:workspaceId/members/:memberId", async (req) => {
    const u = (await user(req))!,
      { workspaceId, memberId } = params(req);
    const removal = await transaction(pool, async (db) => {
      await db.query(
        "SELECT id FROM im_workspaces WHERE id=$1 FOR NO KEY UPDATE",
        [workspaceId],
      );
      const m = await membership(workspaceId!, u.id, db),
        r = await db.query(
          "SELECT * FROM im_members WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
          [workspaceId, memberId],
        );
      assert(r.rows[0], 404, "MEMBER_NOT_FOUND", "Участник не найден.");
      assert(
        canRemove(m.role, r.rows[0].role),
        403,
        "FORBIDDEN",
        "Недостаточно прав для удаления участника.",
      );
      const target = r.rows[0];
      const targetUser = (
        await db.query('SELECT email FROM "user" WHERE id=$1', [target.user_id])
      ).rows[0];
      await db.query(
        "DELETE FROM im_invitations WHERE workspace_id=$1 AND lower(email)=lower($2)",
        [workspaceId, targetUser.email],
      );
      await db.query(
        "INSERT INTO im_removed_members(workspace_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [workspaceId, target.user_id],
      );
      const affected = await db.query(
        "SELECT r.* FROM im_rooms r WHERE r.workspace_id=$1 AND r.status='open' AND (EXISTS(SELECT 1 FROM im_room_access a WHERE a.room_id=r.id AND a.user_id=$2) OR EXISTS(SELECT 1 FROM im_audit a WHERE a.resource_id=r.id AND a.actor_id=$2 AND a.event='room.join_granted')) ORDER BY r.id FOR UPDATE",
        [workspaceId, target.user_id],
      );
      for (const room of affected.rows) {
        await retireMedia(db, room);
        await db.query(
          "UPDATE im_rooms SET media_generation=media_generation+1,media_started=false,slug=$2 WHERE id=$1",
          [room.id, slug()],
        );
        await audit(db, workspaceId!, u.id, "room.access_reset", room.id);
      }
      await db.query("DELETE FROM im_members WHERE workspace_id=$1 AND id=$2", [
        workspaceId,
        memberId,
      ]);
      await audit(db, workspaceId!, u.id, "member.removed", memberId!);
      return {
        ok: true,
        affectedRooms: affected.rowCount ?? 0,
        accessReset: !!affected.rowCount,
      };
    });
    const mediaPending =
      removal.affectedRooms > 0
        ? !(await drainRetirements(workspaceId, 4))
        : false;
    return { ...removal, mediaPending };
  });
  app.get("/api/workspaces/:workspaceId/recordings", async (req) => {
    const u = (await user(req))!,
      { workspaceId } = params(req),
      m = await membership(workspaceId!, u.id);
    return {
      recordings: (
        await pool.query(
          "SELECT rec.*,r.title AS room_title,r.created_by,EXISTS(SELECT 1 FROM im_recording_analysis a WHERE a.recording_id=rec.id AND a.expires_at>now()) AS has_transcript FROM im_recordings rec JOIN im_rooms r ON r.id=rec.room_id WHERE rec.workspace_id=$1 AND rec.deleted_at IS NULL ORDER BY rec.started_at DESC",
          [workspaceId],
        )
      ).rows.map((r) => ({
        ...recordingJson(r),
        canManage: canManage(m.role, r.created_by, u.id),
      })),
    };
  });
  app.post(
    "/api/workspaces/:workspaceId/rooms/:roomId/recordings",
    async (req) => {
      const u = (await user(req))!,
        { workspaceId, roomId } = params(req),
        m = await membership(workspaceId!, u.id);
      assert(
        c.recordingConfigured,
        503,
        "RECORDING_UNAVAILABLE",
        "Запись не настроена. Нужны Egress и хранилище.",
      );
      const recording = await transaction(pool, async (db) => {
        const currentMember = await lockWorkspace(db, workspaceId!, u.id);
        const r = await scopedRoom(workspaceId!, roomId!, db, true);
        assert(
          canManage(currentMember.role, r.created_by, u.id),
          403,
          "FORBIDDEN",
          "Недостаточно прав.",
        );
        assert(r.status === "open", 409, "ROOM_CLOSED", "Встреча закрыта.");
        const active = await db.query(
          "SELECT id FROM im_recordings WHERE room_id=$1 AND status IN ('starting','active','ending')",
          [roomId],
        );
        assert(!active.rowCount, 409, "RECORDING_ACTIVE", "Запись уже идет.");
        const planLimit = await workspaceLimits(db, c, workspaceId!);
        const workspaceActive = (
          await db.query(
            "SELECT count(*)::int AS n FROM im_recordings WHERE workspace_id=$1 AND status IN ('starting','active','ending')",
            [workspaceId],
          )
        ).rows[0].n;
        assert(
          workspaceActive < planLimit.activeRecordings,
          409,
          "PLAN_RECORDING_LIMIT",
          "Достигнут лимит одновременных записей тарифа.",
        );
        await db.query("SELECT pg_advisory_xact_lock(73621905)");
        const total = await db.query(
          "SELECT count(*)::int AS n FROM im_recordings WHERE status IN ('starting','active','ending')",
        );
        assert(
          total.rows[0].n < c.limits.recordings,
          409,
          "RECORDING_CAPACITY",
          "Свободных ресурсов для записи нет.",
        );
        const id = randomUUID(),
          objectKey = `recordings/${workspaceId}/${id}.mp4`;
        const result = await db.query(
          "INSERT INTO im_recordings(id,workspace_id,room_id,status,object_key,media_name,expires_at) VALUES($1,$2,$3,'starting',$4,$5,now()+($6*interval '1 day')) RETURNING *",
          [
            id,
            workspaceId,
            roomId,
            objectKey,
            mediaRoomName(r as { id: string; media_generation: number }),
            c.recordingRetentionDays,
          ],
        );
        await audit(db, workspaceId!, u.id, "recording.requested", id);
        return { ...result.rows[0], room_title: r.title };
      });
      let egressId: string | undefined,
        startAttempted = false;
      try {
        const result = await transaction(pool, async (db) => {
          const currentMember = await lockWorkspace(db, workspaceId!, u.id);
          const room = await scopedRoom(workspaceId!, roomId!, db, true);
          assert(
            canManage(currentMember.role, room.created_by, u.id),
            403,
            "FORBIDDEN",
            "Недостаточно прав.",
          );
          if (
            room.status !== "open" ||
            mediaRoomName(room as { id: string; media_generation: number }) !==
              recording.media_name
          ) {
            const failed = (
              await db.query(
                "UPDATE im_recordings SET status='failed',ended_at=now(),error='Встреча закрыта до запуска записи.' WHERE id=$1 RETURNING *",
                [recording.id],
              )
            ).rows[0];
            return failed;
          }
          startAttempted = true;
          const info = await media.start(
            recording.media_name,
            recording.object_key,
          );
          egressId = info.egressId;
          const row = (
            await db.query(
              "SELECT * FROM im_recordings WHERE id=$1 FOR UPDATE",
              [recording.id],
            )
          ).rows[0];
          return applyRecordingInfo(db, row, info);
        });
        return {
          recording: recordingJson({
            ...result,
            room_title: recording.room_title,
          }),
        };
      } catch (e) {
        if (!startAttempted) {
          await pool.query(
            "UPDATE im_recordings SET status='failed',ended_at=now(),error='Запуск отменен до обращения к Egress.' WHERE id=$1 AND status='starting'",
            [recording.id],
          );
          throw e;
        }
        // RPC timeouts or persistence failures may leave an active external job. Keep the
        // unique active reservation until a signed webhook or reconciliation resolves it.
        req.log.error(
          { err: e, recordingId: recording.id, egressId },
          "Egress start outcome uncertain; reservation retained",
        );
        try {
          await pool.query(
            "UPDATE im_recordings SET egress_id=COALESCE(egress_id,$2),error=$3 WHERE id=$1",
            [
              recording.id,
              egressId ?? null,
              "Статус запуска уточняется. Повторный запуск заблокирован.",
            ],
          );
        } catch {}
        throw new ApiError(
          503,
          "EGRESS_START_UNCERTAIN",
          "Статус запуска записи уточняется. Повторный запуск временно заблокирован.",
        );
      }
    },
  );
  app.post(
    "/api/workspaces/:workspaceId/recordings/:recordingId/stop",
    async (req) => {
      const u = (await user(req))!,
        { workspaceId, recordingId } = params(req),
        m = await membership(workspaceId!, u.id);
      assert(
        c.recordingConfigured,
        503,
        "RECORDING_UNAVAILABLE",
        "Запись не настроена.",
      );
      return transaction(pool, async (db) => {
        const currentMember = await lockWorkspace(db, workspaceId!, u.id);
        const r = (
          await db.query(
            "SELECT rec.*,r.title AS room_title,r.created_by FROM im_recordings rec JOIN im_rooms r ON r.id=rec.room_id WHERE rec.workspace_id=$1 AND rec.id=$2 FOR UPDATE OF rec",
            [workspaceId, recordingId],
          )
        ).rows[0];
        assert(r, 404, "RECORDING_NOT_FOUND", "Запись не найдена.");
        assert(
          canManage(currentMember.role, r.created_by, u.id),
          403,
          "FORBIDDEN",
          "Недостаточно прав.",
        );
        assert(
          r.egress_id && ["active", "ending"].includes(r.status),
          409,
          "RECORDING_NOT_ACTIVE",
          "Запись сейчас нельзя остановить.",
        );
        try {
          await media.egress.stopEgress(r.egress_id);
        } catch {
          throw new ApiError(
            503,
            "EGRESS_UNAVAILABLE",
            "Не удалось остановить запись. Повторите запрос.",
          );
        }
        const result = await db.query(
          "UPDATE im_recordings SET status='ending' WHERE workspace_id=$1 AND id=$2 RETURNING *",
          [workspaceId, recordingId],
        );
        await audit(
          db,
          workspaceId!,
          u.id,
          "recording.stop_requested",
          recordingId!,
        );
        return {
          recording: recordingJson({
            ...result.rows[0],
            room_title: r.room_title,
          }),
        };
      });
    },
  );
  app.get(
    "/api/workspaces/:workspaceId/recordings/:recordingId/download",
    async (req) => {
      const u = (await user(req))!,
        { workspaceId, recordingId } = params(req);
      await membership(workspaceId!, u.id);
      assert(
        c.recordingConfigured,
        503,
        "RECORDING_UNAVAILABLE",
        "Хранилище записей не настроено.",
      );
      const r = (
        await pool.query(
          "SELECT * FROM im_recordings WHERE workspace_id=$1 AND id=$2 AND deletion_requested_at IS NULL AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at>now())",
          [workspaceId, recordingId],
        )
      ).rows[0];
      assert(r, 404, "RECORDING_NOT_FOUND", "Запись не найдена.");
      assert(
        r.status === "complete",
        409,
        "RECORDING_NOT_COMPLETE",
        "Запись еще не готова.",
      );
      return { url: await media.download(r.object_key) };
    },
  );
  const suiteDependencies = {
    c,
    pool,
    deletionJournal,
    media,
    limiter,
    user,
    membership,
    lockWorkspace,
    scopedRoom,
    roomAccess,
    audit,
    retireMedia,
    drainRetirements,
    paymentRequest: options.paymentRequest,
  };
  const moderation = await registerModeration(app, suiteDependencies);
  await registerSuite(app, suiteDependencies);
  await registerBilling(app, suiteDependencies);
  await registerOperationReview(app, suiteDependencies);
  await registerAnalysis(app, suiteDependencies);
  // Scoped parser preserves the exact signed request bytes before any JSON parsing.
  await app.register(async (webhook) => {
    webhook.removeContentTypeParser("application/json");
    webhook.addContentTypeParser(
      ["application/json", "application/webhook+json"],
      { parseAs: "string" },
      (_req, body, done) => done(null, body),
    );
    webhook.post("/api/livekit/webhook", async (req) => {
      assert(
        c.mediaConfigured,
        503,
        "MEDIA_UNAVAILABLE",
        "Медиа не настроено.",
      );
      let event: Awaited<ReturnType<typeof media.receiver.receive>>;
      try {
        event = await media.receiver.receive(
          req.body as string,
          req.headers.authorization,
        );
      } catch {
        throw new ApiError(401, "INVALID_WEBHOOK", "Некорректная подпись.");
      }
      assert(
        event.id,
        400,
        "INVALID_WEBHOOK",
        "Отсутствует идентификатор события.",
      );
      await transaction(pool, async (db) => {
        const seen = await db.query(
          "INSERT INTO im_webhook_events(id) VALUES($1) ON CONFLICT DO NOTHING RETURNING id",
          [event.id],
        );
        if (!seen.rowCount) return;
        if (event.egressInfo) {
          const info = event.egressInfo;
          // Egress may send its first event before the start RPC response is persisted.
          let r = (
            await db.query(
              "SELECT * FROM im_recordings WHERE egress_id=$1 FOR UPDATE",
              [info.egressId],
            )
          ).rows[0];
          if (!r) {
            const pending = (
              await db.query(
                "SELECT * FROM im_recordings WHERE COALESCE(media_name,room_id)=$1 AND status='starting' AND egress_id IS NULL FOR UPDATE",
                [info.roomName],
              )
            ).rows;
            const matched = pending.filter((row) =>
              matchesRecording(info, row.object_key),
            );
            assert(
              matched.length <= 1,
              409,
              "WEBHOOK_AMBIGUOUS",
              "Неоднозначная запись.",
            );
            r = matched[0];
          }
          if (r) {
            const updated = await applyRecordingInfo(db, r, info);
            if (updated.status !== r.status)
              await audit(
                db,
                r.workspace_id,
                null,
                `recording.${updated.status}`,
                r.id,
              );
          }
        }
        if (event.room?.name) {
          const room = (
            await db.query(
              "SELECT workspace_id FROM im_rooms WHERE CASE WHEN media_generation=0 THEN id ELSE id||'-g'||media_generation END=$1",
              [event.room.name],
            )
          ).rows[0];
          if (room)
            await audit(
              db,
              room.workspace_id,
              null,
              `livekit.${event.event}`,
              event.room.name,
            );
        }
      });
      if (
        event.event === "participant_joined" &&
        event.room?.name &&
        event.participant?.identity
      )
        await moderation.rejectRevokedJoin(
          event.room.name,
          event.participant.identity,
        );
      return { ok: true };
    });
  });
  const webPath = fileURLToPath(new URL("../../web/dist", import.meta.url));
  if (existsSync(webPath)) {
    await app.register(staticPlugin, { root: webPath, prefix: "/" });
    // This is a dedicated document, including for ordinary GET/HEAD probes
    // that do not send a browser's Accept: text/html header.
    for (const url of ["/embed/:slug", "/embed/:slug/"]) {
      app.get(url, async (req, reply) => {
        assert(
          isEmbedPath(req.url.split("?")[0]!),
          404,
          "NOT_FOUND",
          "Страница не найдена.",
        );
        return reply.sendFile("index.html", { cacheControl: false });
      });
    }
    app.setNotFoundHandler(async (req, reply) => {
      if (
        req.url.startsWith("/api/") ||
        !req.headers.accept?.includes("text/html")
      )
        return reply.code(404).send({
          error: { code: "NOT_FOUND", message: "Страница не найдена." },
        });
      if (!isApplicationPage(req.url.split("?")[0]!)) reply.code(404);
      return reply.sendFile("index.html", { cacheControl: false });
    });
  }
  let closing = false,
    recordingSync = false;
  const retryClosedRooms = async () => {
    if (!c.mediaConfigured || closing) return;
    closing = true;
    try {
      await drainRetirements();
    } catch (e) {
      app.log.error({ err: e }, "Media retirement retry failed");
    } finally {
      closing = false;
    }
  };
  const retryRecordings = async () => {
    if (!c.recordingConfigured || recordingSync) return;
    recordingSync = true;
    try {
      const recordings = await pool.query(
        "SELECT * FROM im_recordings WHERE status IN ('starting','active','ending') AND started_at<now()-interval '30 seconds' LIMIT 100",
      );
      if (!recordings.rowCount) return;
      // One bounded Egress RPC per cycle, independent from the room-close loop.
      const jobs = await media.egress.listEgress();
      for (const rec of recordings.rows) {
        const info =
          jobs.find((job) => job.egressId === rec.egress_id) ||
          (!rec.egress_id
            ? jobs.find(
                (job) =>
                  job.roomName === (rec.media_name ?? rec.room_id) &&
                  matchesRecording(job, rec.object_key),
              )
            : undefined);
        if (!info) continue; // Absence cannot prove a timed-out start did not happen.
        try {
          await transaction(pool, async (db) => {
            const row = (
              await db.query(
                "SELECT * FROM im_recordings WHERE id=$1 FOR UPDATE",
                [rec.id],
              )
            ).rows[0];
            const updated = await applyRecordingInfo(db, row, info);
            if (updated.status !== row.status)
              await audit(
                db,
                row.workspace_id,
                null,
                `recording.${updated.status}`,
                row.id,
              );
          });
        } catch (e) {
          app.log.error(
            { err: e, recordingId: rec.id },
            "Recording reconciliation failed",
          );
        }
      }
    } catch (e) {
      app.log.error({ err: e }, "Egress reconciliation failed");
    } finally {
      recordingSync = false;
    }
  };
  const closeRetryTimer = setInterval(() => {
    void retryClosedRooms();
  }, 30000);
  closeRetryTimer.unref();
  const recordingRetryTimer = setInterval(() => {
    void retryRecordings();
    void pool
      .query(
        "DELETE FROM im_rate_limits WHERE expires_at<now()-interval '1 day'",
      )
      .catch(() => {});
  }, 30000);
  recordingRetryTimer.unref();
  app.addHook("onReady", async () => {
    void retryClosedRooms();
    void retryRecordings();
  });
  app.addHook("onClose", async () => {
    clearInterval(closeRetryTimer);
    clearInterval(recordingRetryTimer);
  });
  app.addHook("onClose", async () => {
    if (!(await drainAuthTasks(auth)))
      app.log.warn(
        "Authentication tasks reached the shutdown deadline; unresolved deliveries remain blocked by the ledger",
      );
    if (!options.pool) await pool.end();
  });
  return app;
}
