#!/usr/bin/env node
// Run on a second machine against a disposable, guest-enabled room.
// No credentials, signaling payloads, screenshots or traces are retained.
import { chromium, expect } from "@playwright/test";
import {
  parseTurnTlsEndpoint,
  installMediaProbe,
  collectMediaStats,
  collectSafeMediaDiagnostic,
  mediaProofIsValid,
} from "./external-media-policy.mjs";

const roomURL = process.env.MEDIA_TEST_ROOM_URL;
let parsedRoomURL;
try {
  parsedRoomURL = new URL(roomURL);
} catch {
  // Do not print a malformed invitation URL in an exception.
}
if (
  !parsedRoomURL ||
  parsedRoomURL.protocol !== "https:" ||
  parsedRoomURL.username ||
  parsedRoomURL.password
) {
  throw new Error("Set MEDIA_TEST_ROOM_URL to a disposable HTTPS guest room");
}
const turn = parseTurnTlsEndpoint(process.env.MEDIA_TEST_TURN_TLS_URL);
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
    let stage = "connection-setup";
    try {
      for (let index = 0; index < 2; index++) {
        const context = await browser.newContext({
          permissions: ["camera", "microphone"],
          viewport: { width: 1366, height: 900 },
        });
        contexts.push(context);
        await context.addInitScript(installMediaProbe, {
          relayOnly,
          allowedTurnUrls: turn.allowedTurnUrls,
        });
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
      stage = "participants-and-video";
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
      stage = "chat-delivery";
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
      stage = "selected-media-route";
      const stats = [];
      for (const page of pages) {
        const collect = () =>
          page.evaluate(collectMediaStats, {
            allowedTurnUrls: turn.allowedTurnUrls,
          });
        await expect
          .poll(async () => mediaProofIsValid(await collect(), relayOnly), {
            timeout: 20_000,
          })
          .toBe(true);
        const current = await collect();
        // Check the retained sample too: a passing poll must not mask a route
        // change or disconnect immediately before evidence is collected.
        expect(mediaProofIsValid(current, relayOnly)).toBe(true);
        stats.push(current);
      }
      results.push({
        mode: relayOnly ? `TURN TLS ${turn.port} only` : "normal ICE",
        expectedTurnTlsPort: turn.port,
        participants: 2,
        chatDelivered: true,
        stats,
      });
      console.log(JSON.stringify(results.at(-1)));
    } catch {
      for (const page of pages) {
        let diagnostic;
        try {
          diagnostic = await page.evaluate(collectSafeMediaDiagnostic);
        } catch {
          diagnostic = { available: false };
        }
        console.log(
          JSON.stringify({
            mode: relayOnly ? "relay" : "normal",
            stage,
            diagnostic,
          }),
        );
      }
      // Raw Playwright errors can contain invitation URLs and page text.
      throw new Error(
        `External media proof failed at ${stage} (${relayOnly ? "relay" : "normal"}); see bounded connection diagnostics`,
      );
    } finally {
      await Promise.allSettled(contexts.map((context) => context.close()));
    }
  }
} finally {
  await browser.close();
}
console.log(JSON.stringify({ passed: true, scenarios: results.length }));
