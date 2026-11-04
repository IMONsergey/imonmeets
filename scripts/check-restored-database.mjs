#!/usr/bin/env node
/** Read-only SQL-restore inspection. Never enroll, replay, start the app, or contact providers. */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPublicKey } from "node:crypto";
import { readEnv } from "./check-deletion-journal.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const referenceDatabase = "imonmeets";
const quote = (name) => '"' + name.replaceAll('"', '""') + '"';
const fail = (message) => {
  throw new Error(message);
};
export const catalogSql = [
  "SELECT json_build_object('database',current_database(),'tables',COALESCE(json_agg(",
  " json_build_object('name',c.relname,'kind',c.relkind,'rowSecurity',c.relrowsecurity,",
  " 'columns',(SELECT json_agg(json_build_object(",
  "  'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,",
  "  'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated",
  " ) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d",
  " ON d.adrelid=a.attrelid AND d.adnum=a.attnum",
  " WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),",
  " 'constraints',COALESCE((SELECT json_agg(json_build_object('name',x.conname,",
  " 'definition',pg_get_constraintdef(x.oid,true),'validated',x.convalidated) ORDER BY x.conname)",
  " FROM pg_constraint x WHERE x.conrelid=c.oid),'[]'::json),",
  " 'indexes',COALESCE((SELECT json_agg(pg_get_indexdef(i.indexrelid) ORDER BY ic.relname)",
  " FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid),'[]'::json)",
  " ) ORDER BY c.relname),'[]'::json))",
  "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace",
  "WHERE n.nspname='public' AND c.relkind IN ('r','p');",
].join("\n");
export const bindingSql =
  "SELECT COALESCE(json_agg(row_to_json(b)),'[]'::json) FROM (SELECT * FROM public.im_deletion_journal_binding ORDER BY singleton) b;";

export function requireRestoreDatabase(database) {
  if (!/^imonmeets_restore_[a-zA-Z0-9_]+$/.test(database))
    fail(
      "Only a separately created imonmeets_restore_* database may be inspected",
    );
}
function validCatalog(value, database) {
  if (
    value?.database !== database ||
    !Array.isArray(value.tables) ||
    !value.tables.length ||
    value.tables.length > 256
  )
    fail("Unexpected database or public table inventory");
  const names = value.tables.map((table) => table.name);
  if (
    names.some(
      (name) => typeof name !== "string" || !name.length || name.length > 63,
    ) ||
    new Set(names).size !== names.length
  )
    fail("Invalid public table names");
  return value.tables;
}
function oneBinding(rows) {
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    rows[0].singleton !== 1 ||
    !["empty-database", "reviewed-baseline"].includes(rows[0].enrollment_mode)
  )
    fail("Exactly one existing deletion authority binding is required");
  return rows[0];
}
export async function verifyRestoredDatabase({
  database,
  query,
  loadAuthority,
  offlineInspection = false,
}) {
  requireRestoreDatabase(database);
  const restored = validCatalog(await query(database, catalogSql), database);
  let authorityMatched = false;
  if (!offlineInspection) {
    const reference = validCatalog(
      await query(referenceDatabase, catalogSql),
      referenceDatabase,
    );
    if (JSON.stringify(restored) !== JSON.stringify(reference))
      fail(
        "Restored public tables, columns, constraints or indexes differ from the current application database",
      );
    if (!restored.some((table) => table.name === "im_deletion_journal_binding"))
      fail(
        "Bound backup required; legacy archives need explicit offline inspection",
      );
    const authority = await loadAuthority();
    const live = oneBinding(await query(referenceDatabase, bindingSql));
    const copy = oneBinding(await query(database, bindingSql));
    for (const binding of [live, copy]) {
      if (
        binding.journal_id !== authority.journalId ||
        binding.genesis_sha256 !== authority.genesisSha256
      )
        fail(
          "Deletion authority does not match the HMAC-validated canonical journal",
        );
    }
    if (JSON.stringify(copy) !== JSON.stringify(live))
      fail(
        "Restored immutable authority binding differs from the application database",
      );
    authorityMatched = true;
  }
  const rowCounts = {};
  for (const table of restored) {
    const count = await query(
      database,
      "SELECT json_build_object('rows',count(*)::text) FROM public." +
        quote(table.name) +
        ";",
    );
    if (!/^(0|[1-9][0-9]*)$/.test(count?.rows))
      fail("A restored table could not be counted");
    rowCounts[table.name] = count.rows;
  }
  return {
    checkedAt: new Date().toISOString(),
    status: offlineInspection
      ? "OFFLINE_INSPECTION_ONLY"
      : "SQL_RESTORE_VERIFIED",
    database,
    tableCount: restored.length,
    rowCounts,
    publicSchemaMatchesCurrentDatabase: !offlineInspection,
    canonicalBindingMatched: authorityMatched,
    replayPerformed: false,
    servingAuthorized: false,
    scope: offlineInspection
      ? "Disposable offline inspection only; no schema or authority acceptance"
      : "Restored SQL copy, current public table structure/readability, existing canonical authority and complete binding",
    limits: [
      "Live row counts are not compared: the running application may legitimately change them after the backup.",
      "This does not independently certify migration completeness, historical deletions, independent checkpoint durability, or startup recovery.",
      "A separately reviewed complete-head/replay workflow is still required before serving any restored database.",
    ],
  };
}
export function dockerReadOnlyQuery(database, sql) {
  if (database !== referenceDatabase) requireRestoreDatabase(database);
  let output;
  try {
    output = execFileSync(
      "docker",
      [
        "compose",
        "-p",
        "imonmeets",
        "exec",
        "-T",
        "db",
        "psql",
        "-U",
        "imonmeets",
        "-d",
        database,
        "-XAt",
        "-v",
        "ON_ERROR_STOP=1",
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
        input:
          "BEGIN READ ONLY; SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='3s'; SET LOCAL TIME ZONE 'UTC'; SET LOCAL search_path=public,pg_catalog;\n" +
          sql +
          "\nROLLBACK;\n",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  } catch {
    fail("Read-only restore inspection query failed");
  }
  const values = output
    .split("\n")
    .filter((line) => line.startsWith("{") || line.startsWith("["));
  if (values.length !== 1) fail("Unexpected restore inspection query output");
  return JSON.parse(values[0]);
}
export function hostAuthorityEnvironment(model) {
  const app = model?.services?.app;
  const env = app?.environment;
  const directory = env?.DELETION_JOURNAL_DIR;
  if (
    typeof directory !== "string" ||
    !path.isAbsolute(directory) ||
    typeof env?.DELETION_JOURNAL_KEY !== "string" ||
    env.DELETION_JOURNAL_KEY.length < 32
  )
    fail("Effective app deletion authority configuration is missing");
  const mounts = (app.volumes || []).filter(
    (volume) => volume.target === directory,
  );
  if (
    mounts.length !== 1 ||
    mounts[0].type !== "bind" ||
    typeof mounts[0].source !== "string" ||
    !path.isAbsolute(mounts[0].source)
  )
    fail(
      "Exactly one explicit host bind for the canonical journal is required",
    );
  try {
    if (
      typeof env.DELETION_WITNESS_PUBLIC_KEY !== "string" ||
      createPublicKey(env.DELETION_WITNESS_PUBLIC_KEY.replaceAll("\\n", "\n"))
        .asymmetricKeyType !== "ed25519"
    )
      fail("Invalid independent receiver public key");
  } catch {
    fail("Invalid independent receiver public key");
  }
  const selected = {};
  for (const key of [
    "DELETION_JOURNAL_KEY",
    "DELETION_WITNESS_PUBLIC_KEY",
    "DELETION_WITNESS_URL",
    "DELETION_WITNESS_TOKEN",
    "DELETION_RESTORE_REQUIRED",
    "NODE_ENV",
  ])
    if (env[key] !== undefined) selected[key] = env[key];
  selected.DELETION_JOURNAL_DIR = mounts[0].source;
  return selected;
}
export function resolveHostAuthorityEnvironment(projectDirectory = root) {
  const args = [
    "compose",
    "--project-directory",
    projectDirectory,
    "-p",
    "imonmeets",
    "--env-file",
    path.join(projectDirectory, ".env"),
  ];
  for (const name of [
    "compose.yml",
    "compose.public.yml",
    "compose.turn.yml",
    "compose.recording.yml",
  ])
    args.push("-f", path.join(projectDirectory, name));
  args.push(
    "-f",
    "/etc/imonmeets/compose-meets-runtime.yml",
    "config",
    "--format",
    "json",
  );
  let model;
  try {
    // Effective config may contain credentials. Keep stdout/stderr private and never print it.
    model = JSON.parse(
      execFileSync("docker", args, {
        cwd: projectDirectory,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch {
    fail(
      "Cannot resolve the installed private Compose authority configuration",
    );
  }
  return hostAuthorityEnvironment(model);
}
export async function loadCanonicalAuthority(envPath, projectDirectory = root) {
  // envPath is only an explicit isolated-fixture input; scheduled checks use effective Compose.
  const env = envPath
    ? await readEnv(envPath)
    : resolveHostAuthorityEnvironment(projectDirectory);
  const { apiRuntime } = await import(
    pathToFileURL(path.join(projectDirectory, "scripts/api-runtime.mjs")).href
  );
  const api = await apiRuntime("deletion-journal");
  const journal = await api.openDeletionJournal(
    { ...api.loadDeletionConfig(env), required: true },
    async () => {
      fail("Restore inspection must not contact the independent receiver");
    },
  );
  if (!journal) fail("Canonical deletion journal is required");
  return journal.identity;
}
export async function main(args = process.argv.slice(2)) {
  if (
    args.length < 1 ||
    args.length > 2 ||
    (args[1] && args[1] !== "--inspect-unbound-offline")
  )
    fail(
      "Usage: node scripts/check-restored-database.mjs imonmeets_restore_NAME [--inspect-unbound-offline]",
    );
  const result = await verifyRestoredDatabase({
    database: args[0],
    query: dockerReadOnlyQuery,
    loadAuthority: loadCanonicalAuthority,
    offlineInspection: args[1] === "--inspect-unbound-offline",
  });
  console.log(JSON.stringify(result));
  return result;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(() => {
    console.error(
      "Restore inspection failed; disposable database must not be served. Inspect private local configuration and schema.",
    );
    process.exitCode = 1;
  });
}
