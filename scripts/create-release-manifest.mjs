#!/usr/bin/env node
/** Resolve an immutable local image and exact clean source into a reviewable release.
 * No containers are started, no environment is edited and nothing is deployed.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile, mkdir, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { configurationHash } from "./check-launch-readiness.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const capabilities = [
  "legal",
  "media",
  "alerts",
  "email",
  "billing",
  "recording",
  "transcription",
  "summary",
];

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

export async function createManifest({
  source = root,
  imageInfo,
  commit,
  dirty,
  env = {},
  now = new Date().toISOString(),
}) {
  const identity = validateReleaseIdentity(commit, dirty, imageInfo);
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
  const image = option("--image"),
    environment = option("--env");
  if (!image || !/^[a-z0-9][a-z0-9./:@_-]{0,255}$/.test(image) || !environment)
    throw new Error(
      "Usage: node scripts/create-release-manifest.mjs --image IMAGE --env FILE [--output FILE] [--sudo-docker]",
    );
  const info = await lstat(environment);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024)
    throw new Error("Environment file is not a bounded regular file");
  const env = parseEnv(await readFile(environment, "utf8"));
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const commit = git(["rev-parse", "HEAD"]),
    dirty = git(["status", "--porcelain"]);
  const format =
    '{"id":{{json .Id}},"created":{{json .Created}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}}}';
  const dockerArgs = ["image", "inspect", "--format", format, image];
  const imageInfo = JSON.parse(
    execFileSync(
      args.includes("--sudo-docker") ? "sudo" : "docker",
      args.includes("--sudo-docker")
        ? ["-n", "docker", ...dockerArgs]
        : dockerArgs,
      { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
  const manifest = await createManifest({ commit, dirty, imageInfo, env });
  const output = path.resolve(
    option("--output") || path.join(root, "ops-state/release-manifest.json"),
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
      "RELEASE_MANIFEST_NOT_CREATED: check clean source, exact image label, environment file and a new output path.",
    );
    process.exitCode = 1;
  });
}
