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
}: {
  slug: string;
  grant: WaitingGrant;
  onAdmitted: (token: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [status, setStatus] = useState<"waiting" | "denied" | "expired">(
    "waiting",
  );
  const [error, setError] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const admitted = useRef(onAdmitted);
  admitted.current = onAdmitted;
  useEffect(() => {
    if (status !== "waiting") return;
    const controller = new AbortController();
    let inFlight = false;
    let joining = false;
    const poll = async () => {
      if (inFlight || joining) return;
      inFlight = true;
      try {
        const result = await api<{
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
            await admitted.current(grant.waitingToken);
          } finally {
            joining = false;
          }
        } else if (result.status !== "waiting") {
          saveWaitingGrant(slug);
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
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [slug, grant.waitingToken, status, refresh]);
  return (
    <div className="standalone-card waiting-guest">
      <div className="empty-icon">
        {status === "waiting" ? <Clock3 size={29} /> : <DoorOpen size={29} />}
      </div>
      <h1>
        {status === "waiting"
          ? "Ждем разрешения организатора"
          : status === "denied"
            ? "Организатор отклонил запрос"
            : "Время ожидания истекло"}
      </h1>
      <p>
        {status === "waiting"
          ? `${grant.name || "Вы"} в зале ожидания. После разрешения вы подключитесь автоматически.`
          : status === "denied"
            ? "Свяжитесь с организатором, если считаете, что произошла ошибка."
            : "Вернитесь к проверке устройств и отправьте новый запрос."}
      </p>
      {status === "waiting" && (
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
      {error && status === "waiting" && (
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
          setCancelling(true);
          setError("");
          try {
            await api(
              `/rooms/${encodeURIComponent(slug)}/waiting`,
              { waitingToken: grant.waitingToken },
              "DELETE",
              { sessionErrors: false },
            );
            saveWaitingGrant(slug);
            onCancel();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setCancelling(false);
          }
        }}
      >
        {status === "waiting" ? "Отменить запрос" : "К проверке устройств"}
      </Button>
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
