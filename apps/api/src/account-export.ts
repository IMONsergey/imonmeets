import { Readable } from "node:stream";
import type { Pool, QueryResultRow } from "pg";

const pageSize = 500;
const sections = [
  {
    name: "legalAcceptances",
    pageSize: 20,
    query:
      "SELECT a.id,a.accepted_at,a.evidence_schema,a.terms_accepted,a.privacy_acknowledged,v.manifest_sha256,v.version,v.published_at,v.terms_sha256,v.privacy_sha256,v.documents FROM im_legal_acceptances a JOIN im_legal_versions v USING(manifest_sha256) WHERE a.user_id=$1 AND ($2::uuid IS NULL OR a.id>$2::uuid) ORDER BY a.id LIMIT 20",
  },
  {
    name: "memberships",
    query:
      "SELECT w.id,w.name,m.role,w.created_at FROM im_workspaces w JOIN im_members m ON m.workspace_id=w.id WHERE m.user_id=$1 AND ($2::text IS NULL OR w.id>$2) ORDER BY w.id LIMIT 500",
  },
  {
    name: "createdRooms",
    query:
      "SELECT r.id,r.workspace_id,r.title,r.description,r.starts_at,r.duration_minutes,r.allow_guests,r.waiting_room,r.status,r.created_at FROM im_rooms r WHERE r.created_by=$1 AND EXISTS(SELECT 1 FROM im_members m WHERE m.workspace_id=r.workspace_id AND m.user_id=$1) AND ($2::text IS NULL OR r.id>$2) ORDER BY r.id LIMIT 500",
  },
  {
    name: "messages",
    query:
      "SELECT id,room_id,text,created_at FROM im_messages WHERE user_id=$1 AND ($2::bigint IS NULL OR id>$2) ORDER BY id LIMIT 500",
  },
  {
    name: "events",
    query:
      "SELECT id AS cursor_id,event,workspace_id,resource_id,created_at FROM im_audit WHERE actor_id=$1 AND ($2::bigint IS NULL OR id>$2) ORDER BY id LIMIT 500",
  },
  {
    name: "payments",
    query:
      "SELECT id,workspace_id,plan_id,amount_kopecks,currency,test,status,created_at,applied_at,entitlement_end,reversed_at FROM im_payments WHERE user_id=$1 AND ($2::text IS NULL OR id>$2) ORDER BY id LIMIT 500",
  },
];

/** Same JSON export contract with bounded keyset pages and Node stream backpressure. */
export function accountExportStream(
  pool: Pool,
  userId: string,
  profile: QueryResultRow,
  signal: AbortSignal,
) {
  async function page(query: string, cursor: string | null) {
    if (signal.aborted) return [];
    const client = await pool.connect();
    let released = false;
    const release = (destroy = false) => {
      if (!released) {
        released = true;
        client.release(destroy);
      }
    };
    const abort = () => release(true);
    if (signal.aborted) {
      release();
      return [];
    }
    signal.addEventListener("abort", abort, { once: true });
    try {
      const configuration = {
        text: `/* account-export */ ${query}`,
        values: [userId, cursor],
        query_timeout: 5000,
      };
      const result = await client.query<QueryResultRow>(configuration);
      return signal.aborted ? [] : result.rows;
    } catch (error) {
      // Never return a possibly still busy timed-out connection to the shared pool.
      release(true);
      if (signal.aborted) return [];
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      release();
    }
  }
  async function* generate() {
    if (signal.aborted) return;
    const header = {
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      profile,
    };
    yield JSON.stringify(header).slice(0, -1);
    for (const section of sections) {
      if (signal.aborted) return;
      yield `,${JSON.stringify(section.name)}:[`;
      let cursor: string | null = null,
        first = true;
      while (!signal.aborted) {
        const rows = await page(section.query, cursor);
        if (signal.aborted) return;
        for (const row of rows) {
          if (signal.aborted) return;
          cursor = String(row.cursor_id ?? row.id);
          const { cursor_id: ignored, ...value } = row;
          yield `${first ? "" : ","}${JSON.stringify(value)}`;
          first = false;
        }
        if (rows.length < (section.pageSize ?? pageSize)) break;
      }
      if (signal.aborted) return;
      yield "]";
    }
    if (!signal.aborted) yield "}";
  }
  const stream = Readable.from(generate(), {
    objectMode: false,
    highWaterMark: 16 * 1024,
  });
  const abort = () => stream.destroy();
  signal.addEventListener("abort", abort, { once: true });
  stream.once("close", () => signal.removeEventListener("abort", abort));
  return stream;
}
