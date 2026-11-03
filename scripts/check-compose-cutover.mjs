#!/usr/bin/env node
/** Static preflight of an explicitly rendered Compose file. No Docker, network or writes. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BYTES = 4 * 1024 * 1024;
const digest = (value) =>
  typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const revision = (value) =>
  typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const immutable = (value) =>
  digest(value) ||
  (typeof value === "string" &&
    /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(value));
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const present = (value) => typeof value === "string" && value.trim().length > 0;
const directory = (value) =>
  typeof value === "string" &&
  path.posix.isAbsolute(value) &&
  path.posix.normalize(value) === value &&
  value !== "/";
const quotas = {
  EMAILS_PER_DAY: 45,
  EMAILS_PER_WORKSPACE_DAY: 45,
  EMAILS_PER_30D_BUCKET: 1000,
};
const sharedFields = [
  "APP_URL",
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "EMAIL_PROVIDER",
  "EMAIL_DELIVERY_MODE",
  "RESEND_API_KEY",
  "SMTP_FROM",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
  "DELETION_JOURNAL_KEY",
  "DELETION_WITNESS_URL",
  "DELETION_WITNESS_TOKEN",
  "DELETION_WITNESS_PUBLIC_KEY",
];

function httpsUrl(value) {
  if (!present(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function report(failures, sourceMetadataVerified = false) {
  return {
    schema: 1,
    scope: "STATIC_MERGED_COMPOSE_PREFLIGHT",
    ok: failures.length === 0,
    failures,
    sourceMetadataVerified: failures.length === 0 && sourceMetadataVerified,
    productionChanges: false,
    deployed: false,
    runtimeAccepted: false,
  };
}

/** Values are compared in memory; the result contains only fixed service/field names and codes. */
export function checkComposeCutover(compose, options = {}) {
  const failures = [];
  const fail = (service, code, field) =>
    failures.push({ service, code, ...(field ? { field } : {}) });
  const expectedAppImage = options.expectedAppImage;
  const expectedMigrateImage = options.expectedMigrateImage ?? expectedAppImage;
  const expectedCommit = options.expectedCommit;
  if (!immutable(expectedAppImage) || !immutable(expectedMigrateImage)) {
    fail("input", "EXPECTED_IMMUTABLE_IMAGE_REQUIRED");
    return report(failures);
  }
  if (expectedCommit !== undefined && !revision(expectedCommit)) {
    fail("input", "EXPECTED_COMMIT_INVALID");
    return report(failures);
  }
  if (!record(compose) || !record(compose.services)) {
    fail("input", "RENDERED_COMPOSE_SERVICES_REQUIRED");
    return report(failures);
  }
  const metadataSupplied = options.imageInspect !== undefined;
  const metadata = options.imageInspect;
  if (
    metadataSupplied &&
    (!Array.isArray(metadata) ||
      metadata.length === 0 ||
      metadata.length > 16 ||
      metadata.some((item) => !record(item)))
  ) {
    fail("input", "IMAGE_INSPECT_INVALID");
    return report(failures);
  }
  const environments = {};
  for (const [name, expectedImage] of [
    ["app", expectedAppImage],
    ["migrate", expectedMigrateImage],
  ]) {
    const service = compose.services[name];
    if (!record(service)) {
      fail(name, "SERVICE_REQUIRED");
      continue;
    }
    if (service.image !== expectedImage) fail(name, "IMAGE_MISMATCH");
    if (!record(service.environment)) {
      fail(name, "RESOLVED_ENVIRONMENT_REQUIRED");
      continue;
    }
    const env = service.environment;
    environments[name] = env;
    if (env.NODE_ENV !== "production") fail(name, "PRODUCTION_MODE_REQUIRED");
    if (!httpsUrl(env.APP_URL)) fail(name, "HTTPS_APP_URL_REQUIRED");
    if (
      !revision(env.RELEASE_COMMIT) ||
      (expectedCommit !== undefined && env.RELEASE_COMMIT !== expectedCommit)
    )
      fail(name, "RELEASE_COMMIT_MISMATCH");
    if (!digest(env.RELEASE_IMAGE_DIGEST))
      fail(name, "RELEASE_IMAGE_ID_REQUIRED");

    let imageId = digest(expectedImage) ? expectedImage : undefined;
    if (metadataSupplied) {
      const matches = metadata.filter((item) =>
        digest(expectedImage)
          ? item.Id === expectedImage
          : Array.isArray(item.RepoDigests) &&
            item.RepoDigests.includes(expectedImage),
      );
      if (matches.length !== 1 || !digest(matches[0]?.Id))
        fail(name, "IMAGE_INSPECT_IDENTITY_MISMATCH");
      else {
        const item = matches[0];
        imageId = item.Id;
        const declared =
          item.Config?.Labels?.["org.opencontainers.image.revision"];
        const requiredRevision = expectedCommit ?? env.RELEASE_COMMIT;
        if (!revision(declared) || declared !== requiredRevision)
          fail(name, "IMAGE_SOURCE_REVISION_MISMATCH");
        const baked = Array.isArray(item.Config?.Env)
          ? item.Config.Env.filter(
              (entry) =>
                typeof entry === "string" &&
                entry.startsWith("RELEASE_COMMIT="),
            )
          : [];
        if (
          baked.length > 1 ||
          (baked.length === 1 &&
            baked[0] !== "RELEASE_COMMIT=" + requiredRevision)
        )
          fail(name, "IMAGE_SOURCE_ENV_MISMATCH");
      }
    } else if (!imageId) fail(name, "IMAGE_INSPECT_REQUIRED_FOR_REGISTRY_REF");
    if (imageId && env.RELEASE_IMAGE_DIGEST !== imageId)
      fail(name, "RELEASE_IMAGE_ID_MISMATCH");

    if (
      env.EMAIL_PROVIDER !== "resend" ||
      env.EMAIL_DELIVERY_MODE !== "external"
    )
      fail(name, "EXTERNAL_RESEND_REQUIRED");
    for (const field of ["RESEND_API_KEY", "SMTP_FROM"])
      if (!present(env[field])) fail(name, "MAIL_VALUE_REQUIRED", field);
    for (const [field, max] of Object.entries(quotas)) {
      const value = Number(env[field] ?? max);
      if (!Number.isSafeInteger(value) || value < 1 || value > max)
        fail(name, "RESEND_QUOTA_INVALID", field);
    }
  }
  if (environments.app && environments.migrate) {
    for (const field of [...sharedFields, "RELEASE_COMMIT"])
      if (
        (environments.app[field] ?? "") !== (environments.migrate[field] ?? "")
      )
        fail("app+migrate", "SERVICE_CONFIGURATION_MISMATCH", field);
  }

  const app = compose.services.app;
  const env = environments.app;
  if (env) {
    const target = env.DELETION_JOURNAL_DIR;
    if (!directory(target)) fail("app", "JOURNAL_DIRECTORY_INVALID");
    if (
      !present(env.DELETION_JOURNAL_KEY) ||
      env.DELETION_JOURNAL_KEY.length < 32
    )
      fail("app", "JOURNAL_KEY_REQUIRED");
    if (!httpsUrl(env.DELETION_WITNESS_URL))
      fail("app", "HTTPS_WITNESS_REQUIRED");
    if (
      !present(env.DELETION_WITNESS_TOKEN) ||
      env.DELETION_WITNESS_TOKEN.length < 32
    )
      fail("app", "WITNESS_TOKEN_REQUIRED");
    if (!present(env.DELETION_WITNESS_PUBLIC_KEY))
      fail("app", "WITNESS_PUBLIC_KEY_REQUIRED");
    const mounts = Array.isArray(app.volumes) ? app.volumes : [];
    const exact = mounts.filter(
      (mount) => record(mount) && mount.target === target,
    );
    if (exact.length !== 1) fail("app", "EXACT_JOURNAL_BIND_REQUIRED");
    else {
      const mount = exact[0];
      if (mount.type !== "bind" || !directory(mount.source))
        fail("app", "JOURNAL_BIND_SOURCE_INVALID");
      if (mount.read_only !== undefined && mount.read_only !== false)
        fail("app", "JOURNAL_BIND_MUST_BE_WRITABLE");
      // Normalized Compose omits false; canonical short syntax emits true.
      if (
        (mount.bind !== undefined && !record(mount.bind)) ||
        (mount.bind?.create_host_path !== undefined &&
          mount.bind.create_host_path !== false)
      )
        fail("app", "JOURNAL_BIND_MUST_NOT_CREATE_HOST_PATH");
    }
    if (
      directory(target) &&
      mounts.some(
        (mount) =>
          record(mount) &&
          typeof mount.target === "string" &&
          mount.target.startsWith(target + "/"),
      )
    )
      fail("app", "JOURNAL_CHILD_MOUNT_FORBIDDEN");
    if (
      directory(target) &&
      Array.isArray(app.tmpfs) &&
      app.tmpfs.some((entry) => {
        if (typeof entry !== "string") return false;
        const mountPath = entry.split(":", 1)[0];
        return mountPath === target || mountPath.startsWith(target + "/");
      })
    )
      fail("app", "JOURNAL_TMPFS_OVERLAY_FORBIDDEN");
  }
  return report(failures, metadataSupplied);
}

async function readJson(filename) {
  const handle = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > MAX_BYTES)
      throw new Error("INPUT_FILE_INVALID");
    const data = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < data.length) {
      const result = await handle.read(
        data,
        length,
        data.length - length,
        length,
      );
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      length > MAX_BYTES
    )
      throw new Error("INPUT_FILE_CHANGED");
    return JSON.parse(data.subarray(0, length).toString("utf8"));
  } finally {
    await handle.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "Usage: node scripts/check-compose-cutover.mjs --compose <rendered.json> --expected-image <immutable-ref> [--expected-migrate-image <immutable-ref>] [--expected-commit <sha40>] [--image-inspect <docker-image-inspect.json>]\nStatic read-only preflight. Does not run Docker, inspect the host, enroll a journal, contact a provider or deploy.",
    );
    return;
  }
  const allowed = new Set([
    "--compose",
    "--expected-image",
    "--expected-migrate-image",
    "--expected-commit",
    "--image-inspect",
  ]);
  const values = {};
  let result;
  try {
    for (let index = 0; index < args.length; index += 2) {
      if (
        !allowed.has(args[index]) ||
        Object.hasOwn(values, args[index]) ||
        !args[index + 1] ||
        args[index + 1].startsWith("--")
      )
        throw new Error("INVALID_ARGUMENTS");
      values[args[index]] = args[index + 1];
    }
    if (!values["--compose"] || !values["--expected-image"])
      throw new Error("INVALID_ARGUMENTS");
    result = checkComposeCutover(await readJson(values["--compose"]), {
      expectedAppImage: values["--expected-image"],
      expectedMigrateImage: values["--expected-migrate-image"],
      expectedCommit: values["--expected-commit"],
      ...(values["--image-inspect"]
        ? { imageInspect: await readJson(values["--image-inspect"]) }
        : {}),
    });
  } catch {
    // JSON parsing and filesystem errors may contain a secret, path or credential.
    result = report([{ service: "input", code: "INPUT_OR_ARGUMENTS_INVALID" }]);
  }
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
