// Pure guards for a client-only production smoke. No network or file access.
export const APP_ORIGIN = "https://meets.imon.world";
export const RTC_ORIGIN = "https://meets-rtc.imon.world";
export const RTC_WS_ORIGIN = "wss://meets-rtc.imon.world";
export const STATE_ROOT =
  "/home/sergey/.local/state/imonmeets-production-media-20261104";
export const SOURCE = "17147a6203814b5ea81de3eea547452496b2a6eb";
export const IMAGE =
  "sha256:5aac16d52549090301e8bc22d2fd423fd33dea986b5796e838680e5817bf2c29";

export class ClientGuardError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
export function guard(ok, code) {
  if (!ok) throw new ClientGuardError(code);
}
export function validRunId(id) {
  return typeof id === "string" && /^[a-z0-9][a-z0-9_-]{7,47}$/.test(id);
}
export function parseConfig(env) {
  guard(validRunId(env.MEDIA_TEST_RUN_ID), "INVALID_RUN_ID");
  let room;
  try {
    room = new URL(env.MEDIA_TEST_ROOM_URL);
  } catch {}
  guard(
    room &&
      room.origin === APP_ORIGIN &&
      !room.username &&
      !room.password &&
      !room.search &&
      !room.hash &&
      /^\/join\/[A-Za-z0-9_-]{3,120}$/.test(room.pathname),
    "EXACT_DISPOSABLE_HTTPS_ROOM_REQUIRED",
  );
  const mode = env.MEDIA_TEST_MODE || "smoke";
  guard(["smoke", "moderation"].includes(mode), "INVALID_MODE");
  for (const key of [
    "DATABASE_URL",
    "TEST_DATABASE_URL",
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
    "DELETION_JOURNAL_KEY",
    "DELETION_WITNESS_TOKEN",
    "BETTER_AUTH_SECRET",
    "GOOGLE_CLIENT_SECRET",
    "SMTP_PASS",
  ]) {
    guard(!env[key], "PRIVILEGED_ENV_REFUSED");
  }
  const executablePath =
    env.PLAYWRIGHT_EXECUTABLE_PATH || "/usr/bin/google-chrome";
  guard(
    executablePath.startsWith("/") && !executablePath.includes("\0"),
    "INVALID_BROWSER_PATH",
  );
  return {
    runId: env.MEDIA_TEST_RUN_ID,
    roomURL: room.href,
    joinPath: "/api/rooms/" + room.pathname.slice("/join/".length) + "/join",
    mode,
    executablePath,
    deadlineMs: mode === "smoke" ? 90000 : 180000,
    sampleMs: 10000,
  };
}
export function acceptGrant(value, nowSeconds = Date.now() / 1000) {
  guard(
    value &&
      value.status === "joined" &&
      value.canManage === false &&
      typeof value.identity === "string" &&
      value.identity.startsWith("guest:") &&
      typeof value.roomName === "string" &&
      value.roomName.length <= 160 &&
      value.serverUrl === RTC_WS_ORIGIN &&
      typeof value.token === "string" &&
      value.token.length <= 8192 &&
      /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.token),
    "UNEXPECTED_GUEST_GRANT",
  );
  let claims;
  try {
    claims = JSON.parse(
      Buffer.from(value.token.split(".")[1], "base64url").toString("utf8"),
    );
  } catch {}
  guard(
    claims &&
      claims.sub === value.identity &&
      claims.video?.room === value.roomName &&
      Number.isFinite(claims.exp) &&
      claims.exp - nowSeconds >= 60,
    "INVALID_OR_EXPIRING_GUEST_GRANT",
  );
  // Signature verification is the real server/ingress responsibility; never forge a token.
  return {
    token: value.token,
    identity: value.identity,
    roomName: value.roomName,
    expiresAt: claims.exp,
  };
}
export function validateAck(value, status) {
  guard(
    value &&
      Object.keys(value).sort().join(",") === "action,nonce,runId,sequence" &&
      value.runId === status.runId &&
      value.sequence === status.sequence &&
      value.action === status.awaitingAction &&
      value.nonce === status.actionNonce &&
      ["kick", "ban", "close"].includes(value.action),
    "STALE_OR_WRONG_OWNER_ACK",
  );
  return value;
}
export function browserRequestAllowed(urlValue, method, joinPath) {
  let url;
  try {
    url = new URL(urlValue);
  } catch {
    return false;
  }
  if (![APP_ORIGIN, RTC_ORIGIN].includes(url.origin)) return false;
  if (["GET", "HEAD"].includes(method)) return true;
  return (
    url.origin === APP_ORIGIN &&
    url.pathname === joinPath &&
    !url.search &&
    method === "POST"
  );
}
export function mediaDeltaValid(before, after) {
  return (
    before &&
    after &&
    after.connectedPeers > 0 &&
    after.audioBytes > before.audioBytes &&
    after.videoFrames > before.videoFrames
  );
}
export function publishingContinues(before, after) {
  return (
    before &&
    after &&
    after.connectedPeers > 0 &&
    after.outboundAudioBytes > before.outboundAudioBytes &&
    after.outboundVideoFrames > before.outboundVideoFrames
  );
}
export function safeFailure(error) {
  return error instanceof ClientGuardError &&
    /^[A-Z0-9_]{1,80}$/.test(error.code)
    ? error.code
    : "UNEXPECTED_CLIENT_ERROR";
}
