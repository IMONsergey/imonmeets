import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  chmod,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILD_ONLY_ACCEPTANCE,
  createManifest,
  gitArchiveSha256,
  readBuildReceipt,
  validateBuildReceipt,
  validateReleaseIdentity,
} from "./create-release-manifest.mjs";

const commit = "a".repeat(40);
const sourceArchiveSha256 = "d".repeat(64);
const now = "2026-11-03T07:00:00Z";
const imageInfo = {
  id: "sha256:" + "b".repeat(64),
  revision: commit,
  created: "2026-11-03T06:00:00Z",
};
const limits = {
  CpuPeriod: 100000,
  CpuQuota: 100000,
  Memory: 2147483648,
  MemorySwap: 2147483648,
};
function receipt() {
  return {
    schema: 1,
    startedAt: "2026-11-03T05:59:00Z",
    completedAt: "2026-11-03T06:02:00Z",
    sourceCommit: commit,
    sourceArchiveSha256,
    imageId: imageInfo.id,
    imageTag: "imonmeets:release-test",
    imageCreatedAt: imageInfo.created,
    builder: "docker legacy; observed RUN limits",
    observedRunStepLimits: { ["c".repeat(64)]: { ...limits } },
    productionChanges: false,
    deployed: false,
    acceptance: BUILD_ONLY_ACCEPTANCE,
  };
}
const context = { commit, imageInfo, sourceArchiveSha256, now };

test("release identity rejects dirty source, mismatched revision and mutable image tags", () => {
  assert.throws(() =>
    validateReleaseIdentity(commit, " M apps/api/src/app.ts", imageInfo),
  );
  assert.throws(() =>
    validateReleaseIdentity(commit, "", {
      ...imageInfo,
      revision: "c".repeat(40),
    }),
  );
  assert.throws(() =>
    validateReleaseIdentity(commit, "", { ...imageInfo, id: "app:latest" }),
  );
  assert.equal(
    validateReleaseIdentity(commit, "", imageInfo).imageId,
    imageInfo.id,
  );
});

test("matching local build receipt copies only known fields", () => {
  const supplied = { ...receipt(), localSecret: "private-build-secret" };
  const verified = validateBuildReceipt(supplied, context);
  assert.equal(verified.sourceArchiveSha256, sourceArchiveSha256);
  assert.equal(verified.imageId, imageInfo.id);
  assert.equal(verified.deployed, false);
  assert.equal(
    JSON.stringify(verified).includes("private-build-secret"),
    false,
  );
});

test("a revision label alone cannot replace the exact commit, archive and image receipt", () => {
  for (const invalid of [
    undefined,
    null,
    {},
    { ...receipt(), schema: 2 },
    { ...receipt(), sourceCommit: "e".repeat(40) },
    { ...receipt(), sourceArchiveSha256: "e".repeat(64) },
    { ...receipt(), imageId: "sha256:" + "e".repeat(64) },
    { ...receipt(), imageCreatedAt: "2026-11-03T05:00:00Z" },
    { ...receipt(), deployed: true },
    { ...receipt(), productionChanges: true },
    { ...receipt(), acceptance: "accepted" },
    { ...receipt(), builder: "" },
  ])
    assert.throws(() => validateBuildReceipt(invalid, context));
});

test("receipt timestamps must be valid, ordered and no later than now", () => {
  for (const invalid of [
    { ...receipt(), startedAt: "2026-11-03T06:03:00Z" },
    { ...receipt(), completedAt: "2026-11-03T07:00:01Z" },
    { ...receipt(), startedAt: "2026-02-30T00:00:00Z" },
    { ...receipt(), completedAt: "not-an-instant" },
    { ...receipt(), startedAt: "2026-11-03" },
  ])
    assert.throws(() => validateBuildReceipt(invalid, context));
  // Cached images can predate this bounded build; that does not invalidate identity.
  assert.doesNotThrow(() =>
    validateBuildReceipt(
      {
        ...receipt(),
        startedAt: "2026-11-03T06:01:00+00:00",
      },
      context,
    ),
  );
});

test("all recorded RUN observations must carry the exact CPU and memory limits", () => {
  assert.throws(() =>
    validateBuildReceipt({ ...receipt(), observedRunStepLimits: {} }, context),
  );
  for (const key of Object.keys(limits)) {
    const bad = receipt();
    bad.observedRunStepLimits["c".repeat(64)][key] = 0;
    assert.throws(() => validateBuildReceipt(bad, context));
  }
  const extraBad = receipt();
  extraBad.observedRunStepLimits["e".repeat(64)] = {
    ...limits,
    Memory: 4294967296,
  };
  assert.throws(() => validateBuildReceipt(extraBad, context));
});

test("receipt loader rejects symlink, directory, nonprivate mode, malformed and oversized JSON", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "imon-build-receipt-"));
  const file = path.join(directory, "receipt.json");
  try {
    await writeFile(file, JSON.stringify(receipt()), { mode: 0o600 });
    assert.equal((await readBuildReceipt(file)).imageId, imageInfo.id);
    const link = path.join(directory, "linked.json");
    await symlink(file, link);
    await assert.rejects(readBuildReceipt(link));
    await assert.rejects(readBuildReceipt(directory));
    await chmod(file, 0o644);
    await assert.rejects(readBuildReceipt(file));
    await chmod(file, 0o600);
    await writeFile(file, "{broken");
    await assert.rejects(readBuildReceipt(file));
    await writeFile(file, Buffer.alloc(128 * 1024 + 1, 32));
    await assert.rejects(readBuildReceipt(file));
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("fresh archive hash comes from the immutable Git commit and enforces a byte ceiling", async () => {
  const source = await mkdtemp(path.join(tmpdir(), "imon-archive-"));
  const git = (args) =>
    execFileSync("git", args, {
      cwd: source,
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    git(["init", "-q"]);
    await writeFile(
      path.join(source, "source.txt"),
      "committed build source\n",
    );
    git(["add", "source.txt"]);
    git([
      "-c",
      "user.name=Release Test",
      "-c",
      "user.email=release-test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-qm",
      "fixture",
    ]);
    const pinned = git(["rev-parse", "HEAD"]).toString("utf8").trim();
    const expected = createHash("sha256")
      .update(git(["archive", "--format=tar", pinned]))
      .digest("hex");
    assert.equal(await gitArchiveSha256(source, pinned), expected);
    await writeFile(
      path.join(source, "source.txt"),
      "uncommitted replacement\n",
    );
    assert.equal(await gitArchiveSha256(source, pinned), expected);
    await assert.rejects(gitArchiveSha256(source, pinned, { maxBytes: 1024 }));
  } finally {
    await rm(source, { recursive: true });
  }
});

test("manifest binds source archive and migration bytes without exposing secrets or accepting deployment", async () => {
  const source = await mkdtemp(path.join(tmpdir(), "imon-manifest-"));
  try {
    await mkdir(path.join(source, "apps/api/src"), { recursive: true });
    await writeFile(path.join(source, "apps/api/src/db.ts"), "migration-one");
    await writeFile(
      path.join(source, "apps/api/src/auth.ts"),
      "not-a-migration",
    );
    const base = {
      source,
      commit,
      dirty: "",
      imageInfo,
      buildReceipt: receipt(),
      sourceArchiveSha256,
      now,
    };
    const manifest = await createManifest({
      ...base,
      env: {
        APP_URL: "https://meet.example.test",
        DATABASE_URL: "private-database-secret",
        SMTP_PASSWORD: "private-email-secret",
        EMAIL_PROVIDER: "resend",
        RESEND_API_KEY: "private-provider-secret",
      },
    });
    assert.equal(manifest.environmentIdentityMatches, false);
    assert.equal(manifest.deployed, false);
    assert.equal(manifest.acceptance, "not-evaluated");
    assert.equal(manifest.sourceArchiveSha256, sourceArchiveSha256);
    assert.match(
      manifest.buildReceiptTrust,
      /not a cryptographic external attestation/,
    );
    assert.deepEqual(Object.keys(manifest.migrationSourceSha256), ["db.ts"]);
    assert.equal(JSON.stringify(manifest).includes("private-"), false);
    await writeFile(path.join(source, "apps/api/src/db.ts"), "migration-two");
    const changed = await createManifest({
      ...base,
      env: { RELEASE_COMMIT: commit, RELEASE_IMAGE_DIGEST: imageInfo.id },
    });
    assert.notEqual(
      manifest.migrationSourceSha256["db.ts"],
      changed.migrationSourceSha256["db.ts"],
    );
    assert.equal(changed.environmentIdentityMatches, true);
    await assert.rejects(createManifest({ ...base, buildReceipt: undefined }));
  } finally {
    await rm(source, { recursive: true });
  }
});

test("CLI fails closed without --build-receipt before any Docker operation", () => {
  const script = fileURLToPath(
    new URL("./create-release-manifest.mjs", import.meta.url),
  );
  const result = spawnSync(
    process.execPath,
    [
      script,
      "--image",
      "imonmeets:release-test",
      "--env",
      "private-missing-env",
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RELEASE_MANIFEST_NOT_CREATED/);
  assert.equal(result.stderr.includes("private-missing-env"), false);
});

const bridgeTests = fileURLToPath(
  new URL("./test-containerd-image-identity.py", import.meta.url),
);
const pythonOptions = {
  encoding: "utf8",
  timeout: 30000,
  maxBuffer: 128 * 1024,
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
};

test("containerd archive verifier refuses broken identity chains offline", () => {
  assert.doesNotThrow(() =>
    execFileSync("python3", [bridgeTests], pythonOptions),
  );
});

test("only a freshly verified archive bridge can connect config and runtime identities", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "imon-containerd-manifest-"),
  );
  const candidate = path.join(directory, "candidate");
  const fixture = JSON.parse(
    execFileSync("python3", [bridgeTests, "fixture", candidate], pythonOptions),
  );
  try {
    const source = path.join(directory, "source");
    await mkdir(path.join(source, "apps/api/src"), { recursive: true });
    await writeFile(
      path.join(source, "apps/api/src/db.ts"),
      "fixture-migration",
    );
    const base = {
      source,
      commit: fixture.sourceCommit,
      dirty: "",
      imageInfo: fixture.imageInfo,
      buildReceipt: fixture.buildReceipt,
      buildReceiptSha256: fixture.buildReceiptSha256,
      sourceArchiveSha256: fixture.sourceArchiveSha256,
      now,
    };
    const original = await readFile(path.join(candidate, "build-receipt.json"));
    await assert.rejects(createManifest(base));
    await assert.rejects(
      createManifest({
        ...base,
        imageIdentity: {
          status: "PASS_ARCHIVE_TO_RUNTIME_IDENTITY",
          legacyConfigDigest: fixture.buildReceipt.imageId,
          runtimeManifestDigest: fixture.imageInfo.id,
        },
      }),
    );
    await assert.rejects(
      createManifest({
        ...base,
        candidateTransfer: candidate,
        buildReceiptSha256: "f".repeat(64),
      }),
    );
    await assert.rejects(
      createManifest({
        ...base,
        candidateTransfer: candidate,
        sourceArchiveSha256: "f".repeat(64),
      }),
    );
    const manifest = await createManifest({
      ...base,
      candidateTransfer: candidate,
    });
    assert.equal(manifest.imageId, fixture.imageInfo.id);
    assert.equal(manifest.applicationImage, fixture.imageInfo.id);
    assert.equal(
      manifest.requiredEnvironment.RELEASE_IMAGE_DIGEST,
      fixture.imageInfo.id,
    );
    assert.equal(manifest.buildReceipt.imageId, fixture.buildReceipt.imageId);
    assert.equal(
      manifest.imageIdentity.buildReceiptSha256,
      fixture.buildReceiptSha256,
    );
    assert.equal(manifest.imageIdentity.loadedRootfsMatches, true);
    assert.deepEqual(
      await readFile(path.join(candidate, "build-receipt.json")),
      original,
    );
    assert.equal(manifest.deployed, false);
    assert.equal(manifest.imageIdentity.imageExecuted, false);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("operator CLI binds a separate clean release checkout and live inspect without rebuilding", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "imon-operator-source-"));
  const source = path.join(directory, "source");
  const candidate = path.join(directory, "candidate");
  const fakeBin = path.join(directory, "bin");
  const calls = path.join(directory, "docker-calls");
  const script = fileURLToPath(
    new URL("./create-release-manifest.mjs", import.meta.url),
  );
  const operatorRoot = fileURLToPath(new URL("../", import.meta.url));
  const git = (args) =>
    execFileSync("git", args, {
      cwd: source,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    await mkdir(path.join(source, "apps/api/src"), { recursive: true });
    await mkdir(fakeBin);
    await writeFile(
      path.join(source, "apps/api/src/db.ts"),
      "exact-release-migration\n",
    );
    git(["init", "-q"]);
    git(["add", "apps/api/src/db.ts"]);
    git([
      "-c",
      "user.name=Release Test",
      "-c",
      "user.email=release-test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-qm",
      "release fixture",
    ]);
    const releaseCommit = git(["rev-parse", "HEAD"]);
    const archiveHash = await gitArchiveSha256(source, releaseCommit);
    const fixture = JSON.parse(
      execFileSync(
        "python3",
        [bridgeTests, "fixture", candidate, releaseCommit, archiveHash],
        pythonOptions,
      ),
    );
    const inspected = {
      ...fixture.imageInfo,
      releaseEnv: ["RELEASE_COMMIT=" + releaseCommit],
    };
    await writeFile(
      path.join(fakeBin, "docker"),
      `#!${process.execPath}\nimport fs from "node:fs";\nfs.appendFileSync(${JSON.stringify(calls)}, "inspect\\n");\nprocess.stdout.write(JSON.stringify(${JSON.stringify(inspected)}));\n`,
      { mode: 0o700 },
    );
    const environment = path.join(directory, "environment");
    await writeFile(
      environment,
      `APP_URL=https://meet.example.test\nRELEASE_COMMIT=${releaseCommit}\nRELEASE_IMAGE_DIGEST=${fixture.imageInfo.id}\nSMTP_PASSWORD=private-env-fixture\n`,
      { mode: 0o600 },
    );
    const output = path.join(directory, "manifest.json");
    const args = [
      script,
      "--source",
      source,
      "--image",
      fixture.imageInfo.id,
      "--env",
      environment,
      "--build-receipt",
      path.join(candidate, "build-receipt.json"),
      "--candidate-transfer",
      candidate,
      "--output",
      output,
    ];
    const options = {
      encoding: "utf8",
      timeout: 30000,
      env: {
        ...process.env,
        PATH: fakeBin + path.delimiter + process.env.PATH,
      },
    };
    const success = spawnSync(process.execPath, args, options);
    assert.equal(success.status, 0, success.stderr);
    const manifest = JSON.parse(await readFile(output, "utf8"));
    const operatorCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: operatorRoot,
      encoding: "utf8",
    }).trim();
    assert.equal(manifest.commit, releaseCommit);
    assert.equal(manifest.operatorTooling.commit, operatorCommit);
    assert.notEqual(manifest.commit, manifest.operatorTooling.commit);
    assert.match(
      manifest.operatorTooling.files["create-release-manifest.mjs"],
      /^[a-f0-9]{64}$/,
    );
    assert.match(
      manifest.operatorTooling.files["verify-containerd-image-identity.py"],
      /^[a-f0-9]{64}$/,
    );
    assert.equal(manifest.buildReceipt.imageId, fixture.buildReceipt.imageId);
    assert.equal(manifest.imageId, fixture.imageInfo.id);
    assert.equal(manifest.environmentIdentityMatches, true);
    assert.equal(
      JSON.stringify(manifest).includes("private-env-fixture"),
      false,
    );
    const unrelated = [...args];
    unrelated[unrelated.indexOf("--image") + 1] = "sha256:" + "f".repeat(64);
    const unrelatedResult = spawnSync(process.execPath, unrelated, options);
    assert.equal(unrelatedResult.status, 1);
    assert.match(unrelatedResult.stderr, /RELEASE_MANIFEST_NOT_CREATED/);
    const callsBefore = await readFile(calls, "utf8");
    await writeFile(
      path.join(source, "apps/api/src/db.ts"),
      "dirty-release-migration\n",
    );
    const refused = spawnSync(
      process.execPath,
      args.slice(0, -1).concat(path.join(directory, "refused.json")),
      options,
    );
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /RELEASE_MANIFEST_NOT_CREATED/);
    assert.equal(
      await readFile(calls, "utf8"),
      callsBefore,
      "dirty source must fail before any Docker inspection",
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});
