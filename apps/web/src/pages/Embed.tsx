import { useCallback, useEffect, useState } from "react";
import { Brand, ErrorBox, Spinner } from "../ui";
import { guestApi } from "../api";
import type { Config } from "../api";
import { Join } from "./Join";
import {
  frameParameters,
  packet,
  parentCommand,
} from "../../../../packages/sdk/embed-protocol.js";
import type {
  MeetingEmbedEvent,
  MeetingEmbedState,
} from "../../../../packages/sdk/embed-protocol.js";

export default function Embed() {
  const [parameters] = useState(() => frameParameters(location.hash));
  const [slug] = useState(() => {
    const match = /^\/embed\/([A-Za-z0-9_-]{16,128})\/?$/.exec(
      location.pathname,
    );
    return match?.[1] ?? null;
  });
  const [config, setConfig] = useState<Config>();
  const [failure, setFailure] = useState("");
  const [name, setName] = useState<string>();
  const [leaveRequest, setLeaveRequest] = useState(0);
  const [notice, setNotice] = useState("");
  const allowed =
    !!parameters && !!config?.embedAllowedOrigins?.includes(parameters.origin);
  const send = useCallback(
    (event: MeetingEmbedEvent) => {
      if (allowed && parameters && window.parent !== window)
        window.parent.postMessage(
          packet(parameters.channel, event),
          parameters.origin,
        );
    },
    [allowed, parameters],
  );

  useEffect(() => {
    if (!slug || !parameters || window.parent === window) {
      setFailure(
        "Откройте встречу по обычной ссылке или через виджет на сайте организатора.",
      );
      return;
    }
    const controller = new AbortController();
    void guestApi<Config>("/config", undefined, undefined, {
      signal: controller.signal,
    })
      .then((value) => {
        if (controller.signal.aborted) return;
        if (
          !Array.isArray(value.embedAllowedOrigins) ||
          !value.embedAllowedOrigins.includes(parameters.origin)
        ) {
          setFailure(
            "Встраивание встреч на этом сайте не разрешено организатором сервиса.",
          );
          return;
        }
        setConfig(value);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setFailure(
            "Не удалось подключиться к сервису встреч. Обновите страницу или откройте встречу отдельно.",
          );
      });
    return () => controller.abort();
  }, [slug, parameters]);

  useEffect(() => {
    if (!allowed || !parameters) return;
    const receive = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== parameters.origin)
        return;
      const command = parentCommand(event.data, parameters.channel);
      if (command?.type === "configure")
        setName((current) => current ?? command.name ?? "");
      else if (command?.type === "leave") setLeaveRequest((value) => value + 1);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [allowed, parameters]);

  useEffect(() => {
    if (!allowed || name !== undefined) return;
    send({ type: "ready" });
    const retry = setInterval(() => send({ type: "ready" }), 1000);
    const timeout = setTimeout(() => {
      setFailure(
        "Сайт не завершил подключение виджета. Обновите страницу или откройте встречу отдельно.",
      );
      send({ type: "error", code: "INITIALIZATION_FAILED" });
    }, 20000);
    return () => {
      clearInterval(retry);
      clearTimeout(timeout);
    };
  }, [allowed, name, send]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(timer);
  }, [notice]);
  const notify = useCallback(
    (message: string, error?: boolean) => {
      setNotice(message);
      if (error) send({ type: "error", code: "REQUEST_FAILED" });
    },
    [send],
  );
  const stateChanged = useCallback(
    (state: MeetingEmbedState) => {
      send({ type: "state", state });
    },
    [send],
  );

  if (failure)
    return (
      <main className="embed-page embed-unavailable">
        <Brand />
        <h1>Не удалось открыть встречу</h1>
        <p>{failure}</p>
        {slug && (
          <a
            className="button primary"
            href={`/join/${slug}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Открыть встречу отдельно
          </a>
        )}
      </main>
    );
  if (!config || name === undefined || !slug)
    return (
      <main className="embed-page embed-unavailable" aria-live="polite">
        <Brand />
        <Spinner />
        <p>Подключаем встречу...</p>
      </main>
    );
  return (
    <div className="embed-page">
      <Join
        slug={slug}
        config={config}
        request={guestApi}
        embedded
        initialName={name}
        leaveRequest={leaveRequest}
        onStateChange={stateChanged}
        notify={notify}
      />
      {notice && (
        <div className="embed-notice" role="status">
          <ErrorBox error={notice} />
        </div>
      )}
    </div>
  );
}
