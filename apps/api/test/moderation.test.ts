import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { mayRemoveParticipant } from "../src/moderation.js";

test("strict moderation requires explicit protected signaling configuration", () => {
  const env = {
    DATABASE_URL: "postgres://test.invalid/test",
    DEV_ALLOW_UNVERIFIED_EMAIL: "true",
    LIVEKIT_URL: "ws://localhost:7880",
    LIVEKIT_API_KEY: "test-key",
    LIVEKIT_API_SECRET: "test-secret-with-at-least-32-characters",
  };
  assert.equal(loadConfig(env).livekit.signalingAuthEnabled, false);
  assert.throws(
    () => loadConfig({ ...env, LIVEKIT_SIGNALING_AUTH_ENABLED: "true" }),
    /LIVEKIT_SIGNALING_AUTH_SECRET/,
  );
  assert.throws(
    () =>
      loadConfig({
        ...env,
        LIVEKIT_SIGNALING_AUTH_ENABLED: "true",
        LIVEKIT_SIGNALING_AUTH_SECRET: "short",
      }),
    /32/,
  );
  assert.throws(
    () =>
      loadConfig({
        ...env,
        LIVEKIT_URL: "",
        LIVEKIT_SIGNALING_AUTH_ENABLED: "true",
        LIVEKIT_SIGNALING_AUTH_SECRET: "x".repeat(32),
      }),
    /media configuration/,
  );
  assert.equal(
    loadConfig({
      ...env,
      LIVEKIT_SIGNALING_AUTH_ENABLED: "true",
      LIVEKIT_SIGNALING_AUTH_SECRET:
        "isolated-signaling-secret-with-32-characters",
    }).livekit.signalingAuthEnabled,
    true,
  );
});

test("room moderators cannot remove themselves or higher workspace authority", () => {
  assert.equal(
    mayRemoveParticipant("owner", "owner", "creator", "owner", "owner"),
    false,
  );
  assert.equal(
    mayRemoveParticipant("admin", "admin", "creator", "owner", "owner"),
    false,
  );
  assert.equal(
    mayRemoveParticipant("admin", "admin", "creator", "other-admin", "admin"),
    false,
  );
  assert.equal(
    mayRemoveParticipant("member", "creator", "creator", "admin", "admin"),
    false,
  );
  assert.equal(
    mayRemoveParticipant("member", "member", "other-creator", null),
    false,
  );
  assert.equal(
    mayRemoveParticipant("member", "creator", "creator", null),
    true,
  );
  assert.equal(
    mayRemoveParticipant("owner", "owner", "creator", "admin", "admin"),
    true,
  );
});
