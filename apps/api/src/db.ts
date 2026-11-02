import { Pool, type PoolClient } from "pg";
import { suiteSchema } from "./suite-schema.js";
import { analysisSchema } from "./analysis-schema.js";
import { billingSchema } from "./billing-schema.js";
export const schema = `
CREATE TABLE IF NOT EXISTS im_rate_limits(key text PRIMARY KEY,count integer NOT NULL,expires_at timestamptz NOT NULL);
CREATE INDEX IF NOT EXISTS im_rate_expiry ON im_rate_limits(expires_at);
CREATE TABLE IF NOT EXISTS im_email_deliveries (
  idempotency_key text PRIMARY KEY,
  recipient_hash text NOT NULL,
  state text NOT NULL CHECK(state IN ('sending','accepted','uncertain','rate_limited','rejected')),
  provider_id text,
  http_status integer,
  error_kind text,
  retry_after_seconds integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS im_email_deliveries_state_updated ON im_email_deliveries(state,updated_at);
CREATE TABLE IF NOT EXISTS im_workspaces (id text PRIMARY KEY,name text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS im_members (id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES im_workspaces(id) ON DELETE CASCADE,user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,role text NOT NULL CHECK(role IN ('owner','admin','member')),UNIQUE(workspace_id,user_id));
CREATE UNIQUE INDEX IF NOT EXISTS im_one_owner ON im_members(workspace_id) WHERE role='owner';
CREATE TABLE IF NOT EXISTS im_rooms (id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES im_workspaces(id) ON DELETE CASCADE,slug text UNIQUE NOT NULL,title text NOT NULL,description text NOT NULL DEFAULT '',starts_at timestamptz,duration_minutes integer NOT NULL DEFAULT 60 CHECK(duration_minutes BETWEEN 5 AND 1440),allow_guests boolean NOT NULL DEFAULT true,max_participants integer NOT NULL DEFAULT 25 CHECK(max_participants BETWEEN 2 AND 100),status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),media_closed boolean NOT NULL DEFAULT false,created_by text NOT NULL REFERENCES "user"(id),created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE im_rooms ADD COLUMN IF NOT EXISTS media_closed boolean NOT NULL DEFAULT false;
ALTER TABLE im_rooms ADD COLUMN IF NOT EXISTS media_generation integer NOT NULL DEFAULT 0;
ALTER TABLE im_rooms ADD COLUMN IF NOT EXISTS media_started boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS im_media_retirements(name text PRIMARY KEY,workspace_id text NOT NULL REFERENCES im_workspaces(id),attempts integer NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL DEFAULT now(),last_error text);
CREATE INDEX IF NOT EXISTS im_media_retry ON im_media_retirements(next_attempt_at);
CREATE TABLE IF NOT EXISTS im_removed_members(workspace_id text NOT NULL REFERENCES im_workspaces(id),user_id text NOT NULL REFERENCES "user"(id),PRIMARY KEY(workspace_id,user_id));
CREATE TABLE IF NOT EXISTS im_room_access(room_id text NOT NULL REFERENCES im_rooms(id),user_id text NOT NULL REFERENCES "user"(id),last_granted_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(room_id,user_id));
CREATE TABLE IF NOT EXISTS im_invitations (id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES im_workspaces(id) ON DELETE CASCADE,email text NOT NULL,role text NOT NULL CHECK(role IN ('admin','member')),token_hash text UNIQUE NOT NULL,expires_at timestamptz NOT NULL,created_by text NOT NULL REFERENCES "user"(id),consumed_at timestamptz);
CREATE INDEX IF NOT EXISTS im_invitation_workspace ON im_invitations(workspace_id);
CREATE TABLE IF NOT EXISTS im_recordings (id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES im_workspaces(id) ON DELETE CASCADE,room_id text NOT NULL REFERENCES im_rooms(id),egress_id text UNIQUE,status text NOT NULL CHECK(status IN ('starting','active','ending','complete','failed')),started_at timestamptz NOT NULL DEFAULT now(),ended_at timestamptz,size_bytes bigint,error text,object_key text NOT NULL);
ALTER TABLE im_recordings ADD COLUMN IF NOT EXISTS media_name text;
CREATE UNIQUE INDEX IF NOT EXISTS im_active_recording ON im_recordings(room_id) WHERE status IN ('starting','active','ending');
CREATE TABLE IF NOT EXISTS im_audit (id bigserial PRIMARY KEY,workspace_id text REFERENCES im_workspaces(id),actor_id text,event text NOT NULL,resource_id text,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS im_audit_workspace_id ON im_audit(workspace_id,id DESC);
CREATE INDEX IF NOT EXISTS im_audit_actor_id ON im_audit(actor_id,id DESC);
CREATE INDEX IF NOT EXISTS im_audit_room_actor ON im_audit(resource_id,actor_id) WHERE event='room.join_granted';
UPDATE im_rooms r SET media_started=true WHERE media_generation=0 AND EXISTS(SELECT 1 FROM im_audit a WHERE a.resource_id=r.id AND a.event='room.join_granted');
INSERT INTO im_media_retirements(name,workspace_id) SELECT CASE WHEN media_generation=0 THEN id ELSE id||'-g'||media_generation END,workspace_id FROM im_rooms WHERE status='closed' AND media_closed=false ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS im_webhook_events (id text PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT now());
${suiteSchema}
${billingSchema}
${analysisSchema}
`;
export async function transaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
export function createPool(connectionString: string) {
  return new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
    lock_timeout: 10000,
  });
}
