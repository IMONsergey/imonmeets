export const identitySchema = `
CREATE TABLE IF NOT EXISTS im_identity_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now());
WITH applied AS (
  INSERT INTO im_identity_migrations(name) VALUES('unified-mfa-v1') ON CONFLICT DO NOTHING RETURNING name
), sessions_revoked AS (
  DELETE FROM "session" s USING "user" u WHERE s."userId"=u.id AND u."twoFactorEnabled"=true AND EXISTS(SELECT 1 FROM applied) RETURNING s.id
), challenges_revoked AS (
  DELETE FROM "verification" v USING "user" u WHERE v.value=u.id AND u."twoFactorEnabled"=true
  AND (v.identifier LIKE '2fa-%' OR v.identifier LIKE 'trust-device-%') AND EXISTS(SELECT 1 FROM applied) RETURNING v.id
)
SELECT (SELECT count(*) FROM sessions_revoked) AS revoked_sessions,(SELECT count(*) FROM challenges_revoked) AS revoked_challenges;
CREATE TABLE IF NOT EXISTS im_password_enrollments (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES "session"(id) ON DELETE CASCADE,
  email_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS im_password_enrollments_user ON im_password_enrollments(user_id);
CREATE INDEX IF NOT EXISTS im_password_enrollments_expiry ON im_password_enrollments(expires_at);
`;
