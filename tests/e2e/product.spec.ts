import { writeFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

const base = process.env.BASE_URL || "http://localhost:3540";
const mail = process.env.MAILPIT_URL || "http://localhost:3541";
const password = "Browser-test-password-9027";
test.use({ trace: "off", screenshot: "off", video: "off" });

function authenticatorCode(secret: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.replace(/=+$/, "").toUpperCase()) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error("Invalid synthetic authenticator seed");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8)
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac("sha1", Buffer.from(bytes))
    .update(counter)
    .digest();
  const offset = digest[digest.length - 1]! & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(
    6,
    "0",
  );
}

async function submitLogin(page: Page) {
  // Several independent accounts share the runner's IP. Respect the real
  // authentication throttle instead of disabling it for acceptance tests.
  for (let attempt = 0; attempt < 2; attempt++) {
    const pending = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/auth/sign-in/email") &&
        r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Войти в пространство", exact: true })
      .click();
    const response = await pending;
    if (response.status() !== 429 || attempt === 1) {
      expect(response.status()).toBe(200);
      return;
    }
    const retryAfter = Number(response.headers()["x-retry-after"] || 10);
    expect(retryAfter).toBeGreaterThanOrEqual(0);
    expect(retryAfter).toBeLessThanOrEqual(15);
    await new Promise((resolve) =>
      setTimeout(resolve, (retryAfter + 1) * 1000),
    );
  }
}

async function verificationLink(
  request: APIRequestContext,
  email: string,
  expectedPath = "verify-email",
) {
  let link = "";
  await expect
    .poll(
      async () => {
        const response = await request.get(`${mail}/api/v1/messages`);
        const data = await response.json();
        const message = data.messages.find((m: { To: { Address: string }[] }) =>
          m.To.some((to) => to.Address.toLowerCase() === email.toLowerCase()),
        );
        if (!message) return false;
        const detail = await (
          await request.get(`${mail}/api/v1/message/${message.ID}`)
        ).json();
        link = detail.Text.match(/https?:\/\/[^\s]+/)?.[0] || "";
        return Boolean(link) && link.includes(expectedPath);
      },
      { message: "Verification email reaches the local SMTP inbox" },
    )
    .toBe(true);
  return link;
}

async function probeGrant(
  page: Page,
  grant: { token: string; serverUrl: string },
) {
  return page.evaluate(async ({ token, serverUrl }) => {
    return new Promise<string>((resolve) => {
      const url = new URL("/rtc", serverUrl);
      url.searchParams.set("access_token", token);
      url.searchParams.set("auto_subscribe", "1");
      url.searchParams.set("sdk", "js");
      url.searchParams.set("protocol", "16");
      const socket = new WebSocket(url);
      const timeout = setTimeout(() => {
        socket.close();
        resolve("timeout");
      }, 8000);
      socket.onopen = () => {
        clearTimeout(timeout);
        socket.close();
        resolve("opened");
      };
      socket.onerror = () => {
        clearTimeout(timeout);
        resolve("rejected");
      };
      socket.onclose = () => {
        clearTimeout(timeout);
        resolve("rejected");
      };
    });
  }, grant);
}

test("verified account, workspace, scheduled room, guest video and durable close", async ({
  page,
  browser,
  request,
}) => {
  const email = `browser-${Date.now()}@example.test`;
  await page.addInitScript(() => {
    const peers: RTCPeerConnection[] = [];
    Object.assign(window, { __imonRTCPeers: peers });
    const Native = window.RTCPeerConnection;
    window.RTCPeerConnection = new Proxy(Native, {
      construct(Target, args) {
        const peer = new Target(...args);
        peers.push(peer);
        return peer;
      },
    });
  });
  await page.goto("/register");
  await page.getByLabel("Ваше имя").fill("Тест IMON");
  await page.getByLabel("Рабочая почта").fill(email);
  await page.getByLabel(/^Пароль/).fill(password);
  await page
    .getByRole("button", { name: "Создать аккаунт", exact: true })
    .click();
  await expect(
    page.getByText("Аккаунт создан.", { exact: false }),
  ).toBeVisible();
  await page.goto(await verificationLink(request, email));
  await page.goto("/");
  await page.getByLabel("Название пространства").fill("Проверка IMON");
  await page
    .getByRole("button", { name: "Создать пространство", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Добрый день, Тест" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/dashboard-desktop.png",
    fullPage: true,
  });
  await page.getByRole("link", { name: "Встречи", exact: true }).click();
  await page
    .getByRole("button", { name: "Новая встреча", exact: true })
    .first()
    .click();
  await page.getByLabel("Название встречи").fill("Проверка реального звонка");
  await page
    .getByLabel("Описание", { exact: false })
    .fill("Проверка двух участников, видео и закрытия комнаты.");
  await page
    .getByRole("button", { name: "Создать встречу", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Проверка реального звонка" }),
  ).toBeVisible();
  const me = await (await page.request.get(`${base}/api/me`)).json();
  const workspaceId = me.workspaces[0].id;
  const rooms = await (
    await page.request.get(`${base}/api/workspaces/${workspaceId}/rooms`)
  ).json();
  const room = rooms.rooms.find(
    (r: { title: string }) => r.title === "Проверка реального звонка",
  );
  const tokenResponse = await page.request.post(
    `${base}/api/rooms/${room.slug}/join`,
    {
      headers: { origin: base },
      data: { name: "Тест IMON" },
    },
  );
  expect(tokenResponse.status()).toBe(200);
  const priorGrant = await tokenResponse.json();
  expect(await probeGrant(page, priorGrant)).toBe("opened");

  await page.getByRole("link", { name: "Войти", exact: true }).click();
  await page
    .getByRole("button", { name: "Присоединиться к встрече", exact: true })
    .click();
  await expect(page.locator(".lk-participant-tile")).toHaveCount(1);

  const guestContext = await browser.newContext({
    permissions: ["camera", "microphone"],
    viewport: { width: 1366, height: 900 },
  });
  const guest = await guestContext.newPage();
  await guest.goto(`${base}/join/${room.slug}`);
  await guest.getByPlaceholder("Ваше имя", { exact: true }).fill("Гость IMON");
  await guest
    .getByRole("button", { name: "Запросить вход", exact: true })
    .click();
  await expect(
    guest.getByRole("heading", { name: "Ждем разрешения организатора" }),
  ).toBeVisible();
  await expect(page.locator(".lk-participant-tile")).toHaveCount(1);
  await expect(guest.locator(".lk-participant-tile")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Участники встречи", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Разрешить вход: Гость IMON", exact: true })
    .click();
  await expect(page.locator(".lk-participant-tile")).toHaveCount(2);
  await expect(guest.locator(".lk-participant-tile")).toHaveCount(2);
  await page
    .getByRole("button", { name: "Участники встречи", exact: true })
    .click();
  await expect
    .poll(
      () =>
        guest
          .locator("video")
          .evaluateAll(
            (videos) =>
              videos.filter(
                (v) =>
                  v instanceof HTMLVideoElement &&
                  v.readyState >= 2 &&
                  v.videoWidth > 0,
              ).length,
          ),
      {
        message: "Both received and local synthetic video frames are rendered",
      },
    )
    .toBe(2);
  const rtcStats = await page.evaluate(async () => {
    const peers = (window as unknown as { __imonRTCPeers: RTCPeerConnection[] })
      .__imonRTCPeers;
    return Promise.all(
      peers
        .filter((peer) => peer.connectionState === "connected")
        .map(async (peer) => {
          const stats = await peer.getStats();
          const output: Record<string, unknown>[] = [];
          stats.forEach((report) => {
            if (
              report.type === "candidate-pair" &&
              report.state === "succeeded"
            ) {
              const local = stats.get(report.localCandidateId);
              const remote = stats.get(report.remoteCandidateId);
              output.push({
                state: report.state,
                nominated: report.nominated,
                bytesSent: report.bytesSent,
                bytesReceived: report.bytesReceived,
                protocol: remote?.protocol,
                localAddress: local?.address,
                remoteAddress: remote?.address,
                remotePort: remote?.port,
              });
            }
            if (report.type === "inbound-rtp")
              output.push({
                kind: report.kind,
                bytesReceived: report.bytesReceived,
                framesDecoded: report.framesDecoded,
              });
          });
          return { connectionState: peer.connectionState, reports: output };
        }),
    );
  });
  expect(rtcStats.length).toBeGreaterThan(0);
  await writeFile(
    "test-results/rtc-stats.json",
    JSON.stringify(rtcStats, null, 2),
  );
  await page
    .getByRole("button", { name: "Участники встречи", exact: true })
    .click();
  const muteGuest = page.getByRole("button", {
    name: "Выключить микрофон: Гость IMON",
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
  await page.getByRole("button", { name: "Чат встречи", exact: true }).click();
  await guest.getByRole("button", { name: "Чат встречи", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Сообщение команде" })
    .fill("Проверка сообщения между участниками");
  await page.getByRole("button", { name: "Отправить сообщение" }).click();
  await expect(
    guest
      .getByRole("log", { name: "Сообщения встречи" })
      .getByText("Проверка сообщения между участниками", { exact: true }),
  ).toBeVisible();
  // A new media/chat session after a full page reload still receives durable history.
  await page.reload();
  await page
    .getByRole("button", { name: "Присоединиться к встрече", exact: true })
    .click();
  await expect(page.locator(".lk-participant-tile")).toHaveCount(2);
  await page.getByRole("button", { name: "Чат встречи", exact: true }).click();
  await expect(
    page
      .getByRole("log", { name: "Сообщения встречи" })
      .getByText("Проверка сообщения между участниками", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/call-two-participants.png",
    fullPage: true,
  });
  await expect(
    guest.getByRole("button", { name: "Завершить для всех" }),
  ).toHaveCount(0);
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "Завершить для всех", exact: true })
    .click();
  await expect(
    guest.getByRole("heading", { name: "Встреча завершена" }),
  ).toBeVisible();
  const closed = await request.post(`${base}/api/rooms/${room.slug}/join`, {
    headers: { origin: base },
    data: { name: "Повторный гость" },
  });
  expect(closed.status()).toBe(409);
  expect((await closed.json()).error.code).toBe("ROOM_CLOSED");
  // Direct signaling with the cached, previously valid grant must fail. This bypasses our API.
  const cachedGrantResult = await probeGrant(guest, priorGrant);
  expect(cachedGrantResult).toBe("rejected");
  await guestContext.close();
  await page.goto("/");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/dashboard-mobile.png",
    fullPage: true,
  });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
});

test("password recovery revokes the old session and accepts the new password", async ({
  page,
  request,
}) => {
  const email = `recovery-${Date.now()}@example.test`;
  const registered = await page.request.post(`${base}/api/auth/sign-up/email`, {
    headers: { origin: base },
    data: {
      email,
      password,
      name: "Проверка восстановления",
      callbackURL: `${base}/verify-email?success=1`,
    },
  });
  expect(registered.status()).toBe(200);
  await page.goto(await verificationLink(request, email));
  expect((await page.request.get(`${base}/api/me`)).status()).toBe(200);
  await page.goto("/forgot-password");
  await page.getByLabel("Рабочая почта").fill(email);
  await page
    .getByRole("button", { name: "Отправить ссылку", exact: true })
    .click();
  await expect(
    page.getByText("Если аккаунт с таким адресом существует", { exact: false }),
  ).toBeVisible();
  await page.goto(await verificationLink(request, email, "reset-password"));
  const newPassword = "Changed-browser-password-5018";
  await page.getByLabel("Новый пароль", { exact: true }).fill(newPassword);
  await page
    .getByRole("button", { name: "Сохранить пароль", exact: true })
    .click();
  await expect(
    page.getByText("Пароль изменен. Теперь вы можете войти в аккаунт.", {
      exact: true,
    }),
  ).toBeVisible();
  expect((await page.request.get(`${base}/api/me`)).status()).toBe(401);
  const rejected = await page.request.post(`${base}/api/auth/sign-in/email`, {
    headers: { origin: base },
    data: { email, password },
  });
  expect(rejected.ok()).toBe(false);
  await page.goto("/login");
  await page.getByLabel("Рабочая почта").fill(email);
  await page.getByLabel("Пароль", { exact: true }).fill(newPassword);
  await submitLogin(page);
  await expect(
    page.getByRole("button", { name: "Создать пространство", exact: true }),
  ).toBeVisible();
  expect((await page.request.get(`${base}/api/me`)).status()).toBe(200);
});

test("real TOTP enrollment, login challenge, one-use recovery code and account erasure", async ({
  page,
  request,
}) => {
  const email = `mfa-${Date.now()}@example.test`;
  const created = await page.request.post(`${base}/api/auth/sign-up/email`, {
    headers: { origin: base },
    data: {
      email,
      password,
      name: "Проверка второго фактора",
      callbackURL: `${base}/verify-email?success=1`,
    },
  });
  expect(created.status()).toBe(200);
  await page.goto(await verificationLink(request, email));
  await page.goto("/");
  await page.getByRole("button", { name: "Мой аккаунт", exact: true }).click();
  await page
    .getByRole("button", { name: "Настроить второй фактор", exact: true })
    .click();
  await page.getByLabel("Текущий пароль", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  const secret = await page
    .getByLabel("Ключ для ручного ввода", { exact: true })
    .inputValue();
  await page
    .getByLabel("Код из приложения", { exact: true })
    .fill(authenticatorCode(secret));
  await page
    .getByRole("button", { name: "Подтвердить код", exact: true })
    .click();
  await expect(
    page.getByText("Второй фактор включен", { exact: true }),
  ).toBeVisible();
  const backup = (
    await page.locator(".backup-code-list code").first().innerText()
  ).trim();
  await page.getByLabel("Я сохранил резервные коды", { exact: true }).check();
  await page.getByRole("button", { name: "Готово", exact: true }).click();
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await page.getByLabel("Рабочая почта", { exact: true }).fill(email);
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await submitLogin(page);
  await expect(
    page.getByLabel("Код из приложения", { exact: true }),
  ).toBeVisible();
  expect((await page.request.get(`${base}/api/me`)).status()).toBe(401);
  await page
    .getByRole("button", { name: "Использовать резервный код", exact: true })
    .click();
  await page.getByLabel("Резервный код", { exact: true }).fill(backup);
  await page
    .getByRole("button", { name: "Подтвердить вход", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Мой аккаунт", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await page.getByLabel("Рабочая почта", { exact: true }).fill(email);
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await submitLogin(page);
  await page
    .getByRole("button", { name: "Использовать резервный код", exact: true })
    .click();
  await page.getByLabel("Резервный код", { exact: true }).fill(backup);
  await page
    .getByRole("button", { name: "Подтвердить вход", exact: true })
    .click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect((await page.request.get(`${base}/api/me`)).status()).toBe(401);
  await page
    .getByRole("button", { name: "Использовать приложение", exact: true })
    .click();
  await page
    .getByLabel("Код из приложения", { exact: true })
    .fill(authenticatorCode(secret));
  await page
    .getByRole("button", { name: "Подтвердить вход", exact: true })
    .click();
  await page.getByRole("button", { name: "Мой аккаунт", exact: true }).click();
  const exported = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Скачать мои данные", exact: true })
    .click();
  expect((await exported).suggestedFilename()).toMatch(
    /^imonmeets-data-.*\.json$/,
  );
  await page
    .getByRole("button", { name: "Удалить аккаунт", exact: true })
    .click();
  await page.getByLabel("Текущий пароль", { exact: true }).fill(password);
  await page
    .getByLabel("Введите DELETE для подтверждения", { exact: true })
    .fill("DELETE");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Удалить навсегда", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Войти в пространство", exact: true }),
  ).toBeVisible();
  expect((await page.request.get(`${base}/api/me`)).status()).toBe(401);
});
