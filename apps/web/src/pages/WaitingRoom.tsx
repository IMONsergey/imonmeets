import { useEffect, useRef, useState } from "react";
import { Clock3, DoorOpen, ShieldCheck, UserCheck, X } from "lucide-react";
import { api, date } from "../api";
import type { WaitingRequest } from "../api";
import { Button, ErrorBox, Spinner } from "../ui";

export type WaitingGrant = {
  status: "waiting";
  requestId: string;
  waitingToken: string;
  expiresAt: string;
  name?: string;
  accountId?: string | null;
};

const waitingKey = (slug: string) => `imon.waiting.${slug}`;
export function readWaitingGrant(
  slug: string,
  accountId?: string,
): WaitingGrant | undefined {
  try {
    const saved = JSON.parse(
      sessionStorage.getItem(waitingKey(slug)) ?? "null",
    );
    if (
      saved?.status === "waiting" &&
      typeof saved.waitingToken === "string" &&
      typeof saved.requestId === "string" &&
      typeof saved.name === "string" &&
      (saved.accountId ?? null) === (accountId ?? null) &&
      Date.parse(saved.expiresAt) > Date.now()
    )
      return saved;
    sessionStorage.removeItem(waitingKey(slug));
  } catch {
    /* The waiting request still works when browser storage is unavailable. */
  }
  return undefined;
}
export function saveWaitingGrant(slug: string, grant?: WaitingGrant) {
  try {
    if (grant) sessionStorage.setItem(waitingKey(slug), JSON.stringify(grant));
    else sessionStorage.removeItem(waitingKey(slug));
  } catch {
    /* A reload will require a new request when storage is unavailable. */
  }
}

export function WaitingGuest({
  slug,
  grant,
  onAdmitted,
  onCancel,
  request = api,
  persist = true,
}: {
  slug: string;
  grant: WaitingGrant;
  onAdmitted: (token: string, signal: AbortSignal) => Promise<void>;
  onCancel: () => void;
  request?: typeof api;
  persist?: boolean;
}) {
  const [status, setStatus] = useState<"waiting" | "denied" | "expired">(
    "waiting",
  );
  const [error, setError] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [cancelFailed, setCancelFailed] = useState(false);
  const cancelRequested = useRef(false);
  const stopAdmission = useRef<(() => void) | null>(null);
  const [refresh, setRefresh] = useState(0);
  const admitted = useRef(onAdmitted);
  admitted.current = onAdmitted;
  useEffect(() => {
    if (status !== "waiting" || cancelRequested.current) return;
    const controller = new AbortController();
    let inFlight = false;
    let joining = false;
    const poll = async () => {
      if (
        inFlight ||
        joining ||
        cancelRequested.current ||
        controller.signal.aborted
      )
        return;
      inFlight = true;
      try {
        const result = await request<{
          status: "waiting" | "admitted" | "denied" | "expired";
          expiresAt: string;
        }>(
          `/rooms/${encodeURIComponent(slug)}/waiting-status`,
          { waitingToken: grant.waitingToken },
          "POST",
          { signal: controller.signal, sessionErrors: false },
        );
        if (controller.signal.aborted) return;
        setError("");
        if (result.status === "admitted") {
          joining = true;
          try {
            await admitted.current(grant.waitingToken, controller.signal);
          } finally {
            joining = false;
          }
        } else if (result.status !== "waiting") {
          if (persist) saveWaitingGrant(slug);
          setStatus(result.status);
        }
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    const stop = () => {
      controller.abort();
      clearInterval(timer);
    };
    stopAdmission.current = stop;
    return () => {
      stop();
      if (stopAdmission.current === stop) stopAdmission.current = null;
    };
  }, [slug, grant.waitingToken, status, refresh, request, persist]);
  return (
    <div className="standalone-card waiting-guest">
      <div className="empty-icon">
        {status === "waiting" ? <Clock3 size={29} /> : <DoorOpen size={29} />}
      </div>
      <h1>
        {cancelFailed
          ? "Автоматический вход остановлен"
          : status === "waiting"
            ? "Ждем разрешения организатора"
            : status === "denied"
              ? "Организатор отклонил запрос"
              : "Время ожидания истекло"}
      </h1>
      <p>
        {cancelFailed
          ? "Отмена на сервере не подтверждена. Повторите отмену или вернитесь к проверке устройств. Автоматического подключения не будет."
          : status === "waiting"
            ? `${grant.name || "Вы"} в зале ожидания. После разрешения вы подключитесь автоматически.`
            : status === "denied"
              ? "Свяжитесь с организатором, если считаете, что произошла ошибка."
              : "Вернитесь к проверке устройств и отправьте новый запрос."}
      </p>
      {status === "waiting" && !cancelFailed && (
        <>
          <div className="waiting-status" role="status">
            <Spinner /> Запрос на вход отправлен
          </div>
          <p className="form-note">
            <ShieldCheck size={15} /> Камера и микрофон не передают данные, пока
            вы ожидаете. Запрос действует до {date(grant.expiresAt)}.
          </p>
        </>
      )}
      <ErrorBox error={error} />
      {error && status === "waiting" && !cancelRequested.current && (
        <Button onClick={() => setRefresh((value) => value + 1)}>
          Проверить еще раз
        </Button>
      )}
      <Button
        className="full"
        busy={cancelling}
        onClick={async () => {
          if (status !== "waiting") {
            onCancel();
            return;
          }
          // Cancellation intent wins immediately, before DELETE completes.
          // It also aborts an admission request already started by the poll.
          cancelRequested.current = true;
          stopAdmission.current?.();
          setCancelling(true);
          setCancelFailed(false);
          setError("");
          try {
            await request(
              `/rooms/${encodeURIComponent(slug)}/waiting`,
              { waitingToken: grant.waitingToken },
              "DELETE",
              { sessionErrors: false },
            );
            if (persist) saveWaitingGrant(slug);
            onCancel();
          } catch (e) {
            setError((e as Error).message);
            setCancelFailed(true);
          } finally {
            setCancelling(false);
          }
        }}
      >
        {status === "waiting" ? "Отменить запрос" : "К проверке устройств"}
      </Button>
      {cancelFailed && (
        <Button className="full" onClick={onCancel}>
          К проверке устройств
        </Button>
      )}
    </div>
  );
}

export function WaitingList({
  requests,
  error,
  onRefresh,
  management,
  notify,
}: {
  requests: WaitingRequest[] | undefined;
  error: string;
  onRefresh: () => void;
  management: { workspaceId: string; roomId: string };
  notify: (text: string, error?: boolean) => void;
}) {
  const [busy, setBusy] = useState("");
  const decide = async (
    request: WaitingRequest,
    decision: "admitted" | "denied",
  ) => {
    setBusy(request.id);
    try {
      await api(
        `/workspaces/${management.workspaceId}/rooms/${management.roomId}/waiting/${request.id}`,
        { decision },
        "PATCH",
      );
      onRefresh();
      notify(
        decision === "admitted"
          ? `${request.name}: вход разрешен`
          : `${request.name}: запрос отклонен`,
      );
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy("");
    }
  };
  return (
    <section className="waiting-list" aria-label="Зал ожидания">
      <div className="waiting-list-heading">
        <h3>Зал ожидания</h3>
        <span>{requests?.length ?? 0}</span>
      </div>
      <ErrorBox error={error} />
      {!requests && !error && <Spinner />}
      {requests?.length === 0 && <p>Никто не ожидает входа</p>}
      {requests?.map((request) => (
        <div className="waiting-person" key={request.id}>
          <div>
            <strong>{request.name}</strong>
            <small>Ожидает с {date(request.createdAt)}</small>
          </div>
          <div className="waiting-actions">
            <Button
              className="primary"
              busy={busy === request.id}
              disabled={!!busy}
              aria-label={`Разрешить вход: ${request.name}`}
              onClick={() => void decide(request, "admitted")}
            >
              <UserCheck size={16} /> Впустить
            </Button>
            <Button
              className="icon-button"
              disabled={!!busy}
              aria-label={`Отклонить запрос: ${request.name}`}
              onClick={() => void decide(request, "denied")}
            >
              <X size={16} />
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}
