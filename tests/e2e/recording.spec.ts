import {
  test,
  expect,
  type APIRequestContext,
  type BrowserContext,
} from "@playwright/test";

const base = process.env.BASE_URL || "http://localhost:3540";
const mail = process.env.MAILPIT_URL || "http://localhost:3541";
test.use({ trace: "off", screenshot: "off", video: "off" });
test.skip(
  process.env.RECORDING_ACCEPTANCE !== "true",
  "Real Egress/private-storage acceptance requires RECORDING_ACCEPTANCE=true",
);

type Recording = {
  id: string;
  roomId: string;
  status: "starting" | "active" | "ending" | "complete" | "failed";
  sizeBytes: number | null;
  expiresAt: string | null;
};

async function verificationLink(request: APIRequestContext, email: string) {
  let link = "";
  await expect
    .poll(
      async () => {
        const response = await request.get(mail + "/api/v1/messages");
        const messages = (await response.json()).messages as {
          ID: string;
          To: { Address: string }[];
        }[];
        const message = messages.find((item) =>
          item.To.some(
            (to) => to.Address.toLowerCase() === email.toLowerCase(),
          ),
        );
        if (!message) return false;
        const detail = await (
          await request.get(mail + "/api/v1/message/" + message.ID)
        ).json();
        link = detail.Text.match(/https?:\/\/[^\s]+/)?.[0] || "";
        return link.includes("/verify-email");
      },
      {
        timeout: 30000,
        message:
          "Synthetic owner's verification reaches the isolated SMTP inbox",
      },
    )
    .toBe(true);
  return link;
}

function privateUrl(value: unknown) {
  try {
    if (typeof value !== "string") throw new Error();
    const url = new URL(value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error();
    return url;
  } catch {
    throw new Error(
      "The authenticated download response has no valid storage URL",
    );
  }
}

// Native fetch keeps signed URLs out of Playwright's API-step report. No traces,
// screenshots, response attachments or media files are retained by this test.
async function storageGet(
  url: URL,
  range?: string,
  maxBytes = 64 * 1024 * 1024,
) {
  try {
    const response = await fetch(url, {
      headers: {
        ...(range ? { Range: range } : {}),
        "Cache-Control": "no-cache",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > maxBytes) {
            await reader.cancel();
            throw new Error();
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    return {
      status: response.status,
      contentRange: response.headers.get("content-range"),
      body: Buffer.concat(chunks),
    };
  } catch {
    // Do not retain the original fetch error/cause, which can contain a bearer URL.
    throw new Error(
      "Private storage request failed or exceeded its bounded size/time limit",
    );
  }
}

function signedExpiry(url: URL) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(
    url.searchParams.get("X-Amz-Date") ?? "",
  );
  const seconds = Number(url.searchParams.get("X-Amz-Expires"));
  if (!match || !Number.isSafeInteger(seconds) || seconds < 1)
    throw new Error("Storage grant expiry cannot be verified");
  return (
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
    ) +
    seconds * 1000
  );
}

test("real two-participant recording, private MP4 download and physical deletion", async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(6 * 60 * 1000);
  const email = "recording-" + Date.now() + "@example.test";
  let guestContext: BrowserContext | undefined;
  let workspaceId = "",
    roomId = "",
    recordingId = "";
  let removed = false,
    closed = false;
  const origin = { origin: base };
  const workspacePath = () => base + "/api/workspaces/" + workspaceId;
  const recordings = async () => {
    const response = await page.request.get(workspacePath() + "/recordings");
    expect(response.status(), "The owner can read recording state").toBe(200);
    return (await response.json()).recordings as Recording[];
  };

  try {
    const config = await (await request.get(base + "/api/config")).json();
    expect(
      config.recordingConfigured,
      "Enable real Egress/storage only in this isolated deployment",
    ).toBe(true);
    const signup = await page.request.post(base + "/api/auth/sign-up/email", {
      headers: origin,
      data: {
        email,
        password: "Synthetic-recording-password-9027",
        name: "Проверка записи",
        callbackURL: base + "/verify-email?success=1",
      },
    });
    expect(signup.status()).toBe(200);
    await page.goto(await verificationLink(request, email));
    expect((await page.request.get(base + "/api/me")).status()).toBe(200);
    const createdWorkspace = await page.request.post(base + "/api/workspaces", {
      headers: origin,
      data: { name: "Проверка полного цикла записи" },
    });
    expect(createdWorkspace.status()).toBe(200);
    workspaceId = (await createdWorkspace.json()).workspace.id;
    const createdRoom = await page.request.post(workspacePath() + "/rooms", {
      headers: origin,
      data: {
        title: "Синтетическая запись двух участников",
        allowGuests: true,
        waitingRoom: false,
        maxParticipants: 4,
      },
    });
    expect(createdRoom.status()).toBe(200);
    const room = (await createdRoom.json()).room as {
      id: string;
      slug: string;
    };
    roomId = room.id;
    await page.goto(base + "/join/" + room.slug);
    await page
      .getByRole("button", { name: "Присоединиться к встрече", exact: true })
      .click();
    await expect(page.locator(".lk-participant-tile")).toHaveCount(1);

    guestContext = await browser.newContext({
      permissions: ["camera", "microphone"],
      viewport: { width: 1280, height: 900 },
    });
    const guest = await guestContext.newPage();
    await guest.goto(base + "/join/" + room.slug);
    await guest
      .getByPlaceholder("Ваше имя", { exact: true })
      .fill("Гость записи");
    await guest
      .getByRole("button", { name: "Присоединиться к встрече", exact: true })
      .click();
    await expect(page.locator(".lk-participant-tile")).toHaveCount(2);
    await expect(guest.locator(".lk-participant-tile")).toHaveCount(2);
    await expect
      .poll(
        () =>
          guest
            .locator("video")
            .evaluateAll(
              (videos) =>
                videos.filter(
                  (video) =>
                    video instanceof HTMLVideoElement &&
                    video.readyState >= 2 &&
                    video.videoWidth > 0,
                ).length,
            ),
        {
          message:
            "Both real LiveKit participants render synthetic video frames",
        },
      )
      .toBe(2);

    await page.getByRole("button", { name: "Записать", exact: true }).click();
    await expect
      .poll(
        async () => {
          const item = (await recordings()).find(
            (entry) => entry.roomId === roomId,
          );
          if (item) recordingId = item.id;
          if (item?.status === "failed")
            throw new Error("Egress reported a failed recording start");
          return item?.status ?? "not-created";
        },
        {
          timeout: 90000,
          intervals: [1000, 2000, 3000],
          message: "Real Egress reaches active state",
        },
      )
      .toBe("active");
    const stop = page.getByRole("button", {
      name: "Остановить запись",
      exact: true,
    });
    await expect(stop).toBeEnabled({ timeout: 15000 });
    await expect(guest.locator(".call-recording-notice")).toBeVisible();
    await page.waitForTimeout(8000);
    await stop.click();
    let completed: Recording | undefined;
    await expect
      .poll(
        async () => {
          completed = (await recordings()).find(
            (entry) => entry.id === recordingId,
          );
          if (completed?.status === "failed")
            throw new Error("Egress failed while finalizing the recording");
          return completed?.status;
        },
        {
          timeout: 120000,
          intervals: [1000, 2000, 3000],
          message: "Egress upload and API reconciliation reach complete",
        },
      )
      .toBe("complete");
    expect(Number(completed?.sizeBytes)).toBeGreaterThan(1024);
    expect(
      Date.parse(completed?.expiresAt ?? "") > Date.now(),
      "Recording has a future retention deadline",
    ).toBe(true);

    const downloadPath =
      workspacePath() + "/recordings/" + recordingId + "/download";
    expect(
      (await request.get(downloadPath)).status(),
      "Anonymous API access is rejected",
    ).toBe(401);
    const download = await page.request.get(downloadPath);
    expect(download.status()).toBe(200);
    const signed = privateUrl((await download.json()).url);
    const file = await storageGet(signed);
    expect(file.status).toBe(200);
    expect(file.body.length).toBeGreaterThan(1024);
    expect(
      file.body.subarray(4, 8).toString("ascii"),
      "Downloaded file has an MP4 ftyp box",
    ).toBe("ftyp");
    const ranged = await storageGet(signed, "bytes=0-1023", 4096);
    expect(ranged.status).toBe(206);
    expect(ranged.body.length).toBe(1024);
    expect(ranged.contentRange).toMatch(/^bytes 0-1023\/[0-9]+$/);
    const unsigned = new URL(signed);
    unsigned.search = "";
    unsigned.hash = "";
    expect(
      (await storageGet(unsigned, undefined, 16384)).status,
      "The unsigned storage object is private",
    ).toBe(403);

    // Use a fresh, proven-valid grant so expiration cannot masquerade as deletion.
    const freshDownload = await page.request.get(downloadPath);
    expect(freshDownload.status()).toBe(200);
    const oldGrant = privateUrl((await freshDownload.json()).url);
    const expires = signedExpiry(oldGrant);
    expect(
      expires - Date.now() > 40000,
      "The deletion probe has an unexpired grant",
    ).toBe(true);
    expect((await storageGet(oldGrant, "bytes=0-0", 4096)).status).toBe(206);
    const deletion = await page.request.delete(
      workspacePath() + "/recordings/" + recordingId,
      { headers: origin },
    );
    expect(deletion.status()).toBe(200);
    expect(
      (await page.request.get(downloadPath)).status(),
      "Deletion immediately denies new download grants",
    ).toBe(404);
    await expect
      .poll(
        async () => {
          if (Date.now() >= expires - 5000)
            throw new Error(
              "Storage grant expired before physical deletion could be proven",
            );
          const object = await storageGet(oldGrant, "bytes=0-0", 16384);
          const absent = !(await recordings()).some(
            (entry) => entry.id === recordingId,
          );
          return absent && [403, 404].includes(object.status);
        },
        {
          timeout: 40000,
          intervals: [500, 1000, 2000],
          message:
            "Physical deletion revokes the still-valid old storage grant",
        },
      )
      .toBe(true);
    removed = true;

    const close = await page.request.post(
      workspacePath() + "/rooms/" + roomId + "/close",
      { headers: origin, data: {} },
    );
    expect(close.status()).toBe(200);
    closed = true;
    await expect(
      guest.getByRole("heading", { name: "Встреча завершена", exact: true }),
    ).toBeVisible();
  } finally {
    // Only touch this synthetic owner's resources. Preserve the original failure.
    if (workspaceId && roomId && !closed) {
      if (recordingId) {
        await page.request
          .post(workspacePath() + "/recordings/" + recordingId + "/stop", {
            headers: origin,
            data: {},
            timeout: 10000,
          })
          .catch(() => {});
      }
      await page.request
        .post(workspacePath() + "/rooms/" + roomId + "/close", {
          headers: origin,
          data: {},
          timeout: 10000,
        })
        .catch(() => {});
    }
    if (workspaceId && recordingId && !removed) {
      await page.request
        .delete(workspacePath() + "/recordings/" + recordingId, {
          headers: origin,
          timeout: 10000,
        })
        .catch(() => {});
    }
    await guestContext?.close();
  }
});
