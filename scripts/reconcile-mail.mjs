#!/usr/bin/env node
// No public HTTP endpoint. Requires the operator's existing private DB access.
import { readFile } from "node:fs/promises";
import { apiRuntime } from "./api-runtime.mjs";
if (process.env.IMON_ENV_FILE) process.loadEnvFile(process.env.IMON_ENV_FILE);
const args = process.argv.slice(2);
const list = args.length === 1 && args[0] === "--list";
const apply = args.length === 3 && args[0] === "--apply" && args[1] === "--file";
if (!list && !apply) throw new Error("Use reconcile-mail.mjs --list OR --apply --file PRIVATE_RECONCILIATION_JSON");
const { createPool } = await apiRuntime("db");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = createPool(process.env.DATABASE_URL);
try {
  if (list) {
    const result = await pool.query("SELECT idempotency_key,provider,state,delivery_status,version,provider_id,created_at,updated_at,lease_expires_at FROM im_email_deliveries WHERE state IN ('sending','uncertain') ORDER BY created_at LIMIT 50");
    console.log(JSON.stringify({ unresolved: result.rows, automaticRetry: false }, null, 2));
  } else {
    const { reconcileMailDelivery } = await apiRuntime("mail-reconciliation");
    const input = JSON.parse(await readFile(args[2], "utf8"));
    console.log(JSON.stringify(await reconcileMailDelivery(pool, input)));
  }
} catch (error) {
  // Do not echo JSON input, database parameters, provider responses or stack traces.
  console.error(JSON.stringify({ reconciled: false, error: error?.name === "ZodError" ? "INVALID_RECONCILIATION" : "RECONCILIATION_REFUSED" }));
  process.exitCode = 1;
} finally { await pool.end(); }
