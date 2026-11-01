import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";

const base = new URL(process.env.BASE_URL || "https://imonmeets.vercel.app")
  .origin;
const email = process.env.REVIEW_EMAIL || "";
const password = process.env.REVIEW_PASSWORD || "";

type ReviewRoom = {
  id: string;
  workspaceId: string;
  slug: string;
  title: string;
  startsAt: string;
};
type Grant = { token: string; serverUrl: string };

// Credential entry and signaling must never be included in a retained trace.
// Screenshots below deliberately select only the synthetic conference content.
test.use({ trace: "off", screenshot: "off", video: "off" });
test.skip(
  !email || !password,
  "A provisioned verified review account is required.",
);

async function enterCredential(field: Locator, value: string) {
  // Submission still uses the UI and standard auth handler. A generic evaluate
  // action avoids putting credentials in fill-action failure logs.
  await field.evaluate((element, credential) => {
    if (!(element instanceof HTMLInputElement)) {
      throw new Error("Review credential field is unavailable");
    }
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    if (!setter) throw new Error("Review credential field cannot be edited");
    setter.call(element, credential);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

async function probeGrant(page: Page, grant: Grant) {
  return page.evaluate(async ({ token, serverUrl }) => {
    try {
      return await new Promise<"opened" | "rejected" | "timeout">((resolve) => {
        const url = new URL("/rtc", serverUrl);
        url.protocol = ["wss:", "https:"].includes(url.protocol)
          ? "wss:"
          : "ws:";
        url.searchParams.set("access_token", token);
        url.searchParams.set("auto_subscribe", "1");
        url.searchParams.set("sdk", "js");
        url.searchParams.set("protocol", "16");
        const socket = new WebSocket(url);
        const finish = (result: "opened" | "rejected" | "timeout") => {
          clearTimeout(timeout);
          socket.close();
          resolve(result);
        };
        const timeout = setTimeout(() => finish("timeout"), 12_000);
        socket.onopen = () => finish("opened");
        socket.onerror = () => finish("rejected");
        socket.onclose = () => finish("rejected");
      });
    } catch {
      return "unavailable";
    }
  }, grant);
}

async function expectTwoVideos(page: Page) {
  await expect(page.locator(".lk-participant-tile")).toHaveCount(2);
  await expect
    .poll(
      () =>
        page
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
        message: "Both local and received synthetic video frames are rendered",
        timeout: 30_000,
      },
    )
    .toBe(2);
}

test("public review: verified login, calendar export, two-way call and durable room closure", async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(150_000);
  let room: ReviewRoom | undefined;
  let guestContext: BrowserContext | undefined;
  let closed = false;

  try {
    await page.goto(`${base}/register`);
    await expect(
      page.getByRole("heading", { name: "Регистрация закрыта" }),
    ).toBeVisible();
    await expect(page.locator("form")).toHaveCount(0);
    await expect(
      page.getByText("Вход через тестовый аккаунт.", { exact: false }),
    ).toBeVisible();

    await page.goto(`${base}/forgot-password`);
    await expect(
      page.getByRole("button", { name: "Отправить ссылку", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByText("Письма на внешнюю почту в этой версии не отправляются.", {
        exact: false,
      }),
    ).toBeVisible();

    await page.goto(`${base}/login`);
    await expect(
      page.getByRole("link", { name: "Создать аккаунт", exact: true }),
    ).toHaveCount(0);
    await enterCredential(page.getByLabel("Рабочая почта"), email);
    await enterCredential(page.getByLabel("Пароль", { exact: true }), password);
    await page
      .getByRole("button", { name: "Войти в пространство", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: /^Добрый день,/ }),
    ).toBeVisible();
    await expect(
      page.getByText("Тестовый доступ", { exact: true }),
    ).toBeVisible();

    const sessionResponse = await page.request.get(`${base}/api/me`);
    expect(sessionResponse.status()).toBe(200);
    const session = await sessionResponse.json();
    expect(session.user.emailVerified === true).toBe(true);
    expect(
      Array.isArray(session.workspaces) && session.workspaces.length > 0,
    ).toBe(true);
    const workspaceId = await page.evaluate(() =>
      localStorage.getItem("imon.workspace"),
    );
    expect(
      typeof workspaceId === "string" &&
        session.workspaces.some(
          (workspace: { id: string }) => workspace.id === workspaceId,
        ),
    ).toBe(true);
    const sessionCookies = (await page.context().cookies(base)).filter(
      (cookie) => /better-auth.*session_token/.test(cookie.name),
    );
    expect(sessionCookies.length > 0).toBe(true);
    for (const cookie of sessionCookies) {
      expect(cookie.secure, "Review session cookies require HTTPS").toBe(true);
      expect(
        cookie.httpOnly,
        "Review session cookies are unavailable to browser scripts",
      ).toBe(true);
    }

    const title = `Проверка календаря и связи ${Date.now()}`;
    const schedule = await page.evaluate(() => {
      const start = new Date(Date.now() + 2 * 60 * 60_000);
      start.setSeconds(0, 0);
      const pad = (value: number) => String(value).padStart(2, "0");
      return {
        local: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}T${pad(start.getHours())}:${pad(start.getMinutes())}`,
        utc: start.toISOString(),
      };
    });
    await page
      .getByRole("button", { name: "Запланировать встречу", exact: true })
      .first()
      .click();
    await page.getByLabel("Название встречи").fill(title);
    await expect(
      page.getByLabel("Запланировать дату и время", { exact: true }),
    ).toBeChecked();
    await page
      .getByLabel("Начало встречи", { exact: true })
      .fill(schedule.local);
    await page
      .getByLabel("Описание", { exact: false })
      .fill("Проверка календаря, видео, чата и завершения встречи.");
    const createdResponse = page.waitForResponse(
      (response) =>
        response.url() === `${base}/api/workspaces/${workspaceId}/rooms` &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Создать встречу", exact: true })
      .click();
    const created = await createdResponse;
    expect(created.status()).toBe(200);
    room = (await created.json()).room as ReviewRoom;
    expect(Boolean(room?.id && room.slug)).toBe(true);
    expect(
      new Date(room.startsAt).getTime() === new Date(schedule.utc).getTime(),
    ).toBe(true);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // The dashboard shows only the nearest three meetings; this workspace is reused.
    await page.getByRole("link", { name: "Встречи", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Найти встречу", exact: true })
      .fill(title);
    const scheduledRoom = page.locator(".room-row").filter({
      has: page.getByRole("heading", { name: title, exact: true }),
    });
    await expect(scheduledRoom).toHaveCount(1);

    const downloadEvent = page.waitForEvent("download");
    await scheduledRoom
      .getByRole("button", {
        name: `Добавить в календарь: ${title}`,
        exact: true,
      })
      .click();
    const download = await downloadEvent;
    expect(download.suggestedFilename().endsWith(".ics")).toBe(true);
    const stream = await download.createReadStream();
    if (!stream)
      throw new Error("Calendar download did not expose readable content");
    let calendar = "";
    for await (const chunk of stream) calendar += chunk.toString();
    const unfolded = calendar.replace(/\r\n /g, "");
    const expectedUtcStart = schedule.utc
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z");
    expect(unfolded.includes(`SUMMARY:${title}\r\n`)).toBe(true);
    expect(unfolded.includes(`DTSTART:${expectedUtcStart}\r\n`)).toBe(true);
    expect(
      unfolded.includes(
        `URL:${base}/join/${encodeURIComponent(room.slug)}\r\n`,
      ),
    ).toBe(true);
    expect(calendar.replace(/\r\n/g, "").includes("\n")).toBe(false);

    const tokenResponse = await page.request.post(
      `${base}/api/rooms/${room.slug}/join`,
      {
        headers: { origin: base },
        data: { name: "Организатор проверки" },
      },
    );
    expect(tokenResponse.status()).toBe(200);
    const priorGrant = (await tokenResponse.json()) as Grant;
    expect(
      typeof priorGrant.token === "string" &&
        typeof priorGrant.serverUrl === "string",
    ).toBe(true);
    expect(await probeGrant(page, priorGrant)).toBe("opened");

    await page.goto(`${base}/join/${room.slug}`);
    await page
      .getByRole("button", { name: "Присоединиться к встрече", exact: true })
      .click();
    await expect(page.locator(".lk-participant-tile")).toHaveCount(1);
    guestContext = await browser.newContext({
      permissions: ["camera", "microphone"],
      viewport: { width: 1366, height: 900 },
    });
    const guest = await guestContext.newPage();
    await guest.goto(`${base}/join/${room.slug}`);
    await guest
      .getByPlaceholder("Ваше имя", { exact: true })
      .fill("Гость проверки");
    await guest
      .getByRole("button", { name: "Присоединиться к встрече", exact: true })
      .click();
    await expectTwoVideos(page);
    await expectTwoVideos(guest);
    await expect(
      guest.getByRole("button", { name: "Завершить для всех", exact: true }),
    ).toHaveCount(0);

    // Exercise the real moderation RPC and the participant's own recovery.
    await page
      .getByRole("button", { name: "Участники встречи", exact: true })
      .click();
    const muteGuest = page.getByRole("button", {
      name: "Выключить микрофон: Гость проверки",
      exact: true,
    });
    await expect(muteGuest).toBeEnabled();
    await muteGuest.click();
    await expect(muteGuest).toBeDisabled();
    const guestMicrophone = guest.getByRole("button", {
      name: "Включить или выключить микрофон",
      exact: true,
    });
    await expect(guestMicrophone).toHaveAttribute("data-lk-enabled", "false");
    await guestMicrophone.click();
    await expect(guestMicrophone).toHaveAttribute("data-lk-enabled", "true");
    await expect(muteGuest).toBeEnabled();

    await page
      .getByRole("button", { name: "Чат встречи", exact: true })
      .click();
    await guest
      .getByRole("button", { name: "Чат встречи", exact: true })
      .click();
    const outgoing = "Проверка сообщения от организатора";
    await page
      .getByRole("textbox", { name: "Сообщение команде" })
      .fill(outgoing);
    await page
      .getByRole("button", { name: "Отправить сообщение", exact: true })
      .click();
    await expect(
      guest
        .getByRole("log", { name: "Сообщения встречи" })
        .getByText(outgoing, { exact: true }),
    ).toBeVisible();
    const reply = "Ответ гостя получен";
    await guest.getByRole("textbox", { name: "Сообщение команде" }).fill(reply);
    await guest
      .getByRole("button", { name: "Отправить сообщение", exact: true })
      .click();
    await expect(
      page
        .getByRole("log", { name: "Сообщения встречи" })
        .getByText(reply, { exact: true }),
    ).toBeVisible();
    await page.locator(".conference-body").screenshot({
      path: test.info().outputPath("review-two-participant-call.png"),
    });

    page.once("dialog", (dialog) => dialog.accept());
    await page
      .getByRole("button", { name: "Завершить для всех", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Встреча завершена", exact: true }),
    ).toBeVisible();
    closed = true;
    await expect(
      guest.getByRole("heading", {
        name: "Встреча завершена",
        exact: true,
      }),
    ).toBeVisible();
    const closedResponse = await request.post(
      `${base}/api/rooms/${room.slug}/join`,
      {
        headers: { origin: base },
        data: { name: "Повторный гость проверки" },
      },
    );
    expect(closedResponse.status()).toBe(409);
    expect((await closedResponse.json()).error?.code === "ROOM_CLOSED").toBe(
      true,
    );
    // Bypass the application API with the grant that worked before closure.
    expect(await probeGrant(guest, priorGrant)).toBe("rejected");
  } finally {
    if (room && !closed) {
      await page.request
        .post(
          `${base}/api/workspaces/${room.workspaceId}/rooms/${room.id}/close`,
          {
            headers: { origin: base },
            data: {},
          },
        )
        .catch(() => undefined);
    }
    await guestContext?.close();
  }
});
