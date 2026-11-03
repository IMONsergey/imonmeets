import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, expect } from "@playwright/test";

test(
  "public pages, safe legal rendering and mobile personal-security status",
  { skip: !process.env.IMON_BROWSER_EXECUTABLE, timeout: 90_000 },
  async () => {
    const built = await build({
      root: fileURLToPath(new URL("..", import.meta.url)),
      configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
      logLevel: "silent",
      build: { write: false, sourcemap: false },
    });
    const output = Array.isArray(built) ? built[0] : built;
    if (!("output" in output)) throw new Error("Expected in-memory build");
    const assets = new Map(
      output.output.map((item) => [
        item.fileName,
        item.type === "chunk"
          ? item.code
          : typeof item.source === "string"
            ? item.source
            : Buffer.from(item.source),
      ]),
    );
    const html = assets.get("index.html");
    assert.ok(html);
    const browser = await chromium.launch({
      executablePath: process.env.IMON_BROWSER_EXECUTABLE,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--renderer-process-limit=2",
      ],
    });
    const context = await browser.newContext();
    let signedIn = false,
      published = false,
      mfa = false,
      documentsRead = 0;
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== "https://public.invalid") return route.abort();
      if (url.pathname === "/api/config")
        return route.fulfill({
          json: {
            appName: "IMON Meets",
            registrationEnabled: false,
            emailConfigured: true,
            emailDelivery: "capture",
            mediaConfigured: false,
            recordingConfigured: false,
            publicInformation: {
              supportEmail: "support@example.test",
              supportHours: "Пн–пт, 10:00–18:00 UTC+3",
              legalVersion: published ? "2026-11-03.1" : null,
            },
          },
        });
      if (url.pathname === "/api/me")
        return signedIn
          ? route.fulfill({
              json: {
                user: {
                  id: "u1",
                  name: "Test",
                  email: "test@example.test",
                  emailVerified: true,
                  twoFactorEnabled: mfa,
                },
                workspaces: [
                  {
                    id: "w1",
                    name: "Test workspace",
                    role: "owner",
                    createdAt: "2026-01-01T00:00:00Z",
                  },
                ],
              },
            })
          : route.fulfill({
              status: 401,
              json: {
                error: {
                  code: "UNAUTHENTICATED",
                  message: "Войдите в аккаунт.",
                },
              },
            });
      if (url.pathname === "/api/public-documents/privacy") {
        documentsRead++;
        return route.fulfill({
          json: {
            version: "2026-11-03.1",
            publishedAt: "2026-11-03T00:00:00Z",
            operator: {
              name: "Synthetic operator",
              registration: "test registration",
              address: "test address",
            },
            document: {
              title: "Проверенная политика",
              sections: [
                {
                  heading: "Безопасный текст",
                  paragraphs: ["<img src=x onerror=alert('unsafe')>"],
                },
              ],
            },
          },
        });
      }
      if (url.pathname.startsWith("/api/"))
        return route.fulfill({
          status: 404,
          json: { error: { code: "NOT_FOUND", message: "Not found" } },
        });
      const asset = assets.get(url.pathname.slice(1));
      return route.fulfill({
        body: asset ?? html,
        contentType: url.pathname.endsWith(".js")
          ? "text/javascript"
          : url.pathname.endsWith(".css")
            ? "text/css"
            : "text/html",
      });
    });
    const page = await context.newPage();
    try {
      await page.goto("https://public.invalid/");
      await expect(
        page.getByRole("heading", {
          name: "Обсуждайте, показывайте, принимайте решения.",
        }),
      ).toBeVisible();
      assert.equal(new URL(page.url()).pathname, "/");
      await page.goto("https://public.invalid/not-a-page");
      await expect(
        page.getByRole("heading", { name: "Страница не найдена" }),
      ).toBeVisible();
      assert.equal(new URL(page.url()).pathname, "/not-a-page");
      await page.goto("https://public.invalid/help");
      await expect(
        page.getByRole("heading", { name: "Кто видит историю" }),
      ).toBeVisible();
      await page.goto("https://public.invalid/privacy");
      await expect(
        page.getByText(
          "Документ еще не опубликован. Публичные коммерческие продажи не открыты.",
        ),
      ).toBeVisible();
      assert.equal(documentsRead, 0);
      published = true;
      await page.reload();
      await expect(
        page.getByRole("heading", { name: "Проверенная политика" }),
      ).toBeVisible();
      await expect(
        page.getByText("<img src=x onerror=alert('unsafe')>", { exact: true }),
      ).toBeVisible();
      assert.equal(await page.locator("img[src='x']").count(), 0);
      await page.goto("https://public.invalid/register");
      await expect(
        page.getByRole("link", { name: "Написать в поддержку" }),
      ).toHaveAttribute("href", "mailto:support@example.test");
      await expect(
        page.getByRole("link", { name: "Помощь с доступом" }),
      ).toBeVisible();
      signedIn = true;
      await page.setViewportSize({ width: 320, height: 740 });
      await page.goto("https://public.invalid/settings?section=services");
      await expect(
        page.getByText("Выключена у вас", { exact: true }),
      ).toBeVisible();
      const frame = await page
        .getByRole("navigation", { name: "Разделы настроек" })
        .boundingBox();
      const active = await page
        .getByRole("button", { name: "Сервисы", exact: true })
        .boundingBox();
      assert.ok(
        frame &&
          active &&
          active.x >= frame.x - 1 &&
          active.x + active.width <= frame.x + frame.width + 1,
        "The active mobile settings section is visible",
      );
      mfa = true;
      await page.reload();
      await expect(
        page.getByText("Включена у вас", { exact: true }),
      ).toBeVisible();
      await page.goto("https://public.invalid/about");
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        "No horizontal overflow at320px",
      );
      await page.screenshot({
        path: process.env.IMON_PUBLIC_SCREENSHOT || "/tmp/imon-public-320.png",
        fullPage: true,
      });
    } finally {
      await browser.close();
    }
  },
);
