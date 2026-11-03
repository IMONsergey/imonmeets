import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ApiError } from "./policy.js";
export interface RateLimiter {
  consume(
    key: string,
    max: number,
    seconds: number,
    db?: PoolClient,
  ): Promise<{ allowed: boolean; retryAfter: number | null }>;
}
export function postgresLimiter(pool: Pool): RateLimiter {
  return {
    async consume(key, max, seconds, db) {
      const digest = createHash("sha256").update(key).digest("hex");
      const result = await (db ?? pool).query(
        `INSERT INTO im_rate_limits(key,count,expires_at) VALUES($1,1,now()+$2*interval '1 second')
      ON CONFLICT(key) DO UPDATE SET count=CASE WHEN im_rate_limits.expires_at<=now() THEN 1 ELSE LEAST(im_rate_limits.count+1,$3+1) END,
      expires_at=CASE WHEN im_rate_limits.expires_at<=now() THEN now()+$2*interval '1 second' ELSE im_rate_limits.expires_at END
      RETURNING count, GREATEST(1,ceil(extract(epoch FROM expires_at-now())))::int AS retry_after`,
        [digest, seconds, max],
      );
      const row = result.rows[0];
      return {
        allowed: row.count <= max,
        retryAfter: row.count <= max ? null : row.retry_after,
      };
    },
  };
}
export async function requireBudget(
  limiter: RateLimiter,
  key: string,
  max: number,
  seconds: number,
  db?: PoolClient,
) {
  const result = await limiter.consume(key, max, seconds, db);
  if (!result.allowed)
    throw new ApiError(
      429,
      "RATE_LIMIT",
      "Слишком много запросов. Повторите позже.",
      result.retryAfter ?? seconds,
    );
}
