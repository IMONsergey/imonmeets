export const operationReviewSchema =
  "ALTER TABLE im_audit ADD COLUMN IF NOT EXISTS reconciliation_version text;";
