import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, expect } from "@playwright/test";

test(
  "browser: bounded meeting pages, archive, preserved history and restore",
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
    const browser = await chromium.launch({
      executablePath: process.env.IMON_BROWSER_EXECUTABLE,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const context = await browser.newContext();
    const w = "ae0bbf92-f8cf-40ee-92e6-85beeb254974";
    const makeRoom = (index: number, status: "closed" | "open") => ({
      id: randomUUID(),
      workspaceId: w,
      slug: randomUUID(),
      title:
        status === "open"
          ? "Open primary"
          : `History ${String(index).padStart(3, "0")}`,
      description: "",
      startsAt: null,
      durationMinutes: 60,
      allowGuests: true,
      waitingRoom: true,
      maxParticipants: 25,
      status,
      createdBy: "fixture-owner",
      createdAt: "2026-11-03T00:00:00Z",
      archivedAt: null as string | null,
    });
    const rooms = [
      makeRoom(0, "open"),
      ...Array.from({ length: 205 }, (_, i) => makeRoom(i + 1, "closed")),
    ];
    const archiveRequests: string[] = [];
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url()),
        path = url.pathname;
      if (url.origin !== "https://room-fixture.invalid") return route.abort();
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
          recordingConfigured: false,
        });
      if (path === "/api/me")
        return json({
          user: {
            id: "fixture-owner",
            name: "Room owner",
            email: "fixture@example.test",
            emailVerified: true,
          },
          workspaces: [
            {
              id: w,
              name: "Room fixture",
              role: "owner",
              createdAt: "2026-11-03T00:00:00Z",
            },
          ],
        });
      if (path === `/api/workspaces/${w}/rooms`) {
        const view = url.searchParams.get("view") ?? "all",
          q = url.searchParams.get("q")?.toLowerCase() ?? "";
        const selected = rooms.filter(
          (r) =>
            (view === "all" ||
              (view === "archived"
                ? Boolean(r.archivedAt)
                : r.status === view && !r.archivedAt)) &&
            r.title.toLowerCase().includes(q),
        );
        const before = url.searchParams.get("before"),
          start = before ? selected.findIndex((r) => r.id === before) + 1 : 0;
        const page = selected.slice(start, start + 100);
        return json({
          rooms: page,
          nextCursor: start + 100 < selected.length ? page.at(-1)!.id : null,
        });
      }
      const room = rooms.find((r) =>
        path.startsWith(`/api/workspaces/${w}/rooms/${r.id}/`),
      );
      if (room && /\/(?:archive|unarchive)$/.test(path)) {
        archiveRequests.push(path);
        room.archivedAt = path.endsWith("/unarchive")
          ? null
          : "2026-11-03T01:00:00Z";
        return json({ room });
      }
      if (room && path.endsWith("/chat"))
        return json({
          messages: [
            {
              id: "1",
              identity: "fixture",
              name: "Owner",
              text: "Kept history after archive",
              createdAt: "2026-11-03T00:00:00Z",
            },
          ],
          nextCursor: "1",
          hasEarlier: false,
          hasMore: false,
        });
      if (path.startsWith("/api/"))
        return json(
          { error: { code: "NOT_FOUND", message: "Fixture route not found" } },
          404,
        );
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
      await page.goto("https://room-fixture.invalid/rooms");
      await expect(
        page.getByRole("heading", { name: "Open primary", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Завершенные", exact: true })
        .click();
      await expect(page.locator(".room-row")).toHaveCount(100);
      await page
        .getByRole("button", { name: "Показать еще", exact: true })
        .click();
      await expect(page.locator(".room-row")).toHaveCount(200);
      await page
        .getByRole("button", { name: "Показать еще", exact: true })
        .click();
      await expect(page.locator(".room-row")).toHaveCount(205);
      await expect(
        page.getByRole("button", { name: "Показать еще", exact: true }),
      ).toHaveCount(0);
      await page.getByLabel("Найти встречу").fill("History 001");
      await expect(page.locator(".room-row")).toHaveCount(1);
      await page.getByRole("button", { name: "В архив", exact: true }).click();
      await expect(page.locator(".room-row")).toHaveCount(0);
      await page.getByRole("button", { name: "Архив", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "History 001", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "История чата: History 001", exact: true })
        .click();
      await expect(
        page.getByText("Kept history after archive", { exact: true }),
      ).toBeVisible();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Закрыть", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Вернуть из архива", exact: true })
        .click();
      await expect(page.locator(".room-row")).toHaveCount(0);
      await page
        .getByRole("button", { name: "Завершенные", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "History 001", exact: true }),
      ).toBeVisible();
      assert.equal(archiveRequests.length, 2);
      assert.equal(
        rooms.find((r) => r.title === "History 001")!.status,
        "closed",
      );
      assert.equal(rooms.filter((r) => r.status === "open").length, 1);
    } finally {
      await context.close();
      await browser.close();
    }
  },
);
