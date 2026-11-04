#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  lstat,
  realpath,
  open,
  readFile,
  rename,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_ORIGIN,
  RTC_ORIGIN,
  RTC_WS_ORIGIN,
  STATE_ROOT,
  SOURCE,
  IMAGE,
  ClientGuardError,
  guard,
  validRunId,
  parseConfig,
  acceptGrant,
  validateAck,
  browserRequestAllowed,
  mediaDeltaValid,
  publishingContinues,
  safeFailure,
} from "./production-media-policy.mjs";
import {
  installMediaProbe,
  collectMediaStats,
  mediaProofIsValid,
} from "./external-media-policy.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const runPath = (id) => path.join(STATE_ROOT, "runs", id);
async function privateDirectory(directory, create = false) {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  guard(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (stat.mode & 0o077) === 0 &&
      stat.uid === process.getuid() &&
      (await realpath(directory)) === directory,
    "UNSAFE_PRIVATE_DIRECTORY",
  );
}
async function readPrivateJSON(filename, limit = 32768) {
  const stat = await lstat(filename);
  guard(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.size <= limit &&
      (stat.mode & 0o077) === 0 &&
      stat.uid === process.getuid(),
    "UNSAFE_PRIVATE_FILE",
  );
  return JSON.parse(await readFile(filename, "utf8"));
}
async function atomicJSON(filename, value) {
  try {
    const stat = await lstat(filename);
    guard(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        (stat.mode & 0o077) === 0 &&
        stat.uid === process.getuid(),
      "UNSAFE_OUTPUT_FILE",
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temp = filename + ".tmp-" + randomBytes(6).toString("hex");
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, filename);
}
export async function acknowledge(runId, action) {
  guard(
    validRunId(runId) && ["kick", "ban", "close"].includes(action),
    "INVALID_ACK_ARGUMENT",
  );
  const directory = runPath(runId);
  await privateDirectory(directory);
  const status = await readPrivateJSON(path.join(directory, "status.json"));
  guard(
    status.phase === "awaiting_" + action &&
      status.awaitingAction === action &&
      Date.parse(status.deadlineAt) > Date.now(),
    "OWNER_ACTION_NOT_AWAITED",
  );
  const ack = {
    runId,
    sequence: status.sequence,
    action,
    nonce: status.actionNonce,
  };
  validateAck(ack, status);
  try {
    await lstat(path.join(directory, "control.json"));
    throw new ClientGuardError("ACK_ALREADY_EXISTS");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await atomicJSON(path.join(directory, "control.json"), ack);
  console.log(JSON.stringify({ ownerActionAcknowledged: action, runId }));
}

export async function closeBrowserBounded(browser, contexts, budget = 8000) {
  // A hung context must never postpone the separate browser shutdown attempt.
  void Promise.allSettled(
    contexts.map((context) => Promise.resolve().then(() => context.close())),
  );
  if (!browser) return true;
  let timer;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => browser.close())
        .then(() => !browser.isConnected())
        .catch(() => false),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), budget);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Serialized into real HTTPS application pages; never uses a test data URL.
async function collectPublishingStats() {
  const peers = window.__imonRTCPeers || [];
  const result = {
    connectedPeers: 0,
    connectedPeerIndices: [],
    peerConnectionsCreated: peers.length,
    outboundAudioBytes: 0,
    outboundVideoFrames: 0,
  };
  for (const [index, peer] of peers.entries()) {
    if (peer.connectionState !== "connected") continue;
    result.connectedPeers++;
    result.connectedPeerIndices.push(index);
    const reports = await peer.getStats();
    for (const item of reports.values()) {
      if (item.type !== "outbound-rtp") continue;
      if (item.kind === "audio")
        result.outboundAudioBytes += item.bytesSent || 0;
      if (item.kind === "video")
        result.outboundVideoFrames += item.framesEncoded || 0;
    }
  }
  return result;
}

async function runClient(config) {
  await privateDirectory(STATE_ROOT, true);
  await privateDirectory(path.join(STATE_ROOT, "runs"), true);
  const directory = runPath(config.runId);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch {
    throw new ClientGuardError("RUN_DIRECTORY_REUSE_REFUSED");
  }
  await privateDirectory(directory);
  const statusPath = path.join(directory, "status.json");
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + config.deadlineMs;
  const names = { A: "IMON A " + config.runId, B: "IMON B " + config.runId };
  const evidence = {
    baselineMedia: null,
    kick: null,
    rejoin: null,
    ban: null,
    roomClose: null,
  };
  let sequence = 0,
    finished = false,
    expired = false,
    interrupted = false;
  let phase = "starting",
    browser,
    resultStatus = "FAIL",
    failure;
  let blockedMutations = 0,
    blockedExternalRequests = 0;
  const contexts = [];
  const remaining = (maximum = 15000) => {
    guard(
      !finished && !expired && !interrupted && Date.now() < deadline,
      "DEADLINE_OR_INTERRUPT",
    );
    return Math.max(1, Math.min(maximum, deadline - Date.now()));
  };
  const baseStatus = () => ({
    schema: 1,
    runId: config.runId,
    mode: config.mode,
    startedAt,
    deadlineAt: new Date(deadline).toISOString(),
    expectedApplicationSource: SOURCE,
    expectedApplicationImage: IMAGE,
    deploymentIdentityProvidedByCoordinator: true,
    clientScope:
      "same-host production ingress; not external NAT or TURN acceptance",
    roomUrlSha256: sha(config.roomURL),
    names,
    tokensPersisted: false,
    cookiesPersisted: false,
  });
  async function checkpoint(next, extra = {}) {
    remaining();
    phase = next;
    const value = {
      ...baseStatus(),
      sequence: ++sequence,
      phase,
      checkedAt: new Date().toISOString(),
      ...extra,
    };
    await atomicJSON(
      path.join(
        directory,
        String(sequence).padStart(3, "0") + "-" + next + ".json",
      ),
      value,
    );
    await atomicJSON(statusPath, value);
    console.log(JSON.stringify({ runId: config.runId, phase, statusPath }));
    return value;
  }
  async function until(test, code, budget = 15000) {
    const end = Date.now() + remaining(budget);
    while (Date.now() < end) {
      remaining();
      if (await test()) return;
      await sleep(200);
    }
    throw new ClientGuardError(code);
  }
  const media = (guest) =>
    guest.page.evaluate(collectMediaStats, { allowedTurnUrls: [] });
  const publishing = (guest) => guest.page.evaluate(collectPublishingStats);
  async function connected(guest) {
    const stats = await publishing(guest);
    return stats.connectedPeers > 0;
  }
  async function requireInnocent(guest) {
    guard(await connected(guest), "INNOCENT_PEER_DISCONNECTED");
  }
  async function ownerAction(action, innocent) {
    const state = await checkpoint("awaiting_" + action, {
      awaitingAction: action,
      actionNonce: randomBytes(12).toString("hex"),
      ownerInstruction:
        action === "close"
          ? "Close this test meeting for everyone, then acknowledge close."
          : "Use the organizer UI to " +
            action +
            " exactly " +
            names.B +
            ", then acknowledge " +
            action +
            ".",
      targetDisplayName: action === "close" ? undefined : names.B,
    });
    const end = Date.now() + remaining(45000);
    while (Date.now() < end) {
      remaining();
      try {
        const ack = await readPrivateJSON(
          path.join(directory, "control.json"),
          2048,
        );
        validateAck(ack, state);
        await rename(
          path.join(directory, "control.json"),
          path.join(
            directory,
            String(state.sequence).padStart(3, "0") +
              "-" +
              action +
              "-ack.json",
          ),
        );
        await checkpoint("observing_" + action);
        return;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      // Close may already have disconnected A before the coordinator writes ACK.
      if (action !== "close") await requireInnocent(innocent);
      await sleep(200);
    }
    throw new ClientGuardError("OWNER_ACK_TIMEOUT");
  }
  async function join(guest) {
    remaining();
    await guest.page.goto(config.roomURL, {
      waitUntil: "domcontentloaded",
      timeout: remaining(20000),
    });
    guard(
      new URL(guest.page.url()).href === config.roomURL,
      "UNEXPECTED_PAGE_REDIRECT",
    );
    await guest.page
      .getByPlaceholder("Ваше имя", { exact: true })
      .fill(names[guest.slot], { timeout: remaining(10000) });
    const [response] = await Promise.all([
      guest.page.waitForResponse(
        (r) => {
          try {
            const u = new URL(r.url());
            return (
              u.origin === APP_ORIGIN &&
              u.pathname === config.joinPath &&
              r.request().method() === "POST"
            );
          } catch {
            return false;
          }
        },
        { timeout: remaining(15000) },
      ),
      guest.page
        .getByRole("button", { name: "Присоединиться к встрече", exact: true })
        .click({ timeout: remaining(10000) }),
    ]);
    guard(response.status() === 200, "GUEST_JOIN_NOT_ACCEPTED");
    guest.grant = acceptGrant(await response.json());
    await until(
      async () => mediaProofIsValid(await media(guest), false),
      "REAL_MEDIA_NOT_ESTABLISHED",
      35000,
    );
  }
  async function makeGuest(slot) {
    const context = await browser.newContext({
      permissions: ["camera", "microphone"],
      viewport: { width: 1280, height: 800 },
      acceptDownloads: false,
      serviceWorkers: "block",
    });
    contexts.push(context);
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (
        browserRequestAllowed(request.url(), request.method(), config.joinPath)
      )
        return route.continue();
      if (["GET", "HEAD"].includes(request.method())) blockedExternalRequests++;
      else blockedMutations++;
      return route.abort();
    });
    await context.addInitScript(installMediaProbe, {
      relayOnly: false,
      allowedTurnUrls: [],
    });
    await context.addInitScript(() => {
      if (!navigator.mediaDevices?.getUserMedia) return;
      const original = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      navigator.mediaDevices.getUserMedia = (constraints) =>
        original({
          ...constraints,
          ...(constraints?.video
            ? {
                video: {
                  ...(typeof constraints.video === "object"
                    ? constraints.video
                    : {}),
                  width: { ideal: 640, max: 640 },
                  height: { ideal: 360, max: 360 },
                  frameRate: { ideal: 15, max: 15 },
                },
              }
            : {}),
        });
    });
    return { slot, context, page: await context.newPage(), grant: undefined };
  }
  async function sampleBoth(a, b, duration = config.sampleMs) {
    await until(
      async () =>
        (await Promise.all([media(a), media(b)])).every((s) =>
          mediaProofIsValid(s, false),
        ),
      "BOTH_MEDIA_PEERS_REQUIRED",
      35000,
    );
    for (const guest of [a, b]) {
      const tiles = await guest.page.locator(".lk-participant-tile").count();
      guard(tiles >= 2 && tiles <= 3, "UNEXPECTED_PARTICIPANT_COUNT");
    }
    const before = await Promise.all([media(a), media(b)]);
    const stop = Date.now() + remaining(duration);
    while (Date.now() < stop) {
      await sleep(200);
      remaining();
      await requireInnocent(a);
      await requireInnocent(b);
    }
    const after = await Promise.all([media(a), media(b)]);
    guard(
      after.every(
        (value, i) =>
          mediaDeltaValid(before[i], value) && mediaProofIsValid(value, false),
      ),
      "DECODED_AUDIO_VIDEO_DID_NOT_ADVANCE",
    );
    return {
      sampleMilliseconds: duration,
      bothDecodedAudioVideo: true,
      stats: after,
    };
  }
  async function rejectCapturedToken(guest, grant) {
    guard(
      grant.expiresAt > Date.now() / 1000 + 5,
      "TOKEN_EXPIRED_BEFORE_REVOCATION_CHECK",
    );
    const routes = ["/rtc", "/rtc/validate", "/rtc/v1", "/rtc/v1/validate"];
    const codes = await Promise.all(
      routes.map(async (route) => {
        const response = await guest.context.request.get(RTC_ORIGIN + route, {
          headers: {
            Authorization: "Bearer " + grant.token,
            Origin: APP_ORIGIN,
          },
          maxRedirects: 0,
          timeout: remaining(5000),
        });
        const code = response.status();
        await response.dispose();
        return code;
      }),
    );
    guard(
      codes.every((code) => code === 403),
      "REVOKED_TOKEN_NOT_DENIED_ON_ALL_ROUTES",
    );
    const socketResults = await guest.page.evaluate(
      async ({ origin, token }) => {
        return Promise.all(
          ["/rtc", "/rtc/v1"].map(
            (route) =>
              new Promise((resolve) => {
                let opened = false,
                  settled = false,
                  socket;
                const done = (timedOut) => {
                  if (settled) return;
                  settled = true;
                  clearTimeout(timer);
                  try {
                    socket?.close();
                  } catch {}
                  resolve({ opened, timedOut });
                };
                const timer = setTimeout(() => done(true), 3000);
                try {
                  socket = new WebSocket(
                    origin +
                      route +
                      "?access_token=" +
                      encodeURIComponent(token),
                  );
                  socket.onopen = () => {
                    opened = true;
                    done(false);
                  };
                  socket.onerror = () => done(false);
                  socket.onclose = () => done(false);
                } catch {
                  done(false);
                }
              }),
          ),
        );
      },
      { origin: RTC_WS_ORIGIN, token: grant.token },
    );
    guard(
      socketResults.every((value) => !value.opened && !value.timedOut),
      "REVOKED_WEBSOCKET_HANDSHAKE_NOT_REJECTED",
    );
    return {
      routes: routes.map((route, i) => ({ route, status: codes[i] })),
      rawWebSocketHandshakesRejected: true,
      productionTokenSignedByRunner: false,
    };
  }
  async function joinStatus(guest) {
    const response = await guest.context.request.post(
      APP_ORIGIN + config.joinPath,
      {
        data: { name: names[guest.slot] },
        headers: { Origin: APP_ORIGIN },
        maxRedirects: 0,
        timeout: remaining(5000),
      },
    );
    const status = response.status();
    let errorCode;
    try {
      errorCode = (await response.json())?.error?.code;
    } catch {}
    await response.dispose();
    return { status, errorCode };
  }
  let timer;
  const interruptedHandler = () => {
    interrupted = true;
    void browser?.close().catch(() => {});
  };
  process.once("SIGTERM", interruptedHandler);
  process.once("SIGINT", interruptedHandler);
  try {
    const scenario = async () => {
      await checkpoint("starting");
      const { chromium } = await import("@playwright/test");
      browser = await chromium.launch({
        executablePath: config.executablePath,
        headless: true,
        timeout: remaining(20000),
        args: [
          "--use-fake-ui-for-media-stream",
          "--use-fake-device-for-media-stream",
          "--disable-background-timer-throttling",
          "--disable-renderer-backgrounding",
        ],
      });
      const [a, b] = await Promise.all([makeGuest("A"), makeGuest("B")]);
      await checkpoint("joining_synthetic_guests");
      await Promise.all([join(a), join(b)]);
      guard(
        a.grant.identity !== b.grant.identity &&
          a.grant.roomName === b.grant.roomName,
        "GUEST_SCOPE_MISMATCH",
      );
      evidence.baselineMedia = await sampleBoth(a, b);
      guard(blockedMutations === 0, "UNEXPECTED_APP_MUTATION_BLOCKED");
      await checkpoint("two_peer_media_pass", { mediaAccepted: true });
      if (config.mode === "smoke") return;
      const originalB = b.grant;
      const originalAConnections = await publishing(a);
      await ownerAction("kick", a);
      await until(
        async () => !(await connected(b)),
        "KICK_DID_NOT_DISCONNECT_TARGET",
      );
      await requireInnocent(a);
      const kickRejection = await rejectCapturedToken(b, originalB);
      await join(b);
      guard(
        b.grant.identity !== originalB.identity,
        "KICK_REJOIN_REUSED_IDENTITY",
      );
      // Adaptive video may pause when B is absent. Require A to publish again
      // over its existing connection once B can subscribe, without rejoining A.
      const beforeA = await publishing(a);
      evidence.rejoin = {
        newIdentity: true,
        media: await sampleBoth(a, b, 3000),
      };
      const afterA = await publishing(a);
      guard(
        originalAConnections.peerConnectionsCreated ===
          afterA.peerConnectionsCreated &&
          JSON.stringify(originalAConnections.connectedPeerIndices) ===
            JSON.stringify(afterA.connectedPeerIndices),
        "INNOCENT_PEER_CONNECTION_REPLACED",
      );
      guard(
        publishingContinues(beforeA, afterA),
        "INNOCENT_PUBLISHING_DID_NOT_ADVANCE",
      );
      evidence.kick = {
        targetDisconnected: true,
        innocentConnectionPreserved: true,
        innocentPublishedAudioVideoWithRejoinedSubscriber: true,
        publishingSampleMilliseconds: 3000,
        ...kickRejection,
      };
      await checkpoint("kick_pass");
      const bannedB = b.grant;
      await ownerAction("ban", a);
      await until(
        async () => !(await connected(b)),
        "BAN_DID_NOT_DISCONNECT_TARGET",
      );
      await requireInnocent(a);
      const banRejection = await rejectCapturedToken(b, bannedB);
      const retry = await joinStatus(b);
      guard(
        retry.status === 403 && retry.errorCode === "PARTICIPANT_BLOCKED",
        "BANNED_BROWSER_REJOIN_NOT_BLOCKED",
      );
      evidence.ban = {
        targetDisconnected: true,
        innocentConnected: true,
        sameBrowserRejoinBlocked: true,
        ...banRejection,
      };
      await checkpoint("ban_pass");
      await ownerAction("close", a);
      await until(
        async () => !(await connected(a)),
        "ROOM_CLOSE_DID_NOT_DISCONNECT_INNOCENT",
      );
      const closed = await joinStatus(a);
      guard(
        closed.status === 409 && closed.errorCode === "ROOM_CLOSED",
        "ROOM_NOT_CLOSED_FOR_NEW_GRANTS",
      );
      evidence.roomClose = {
        remainingGuestDisconnected: true,
        newJoinRejectedAsClosed: true,
      };
      await checkpoint("room_close_pass");
    };
    await Promise.race([
      scenario(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          void browser?.close().catch(() => {});
          reject(new ClientGuardError("DEADLINE_EXCEEDED"));
        }, config.deadlineMs);
      }),
    ]);
    guard(blockedMutations === 0, "UNEXPECTED_APP_MUTATION_BLOCKED");
    resultStatus = "PASS";
  } catch (error) {
    failure = expired
      ? "DEADLINE_EXCEEDED"
      : interrupted
        ? "INTERRUPTED"
        : safeFailure(error);
  } finally {
    finished = true;
    clearTimeout(timer);
    process.removeListener("SIGTERM", interruptedHandler);
    process.removeListener("SIGINT", interruptedHandler);
    const cleanupComplete = await closeBrowserBounded(browser, contexts);
    if (!cleanupComplete) {
      resultStatus = "FAIL";
      failure ||= "BROWSER_CLEANUP_INCOMPLETE";
    }
    const receipt = {
      ...baseStatus(),
      sequence: ++sequence,
      phase: resultStatus === "PASS" ? "finished" : "failed",
      status: resultStatus,
      failedStage: failure ? phase : undefined,
      failureCode: failure,
      finishedAt: new Date().toISOString(),
      evidence,
      cleanupComplete,
      ownerMustCloseRoom: !evidence.roomClose,
      blockedMutations,
      blockedExternalRequests,
      mailSent: false,
      chatSent: false,
      recordingStarted: false,
      databaseAccessed: false,
      productionApiStopped: false,
      privilegedCredentialsUsed: false,
      tracesScreenshotsOrStorageStateWritten: false,
      runnerSha256: sha(await readFile(fileURLToPath(import.meta.url))),
    };
    await atomicJSON(path.join(directory, "result.json"), receipt);
    await atomicJSON(statusPath, receipt);
    console.log(
      JSON.stringify({
        runId: config.runId,
        status: resultStatus,
        failureCode: failure,
        resultPath: path.join(directory, "result.json"),
        cleanupComplete,
      }),
    );
  }
  return resultStatus === "PASS" ? 0 : 1;
}

async function main() {
  if (
    process.argv.length === 6 &&
    process.argv[2] === "--ack" &&
    process.argv[4] === "--run-id"
  ) {
    await acknowledge(process.argv[5], process.argv[3]);
    return 0;
  }
  guard(
    process.argv.length === 3 && process.argv[2] === "--run",
    "EXPLICIT_RUN_OR_ACK_REQUIRED",
  );
  return runClient(parseConfig(process.env));
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.log(
      JSON.stringify({ status: "REFUSED", failureCode: safeFailure(error) }),
    );
    process.exitCode = 1;
  }
}
