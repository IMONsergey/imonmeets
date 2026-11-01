import { getMigrations } from "better-auth/db/migration";
import { createAuth } from "./auth.js";
import { loadConfig } from "./config.js";
import { createPool, schema } from "./db.js";
export async function migrate(databaseUrl?: string) {
  const config = loadConfig(
    databaseUrl ? { ...process.env, DATABASE_URL: databaseUrl } : process.env,
  );
  const pool = createPool(config.databaseUrl);
  try {
    const client = await pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(73621904)");
      const auth = createAuth(config, pool);
      const { runMigrations } = await getMigrations(auth.options);
      await runMigrations();
      await client.query("BEGIN");
      await client.query(schema);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      await client.query("SELECT pg_advisory_unlock(73621904)");
      client.release();
    }
  } finally {
    await pool.end();
  }
}
if (
  process.argv[1]?.endsWith("migrate.ts") ||
  process.argv[1]?.endsWith("migrate.js")
) {
  await migrate();
  console.log("Database migrations applied");
}
