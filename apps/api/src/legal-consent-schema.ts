/** Immutable public version snapshots and explicit, account-bound acceptance evidence. */
export const legalConsentSchema = `
CREATE TABLE IF NOT EXISTS im_legal_versions (
  manifest_sha256 text PRIMARY KEY CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
  version text NOT NULL CHECK(version ~ '^[A-Za-z0-9._-]{1,64}$'),
  published_at timestamptz NOT NULL,
  terms_sha256 text NOT NULL CHECK(terms_sha256 ~ '^[a-f0-9]{64}$'),
  privacy_sha256 text NOT NULL CHECK(privacy_sha256 ~ '^[a-f0-9]{64}$'),
  documents jsonb NOT NULL CHECK(jsonb_typeof(documents)='object'),
  archived_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS im_legal_acceptances (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  manifest_sha256 text NOT NULL REFERENCES im_legal_versions(manifest_sha256),
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  evidence_schema text NOT NULL DEFAULT 'explicit-account-v1' CHECK(evidence_schema='explicit-account-v1'),
  terms_accepted boolean NOT NULL CHECK(terms_accepted=true),
  privacy_acknowledged boolean NOT NULL CHECK(privacy_acknowledged=true),
  UNIQUE(user_id,manifest_sha256)
);
CREATE OR REPLACE FUNCTION im_reject_legal_evidence_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Legal evidence is immutable';
END;
$$;
DROP TRIGGER IF EXISTS im_legal_versions_immutable ON im_legal_versions;
CREATE TRIGGER im_legal_versions_immutable BEFORE UPDATE ON im_legal_versions FOR EACH ROW EXECUTE FUNCTION im_reject_legal_evidence_update();
DROP TRIGGER IF EXISTS im_legal_acceptances_immutable ON im_legal_acceptances;
CREATE TRIGGER im_legal_acceptances_immutable BEFORE UPDATE ON im_legal_acceptances FOR EACH ROW EXECUTE FUNCTION im_reject_legal_evidence_update();
`;
