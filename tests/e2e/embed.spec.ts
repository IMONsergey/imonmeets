import {
  expect,
  test,
  type BrowserContext,
  type Frame,
  type Locator,
  type Page,
} from "@playwright/test";

const base = new URL(process.env.BASE_URL || "https://imonmeets.vercel.app")
  .origin;
const embedHost = new URL(process.env.EMBED_TEST_HOST || "https://imon.agency")
  .origin;
const email = process.env.REVIEW_EMAIL || "",
  password = process.env.REVIEW_PASSWORD || "";
const parentPath = "/__imonmeets-embed-acceptance";
type CreatedRoom = { id: string; slug: string; workspaceId: string };

// Real auth, media and cross-origin frames must not enter retained traces,
// screenshots, videos, browser console dumps or request/response attachments.
test.use({ trace: "off", screenshot: "off", video: "off" });
test.skip(
  !email || !password,
  "A provisioned verified review account is required.",
);

async function enterCredential(field: Locator, value: string) {
  await field.evaluate((element, credential) => {
    if (!(element instanceof HTMLInputElement))
      throw new Error("Credential field unavailable");
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    if (!setter) throw new Error("Credential field cannot be edited");
    setter.call(element, credential);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

async function navigate(page: Page, path: string) {
  try {
    await page.goto(path, { waitUntil: "domcontentloaded" });
  } catch {
    throw new Error(
      "Acceptance page navigation failed; raw URLs are not retained",
    );
  }
}

async function installMediaProbe(context: BrowserContext) {
  await context.addInitScript(
    ({ base }) => {
      if (location.origin !== base) return;
      const probe = {
        deviceRequests: 0,
        tracks: [] as MediaStreamTrack[],
        peers: [] as RTCPeerConnection[],
      };
      (window as any).__imonEmbedProbe = probe;
      if (navigator.mediaDevices) {
        const acquire = navigator.mediaDevices.getUserMedia.bind(
          navigator.mediaDevices,
        );
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          probe.deviceRequests++;
          const stream = await acquire(constraints);
          probe.tracks.push(...stream.getTracks());
          return stream;
        };
      }
      const Native = RTCPeerConnection;
      window.RTCPeerConnection = new Proxy(Native, {
        construct(Target, args) {
          const peer = Reflect.construct(Target, args) as RTCPeerConnection;
          probe.peers.push(peer);
          return peer;
        },
      });
    },
    { base },
  );
}

async function mediaIsFlowing(surface: Page | Frame) {
  return surface.evaluate(async () => {
    const probe = (window as any).__imonEmbedProbe as
      { peers: RTCPeerConnection[] } | undefined;
    let audioBytes = 0,
      videoFrames = 0;
    for (const peer of probe?.peers ?? []) {
      if (peer.connectionState !== "connected") continue;
      const stats = await peer.getStats();
      stats.forEach((entry) => {
        if (entry.type === "inbound-rtp" && entry.kind === "audio")
          audioBytes += entry.bytesReceived || 0;
        if (entry.type === "inbound-rtp" && entry.kind === "video")
          videoFrames += entry.framesDecoded || 0;
      });
    }
    // Only a boolean returns to the report; no SDP, ICE addresses or grant data.
    return audioBytes > 0 && videoFrames > 0;
  });
}

async function expectTwoVideos(surface: Page | Frame) {
  await expect(surface.locator(".lk-participant-tile")).toHaveCount(2, {
    timeout: 30000,
  });
  await expect
    .poll(
      () =>
        surface
          .locator("video")
          .evaluateAll(
            (videos) =>
              videos.filter(
                (video) =>
                  video instanceof HTMLVideoElement &&
                  video.readyState >= 2 &&
                  video.videoWidth > 0 &&
                  video.videoHeight > 0,
              ).length,
          ),
      {
        timeout: 30000,
        message: "Local and received synthetic video frames render",
      },
    )
    .toBe(2);
  await expect
    .poll(() => mediaIsFlowing(surface), {
      timeout: 30000,
      message: "Real inbound audio and video are flowing",
    })
    .toBe(true);
}

function parentHtml(room: string) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="meeting"></div><script type="module">
    import { mountMeeting } from ${JSON.stringify(base + "/sdk/v1/embed.js")};
    window.embedEvents = [];
    window.embedLoadFailed = false;
    window.widget = mountMeeting({ container: document.getElementById('meeting'), appUrl: ${JSON.stringify(base)}, room: ${JSON.stringify(room)}, name: 'Гость встроенной проверки', height: 760, onEvent: event => window.embedEvents.push(event) });
    window.widget.ready.catch(() => { window.embedLoadFailed = true; });
    </script></body></html>`;
}

test("published guest widget: CSP, hosted modules, admission, real media, chat and cleanup", async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(240000);
  let workspaceId: string | undefined, room: CreatedRoom | undefined;
  let guestContext: BrowserContext | undefined,
    blockedContext: BrowserContext | undefined;
  let assetFailures = 0;
  const get = async (url: string) => {
    try {
      return await request.get(url);
    } catch {
      throw new Error(
        "Acceptance HTTP request failed; raw URLs are not retained",
      );
    }
  };
  try {
    const configuration = await get(`${base}/api/config`);
    expect(configuration.status(), "Public configuration is available").toBe(
      200,
    );
    const config = await configuration.json();
    expect(
      Array.isArray(config.embedAllowedOrigins) &&
        config.embedAllowedOrigins.includes(embedHost),
      "The exact acceptance parent origin must be configured before this test",
    ).toBe(true);
    expect(config.mediaConfigured, "Real media is configured").toBe(true);
    expect(
      config.embedAllowedOrigins.includes("https://blocked.invalid"),
      "The negative-test origin is not authorized",
    ).toBe(false);
    for (const filename of ["embed.js", "embed-protocol.js", "index.js"]) {
      const module = await get(`${base}/sdk/v1/${filename}`);
      expect(module.status(), "Public SDK module loads").toBe(200);
      expect(
        module.headers()["content-type"]?.includes("javascript"),
        "SDK response is JavaScript",
      ).toBe(true);
      expect(module.headers()["access-control-allow-origin"]).toBe("*");
      expect(
        module.headers()["access-control-allow-credentials"],
      ).toBeUndefined();
      expect(
        (await module.text()).includes("export"),
        "SDK returns executable source, not an HTML fallback",
      ).toBe(true);
    }
    const account = await get(`${base}/login`);
    expect(account.headers()["x-frame-options"]).toBe("DENY");

    await installMediaProbe(page.context());
    await navigate(page, `${base}/login`);
    await enterCredential(page.getByLabel("Рабочая почта"), email);
    await enterCredential(page.getByLabel("Пароль", { exact: true }), password);
    await page
      .getByRole("button", { name: "Войти в пространство", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: /^Добрый день,/ }),
    ).toBeVisible();
    const createdWorkspace = await page.request
      .post(`${base}/api/workspaces`, {
        headers: { origin: base },
        data: { name: `Проверка виджета ${Date.now()}` },
      })
      .catch(() => {
        throw new Error("Could not create an isolated acceptance workspace");
      });
    expect(createdWorkspace.status(), "A disposable workspace is created").toBe(
      200,
    );
    workspaceId = (await createdWorkspace.json()).workspace?.id;
    expect(
      typeof workspaceId === "string",
      "Created workspace ID is present",
    ).toBe(true);
    const createdRoom = await page.request
      .post(`${base}/api/workspaces/${workspaceId}/rooms`, {
        headers: { origin: base },
        data: {
          title: "Приемка встроенной встречи",
          allowGuests: true,
          waitingRoom: true,
          maxParticipants: 2,
          durationMinutes: 30,
        },
      })
      .catch(() => {
        throw new Error("Could not create a disposable acceptance meeting");
      });
    expect(createdRoom.status(), "A disposable guest meeting is created").toBe(
      200,
    );
    room = (await createdRoom.json()).room;
    expect(
      Boolean(room?.id && room?.slug),
      "Created meeting identifiers are present",
    ).toBe(true);
    const testRoom = room!;

    const document = await get(`${base}/embed/${testRoom.slug}`);
    expect(document.status(), "Published iframe document loads").toBe(200);
    expect(document.headers()["content-type"]?.includes("text/html")).toBe(
      true,
    );
    expect(document.headers()["x-frame-options"]).toBeUndefined();
    const ancestors =
      document
        .headers()
        ["content-security-policy"]?.split(";")
        .find((directive) => directive.trim().startsWith("frame-ancestors"))
        ?.trim()
        .split(/\s+/)
        .slice(1) ?? [];
    expect(
      ancestors.includes(embedHost),
      "CSP authorizes the exact parent origin",
    ).toBe(true);
    expect(
      ancestors.includes("*") || ancestors.includes("https://blocked.invalid"),
      "CSP has no broad or negative-test authorization",
    ).toBe(false);
    const html = await document.text();
    const assetPaths = [
      ...html.matchAll(/\b(?:src|href)="(\/assets\/[^"<>]+)"/g),
    ].map((match) => match[1]);
    expect(
      assetPaths.length > 0,
      "The backend iframe document references real build assets",
    ).toBe(true);
    for (const assetPath of [...new Set(assetPaths)]) {
      const asset = await get(new URL(assetPath, base).href);
      expect(
        asset.status(),
        "The exact asset referenced by backend HTML exists on Vercel",
      ).toBe(200);
      expect(
        asset.headers()["content-type"]?.includes("text/html"),
        "Build assets must not return SPA fallback HTML",
      ).toBe(false);
    }

    await navigate(page, `${base}/join/${testRoom.slug}`);
    await page
      .getByRole("button", { name: "Присоединиться к встрече", exact: true })
      .click();
    await expect(page.locator(".lk-participant-tile")).toHaveCount(1);
    guestContext = await browser.newContext({
      permissions: ["camera", "microphone"],
      viewport: { width: 1366, height: 1000 },
    });
    await installMediaProbe(guestContext);
    // Only this temporary parent HTML is intercepted. All modules, iframe
    // content, API calls and LiveKit signaling/media use the published service.
    await guestContext.route(`${embedHost}${parentPath}`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: parentHtml(testRoom.slug),
      }),
    );
    const guest = await guestContext.newPage();
    guest.on("response", (response) => {
      const url = new URL(response.url());
      if (
        url.origin === base &&
        url.pathname.startsWith("/assets/") &&
        response.status() >= 400
      )
        assetFailures++;
    });
    await navigate(guest, `${embedHost}${parentPath}`);
    const view = guest.frameLocator("iframe");
    await expect(
      view.getByRole("heading", {
        name: "Приемка встроенной встречи",
        exact: true,
      }),
    ).toBeVisible();
    const guestFrame = guest.frames().find((frame) => {
      try {
        const url = new URL(frame.url());
        return url.origin === base && url.pathname.startsWith("/embed/");
      } catch {
        return false;
      }
    });
    expect(
      Boolean(guestFrame),
      "The actual cross-origin meeting frame is loaded",
    ).toBe(true);
    const frame = guestFrame!;
    expect(
      await frame.evaluate(
        () => (window as any).__imonEmbedProbe?.deviceRequests,
      ),
      "Frame load does not request camera or microphone",
    ).toBe(0);
    const mic = view.locator(
      '.prejoin-wrap button[data-lk-source="microphone"]',
    );
    const camera = view.locator(
      '.prejoin-wrap button[data-lk-source="camera"]',
    );
    await expect(mic).toHaveAttribute("data-lk-enabled", "false");
    await expect(camera).toHaveAttribute("data-lk-enabled", "false");
    await mic.click();
    await camera.click();
    await expect(mic).toHaveAttribute("data-lk-enabled", "true");
    await expect(camera).toHaveAttribute("data-lk-enabled", "true");
    await view
      .getByRole("button", { name: "Запросить вход", exact: true })
      .click();
    await expect(
      view.getByRole("heading", { name: "Ждем разрешения организатора" }),
    ).toBeVisible();
    await expect
      .poll(() =>
        guest.evaluate(() =>
          (window as any).embedEvents.some(
            (event: any) => event.type === "state" && event.state === "waiting",
          ),
        ),
      )
      .toBe(true);
    await expect(page.locator(".lk-participant-tile")).toHaveCount(1);
    await page
      .getByRole("button", { name: "Участники встречи", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "Разрешить вход: Гость встроенной проверки",
        exact: true,
      })
      .click();
    await expectTwoVideos(page);
    await expectTwoVideos(frame);
    await expect
      .poll(() =>
        guest.evaluate(() =>
          (window as any).embedEvents.some(
            (event: any) => event.type === "state" && event.state === "joined",
          ),
        ),
      )
      .toBe(true);
    await expect(
      view.getByRole("button", { name: "Завершить для всех", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Чат встречи", exact: true })
      .click();
    await view
      .getByRole("button", { name: "Чат встречи", exact: true })
      .click();
    const message = "Проверка сообщения из встроенной встречи";
    await view
      .getByRole("textbox", { name: "Сообщение команде" })
      .fill(message);
    await view
      .getByRole("button", { name: "Отправить сообщение", exact: true })
      .click();
    await expect(
      page
        .getByRole("log", { name: "Сообщения встречи" })
        .getByText(message, { exact: true }),
    ).toBeVisible();
    expect(
      await guest.evaluate(() =>
        (window as any).embedEvents.every((event: any) =>
          Object.keys(event).every((key) =>
            ["type", "state", "code"].includes(key),
          ),
        ),
      ),
      "Parent receives only bounded public lifecycle events",
    ).toBe(true);
    expect(
      assetFailures,
      "No dynamic meeting chunks are missing after deployment",
    ).toBe(0);
    await guest.evaluate(() => (window as any).widget.leave());
    await expect(
      view.getByRole("heading", { name: "Вы вышли из встречи", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".lk-participant-tile")).toHaveCount(1);
    await expect
      .poll(
        () =>
          frame.evaluate(() => {
            const probe = (window as any).__imonEmbedProbe as {
              tracks: MediaStreamTrack[];
              peers: RTCPeerConnection[];
            };
            return (
              probe.tracks.every((track) => track.readyState === "ended") &&
              probe.peers.every((peer) => peer.connectionState === "closed")
            );
          }),
        {
          message:
            "Leaving stops captured synthetic tracks and closes peer connections",
        },
      )
      .toBe(true);
    await guest.evaluate(() => (window as any).widget.destroy());
    await expect(guest.locator("iframe")).toHaveCount(0);

    blockedContext = await browser.newContext();
    await blockedContext.route(
      `https://blocked.invalid${parentPath}`,
      (route) =>
        route.fulfill({
          contentType: "text/html",
          body: parentHtml(testRoom.slug),
        }),
    );
    const blocked = await blockedContext.newPage();
    let cspBlocked = false,
      blockedApiRequests = 0;
    blocked.on("console", (message) => {
      // Read only to classify the browser's enforcement; never store/log text.
      if (message.type() === "error" && /frame-ancestors/i.test(message.text()))
        cspBlocked = true;
    });
    blocked.on("request", (outgoing) => {
      const url = new URL(outgoing.url());
      if (url.origin === base && url.pathname.startsWith("/api/"))
        blockedApiRequests++;
    });
    await navigate(blocked, `https://blocked.invalid${parentPath}`);
    await expect
      .poll(() => cspBlocked, {
        message:
          "The browser enforces frame-ancestors against an unapproved site",
        timeout: 20000,
      })
      .toBe(true);
    expect(
      blockedApiRequests,
      "A CSP-blocked frame never starts guest API requests",
    ).toBe(0);
  } finally {
    await blockedContext?.close();
    await guestContext?.close();
    if (room)
      await page.request
        .post(
          `${base}/api/workspaces/${room.workspaceId}/rooms/${room.id}/close`,
          {
            headers: { origin: base },
            data: {},
          },
        )
        .catch(() => undefined);
    if (workspaceId) {
      // Password remains inside a generic browser evaluation with tracing off.
      // The scope is the workspace created by this test, never a preexisting one.
      const deleted = await page
        .evaluate(
          async ({ base, workspaceId, password }) => {
            if (location.origin !== base) return 0;
            try {
              const response = await fetch(
                `${base}/api/workspaces/${encodeURIComponent(workspaceId)}`,
                {
                  method: "DELETE",
                  credentials: "include",
                  redirect: "error",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ password, confirmation: "DELETE" }),
                },
              );
              return response.status;
            } catch {
              return 0;
            }
          },
          { base, workspaceId, password },
        )
        .catch(() => 0);
      expect(
        deleted,
        "The disposable acceptance workspace and its data are removed",
      ).toBe(200);
    }
  }
});
