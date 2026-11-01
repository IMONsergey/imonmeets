import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, expect } from "@playwright/test";

// Separate browser origins, real production UI and hosted ES modules. API/media
// responses are controlled fixtures; actual LiveKit acceptance runs separately.
test(
  "real browser: hosted guest iframe handshake, waiting, cookie isolation and explicit exit",
  {
    skip: !process.env.IMON_BROWSER_EXECUTABLE,
    timeout: 90_000,
  },
  async () => {
    const built = await build({
      root: fileURLToPath(new URL("..", import.meta.url)),
      configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
      logLevel: "silent",
      build: { write: false, sourcemap: false },
    });
    const bundle = Array.isArray(built) ? built[0] : built;
    if (!("output" in bundle)) throw new Error("Missing production bundle");
    const assets = new Map(
      bundle.output.map((item) => [
        item.fileName,
        item.type === "chunk"
          ? item.code
          : typeof item.source === "string"
            ? item.source
            : Buffer.from(item.source),
      ]),
    );
    const html = assets.get("index.html");
    if (!html) throw new Error("Missing production HTML");
    const host = "https://customer.invalid",
      app = "https://meet.customer.invalid";
    const room = "room_12345678901234567890",
      waitingToken = "w".repeat(43);
    const browser = await chromium.launch({
      executablePath: process.env.IMON_BROWSER_EXECUTABLE,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const context = await browser.newContext();
    const requests: {
      path: string;
      method: string;
      cookie?: string;
      body?: any;
    }[] = [];
    let allowHost = true;
    try {
      await context.addCookies([
        {
          name: "account-cookie-must-not-leak",
          value: "signed-in-account",
          url: app,
          secure: true,
          sameSite: "None",
        },
      ]);
      await context.addInitScript(
        ({ app, room }) => {
          if (location.origin !== app) return;
          (window as any).mediaAttempts = 0;
          const media = navigator.mediaDevices;
          if (media)
            media.getUserMedia = async () => {
              (window as any).mediaAttempts++;
              throw new Error("Device access was not requested by this test");
            };
          localStorage.setItem("imon.displayName", "Existing account name");
          sessionStorage.setItem(
            `imon.waiting.${room}`,
            "unrelated private account state",
          );
        },
        { app, room },
      );
      await context.route("**/*", async (route) => {
        const request = route.request(),
          url = new URL(request.url()),
          path = url.pathname;
        if (url.origin === host)
          return route.fulfill({
            contentType: "text/html",
            body: `<!doctype html><html><body><div id="meeting"></div><script type="module">import {mountMeeting} from "${app}/sdk/v1/embed.js"; window.embedEvents=[]; window.widget=mountMeeting({container:document.getElementById('meeting'),appUrl:${JSON.stringify(app)},room:${JSON.stringify(room)},name:'Embed guest',onEvent:event=>window.embedEvents.push(event)});</script></body></html>`,
          });
        if (url.origin !== app) return route.abort();
        if (path.startsWith("/api/")) {
          const headers = await request.allHeaders();
          requests.push({
            path,
            method: request.method(),
            cookie: headers.cookie,
            body: request.postData() ? request.postDataJSON() : undefined,
          });
          if (path === "/api/config")
            return route.fulfill({
              json: {
                appName: "IMON Meets",
                registrationEnabled: false,
                emailConfigured: true,
                emailDelivery: "capture",
                emailVerificationRequired: true,
                mediaConfigured: true,
                recordingConfigured: false,
                embedAllowedOrigins: allowHost ? [host] : [],
              },
            });
          if (path === `/api/rooms/${room}`)
            return route.fulfill({
              json: {
                room: {
                  title: "Встроенная встреча",
                  description: "",
                  startsAt: null,
                  durationMinutes: 30,
                  allowGuests: true,
                  waitingRoom: true,
                  maxParticipants: 8,
                  status: "open",
                },
                canManage: false,
              },
            });
          if (path.endsWith("/join"))
            return route.fulfill({
              json: {
                status: "waiting",
                requestId: "waiting-1",
                waitingToken,
                expiresAt: new Date(Date.now() + 600000).toISOString(),
              },
            });
          if (path.endsWith("/waiting-status"))
            return route.fulfill({
              json: {
                status: "waiting",
                expiresAt: new Date(Date.now() + 600000).toISOString(),
              },
            });
          if (path.endsWith("/waiting") && request.method() === "DELETE")
            return route.fulfill({ json: { ok: true } });
          return route.fulfill({
            status: 403,
            json: {
              error: {
                code: "FORBIDDEN",
                message: "Unexpected account request",
              },
            },
          });
        }
        const asset = assets.get(path.slice(1));
        if (asset !== undefined)
          return route.fulfill({
            body: asset,
            headers: path.startsWith("/sdk/")
              ? { "Access-Control-Allow-Origin": "*" }
              : {},
            contentType: path.endsWith(".js")
              ? "application/javascript"
              : path.endsWith(".css")
                ? "text/css"
                : "text/html",
          });
        if (path.startsWith("/embed/"))
          return route.fulfill({ body: html, contentType: "text/html" });
        return route.abort();
      });
      const page = await context.newPage();
      await page.goto(host);
      const frame = page.frameLocator("iframe");
      await expect(
        frame.getByRole("heading", { name: "Встроенная встреча" }),
      ).toBeVisible();
      await expect(
        frame.getByRole("textbox", { name: "Ваше имя" }),
      ).toHaveValue("Embed guest");
      await expect(
        frame.getByRole("button", { name: "Войти в пространство" }),
      ).toHaveCount(0);
      const meeting = page
        .frames()
        .find((item) => item.url().startsWith(app + "/embed/"))!;
      assert.equal(
        await meeting.evaluate(() => (window as any).mediaAttempts),
        0,
      );
      await frame
        .getByRole("button", { name: "Запросить вход", exact: true })
        .click();
      await expect(
        frame.getByRole("heading", { name: "Ждем разрешения организатора" }),
      ).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(() =>
            (window as any).embedEvents.some(
              (event: any) =>
                event.type === "state" && event.state === "waiting",
            ),
          ),
        )
        .toBe(true);
      // A correctly formatted but wrong-channel command cannot control this room.
      await page.evaluate(
        ({ app }) => {
          const frame = document.querySelector("iframe")!;
          frame.contentWindow!.postMessage(
            {
              protocol: "imon-meets",
              version: 1,
              channel: "a".repeat(32),
              type: "leave",
            },
            app,
          );
        },
        { app },
      );
      // Origin and sender are checked independently, even for otherwise valid data.
      await meeting.evaluate(() => {
        const channel = new URLSearchParams(location.hash.slice(1)).get(
          "channel",
        );
        dispatchEvent(
          new MessageEvent("message", {
            origin: "https://attacker.invalid",
            source: window.parent,
            data: {
              protocol: "imon-meets",
              version: 1,
              channel,
              type: "leave",
            },
          }),
        );
        dispatchEvent(
          new MessageEvent("message", {
            origin: "https://customer.invalid",
            source: window,
            data: {
              protocol: "imon-meets",
              version: 1,
              channel,
              type: "leave",
            },
          }),
        );
      });
      await expect(
        frame.getByRole("heading", { name: "Ждем разрешения организатора" }),
      ).toBeVisible();
      assert.equal(
        await meeting.evaluate(
          ({ room }) => sessionStorage.getItem(`imon.waiting.${room}`),
          { room },
        ),
        "unrelated private account state",
      );
      assert.equal(
        await meeting.evaluate(() => localStorage.getItem("imon.displayName")),
        "Existing account name",
      );
      assert.equal(
        await meeting.evaluate(() => (window as any).mediaAttempts),
        0,
      );
      assert.equal(
        requests.some((request) => request.cookie),
        false,
      );
      assert.equal(
        requests.some(
          (request) =>
            request.path === "/api/me" || request.path.startsWith("/api/auth/"),
        ),
        false,
      );
      assert.deepEqual(
        requests.find((request) => request.path.endsWith("/join"))?.body,
        { name: "Embed guest" },
      );
      assert.equal(
        JSON.stringify(
          await page.evaluate(() => (window as any).embedEvents),
        ).includes(waitingToken),
        false,
      );
      assert.equal(meeting.url().includes("Embed"), false);
      await page.evaluate(() => (window as any).widget.leave());
      await expect(
        frame.getByRole("heading", { name: "Вы вышли из встречи" }),
      ).toBeVisible();
      await expect
        .poll(() =>
          requests.some(
            (request) =>
              request.path.endsWith("/waiting") && request.method === "DELETE",
          ),
        )
        .toBe(true);
      await page.evaluate(() => (window as any).widget.destroy());
      await expect(page.locator("iframe")).toHaveCount(0);
      allowHost = false;
      const before = requests.filter((request) =>
        request.path.startsWith("/api/rooms/"),
      ).length;
      await page.reload();
      await expect(
        page
          .frameLocator("iframe")
          .getByRole("heading", { name: "Не удалось открыть встречу" }),
      ).toBeVisible();
      assert.equal(
        requests.filter((request) => request.path.startsWith("/api/rooms/"))
          .length,
        before,
      );
      await page.evaluate(() => (window as any).widget.destroy());
    } finally {
      await context.close();
      await browser.close();
    }
  },
);
