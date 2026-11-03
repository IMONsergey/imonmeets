export const mailSchema = `
ALTER TABLE im_email_deliveries ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'resend' CHECK(provider IN ('smtp','resend'));
ALTER TABLE im_email_deliveries ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
ALTER TABLE im_email_deliveries ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0;
ALTER TABLE im_email_deliveries ADD COLUMN IF NOT EXISTS delivery_status text NOT NULL DEFAULT 'unknown' CHECK(delivery_status IN ('unknown','accepted','delivered','bounced','complained'));
UPDATE im_email_deliveries SET delivery_status='accepted' WHERE state='accepted' AND delivery_status='unknown';
CREATE TABLE IF NOT EXISTS im_email_reconciliations (
  id bigserial PRIMARY KEY,
  idempotency_key text NOT NULL REFERENCES im_email_deliveries(idempotency_key),
  previous_version integer NOT NULL,
  action text NOT NULL CHECK(action IN ('accepted','abandoned','delivered','bounced','complained')),
  operator_id text NOT NULL,
  evidence_sha256 text NOT NULL CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),
  provider_id text,
  previous_state text NOT NULL,
  previous_delivery_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(idempotency_key,previous_version)
);
`;
