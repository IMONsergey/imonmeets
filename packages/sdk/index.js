/** A small transport SDK for a custom meeting UI. No credentials are persisted. */
export class ImonMeetsError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ImonMeetsError";
    this.status = status;
    this.code = code;
  }
}

const segment = (value) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    throw new TypeError("Expected a room slug");
  return value;
};
const bearer = (value) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value))
    throw new TypeError("Expected an opaque room token");
  return value;
};

export class ImonMeetsClient {
  #base;
  #fetch;
  #timeout;
  constructor({ baseUrl, fetch: request = fetch, timeoutMs = 15000 }) {
    const base = new URL(baseUrl);
    if (
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      !(
        base.protocol === "https:" ||
        (base.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
      )
    )
      throw new TypeError(
        "Use an HTTPS API base URL (HTTP is allowed only on loopback)",
      );
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 100 ||
      timeoutMs > 60000
    )
      throw new TypeError("timeoutMs must be between 100 and 60000");
    this.#base = base.href.replace(/\/$/, "");
    this.#fetch = request;
    this.#timeout = timeoutMs;
  }

  async #request(path, { method = "GET", body, headers = {}, signal } = {}) {
    const timeout = AbortSignal.timeout(this.#timeout);
    let response;
    try {
      response = await this.#fetch(`${this.#base}${path}`, {
        method,
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: {
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new ImonMeetsError(
        0,
        timeout.aborted ? "TIMEOUT" : "NETWORK_ERROR",
        "Не удалось связаться с IMON Meets.",
      );
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new ImonMeetsError(
        response.status,
        "INVALID_RESPONSE",
        "Сервис вернул неподдерживаемый ответ.",
      );
    }
    if (!response.ok)
      throw new ImonMeetsError(
        response.status,
        typeof data?.error?.code === "string"
          ? data.error.code
          : "REQUEST_FAILED",
        typeof data?.error?.message === "string"
          ? data.error.message
          : "Запрос не выполнен.",
      );
    return data;
  }

  getRoom(slug, { signal } = {}) {
    return this.#request(`/rooms/${segment(slug)}`, { signal });
  }

  join(slug, { name, waitingToken, signal } = {}) {
    if (typeof name !== "string" || !name.trim() || name.trim().length > 80)
      throw new TypeError(
        "A participant name of 1 to 80 characters is required",
      );
    return this.#request(`/rooms/${segment(slug)}/join`, {
      method: "POST",
      signal,
      body: {
        name: name.trim(),
        ...(waitingToken ? { waitingToken: bearer(waitingToken) } : {}),
      },
    });
  }

  waitingStatus(slug, waitingToken, { signal } = {}) {
    return this.#request(`/rooms/${segment(slug)}/waiting-status`, {
      method: "POST",
      body: { waitingToken: bearer(waitingToken) },
      signal,
    });
  }

  cancelWaiting(slug, waitingToken, { signal } = {}) {
    return this.#request(`/rooms/${segment(slug)}/waiting`, {
      method: "DELETE",
      body: { waitingToken: bearer(waitingToken) },
      signal,
    });
  }

  readMessages(slug, chatToken, { after, before, signal } = {}) {
    if (after && before) throw new TypeError("Use one chat cursor at a time");
    for (const cursor of [after, before])
      if (cursor !== undefined && !/^\d{1,19}$/.test(String(cursor)))
        throw new TypeError("Invalid chat cursor");
    const query =
      after !== undefined
        ? `?after=${after}`
        : before !== undefined
          ? `?before=${before}`
          : "";
    return this.#request(`/rooms/${segment(slug)}/chat${query}`, {
      headers: { "X-Imon-Room-Session": bearer(chatToken) },
      signal,
    });
  }

  sendMessage(
    slug,
    chatToken,
    { text, clientId = crypto.randomUUID(), signal },
  ) {
    if (typeof text !== "string" || !text.trim() || text.trim().length > 4000)
      throw new TypeError("A message of 1 to 4000 characters is required");
    if (
      typeof clientId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        clientId,
      )
    )
      throw new TypeError("clientId must be a UUID v4");
    return this.#request(`/rooms/${segment(slug)}/chat`, {
      method: "POST",
      headers: { "X-Imon-Room-Session": bearer(chatToken) },
      body: { text: text.trim(), clientId },
      signal,
    });
  }
}
