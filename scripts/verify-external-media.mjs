#!/usr/bin/env node
// Run on a second machine against a disposable, guest-enabled room.
// No credentials, signaling payloads, screenshots or traces are retained.
import { chromium, expect } from "@playwright/test";

const roomURL = process.env.MEDIA_TEST_ROOM_URL;
if (!roomURL || new URL(roomURL).protocol !== "https:") {
  throw new Error("Set MEDIA_TEST_ROOM_URL to a disposable HTTPS guest room");
}
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
  ],
});
const results = [];
try {
  for (const relayOnly of [false, true]) {
    const contexts = [];
    const pages = [];
    try {
      for (let index = 0; index < 2; index++) {
        const context = await browser.newContext({
          permissions: ["camera", "microphone"],
          viewport: { width: 1366, height: 900 },
        });
        contexts.push(context);
        await context.addInitScript(
          ({ relayOnly }) => {
            window.__imonRTCPeers = [];
            const Native = window.RTCPeerConnection;
            const configure = (source = {}) => {
              if (!relayOnly) return source;
              return {
                ...source,
                iceTransportPolicy: "relay",
                iceServers: (source.iceServers || []).flatMap((server) => {
                  const urls = (
                    Array.isArray(server.urls) ? server.urls : [server.urls]
                  ).filter(
                    (url) =>
                      typeof url === "string" &&
                      /^turns:.*:5349(?:\?|$)/.test(url),
                  );
                  return urls.length ? [{ ...server, urls }] : [];
                }),
              };
            };
            window.RTCPeerConnection = new Proxy(Native, {
              construct(Target, args) {
                const peer = new Target(configure(args[0]));
                const setConfiguration = peer.setConfiguration.bind(peer);
                peer.setConfiguration = (next) =>
                  setConfiguration(configure(next));
                window.__imonRTCPeers.push(peer);
                return peer;
              },
            });
          },
          { relayOnly },
        );
        const page = await context.newPage();
        pages.push(page);
        await page.goto(roomURL, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        await page
          .getByPlaceholder("Ваше имя", { exact: true })
          .fill(`Проверка связи ${index + 1}`);
        await page
          .getByRole("button", {
            name: "Присоединиться к встрече",
            exact: true,
          })
          .click();
      }
      for (const page of pages) {
        await expect(page.locator(".lk-participant-tile")).toHaveCount(2, {
          timeout: 40_000,
        });
        await expect
          .poll(
            () =>
              page
                .locator("video")
                .evaluateAll(
                  (videos) =>
                    videos.filter(
                      (video) =>
                        video.readyState >= 2 &&
                        video.videoWidth > 0 &&
                        video.videoHeight > 0,
                    ).length,
                ),
            { timeout: 30_000 },
          )
          .toBe(2);
      }
      await pages[0]
        .getByRole("button", { name: "Чат встречи", exact: true })
        .click();
      await pages[1]
        .getByRole("button", { name: "Чат встречи", exact: true })
        .click();
      await pages[0]
        .getByRole("textbox", { name: "Сообщение команде" })
        .fill("Проверка доставки между участниками");
      await pages[0]
        .getByRole("button", { name: "Отправить сообщение" })
        .click();
      await expect(
        pages[1]
          .getByRole("log", { name: "Сообщения встречи" })
          .getByText("Проверка доставки между участниками", { exact: true }),
      ).toBeVisible();
      const stats = [];
      for (const page of pages) {
        const collect = () =>
          page.evaluate(async () => {
            const output = {
              audioBytes: 0,
              videoFrames: 0,
              pairs: [],
              policies: [],
            };
            for (const peer of window.__imonRTCPeers) {
              if (peer.connectionState !== "connected") continue;
              output.policies.push(peer.getConfiguration().iceTransportPolicy);
              const reports = await peer.getStats();
              reports.forEach((report) => {
                if (report.type === "inbound-rtp" && report.kind === "audio")
                  output.audioBytes += report.bytesReceived || 0;
                if (report.type === "inbound-rtp" && report.kind === "video")
                  output.videoFrames += report.framesDecoded || 0;
                if (
                  report.type !== "transport" ||
                  !report.selectedCandidatePairId
                )
                  return;
                const pair = reports.get(report.selectedCandidatePairId);
                const local = reports.get(pair?.localCandidateId);
                const remote = reports.get(pair?.remoteCandidateId);
                output.pairs.push({
                  localType: local?.candidateType,
                  relayProtocol: local?.relayProtocol,
                  relayServer: local?.url,
                  remoteProtocol: remote?.protocol,
                  remotePort: remote?.port,
                  bytesSent: pair?.bytesSent,
                  bytesReceived: pair?.bytesReceived,
                });
              });
            }
            return output;
          });
        await expect
          .poll(
            async () => {
              const current = await collect();
              return (
                current.audioBytes > 0 &&
                current.videoFrames > 0 &&
                current.pairs.length > 0
              );
            },
            { timeout: 20_000 },
          )
          .toBe(true);
        const current = await collect();
        if (relayOnly) {
          expect(current.policies.every((policy) => policy === "relay")).toBe(
            true,
          );
          // Chrome may label the nominated address as peer-reflexive after a
          // relay route is established. Require relay-only policy AND the
          // selected candidate's relay transport, not a host/prflx shortcut.
          expect(
            current.pairs.every(
              (pair) =>
                ["relay", "prflx"].includes(pair.localType) &&
                ["tls", "tcp"].includes(pair.relayProtocol) &&
                /^turns:.*:5349(?:\?|$)/.test(pair.relayServer || ""),
            ),
          ).toBe(true);
        }
        stats.push(current);
      }
      results.push({
        mode: relayOnly ? "TURN TLS 5349 only" : "normal ICE",
        participants: 2,
        chatDelivered: true,
        stats,
      });
      console.log(JSON.stringify(results.at(-1)));
    } catch (error) {
      for (const page of pages) {
        console.log(
          JSON.stringify({
            mode: relayOnly ? "relay" : "normal",
            diagnostic: await page.evaluate(() => ({
              screen: document.body.innerText.slice(0, 1400),
              peers: (window.__imonRTCPeers || []).map((peer) => ({
                connection: peer.connectionState,
                ice: peer.iceConnectionState,
                gathering: peer.iceGatheringState,
                iceServers: (peer.getConfiguration().iceServers || []).map(
                  (server) => server.urls,
                ),
              })),
            })),
          }),
        );
      }
      throw error;
    } finally {
      await Promise.allSettled(contexts.map((context) => context.close()));
    }
  }
} finally {
  await browser.close();
}
console.log(JSON.stringify({ passed: true, scenarios: results.length }));
