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
CREATE INDEX IF NOT EXISTS im_payments_pending ON im_payments(updated_at) WHERE status IN ('creating','pending','waiting_for_capture');
`;
