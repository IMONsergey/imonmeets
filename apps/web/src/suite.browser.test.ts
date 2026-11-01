import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, expect } from "@playwright/test";

test(
  "browser: MFA enrollment and recovery, private data, chat history and waiting cancellation",
  {
    skip: !process.env.IMON_BROWSER_EXECUTABLE,
    timeout: 120_000,
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
    const html = assets.get("index.html")!;
    const browser = await chromium.launch({
      executablePath: process.env.IMON_BROWSER_EXECUTABLE,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
      ],
    });
    const context = await browser.newContext({
      permissions: ["camera", "microphone"],
    });
    let loggedIn = false;
    let mfaEnabled = true;
    let owned = true;
    let workspaceExists = true;
    let cancelledWaiting = false;
    let waitState = "waiting";
    let exportCount = 0;
    let recoveryUsed = false;
    let analysisState: "none" | "queued" | "complete" = "none";
    let billingEnabled = false;
    let providerPaymentSucceeded = false;
    let paymentCreated = false;
    const checkoutRequestIds: string[] = [];
    const paymentId = "75811832-39f6-4f54-9809-bd481fdc215c";
    const roomSlug = "suite-fixture-room-123456789";
    const room = {
      id: "room-suite",
      workspaceId: "ws-suite",
      slug: roomSlug,
      title: "Проверка сценариев",
      description: "",
      startsAt: null,
      durationMinutes: 30,
      allowGuests: true,
      waitingRoom: true,
      maxParticipants: 20,
      status: "open",
      createdBy: "suite-user",
      createdAt: "2026-01-01T00:00:00Z",
    };
    const waitingToken = "room-only-private-fixture-token-1234567890";
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const fixturePayment = () => ({
      id: paymentId,
      status: providerPaymentSucceeded ? "succeeded" : "pending",
      amountKopecks: 99900,
      currency: "RUB",
      test: true,
      createdAt,
      confirmationUrl: providerPaymentSucceeded
        ? null
        : "https://yoomoney.ru/fixture-checkout",
      appliedAt: providerPaymentSucceeded ? createdAt : null,
    });
    const externalRequests: string[] = [];
    await context.route("**/*", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.origin !== "https://suite.invalid") {
        externalRequests.push(url.origin);
        if (url.origin === "https://yoomoney.ru")
          return route.fulfill({
            body: "<html><body>Тестовая платежная страница</body></html>",
            contentType: "text/html",
          });
        return route.abort();
      }
      assert.equal(
        req.url().includes(waitingToken),
        false,
        "waiting credential must never enter URL",
      );
      const path = url.pathname;
      const json = (value: unknown, status = 200) =>
        route.fulfill({ status, json: value });
      if (path === "/api/config")
        return json({
          appName: "IMON Meets",
          registrationEnabled: true,
          emailDelivery: "external",
          emailConfigured: true,
          emailVerificationRequired: true,
          mediaConfigured: true,
          recordingConfigured: true,
          transcriptionConfigured: true,
          summaryConfigured: true,
        });
      if (path === "/api/me" && req.method() === "DELETE") {
        const body = req.postDataJSON();
        assert.equal(body.confirmation, "DELETE");
        assert.equal(body.password, "Fixture-passphrase-1234");
        if (owned)
          return json(
            {
              error: {
                code: "OWNED_WORKSPACES",
                message:
                  "Сначала передайте или удалите рабочие пространства, которыми владеете.",
              },
            },
            409,
          );
        loggedIn = false;
        return json({ ok: true });
      }
      if (path === "/api/me")
        return loggedIn
          ? json({
              user: {
                id: "suite-user",
                name: "Проверка",
                email: "suite@example.invalid",
                emailVerified: true,
                twoFactorEnabled: mfaEnabled,
              },
              workspaces: workspaceExists
                ? [
                    {
                      id: "ws-suite",
                      name: "Проверка",
                      role: "owner",
                      createdAt,
                    },
                  ]
                : [],
            })
          : json(
              {
                error: {
                  code: "UNAUTHENTICATED",
                  message: "Войдите в аккаунт.",
                },
              },
              401,
            );
      if (path === "/api/auth/sign-in/email")
        return json({ twoFactorRedirect: true, twoFactorMethods: ["totp"] });
      if (path === "/api/auth/two-factor/verify-totp") {
        const body = req.postDataJSON();
        assert.equal(body.trustDevice, false);
        if (body.code !== "123456")
          return json(
            {
              code: "INVALID_TWO_FACTOR_CODE",
              message: "Неверный код. Попробуйте еще раз.",
            },
            401,
          );
        loggedIn = true;
        mfaEnabled = true;
        return json({ user: { id: "suite-user" } });
      }
      if (path === "/api/auth/two-factor/verify-backup-code") {
        assert.equal(req.postDataJSON().code, "test-recovery-code");
        recoveryUsed = true;
        loggedIn = true;
        return json({ user: { id: "suite-user" } });
      }
      if (path === "/api/auth/two-factor/enable")
        return json({
          method: "totp",
          totpURI:
            "otpauth://totp/IMON%20Meets:suite%40example.invalid?secret=JBSWY3DPEHPK3PXP&issuer=IMON%20Meets",
          backupCodes: ["backup-fixture-1", "backup-fixture-2"],
        });
      if (path === "/api/auth/sign-out") {
        loggedIn = false;
        return json({ success: true });
      }
      if (path === "/api/sessions") return json({ sessions: [] });
      if (path === "/api/me/export") {
        exportCount++;
        return json({
          formatVersion: 1,
          profile: { name: "Проверка" },
          messages: [],
        });
      }
      if (path === "/api/workspaces/ws-suite/plan")
        return json({
          plan: {
            id: providerPaymentSucceeded ? "pro" : "pilot",
            name: providerPaymentSucceeded ? "Про" : "Пилот",
            limits: {
              rooms: 200,
              members: 100,
              participants: 100,
              activeRecordings: 2,
              recordingRetentionDays: 30,
              chatRetentionDays: 90,
            },
          },
          usage: {
            rooms: 1,
            members: 1,
            recordingBytes: 1048576,
            activeRecordings: 0,
          },
          billingEnabled,
          testMode: true,
          paidUntil: providerPaymentSucceeded ? expiresAt : null,
          offer: billingEnabled
            ? {
                id: "pro",
                name: "Про",
                amountKopecks: 99900,
                currency: "RUB",
                periodDays: 30,
                limits: {
                  rooms: 200,
                  members: 100,
                  participants: 100,
                  activeRecordings: 2,
                  recordingRetentionDays: 30,
                  chatRetentionDays: 90,
                },
              }
            : null,
          payments: paymentCreated ? [fixturePayment()] : [],
        });
      if (path === "/api/workspaces/ws-suite/payments") {
        checkoutRequestIds.push(req.postDataJSON().requestId);
        assert.equal(req.postDataJSON().planId, "pro");
        if (checkoutRequestIds.length === 1)
          return json(
            {
              error: {
                code: "PAYMENT_UNAVAILABLE",
                message: "Подготовка платежа не завершилась. Повторите запрос.",
              },
            },
            503,
          );
        paymentCreated = true;
        return json({ payment: fixturePayment() });
      }
      if (path === `/api/workspaces/ws-suite/payments/${paymentId}/refresh`)
        return json({ payment: fixturePayment() });
      if (path === "/api/workspaces/ws-suite/rooms")
        return json({ rooms: [room] });
      if (path === "/api/workspaces/ws-suite/recordings")
        return json({
          recordings: [
            {
              id: "recording-suite",
              roomId: room.id,
              roomTitle: room.title,
              status: "complete",
              startedAt: createdAt,
              endedAt: createdAt,
              sizeBytes: 1048576,
              error: null,
              canManage: true,
              expiresAt,
            },
          ],
        });
      if (
        path ===
        "/api/workspaces/ws-suite/recordings/recording-suite/transcript"
      ) {
        if (req.method() === "DELETE") {
          analysisState = "none";
          return json({ ok: true });
        }
        if (req.method() === "POST") {
          assert.equal(req.postDataJSON().language, "ru");
          assert.equal(req.postDataJSON().summary, true);
          analysisState = "queued";
        }
        return json({
          job:
            analysisState === "none"
              ? null
              : {
                  id: "analysis-suite",
                  status: analysisState,
                  createdAt,
                  completedAt: analysisState === "complete" ? createdAt : null,
                  error: null,
                  ...(analysisState === "complete"
                    ? {
                        text: "Проверенная расшифровка",
                        segments: [
                          { start: 0, end: 5, text: "Проверенная расшифровка" },
                        ],
                        summary: "Итог тестовой встречи",
                        duration: 5,
                      }
                    : {}),
                },
        });
      }
      if (path === "/api/workspaces/ws-suite/members")
        return json({
          members: [
            {
              id: "self",
              userId: "suite-user",
              name: "Проверка",
              email: "suite@example.invalid",
              role: "owner",
            },
          ],
          invitations: [],
        });
      if (path === "/api/workspaces/ws-suite/rooms/room-suite/chat")
        return json({
          messages: [
            {
              id: "9007199254740993",
              identity: "fixture",
              name: "Гость",
              text: "Сохраненное сообщение после встречи",
              createdAt,
            },
          ],
          hasEarlier: false,
          nextCursor: "9007199254740993",
        });
      if (path === `/api/rooms/${roomSlug}`)
        return json({ room, canManage: false });
      if (path === `/api/rooms/${roomSlug}/waiting-status`) {
        assert.equal(req.postDataJSON().waitingToken, waitingToken);
        return json({ status: waitState, expiresAt });
      }
      if (
        path === `/api/rooms/${roomSlug}/waiting` &&
        req.method() === "DELETE"
      ) {
        assert.equal(req.postDataJSON().waitingToken, waitingToken);
        cancelledWaiting = true;
        return json({ ok: true });
      }
      if (path.startsWith("/api/"))
        return json(
          { error: { code: "NOT_FOUND", message: "Не найдено." } },
          404,
        );
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
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("https://suite.invalid/login");
      await page
        .getByLabel("Рабочая почта", { exact: true })
        .fill("suite@example.invalid");
      await page
        .getByLabel("Пароль", { exact: true })
        .fill("Fixture-passphrase-1234");
      await page
        .getByRole("button", { name: "Войти в пространство", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Подтвердите вход" }),
      ).toBeVisible();
      assert.equal(loggedIn, false);
      await page
        .getByLabel("Код из приложения", { exact: true })
        .fill("000000");
      await page
        .getByRole("button", { name: "Подтвердить вход", exact: true })
        .click();
      await expect(page.getByRole("alert")).toHaveText(
        "Неверный код. Попробуйте еще раз.",
      );
      assert.equal(loggedIn, false);
      await page
        .getByRole("button", { name: "Использовать резервный код" })
        .click();
      await page
        .getByLabel("Резервный код", { exact: true })
        .fill("test-recovery-code");
      await page
        .getByRole("button", { name: "Подтвердить вход", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: /Добрый день/ }),
      ).toBeVisible();
      assert.equal(recoveryUsed, true);

      mfaEnabled = false;
      await page.goto("https://suite.invalid/settings");
      await page
        .getByRole("button", { name: "Безопасность", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Настроить второй фактор", exact: true })
        .click();
      const modal = page.getByRole("dialog");
      await modal
        .getByLabel("Текущий пароль", { exact: true })
        .fill("Fixture-passphrase-1234");
      await modal
        .getByRole("button", { name: "Продолжить", exact: true })
        .click();
      await expect(
        modal.getByLabel("Ключ для ручного ввода", { exact: true }),
      ).toHaveValue("JBSWY3DPEHPK3PXP");
      await expect(
        modal.getByRole("img", {
          name: "QR-код для настройки приложения-аутентификатора",
        }),
      ).toBeVisible();
      await expect
        .poll(() =>
          modal
            .locator("canvas")
            .evaluate((canvas) => (canvas as HTMLCanvasElement).width),
        )
        .toBe(224);
      await page.setViewportSize({ width: 320, height: 740 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        "MFA modal fits a narrow phone",
      );
      if (process.env.IMON_CAPTURE_UI)
        await page.screenshot({
          path: "/tmp/imonmeets-suite-mfa-mobile.png",
          fullPage: true,
        });
      await page.setViewportSize({ width: 1280, height: 800 });
      await modal
        .getByLabel("Код из приложения", { exact: true })
        .fill("123456");
      await modal
        .getByRole("button", { name: "Подтвердить код", exact: true })
        .click();
      await expect(
        modal.getByText("backup-fixture-1", { exact: true }),
      ).toBeVisible();
      await expect(
        modal.getByRole("button", { name: "Готово", exact: true }),
      ).toBeDisabled();
      await modal.getByLabel("Я сохранил резервные коды").check();
      await modal.getByRole("button", { name: "Готово", exact: true }).click();
      await expect(
        page.getByText("backup-fixture-1", { exact: true }),
      ).toHaveCount(0);
      assert.equal(externalRequests.length, 0, "QR secret must stay local");

      await page.getByRole("button", { name: "Тариф", exact: true }).click();
      await expect(
        page.getByText("Онлайн-оплата пока недоступна.", { exact: false }),
      ).toBeVisible();
      await expect(page.getByText("30 дней", { exact: true })).toBeVisible();
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        "Plan details fit a phone",
      );
      if (process.env.IMON_CAPTURE_UI)
        await page.screenshot({
          path: "/tmp/imonmeets-suite-plan-mobile.png",
          fullPage: true,
        });
      await page.setViewportSize({ width: 1280, height: 800 });
      billingEnabled = true;
      await page.reload();
      await expect(
        page.getByText("Тестовый режим оплаты", { exact: true }),
      ).toBeVisible();
      await page.setViewportSize({ width: 320, height: 740 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        "Paid offer fits a narrow phone",
      );
      if (process.env.IMON_CAPTURE_UI)
        await page.screenshot({
          path: "/tmp/imonmeets-suite-checkout-mobile.png",
          fullPage: true,
        });
      await page.setViewportSize({ width: 1280, height: 800 });
      await page
        .getByRole("button", { name: "Проверить тестовую оплату", exact: true })
        .click();
      await expect(page.getByRole("alert")).toHaveText(
        "Подготовка платежа не завершилась. Повторите запрос.",
      );
      await page.reload();
      await page
        .getByRole("button", { name: "Проверить тестовую оплату", exact: true })
        .click();
      await page.waitForURL("https://yoomoney.ru/fixture-checkout");
      assert.equal(checkoutRequestIds.length, 2);
      assert.equal(
        checkoutRequestIds[0],
        checkoutRequestIds[1],
        "ambiguous checkout retry must reuse the same idempotency ID after reload",
      );
      await page.goto(
        `https://suite.invalid/settings?section=plan&workspace=ws-suite&payment=${paymentId}`,
      );
      await expect(
        page.getByText("Ожидает оплаты", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: "Есть незавершенный платеж",
          exact: true,
        }),
      ).toBeDisabled();
      await expect(
        page.getByText("Тестовый платеж подтвержден", { exact: true }),
      ).toHaveCount(0);
      providerPaymentSucceeded = true;
      await page
        .getByRole("button", { name: "Проверить статус", exact: true })
        .click();
      await expect(
        page.getByText("Тестовый платеж подтвержден", { exact: true }),
      ).toBeVisible();
      assert.equal(
        await page.evaluate(() =>
          sessionStorage.getItem("imon.checkout.ws-suite"),
        ),
        null,
      );
      await page
        .getByRole("button", { name: "Мои данные", exact: true })
        .click();
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: "Скачать мои данные" }).click();
      assert.match(
        (await download).suggestedFilename(),
        /^imonmeets-data-.*\.json$/,
      );
      assert.equal(exportCount, 1);
      await page
        .getByRole("button", { name: "Удалить аккаунт", exact: true })
        .click();
      await expect(
        modal.getByRole("button", { name: "Удалить навсегда", exact: true }),
      ).toBeDisabled();
      await modal
        .getByLabel("Текущий пароль", { exact: true })
        .fill("Fixture-passphrase-1234");
      await modal.getByLabel("Введите DELETE для подтверждения").fill("DELETE");
      await modal
        .getByRole("button", { name: "Удалить навсегда", exact: true })
        .click();
      await expect(modal.getByRole("alert")).toHaveText(
        "Сначала передайте или удалите рабочие пространства, которыми владеете.",
      );
      await modal.getByRole("button", { name: "Отмена", exact: true }).click();

      await page.goto("https://suite.invalid/rooms");
      await page
        .getByRole("button", { name: "История чата: Проверка сценариев" })
        .click();
      await expect(
        modal.getByText("Сохраненное сообщение после встречи"),
      ).toBeVisible();
      await modal
        .getByRole("button", { name: "Закрыть", exact: true })
        .last()
        .click();

      await page.goto("https://suite.invalid/recordings");
      await page
        .getByRole("button", { name: "Расшифровка", exact: true })
        .click();
      await expect(
        modal.getByRole("heading", { name: "Расшифровка еще не создана" }),
      ).toBeVisible();
      await modal.getByLabel("Язык записи").selectOption("ru");
      await modal.getByRole("checkbox", { name: /Добавить AI-резюме/ }).check();
      await modal
        .getByRole("button", { name: "Создать расшифровку", exact: true })
        .click();
      await expect(
        modal.getByText("Запись в очереди", { exact: true }),
      ).toBeVisible();
      analysisState = "complete";
      await modal
        .getByRole("button", { name: "Проверить состояние", exact: true })
        .click();
      await expect(
        modal.getByText("Проверенная расшифровка", { exact: true }),
      ).toBeVisible();
      await expect(
        modal.getByText("Итог тестовой встречи", { exact: true }),
      ).toBeVisible();
      const transcriptDownload = page.waitForEvent("download");
      await modal
        .getByRole("button", { name: "Скачать текст", exact: true })
        .click();
      assert.equal(
        (await transcriptDownload).suggestedFilename(),
        "imonmeets-transcript-recording-suite.txt",
      );
      await modal
        .getByRole("button", { name: "Удалить расшифровку", exact: true })
        .click();
      await modal
        .getByRole("button", { name: "Удалить расшифровку", exact: true })
        .click();
      await expect(
        modal.getByRole("heading", { name: "Расшифровка еще не создана" }),
      ).toBeVisible();
      await modal
        .getByRole("button", { name: "Закрыть", exact: true })
        .last()
        .click();

      // Account deletion remains reachable after the last workspace has gone.
      workspaceExists = false;
      owned = false;
      await page.goto("https://suite.invalid/");
      await page
        .getByRole("button", { name: "Мой аккаунт", exact: true })
        .click();
      await page.setViewportSize({ width: 320, height: 740 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        "Account controls fit a narrow phone without a workspace",
      );
      if (process.env.IMON_CAPTURE_UI)
        await page.screenshot({
          path: "/tmp/imonmeets-suite-account-mobile.png",
          fullPage: true,
        });
      await page.setViewportSize({ width: 1280, height: 800 });
      await page
        .getByRole("button", { name: "Удалить аккаунт", exact: true })
        .click();
      await modal
        .getByLabel("Текущий пароль", { exact: true })
        .fill("Fixture-passphrase-1234");
      await modal.getByLabel("Введите DELETE для подтверждения").fill("DELETE");
      await modal
        .getByRole("button", { name: "Удалить навсегда", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Войти", exact: true }),
      ).toBeVisible();

      await page.evaluate(
        ({ slug, token, expiresAt }) =>
          sessionStorage.setItem(
            `imon.waiting.${slug}`,
            JSON.stringify({
              status: "waiting",
              requestId: "waiting-fixture",
              waitingToken: token,
              expiresAt,
              name: "Гость",
              accountId: null,
            }),
          ),
        { slug: roomSlug, token: waitingToken, expiresAt },
      );
      await page.goto(`https://suite.invalid/join/${roomSlug}`);
      await expect(
        page.getByRole("heading", { name: "Ждем разрешения организатора" }),
      ).toBeVisible();
      await expect(page.locator(".live-room")).toHaveCount(0);
      await page
        .getByRole("button", { name: "Отменить запрос", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: room.title, exact: true }),
      ).toBeVisible();
      assert.equal(cancelledWaiting, true);
      assert.equal(
        await page.evaluate(
          (slug) => sessionStorage.getItem(`imon.waiting.${slug}`),
          roomSlug,
        ),
        null,
      );

      await page.evaluate(
        ({ slug, token, expiresAt }) =>
          sessionStorage.setItem(
            `imon.waiting.${slug}`,
            JSON.stringify({
              status: "waiting",
              requestId: "denied-fixture",
              waitingToken: token,
              expiresAt,
              name: "Гость",
              accountId: null,
            }),
          ),
        { slug: roomSlug, token: waitingToken, expiresAt },
      );
      waitState = "denied";
      await page.reload();
      await expect(
        page.getByRole("heading", { name: "Организатор отклонил запрос" }),
      ).toBeVisible();
      await page.setViewportSize({ width: 320, height: 740 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
      await browser.close();
    }
  },
);
