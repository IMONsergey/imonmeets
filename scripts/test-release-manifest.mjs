import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createManifest,
  validateReleaseIdentity,
} from "./create-release-manifest.mjs";

const commit = "a".repeat(40);
const imageInfo = {
  id: `sha256:${"b".repeat(64)}`,
  revision: commit,
  created: "2026-11-03T06:00:00Z",
};
test("release identity rejects dirty source, mismatched image revision and ambiguous tags", () => {
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
test("manifest binds migration bytes and capability hashes, excludes secrets and never claims deployment", async () => {
  const source = await mkdtemp(path.join(tmpdir(), "imon-manifest-"));
  try {
    await mkdir(path.join(source, "apps/api/src"), { recursive: true });
    await writeFile(path.join(source, "apps/api/src/db.ts"), "migration-one");
    await writeFile(
      path.join(source, "apps/api/src/auth.ts"),
      "not-a-migration",
    );
    const manifest = await createManifest({
      source,
      commit,
      dirty: "",
      imageInfo,
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
    assert.deepEqual(Object.keys(manifest.migrationSourceSha256), ["db.ts"]);
    assert.equal(JSON.stringify(manifest).includes("private-"), false);
    await writeFile(path.join(source, "apps/api/src/db.ts"), "migration-two");
    const changed = await createManifest({
      source,
      commit,
      dirty: "",
      imageInfo,
      env: { RELEASE_COMMIT: commit, RELEASE_IMAGE_DIGEST: imageInfo.id },
    });
    assert.notEqual(
      manifest.migrationSourceSha256["db.ts"],
      changed.migrationSourceSha256["db.ts"],
    );
    assert.equal(changed.environmentIdentityMatches, true);
  } finally {
    await rm(source, { recursive: true });
  }
});
