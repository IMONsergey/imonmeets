import Fastify, { type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import staticPlugin from "@fastify/static";
import { fromNodeHeaders } from "better-auth/node";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { createAuth, createMailer } from "./auth.js";
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

type Row = QueryResultRow;
type User = { id: string; name: string; email: string; emailVerified: boolean };
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const slug = () => randomBytes(24).toString("base64url");
const roomFields = z
  .object({
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().max(4000).optional(),
    startsAt: z.iso.datetime({ offset: true }).nullable().optional(),
    durationMinutes: z.number().int().min(5).max(1440).optional(),
    allowGuests: z.boolean().optional(),
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
  maxParticipants: r.max_participants,
  status: r.status,
  createdBy: r.created_by,
  createdAt: r.created_at,
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
  options: { pool?: Pool; media?: Media; logger?: boolean } = {},
) {
  const pool = options.pool || createPool(c.databaseUrl),
    auth = createAuth(c, pool),
    media = options.media || createMedia(c),
    sendMail = createMailer(c);
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 1024 * 1024,
    trustProxy: false,
    disableRequestLogging: true,
  });
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: () => ({
      error: {
        code: "RATE_LIMIT",
        message: "Слишком много запросов. Повторите позже.",
      },
    }),
  });
  app.setErrorHandler((e, req, reply) => {
    if (e instanceof ApiError)
      return reply
        .code(e.status)
        .send({ error: { code: e.code, message: e.message } });
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
    if ((e as { statusCode?: number }).statusCode === 400)
      return reply.code(400).send({
        error: { code: "INVALID_REQUEST", message: "Некорректный запрос." },
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
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    if (req.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
      req.url.split("?")[0] !== "/api/livekit/webhook"
    ) {
      assert(
        validOrigin(req.headers.origin, c.appUrl),
        403,
        "ORIGIN_REJECTED",
        "Источник запроса не разрешен.",
      );
    }
  });
  async function user(
    req: FastifyRequest,
    required = true,
  ): Promise<User | null> {
    const headers = fromNodeHeaders(req.headers);
    headers.set("x-imon-client-ip", req.ip);
    const session = await auth.api.getSession({ headers });
    assert(!required || session, 401, "UNAUTHENTICATED", "Войдите в аккаунт.");
    if (!session) return null;
    assert(
      c.dev || session.user.emailVerified,
      403,
      "EMAIL_UNVERIFIED",
      "Подтвердите адрес почты.",
    );
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
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
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
      const headers = fromNodeHeaders(req.headers);
      headers.set("x-imon-client-ip", req.ip);
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
      return reply.send(await response.text());
    },
  });
  app.get("/api/config", async () => ({
    appName: "IMON Meets",
    registrationEnabled: c.registrationEnabled,
    emailVerificationRequired: !c.dev,
    emailConfigured: c.emailConfigured,
    mediaConfigured: c.mediaConfigured,
    recordingConfigured: c.recordingConfigured,
  }));
  app.get("/api/health", async (_req, reply) => {
    try {
      await pool.query("SELECT 1 FROM im_workspaces LIMIT 1");
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
      },
      workspaces: r.rows.map(workspaceJson),
    };
  });
  app.post("/api/workspaces", async (req) => {
    const u = (await user(req))!,
      b = z
        .object({ name: z.string().trim().min(1).max(100) })
        .strict()
        .parse(req.body);
    return transaction(pool, async (db) => {
      const id = randomUUID();
      const r = await db.query(
        "INSERT INTO im_workspaces(id,name) VALUES($1,$2) RETURNING *",
        [id, b.name],
      );
      await db.query(
        "INSERT INTO im_members(id,workspace_id,user_id,role) VALUES($1,$2,$3,'owner')",
        [randomUUID(), id, u.id],
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
        "SELECT * FROM im_rooms WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100",
        [workspaceId],
      ),
      pool.query(
        "SELECT count(*)::int AS n FROM im_members WHERE workspace_id=$1",
        [workspaceId],
      ),
      pool.query(
        "SELECT count(*)::int AS n FROM im_recordings WHERE workspace_id=$1",
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
    return {
      rooms: (
        await pool.query(
          "SELECT * FROM im_rooms WHERE workspace_id=$1 ORDER BY created_at DESC",
          [workspaceId],
        )
      ).rows.map(roomJson),
    };
  });
  app.post("/api/workspaces/:workspaceId/rooms", async (req) => {
    const u = (await user(req))!,
      { workspaceId } = params(req);
    await membership(workspaceId!, u.id);
    const b = roomFields.parse(req.body);
    return transaction(pool, async (db) => {
      const r = await db.query(
        "INSERT INTO im_rooms(id,workspace_id,slug,title,description,starts_at,duration_minutes,allow_guests,max_participants,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
        [
          randomUUID(),
          workspaceId,
          slug(),
          b.title,
          b.description ?? "",
          b.startsAt ?? null,
          b.durationMinutes ?? 60,
          b.allowGuests ?? true,
          b.maxParticipants ?? 25,
          u.id,
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
    return transaction(pool, async (db) => {
      const r = await scopedRoom(workspaceId!, roomId!, db, true);
      assert(
        canManage(m.role, r.created_by, u.id),
        403,
        "FORBIDDEN",
        "Недостаточно прав.",
      );
      assert(r.status === "open", 409, "ROOM_CLOSED", "Встреча закрыта.");
      const result = await db.query(
        "UPDATE im_rooms SET title=$3,description=$4,starts_at=$5,duration_minutes=$6,allow_guests=$7,max_participants=$8 WHERE workspace_id=$1 AND id=$2 RETURNING *",
        [
          workspaceId,
          roomId,
          b.title ?? r.title,
          b.description ?? r.description,
          b.startsAt === undefined ? r.starts_at : b.startsAt,
          b.durationMinutes ?? r.duration_minutes,
          b.allowGuests ?? r.allow_guests,
          b.maxParticipants ?? r.max_participants,
        ],
      );
      await audit(db, workspaceId!, u.id, "room.updated", roomId!);
      return { room: roomJson(result.rows[0]) };
    });
  });
  app.post(
    "/api/workspaces/:workspaceId/rooms/:roomId/rotate-link",
    async (req) => {
      const u = (await user(req))!,
        { workspaceId, roomId } = params(req),
        m = await membership(workspaceId!, u.id);
      return transaction(pool, async (db) => {
        const r = await scopedRoom(workspaceId!, roomId!, db, true);
        assert(
          canManage(m.role, r.created_by, u.id),
          403,
          "FORBIDDEN",
          "Недостаточно прав.",
        );
        const result = await db.query(
          "UPDATE im_rooms SET slug=$3 WHERE workspace_id=$1 AND id=$2 RETURNING *",
          [workspaceId, roomId, slug()],
        );
        await audit(db, workspaceId!, u.id, "room.link_rotated", roomId!);
        return { room: roomJson(result.rows[0]) };
      });
    },
  );
  app.post("/api/workspaces/:workspaceId/rooms/:roomId/close", async (req) => {
    const u = (await user(req))!,
      { workspaceId, roomId } = params(req),
      m = await membership(workspaceId!, u.id);
    // Room lock serializes close with grant issuance. Persist closed even if media fails; retry close disconnects again.
    const room = await transaction(pool, async (db) => {
      const r = await scopedRoom(workspaceId!, roomId!, db, true);
      assert(
        canManage(m.role, r.created_by, u.id),
        403,
        "FORBIDDEN",
        "Недостаточно прав.",
      );
      const result = await db.query(
        "UPDATE im_rooms SET status='closed' WHERE workspace_id=$1 AND id=$2 RETURNING *",
        [workspaceId, roomId],
      );
      await audit(db, workspaceId!, u.id, "room.closed", roomId!);
      return result.rows[0];
    });
    if (c.mediaConfigured) {
      try {
        await media.rooms.deleteRoom(roomId!);
        await pool.query(
          "UPDATE im_rooms SET media_closed=true WHERE id=$1 AND status='closed'",
          [roomId],
        );
      } catch (e) {
        if ((e as { code?: string }).code === "not_found")
          await pool.query(
            "UPDATE im_rooms SET media_closed=true WHERE id=$1 AND status='closed'",
            [roomId],
          );
        else
          throw new ApiError(
            503,
            "MEDIA_DISCONNECT_FAILED",
            "Встреча закрыта. Отключение участников не удалось; повторите закрытие.",
          );
      }
    }
    return { room: roomJson(room) };
  });
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
    assert(r, 404, "ROOM_NOT_FOUND", "Встреча не найдена.");
    const m = u
      ? (
          await db.query(
            "SELECT role FROM im_members WHERE workspace_id=$1 AND user_id=$2",
            [r.workspace_id, u.id],
          )
        ).rows[0]
      : undefined;
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
        maxParticipants: r.max_participants,
        status: r.status,
      },
      canManage: manage,
      ...(m ? { workspaceId: r.workspace_id, roomId: r.id } : {}),
    };
  });
  app.post(
    "/api/rooms/:slug/join",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req) => {
      const b = z
        .object({ name: z.string().trim().min(1).max(80).optional() })
        .strict()
        .parse(req.body ?? {});
      assert(
        c.mediaConfigured,
        503,
        "MEDIA_UNAVAILABLE",
        "Видеосвязь пока не настроена.",
      );
      const joiningUser = await user(req, false);
      return transaction(pool, async (db) => {
        const { u, r, m, manage } = await roomAccess(
          req,
          db,
          true,
          joiningUser,
        );
        assert(r.status === "open", 409, "ROOM_CLOSED", "Встреча закрыта.");
        assert(u || b.name, 400, "NAME_REQUIRED", "Укажите ваше имя.");
        let token: string;
        try {
          token = await media.token(
            r.id,
            u ? `user:${u.id}:${randomUUID()}` : `guest:${randomUUID()}`,
            u?.name || b.name!,
            r.max_participants,
          );
        } catch {
          throw new ApiError(
            503,
            "MEDIA_UNAVAILABLE",
            "Сервер видеосвязи недоступен. Повторите позже.",
          );
        }
        await audit(
          db,
          r.workspace_id,
          u?.id ?? null,
          "room.join_granted",
          r.id,
        );
        return {
          token,
          serverUrl: c.livekit.url,
          roomName: r.id,
          canManage: manage,
          ...(m ? { roomId: r.id, workspaceId: r.workspace_id } : {}),
        };
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
      await db.query("SELECT id FROM im_workspaces WHERE id=$1 FOR UPDATE", [
        workspaceId,
      ]);
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
      const r = await db.query(
        "INSERT INTO im_invitations(id,workspace_id,email,role,token_hash,expires_at,created_by) VALUES($1,$2,$3,$4,$5,now()+interval '7 days',$6) RETURNING *",
        [randomUUID(), workspaceId, b.email, b.role, hash(token), u.id],
      );
      await audit(db, workspaceId!, u.id, "invitation.created", r.rows[0].id);
      return r.rows[0];
    });
    const inviteUrl = `${c.appUrl}/invite#token=${token}`;
    if (c.emailConfigured) {
      try {
        await sendMail(
          b.email,
          "Приглашение в IMON Meets",
          `Вас пригласили в рабочее пространство. Войдите с адресом ${b.email}, подтвердите почту и откройте ссылку: ${inviteUrl}`,
        );
      } catch (e) {
        req.log.error({ err: e }, "Invitation email delivery failed");
      }
    }
    return { invitation: invitationJson(result), inviteUrl };
  });
  app.delete(
    "/api/workspaces/:workspaceId/invitations/:invitationId",
    async (req) => {
      const u = (await user(req))!,
        { workspaceId, invitationId } = params(req);
      return transaction(pool, async (db) => {
        await db.query("SELECT id FROM im_workspaces WHERE id=$1 FOR UPDATE", [
          workspaceId,
        ]);
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
      await db.query("SELECT id FROM im_workspaces WHERE id=$1 FOR UPDATE", [
        discovered.workspace_id,
      ]);
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
      await db.query(
        "INSERT INTO im_members(id,workspace_id,user_id,role) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,user_id) DO NOTHING",
        [randomUUID(), inv.workspace_id, u.id, inv.role],
      );
      await db.query(
        "UPDATE im_invitations SET consumed_at=now() WHERE id=$1",
        [inv.id],
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
    return transaction(pool, async (db) => {
      await db.query("SELECT id FROM im_workspaces WHERE id=$1 FOR UPDATE", [
        workspaceId,
      ]);
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
      await db.query("DELETE FROM im_members WHERE workspace_id=$1 AND id=$2", [
        workspaceId,
        memberId,
      ]);
      await audit(db, workspaceId!, u.id, "member.removed", memberId!);
      return { ok: true };
    });
  });
  app.get("/api/workspaces/:workspaceId/recordings", async (req) => {
    const u = (await user(req))!,
      { workspaceId } = params(req),
      m = await membership(workspaceId!, u.id);
    return {
      recordings: (
        await pool.query(
          "SELECT rec.*,r.title AS room_title,r.created_by FROM im_recordings rec JOIN im_rooms r ON r.id=rec.room_id WHERE rec.workspace_id=$1 ORDER BY rec.started_at DESC",
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
        const r = await scopedRoom(workspaceId!, roomId!, db, true);
        assert(
          canManage(m.role, r.created_by, u.id),
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
        const id = randomUUID(),
          objectKey = `recordings/${workspaceId}/${id}.mp4`;
        const result = await db.query(
          "INSERT INTO im_recordings(id,workspace_id,room_id,status,object_key) VALUES($1,$2,$3,'starting',$4) RETURNING *",
          [id, workspaceId, roomId, objectKey],
        );
        await audit(db, workspaceId!, u.id, "recording.requested", id);
        return { ...result.rows[0], room_title: r.title };
      });
      let egressId: string | undefined;
      try {
        const info = await media.start(roomId!, recording.object_key);
        egressId = info.egressId;
        const result = await transaction(pool, async (db) => {
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
        const r = (
          await db.query(
            "SELECT rec.*,r.title AS room_title,r.created_by FROM im_recordings rec JOIN im_rooms r ON r.id=rec.room_id WHERE rec.workspace_id=$1 AND rec.id=$2 FOR UPDATE OF rec",
            [workspaceId, recordingId],
          )
        ).rows[0];
        assert(r, 404, "RECORDING_NOT_FOUND", "Запись не найдена.");
        assert(
          canManage(m.role, r.created_by, u.id),
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
          "SELECT * FROM im_recordings WHERE workspace_id=$1 AND id=$2",
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
                "SELECT * FROM im_recordings WHERE room_id=$1 AND status='starting' AND egress_id IS NULL FOR UPDATE",
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
            await db.query("SELECT workspace_id FROM im_rooms WHERE id=$1", [
              event.room.name,
            ])
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
      return { ok: true };
    });
  });
  const webPath = fileURLToPath(new URL("../../web/dist", import.meta.url));
  if (existsSync(webPath)) {
    await app.register(staticPlugin, { root: webPath, prefix: "/" });
    app.setNotFoundHandler(async (req, reply) => {
      if (
        req.url.startsWith("/api/") ||
        !req.headers.accept?.includes("text/html")
      )
        return reply.code(404).send({
          error: { code: "NOT_FOUND", message: "Страница не найдена." },
        });
      return reply.sendFile("index.html");
    });
  }
  let closing = false,
    recordingSync = false;
  const retryClosedRooms = async () => {
    if (!c.mediaConfigured || closing) return;
    closing = true;
    try {
      const pending = await pool.query(
        "SELECT id FROM im_rooms WHERE status='closed' AND media_closed=false LIMIT 100",
      );
      for (const r of pending.rows) {
        try {
          await media.rooms.deleteRoom(r.id);
        } catch (e) {
          if ((e as { code?: string }).code !== "not_found") continue;
        }
        await pool.query(
          "UPDATE im_rooms SET media_closed=true WHERE id=$1 AND status='closed'",
          [r.id],
        );
      }
    } catch (e) {
      app.log.error({ err: e }, "Closed-room reconciliation failed");
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
                  job.roomName === rec.room_id &&
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
    if (!options.pool) await pool.end();
  });
  return app;
}
