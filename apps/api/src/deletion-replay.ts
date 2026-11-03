import type { Pool, PoolClient, QueryResultRow } from "pg";
import { EgressStatus } from "livekit-server-sdk";
import { transaction } from "./db.js";
import type { Media } from "./media.js";
import { matchesRecording } from "./recordings.js";
import { canManage } from "./policy.js";
import type { DeletionJournal, StoredIntent } from "./deletion-journal.js";

type ReplayOptions = { mediaConfigured: boolean; recordingConfigured: boolean };
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const TERMINAL_EGRESS = new Set([
  EgressStatus.EGRESS_COMPLETE,
  EgressStatus.EGRESS_FAILED,
  EgressStatus.EGRESS_ABORTED,
  EgressStatus.EGRESS_LIMIT_REACHED,
]);
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("Deletion recovery media operation timed out")),
          10_000,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function closeRooms(
  media: Media,
  rooms: QueryResultRow[],
  options: ReplayOptions,
) {
  if (!rooms.length) return;
  if (rooms.some((room) => !UUID.test(room.id)))
    throw new Error("Invalid restored room identity");
  if (!options.mediaConfigured) {
    if (rooms.some((room) => room.media_started || !room.media_closed))
      throw new Error("Deletion recovery requires media cleanup");
    return;
  }
  const ids = new Set(rooms.map((room) => room.id as string));
  const active = await bounded(media.rooms.listRooms());
  if (active.length > 10_000)
    throw new Error("Deletion recovery room inventory exceeds limit");
  for (const room of active) {
    const match =
      /^([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:-g\d+)?$/.exec(
        room.name,
      );
    if (match && ids.has(match[1]!))
      await bounded(media.rooms.deleteRoom(room.name));
  }
}
async function removeRecordingObject(
  media: Media,
  workspaceId: string,
  recordingId: string,
  row: QueryResultRow | undefined,
  fallbackEgressId: string | null | undefined,
  options: ReplayOptions,
) {
  if (!options.recordingConfigured)
    throw new Error("Deletion recovery requires the recording store");
  if (!UUID.test(workspaceId) || !UUID.test(recordingId))
    throw new Error("Invalid restored recording identity");
  const key = "recordings/" + workspaceId + "/" + recordingId + ".mp4";
  if (row && (row.object_key !== key || row.workspace_id !== workspaceId))
    throw new Error(
      "Restored recording scope does not match the deletion intent",
    );
  const jobs = await bounded(media.egress.listEgress());
  if (jobs.length > 10_000)
    throw new Error("Deletion recovery Egress inventory exceeds limit");
  let stopping = false;
  for (const job of jobs) {
    if (matchesRecording(job, key) && !TERMINAL_EGRESS.has(job.status)) {
      await bounded(media.egress.stopEgress(job.egressId));
      stopping = true;
    }
  }
  // Do not delete an object while an Egress can upload it again after deletion.
  if (stopping)
    throw new Error("Deletion recovery is waiting for recording finalization");
  const egressId = row?.egress_id ?? fallbackEgressId;
  if (egressId && !/^EG_[A-Za-z0-9_-]{1,128}$/.test(egressId))
    throw new Error("Invalid restored Egress identity");
  await bounded(media.delete(key, egressId));
}
async function noPendingPayment(
  db: PoolClient,
  column: "user_id" | "workspace_id",
  id: string,
) {
  if (
    (
      await db.query(
        "SELECT 1 FROM im_payments WHERE " +
          column +
          "=$1 AND status IN ('creating','pending','waiting_for_capture') LIMIT 1",
        [id],
      )
    ).rowCount
  )
    throw new Error(
      "Deletion recovery requires authoritative payment reconciliation",
    );
}
async function replayAccount(
  db: PoolClient,
  accountId: string,
  media: Media,
  options: ReplayOptions,
) {
  const workspaces = (
    await db.query(
      "SELECT DISTINCT w.id FROM im_workspaces w LEFT JOIN im_members m ON m.workspace_id=w.id LEFT JOIN im_rooms r ON r.workspace_id=w.id WHERE m.user_id=$1 OR r.created_by=$1 OR EXISTS(SELECT 1 FROM im_room_access a WHERE a.room_id=r.id AND a.user_id=$1) ORDER BY w.id",
      [accountId],
    )
  ).rows;
  for (const workspace of workspaces)
    await db.query(
      "SELECT id FROM im_workspaces WHERE id=$1 FOR NO KEY UPDATE",
      [workspace.id],
    );
  const account = (
    await db.query('SELECT id,email FROM "user" WHERE id=$1 FOR UPDATE', [
      accountId,
    ])
  ).rows[0];
  if (!account) return;
  await noPendingPayment(db, "user_id", accountId);
  // Ownership may have transferred after the restored backup. Never invent a successor.
  if (
    (
      await db.query(
        "SELECT 1 FROM im_members WHERE user_id=$1 AND role='owner' LIMIT 1",
        [accountId],
      )
    ).rowCount
  )
    throw new Error(
      "Deletion recovery requires authoritative ownership-transfer history",
    );
  const affected = (
    await db.query(
      "SELECT r.* FROM im_rooms r WHERE EXISTS(SELECT 1 FROM im_room_access a WHERE a.room_id=r.id AND a.user_id=$1) ORDER BY r.id FOR UPDATE OF r",
      [accountId],
    )
  ).rows;
  await closeRooms(media, affected, options);
  for (const room of affected)
    await db.query(
      "UPDATE im_rooms SET media_generation=media_generation+1,media_started=false WHERE id=$1",
      [room.id],
    );
  await db.query(
    "UPDATE im_rooms r SET created_by=(SELECT m.user_id FROM im_members m WHERE m.workspace_id=r.workspace_id AND m.role='owner') WHERE created_by=$1",
    [accountId],
  );
  await db.query(
    "DELETE FROM im_invitations WHERE created_by=$1 OR lower(email)=lower($2)",
    [accountId, account.email],
  );
  await db.query("DELETE FROM im_messages WHERE user_id=$1", [accountId]);
  await db.query("DELETE FROM im_room_access WHERE user_id=$1", [accountId]);
  await db.query("DELETE FROM im_removed_members WHERE user_id=$1", [
    accountId,
  ]);
  await db.query(
    "UPDATE im_waiting_requests SET decided_by=NULL WHERE decided_by=$1",
    [accountId],
  );
  await db.query(
    "UPDATE im_audit SET actor_id=NULL,resource_id=CASE WHEN resource_id=$1 THEN NULL ELSE resource_id END WHERE actor_id=$1 OR resource_id=$1",
    [accountId],
  );
  await db.query(
    'DELETE FROM "verification" WHERE identifier=$1 OR identifier=$2 OR value=$2',
    [account.email, accountId],
  );
  // The moderation queue has no user FK and may retain a former participant identity.
  if (
    (
      await db.query(
        "SELECT to_regclass('im_participant_removals') AS relation",
      )
    ).rows[0]?.relation
  )
    await db.query(
      "DELETE FROM im_participant_removals WHERE identity LIKE $1",
      ["user:" + accountId + ":%"],
    );
  await db.query('DELETE FROM "user" WHERE id=$1', [accountId]);
}
async function replayWorkspace(
  db: PoolClient,
  workspaceId: string,
  media: Media,
  options: ReplayOptions,
  intent: StoredIntent,
) {
  const workspace = (
    await db.query(
      "SELECT id FROM im_workspaces WHERE id=$1 FOR NO KEY UPDATE",
      [workspaceId],
    )
  ).rows[0];
  if (!workspace) return;
  if (
    intent.state === "pending" &&
    !(
      await db.query(
        "SELECT 1 FROM im_members WHERE workspace_id=$1 AND user_id=$2 AND role='owner'",
        [workspaceId, intent.body.actorId],
      )
    ).rowCount
  )
    throw new Error(
      "Pending workspace deletion requires authoritative ownership reconciliation",
    );
  await noPendingPayment(db, "workspace_id", workspaceId);
  const rooms = (
    await db.query(
      "SELECT * FROM im_rooms WHERE workspace_id=$1 ORDER BY id FOR UPDATE",
      [workspaceId],
    )
  ).rows;
  const recordings = (
    await db.query(
      "SELECT * FROM im_recordings WHERE workspace_id=$1 ORDER BY id LIMIT 10001 FOR UPDATE",
      [workspaceId],
    )
  ).rows;
  if (rooms.length > 10_000 || recordings.length > 10_000)
    throw new Error("Deletion recovery exceeds its bounded batch");
  await closeRooms(media, rooms, options);
  for (const row of recordings)
    await removeRecordingObject(
      media,
      workspaceId,
      row.id,
      row,
      undefined,
      options,
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
  await db.query("DELETE FROM im_audit WHERE workspace_id=$1", [workspaceId]);
  await db.query("DELETE FROM im_workspaces WHERE id=$1", [workspaceId]);
}
async function replayIntent(
  db: PoolClient,
  intent: StoredIntent,
  media: Media,
  options: ReplayOptions,
) {
  const target = intent.body.target;
  if (target.kind === "account")
    return replayAccount(db, target.accountId, media, options);
  if (target.kind === "workspace")
    return replayWorkspace(db, target.workspaceId, media, options, intent);
  await db.query("SELECT id FROM im_workspaces WHERE id=$1 FOR NO KEY UPDATE", [
    target.workspaceId,
  ]);
  if (intent.state === "pending") {
    const resource = (
      await db.query(
        "SELECT r.id,room.created_by,m.role FROM im_recordings r JOIN im_rooms room ON room.id=r.room_id LEFT JOIN im_members m ON m.workspace_id=r.workspace_id AND m.user_id=$3 WHERE r.id=$1 AND r.workspace_id=$2",
        [target.recordingId, target.workspaceId, intent.body.actorId],
      )
    ).rows[0];
    if (
      resource &&
      !canManage(resource.role, resource.created_by, intent.body.actorId)
    )
      throw new Error(
        "Pending media deletion requires authoritative access reconciliation",
      );
  }
  if (target.kind === "analysis") {
    // A later legitimate re-analysis has a different generation ID and survives.
    await db.query(
      "DELETE FROM im_recording_analysis WHERE id=$1 AND recording_id=$2 AND workspace_id=$3",
      [target.analysisId, target.recordingId, target.workspaceId],
    );
    return;
  }
  const row = (
    await db.query(
      "SELECT * FROM im_recordings WHERE id=$1 AND workspace_id=$2 FOR UPDATE",
      [target.recordingId, target.workspaceId],
    )
  ).rows[0];
  await removeRecordingObject(
    media,
    target.workspaceId,
    target.recordingId,
    row,
    target.egressId,
    options,
  );
  await db.query(
    "DELETE FROM im_recording_analysis WHERE recording_id=$1 AND workspace_id=$2",
    [target.recordingId, target.workspaceId],
  );
  await db.query(
    "UPDATE im_recordings SET deletion_requested_at=COALESCE(deletion_requested_at,now()),deleted_at=now(),status=CASE WHEN status IN ('starting','active','ending') THEN 'failed' ELSE status END,error=NULL WHERE id=$1 AND workspace_id=$2",
    [target.recordingId, target.workspaceId],
  );
}

/** Runs before Fastify, background loops, or any HTTP listener is created. */
export async function replayDeletionJournal(
  pool: Pool,
  journal: DeletionJournal,
  media: Media,
  options: ReplayOptions,
) {
  const relations = (
    await pool.query(
      "SELECT to_regclass('im_workspaces') IS NOT NULL AND to_regclass('im_recordings') IS NOT NULL AND to_regclass('im_recording_analysis') IS NOT NULL AND to_regclass('im_payments') IS NOT NULL AS ready",
    )
  ).rows[0];
  if (!relations?.ready)
    throw new Error("Apply database migrations before deletion recovery");
  const snapshot = await journal.snapshot();
  const independentlyProtected = await journal.verifyIndependentCheckpoint(
    snapshot,
    { recoverPending: true },
  );
  const ordered = [...snapshot.intents].sort(
    (a, b) =>
      a.body.requestedAt - b.body.requestedAt ||
      a.body.id.localeCompare(b.body.id),
  );
  const deadline = Date.now() + 120_000;
  for (const intent of ordered) {
    if (Date.now() >= deadline)
      throw new Error(
        "Deletion replay exceeded its startup budget; use the isolated restore workflow",
      );
    await transaction(pool, async (db) => {
      await db.query("SET LOCAL statement_timeout='10s'");
      await db.query("SET LOCAL lock_timeout='5s'");
      await replayIntent(db, intent, media, options);
    });
    // Replaying a pending, authorized request resolves its DB state. This is not proof of offsite durability.
    await journal.markCommitted(intent);
  }
  const after = await journal.snapshot();
  if (
    after.version !== snapshot.version ||
    after.headSha256 !== snapshot.headSha256
  )
    throw new Error(
      "Deletion journal changed during restore; restart recovery with the latest head",
    );
  return {
    journalId: snapshot.journalId,
    version: snapshot.version,
    headSha256: snapshot.headSha256,
    replayed: ordered.length,
    independentlyProtected,
  };
}
