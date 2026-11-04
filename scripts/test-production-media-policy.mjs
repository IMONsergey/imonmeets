import test from "node:test";
import assert from "node:assert/strict";
import {
  parseConfig,
  acceptGrant,
  validateAck,
  browserRequestAllowed,
  mediaDeltaValid,
  publishingContinues,
  safeFailure,
  ClientGuardError,
} from "./production-media-policy.mjs";
import { closeBrowserBounded } from "./verify-production-media-client.mjs";
const base = {
  MEDIA_TEST_RUN_ID: "offline-test-1234",
  MEDIA_TEST_ROOM_URL: "https://meets.imon.world/join/disposable123",
};

test("only the explicit canonical disposable HTTPS room is accepted", () => {
  const config = parseConfig(base);
  assert.equal(config.joinPath, "/api/rooms/disposable123/join");
  assert.equal(config.mode, "smoke");
  assert.equal(config.deadlineMs, 90000);
  for (const url of [
    "data:text/html,hello",
    "http://meets.imon.world/join/abc",
    "https://meets.imon.world.evil.test/join/abc",
    "https://user:secret@meets.imon.world/join/abc",
    "https://meets.imon.world/api/rooms",
    "https://meets.imon.world/join/a%2Fb",
    "https://meets.imon.world/join/abc?access_token=secret",
    "https://meets.imon.world/join/abc#secret",
  ]) {
    assert.throws(
      () => parseConfig({ ...base, MEDIA_TEST_ROOM_URL: url }),
      /EXACT_DISPOSABLE_HTTPS_ROOM_REQUIRED/,
    );
  }
});
test("private scope and runtime limits cannot be expanded by environment", () => {
  assert.equal(
    parseConfig({ ...base, MEDIA_TEST_MODE: "moderation" }).deadlineMs,
    180000,
  );
  assert.throws(
    () => parseConfig({ ...base, MEDIA_TEST_RUN_ID: "../../other" }),
    /INVALID_RUN_ID/,
  );
  assert.throws(
    () => parseConfig({ ...base, MEDIA_TEST_MODE: "load" }),
    /INVALID_MODE/,
  );
  for (const key of [
    "DATABASE_URL",
    "TEST_DATABASE_URL",
    "LIVEKIT_API_SECRET",
    "DELETION_JOURNAL_KEY",
  ]) {
    assert.throws(
      () => parseConfig({ ...base, [key]: "never-print-this-secret" }),
      /PRIVILEGED_ENV_REFUSED/,
    );
  }
});
test("browser mutation allowlist admits only the exact normal guest join", () => {
  const join = "/api/rooms/disposable123/join";
  assert.equal(
    browserRequestAllowed("https://meets.imon.world" + join, "POST", join),
    true,
  );
  assert.equal(
    browserRequestAllowed(
      "https://meets.imon.world/assets/app.js",
      "GET",
      join,
    ),
    true,
  );
  for (const [url, method] of [
    ["https://meets.imon.world/api/auth/sign-up/email", "POST"],
    ["https://meets.imon.world/api/workspaces/w/invitations", "POST"],
    ["https://meets.imon.world/api/workspaces/w/rooms/r/recordings", "POST"],
    ["https://meets.imon.world/api/rooms/disposable123/chat", "POST"],
    ["https://meets.imon.world" + join, "DELETE"],
    ["https://meets.imon.world" + join + "?other=1", "POST"],
    ["https://meets.imon.world/api/rooms/foreign/join", "POST"],
    ["https://external.test/notify", "GET"],
  ])
    assert.equal(browserRequestAllowed(url, method, join), false);
});
function grant(overrides = {}, claimsOverrides = {}) {
  const value = {
    status: "joined",
    canManage: false,
    identity: "guest:offline-synthetic",
    roomName: "room-offline",
    serverUrl: "wss://meets-rtc.imon.world",
    ...overrides,
  };
  const claims = {
    sub: value.identity,
    video: { room: value.roomName },
    exp: 1300,
    ...claimsOverrides,
  };
  value.token =
    "header." +
    Buffer.from(JSON.stringify(claims)).toString("base64url") +
    ".signature";
  return value;
}
test("only a normal guest grant for the canonical SFU is retained in memory", () => {
  const accepted = acceptGrant(grant(), 1000);
  assert.deepEqual(Object.keys(accepted).sort(), [
    "expiresAt",
    "identity",
    "roomName",
    "token",
  ]);
  for (const overrides of [
    { canManage: true },
    { identity: "user:owner" },
    { status: "waiting" },
    { serverUrl: "wss://foreign.example" },
  ]) {
    assert.throws(
      () => acceptGrant(grant(overrides), 1000),
      /UNEXPECTED_GUEST_GRANT/,
    );
  }
  assert.throws(
    () => acceptGrant(grant({}, { sub: "guest:other" }), 1000),
    /INVALID_OR_EXPIRING/,
  );
  assert.throws(
    () => acceptGrant(grant({}, { video: { room: "other" } }), 1000),
    /INVALID_OR_EXPIRING/,
  );
  assert.throws(
    () => acceptGrant(grant({}, { exp: 1030 }), 1000),
    /INVALID_OR_EXPIRING/,
  );
});
test("an owner ACK is bound to exactly one run, checkpoint, action and nonce", () => {
  const status = {
    runId: "offline-test-1234",
    sequence: 4,
    awaitingAction: "kick",
    actionNonce: "fresh-nonce",
  };
  const ack = {
    runId: status.runId,
    sequence: 4,
    action: "kick",
    nonce: "fresh-nonce",
  };
  assert.equal(validateAck(ack, status), ack);
  for (const change of [
    { runId: "foreign-run-123" },
    { sequence: 3 },
    { action: "ban" },
    { nonce: "old-nonce" },
    { approved: true },
  ]) {
    assert.throws(
      () => validateAck({ ...ack, ...change }, status),
      /STALE_OR_WRONG_OWNER_ACK/,
    );
  }
});
test("cached packet totals or a disconnected peer cannot masquerade as media progress", () => {
  const before = { connectedPeers: 1, audioBytes: 20, videoFrames: 4 };
  const after = { connectedPeers: 1, audioBytes: 50, videoFrames: 7 };
  assert.equal(mediaDeltaValid(before, after), true);
  assert.equal(mediaDeltaValid(before, before), false);
  assert.equal(mediaDeltaValid(before, { ...after, connectedPeers: 0 }), false);
  assert.equal(mediaDeltaValid(before, { ...after, videoFrames: 4 }), false);
  assert.equal(mediaDeltaValid(before, { ...after, audioBytes: 20 }), false);
  assert.equal(
    publishingContinues(
      { outboundAudioBytes: 20, outboundVideoFrames: 4 },
      { connectedPeers: 1, outboundAudioBytes: 30, outboundVideoFrames: 5 },
    ),
    true,
  );
});
test("raw browser errors, private URLs and tokens are never an output error message", () => {
  assert.equal(
    safeFailure(
      new Error("https://meets.imon.world/join/private?access_token=secret"),
    ),
    "UNEXPECTED_CLIENT_ERROR",
  );
  assert.equal(
    safeFailure(new ClientGuardError("OWNER_ACK_TIMEOUT")),
    "OWNER_ACK_TIMEOUT",
  );
  assert.equal(
    safeFailure(new ClientGuardError("raw token=secret")),
    "UNEXPECTED_CLIENT_ERROR",
  );
});

test("a hung context cannot postpone browser shutdown", async () => {
  let attempted = false;
  const browser = {
    close: async () => {
      attempted = true;
    },
    isConnected: () => false,
  };
  const contexts = [{ close: () => new Promise(() => {}) }];
  assert.equal(await closeBrowserBounded(browser, contexts, 50), true);
  assert.equal(attempted, true);
});
test("failed or timed-out browser shutdown cannot report cleanup success", async () => {
  assert.equal(
    await closeBrowserBounded(
      {
        close: async () => {
          throw new Error("private browser detail");
        },
        isConnected: () => false,
      },
      [],
      10,
    ),
    false,
  );
  assert.equal(
    await closeBrowserBounded(
      {
        close: () => new Promise(() => {}),
        isConnected: () => true,
      },
      [],
      10,
    ),
    false,
  );
  assert.equal(
    await closeBrowserBounded(
      {
        close: async () => {},
        isConnected: () => true,
      },
      [],
      10,
    ),
    false,
  );
});
