import { exactOrigin, frameEvent, packet } from "./embed-protocol.js";
import { ImonMeetsError } from "./index.js";

/** Mount the real, cookie-free guest meeting UI. The host must be allowlisted. */
export function mountMeeting({
  container,
  appUrl,
  room,
  name,
  title = "IMON Meets: видеовстреча",
  height = 680,
  timeoutMs = 20000,
  onEvent = () => {},
}) {
  const hostWindow = container?.ownerDocument?.defaultView;
  if (!hostWindow || !(container instanceof hostWindow.HTMLElement))
    throw new TypeError(
      "container must be an HTML element in a browser document",
    );
  const origin = exactOrigin(appUrl);
  const parentOrigin = exactOrigin(hostWindow.location.origin);
  if (!origin || !parentOrigin)
    throw new TypeError(
      "Use an HTTPS application origin (HTTP is allowed only on loopback)",
    );
  if (typeof room !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(room))
    throw new TypeError("Expected a room slug from an IMON Meets guest link");
  if (
    name !== undefined &&
    (typeof name !== "string" || name.trim().length > 80)
  )
    throw new TypeError("name must contain at most 80 characters");
  if (typeof title !== "string" || !title.trim() || title.length > 200)
    throw new TypeError("A short, accessible frame title is required");
  if (!Number.isSafeInteger(height) || height < 420 || height > 2160)
    throw new TypeError("height must be between 420 and 2160 pixels");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000)
    throw new TypeError("timeoutMs must be between 1000 and 60000");
  if (typeof onEvent !== "function")
    throw new TypeError("onEvent must be a function");

  const channel = [...hostWindow.crypto.getRandomValues(new Uint8Array(16))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  const frame = container.ownerDocument.createElement("iframe");
  frame.title = title;
  frame.allow = "camera; microphone; display-capture; fullscreen; autoplay";
  frame.allowFullscreen = true;
  frame.referrerPolicy = "no-referrer";
  frame.setAttribute(
    "sandbox",
    "allow-scripts allow-same-origin allow-forms allow-popups",
  );
  frame.setAttribute("loading", "eager");
  frame.style.cssText = `display:block;width:100%;height:${height}px;border:0;background:#fff;color-scheme:light;`;
  frame.src = `${origin}/embed/${room}#${new URLSearchParams({ origin: parentOrigin, channel })}`;

  let disposed = false;
  let initialized = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Consumers can use onEvent alone without an unhandled Promise rejection.
  void ready.catch(() => {});
  const send = (body) =>
    frame.contentWindow?.postMessage(packet(channel, body), origin);
  const report = (event) => {
    try {
      onEvent(event);
    } catch (error) {
      hostWindow.setTimeout(() => {
        throw error;
      }, 0);
    }
  };
  const timeout = hostWindow.setTimeout(() => {
    if (disposed || initialized) return;
    disposed = true;
    hostWindow.clearTimeout(timeout);
    hostWindow.removeEventListener("message", receive);
    frame.remove();
    rejectReady(
      new ImonMeetsError(
        0,
        "EMBED_TIMEOUT",
        "Виджет не запустился. Проверьте разрешенный домен и доступность сервиса.",
      ),
    );
    report({ type: "error", code: "INITIALIZATION_FAILED" });
  }, timeoutMs);
  const receive = (event) => {
    if (
      disposed ||
      event.source !== frame.contentWindow ||
      event.origin !== origin
    )
      return;
    const data = frameEvent(event.data, channel);
    if (!data) return;
    if (data.type === "ready") {
      send({
        type: "configure",
        ...(name === undefined ? {} : { name: name.trim() }),
      });
      if (initialized) return;
      initialized = true;
      hostWindow.clearTimeout(timeout);
      resolveReady();
    }
    if (!initialized) return;
    report(data);
  };
  hostWindow.addEventListener("message", receive);
  container.append(frame);
  return Object.freeze({
    iframe: frame,
    ready,
    leave() {
      if (!disposed && initialized) send({ type: "leave" });
    },
    destroy() {
      if (disposed) return;
      if (initialized) send({ type: "leave" });
      disposed = true;
      hostWindow.clearTimeout(timeout);
      hostWindow.removeEventListener("message", receive);
      frame.remove();
      if (!initialized)
        rejectReady(
          new ImonMeetsError(
            0,
            "EMBED_DESTROYED",
            "Виджет закрыт до подключения.",
          ),
        );
    },
  });
}
