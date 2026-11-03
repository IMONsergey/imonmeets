#!/usr/bin/env node
/** Inspect the current journal and independent checkpoint. Never replay or delete data. */
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { configurationHash } from "./check-launch-readiness.mjs";

async function readEnv(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size > 128 * 1024 ||
      (before.mode & 0o077) !== 0
    )
      throw new Error("Invalid environment file");
    const buffer = Buffer.alloc(128 * 1024 + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const part = await handle.read(
        buffer,
        bytes,
        buffer.length - bytes,
        bytes,
      );
      if (!part.bytesRead) break;
      bytes += part.bytesRead;
    }
    const after = await handle.stat();
    if (
      bytes !== before.size ||
      bytes > 128 * 1024 ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("Environment changed");
    return parseEnv(buffer.subarray(0, bytes).toString("utf8"));
  } finally {
    await handle.close();
  }
}

async function save(file, value) {
  const directory = path.dirname(path.resolve(file));
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new Error("Private existing output directory required");
  const temp = path.join(directory, ".deletion-status-" + randomUUID());
  let handle;
  try {
    handle = await fs.open(
      temp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temp, file);
    const folder = await fs.open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await folder.sync();
    } finally {
      await folder.close();
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temp).catch(() => {});
  }
}

export async function inspectDeletionJournal(env, dependencies) {
  const state = {
    checkedAt: new Date().toISOString(),
    configurationHash: configurationHash(env, "deletion"),
    ok: false,
    proofValid: false,
    journalComplete: false,
    capacityAvailable: false,
  };
  try {
    const api =
      dependencies || (await import("../apps/api/dist/deletion-journal.js"));
    const journal = await api.openDeletionJournal({
      ...api.loadDeletionConfig(env),
      required: true,
    });
    if (!journal) return state;
    const snapshot = await journal.snapshot();
    const proofValid = await journal.verifyIndependentCheckpoint(snapshot, {
      recoverPending: false,
    });
    const capacityAvailable =
      Number.isSafeInteger(snapshot.version) &&
      snapshot.version >= 0 &&
      snapshot.version < 10_000;
    return {
      ...state,
      checkedAt: new Date().toISOString(),
      ok: proofValid === true && capacityAvailable,
      proofValid: proofValid === true,
      journalComplete: proofValid === true,
      capacityAvailable,
    };
  } catch {
    return { ...state, checkedAt: new Date().toISOString() };
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (
      !["--env", "--output"].includes(args[i]) ||
      !args[i + 1] ||
      args[i + 1].startsWith("--")
    )
      throw new Error("Invalid arguments");
    options[args[i]] = path.resolve(args[i + 1]);
  }
  const env = options["--env"] ? await readEnv(options["--env"]) : process.env;
  const state = await inspectDeletionJournal(env);
  if (options["--output"]) await save(options["--output"], state);
  console.log(JSON.stringify(state));
  return state.ok ? 0 : 1;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.error("DELETION_STATUS_NOT_WRITTEN");
      process.exitCode = 2;
    });
}
