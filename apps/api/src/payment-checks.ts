import { randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import { ApiError } from "./policy.js";

/** Durable leases across API replicas. Separate slots prevent pending orders starving refund checks. */
export async function processPaymentChecks(
  pool: Pool,
  process: (row: QueryResultRow) => Promise<unknown>,
) {
  const rows: QueryResultRow[] = [];
  for (const statuses of [
    ["creating", "pending", "waiting_for_capture"],
    ["succeeded"],
  ]) {
    const claimed = await pool.query(
      "WITH picked AS (SELECT id FROM im_payments WHERE status=ANY($1::text[]) AND next_check_at<=now() AND (check_lease_until IS NULL OR check_lease_until<now()) ORDER BY next_check_at,id LIMIT 4 FOR UPDATE SKIP LOCKED), claimed AS (UPDATE im_payments p SET check_lease_token=$2,check_lease_until=now()+interval '3 minutes' FROM picked WHERE p.id=picked.id RETURNING p.*) SELECT claimed.*,u.email FROM claimed LEFT JOIN \"user\" u ON u.id=claimed.user_id",
      [statuses, randomUUID()],
    );
    rows.push(...claimed.rows);
  }
  let checked = 0,
    failed = 0;
  // At most eight calls per tick, sequential; every provider call has its own timeout.
  for (const row of rows) {
    try {
      await process(row);
      await pool.query(
        "UPDATE im_payments SET check_lease_token=NULL,check_lease_until=NULL,next_check_at=now()+CASE WHEN status='succeeded' THEN interval '6 hours' ELSE interval '2 minutes' END WHERE id=$1 AND check_lease_token=$2",
        [row.id, row.check_lease_token],
      );
      checked++;
    } catch (error) {
      const code =
        error instanceof ApiError &&
        [
          "PAYMENT_REVIEW_REQUIRED",
          "PAYMENT_MISMATCH",
          "PAYMENT_WORKSPACE_MISSING",
          "RATE_LIMITED",
          "PAYMENT_CHECK_PENDING",
        ].includes(error.code)
          ? error.code
          : "PAYMENT_CHECK_PENDING";
      await pool.query(
        "UPDATE im_payments SET check_lease_token=NULL,check_lease_until=NULL,last_check_error=$3,check_failures=LEAST(check_failures+1,20),next_check_at=now()+make_interval(secs => CASE WHEN $3='PAYMENT_REVIEW_REQUIRED' THEN 86400 ELSE LEAST(21600,120*power(2,LEAST(check_failures,8)))::int END) WHERE id=$1 AND check_lease_token=$2",
        [row.id, row.check_lease_token, code],
      );
      failed++;
    }
  }
  return { checked, failed };
}
