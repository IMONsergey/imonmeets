import { test, expect, type Locator } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

const base = new URL(process.env.BASE_URL || "https://imonmeets.vercel.app")
  .origin;
const email = process.env.REVIEW_EMAIL || "",
  password = process.env.REVIEW_PASSWORD || "";
const action = process.env.RECORDING_BACKUP_ACTION || "";
const fixturePath = process.env.RECORDING_BACKUP_FIXTURE || "";
const purpose = "imonmeets-recording-backup-acceptance-v1";
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
type Fixture = {
  version: 1;
  purpose: typeof purpose;
  base: string;
  runId: string;
  workspaceName: string;
  roomTitle: string;
  createdAt: string;
  workspaceId: string | null;
  roomId: string | null;
  recordingId: string | null;
  phase: "creating" | "complete" | "cleaned";
  bytes?: number;
  sha256?: string;
  expiresAt?: string;
  completedAt?: string;
};
type Recording = {
  id: string;
  roomId: string;
  roomTitle: string;
  status: string;
  sizeBytes: number | null;
  expiresAt: string | null;
};

test.use({ trace: "off", screenshot: "off", video: "off" });
test.skip(
  process.env.RECORDING_BACKUP_ACCEPTANCE !== "true" ||
    !email ||
    !password ||
    !fixturePath,
  "Requires explicit backup acceptance, private fixture path and a verified review account",
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

async function privateDirectory() {
  if (!isAbsolute(fixturePath))
    throw new Error("Fixture path must be absolute");
  await mkdir(dirname(fixturePath), { recursive: true, mode: 0o700 });
  const info = await lstat(dirname(fixturePath));
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077)
    throw new Error("Fixture directory must be private with mode 0700");
}

async function writeFixture(value: Fixture, initial = false) {
  const temporary = `${fixturePath}.pending-${randomUUID()}`;
  const handle = await open(initial ? fixturePath : temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (!initial) {
    try {
      await rename(temporary, fixturePath);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
}

async function readFixture(): Promise<Fixture> {
  const handle = await open(
    fixturePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.mode & 0o077 || info.size > 8192)
      throw new Error("Fixture must be a small private regular file");
    const value = JSON.parse(await handle.readFile("utf8")) as Fixture;
    if (
      value.version !== 1 ||
      value.purpose !== purpose ||
      value.base !== base ||
      !uuid.test(value.runId) ||
      value.workspaceName !== `Backup acceptance ${value.runId}` ||
      value.roomTitle !== `Synthetic backup ${value.runId}` ||
      !["creating", "complete", "cleaned"].includes(value.phase) ||
      [value.workspaceId, value.roomId, value.recordingId].some(
        (id) => id !== null && (typeof id !== "string" || !uuid.test(id)),
      )
    )
      throw new Error("Fixture scope is invalid");
    return value;
  } finally {
    await handle.close();
  }
}

async function privateMp4(url: unknown) {
  try {
    if (typeof url !== "string") throw new Error();
    const target = new URL(url);
    if (
      target.username ||
      target.password ||
      !(
        target.protocol === "https:" ||
        (target.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname))
      )
    )
      throw new Error();
    const response = await fetch(target, {
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    if (response.status !== 200 || !response.body) throw new Error();
    const reader = response.body.getReader(),
      digest = createHash("sha256");
    let bytes = 0,
      head = Buffer.alloc(0);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 64 * 1024 * 1024) {
          await reader.cancel();
          throw new Error();
        }
        if (head.length < 16)
          head = Buffer.concat([head, Buffer.from(value)]).subarray(0, 16);
        digest.update(value);
      }
    } finally {
      reader.releaseLock();
    }
    if (bytes <= 1024 || head.subarray(4, 8).toString("ascii") !== "ftyp")
      throw new Error();
    return { bytes, sha256: digest.digest("hex") };
  } catch {
    throw new Error(
      "Private MP4 verification failed; signed URLs and original causes are not retained",
    );
  }
}

test("production backup witness: explicit creation or scoped cleanup of one synthetic MP4", async ({
  page,
}) => {
  test.setTimeout(360000);
  expect(
    test
      .info()
      .project.use.launchOptions?.args?.includes(
        "--use-fake-device-for-media-stream",
      ),
    "This acceptance must run with synthetic devices, never real camera or microphone",
  ).toBe(true);
  expect(
    ["create", "cleanup"].includes(action),
    "Choose an explicit create or cleanup action",
  ).toBe(true);
  await privateDirectory();
  let fixture: Fixture | undefined,
    cookie = "",
    retained = false;
  const api = async (
    path: string,
    method = "GET",
    data?: unknown,
  ): Promise<{ status: number; body: any }> => {
    try {
      const response = await fetch(new URL(path, base), {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(25000),
        headers: {
          origin: base,
          ...(cookie ? { cookie } : {}),
          ...(data === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      const content = await response.text();
      if (content.length > 1024 * 1024) throw new Error();
      return {
        status: response.status,
        body: content ? JSON.parse(content) : {},
      };
    } catch {
      throw new Error(
        "Acceptance API request failed; raw URLs, credentials and response bodies are not retained",
      );
    }
  };
  const workspacePath = () => `/api/workspaces/${fixture!.workspaceId}`;
  const recordings = async (): Promise<Recording[]> => {
    const result = await api(`${workspacePath()}/recordings`);
    expect(
      result.status,
      "The owner can inspect this fixture's recordings",
    ).toBe(200);
    return result.body.recordings;
  };
  const cleanup = async () => {
    if (!fixture?.workspaceId || fixture.phase === "cleaned") return;
    const session = await api("/api/me");
    expect(session.status).toBe(200);
    const owned = session.body.workspaces?.find(
      (item: any) => item.id === fixture!.workspaceId,
    );
    expect(
      owned?.role === "owner" && owned?.name === fixture.workspaceName,
      "Cleanup requires the exact synthetic workspace and its current owner",
    ).toBe(true);
    const rooms = await api(`${workspacePath()}/rooms`);
    expect(rooms.status).toBe(200);
    expect(
      Array.isArray(rooms.body.rooms) &&
        rooms.body.rooms.every(
          (item: any) =>
            item.id === fixture!.roomId && item.title === fixture!.roomTitle,
        ),
      "Cleanup refuses a workspace containing any unrelated room",
    ).toBe(true);
    const current = await recordings();
    expect(
      current.every(
        (item) =>
          item.id === fixture!.recordingId &&
          item.roomId === fixture!.roomId &&
          item.roomTitle === fixture!.roomTitle,
      ),
      "Cleanup refuses any recording outside the exact created IDs",
    ).toBe(true);
    const selected = current.find((item) => item.id === fixture!.recordingId);
    if (selected && ["starting", "active", "ending"].includes(selected.status))
      await api(
        `${workspacePath()}/recordings/${selected.id}/stop`,
        "POST",
        {},
      );
    if (fixture.roomId) {
      const closed = await api(
        `${workspacePath()}/rooms/${fixture.roomId}/close`,
        "POST",
        {},
      );
      expect(
        [200, 503].includes(closed.status),
        "Only the fixture room is closed",
      ).toBe(true);
    }
    if (selected && ["starting", "active", "ending"].includes(selected.status))
      await expect
        .poll(
          async () => {
            const item = (await recordings()).find(
              (recording) => recording.id === fixture!.recordingId,
            );
            return !item || ["complete", "failed"].includes(item.status);
          },
          {
            timeout: 120000,
            intervals: [1000, 2000, 3000],
            message: "The fixture recording stops before deletion",
          },
        )
        .toBe(true);
    if (fixture.recordingId) {
      const deleted = await api(
        `${workspacePath()}/recordings/${fixture.recordingId}`,
        "DELETE",
      );
      expect(
        [200, 404].includes(deleted.status),
        "Only the fixture MP4 is withdrawn",
      ).toBe(true);
      await expect
        .poll(
          async () =>
            !(await recordings()).some(
              (item) => item.id === fixture!.recordingId,
            ),
          {
            timeout: 90000,
            intervals: [1000, 2000, 3000],
            message: "The fixture MP4 finishes its storage cleanup",
          },
        )
        .toBe(true);
    }
    await expect
      .poll(
        async () =>
          (
            await api(workspacePath(), "DELETE", {
              password,
              confirmation: "DELETE",
            })
          ).status,
        {
          timeout: 30000,
          intervals: [1000, 2000, 3000],
          message: "The isolated fixture workspace is removed",
        },
      )
      .toBe(200);
    fixture.phase = "cleaned";
    await writeFixture(fixture);
  };
  try {
    if (action === "cleanup") {
      fixture = await readFixture();
      if (fixture.phase === "cleaned") return;
    } else {
      const runId = randomUUID();
      fixture = {
        version: 1,
        purpose,
        base,
        runId,
        workspaceName: `Backup acceptance ${runId}`,
        roomTitle: `Synthetic backup ${runId}`,
        createdAt: new Date().toISOString(),
        workspaceId: null,
        roomId: null,
        recordingId: null,
        phase: "creating",
      };
      // A previous fixture is never silently overwritten or mixed into this run.
      await writeFixture(fixture, true);
    }
    await page.goto(`${base}/login`).catch(() => {
      throw new Error("Review login page could not be opened");
    });
    await enterCredential(page.getByLabel("Рабочая почта"), email);
    await enterCredential(page.getByLabel("Пароль", { exact: true }), password);
    await page
      .getByRole("button", { name: "Войти в пространство", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: /^Добрый день,/ }),
    ).toBeVisible();
    cookie = (await page.context().cookies(base))
      .map((item) => `${item.name}=${item.value}`)
      .join("; ");
    expect(
      cookie.length > 0,
      "A private authenticated cleanup capability exists",
    ).toBe(true);
    if (action === "cleanup") {
      await cleanup();
      return;
    }

    const config = await api("/api/config");
    expect(config.status, "Configuration loads").toBe(200);
    expect(
      config.body.recordingConfigured,
      "Real Egress and private storage are enabled",
    ).toBe(true);
    const createdWorkspace = await api("/api/workspaces", "POST", {
      name: fixture.workspaceName,
    });
    expect(createdWorkspace.status).toBe(200);
    fixture.workspaceId = createdWorkspace.body.workspace?.id;
    expect(
      typeof fixture.workspaceId === "string" && uuid.test(fixture.workspaceId),
      "A new fixture workspace is identified",
    ).toBe(true);
    await writeFixture(fixture);
    const createdRoom = await api(`${workspacePath()}/rooms`, "POST", {
      title: fixture.roomTitle,
      allowGuests: false,
      waitingRoom: true,
      maxParticipants: 2,
      durationMinutes: 30,
    });
    expect(createdRoom.status).toBe(200);
    fixture.roomId = createdRoom.body.room?.id;
    expect(
      typeof fixture.roomId === "string" && uuid.test(fixture.roomId),
      "A new fixture room is identified",
    ).toBe(true);
    await writeFixture(fixture);
    const slug = createdRoom.body.room.slug;
    expect(
      typeof slug === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(slug),
    ).toBe(true);
    await page.goto(`${base}/join/${slug}`).catch(() => {
      throw new Error("Synthetic recording room could not be opened");
    });
    await page
      .getByRole("button", { name: "Присоединиться к встрече", exact: true })
      .click();
    await expect(page.locator(".lk-participant-tile")).toHaveCount(1);
    await expect
      .poll(
        () =>
          page
            .locator("video")
            .evaluateAll((videos) =>
              videos.some(
                (video) =>
                  video instanceof HTMLVideoElement &&
                  video.readyState >= 2 &&
                  video.videoWidth > 0,
              ),
            ),
        {
          message: "The synthetic camera is publishing frames",
        },
      )
      .toBe(true);
    const [start] = await Promise.all([
      page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.origin === base &&
          url.pathname ===
            `${workspacePath()}/rooms/${fixture!.roomId}/recordings` &&
          response.request().method() === "POST"
        );
      }),
      page.getByRole("button", { name: "Записать", exact: true }).click(),
    ]);
    expect(start.status(), "The service accepted the fixture recording").toBe(
      200,
    );
    fixture.recordingId = (await start.json()).recording?.id;
    expect(
      typeof fixture.recordingId === "string" && uuid.test(fixture.recordingId),
      "The exact fixture recording ID is captured",
    ).toBe(true);
    await writeFixture(fixture);
    await expect
      .poll(
        async () => {
          const item = (await recordings()).find(
            (recording) => recording.id === fixture!.recordingId,
          );
          if (item?.status === "failed")
            throw new Error("Synthetic Egress recording failed");
          return item?.status;
        },
        {
          timeout: 90000,
          intervals: [1000, 2000, 3000],
          message: "Real Egress reaches active state",
        },
      )
      .toBe("active");
    await page.waitForTimeout(8000);
    await page
      .getByRole("button", { name: "Остановить запись", exact: true })
      .click();
    let complete: Recording | undefined;
    await expect
      .poll(
        async () => {
          complete = (await recordings()).find(
            (recording) => recording.id === fixture!.recordingId,
          );
          if (complete?.status === "failed")
            throw new Error("Synthetic Egress finalization failed");
          return complete?.status;
        },
        {
          timeout: 120000,
          intervals: [1000, 2000, 3000],
          message: "A completed private MP4 is available",
        },
      )
      .toBe("complete");
    expect(Number(complete?.sizeBytes)).toBeGreaterThan(1024);
    expect(Date.parse(complete?.expiresAt || "") > Date.now()).toBe(true);
    const download = await api(
      `${workspacePath()}/recordings/${fixture.recordingId}/download`,
    );
    expect(download.status).toBe(200);
    const verified = await privateMp4(download.body.url);
    expect(
      verified.bytes,
      "The complete object matches the API's declared length",
    ).toBe(Number(complete!.sizeBytes));
    const close = await api(
      `${workspacePath()}/rooms/${fixture.roomId}/close`,
      "POST",
      {},
    );
    expect(close.status).toBe(200);
    fixture = {
      ...fixture,
      ...verified,
      phase: "complete",
      expiresAt: complete!.expiresAt!,
      completedAt: new Date().toISOString(),
    };
    await writeFixture(fixture);
    retained = true;
    // Intentionally retain only this verified synthetic MP4 between the explicit
    // create and cleanup actions. No signed grant or plaintext is written to disk.
  } finally {
    if (action === "create" && fixture?.workspaceId && cookie && !retained)
      await cleanup();
    cookie = "";
  }
});
