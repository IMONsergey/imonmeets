import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, expect } from "@playwright/test";

test(
  "explicit legal choice, stale edition recovery, privacy access and preserved invitation intent",
  { skip: !process.env.IMON_BROWSER_EXECUTABLE, timeout: 90000 },
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
    const context = await browser.newContext({
      viewport: { width: 320, height: 800 },
    });
    let signedIn = true,
      accepted = false,
      version = 1,
      posts = 0,
      saved = 0,
      invitationAccepts = 0;
    let hasWorkspace = false,
      recordingActive = true,
      recordingStops = 0;
    let changeOnPost = true;
    const edition = () => ({
      version: "synthetic-v" + version,
      publishedAt: "2026-01-01T00:00:00Z",
      manifestSha256: String(version).repeat(64),
      termsSha256: "a".repeat(64),
      privacySha256: "b".repeat(64),
    });
    const receipt = () => ({
      ...edition(),
      id: "synthetic-receipt",
      acceptedAt: "2026-11-03T12:00:00Z",
      evidenceSchema: "explicit-account-v1",
      termsAccepted: true,
      privacyAcknowledged: true,
    });
    const status = () => ({
      required: true,
      accepted,
      current: edition(),
      receipt: accepted ? receipt() : null,
    });
    const documents = () => ({
      schema: 1,
      version: edition().version,
      publishedAt: edition().publishedAt,
      operator: {
        name: "Synthetic operator",
        registration: "fixture registration",
        address: "fixture address",
      },
      terms: {
        title: "Условия использования",
        sections: [
          {
            heading: "Тестовый документ",
            paragraphs: ["<img src=x onerror=alert(1)>"],
          },
        ],
      },
      privacy: {
        title: "Политика обработки данных",
        sections: [
          {
            heading: "Данные",
            paragraphs: ["Synthetic privacy notice, version " + version],
          },
        ],
      },
    });
    await context.route("**/*", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin !== "https://consent.invalid") return route.abort();
      if (url.pathname === "/api/config")
        return route.fulfill({
          json: {
            appName: "IMON Meets",
            registrationEnabled: true,
            emailVerificationRequired: true,
            emailConfigured: false,
            emailDelivery: "capture",
            mediaConfigured: false,
            recordingConfigured: true,
            publicInformation: {
              supportEmail: null,
              supportHours: null,
              legalVersion: edition().version,
              legalPublishedAt: edition().publishedAt,
              legalManifestSha256: edition().manifestSha256,
              legalAcceptanceRequired: true,
              operatorName: "Synthetic operator",
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
                },
                workspaces: hasWorkspace
                  ? [
                      {
                        id: "w1",
                        name: "Synthetic workspace",
                        role: "owner",
                        createdAt: "2026-01-01T00:00:00Z",
                      },
                    ]
                  : [],
                legalConsent: status(),
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
      if (url.pathname === "/api/me/legal-consent") {
        if (request.method() === "GET")
          return route.fulfill({
            json: { ...status(), documents: documents() },
          });
        posts++;
        const body = request.postDataJSON();
        assert.equal(body.termsAccepted, true);
        assert.equal(body.privacyAcknowledged, true);
        assert.equal("userId" in body, false);
        assert.equal("acceptedAt" in body, false);
        if (changeOnPost) {
          changeOnPost = false;
          version++;
          return route.fulfill({
            status: 409,
            json: {
              error: {
                code: "LEGAL_VERSION_CHANGED",
                message: "Документы обновились.",
              },
            },
          });
        }
        assert.equal(body.version, edition().version);
        assert.equal(body.manifestSha256, edition().manifestSha256);
        assert.equal(body.termsSha256, edition().termsSha256);
        assert.equal(body.privacySha256, edition().privacySha256);
        accepted = true;
        saved++;
        return route.fulfill({ json: { accepted: true, receipt: receipt() } });
      }
      if (url.pathname === "/api/auth/sign-out") {
        signedIn = false;
        return route.fulfill({ json: { success: true } });
      }
      if (url.pathname === "/api/invitations/accept") {
        invitationAccepts++;
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: "SYNTHETIC_ONLY",
              message: "Fixture does not accept invitations",
            },
          },
        });
      }
      if (url.pathname === "/api/workspaces/w1/recordings")
        return route.fulfill({
          json: {
            recordings: [
              {
                id: "r1",
                roomId: "room1",
                roomTitle: "Synthetic recording",
                status: recordingActive ? "active" : "complete",
                startedAt: "2026-11-03T10:00:00Z",
                endedAt: null,
                sizeBytes: 1024,
                error: null,
                canManage: true,
              },
            ],
          },
        });
      if (url.pathname === "/api/workspaces/w1/recordings/r1/stop") {
        recordingStops++;
        recordingActive = false;
        return route.fulfill({ json: { ok: true } });
      }
      if (url.pathname.startsWith("/api/"))
        return route.fulfill({
          status: 404,
          json: {
            error: {
              code: "NOT_FOUND",
              message: "Fixture endpoint unavailable",
            },
          },
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
      const invitation =
        "https://consent.invalid/invite#token=synthetic-invitation-intent";
      await page.goto(invitation);
      await expect(
        page.getByRole("heading", { name: "Документы и ваш выбор" }),
      ).toBeVisible();
      const confirm = page.getByRole("button", {
        name: "Подтвердить выбор и продолжить",
      });
      await expect(confirm).toBeDisabled();
      await expect(page.getByRole("checkbox")).toHaveCount(2);
      for (const checkbox of await page.getByRole("checkbox").all())
        await expect(checkbox).not.toBeChecked();
      assert.equal(posts, 0);
      assert.equal(saved, 0);
      await page
        .locator("summary")
        .filter({ hasText: "Условия использования" })
        .click();
      await expect(
        page.getByText("<img src=x onerror=alert(1)>", { exact: true }),
      ).toBeVisible();
      assert.equal(await page.locator("img[src='x']").count(), 0);
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        "no horizontal overflow at 320px",
      );
      const screenshotPrefix =
        process.env.IMON_CONSENT_SCREENSHOT_PREFIX || "/tmp/imon-consent";
      await page.screenshot({
        path: screenshotPrefix + "-320.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 1360, height: 1000 });
      await page.screenshot({
        path: screenshotPrefix + "-desktop.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 320, height: 800 });
      await page.getByRole("checkbox").nth(0).check();
      await expect(confirm).toBeDisabled();
      await page.getByRole("checkbox").nth(1).check();
      await confirm.click();
      await expect(
        page.getByText(
          "Документы обновились. Прочитайте новую версию и отметьте свой выбор заново.",
        ),
      ).toBeVisible();
      await expect(page.getByRole("checkbox").nth(0)).toHaveAccessibleName(
        /synthetic-v2/,
      );
      for (const checkbox of await page.getByRole("checkbox").all())
        await expect(checkbox).not.toBeChecked();
      await expect(confirm).toBeDisabled();
      assert.equal(posts, 1);
      assert.equal(
        saved,
        0,
        "a rejected stale post is never automatic acceptance of the new edition",
      );
      await page
        .getByRole("link", { name: "Мои данные и удаление аккаунта" })
        .click();
      await expect(
        page.getByRole("heading", { name: "Мои данные", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Скачать мои данные" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Удалить аккаунт", exact: true }),
      ).toBeVisible();
      assert.equal(saved, 0);
      hasWorkspace = true;
      await page.goto("https://consent.invalid/recordings");
      await expect(
        page.getByRole("button", { name: "Остановить", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Остановить", exact: true })
        .click();
      await expect.poll(() => recordingStops).toBe(1);
      await expect(
        page.getByRole("button", {
          name: "Удалить запись: Synthetic recording",
          exact: true,
        }),
      ).toBeVisible();
      assert.equal(
        saved,
        0,
        "safe departure can stop and remove recordings without accepting new documents",
      );
      hasWorkspace = false;
      await page.goto(invitation);
      await expect(page.getByRole("checkbox")).toHaveCount(2);
      await page.getByRole("checkbox").nth(0).check();
      await page.getByRole("checkbox").nth(1).check();
      await page
        .getByRole("button", { name: "Подтвердить выбор и продолжить" })
        .click();
      await expect(
        page.getByRole("heading", { name: "Приглашение в пространство" }),
      ).toBeVisible();
      assert.equal(
        page.url(),
        invitation,
        "the original invitation fragment survives consent",
      );
      await expect(
        page.getByRole("button", { name: "Присоединиться к команде" }),
      ).toBeVisible();
      assert.equal(
        invitationAccepts,
        0,
        "document choice must not implicitly accept the invitation",
      );
      assert.equal(saved, 1);
      assert.equal(posts, 2);
      accepted = false;
      version++;
      await page.reload();
      await expect(
        page.getByRole("heading", { name: "Документы и ваш выбор" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Не принимать и выйти" }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/login");
      assert.equal(posts, 2);
      assert.equal(saved, 1);
    } finally {
      await browser.close();
    }
  },
);
