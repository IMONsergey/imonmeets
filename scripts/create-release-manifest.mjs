#!/usr/bin/env node
/** Prepare a release from clean source, an immutable image and a local build receipt.
 * The receipt is trusted local operator evidence, not a cryptographic external attestation.
 * No containers are started, no environment is edited and nothing is deployed.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  readFile,
  readdir,
  writeFile,
  mkdir,
  lstat,
  open,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { configurationHash } from "./check-launch-readiness.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const RECEIPT_MAX_BYTES = 128 * 1024;
const ARCHIVE_MAX_BYTES = 128 * 1024 * 1024;
export const BUILD_ONLY_ACCEPTANCE =
  "build-only; migrations and external capabilities not accepted";
const capabilities = [
  "deletion",
  "legal",
  "media",
  "alerts",
  "email",
  "billing",
  "recording",
  "transcription",
  "summary",
];
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function isoTime(value) {
  if (typeof value !== "string") throw new Error("Invalid build receipt time");
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  const instant = Date.parse(value);
  if (!parts || !Number.isFinite(instant))
    throw new Error("Invalid build receipt time");
  const [, year, month, day, hour, minute, second] = parts;
  const calendar = new Date(0);
  calendar.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  calendar.setUTCHours(Number(hour), Number(minute), Number(second), 0);
  if (
    calendar.getUTCFullYear() !== Number(year) ||
    calendar.getUTCMonth() !== Number(month) - 1 ||
    calendar.getUTCDate() !== Number(day) ||
    calendar.getUTCHours() !== Number(hour) ||
    calendar.getUTCMinutes() !== Number(minute) ||
    calendar.getUTCSeconds() !== Number(second)
  )
    throw new Error("Invalid build receipt time");
  return instant;
}

export function validateReleaseIdentity(commit, dirty, image) {
  if (!/^[a-f0-9]{40}$/.test(commit) || dirty.trim())
    throw new Error("Release source must be a clean committed checkout");
  if (
    !image ||
    !/^sha256:[a-f0-9]{64}$/.test(image.id || "") ||
    image.revision !== commit
  )
    throw new Error("Image revision must match the exact release commit");
  if (!Number.isFinite(Date.parse(image.created)))
    throw new Error("Image creation time is missing");
  return { commit, imageId: image.id, imageCreatedAt: image.created };
}

export function validateBuildReceipt(
  receipt,
  { commit, imageInfo, sourceArchiveSha256, now = new Date().toISOString() },
) {
  if (
    !record(receipt) ||
    receipt.schema !== 1 ||
    !/^[a-f0-9]{64}$/.test(sourceArchiveSha256 || "") ||
    receipt.sourceCommit !== commit ||
    receipt.imageId !== imageInfo.id ||
    receipt.sourceArchiveSha256 !== sourceArchiveSha256 ||
    receipt.imageCreatedAt !== imageInfo.created ||
    receipt.productionChanges !== false ||
    receipt.deployed !== false ||
    receipt.acceptance !== BUILD_ONLY_ACCEPTANCE ||
    typeof receipt.builder !== "string" ||
    !receipt.builder.trim() ||
    receipt.builder.length > 256 ||
    /[\x00-\x1f\x7f]/.test(receipt.builder) ||
    typeof receipt.imageTag !== "string" ||
    !/^[a-z0-9][a-z0-9./:@_-]{0,255}$/.test(receipt.imageTag) ||
    !record(receipt.observedRunStepLimits)
  )
    throw new Error("Build receipt does not match the exact local release");
  const started = isoTime(receipt.startedAt);
  const completed = isoTime(receipt.completedAt);
  const created = isoTime(receipt.imageCreatedAt);
  const current = isoTime(now);
  if (started > completed || completed > current || created > completed)
    throw new Error("Build receipt times are inconsistent or in the future");
  const steps = Object.entries(receipt.observedRunStepLimits);
  if (!steps.length || steps.length > 64)
    throw new Error("Build receipt has no bounded RUN-step observations");
  const required = {
    CpuPeriod: 100000,
    CpuQuota: 100000,
    Memory: 2147483648,
    MemorySwap: 2147483648,
  };
  const limits = Object.fromEntries(
    steps.map(([id, observed]) => {
      if (
        !/^[a-f0-9]{12,64}$/.test(id) ||
        !record(observed) ||
        Object.entries(required).some(
          ([key, expected]) => observed[key] !== expected,
        )
      )
        throw new Error("Build receipt RUN-step resource limits are invalid");
      return [id, { ...required }];
    }),
  );
  // Copy known fields only: a receipt must never publish arbitrary local metadata.
  return {
    schema: 1,
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt,
    sourceCommit: receipt.sourceCommit,
    sourceArchiveSha256: receipt.sourceArchiveSha256,
    imageId: receipt.imageId,
    imageTag: receipt.imageTag,
    imageCreatedAt: receipt.imageCreatedAt,
    builder: receipt.builder,
    observedRunStepLimits: limits,
    productionChanges: false,
    deployed: false,
    acceptance: BUILD_ONLY_ACCEPTANCE,
  };
}

/** Bounded descriptor read; reject symlinks, nonregular files and nonprivate mode. */
async function readBuildEvidence(file) {
  let handle;
  try {
    const before = await lstat(file);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      (before.mode & 0o777) !== 0o600 ||
      before.size > RECEIPT_MAX_BYTES ||
      typeof constants.O_NOFOLLOW !== "number"
    )
      throw new Error();
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      (opened.mode & 0o777) !== 0o600 ||
      opened.size > RECEIPT_MAX_BYTES
    )
      throw new Error();
    const buffer = Buffer.alloc(RECEIPT_MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        size,
        buffer.length - size,
        size,
      );
      if (!bytesRead) break;
      size += bytesRead;
    }
    const after = await handle.stat();
    if (
      size > RECEIPT_MAX_BYTES ||
      after.size !== size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      (after.mode & 0o777) !== 0o600
    )
      throw new Error();
    const raw = buffer.subarray(0, size);
    return {
      receipt: JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(raw),
      ),
      sha256: sha(raw),
    };
  } catch {
    throw new Error(
      "Build receipt must be a stable private 0600 regular JSON file within 128 KiB",
    );
  } finally {
    await handle?.close();
  }
}

export async function readBuildReceipt(file) {
  return (await readBuildEvidence(file)).receipt;
}

/** Reverify the archive against live inspect data; a supplied JSON proof is never accepted. */
export async function verifyContainerdImageTransfer({
  directory,
  commit,
  imageInfo,
  buildReceipt,
  buildReceiptSha256,
  sourceArchiveSha256,
}) {
  if (
    typeof directory !== "string" ||
    !path.isAbsolute(directory) ||
    !record(buildReceipt) ||
    !/^sha256:[a-f0-9]{64}$/.test(buildReceipt.imageId || "") ||
    !/^[a-f0-9]{64}$/.test(buildReceiptSha256 || "")
  )
    throw new Error("Explicit immutable image transfer evidence is required");
  const loaded = {
    id: imageInfo.id,
    created: imageInfo.created,
    revision: imageInfo.revision,
    os: imageInfo.os,
    architecture: imageInfo.architecture,
    rootfs: {
      type: imageInfo.rootfs?.type,
      diff_ids: imageInfo.rootfs?.diff_ids,
    },
    releaseCommit: imageInfo.releaseCommit,
  };
  const input = JSON.stringify(loaded);
  const result = JSON.parse(
    execFileSync(
      "python3",
      [
        path.join(root, "scripts/verify-containerd-image-identity.py"),
        "--directory",
        directory,
        "--source-commit",
        commit,
        "--expected-config-digest",
        buildReceipt.imageId,
        "--expected-build-receipt-sha256",
        buildReceiptSha256,
      ],
      {
        encoding: "utf8",
        input,
        timeout: 120000,
        maxBuffer: 128 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      },
    ),
  );
  if (
    !record(result) ||
    result.schema !== 1 ||
    result.status !== "PASS_ARCHIVE_TO_RUNTIME_IDENTITY" ||
    result.sourceCommit !== commit ||
    result.sourceArchiveSha256 !== sourceArchiveSha256 ||
    result.imageCreatedAt !== imageInfo.created ||
    result.legacyConfigDigest !== buildReceipt.imageId ||
    result.runtimeManifestDigest !== imageInfo.id ||
    result.buildReceiptSha256 !== buildReceiptSha256 ||
    result.loadedProjectionSha256 !== sha(input) ||
    result.loadedRootfsMatches !== true ||
    result.imageExecuted !== false ||
    result.originalReceiptsModified !== false
  )
    throw new Error(
      "Image transfer identity proof does not match this preparation",
    );
  return result;
}

/** Hash the actual committed build context, without buffering an archive in RAM. */
export function gitArchiveSha256(
  source,
  commit,
  { maxBytes = ARCHIVE_MAX_BYTES, timeoutMs = 30000 } = {},
) {
  if (
    !/^[a-f0-9]{40}$/.test(commit) ||
    !Number.isInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > ARCHIVE_MAX_BYTES ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 30000
  )
    throw new Error("Invalid source archive request");
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["archive", "--format=tar", commit], {
      cwd: source,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const hash = createHash("sha256");
    let bytes = 0;
    let failure;
    const timer = setTimeout(() => {
      failure = new Error("Source archive exceeded its time limit");
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stderr.resume();
    child.stdout.on("data", (chunk) => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        failure = new Error("Source archive exceeded its size limit");
        child.kill("SIGKILL");
        return;
      }
      hash.update(chunk);
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("Unable to read the exact committed source archive"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure || code !== 0) {
        reject(
          failure ||
            new Error("Unable to read the exact committed source archive"),
        );
        return;
      }
      resolve(hash.digest("hex"));
    });
  });
}

export async function createManifest({
  source = root,
  imageInfo,
  commit,
  dirty,
  buildReceipt,
  buildReceiptSha256,
  sourceArchiveSha256,
  candidateTransfer,
  operatorTooling,
  env = {},
  now = new Date().toISOString(),
}) {
  const identity = validateReleaseIdentity(commit, dirty, imageInfo);
  const imageIdentity = candidateTransfer
    ? await verifyContainerdImageTransfer({
        directory: candidateTransfer,
        commit,
        imageInfo,
        buildReceipt,
        buildReceiptSha256,
        sourceArchiveSha256,
      })
    : undefined;
  // Preserve the original receipt. Only the fully verified archive bridge may
  // select its config digest for the strict receipt comparison; runtime stays pinned.
  const verifiedBuild = validateBuildReceipt(buildReceipt, {
    commit,
    imageInfo: imageIdentity
      ? { ...imageInfo, id: imageIdentity.legacyConfigDigest }
      : imageInfo,
    sourceArchiveSha256,
    now,
  });
  const effective = {
    ...env,
    RELEASE_COMMIT: commit,
    RELEASE_IMAGE_DIGEST: identity.imageId,
  };
  const migrations = {};
  for (const name of (await readdir(path.join(source, "apps/api/src")))
    .filter(
      (name) =>
        name === "db.ts" ||
        name === "migrate.ts" ||
        name.endsWith("-schema.ts"),
    )
    .sort()) {
    migrations[name] = sha(
      await readFile(path.join(source, "apps/api/src", name)),
    );
  }
  return {
    schema: 1,
    preparedAt: now,
    ...identity,
    applicationImage: identity.imageId,
    sourceArchiveSha256,
    buildReceipt: verifiedBuild,
    ...(imageIdentity ? { imageIdentity } : {}),
    ...(operatorTooling ? { operatorTooling } : {}),
    buildReceiptTrust:
      "trusted local 0600 receipt; not a cryptographic external attestation",
    configurationHashes: Object.fromEntries(
      capabilities.map((capability) => [
        capability,
        configurationHash(effective, capability),
      ]),
    ),
    migrationSourceSha256: migrations,
    environmentIdentityMatches:
      env.RELEASE_COMMIT === commit &&
      env.RELEASE_IMAGE_DIGEST === identity.imageId,
    deployed: false,
    acceptance: "not-evaluated",
    requiredEnvironment: {
      APP_IMAGE: identity.imageId,
      RELEASE_COMMIT: commit,
      RELEASE_IMAGE_DIGEST: identity.imageId,
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  function option(name) {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  }
  const image = option("--image");
  const environment = option("--env");
  const receiptPath = option("--build-receipt");
  const candidateTransfer = option("--candidate-transfer");
  if (
    candidateTransfer &&
    (!path.isAbsolute(candidateTransfer) ||
      !/^sha256:[a-f0-9]{64}$/.test(image || ""))
  )
    throw new Error(
      "A containerd transfer requires an absolute directory and immutable runtime ID",
    );
  if (
    !image ||
    !/^[a-z0-9][a-z0-9./:@_-]{0,255}$/.test(image) ||
    !environment ||
    !receiptPath
  )
    throw new Error(
      "Usage: --image IMAGE --env FILE --build-receipt FILE [--source DIR] [--candidate-transfer DIR] [--output FILE] [--sudo-docker]",
    );
  const { receipt: buildReceipt, sha256: buildReceiptSha256 } =
    await readBuildEvidence(receiptPath);
  const source = await realpath(option("--source") || root);
  const info = await lstat(environment);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024)
    throw new Error("Environment file is not a bounded regular file");
  const env = parseEnv(await readFile(environment, "utf8"));
  const gitAt = (directory, args) =>
    execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const git = (args) => gitAt(source, args);
  if ((await realpath(git(["rev-parse", "--show-toplevel"]))) !== source)
    throw new Error("Release source must be the exact checkout root");
  const toolingCommit = gitAt(root, ["rev-parse", "HEAD"]);
  if (gitAt(root, ["status", "--porcelain"]))
    throw new Error("Operator tooling is not clean committed source");
  const toolingFiles = [
    "create-release-manifest.mjs",
    "verify-containerd-image-identity.py",
    "ci-candidate-image.py",
    "check-launch-readiness.mjs",
  ];
  const operatorTooling = {
    commit: toolingCommit,
    nodeVersion: process.version,
    files: Object.fromEntries(
      await Promise.all(
        toolingFiles.map(async (name) => [
          name,
          sha(await readFile(path.join(root, "scripts", name))),
        ]),
      ),
    ),
  };
  const commit = git(["rev-parse", "HEAD"]);
  const dirty = git(["status", "--porcelain"]);
  if (dirty) throw new Error("Release source is not clean");
  const sourceArchiveSha256 = await gitArchiveSha256(source, commit);
  const format =
    '{"id":{{json .Id}},"created":{{json .Created}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"os":{{json .Os}},"architecture":{{json .Architecture}},"rootfs":{"type":{{json .RootFS.Type}},"diff_ids":{{json .RootFS.Layers}}},"releaseEnv":{{json .Config.Env}}}';
  const dockerArgs = ["image", "inspect", "--format", format, image];
  const imageInfo = JSON.parse(
    execFileSync(
      args.includes("--sudo-docker") ? "sudo" : "docker",
      args.includes("--sudo-docker")
        ? ["-n", "docker", ...dockerArgs]
        : dockerArgs,
      { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
  if (candidateTransfer && imageInfo.id !== image)
    throw new Error(
      "Loaded runtime ID differs from the requested immutable ID",
    );
  const releaseValues = Array.isArray(imageInfo.releaseEnv)
    ? imageInfo.releaseEnv.filter(
        (value) =>
          typeof value === "string" && value.startsWith("RELEASE_COMMIT="),
      )
    : [];
  imageInfo.releaseCommit =
    releaseValues.length === 1
      ? releaseValues[0].slice("RELEASE_COMMIT=".length)
      : undefined;
  delete imageInfo.releaseEnv;
  const manifest = await createManifest({
    source,
    commit,
    dirty,
    imageInfo,
    env,
    buildReceipt,
    buildReceiptSha256,
    sourceArchiveSha256,
    candidateTransfer,
    operatorTooling,
  });
  if (
    gitAt(root, ["rev-parse", "HEAD"]) !== toolingCommit ||
    gitAt(root, ["status", "--porcelain"])
  )
    throw new Error("Operator tooling changed during preparation");
  if (git(["rev-parse", "HEAD"]) !== commit || git(["status", "--porcelain"]))
    throw new Error("Release checkout changed during preparation");
  const output = path.resolve(
    option("--output") || path.join(source, "ops-state/release-manifest.json"),
  );
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, JSON.stringify(manifest, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  console.log(
    JSON.stringify({
      prepared: true,
      commit,
      imageId: manifest.imageId,
      environmentIdentityMatches: manifest.environmentIdentityMatches,
      deployed: false,
      acceptance: "not-evaluated",
    }),
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(() => {
    console.error(
      "RELEASE_MANIFEST_NOT_CREATED: check clean source, exact image, private build receipt, environment file and a new output path.",
    );
    process.exitCode = 1;
  });
}
