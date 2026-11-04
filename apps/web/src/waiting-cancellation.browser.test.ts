import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { build } from "vite";
import { chromium, expect, type Page } from "@playwright/test";

const fixtureEntry = "virtual:imon-waiting-cancellation";
const fixtureSource = `
import React from "react";
import { createRoot } from "react-dom/client";
import { Join } from ${JSON.stringify(fileURLToPath(new URL("./pages/Join.tsx", import.meta.url)))};
import "@livekit/components-styles";
import ${JSON.stringify(fileURLToPath(new URL("./styles.css", import.meta.url)))};
import ${JSON.stringify(fileURLToPath(new URL("./styles/auth.css", import.meta.url)))};
import ${JSON.stringify(fileURLToPath(new URL("./styles/call.css", import.meta.url)))};

const slug = "waiting-cancellation-fixture";
const requests = [];
const states = [];
const notifications = [];
let callMounts = 0;
const observer = new MutationObserver((records) => {
  for (const record of records)
    for (const node of record.addedNodes)
      if (node instanceof Element &&
          (node.matches(".call-page") || node.querySelector(".call-page")))
        callMounts++;
});
observer.observe(document.body, { childList: true, subtree: true });
const grant = {
  status: "waiting",
  requestId: "waiting-fixture",
  waitingToken: "synthetic-waiting-token-not-a-real-credential",
  expiresAt: new Date(Date.now() + 600000).toISOString(),
  name: "Synthetic guest",
  accountId: null,
};
sessionStorage.setItem("imon.waiting." + slug, JSON.stringify(grant));
const request = (path, body, method, options) => {
  if (path === "/rooms/" + slug)
    return Promise.resolve({
      room: {
        title: "Cancellation fixture", description: "", startsAt: null,
        durationMinutes: 60, allowGuests: true, waitingRoom: true,
        maxParticipants: 5, status: "open"
      },
      canManage: false
    });
  return new Promise((resolve, reject) => {
    const item = {
      path, method: method ?? (body ? "POST" : "GET"),
      settled: false, aborted: Boolean(options?.signal?.aborted),
      resolve(value) { item.settled = true; resolve(value); },
      reject(message) { item.settled = true; reject(new Error(message)); }
    };
    // Preserve completion after abort deliberately: a response may already be
    // queued. Production must also reject stale completion, not rely only on I/O.
    options?.signal?.addEventListener("abort", () => { item.aborted = true; });
    requests.push(item);
  });
};
window.waitingFixture = {
  snapshot() {
    return {
      requests: requests.map(({ path, method, settled, aborted }) =>
        ({ path, method, settled, aborted })),
      states: [...states], notifications: [...notifications], callMounts
    };
  },
  settle(suffix, value, reject = false) {
    const item = requests.find((r) => !r.settled && r.path.endsWith(suffix));
    if (!item) throw new Error("No pending fixture request for " + suffix);
    if (reject) item.reject(value);
    else item.resolve(value);
  }
};
createRoot(document.getElementById("root")).render(
  React.createElement(Join, {
    slug,
    config: {
      appName: "IMON Meets", registrationEnabled: false,
      emailVerificationRequired: false, emailConfigured: false,
      emailDelivery: "capture", mediaConfigured: true,
      recordingConfigured: false
    },
    request,
    notify: (message) => notifications.push(message),
    onStateChange: (state) => states.push(state)
  })
);
`;

type Snapshot = {
  requests: {
    path: string;
    method: string;
    settled: boolean;
    aborted: boolean;
  }[];
  states: string[];
  notifications: string[];
  callMounts: number;
};
type Fixture = {
  snapshot: () => Snapshot;
  settle: (suffix: string, value: unknown, reject?: boolean) => void;
};
declare global {
  interface Window {
    waitingFixture: Fixture;
  }
}

async function snapshot(page: Page) {
  return page.evaluate(() => window.waitingFixture.snapshot());
}
async function settle(
  page: Page,
  suffix: string,
  value: unknown,
  reject = false,
) {
  await page.evaluate(
    ({ suffix, value, reject }) =>
      window.waitingFixture.settle(suffix, value, reject),
    { suffix, value, reject },
  );
  // Flush the actual React update and MutationObserver, without network timing
  // or arbitrary sleeps. Responses themselves are explicitly deferred above.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

test(
  "waiting cancellation cannot initiate or complete media admission",
  {
    skip: !process.env.IMON_BROWSER_EXECUTABLE,
    timeout: 120_000,
  },
  async (t) => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const result = await build({
      root,
      configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
      logLevel: "silent",
      plugins: [
        {
          name: "waiting-cancellation-fixture",
          resolveId(id) {
            if (id === fixtureEntry) return "\0" + fixtureEntry;
          },
          load(id) {
            if (id === "\0" + fixtureEntry) return fixtureSource;
          },
        },
      ],
      build: {
        write: false,
        sourcemap: false,
        rollupOptions: { input: fixtureEntry },
      },
    });
    const output = Array.isArray(result) ? result[0] : result;
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
    const entry = output.output.find(
      (item) => item.type === "chunk" && item.isEntry,
    );
    if (!entry) throw new Error("Missing fixture entry");
    const styles = [...assets.keys()].filter((name) => name.endsWith(".css"));
    const html =
      '<!doctype html><html lang="ru"><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      styles
        .map((name) => '<link rel="stylesheet" href="/' + name + '">')
        .join("") +
      '<body><div id="root"></div><script type="module" src="/' +
      entry.fileName +
      '"></script></body></html>';
    const browser = await chromium.launch({
      executablePath: process.env.IMON_BROWSER_EXECUTABLE,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const evidence: Record<string, Snapshot> = {};
    try {
      for (const scenario of [
        "normal-admission",
        "poll-after-cancel",
        "grant-after-cancel",
        "cancel-failure",
      ] as const) {
        await t.test(scenario, async () => {
          const context = await browser.newContext({
            viewport: { width: 390, height: 844 },
          });
          try {
            await context.addInitScript(() => {
              // This regression never reads physical devices.
              navigator.mediaDevices.getUserMedia = async () => {
                throw new DOMException(
                  "Synthetic fixture denies capture",
                  "NotAllowedError",
                );
              };
            });
            await context.routeWebSocket("**/*", (socket) => socket.close());
            await context.route("**/*", (route) => {
              const url = new URL(route.request().url());
              if (url.origin !== "https://waiting-fixture.invalid")
                return route.abort();
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
            await page.goto("https://waiting-fixture.invalid/");
            await expect(
              page.getByRole("heading", {
                name: "Ждем разрешения организатора",
              }),
            ).toBeVisible();
            await expect
              .poll(
                async () =>
                  (await snapshot(page)).requests.filter((r) =>
                    r.path.endsWith("/waiting-status"),
                  ).length,
              )
              .toBe(1);
            if (scenario === "normal-admission") {
              await settle(page, "/waiting-status", {
                status: "admitted",
                expiresAt: new Date(Date.now() + 600000).toISOString(),
              });
              await expect
                .poll(
                  async () =>
                    (await snapshot(page)).requests.filter((r) =>
                      r.path.endsWith("/join"),
                    ).length,
                )
                .toBe(1);
              await settle(page, "/join", {
                status: "joined",
                token: "synthetic-unusable-token",
                serverUrl: "wss://blocked-media.invalid",
                roomName: "fixture",
                canManage: false,
              });
              const admitted = await snapshot(page);
              evidence[scenario] = admitted;
              assert.equal(
                admitted.states.includes("connecting"),
                true,
                "Ordinary uncancelled admission must still enter the call flow",
              );
              return;
            }
            if (scenario === "grant-after-cancel") {
              await settle(page, "/waiting-status", {
                status: "admitted",
                expiresAt: new Date(Date.now() + 600000).toISOString(),
              });
              await expect
                .poll(
                  async () =>
                    (await snapshot(page)).requests.filter((r) =>
                      r.path.endsWith("/join"),
                    ).length,
                )
                .toBe(1);
            }
            await page
              .getByRole("button", { name: "Отменить запрос", exact: true })
              .click();
            await expect
              .poll(
                async () =>
                  (await snapshot(page)).requests.filter(
                    (r) => r.path.endsWith("/waiting") && r.method === "DELETE",
                  ).length,
              )
              .toBe(1);
            if (scenario !== "grant-after-cancel") {
              await settle(page, "/waiting-status", {
                status: scenario === "cancel-failure" ? "waiting" : "admitted",
                expiresAt: new Date(Date.now() + 600000).toISOString(),
              });
            } else {
              await settle(page, "/join", {
                status: "joined",
                token: "synthetic-unusable-token",
                serverUrl: "wss://blocked-media.invalid",
                roomName: "fixture",
                canManage: false,
              });
            }
            const afterLate = await snapshot(page);
            assert.equal(
              await page.evaluate(() =>
                sessionStorage.getItem(
                  "imon.waiting.waiting-cancellation-fixture",
                ),
              ),
              null,
              "Cancel intent must not resume automatically after reloading",
            );
            assert.equal(
              afterLate.requests
                .filter(
                  (r) =>
                    r.path.endsWith("/waiting-status") ||
                    r.path.endsWith("/join"),
                )
                .every((r) => r.aborted),
              true,
              "Cancel must abort every pending admission request before its response",
            );
            evidence[scenario + "-late"] = afterLate;
            assert.equal(
              afterLate.states.includes("connecting"),
              false,
              "Cancel must never transition into media connection from a late grant",
            );
            assert.equal(
              afterLate.callMounts,
              0,
              "Cancel must never mount LiveKitRoom from a late grant",
            );
            assert.equal(
              afterLate.requests.filter((r) => r.path.endsWith("/join")).length,
              scenario === "grant-after-cancel" ? 1 : 0,
              "Cancel must prevent a late waiting-status response from requesting admission",
            );
            await expect(page.locator(".call-page")).toHaveCount(0);
            if (scenario === "cancel-failure") {
              await settle(
                page,
                "/waiting",
                "Synthetic cancellation unavailable",
                true,
              );
              await expect(page.getByRole("alert")).toContainText(
                "Synthetic cancellation unavailable",
              );
              await expect(
                page.getByRole("button", {
                  name: "К проверке устройств",
                  exact: true,
                }),
              ).toBeVisible();
              assert.equal(
                await page.evaluate(
                  () =>
                    document.documentElement.scrollWidth >
                    document.documentElement.clientWidth,
                ),
                false,
                "The cancellation failure state fits a mobile viewport",
              );
              if (process.env.IMON_CANCELLATION_EVIDENCE_DIR)
                await page.screenshot({
                  path:
                    process.env.IMON_CANCELLATION_EVIDENCE_DIR +
                    "/cancel-failure-paused.png",
                  fullPage: true,
                });
              await page
                .getByRole("button", {
                  name: "К проверке устройств",
                  exact: true,
                })
                .click();
            } else {
              await settle(page, "/waiting", {});
            }
            await expect(
              page.getByRole("heading", { name: "Cancellation fixture" }),
            ).toBeVisible();
            await expect(
              page.getByRole("heading", {
                name: "Ждем разрешения организатора",
              }),
            ).toHaveCount(0);
            const final = await snapshot(page);
            evidence[scenario + "-final"] = final;
            assert.equal(final.callMounts, 0);
            assert.equal(
              await page.evaluate(() =>
                sessionStorage.getItem(
                  "imon.waiting.waiting-cancellation-fixture",
                ),
              ),
              null,
            );
            if (process.env.IMON_CANCELLATION_EVIDENCE_DIR) {
              await mkdir(process.env.IMON_CANCELLATION_EVIDENCE_DIR, {
                recursive: true,
              });
              await page.screenshot({
                path:
                  process.env.IMON_CANCELLATION_EVIDENCE_DIR +
                  "/" +
                  scenario +
                  ".png",
                fullPage: true,
              });
            }
          } finally {
            await context.close();
          }
        });
      }
    } finally {
      await browser.close();
      if (process.env.IMON_CANCELLATION_EVIDENCE_DIR) {
        await mkdir(process.env.IMON_CANCELLATION_EVIDENCE_DIR, {
          recursive: true,
        });
        await writeFile(
          process.env.IMON_CANCELLATION_EVIDENCE_DIR + "/observations.json",
          JSON.stringify(evidence, null, 2) + "\n",
        );
      }
    }
  },
);
