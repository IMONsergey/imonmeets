export const billingSchema = `
ALTER TABLE im_workspace_plans DROP CONSTRAINT IF EXISTS im_workspace_plans_plan_id_check;
ALTER TABLE im_workspace_plans ADD CONSTRAINT im_workspace_plans_plan_id_check CHECK(plan_id IN ('pilot','pro'));
ALTER TABLE im_workspace_plans ADD COLUMN IF NOT EXISTS paid_until timestamptz;
CREATE TABLE IF NOT EXISTS im_payments (
 id text PRIMARY KEY,workspace_id text NOT NULL,
 user_id text NOT NULL,request_id uuid NOT NULL,plan_id text NOT NULL CHECK(plan_id='pro'),
 amount_kopecks bigint NOT NULL CHECK(amount_kopecks>=100),currency text NOT NULL CHECK(currency='RUB'),test boolean NOT NULL,
 provider_id text UNIQUE,status text NOT NULL CHECK(status IN ('creating','pending','waiting_for_capture','succeeded','canceled','refunded')),
 confirmation_url text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),applied_at timestamptz,
 entitlement_start timestamptz,entitlement_end timestamptz,reversed_at timestamptz,
 UNIQUE(workspace_id,request_id)
);
ALTER TABLE im_payments DROP CONSTRAINT IF EXISTS im_payments_workspace_id_fkey;
ALTER TABLE im_payments ADD COLUMN IF NOT EXISTS refunded_kopecks bigint NOT NULL DEFAULT 0 CHECK(refunded_kopecks>=0 AND refunded_kopecks<=amount_kopecks);
UPDATE im_payments SET refunded_kopecks=amount_kopecks WHERE status='refunded' AND refunded_kopecks=0;
ALTER TABLE im_payments ADD COLUMN IF NOT EXISTS last_checked_at timestamptz;
ALTER TABLE im_payments ADD COLUMN IF NOT EXISTS next_check_at timestamptz DEFAULT now();
ALTER TABLE im_payments ADD COLUMN IF NOT EXISTS check_lease_token text;
ALTER TABLE im_payments ADD COLUMN IF NOT EXISTS check_lease_until timestamptz;
ALTER TABLE im_payments ADD COLUMN IF NOT EXISTS check_failures integer NOT NULL DEFAULT 0;
ALTER TABLE im_payments ADD COLUMN IF NOT EXISTS last_check_error text;
CREATE INDEX IF NOT EXISTS im_payments_check_queue ON im_payments(next_check_at,id) WHERE status IN ('creating','pending','waiting_for_capture','succeeded');
CREATE INDEX IF NOT EXISTS im_payments_pending ON im_payments(updated_at) WHERE status IN ('creating','pending','waiting_for_capture');
`;
