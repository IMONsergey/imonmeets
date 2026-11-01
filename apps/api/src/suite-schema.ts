export const suiteSchema = `
ALTER TABLE im_rooms ADD COLUMN IF NOT EXISTS waiting_room boolean NOT NULL DEFAULT false;
ALTER TABLE im_recordings ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE im_recordings ADD COLUMN IF NOT EXISTS deletion_requested_at timestamptz;
ALTER TABLE im_recordings ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE im_recordings ADD COLUMN IF NOT EXISTS delete_attempt_at timestamptz;
ALTER TABLE im_recordings ADD COLUMN IF NOT EXISTS delete_attempts integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS im_recordings_retention ON im_recordings(expires_at) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS im_waiting_requests (
 id text PRIMARY KEY,room_id text NOT NULL REFERENCES im_rooms(id) ON DELETE CASCADE,
 token_hash text UNIQUE NOT NULL,user_id text REFERENCES "user"(id) ON DELETE CASCADE,
 name text NOT NULL,media_generation integer NOT NULL,
 status text NOT NULL CHECK(status IN ('waiting','admitted','denied')),
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,
 decided_by text,used_at timestamptz
);
CREATE INDEX IF NOT EXISTS im_waiting_room ON im_waiting_requests(room_id,created_at) WHERE used_at IS NULL;
CREATE TABLE IF NOT EXISTS im_chat_sessions (
 token_hash text PRIMARY KEY,room_id text NOT NULL REFERENCES im_rooms(id) ON DELETE CASCADE,
 user_id text REFERENCES "user"(id) ON DELETE CASCADE,identity text NOT NULL,name text NOT NULL,
 media_generation integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS im_chat_session_expiry ON im_chat_sessions(expires_at);
CREATE TABLE IF NOT EXISTS im_messages (
 id bigserial PRIMARY KEY,room_id text NOT NULL REFERENCES im_rooms(id) ON DELETE CASCADE,
 user_id text REFERENCES "user"(id) ON DELETE SET NULL,identity text NOT NULL,name text NOT NULL,
 client_id uuid NOT NULL,text text NOT NULL CHECK(length(text) BETWEEN 1 AND 4000),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(room_id,identity,client_id)
);
CREATE INDEX IF NOT EXISTS im_messages_room ON im_messages(room_id,id);
CREATE INDEX IF NOT EXISTS im_messages_retention ON im_messages(created_at);
CREATE TABLE IF NOT EXISTS im_workspace_plans (
 workspace_id text PRIMARY KEY REFERENCES im_workspaces(id) ON DELETE CASCADE,
 plan_id text NOT NULL DEFAULT 'pilot' CHECK(plan_id IN ('pilot')),
 created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO im_workspace_plans(workspace_id) SELECT id FROM im_workspaces ON CONFLICT DO NOTHING;
`;
