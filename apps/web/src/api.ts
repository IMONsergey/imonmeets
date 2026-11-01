export type Workspace = {
  id: string;
  name: string;
  role: "owner" | "admin" | "member";
  createdAt: string;
};
export type User = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  twoFactorEnabled?: boolean;
};
export type Room = {
  id: string;
  workspaceId: string;
  slug: string;
  title: string;
  description: string;
  startsAt: string | null;
  durationMinutes: number;
  allowGuests: boolean;
  waitingRoom?: boolean;
  maxParticipants: number;
  status: "open" | "closed";
  createdBy: string;
  createdAt: string;
};
export type Recording = {
  id: string;
  roomId: string;
  roomTitle: string;
  status: "starting" | "active" | "ending" | "complete" | "failed";
  startedAt: string;
  endedAt: string | null;
  sizeBytes: number | null;
  error: string | null;
  canManage?: boolean;
  expiresAt?: string | null;
  deletionPending?: boolean;
  hasTranscript?: boolean;
};
export type Config = {
  appName: string;
  registrationEnabled: boolean;
  emailVerificationRequired: boolean;
  emailConfigured: boolean;
  emailDelivery: "capture" | "external";
  mediaConfigured: boolean;
  recordingConfigured: boolean;
  transcriptionConfigured?: boolean;
  summaryConfigured?: boolean;
  embedAllowedOrigins?: string[];
};
export type Member = {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: Workspace["role"];
};
export type Invitation = {
  id: string;
  email: string;
  role: "admin" | "member";
  expiresAt: string;
};
export type ChatMessage = {
  id: string;
  identity: string;
  name: string;
  text: string;
  createdAt: string;
};
export type WaitingRequest = {
  id: string;
  name: string;
  createdAt: string;
  expiresAt: string;
  status: "waiting" | "admitted" | "denied";
};

export const AUTH_CHANGED_EVENT = "imon:auth-changed";
export const AUTH_STORAGE_KEY = "imon.auth.change";
type AuthChange = "signed-out" | "unauthorized" | "refresh";
const INTENT_PREFIX = "imon.auth.intent.";
const INTENT_ID_KEY = "imon.auth.intentId";
const INTENT_TTL = 24 * 60 * 60 * 1000;
const preferenceFallback = new Map<string, string>();
const authErrorMessages: Record<string, string> = {
  INVALID_PASSWORD: "Неверный текущий пароль.",
  INVALID_CODE: "Неверный код. Проверьте приложение и повторите попытку.",
  INVALID_BACKUP_CODE: "Резервный код не подходит или уже использован.",
  INVALID_TWO_FACTOR_COOKIE:
    "Время подтверждения истекло. Вернитесь ко входу и введите почту и пароль заново.",
  OTP_HAS_EXPIRED: "Код истек. Используйте новый код.",
  ACCOUNT_TEMPORARILY_LOCKED:
    "Слишком много неверных кодов. Подтверждение временно заблокировано, повторите позже.",
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE:
    "Слишком много попыток. Повторите подтверждение позднее.",
  TOTP_ALREADY_ENABLED:
    "Приложение-аутентификатор уже подключено. Обновите настройки аккаунта.",
};
let currentIntentId: string | null = null;
let authEpoch = 0;
export function markAuthStateChanged(): void {
  authEpoch++;
}

export function readLocalPreference(key: string): string | null {
  if (preferenceFallback.has(key)) return preferenceFallback.get(key)!;
  try {
    return localStorage.getItem(key) ?? preferenceFallback.get(key) ?? null;
  } catch {
    return preferenceFallback.get(key) ?? null;
  }
}
export function writeLocalPreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
    preferenceFallback.delete(key);
  } catch {
    preferenceFallback.set(key, value);
  }
}
function removePreference(key: string): void {
  preferenceFallback.delete(key);
  try {
    localStorage.removeItem(key);
  } catch {
    /* Storage can be denied by the browser. */
  }
}
function sessionPreference(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function origin(): string {
  return typeof location === "undefined" ? "http://localhost" : location.origin;
}
export function safeReturnTo(value: unknown, base = origin()): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\u0000-\u001f\u007f]/.test(value)
  )
    return "/";
  try {
    const url = new URL(value, base);
    if (url.origin !== new URL(base).origin) return "/";
    if (
      !["/", "/rooms", "/recordings", "/team", "/settings", "/invite"].includes(
        url.pathname,
      ) &&
      !/^\/join\/[^/]+$/.test(url.pathname)
    )
      return "/";
    return url.pathname + url.search + url.hash;
  } catch {
    return "/";
  }
}
function activeIntent(): { id: string; path: string } | null {
  const fromCallback =
    typeof location === "undefined"
      ? null
      : new URLSearchParams(location.search).get("intent");
  const id =
    fromCallback ??
    currentIntentId ??
    sessionPreference(INTENT_ID_KEY) ??
    readLocalPreference(INTENT_ID_KEY);
  if (!id || !/^[a-zA-Z0-9_-]{16,80}$/.test(id)) return null;
  try {
    const saved = JSON.parse(
      readLocalPreference(INTENT_PREFIX + id) ?? "null",
    ) as { path?: unknown; expiresAt?: unknown } | null;
    if (
      !saved ||
      typeof saved.expiresAt !== "number" ||
      saved.expiresAt < Date.now()
    ) {
      removePreference(INTENT_PREFIX + id);
      return null;
    }
    if (fromCallback) {
      currentIntentId = id;
      try {
        sessionStorage.setItem(INTENT_ID_KEY, id);
      } catch {
        /* In-memory intent survives route changes. */
      }
    }
    return { id, path: safeReturnTo(saved.path) };
  } catch {
    return null;
  }
}
export function rememberReturnTo(path: string): void {
  const id =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
  currentIntentId = id;
  writeLocalPreference(
    INTENT_PREFIX + id,
    JSON.stringify({
      path: safeReturnTo(path),
      expiresAt: Date.now() + INTENT_TTL,
    }),
  );
  writeLocalPreference(INTENT_ID_KEY, id);
  try {
    sessionStorage.setItem(INTENT_ID_KEY, id);
  } catch {
    /* Same-tab memory fallback remains available. */
  }
}
export function getReturnTo(): string {
  return activeIntent()?.path ?? "/";
}
export function takeReturnTo(): string {
  const intent = activeIntent();
  if (!intent) return "/";
  removePreference(INTENT_PREFIX + intent.id);
  if (readLocalPreference(INTENT_ID_KEY) === intent.id)
    removePreference(INTENT_ID_KEY);
  try {
    if (sessionStorage.getItem(INTENT_ID_KEY) === intent.id)
      sessionStorage.removeItem(INTENT_ID_KEY);
  } catch {
    /* Optional storage. */
  }
  if (currentIntentId === intent.id) currentIntentId = null;
  return intent.path;
}
export function authCallbackURL(
  destination: "/verify-email" | "/reset-password" = "/verify-email",
): string {
  const existing = activeIntent();
  if (existing)
    return `${origin()}${destination}?intent=${encodeURIComponent(existing.id)}`;
  // The current URL may still contain an invalid/expired callback ID. Do not
  // re-read it after creating the replacement intent.
  rememberReturnTo("/");
  return `${origin()}${destination}?intent=${encodeURIComponent(currentIntentId!)}`;
}
export function parseJoinSlug(path: string): string | null {
  try {
    if (!path.startsWith("/join/")) return null;
    const slug = decodeURIComponent(path.slice(6));
    return /^[a-zA-Z0-9_-]{16,128}$/.test(slug) ? slug : null;
  } catch {
    return null;
  }
}
export function notifyAuthChange(reason: AuthChange = "refresh"): void {
  markAuthStateChanged();
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(AUTH_CHANGED_EVENT, { detail: { reason } }),
  );
  try {
    localStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({
        reason,
        at: Date.now(),
        id: globalThis.crypto?.randomUUID?.() ?? Math.random(),
      }),
    );
  } catch {
    /* Same-tab notification already dispatched. */
  }
}

export async function api<T>(
  path: string,
  body?: unknown,
  method?: string,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    headers?: Record<string, string>;
    sessionErrors?: boolean;
    credentials?: RequestCredentials;
  } = {},
): Promise<T> {
  const requestAuthEpoch = authEpoch;
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? 15_000);
  try {
    const response = await fetch(`/api${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      credentials: options.credentials ?? "include",
      cache: "no-store",
      redirect: "error",
      headers: {
        ...options.headers,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    let data: Record<string, any> = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      throw new ApiError(
        "Сервис вернул некорректный ответ. Попробуйте еще раз.",
        response.status,
        "INVALID_RESPONSE",
      );
    }
    if (!response.ok) {
      if (
        response.status === 401 &&
        options.sessionErrors !== false &&
        !path.startsWith("/auth/") &&
        requestAuthEpoch === authEpoch
      )
        notifyAuthChange("unauthorized");
      else if (
        response.status === 403 &&
        options.sessionErrors !== false &&
        !path.startsWith("/auth/") &&
        path !== "/me" &&
        ["NOT_MEMBER", "FORBIDDEN"].includes(data.error?.code)
      )
        notifyAuthChange("refresh");
      throw new ApiError(
        (response.status === 429
          ? "Слишком много попыток. Подождите немного и повторите запрос."
          : undefined) ??
          (path.startsWith("/auth/")
            ? authErrorMessages[data.error?.code ?? data.code]
            : undefined) ??
          data.error?.message ??
          data.message ??
          "Не удалось выполнить запрос. Попробуйте еще раз.",
        response.status,
        data.error?.code ?? data.code,
      );
    }
    if (path === "/auth/sign-out") notifyAuthChange("signed-out");
    else if (
      [
        "/auth/update-user",
        "/auth/change-password",
        "/auth/reset-password",
        "/auth/sign-in/email",
        "/auth/two-factor/verify-totp",
        "/auth/two-factor/verify-backup-code",
        "/auth/two-factor/disable",
      ].includes(path)
    )
      notifyAuthChange("refresh");
    return data as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted)
      throw new ApiError(
        timedOut
          ? "Сервер не ответил вовремя. Проверьте результат перед повтором."
          : "Запрос отменен.",
        0,
        timedOut ? "REQUEST_TIMEOUT" : "REQUEST_ABORTED",
      );
    throw new ApiError(
      "Не удалось связаться с сервисом. Проверьте подключение и повторите запрос.",
      0,
      "NETWORK_ERROR",
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}
/** The embedded guest view never inherits a signed-in account's cookies. */
export const guestApi: typeof api = (path, body, method, options) => {
  const verb = method ?? (body === undefined ? "GET" : "POST");
  const match =
    /^\/rooms\/[A-Za-z0-9_-]{16,128}(?:\/(join|waiting-status|waiting|chat))?(?:\?(?:after|before)=\d{1,19})?$/.exec(
      path,
    );
  const allowed =
    (path === "/config" && verb === "GET") ||
    (match &&
      ((!match[1] && verb === "GET") ||
        (["join", "waiting-status"].includes(match[1] ?? "") &&
          verb === "POST") ||
        (match[1] === "waiting" && verb === "DELETE") ||
        (match[1] === "chat" && ["GET", "POST"].includes(verb))));
  if (!allowed)
    return Promise.reject(
      new ApiError(
        "Этот запрос недоступен гостевому виджету.",
        403,
        "EMBED_REQUEST_REJECTED",
      ),
    );
  return api(path, body, method, {
    ...options,
    credentials: "omit",
    sessionErrors: false,
  });
};
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}
export const date = (value: string | null, time = true) =>
  value
    ? new Intl.DateTimeFormat("ru-RU", {
        day: "numeric",
        month: "short",
        ...(time ? { hour: "2-digit", minute: "2-digit" } : {}),
      }).format(new Date(value))
    : "Без расписания";
export const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
export const meetingUrl = (slug: string) =>
  `${location.origin}/join/${encodeURIComponent(slug)}`;
