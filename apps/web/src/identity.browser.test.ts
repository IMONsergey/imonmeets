import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, expect } from "@playwright/test";

test(
  "browser: OAuth MFA preserves invitation intent and Google-only step-up offers session-bound password setup",
  { skip: !process.env.IMON_BROWSER_EXECUTABLE, timeout: 120_000 },
  async () => {
    const built = await build({
      root: fileURLToPath(new URL("..", import.meta.url)),
      configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
      logLevel: "silent",
      build: { write: false, sourcemap: false },
    });
    const output = Array.isArray(built) ? built[0] : built;
    if (!("output" in output))
      throw new Error("Missing browser fixture bundle");
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
    const browser = await chromium.launch({
      executablePath: process.env.IMON_BROWSER_EXECUTABLE,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const context = await browser.newContext();
    let loggedIn = false;
    let hasPassword = false;
    let requested = 0;
    let completed: Record<string, unknown> | undefined;
    const external: string[] = [];
    await context.route("**/*", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.origin !== "https://identity.invalid") {
        external.push(url.origin);
        return route.abort();
      }
      const path = url.pathname;
      if (path === "/api/config")
        return route.fulfill({
          json: {
            appName: "IMON Meets",
            registrationEnabled: true,
            emailDelivery: "external",
            emailConfigured: true,
            emailVerificationRequired: true,
            googleOAuthConfigured: true,
            mediaConfigured: false,
            recordingConfigured: false,
          },
        });
      if (path === "/api/me")
        return route.fulfill(
          loggedIn
            ? {
                json: {
                  user: {
                    id: "oauth-user",
                    name: "OAuth User",
                    email: "oauth@example.invalid",
                    emailVerified: true,
                    twoFactorEnabled: false,
                  },
                  workspaces: [
                    {
                      id: "ws-identity",
                      name: "Identity",
                      role: "owner",
                      createdAt: "2026-01-01T00:00:00Z",
                    },
                  ],
                },
              }
            : {
                status: 401,
                json: {
                  error: {
                    code: "AUTH_REQUIRED",
                    message: "Войдите в аккаунт.",
                  },
                },
              },
        );
      if (path === "/api/auth/two-factor/verify-totp")
        return route.fulfill({
          status: 403,
          json: {
            code: "INVALID_CODE",
            message: "Код не подошел. Повторите ввод.",
          },
        });
      if (path === "/api/auth/two-factor/verify-backup-code") {
        loggedIn = true;
        return route.fulfill({ json: { status: true } });
      }
      if (path === "/api/me/security")
        return route.fulfill({
          json: { hasPassword, addPasswordAvailable: true },
        });
      if (path === "/api/me/password/request") {
        requested++;
        return route.fulfill({ json: { requested: true } });
      }
      if (path === "/api/me/password/complete") {
        completed = req.postDataJSON();
        hasPassword = true;
        loggedIn = false;
        return route.fulfill({
          json: { status: true, reauthenticationRequired: true },
        });
      }
      if (path === "/api/auth/list-accounts")
        return route.fulfill({ json: [{ providerId: "google" }] });
      if (path === "/api/sessions")
        return route.fulfill({ json: { sessions: [] } });
      if (path.startsWith("/api/"))
        return route.fulfill({
          status: 404,
          json: { error: { code: "FIXTURE_ROUTE", message: path } },
        });
      const asset = assets.get(path.slice(1));
      if (asset)
        return route.fulfill({
          body: asset,
          contentType: path.endsWith(".css")
            ? "text/css"
            : "application/javascript",
        });
      return route.fulfill({
        body: assets.get("index.html")!,
        contentType: "text/html",
      });
    });
    const page = await context.newPage();
    try {
      const intent = "/invite#token=preserved-local-invitation";
      await page.goto(
        "https://identity.invalid/login?twoFactor=1#" +
          new URLSearchParams({ returnTo: intent }),
      );
      await expect(
        page.getByRole("heading", { name: "Подтвердите вход", exact: true }),
      ).toBeVisible();
      await expect(page.getByLabel("Пароль", { exact: true })).toHaveCount(0);
      await page
        .getByLabel("Код из приложения", { exact: true })
        .fill("000000");
      await page
        .getByRole("button", { name: "Подтвердить вход", exact: true })
        .click();
      await expect(page.getByRole("alert")).toContainText("Неверный код");
      assert.equal(new URL(page.url()).pathname, "/login");
      await page
        .getByRole("button", {
          name: "Использовать резервный код",
          exact: true,
        })
        .click();
      await page
        .getByLabel("Резервный код", { exact: true })
        .fill("local-backup-code");
      await page
        .getByRole("button", { name: "Подтвердить вход", exact: true })
        .click();
      await expect(page).toHaveURL("https://identity.invalid" + intent);
      await page.goto("https://identity.invalid/settings?section=security");
      await expect(
        page.getByRole("heading", {
          name: "Добавьте пароль IMON Meets",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByLabel("Текущий пароль", { exact: true }),
      ).toHaveCount(0);
      await page
        .getByRole("button", {
          name: "Получить ссылку для добавления пароля",
          exact: true,
        })
        .click();
      await expect(page.getByRole("status")).toContainText(
        "Откройте письмо в том же браузере",
      );
      assert.equal(requested, 1);
      const token = "a".repeat(43);
      await page.goto("https://identity.invalid/set-password#token=" + token);
      await expect(
        page.getByRole("heading", {
          name: "Добавить пароль IMON Meets",
          exact: true,
        }),
      ).toBeVisible();
      await page
        .getByLabel("Новый пароль", { exact: true })
        .fill("New-local-password-123");
      await page
        .getByRole("button", { name: "Сохранить пароль", exact: true })
        .click();
      await expect(page.getByText(/Пароль IMON Meets добавлен/)).toBeVisible();
      assert.equal(completed?.token, token);
      assert.equal(completed?.newPassword, "New-local-password-123");
      assert.equal(new URL(page.url()).hash, "");
      loggedIn = true;
      await page.goto("https://identity.invalid/settings?section=security");
      await expect(
        page.getByLabel("Текущий пароль", { exact: true }),
      ).toBeVisible();
      hasPassword = false;
      await page.goto("https://identity.invalid/settings?section=data");
      await page
        .getByRole("button", { name: "Удалить аккаунт", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await expect(
        dialog.getByRole("heading", {
          name: "Добавьте пароль IMON Meets",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        dialog.getByLabel("Текущий пароль", { exact: true }),
      ).toHaveCount(0);
      assert.deepEqual(external, []);
    } finally {
      await context.close();
      await browser.close();
    }
  },
);
