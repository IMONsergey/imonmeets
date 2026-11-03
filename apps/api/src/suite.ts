import { randomBytes, randomUUID, createHash } from "node:crypto";
import { verifyPassword } from "better-auth/crypto";
import { accountExportStream } from "./account-export.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { z } from "zod";
import type { Config } from "./config.js";
import type { Media } from "./media.js";
import { transaction } from "./db.js";
import { assert, canManage, type Role } from "./policy.js";
import { requireBudget, type RateLimiter } from "./limits.js";

type Row = QueryResultRow;
type User = { id: string; name: string; email: string; emailVerified: boolean };
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const params = (req: FastifyRequest) => req.params as Record<string, string>;
const waitingBody = z
  .object({ waitingToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();
const passwordField = z.string().min(1).max(1024);
const messageJson = (row: Row) => ({
  id: String(row.id),
  identity: row.identity,
  name: row.name,
  text: row.text,
  createdAt: row.created_at,
});

export type SuiteDependencies = {
  c: Config;
  pool: Pool;
  media: Media;
  limiter: RateLimiter;
  paymentRequest?: typeof fetch;
  user: (req: FastifyRequest, required?: boolean) => Promise<User | null>;
  membership: (
    workspaceId: string,
    userId: string,
    db?: Pool | PoolClient,
  ) => Promise<Row & { role: Role }>;
  lockWorkspace: (
    db: PoolClient,
    workspaceId: string,
    userId: string,
  ) => Promise<Row & { role: Role }>;
  scopedRoom: (
    workspaceId: string,
    roomId: string,
    db?: Pool | PoolClient,
    lock?: boolean,
  ) => Promise<Row>;
  roomAccess: (
    req: FastifyRequest,
    db?: Pool | PoolClient,
    lock?: boolean,
    resolvedUser?: User | null,
  ) => Promise<{ u: User | null; r: Row; m: Row | undefined; manage: boolean }>;
  audit: (
    db: Pool | PoolClient,
    workspaceId: string | null,
    actorId: string | null,
    event: string,
    resourceId: string | null,
  ) => Promise<void>;
  retireMedia: (db: PoolClient, room: Row) => Promise<void>;
  drainRetirements: (
    workspaceId?: string,
    maxJobs?: number,
    onlyName?: string,
  ) => Promise<boolean>;
};

/** Called under workspace then room lock. The admission token never authorizes another room/generation/user. */
export async function admissionForJoin(
  db: PoolClient,
  room: Row,
  user: User | null,
  manager: boolean,
  name: string,
  waitingToken: string | undefined,
  limiter: RateLimiter,
  guestKeyHash?: string,
) {
  if (!room.waiting_room || manager) return { name, guestKeyHash };
  if (waitingToken) {
    const row = (
      await db.query(
        "SELECT * FROM im_waiting_requests WHERE token_hash=$1 AND room_id=$2 FOR UPDATE",
        [hash(waitingToken), room.id],
      )
    ).rows[0];
    assert(
      row &&
        row.user_id === (user?.id ?? null) &&
        row.media_generation === room.media_generation,
      403,
      "WAITING_INVALID",
      "Запрос на вход недействителен.",
    );
    assert(
      new Date(row.expires_at).getTime() > Date.now() && !row.used_at,
      410,
      "WAITING_EXPIRED",
      "Запрос на вход истек. Отправьте новый.",
    );
    assert(
      row.status !== "denied",
      403,
      "WAITING_DENIED",
      "Организатор отклонил запрос на вход.",
    );
    if (row.status === "admitted")
      return {
        name: String(row.name),
        requestId: String(row.id),
        guestKeyHash: row.guest_key_hash as string | undefined,
      };
    return {
      name: String(row.name),
      guestKeyHash: row.guest_key_hash as string | undefined,
      pending: {
        status: "waiting" as const,
        requestId: row.id,
        waitingToken,
        expiresAt: row.expires_at,
      },
    };
  }
  const queued = (
    await db.query(
      "SELECT count(*)::int AS n FROM im_waiting_requests WHERE room_id=$1 AND status='waiting' AND expires_at>now()",
      [room.id],
    )
  ).rows[0].n;
  assert(
    queued < 100,
    429,
    "WAITING_FULL",
    "Зал ожидания заполнен. Повторите позже.",
  );
  if (user)
    await requireBudget(
      limiter,
      `waiting-user:${room.id}:${user.id}`,
      10,
      3600,
      db,
    );
  const token = secret(),
    id = randomUUID();
  const row = (
    await db.query(
      "INSERT INTO im_waiting_requests(id,room_id,token_hash,user_id,name,media_generation,guest_key_hash,status,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'waiting',now()+interval '30 minutes') RETURNING expires_at",
      [
        id,
        room.id,
        hash(token),
        user?.id ?? null,
        name,
        room.media_generation,
        guestKeyHash ?? null,
      ],
    )
  ).rows[0];
  return {
    name,
    guestKeyHash,
    pending: {
      status: "waiting" as const,
      requestId: id,
      waitingToken: token,
      expiresAt: row.expires_at,
    },
  };
}
export async function createChatSession(
  db: PoolClient,
  room: Row,
  user: User | null,
  identity: string,
  name: string,
  guestKeyHash?: string,
) {
  const token = secret();
  await db.query(
    "INSERT INTO im_chat_sessions(token_hash,room_id,user_id,identity,name,media_generation,guest_key_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '24 hours')",
    [
      hash(token),
      room.id,
      user?.id ?? null,
      identity,
      name,
      room.media_generation,
      guestKeyHash ?? null,
    ],
  );
  return token;
}

export async function registerSuite(
  app: FastifyInstance,
  d: SuiteDependencies,
) {
  const {
    c,
    pool,
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
  } = d;
  async function passwordCheck(id: string, password: string) {
    await requireBudget(limiter, `sensitive-password:${id}`, 6, 900);
    const account = (
      await pool.query(
        'SELECT password FROM "account" WHERE "userId"=$1 AND "providerId"=\'credential\'',
        [id],
      )
    ).rows[0];
    assert(
      account?.password &&
        (await verifyPassword({ hash: account.password, password })),
      403,
      "INVALID_PASSWORD",
      "Неверный пароль.",
    );
  }
  async function waitingTicket(
    req: FastifyRequest,
    db: Pool | PoolClient,
    lock = false,
  ) {
    const b = waitingBody.parse(req.body),
      { u, r } = await roomAccess(req, db, lock);
    const row = (
      await db.query(
        `SELECT * FROM im_waiting_requests WHERE token_hash=$1 AND room_id=$2${lock ? " FOR UPDATE" : ""}`,
        [hash(b.waitingToken), r.id],
      )
    ).rows[0];
    assert(
      row && row.user_id === (u?.id ?? null),
      404,
      "WAITING_NOT_FOUND",
      "Запрос на вход не найден.",
    );
    const expired =
      r.status !== "open" ||
      row.media_generation !== r.media_generation ||
      row.used_at ||
      new Date(row.expires_at).getTime() <= Date.now();
    return { r, row, expired: Boolean(expired) };
  }
  app.post("/api/rooms/:slug/waiting-status", async (req) => {
    const { row, expired } = await waitingTicket(req, pool);
    await requireBudget(limiter, `waiting-read:${row.id}`, 60, 60);
    return {
      status: expired ? "expired" : row.status,
      expiresAt: row.expires_at,
    };
  });
  app.delete("/api/rooms/:slug/waiting", async (req) => {
    const { row } = await waitingTicket(req, pool);
    await pool.query(
      "UPDATE im_waiting_requests SET status='denied' WHERE id=$1 AND used_at IS NULL",
      [row.id],
    );
    return { ok: true };
  });
  app.get("/api/workspaces/:workspaceId/rooms/:roomId/waiting", async (req) => {
    const u = (await user(req))!,
      { workspaceId, roomId } = params(req),
      m = await membership(workspaceId!, u.id),
      r = await scopedRoom(workspaceId!, roomId!);
    assert(
      canManage(m.role, r.created_by, u.id),
      403,
      "FORBIDDEN",
      "Недостаточно прав.",
    );
    const rows = await pool.query(
      "SELECT id,name,status,created_at,expires_at FROM im_waiting_requests WHERE room_id=$1 AND media_generation=$2 AND used_at IS NULL AND expires_at>now() AND status='waiting' ORDER BY created_at LIMIT 100",
      [r.id, r.media_generation],
    );
    return {
      requests: rows.rows.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      })),
    };
  });
  app.patch(
    "/api/workspaces/:workspaceId/rooms/:roomId/waiting/:requestId",
    async (req) => {
      const u = (await user(req))!,
        { workspaceId, roomId, requestId } = params(req),
        b = z
          .object({ decision: z.enum(["admitted", "denied"]) })
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
        assert(r.status === "open", 409, "ROOM_CLOSED", "Встреча закрыта.");
        const row = (
          await db.query(
            "UPDATE im_waiting_requests SET status=$4,decided_by=$5,expires_at=LEAST(expires_at,now()+interval '10 minutes') WHERE id=$1 AND room_id=$2 AND media_generation=$3 AND expires_at>now() AND used_at IS NULL AND status='waiting' RETURNING id",
            [requestId, roomId, r.media_generation, b.decision, u.id],
          )
        ).rows[0];
        assert(row, 409, "WAITING_CHANGED", "Запрос истек или уже обработан.");
        await audit(
          db,
          workspaceId!,
          u.id,
          `waiting.${b.decision}`,
          requestId!,
        );
        return { ok: true };
      });
    },
  );
  async function chatAccess(
    req: FastifyRequest,
    db: Pool | PoolClient = pool,
    write = false,
  ) {
    const token = req.headers["x-imon-room-session"];
    assert(
      typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token),
      401,
      "CHAT_SESSION_REQUIRED",
      "Подключитесь к встрече для доступа к чату.",
    );
    const { u, r } = await roomAccess(req, db, write);
    assert(r.status === "open", 409, "ROOM_CLOSED", "Встреча закрыта.");
    const session = (
      await db.query(
        "SELECT * FROM im_chat_sessions WHERE token_hash=$1 AND room_id=$2 AND media_generation=$3 AND expires_at>now() AND revoked_at IS NULL",
        [hash(token), r.id, r.media_generation],
      )
    ).rows[0];
    assert(
      session && (!session.user_id || session.user_id === u?.id),
      403,
      "CHAT_SESSION_INVALID",
      "Сеанс чата истек. Подключитесь к встрече снова.",
    );
    if (!write)
      await requireBudget(limiter, `chat-read:${session.identity}`, 120, 60);
    return { r, session };
  }
  async function messages(roomId: string, query: unknown) {
    const cursor = z
      .string()
      .regex(/^\d{1,19}$/)
      .refine((value) => BigInt(value) <= 9223372036854775807n);
    const q = z
      .object({ after: cursor.optional(), before: cursor.optional() })
      .strict()
      .refine((v) => !(v.after && v.before))
      .parse(query);
    const rows = await pool.query(
      `SELECT id,identity,name,text,created_at FROM im_messages WHERE room_id=$1 AND created_at>now()-($2*interval '1 day')${q.after ? " AND id>$3" : q.before ? " AND id<$3" : ""} ORDER BY id ${q.after ? "ASC" : "DESC"} LIMIT 101`,
      q.after || q.before
        ? [roomId, c.chatRetentionDays, q.after ?? q.before]
        : [roomId, c.chatRetentionDays],
    );
    const extra = rows.rows.length > 100,
      page = rows.rows.slice(0, 100);
    if (!q.after) page.reverse();
    return {
      messages: page.map(messageJson),
      nextCursor: page.length ? String(page.at(-1)!.id) : (q.after ?? null),
      hasEarlier: !q.after && extra,
      hasMore: Boolean(q.after) && extra,
    };
  }
  app.get("/api/rooms/:slug/chat", async (req) => {
    const { r } = await chatAccess(req);
    return messages(r.id, req.query);
  });
  app.post("/api/rooms/:slug/chat", async (req) => {
    const body = z
      .object({ text: z.string().trim().min(1).max(4000), clientId: z.uuid() })
      .strict()
      .parse(req.body);
    return transaction(pool, async (db) => {
      const { r, session } = await chatAccess(req, db, true);
      await requireBudget(limiter, `chat:${session.identity}`, 30, 60, db);
      const existing = (
        await db.query(
          "SELECT * FROM im_messages WHERE room_id=$1 AND identity=$2 AND client_id=$3",
          [r.id, session.identity, body.clientId],
        )
      ).rows[0];
      if (existing) return { message: messageJson(existing) };
      const count = (
        await db.query(
          "SELECT count(*)::int AS n FROM im_messages WHERE room_id=$1",
          [r.id],
        )
      ).rows[0].n;
      assert(
        count < 100000,
        409,
        "CHAT_LIMIT",
        "Достигнут лимит сообщений этой комнаты.",
      );
      const row = (
        await db.query(
          "INSERT INTO im_messages(room_id,user_id,identity,name,client_id,text) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
          [
            r.id,
            session.user_id,
            session.identity,
            session.name,
            body.clientId,
            body.text,
          ],
        )
      ).rows[0];
      return { message: messageJson(row) };
    });
  });
  app.get("/api/workspaces/:workspaceId/rooms/:roomId/chat", async (req) => {
    const u = (await user(req))!,
      { workspaceId, roomId } = params(req);
    await membership(workspaceId!, u.id);
    await scopedRoom(workspaceId!, roomId!);
    return messages(roomId!, req.query);
  });
  app.get("/api/me/export", async (req, reply) => {
    const u = (await user(req))!;
    await requireBudget(limiter, `data-export:${u.id}`, 5, 3600);
    const profile = (
      await pool.query(
        'SELECT id,name,email,"emailVerified","createdAt","updatedAt","twoFactorEnabled" FROM "user" WHERE id=$1',
        [u.id],
      )
    ).rows[0];
    assert(profile, 401, "UNAUTHENTICATED", "Войдите в аккаунт.");
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.raw.once("aborted", abort);
    reply.raw.once("close", abort);
    const stream = accountExportStream(pool, u.id, profile, controller.signal);
    stream.once("close", () => {
      req.raw.removeListener("aborted", abort);
      reply.raw.removeListener("close", abort);
    });
    reply.header(
      "Content-Disposition",
      'attachment; filename="imonmeets-account.json"',
    );
    reply.type("application/json; charset=utf-8");
    return reply.send(stream);
  });
  app.post("/api/workspaces/:workspaceId/transfer-ownership", async (req) => {
    const u = (await user(req))!,
      { workspaceId } = params(req),
      b = z
        .object({
          memberId: z.string().min(1).max(128),
          password: passwordField,
        })
        .strict()
        .parse(req.body);
    await passwordCheck(u.id, b.password);
    return transaction(pool, async (db) => {
      const m = await lockWorkspace(db, workspaceId!, u.id);
      assert(
        m.role === "owner",
        403,
        "FORBIDDEN",
        "Только владелец может передать пространство.",
      );
      const target = (
        await db.query(
          'SELECT m.*,u."emailVerified" FROM im_members m JOIN "user" u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.id=$2 FOR UPDATE OF m',
          [workspaceId, b.memberId],
        )
      ).rows[0];
      assert(
        target && target.role !== "owner" && target.emailVerified,
        409,
        "INVALID_NEW_OWNER",
        "Выберите другого участника с подтвержденной почтой.",
      );
      await db.query("UPDATE im_members SET role='admin' WHERE id=$1", [m.id]);
      await db.query("UPDATE im_members SET role='owner' WHERE id=$1", [
        target.id,
      ]);
      await audit(
        db,
        workspaceId!,
        u.id,
        "workspace.ownership_transferred",
        target.user_id,
      );
      return { ok: true };
    });
  });
  app.delete("/api/me", async (req) => {
    const u = (await user(req))!,
      b = z
        .object({ password: passwordField, confirmation: z.literal("DELETE") })
        .strict()
        .parse(req.body);
    await passwordCheck(u.id, b.password);
    const workspaces = (
      await pool.query(
        "SELECT DISTINCT w.id FROM im_workspaces w LEFT JOIN im_members m ON m.workspace_id=w.id LEFT JOIN im_rooms r ON r.workspace_id=w.id WHERE m.user_id=$1 OR r.created_by=$1 OR EXISTS(SELECT 1 FROM im_room_access a WHERE a.room_id=r.id AND a.user_id=$1) ORDER BY w.id",
        [u.id],
      )
    ).rows;
    await transaction(pool, async (db) => {
      // The same workspace lock order as membership/grant mutations prevents a revoked account racing a new grant.
      for (const w of workspaces)
        await db.query(
          "SELECT id FROM im_workspaces WHERE id=$1 FOR NO KEY UPDATE",
          [w.id],
        );
      await db.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [u.id]);
      assert(
        !(
          await db.query(
            "SELECT 1 FROM im_payments WHERE user_id=$1 AND status IN ('creating','pending','waiting_for_capture') LIMIT 1",
            [u.id],
          )
        ).rowCount,
        409,
        "PAYMENT_PENDING",
        "Сначала завершите или отмените незавершенный платеж у платежного оператора.",
      );
      const owners = (
        await db.query(
          "SELECT workspace_id FROM im_members WHERE user_id=$1 AND role='owner'",
          [u.id],
        )
      ).rows;
      assert(
        !owners.length,
        409,
        "OWNED_WORKSPACES",
        "Сначала передайте или удалите рабочие пространства, которыми владеете.",
      );
      const affected = (
        await db.query(
          "SELECT r.* FROM im_rooms r WHERE r.status='open' AND EXISTS(SELECT 1 FROM im_room_access a WHERE a.room_id=r.id AND a.user_id=$1) ORDER BY r.id FOR UPDATE OF r",
          [u.id],
        )
      ).rows;
      for (const room of affected) {
        await retireMedia(db, room);
        await db.query(
          "UPDATE im_rooms SET media_generation=media_generation+1,media_started=false,slug=$2 WHERE id=$1",
          [room.id, secret()],
        );
      }
      await db.query(
        "UPDATE im_rooms r SET created_by=(SELECT m.user_id FROM im_members m WHERE m.workspace_id=r.workspace_id AND m.role='owner') WHERE created_by=$1",
        [u.id],
      );
      await db.query(
        "DELETE FROM im_invitations WHERE created_by=$1 OR lower(email)=lower($2)",
        [u.id, u.email],
      );
      await db.query("DELETE FROM im_messages WHERE user_id=$1", [u.id]);
      await db.query("DELETE FROM im_room_access WHERE user_id=$1", [u.id]);
      await db.query("DELETE FROM im_removed_members WHERE user_id=$1", [u.id]);
      await db.query(
        "UPDATE im_waiting_requests SET decided_by=NULL WHERE decided_by=$1",
        [u.id],
      );
      await db.query(
        "UPDATE im_audit SET actor_id=NULL,resource_id=CASE WHEN resource_id=$1 THEN NULL ELSE resource_id END WHERE actor_id=$1 OR resource_id=$1",
        [u.id],
      );
      await db.query(
        'DELETE FROM "verification" WHERE identifier=$1 OR identifier=$2 OR value=$2',
        [u.email, u.id],
      );
      await db.query('DELETE FROM "user" WHERE id=$1', [u.id]);
      await audit(db, null, null, "account.deleted", null);
    });
    const mediaPending = !(await drainRetirements(undefined, 4));
    return { ok: true, mediaPending };
  });
  app.delete("/api/workspaces/:workspaceId", async (req) => {
    const u = (await user(req))!,
      { workspaceId } = params(req),
      b = z
        .object({ password: passwordField, confirmation: z.literal("DELETE") })
        .strict()
        .parse(req.body);
    await passwordCheck(u.id, b.password);
    await transaction(pool, async (db) => {
      const m = await lockWorkspace(db, workspaceId!, u.id);
      assert(
        m.role === "owner",
        403,
        "FORBIDDEN",
        "Только владелец может удалить пространство.",
      );
      assert(
        !(
          await db.query(
            "SELECT 1 FROM im_payments WHERE workspace_id=$1 AND status IN ('creating','pending','waiting_for_capture') LIMIT 1",
            [workspaceId],
          )
        ).rowCount,
        409,
        "PAYMENT_PENDING",
        "Сначала дождитесь окончательного статуса платежа. Пространство с незавершенной оплатой удалить нельзя.",
      );
      const rec = (
        await db.query(
          "SELECT 1 FROM im_recordings WHERE workspace_id=$1 AND deleted_at IS NULL LIMIT 1",
          [workspaceId],
        )
      ).rowCount;
      assert(
        !rec,
        409,
        "RECORDINGS_REMAIN",
        "Сначала остановите и удалите записи пространства. Дождитесь удаления файлов.",
      );
      const rooms = (
        await db.query(
          "SELECT * FROM im_rooms WHERE workspace_id=$1 ORDER BY id FOR UPDATE",
          [workspaceId],
        )
      ).rows;
      for (const room of rooms) {
        if (!room.media_closed) {
          await retireMedia(db, room);
          await db.query("UPDATE im_rooms SET status='closed' WHERE id=$1", [
            room.id,
          ]);
        }
      }
    });
    const cleared = c.mediaConfigured
      ? await drainRetirements(workspaceId, 4)
      : true;
    assert(
      cleared,
      503,
      "MEDIA_DISCONNECT_PENDING",
      "Встречи закрыты. Дождитесь отключения участников и повторите удаление пространства.",
    );
    await transaction(pool, async (db) => {
      const m = await lockWorkspace(db, workspaceId!, u.id);
      assert(m.role === "owner", 403, "FORBIDDEN", "Недостаточно прав.");
      assert(
        !(
          await db.query(
            "SELECT 1 FROM im_recordings WHERE workspace_id=$1 AND deleted_at IS NULL LIMIT 1",
            [workspaceId],
          )
        ).rowCount,
        409,
        "RECORDINGS_REMAIN",
        "Сначала удалите записи пространства.",
      );
      assert(
        !(
          await db.query(
            "SELECT 1 FROM im_payments WHERE workspace_id=$1 AND status IN ('creating','pending','waiting_for_capture') LIMIT 1",
            [workspaceId],
          )
        ).rowCount,
        409,
        "PAYMENT_PENDING",
        "Дождитесь окончательного статуса платежа.",
      );
      // Holding the workspace lock also excludes concurrent room creation and recording starts.
      assert(
        !(
          await db.query(
            "SELECT 1 FROM im_rooms WHERE workspace_id=$1 AND status='open' LIMIT 1",
            [workspaceId],
          )
        ).rowCount,
        409,
        "WORKSPACE_CHANGED",
        "Пространство изменилось. Повторите удаление.",
      );
      await db.query(
        "DELETE FROM im_room_access WHERE room_id IN (SELECT id FROM im_rooms WHERE workspace_id=$1)",
        [workspaceId],
      );
      await db.query("DELETE FROM im_recordings WHERE workspace_id=$1", [
        workspaceId,
      ]);
      await db.query("DELETE FROM im_removed_members WHERE workspace_id=$1", [
        workspaceId,
      ]);
      await db.query("DELETE FROM im_media_retirements WHERE workspace_id=$1", [
        workspaceId,
      ]);
      await db.query("DELETE FROM im_audit WHERE workspace_id=$1", [
        workspaceId,
      ]);
      await db.query("DELETE FROM im_workspaces WHERE id=$1", [workspaceId]);
      await audit(db, null, u.id, "workspace.deleted", null);
    });
    return { ok: true };
  });
  async function deleteRecordingObjects(maxJobs = 8) {
    if (!c.recordingConfigured) return;
    const jobs = await transaction(pool, async (db) => {
      await db.query(
        "UPDATE im_recordings SET expires_at=COALESCE(ended_at,started_at)+($1*interval '1 day') WHERE expires_at IS NULL AND status IN ('complete','failed')",
        [c.recordingRetentionDays],
      );
      await db.query(
        "UPDATE im_recordings SET deletion_requested_at=now() WHERE deleted_at IS NULL AND deletion_requested_at IS NULL AND expires_at<=now() AND status IN ('complete','failed')",
      );
      const rows = (
        await db.query(
          "SELECT id,object_key,egress_id FROM im_recordings WHERE deleted_at IS NULL AND deletion_requested_at IS NOT NULL AND (delete_attempt_at IS NULL OR delete_attempt_at<=now()) AND status IN ('complete','failed') ORDER BY deletion_requested_at LIMIT $1 FOR UPDATE SKIP LOCKED",
          [maxJobs],
        )
      ).rows;
      for (const r of rows)
        await db.query(
          "UPDATE im_recordings SET delete_attempts=delete_attempts+1,delete_attempt_at=now()+interval '2 minutes' WHERE id=$1",
          [r.id],
        );
      return rows;
    });
    for (const r of jobs) {
      try {
        await media.delete(r.object_key, r.egress_id);
        await pool.query(
          "UPDATE im_recordings SET deleted_at=now(),error=NULL WHERE id=$1",
          [r.id],
        );
      } catch {
        await pool.query(
          "UPDATE im_recordings SET delete_attempt_at=now()+LEAST(3600,power(2,LEAST(delete_attempts,8))*10)*interval '1 second' WHERE id=$1",
          [r.id],
        );
      }
    }
  }
  app.delete(
    "/api/workspaces/:workspaceId/recordings/:recordingId",
    async (req) => {
      const u = (await user(req))!,
        { workspaceId, recordingId } = params(req);
      await transaction(pool, async (db) => {
        const m = await lockWorkspace(db, workspaceId!, u.id),
          r = (
            await db.query(
              "SELECT rec.*,room.created_by FROM im_recordings rec JOIN im_rooms room ON room.id=rec.room_id WHERE rec.workspace_id=$1 AND rec.id=$2 FOR UPDATE OF rec",
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
          ["complete", "failed"].includes(r.status),
          409,
          "RECORDING_ACTIVE",
          "Сначала остановите запись и дождитесь завершения обработки.",
        );
        await db.query(
          "UPDATE im_recordings SET deletion_requested_at=COALESCE(deletion_requested_at,now()) WHERE id=$1",
          [r.id],
        );
        await audit(
          db,
          workspaceId!,
          u.id,
          "recording.deletion_requested",
          r.id,
        );
      });
      await deleteRecordingObjects(2);
      const row = (
        await pool.query("SELECT deleted_at FROM im_recordings WHERE id=$1", [
          recordingId,
        ])
      ).rows[0];
      return { ok: true, deletionPending: !row?.deleted_at };
    },
  );
  let retentionBusy = false;
  async function retention() {
    if (retentionBusy) return;
    retentionBusy = true;
    try {
      await deleteRecordingObjects();
      await pool.query(
        "DELETE FROM im_messages WHERE created_at<now()-($1*interval '1 day')",
        [c.chatRetentionDays],
      );
      await pool.query(
        "DELETE FROM im_chat_sessions WHERE expires_at<now() OR EXISTS(SELECT 1 FROM im_rooms r WHERE r.id=room_id AND (r.status='closed' OR r.media_generation<>im_chat_sessions.media_generation))",
      );
      await pool.query(
        "DELETE FROM im_waiting_requests WHERE expires_at<now()-interval '1 day'",
      );
    } catch (e) {
      app.log.error({ err: e }, "Retention cleanup failed");
    } finally {
      retentionBusy = false;
    }
  }
  const timer = setInterval(() => void retention(), 60000);
  timer.unref();
  app.addHook("onReady", async () => {
    void retention();
  });
  app.addHook("onClose", async () => {
    clearInterval(timer);
  });
}
