export const analysisSchema = `
CREATE TABLE IF NOT EXISTS im_recording_analysis (
 recording_id text PRIMARY KEY REFERENCES im_recordings(id) ON DELETE CASCADE,
 workspace_id text NOT NULL REFERENCES im_workspaces(id) ON DELETE CASCADE,
 id text UNIQUE NOT NULL,requested_by text REFERENCES "user"(id) ON DELETE SET NULL,
 status text NOT NULL CHECK(status IN ('queued','running','complete','failed')),
 language text NOT NULL CHECK(language IN ('auto','ru','en')),with_summary boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,expires_at timestamptz NOT NULL,
 lease_id text,lease_until timestamptz,attempts integer NOT NULL DEFAULT 0,
 result jsonb,error text
);
CREATE INDEX IF NOT EXISTS im_analysis_queue ON im_recording_analysis(status,created_at);
CREATE INDEX IF NOT EXISTS im_analysis_expiry ON im_recording_analysis(expires_at);
`;
