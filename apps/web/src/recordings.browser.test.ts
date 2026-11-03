import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, expect } from "@playwright/test";
import type { Recording } from "./api";

test(
  "browser: recording pages preserve visible history, recover from failure, and discard canceled or foreign workspace responses",
  { skip: !process.env.IMON_BROWSER_EXECUTABLE, timeout: 120_000 },
  async () => {
    const built = await build({
      root: fileURLToPath(new URL("..", import.meta.url)),
      configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
      logLevel: "silent",
      build: { write: false, sourcemap: false },
    });
    const output = Array.isArray(built) ? built[0] : built;
    if (!("output" in output)) throw new Error("Missing fixture bundle");
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
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const workspace = randomUUID(),
      otherWorkspace = randomUUID();
    let recordings: Recording[] = Array.from({ length: 205 }, (_, i) => ({
      id: randomUUID(),
      roomId: "fixture-room",
      roomTitle: `Recording ${String(i + 1).padStart(3, "0")}`,
      status: "complete",
      startedAt: "2026-11-03T00:00:00Z",
      endedAt: "2026-11-03T01:00:00Z",
      sizeBytes: 1000,
      error: null,
      canManage: true,
    }));
    recordings.at(-1)!.status = "ending";
    const otherRecording = {
      ...recordings[0]!,
      id: randomUUID(),
      roomTitle: "Other workspace recording",
    };
    const requestPages: string[] = [],
      unexpected: string[] = [];
    let failAppend = true,
      deferThird = false,
      deferFirst = false;
    let pendingStarted: (() => void) | undefined,
      releasePending: (() => void) | undefined;
    const holdNext = () => {
      const started = new Promise<void>((resolve) => {
        pendingStarted = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releasePending = resolve;
      });
      return { started, release };
    };
    let held = holdNext();
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url()),
        path = url.pathname;
      if (url.origin !== "https://recording-pages.invalid") {
        unexpected.push(url.origin);
        return route.abort();
      }
      const json = (value: unknown, status = 200) =>
        route.fulfill({ json: value, status });
      if (path === "/api/config")
        return json({
          appName: "IMON Meets",
          registrationEnabled: false,
          emailVerificationRequired: false,
          emailConfigured: false,
          emailDelivery: "capture",
          mediaConfigured: false,
          recordingConfigured: true,
        });
      if (path === "/api/me")
        return json({
          user: {
            id: "fixture-owner",
            name: "Recording owner",
            email: "fixture@example.test",
            emailVerified: true,
          },
          workspaces: [
            {
              id: workspace,
              name: "Recording fixture",
              role: "owner",
              createdAt: "2026-11-03T00:00:00Z",
            },
            {
              id: otherWorkspace,
              name: "Other workspace",
              role: "owner",
              createdAt: "2026-11-03T00:00:00Z",
            },
          ],
        });
      if (path === `/api/workspaces/${otherWorkspace}/recordings`)
        return json({ recordings: [otherRecording], nextCursor: null });
      if (path === `/api/workspaces/${workspace}/recordings`) {
        const before = url.searchParams.get("before");
        requestPages.push(before ?? "first");
        if (before && failAppend) {
          failAppend = false;
          return json(
            {
              error: {
                code: "FIXTURE_FAILURE",
                message: "Temporary recording history failure",
              },
            },
            503,
          );
        }
        const start = before
          ? recordings.findIndex((r) => r.id === before) + 1
          : 0;
        const page = recordings.slice(start, start + 100);
        const payload = {
          recordings: page.map((r) => ({ ...r })),
          nextCursor: start + 100 < recordings.length ? page.at(-1)!.id : null,
        };
        if ((deferThird && start === 200) || (deferFirst && !before)) {
          deferThird = false;
          deferFirst = false;
          pendingStarted?.();
          await held.release;
          try {
            return await json(payload);
          } catch {
            return;
          } // The browser may have aborted this obsolete request.
        }
        return json(payload);
      }
      const deleted = recordings.find(
        (r) => path === `/api/workspaces/${workspace}/recordings/${r.id}`,
      );
      if (deleted && route.request().method() === "DELETE") {
        recordings = recordings.filter((r) => r.id !== deleted.id);
        return json({ ok: true, deletionPending: false });
      }
      if (path.startsWith("/api/")) {
        unexpected.push(path);
        return json(
          { error: { code: "NOT_FOUND", message: "Fixture route missing" } },
          404,
        );
      }
      return route.fulfill({
        body: assets.get(path.slice(1)) ?? assets.get("index.html")!,
        contentType: path.endsWith(".js")
          ? "text/javascript"
          : path.endsWith(".css")
            ? "text/css"
            : "text/html",
      });
    });
    try {
      const page = await context.newPage();
      await page.clock.install();
      await page.goto("https://recording-pages.invalid/recordings");
      const rows = page.locator(".workspace-recording-row");
      const more = page.getByRole("button", {
        name: /Показать еще$/,
      });
      await expect(rows).toHaveCount(100);
      await expect(page.locator(".workspace-count")).toHaveText("100+");
      await more.click();
      await expect(
        page.getByText("Temporary recording history failure", { exact: true }),
      ).toBeVisible();
      await expect(rows).toHaveCount(100);
      await more.click();
      await expect(rows).toHaveCount(200);
      await expect(page.locator(".workspace-count")).toHaveText("200+");

      // A new refresh supersedes the pending third page; its late answer cannot append.
      deferThird = true;
      const heldRequest = page.waitForRequest(
        (r) =>
          new URL(r.url()).searchParams.get("before") === recordings[199]!.id,
      );
      await more.click();
      await held.started;
      const obsolete = await heldRequest;
      await expect(more).toBeDisabled();
      await page.getByRole("button", { name: "Обновить", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Обновить", exact: true }),
      ).toBeEnabled();
      releasePending?.();
      await obsolete.response();
      await expect(rows).toHaveCount(200);
      await more.click();
      await expect(rows).toHaveCount(205);
      await expect(more).toHaveCount(0);

      // Deleting within expanded history refreshes its loaded pages and keeps the rest visible.
      await page
        .getByRole("button", {
          name: "Удалить запись: Recording 150",
          exact: true,
        })
        .click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Удалить запись", exact: true })
        .click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(rows).toHaveCount(204);
      await expect(
        page.getByRole("heading", { name: "Recording 205", exact: true }),
      ).toBeVisible();
      assert.equal(
        await rows
          .locator("h3")
          .evaluateAll(
            (items) => new Set(items.map((item) => item.textContent)).size,
          ),
        204,
      );

      // Polling updates an older loaded page without resetting expanded history.
      const lastRow = rows.filter({
        has: page.getByRole("heading", { name: "Recording 205", exact: true }),
      });
      await expect(lastRow.locator(".workspace-status")).toHaveText(
        "Обрабатывается",
      );
      recordings.at(-1)!.status = "complete";
      await page.clock.fastForward(10_001);
      await expect(lastRow.locator(".workspace-status")).toHaveText("Готова");
      await expect(rows).toHaveCount(204);

      // An obsolete workspace response must not replace the newly selected workspace.
      held = holdNext();
      deferFirst = true;
      await page.getByRole("button", { name: "Обновить", exact: true }).click();
      await held.started;
      await page
        .getByLabel("Рабочее пространство", { exact: true })
        .selectOption(otherWorkspace);
      await expect(rows).toHaveCount(1);
      await expect(rows.locator("h3")).toHaveText("Other workspace recording");
      releasePending?.();
      await expect(rows.locator("h3")).toHaveText("Other workspace recording");
      await expect(more).toHaveCount(0);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      assert.equal(unexpected.length, 0, JSON.stringify(unexpected));
      assert(
        requestPages.length < 20,
        "paging must not create an unbounded request loop",
      );
    } finally {
      releasePending?.();
      await context.close();
      await browser.close();
    }
  },
);
