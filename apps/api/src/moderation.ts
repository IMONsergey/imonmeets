import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { TokenVerifier } from "livekit-server-sdk";
import { z } from "zod";
import { transaction } from "./db.js";
import { ApiError, assert, canManage, type Role } from "./policy.js";
import { mediaRoomName } from "./media.js";
import { requireBudget } from "./limits.js";
import type { SuiteDependencies } from "./suite.js";

type Row = QueryResultRow;
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const params = (req: FastifyRequest) => req.params as Record<string, string>;
const guestCookie = "imonmeets-room-visitor";

/** A browser key helps recognize an anonymous visitor; it is never proof of a person's identity. */
export function roomVisitorKey(
  req: FastifyRequest,
  reply: FastifyReply,
  secure: boolean,
) {
  const values = (req.headers.cookie ?? "")
    .split(";")
    .map((v) => v.trim())
    .filter((v) => v.startsWith(guestCookie + "="));
  const previous =
    values.length === 1 ? values[0]!.slice(guestCookie.length + 1) : "";
  const token = /^[A-Za-z0-9_-]{43}$/.test(previous)
    ? previous
    : randomBytes(32).toString("base64url");
  if (token !== previous)
    reply.header(
      "Set-Cookie",
      `${guestCookie}=${token}; Path=/api/rooms; HttpOnly; SameSite=Lax; Max-Age=86400${secure ? "; Secure" : ""}`,
    );
  return digest(token);
}

export async function assertRoomUnblocked(
  db: Pool | PoolClient,
  roomId: string,
  userId: string | null,
  guestKeyHash?: string,
) {
  const blocked = await db.query(
    "SELECT 1 FROM im_room_bans WHERE room_id=$1 AND (($2::text IS NOT NULL AND user_id=$2) OR ($3::text IS NOT NULL AND guest_key_hash=$3)) LIMIT 1",
    [roomId, userId, guestKeyHash ?? null],
  );
  assert(
    !blocked.rowCount,
    403,
    "PARTICIPANT_BLOCKED",
    "Организатор запретил повторный вход в эту встречу.",
  );
}

export function mayRemoveParticipant(
  actorRole: Role,
  actorId: string,
  creator: string,
  targetUserId: string | null,
  targetRole?: Role,
) {
  return (
    canManage(actorRole, creator, actorId) &&
    actorId !== targetUserId &&
    targetRole !== "owner" &&
    (targetRole !== "admin" || actorRole === "owner")
  );
}

/** Used at every public LiveKit signaling handshake and by the joined-event race guard. */
export async function activeMediaSession(
  db: Pool | PoolClient,
  roomName: string,
  identity: string,
) {
  const result = await db.query(
    `SELECT s.*,r.workspace_id,r.status,r.media_generation AS current_generation,r.archived_at,r.allow_guests
     FROM im_chat_sessions s JOIN im_rooms r ON r.id=s.room_id
     WHERE s.identity=$2 AND CASE WHEN r.media_generation=0 THEN r.id ELSE r.id||'-g'||r.media_generation END=$1
       AND r.status='open' AND r.archived_at IS NULL AND s.revoked_at IS NULL
       AND s.media_generation=r.media_generation AND s.expires_at>now()
       AND NOT EXISTS(SELECT 1 FROM im_room_bans b WHERE b.room_id=r.id AND
          (b.identity=s.identity OR (s.user_id IS NOT NULL AND b.user_id=s.user_id) OR (s.guest_key_hash IS NOT NULL AND b.guest_key_hash=s.guest_key_hash)))
       AND NOT EXISTS(SELECT 1 FROM im_removed_members m WHERE m.workspace_id=r.workspace_id AND m.user_id=s.user_id)
       AND (r.allow_guests OR EXISTS(SELECT 1 FROM im_members m WHERE m.workspace_id=r.workspace_id AND m.user_id=s.user_id))
     LIMIT 1`,
    [roomName, identity],
  );
  return result.rows[0] as Row | undefined;
}

export async function participantModeration(
  db: Pool | PoolClient,
  room: Row,
  actor: { id: string },
  role: Role,
  enabled: boolean,
) {
  const sessions = await db.query(
    "SELECT s.identity,s.user_id,m.role FROM im_chat_sessions s LEFT JOIN im_members m ON m.workspace_id=$2 AND m.user_id=s.user_id WHERE s.room_id=$1 AND s.media_generation=$3",
    [room.id, room.workspace_id, room.media_generation],
  );
  const permissions = new Map(
    sessions.rows.map((s) => [
      s.identity,
      {
        canRemove:
          enabled &&
          mayRemoveParticipant(
            role,
            actor.id,
            room.created_by,
            s.user_id,
            s.role,
          ),
        isGuest: !s.role,
      },
    ]),
  );
  const bans = await db.query(
    `SELECT b.id,b.created_at,COALESCE(u.name,(SELECT s.name FROM im_chat_sessions s WHERE s.room_id=b.room_id AND s.identity=b.identity LIMIT 1),'Участник') AS name
     FROM im_room_bans b LEFT JOIN "user" u ON u.id=b.user_id WHERE b.room_id=$1 ORDER BY b.created_at DESC LIMIT 100`,
    [room.id],
  );
  return {
    permissions,
    blocked: bans.rows.map((b) => ({
      id: b.id,
      name: b.name,
      createdAt: b.created_at,
    })),
  };
}

export async function registerModeration(
  app: FastifyInstance,
  d: SuiteDependencies,
) {
  const { c, pool, media, limiter, user, lockWorkspace, scopedRoom, audit } = d;
  const verifier = new TokenVerifier(c.livekit.apiKey, c.livekit.apiSecret);
  app.get("/api/internal/livekit/authorize", async (req, reply) => {
    const supplied = req.headers["x-imon-livekit-auth"];
    const expected = c.livekit.signalingAuthSecret;
    if (!c.livekit.signalingAuthEnabled || !expected)
      return reply.code(503).send();
    // Fixed-size digests avoid even a length-dependent secret comparison.
    if (
      typeof supplied !== "string" ||
      supplied.length > 1024 ||
      !timingSafeEqual(
        Buffer.from(digest(supplied), "hex"),
        Buffer.from(digest(expected), "hex"),
      )
    )
      return reply.code(403).send();
    if (Object.keys(req.query as object).length) return reply.code(403).send();
    const headerToken = req.headers["x-imon-livekit-token"];
    const authorization = req.headers.authorization;
    const bearer =
      typeof authorization === "string" && authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : undefined;
    if (
      (headerToken !== undefined && typeof headerToken !== "string") ||
      (typeof headerToken === "string" && bearer && headerToken !== bearer)
    )
      return reply.code(401).send();
    const token = typeof headerToken === "string" ? headerToken : bearer;
    if (!token || token.length > 16384) return reply.code(401).send();
    let roomName: string, identity: string;
    try {
      const claims = await verifier.verify(token, 0);
      if (!claims.sub || !claims.video?.room || claims.video.roomJoin !== true)
        return reply.code(401).send();
      identity = claims.sub;
      roomName = claims.video.room;
    } catch {
      return reply.code(401).send();
    }
    try {
      return reply
        .code((await activeMediaSession(pool, roomName, identity)) ? 204 : 403)
        .send();
    } catch {
      return reply.code(503).send();
    }
  });

  async function drainRemovals(
    roomId?: string,
    maxJobs = 20,
    onlyIdentity?: string,
  ) {
    if (!c.mediaConfigured) return false;
    const jobs = await transaction(pool, async (db) => {
      const rows = await db.query(
        "SELECT * FROM im_participant_removals WHERE ($1::text IS NULL OR room_id=$1) AND ($3::text IS NULL OR identity=$3) AND next_attempt_at<=now() ORDER BY next_attempt_at LIMIT $2 FOR UPDATE SKIP LOCKED",
        [roomId ?? null, maxJobs, onlyIdentity ?? null],
      );
      for (const row of rows.rows)
        await db.query(
          "UPDATE im_participant_removals SET attempts=attempts+1,next_attempt_at=now()+interval '30 seconds' WHERE media_name=$1 AND identity=$2",
          [row.media_name, row.identity],
        );
      return rows.rows;
    });
    for (let index = 0; index < jobs.length; index += 4)
      await Promise.all(
        jobs.slice(index, index + 4).map(async (job) => {
          try {
            try {
              await media.rooms.removeParticipant(job.media_name, job.identity);
            } catch (e) {
              if ((e as { code?: string }).code !== "not_found") throw e;
            }
            await pool.query(
              "DELETE FROM im_participant_removals WHERE media_name=$1 AND identity=$2 AND revision=$3",
              [job.media_name, job.identity, job.revision],
            );
          } catch {
            await pool.query(
              "UPDATE im_participant_removals SET next_attempt_at=now()+LEAST(60,power(2,LEAST(attempts,5)))*interval '1 second' WHERE media_name=$1 AND identity=$2",
              [job.media_name, job.identity],
            );
          }
        }),
      );
    return !(
      await pool.query(
        "SELECT 1 FROM im_participant_removals WHERE ($1::text IS NULL OR room_id=$1) AND ($2::text IS NULL OR identity=$2) LIMIT 1",
        [roomId ?? null, onlyIdentity ?? null],
      )
    ).rowCount;
  }

  app.post(
    "/api/workspaces/:workspaceId/rooms/:roomId/participants/:identity/remove",
    async (req) => {
      assert(
        c.livekit.signalingAuthEnabled,
        503,
        "MODERATION_UNAVAILABLE",
        "Удаление участников пока недоступно.",
      );
      const actor = (await user(req))!,
        { workspaceId, roomId, identity } = params(req);
      const body = z.object({ ban: z.boolean() }).strict().parse(req.body);
      z.string().min(1).max(300).parse(identity);
      await requireBudget(limiter, `moderation:${actor.id}`, 60, 60);
      const result = await transaction(pool, async (db) => {
        const member = await lockWorkspace(db, workspaceId!, actor.id);
        const room = await scopedRoom(workspaceId!, roomId!, db, true);
        assert(room.status === "open", 409, "ROOM_CLOSED", "Встреча закрыта.");
        const target = (
          await db.query(
            "SELECT s.*,m.role FROM im_chat_sessions s LEFT JOIN im_members m ON m.workspace_id=$3 AND m.user_id=s.user_id WHERE s.room_id=$1 AND s.identity=$2 AND s.media_generation=$4 FOR UPDATE OF s",
            [room.id, identity, workspaceId, room.media_generation],
          )
        ).rows[0];
        assert(
          target,
          404,
          "PARTICIPANT_NOT_FOUND",
          "Сеанс участника не найден.",
        );
        assert(
          mayRemoveParticipant(
            member.role,
            actor.id,
            room.created_by,
            target.user_id,
            target.role,
          ),
          403,
          "FORBIDDEN",
          "Недостаточно прав для удаления этого участника.",
        );
        if (body.ban) {
          await db.query(
            "INSERT INTO im_room_bans(id,room_id,identity,user_id,guest_key_hash,created_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(room_id,identity) DO NOTHING",
            [
              randomUUID(),
              room.id,
              identity,
              target.user_id,
              target.guest_key_hash,
              actor.id,
            ],
          );
          await db.query(
            "UPDATE im_waiting_requests SET status='denied' WHERE room_id=$1 AND (($2::text IS NOT NULL AND user_id=$2) OR ($3::text IS NOT NULL AND guest_key_hash=$3))",
            [room.id, target.user_id, target.guest_key_hash],
          );
          // An anonymous guest can erase cookies. Fresh guest identities must be
          // admitted explicitly after a ban; existing participants stay connected.
          await db.query(
            "UPDATE im_rooms SET guest_admission_required=true WHERE id=$1",
            [room.id],
          );
        }
        const revoked = await db.query(
          `UPDATE im_chat_sessions SET revoked_at=COALESCE(revoked_at,now())
         WHERE room_id=$1 AND (identity=$2 OR ($3 AND (($4::text IS NOT NULL AND user_id=$4) OR ($5::text IS NOT NULL AND guest_key_hash=$5))))
         RETURNING identity,media_generation`,
          [room.id, identity, body.ban, target.user_id, target.guest_key_hash],
        );
        for (const session of revoked.rows) {
          await db.query(
            "INSERT INTO im_participant_removals(room_id,media_name,identity) VALUES($1,$2,$3) ON CONFLICT(media_name,identity) DO UPDATE SET next_attempt_at=now(),revision=im_participant_removals.revision+1",
            [
              room.id,
              mediaRoomName({
                id: room.id,
                media_generation: session.media_generation,
              }),
              session.identity,
            ],
          );
        }
        await audit(
          db,
          workspaceId!,
          actor.id,
          body.ban ? "participant.blocked" : "participant.removed",
          room.id,
        );
        return {
          guestAdmissionRequired: room.guest_admission_required || body.ban,
        };
      });
      const disconnected = await drainRemovals(roomId);
      // Revocation is durable even when the media RPC is uncertain. Never report
      // a successful disconnect while the server still owes the external action.
      if (!disconnected)
        throw new ApiError(
          503,
          "PARTICIPANT_DISCONNECT_PENDING",
          "Доступ отозван. Отключение участника еще выполняется; повторите проверку.",
        );
      return { ok: true, ...result };
    },
  );

  app.delete(
    "/api/workspaces/:workspaceId/rooms/:roomId/blocked/:banId",
    async (req) => {
      const actor = (await user(req))!,
        { workspaceId, roomId, banId } = params(req);
      return transaction(pool, async (db) => {
        const member = await lockWorkspace(db, workspaceId!, actor.id);
        const room = await scopedRoom(workspaceId!, roomId!, db, true);
        assert(
          canManage(member.role, room.created_by, actor.id),
          403,
          "FORBIDDEN",
          "Недостаточно прав.",
        );
        const blocked = (
          await db.query(
            "SELECT * FROM im_room_bans WHERE room_id=$1 AND id=$2 FOR UPDATE",
            [room.id, banId],
          )
        ).rows[0];
        if (blocked)
          await db.query(
            "DELETE FROM im_room_bans WHERE room_id=$1 AND (id=$2 OR ($3::text IS NOT NULL AND user_id=$3) OR ($4::text IS NOT NULL AND guest_key_hash=$4))",
            [room.id, banId, blocked.user_id, blocked.guest_key_hash],
          );
        // Revoked tokens remain revoked. Unblocking permits only a fresh join.
        await audit(
          db,
          workspaceId!,
          actor.id,
          "participant.unblocked",
          room.id,
        );
        return { ok: true };
      });
    },
  );

  /** A handshake admitted before a concurrent ban may finish afterwards. */
  async function rejectRevokedJoin(roomName: string, identity: string) {
    if (
      !c.livekit.signalingAuthEnabled ||
      !/^(user|guest):/.test(identity) ||
      (await activeMediaSession(pool, roomName, identity))
    )
      return;
    // Retirement can finish before an already-authorized old-generation
    // handshake does. Resolve the stable room ID as well as the current name,
    // otherwise a late participant could recreate the retired media room.
    const stableId =
      /^([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})(?:-g[1-9][0-9]{0,9})?$/i.exec(
        roomName,
      )?.[1];
    if (!stableId) return;
    const room = (
      await pool.query("SELECT id FROM im_rooms WHERE id=$1", [stableId])
    ).rows[0];
    if (!room) return;
    await pool.query(
      "INSERT INTO im_participant_removals(room_id,media_name,identity) VALUES($1,$2,$3) ON CONFLICT(media_name,identity) DO UPDATE SET next_attempt_at=now(),revision=im_participant_removals.revision+1",
      [room.id, roomName, identity],
    );
    await drainRemovals(room.id);
  }
  let busy = false;
  const retry = async () => {
    if (busy) return;
    busy = true;
    try {
      await drainRemovals();
    } catch (e) {
      app.log.error({ err: e }, "Participant removal retry failed");
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void retry(), 5000);
  timer.unref();
  app.addHook("onReady", async () => {
    void retry();
  });
  app.addHook("onClose", async () => {
    clearInterval(timer);
  });
  return { rejectRevokedJoin, drainRemovals };
}
