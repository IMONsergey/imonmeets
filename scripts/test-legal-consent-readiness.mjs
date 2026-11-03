import test from "node:test";
import assert from "node:assert/strict";
import { configurationHash } from "./check-launch-readiness.mjs";

test("release legal acceptance evidence changes with enforcement and exact published manifest", () => {
  const env = {
    APP_URL: "https://example.test",
    PUBLIC_LEGAL_APPROVED: "true",
    PUBLIC_LEGAL_MANIFEST_SHA256: "a".repeat(64),
    SUPPORT_EMAIL: "support@example.test",
    RELEASE_COMMIT: "b".repeat(40),
    RELEASE_IMAGE_DIGEST: "sha256:" + "c".repeat(64),
    LEGAL_ACCEPTANCE_REQUIRED: "false",
  };
  const initial = configurationHash(env, "legal");
  assert.notEqual(
    configurationHash({ ...env, LEGAL_ACCEPTANCE_REQUIRED: "true" }, "legal"),
    initial,
  );
  assert.notEqual(
    configurationHash(
      { ...env, PUBLIC_LEGAL_MANIFEST_SHA256: "d".repeat(64) },
      "legal",
    ),
    initial,
  );
  assert.equal(
    configurationHash(
      { ...env, DELETION_WITNESS_TOKEN: "unrelated-private-test-value" },
      "legal",
    ),
    initial,
  );
});
