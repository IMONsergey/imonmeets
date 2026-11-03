import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, expect } from "@playwright/test";
import "./suite.browser.test";
import "./rooms.browser.test";
import "./embed.browser.test";

// All requests are intercepted. This exercises the production React bundle and
// browser state, without a server, production account, email or media connection.
test(
  "real browser: auth intents, sessions, membership, modal access and recovery",
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
    const output = Array.isArray(built) ? built[0] : built;
    if (!("output" in output))
      throw new Error("Expected in-memory production bundle");
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
    if (!html) throw new Error("Missing fixture HTML");
    const browser = await chromium.launch({
      executablePath: process.env.IMON_BROWSER_EXECUTABLE,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const context = await browser.newContext();
    let loggedIn = false;
    let registrationEnabled = false;
    let googleOAuthEnabled = true;
    let googleLinked = false;
    const capturedSocialRequests: Record<string, unknown>[] = [];
    let corruptedUser = false;
    let capturedCallback = "";
    let loginAllowed = false;
    let expireOnMembers = false;
    let name = "Проверка";
    let workspaces = [
      {
        id: "ws-first",
        name: "Первое",
        role: "owner",
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "ws-second",
        name: "Второе",
        role: "member",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === "https://accounts.google.com")
        return route.fulfill({
          contentType: "text/html",
          body: "<main><h1>Mock Google authorization</h1></main>",
        });
      if (url.origin !== "https://audit.invalid") return route.abort();
      const path = url.pathname;
      if (path === "/api/config")
        return route.fulfill({
          json: {
            appName: "IMON Meets",
            registrationEnabled,
            emailDelivery: registrationEnabled ? "external" : "capture",
            emailConfigured: true,
            emailVerificationRequired: true,
            googleOAuthConfigured: googleOAuthEnabled,
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
                    id: "fixture-user",
                    name: corruptedUser ? null : name,
                    email: "fixture@example.invalid",
                    emailVerified: true,
                  },
                  workspaces,
                },
              }
            : {
                status: 401,
                json: {
                  error: {
                    code: "UNAUTHENTICATED",
                    message: "Войдите в аккаунт.",
                  },
                },
              },
        );
      if (path === "/api/auth/sign-in/social") {
        capturedSocialRequests.push(route.request().postDataJSON());
        return route.fulfill({
          json: {
            url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=mock-google-client",
            redirect: true,
          },
        });
      }
      if (path === "/api/auth/list-accounts")
        return route.fulfill({
          json: googleLinked
            ? [{ providerId: "google" }]
            : [{ providerId: "credential" }],
        });
      if (path === "/api/auth/link-social") {
        capturedSocialRequests.push(route.request().postDataJSON());
        googleLinked = true;
        return route.fulfill({
          json: {
            url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=mock-google-client&flow=link",
            redirect: true,
          },
        });
      }
      if (path === "/api/auth/sign-up/email") {
        capturedCallback = route.request().postDataJSON().callbackURL;
        return route.fulfill({ json: { user: { id: "fixture-user" } } });
      }
      if (path === "/api/auth/sign-out") {
        loggedIn = false;
        return route.fulfill({ json: { success: true } });
      }
      if (path === "/api/auth/sign-in/email") {
        if (!loginAllowed)
          return route.fulfill({
            status: 403,
            json: { code: "EMAIL_NOT_VERIFIED", message: "Email not verified" },
          });
        loggedIn = true;
        return route.fulfill({ json: { success: true } });
      }
      if (path === "/api/auth/update-user") {
        name = route.request().postDataJSON().name;
        return route.fulfill({ json: { success: true } });
      }
      if (path.startsWith("/api/")) {
        if (expireOnMembers && path.endsWith("/members")) loggedIn = false;
        if (!loggedIn)
          return route.fulfill({
            status: 401,
            json: {
              error: { code: "UNAUTHENTICATED", message: "Войдите в аккаунт." },
            },
          });
        if (path.endsWith("/rooms"))
          return route.fulfill({ json: { rooms: [] } });
        if (path.endsWith("/members"))
          return route.fulfill({ json: { members: [], invitations: [] } });
        return route.fulfill({
          status: 404,
          json: { error: { code: "NOT_FOUND", message: "Не найдено." } },
        });
      }
      const asset = assets.get(path.slice(1));
      return route.fulfill({
        body: asset ?? html,
        contentType: path.endsWith(".js")
          ? "text/javascript"
          : path.endsWith(".css")
            ? "text/css"
            : "text/html",
      });
    });
    try {
      const page = await context.newPage();
      await page.goto("https://audit.invalid/join/%ZZ");
      await expect(
        page.getByRole("heading", { name: "Неправильная ссылка на встречу" }),
      ).toBeVisible();
      await page.goto("https://audit.invalid/verify-email?success=1");
      await expect(
        page.getByRole("heading", { name: "Подтвердите вашу почту" }),
      ).toBeVisible();
      await expect(
        page.getByText("Адрес подтвержден.", { exact: false }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Отправить письмо", exact: true }),
      ).toBeDisabled();
      await page.goto("https://audit.invalid/register");
      await expect(
        page.getByRole("heading", { name: "Регистрация закрыта" }),
      ).toBeVisible();
      await expect(page.locator("form")).toHaveCount(0);

      await page.goto("https://audit.invalid/login");
      await page.setViewportSize({ width: 390, height: 844 });
      const googleButton = page.getByRole("button", {
        name: "Продолжить с Google",
        exact: true,
      });
      await expect(googleButton).toBeVisible();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth,
        ),
        false,
      );
      await page.setViewportSize({ width: 1440, height: 900 });
      await googleButton.click();
      await expect(
        page.getByRole("heading", { name: "Mock Google authorization" }),
      ).toBeVisible();
      assert.equal(capturedSocialRequests.at(-1)?.provider, "google");
      assert.equal(capturedSocialRequests.at(-1)?.requestSignUp, false);
      await page.goto("https://audit.invalid/login?error=access_denied");
      await expect(page.getByRole("alert")).toContainText(
        "Вход через Google отменен",
      );
      assert.equal(new URL(page.url()).searchParams.has("error"), false);
      await page.goto("https://audit.invalid/login?error=account_not_linked");
      await expect(page.getByRole("alert")).toContainText(
        "привяжите Google в настройках безопасности",
      );

      await page.goto("https://audit.invalid/login");
      await page
        .getByLabel("Рабочая почта", { exact: true })
        .fill("fixture@example.invalid");
      await page
        .getByLabel("Пароль", { exact: true })
        .fill("Fixture-password-1024");
      await page
        .getByRole("button", { name: "Войти в пространство", exact: true })
        .click();
      await expect(page.getByRole("alert")).toHaveText(
        "Подтвердите адрес почты, чтобы войти в аккаунт.",
      );
      await page
        .getByRole("link", {
          name: "Подтвердить почту или запросить новое письмо",
          exact: true,
        })
        .click();
      await expect(
        page.getByLabel("Рабочая почта", { exact: true }),
      ).toHaveValue("fixture@example.invalid");
      await expect(
        page.getByRole("button", { name: "Отправить письмо", exact: true }),
      ).toBeDisabled();
      loginAllowed = true;
      await page.goto("https://audit.invalid/login");
      await page
        .getByLabel("Рабочая почта", { exact: true })
        .fill("fixture@example.invalid");
      await page
        .getByLabel("Пароль", { exact: true })
        .fill("Fixture-password-1024");
      await page
        .getByRole("button", { name: "Войти в пространство", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: /Добрый день/ }),
      ).toBeVisible();
      await page.goto("https://audit.invalid/settings?section=security");
      await expect(
        page.getByRole("heading", { name: "Аккаунт Google" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Привязать Google", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Привязать Google", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Mock Google authorization" }),
      ).toBeVisible();
      assert.equal(capturedSocialRequests.at(-1)?.provider, "google");
      assert.equal(typeof capturedSocialRequests.at(-1)?.callbackURL, "string");
      await page.goto("https://audit.invalid/settings?section=security");
      await expect(page.getByText("Подключен", { exact: true })).toBeVisible();
      await page.getByLabel("Меню аккаунта").click();
      await page
        .getByRole("button", { name: "Выйти из аккаунта", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Войти", exact: true }),
      ).toBeVisible();

      registrationEnabled = true;
      await page.goto(
        "https://audit.invalid/invite#token=private-fixture-invite",
      );
      await page
        .getByRole("button", { name: "Войти и принять приглашение" })
        .click();
      await page
        .getByRole("link", { name: "Создать аккаунт", exact: true })
        .click();
      const googleSignup = page.getByRole("button", {
        name: "Продолжить с Google",
        exact: true,
      });
      await expect(googleSignup).toBeVisible();
      await googleSignup.click();
      await expect(
        page.getByRole("heading", { name: "Mock Google authorization" }),
      ).toBeVisible();
      assert.equal(capturedSocialRequests.at(-1)?.requestSignUp, true);
      await page.goto("https://audit.invalid/register");
      await page.getByLabel("Ваше имя", { exact: true }).fill("Проверка");
      await page
        .getByLabel("Рабочая почта", { exact: true })
        .fill("fixture@example.invalid");
      const password = page.getByLabel(/^Пароль/);
      const hint = await password.getAttribute("aria-describedby");
      assert.ok(hint);
      assert.ok(await page.locator(`[id="${hint}"]`).count());
      await password.fill("Fixture-password-1024");
      await page
        .getByRole("button", { name: "Создать аккаунт", exact: true })
        .click();
      await expect(
        page.getByText("Аккаунт создан.", { exact: false }),
      ).toBeVisible();
      assert.ok(capturedCallback.includes("?intent="));
      assert.equal(capturedCallback.includes("private-fixture-invite"), false);
      loggedIn = true;
      const verifiedTab = await context.newPage();
      await verifiedTab.goto(capturedCallback);
      await expect(
        verifiedTab.getByText("Адрес подтвержден.", { exact: false }),
      ).toBeVisible();
      await verifiedTab
        .getByRole("button", { name: "Продолжить", exact: true })
        .click();
      await expect(
        verifiedTab.getByRole("button", {
          name: "Присоединиться к команде",
          exact: true,
        }),
      ).toBeVisible();
      assert.equal(
        new URL(verifiedTab.url()).hash,
        "#token=private-fixture-invite",
      );

      await page.goto("https://audit.invalid/");
      const opener = page
        .getByRole("button", { name: "Запланировать встречу", exact: true })
        .first();
      await opener.click();
      const dialog = page.getByRole("dialog", {
        name: "Новая встреча",
        exact: true,
      });
      await expect(
        dialog.getByLabel("Название встречи", { exact: true }),
      ).toBeFocused();
      assert.equal(
        await page
          .locator("#root")
          .evaluate((root) => (root as HTMLElement).inert),
        true,
      );
      assert.equal(
        await page.locator("body").evaluate((body) => body.style.overflow),
        "hidden",
      );
      const description = await dialog.getAttribute("aria-describedby");
      assert.ok(description);
      await expect(page.locator(`[id="${description}"]`)).toBeVisible();
      await dialog
        .getByRole("button", { name: "Создать встречу", exact: true })
        .focus();
      await page.keyboard.press("Tab");
      await expect(
        dialog.getByRole("button", { name: "Закрыть", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(opener).toBeFocused();
      assert.equal(
        await page
          .locator("#root")
          .evaluate((root) => (root as HTMLElement).inert),
        false,
      );

      await page
        .getByRole("combobox", { name: "Рабочее пространство" })
        .selectOption("ws-second");
      workspaces = [workspaces[0]];
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(
        page.getByRole("combobox", { name: "Рабочее пространство" }),
      ).toHaveValue("ws-first");
      await expect(
        page.getByRole("option", { name: "Второе", exact: true }),
      ).toHaveCount(0);

      name = "Внешний";
      await page.evaluate(() =>
        document.dispatchEvent(new Event("visibilitychange")),
      );
      await expect(
        page.getByRole("heading", {
          name: "Добрый день, Внешний",
          exact: true,
        }),
      ).toBeVisible();
      await page.getByRole("link", { name: "Настройки", exact: true }).click();
      await page
        .getByLabel("Ваше имя", { exact: true })
        .fill("Обновленный профиль");
      await page
        .getByRole("button", { name: "Сохранить изменения", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Обновленный профиль", exact: true }),
      ).toBeVisible();
      await verifiedTab.goto("https://audit.invalid/");
      await page.getByLabel("Меню аккаунта").click();
      await page
        .getByRole("button", { name: "Выйти из аккаунта", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Войти", exact: true }),
      ).toBeVisible();
      await expect(
        verifiedTab.getByRole("heading", { name: "Войти", exact: true }),
      ).toBeVisible();

      loggedIn = true;
      await page.goto("https://audit.invalid/");
      await expect(
        page.getByRole("heading", { name: /Добрый день/ }),
      ).toBeVisible();
      expireOnMembers = true;
      await page
        .getByRole("navigation", { name: "Главная навигация" })
        .getByRole("link", { name: "Команда", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Войти", exact: true }),
      ).toBeVisible();

      loggedIn = true;
      corruptedUser = true;
      await page.goto("https://audit.invalid/");
      await expect(
        page.getByRole("heading", {
          name: "Не удалось отобразить страницу",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "На главную", exact: true }),
      ).toBeVisible();
    } finally {
      await browser.close();
    }
  },
);
