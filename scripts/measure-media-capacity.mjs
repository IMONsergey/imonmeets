#!/usr/bin/env node
// A bounded browser/SFU smoke load, not a capacity certification.
// Use a disposable guest room with waiting room disabled. Run on a separate host.
import { chromium, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";

const url = new URL(process.env.MEDIA_TEST_ROOM_URL || "http://invalid");
if (url.protocol !== "https:" || !/^\/join\/[A-Za-z0-9_-]+$/.test(url.pathname))
  throw new Error(
    "MEDIA_TEST_ROOM_URL must be a disposable HTTPS /join/ room URL",
  );
const levels = (process.env.MEDIA_LOAD_LEVELS || "2,4,8")
  .split(",")
  .map(Number);
if (
  !levels.length ||
  levels.length > 4 ||
  levels.some((n) => !Number.isSafeInteger(n) || n < 2 || n > 12) ||
  levels.some((n, i) => i > 0 && n <= levels[i - 1])
)
  throw new Error("Use 1 to 4 increasing participant counts between 2 and 12");
const sampleSeconds = Number(process.env.MEDIA_LOAD_SAMPLE_SECONDS || 20);
if (
  !Number.isSafeInteger(sampleSeconds) ||
  sampleSeconds < 10 ||
  sampleSeconds > 60
)
  throw new Error("MEDIA_LOAD_SAMPLE_SECONDS must be between 10 and 60");
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
  ],
});
const contexts = [],
  pages = [],
  levelsReport = [];
const startedAt = new Date().toISOString();

async function stats(page) {
  return page.evaluate(async () => {
    const result = {
      connectedPeers: 0,
      incomingAudioBytes: 0,
      incomingVideoBytes: 0,
      decodedFrames: 0,
      packetsReceived: 0,
      packetsLost: 0,
      jitterMaxMs: 0,
      rttMaxMs: 0,
      incomingVideoTracks: 0,
      routes: [],
    };
    for (const peer of window.__imonLoadPeers || []) {
      if (peer.connectionState !== "connected") continue;
      result.connectedPeers++;
      const reports = await peer.getStats();
      for (const report of reports.values()) {
        if (report.type === "inbound-rtp" && !report.isRemote) {
          result.packetsReceived += report.packetsReceived || 0;
          result.packetsLost += Math.max(0, report.packetsLost || 0);
          result.jitterMaxMs = Math.max(
            result.jitterMaxMs,
            (report.jitter || 0) * 1000,
          );
          if (report.kind === "audio")
            result.incomingAudioBytes += report.bytesReceived || 0;
          if (report.kind === "video") {
            result.incomingVideoBytes += report.bytesReceived || 0;
            result.decodedFrames += report.framesDecoded || 0;
            result.incomingVideoTracks++;
          }
        }
        if (report.type === "transport" && report.selectedCandidatePairId) {
          const pair = reports.get(report.selectedCandidatePairId);
          const local = reports.get(pair?.localCandidateId);
          result.rttMaxMs = Math.max(
            result.rttMaxMs,
            (pair?.currentRoundTripTime || 0) * 1000,
          );
          result.routes.push({
            type: local?.candidateType,
            relayProtocol: local?.relayProtocol,
            transport: local?.protocol,
          });
        }
      }
    }
    return result;
  });
}

try {
  for (const count of levels) {
    while (pages.length < count) {
      const index = pages.length;
      const context = await browser.newContext({
        permissions: ["microphone", "camera"],
        viewport: { width: 1366, height: 900 },
      });
      contexts.push(context);
      await context.addInitScript(() => {
        window.__imonLoadPeers = [];
        const Native = window.RTCPeerConnection;
        window.RTCPeerConnection = new Proxy(Native, {
          construct(Target, args) {
            const peer = new Target(...args);
            window.__imonLoadPeers.push(peer);
            return peer;
          },
        });
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
      const page = await context.newPage();
      pages.push(page);
      await page.goto(url.href, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await page
        .getByPlaceholder("Ваше имя", { exact: true })
        .fill(`Нагрузочная проверка ${index + 1}`);
      await page
        .getByRole("button", { name: "Присоединиться к встрече", exact: true })
        .click();
      await expect(page.locator(".lk-participant-tile")).toHaveCount(
        pages.length,
        { timeout: 45000 },
      );
    }
    for (const page of pages)
      await expect(page.locator(".lk-participant-tile")).toHaveCount(count, {
        timeout: 30000,
      });
    const before = await Promise.all(pages.map(stats));
    const sampleStarted = Date.now();
    // Sample at one-second intervals, so a failed participant ends the run promptly.
    for (let i = 0; i < sampleSeconds; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (pages.some((page) => page.isClosed()))
        throw new Error("A browser participant closed during the sample");
    }
    const elapsedSeconds = (Date.now() - sampleStarted) / 1000;
    const after = await Promise.all(pages.map(stats));
    const participants = after.map((current, index) => {
      const previous = before[index];
      const received = Math.max(
        0,
        current.packetsReceived - previous.packetsReceived,
      );
      const lost = Math.max(0, current.packetsLost - previous.packetsLost);
      return {
        index: index + 1,
        connected: current.connectedPeers > 0,
        audioReceived: current.incomingAudioBytes > previous.incomingAudioBytes,
        videoReceived: current.decodedFrames > previous.decodedFrames,
        incomingVideoTracks: current.incomingVideoTracks,
        decodedFramesPerSecond: Number(
          (
            (current.decodedFrames - previous.decodedFrames) /
            elapsedSeconds
          ).toFixed(2),
        ),
        inboundMbps: Number(
          (
            ((current.incomingAudioBytes -
              previous.incomingAudioBytes +
              current.incomingVideoBytes -
              previous.incomingVideoBytes) *
              8) /
            elapsedSeconds /
            1000000
          ).toFixed(3),
        ),
        packetLossPercent:
          received + lost
            ? Number(((lost * 100) / (received + lost)).toFixed(3))
            : null,
        jitterMaxMs: Number(current.jitterMaxMs.toFixed(1)),
        rttMaxMs: Number(current.rttMaxMs.toFixed(1)),
        routes: current.routes,
      };
    });
    const result = {
      participants: count,
      elapsedSeconds,
      accepted: participants.every(
        (p) =>
          p.connected &&
          p.audioReceived &&
          p.videoReceived &&
          p.packetLossPercent !== null &&
          p.packetLossPercent < 5,
      ),
      measurements: participants,
    };
    levelsReport.push(result);
    console.log(JSON.stringify(result));
    if (!result.accepted)
      throw new Error(
        `Media acceptance failed at ${count} participants; later levels were not started`,
      );
  }
} finally {
  await Promise.allSettled(contexts.map((context) => context.close()));
  await browser.close();
  const report = {
    startedAt,
    completedAt: new Date().toISOString(),
    scenario:
      "Synthetic browser clients, camera capped at 640x360/15fps; adaptive subscriptions; one conference; no screen sharing or recording",
    limitations:
      "A smoke load on this client/network, not a production maximum. It does not cover physical devices, mobile Safari, long calls, simultaneous rooms or TCP443-only networks.",
    levels: levelsReport,
  };
  if (process.env.MEDIA_LOAD_REPORT)
    await writeFile(
      process.env.MEDIA_LOAD_REPORT,
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600 },
    );
  console.log(
    JSON.stringify({
      completed:
        levelsReport.length === levels.length &&
        levelsReport.every((level) => level.accepted),
      highestAcceptedParticipants:
        levelsReport.filter((level) => level.accepted).at(-1)?.participants ??
        0,
    }),
  );
}
