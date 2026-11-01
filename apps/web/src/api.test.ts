import assert from "node:assert/strict";
import test from "node:test";
import {
  api,
  ApiError,
  authCallbackURL,
  getReturnTo,
  rememberReturnTo,
  parseJoinSlug,
  readLocalPreference,
  safeReturnTo,
  takeReturnTo,
  writeLocalPreference,
  AUTH_CHANGED_EVENT,
} from "./api";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  clear() {
    this.values.clear();
  }
}
const local = new MemoryStorage();
const session = new MemoryStorage();
const fixtureLocation = { origin: "https://audit.invalid", search: "" };
Object.defineProperties(globalThis, {
  location: { value: fixtureLocation, configurable: true },
  localStorage: { value: local, configurable: true },
  sessionStorage: { value: session, configurable: true },
});

test("auth destinations reject cross-origin, protocol-relative, control and auth-loop paths", () => {
  for (const value of [
    "https://evil.invalid/",
    "//evil.invalid/",
    "/\\evil.invalid/",
    "/login",
    "/register",
    "/verify-email?success=1",
    "/settings\n",
  ]) {
    assert.equal(safeReturnTo(value), "/");
  }
  assert.equal(safeReturnTo("/invite#token=fixture"), "/invite#token=fixture");
  assert.equal(safeReturnTo("/rooms?q=project"), "/rooms?q=project");
});

test("new-tab callback restores the specific intent without exposing invitation token in callback URL", () => {
  rememberReturnTo("/invite#token=private-fixture-token");
  const callback = authCallbackURL();
  assert.equal(callback.includes("private-fixture-token"), false);
  assert.equal(callback.includes("/invite"), false);
  rememberReturnTo("/rooms?q=other-tab");
  fixtureLocation.search = new URL(callback).search;
  session.clear();
  assert.equal(getReturnTo(), "/invite#token=private-fixture-token");
  assert.equal(takeReturnTo(), "/invite#token=private-fixture-token");
  assert.equal(getReturnTo(), "/");
  fixtureLocation.search = "";
  assert.equal(takeReturnTo(), "/rooms?q=other-tab");
});

test("intent expires, cannot redirect through poisoned stored payload and blocked storage remains usable", () => {
  rememberReturnTo("/settings");
  const id = new URL(authCallbackURL()).searchParams.get("intent")!;
  local.setItem(
    `imon.auth.intent.${id}`,
    JSON.stringify({
      path: "https://evil.invalid/",
      expiresAt: Date.now() + 10000,
    }),
  );
  assert.equal(getReturnTo(), "/");
  local.setItem(
    `imon.auth.intent.${id}`,
    JSON.stringify({ path: "/settings", expiresAt: Date.now() - 1 }),
  );
  assert.equal(getReturnTo(), "/");
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
  Object.defineProperty(globalThis, "localStorage", {
    get() {
      throw new Error("denied");
    },
    configurable: true,
  });
  try {
    writeLocalPreference("fixture-blocked", "works");
    assert.equal(readLocalPreference("fixture-blocked"), "works");
    rememberReturnTo("/team");
    assert.equal(takeReturnTo(), "/team");
  } finally {
    Object.defineProperty(globalThis, "localStorage", original);
  }
});

test("resend/reset generates a valid replacement for an invalid or expired callback intent", () => {
  for (const prior of ["invalid", "expired-fixture-intent-1234"]) {
    fixtureLocation.search = `?intent=${prior}`;
    const callback = authCallbackURL("/reset-password");
    const url = new URL(callback);
    assert.equal(url.pathname, "/reset-password");
    assert.notEqual(url.searchParams.get("intent"), prior);
    fixtureLocation.search = url.search;
    assert.equal(takeReturnTo(), "/");
  }
  fixtureLocation.search = "";
});

test("join parser handles malformed encoding, separators and valid room slugs", () => {
  for (const path of [
    "/join/%ZZ",
    "/join/%",
    "/join/a%2Fb",
    "/join/short",
    "/not-a-room",
  ]) {
    assert.equal(parseJoinSlug(path), null);
  }
  assert.equal(
    parseJoinSlug("/join/abcdefghijklmnop_123-456"),
    "abcdefghijklmnop_123-456",
  );
});

test("request deadline and explicit cancellation produce distinct actionable errors", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    (_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      }),
  );
  await assert.rejects(
    api("/fixture", undefined, undefined, { timeoutMs: 15 }),
    (e) => e instanceof ApiError && e.code === "REQUEST_TIMEOUT",
  );
  const controller = new AbortController();
  const pending = api("/fixture", undefined, undefined, {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(
    pending,
    (e) => e instanceof ApiError && e.code === "REQUEST_ABORTED",
  );
});

test("API keeps HTTP error envelopes and rejects malformed successful responses", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          error: { code: "FORBIDDEN", message: "Недостаточно прав." },
        }),
        { status: 403 },
      ),
  );
  await assert.rejects(
    api("/fixture"),
    (e) => e instanceof ApiError && e.status === 403 && e.code === "FORBIDDEN",
  );
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("not json", { status: 200 }),
  );
  await assert.rejects(
    api("/fixture"),
    (e) => e instanceof ApiError && e.code === "INVALID_RESPONSE",
  );
});

test("a stale protected response cannot invalidate a newly authenticated session", async (t) => {
  const events: string[] = [];
  const target = new EventTarget();
  target.addEventListener(AUTH_CHANGED_EVENT, (event) =>
    events.push((event as CustomEvent).detail.reason),
  );
  Object.defineProperty(globalThis, "window", {
    value: target,
    configurable: true,
  });
  let resolveOld!: (response: Response) => void;
  t.mock.method(globalThis, "fetch", async (url: unknown) =>
    String(url).endsWith("/old")
      ? new Promise<Response>((resolve) => {
          resolveOld = resolve;
        })
      : new Response(JSON.stringify({ success: true }), { status: 200 }),
  );
  try {
    const stale = api("/old");
    await api("/auth/sign-in/email", {
      email: "fixture@example.invalid",
      password: "synthetic",
    });
    resolveOld(
      new Response(
        JSON.stringify({
          error: { code: "UNAUTHENTICATED", message: "Войдите." },
        }),
        { status: 401 },
      ),
    );
    await assert.rejects(
      stale,
      (e) => e instanceof ApiError && e.status === 401,
    );
    assert.deepEqual(events, ["refresh"]);
  } finally {
    Reflect.deleteProperty(globalThis, "window");
  }
});

test("room-scoped credentials use headers and their expiration does not sign the account out", async (t) => {
  const events: string[] = [];
  const target = new EventTarget();
  target.addEventListener(AUTH_CHANGED_EVENT, (event) =>
    events.push((event as CustomEvent).detail.reason),
  );
  Object.defineProperty(globalThis, "window", {
    value: target,
    configurable: true,
  });
  t.mock.method(
    globalThis,
    "fetch",
    async (url: unknown, init?: RequestInit) => {
      assert.equal(String(url).includes("private-room-token"), false);
      assert.equal(
        new Headers(init?.headers).get("x-imon-room-session"),
        "private-room-token",
      );
      return new Response(
        JSON.stringify({
          error: {
            code: "ROOM_SESSION_EXPIRED",
            message: "Переподключитесь к встрече.",
          },
        }),
        { status: 401 },
      );
    },
  );
  try {
    await assert.rejects(
      api("/rooms/fixture/chat", undefined, undefined, {
        headers: { "x-imon-room-session": "private-room-token" },
        sessionErrors: false,
      }),
      (error) => error instanceof ApiError && error.status === 401,
    );
    assert.deepEqual(events, []);
  } finally {
    Reflect.deleteProperty(globalThis, "window");
  }
});
