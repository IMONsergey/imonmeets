export const moderationSchema = `
ALTER TABLE im_rooms ADD COLUMN IF NOT EXISTS guest_admission_required boolean NOT NULL DEFAULT false;
ALTER TABLE im_chat_sessions ADD COLUMN IF NOT EXISTS guest_key_hash text;
ALTER TABLE im_chat_sessions ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE im_waiting_requests ADD COLUMN IF NOT EXISTS guest_key_hash text;
CREATE INDEX IF NOT EXISTS im_chat_media_identity ON im_chat_sessions(identity,room_id);
CREATE INDEX IF NOT EXISTS im_chat_room_generation ON im_chat_sessions(room_id,media_generation);
CREATE TABLE IF NOT EXISTS im_room_bans (
 id text PRIMARY KEY, room_id text NOT NULL REFERENCES im_rooms(id) ON DELETE CASCADE,
 identity text NOT NULL, user_id text REFERENCES "user"(id) ON DELETE CASCADE,
 guest_key_hash text, created_by text REFERENCES "user"(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(room_id,identity)
);
CREATE INDEX IF NOT EXISTS im_room_bans_user ON im_room_bans(room_id,user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS im_room_bans_guest ON im_room_bans(room_id,guest_key_hash) WHERE guest_key_hash IS NOT NULL;
CREATE TABLE IF NOT EXISTS im_participant_removals (
 room_id text NOT NULL REFERENCES im_rooms(id) ON DELETE CASCADE,
 media_name text NOT NULL, identity text NOT NULL,
 revision bigint NOT NULL DEFAULT 0, attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(media_name,identity)
);
CREATE INDEX IF NOT EXISTS im_participant_remove_retry ON im_participant_removals(next_attempt_at);
`;
