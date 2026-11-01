import { useCallback, useEffect, useState } from "react";
import {
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  DoorOpen,
  Film,
  ShieldCheck,
  Square,
  Video,
} from "lucide-react";
import { LiveKitRoom, PreJoin } from "@livekit/components-react";
import type { LocalUserChoices } from "@livekit/components-react";
import { api, date } from "../api";
import type { Config, Recording, Room, User } from "../api";
import { Brand, Button, Empty, ErrorBox, Link, Spinner, go } from "../ui";
import { CallSurface } from "./CallSurface";
type PublicRoom = {
  room: Pick<
    Room,
    | "title"
    | "description"
    | "startsAt"
    | "durationMinutes"
    | "allowGuests"
    | "maxParticipants"
    | "status"
  >;
  canManage: boolean;
  workspaceId?: string;
  roomId?: string;
};
type JoinGrant = {
  token: string;
  serverUrl: string;
  roomName: string;
  canManage: boolean;
  roomId?: string;
  workspaceId?: string;
};
export function Join({
  slug,
  config,
  user,
  notify,
}: {
  slug: string;
  config: Config;
  user?: User;
  notify: (s: string, e?: boolean) => void;
}) {
  const [info, setInfo] = useState<PublicRoom>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [grant, setGrant] = useState<JoinGrant>();
  const [choices, setChoices] = useState<LocalUserChoices>();
  const [left, setLeft] = useState(false);
  const [recording, setRecording] = useState<Recording>();
  const [recordingStatus, setRecordingStatus] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [actionBusy, setActionBusy] = useState(false);
  const load = useCallback(
    () =>
      api<PublicRoom>(`/rooms/${encodeURIComponent(slug)}`)
        .then(setInfo)
        .catch((e) => setError(e.message)),
    [slug],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (
      !grant?.canManage ||
      !grant.workspaceId ||
      !grant.roomId ||
      !config.recordingConfigured ||
      left
    ) {
      setRecording(undefined);
      setRecordingStatus("loading");
      return;
    }
    if (actionBusy) return;
    let cancelled = false;
    let inFlight = false;
    const workspaceId = grant.workspaceId;
    const roomId = grant.roomId;
    setRecordingStatus("loading");
    async function syncRecording() {
      if (inFlight) return;
      inFlight = true;
      try {
        const { recordings } = await api<{ recordings: Recording[] }>(
          `/workspaces/${workspaceId}/recordings`,
        );
        if (cancelled) return;
        const roomRecordings = recordings
          .filter((item) => item.roomId === roomId)
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
        const pending = roomRecordings.find((item) =>
          ["starting", "active", "ending"].includes(item.status),
        );
        const latest = roomRecordings[0];
        setRecording(
          pending ?? (latest?.status === "failed" ? latest : undefined),
        );
        setRecordingStatus("ready");
      } catch {
        if (!cancelled) setRecordingStatus("error");
      } finally {
        inFlight = false;
      }
    }
    void syncRecording();
    const timer = setInterval(() => void syncRecording(), 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    grant?.canManage,
    grant?.workspaceId,
    grant?.roomId,
    config.recordingConfigured,
    left,
    actionBusy,
  ]);
  async function enter(values: LocalUserChoices) {
    if (!values.username.trim()) {
      setError("Укажите ваше имя перед входом.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const next = await api<JoinGrant>(
        `/rooms/${encodeURIComponent(slug)}/join`,
        { name: values.username.trim() },
      );
      setChoices(values);
      setGrant(next);
      setLeft(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (grant && !left)
    return (
      <div className="call-page">
        <header className="call-header">
          <Brand light />
          <div>
            <span className="call-room-title">{info?.room.title}</span>
            <span className="call-security">
              <ShieldCheck size={13} />
              Приватная встреча
            </span>
          </div>
          <div className="call-owner-actions">
            {grant.canManage && config.recordingConfigured && (
              <Button
                className={
                  recording && recording.status !== "failed"
                    ? "recording-active"
                    : ""
                }
                busy={actionBusy}
                disabled={
                  recordingStatus !== "ready" ||
                  recording?.status === "starting" ||
                  recording?.status === "ending"
                }
                title={
                  recordingStatus === "error"
                    ? "Не удалось проверить состояние записи. Повторяем запрос."
                    : recording?.status === "failed"
                      ? (recording.error ??
                        "Предыдущая запись завершилась с ошибкой")
                      : undefined
                }
                onClick={async () => {
                  setActionBusy(true);
                  try {
                    if (recording?.status === "active") {
                      const result = await api<{ recording: Recording }>(
                        `/workspaces/${grant.workspaceId}/recordings/${recording.id}/stop`,
                        {},
                      );
                      setRecording(result.recording);
                      notify("Запись обрабатывается");
                    } else {
                      const result = await api<{ recording: Recording }>(
                        `/workspaces/${grant.workspaceId}/rooms/${grant.roomId}/recordings`,
                        {},
                      );
                      setRecording(result.recording);
                      notify("Запись запускается");
                    }
                  } catch (e) {
                    notify((e as Error).message, true);
                  } finally {
                    setActionBusy(false);
                  }
                }}
              >
                {recording?.status === "active" ? (
                  <Square size={15} />
                ) : (
                  <Film size={16} />
                )}{" "}
                {recordingStatus === "loading"
                  ? "Проверяем запись..."
                  : recordingStatus === "error"
                    ? "Статус записи недоступен"
                    : recording?.status === "starting"
                      ? "Запись запускается..."
                      : recording?.status === "ending"
                        ? "Запись обрабатывается..."
                        : recording?.status === "active"
                          ? "Остановить запись"
                          : recording?.status === "failed"
                            ? "Повторить запись"
                            : "Записать"}
              </Button>
            )}
            {grant.canManage && (
              <Button
                className="close-room-button"
                busy={actionBusy}
                onClick={async () => {
                  if (!confirm("Завершить встречу для всех участников?"))
                    return;
                  setActionBusy(true);
                  try {
                    await api(
                      `/workspaces/${grant.workspaceId}/rooms/${grant.roomId}/close`,
                      {},
                    );
                    setLeft(true);
                    setGrant(undefined);
                  } catch (e) {
                    notify((e as Error).message, true);
                  } finally {
                    setActionBusy(false);
                  }
                }}
              >
                Завершить для всех
              </Button>
            )}
          </div>
        </header>
        <LiveKitRoom
          token={grant.token}
          serverUrl={grant.serverUrl}
          connect={true}
          video={
            choices?.videoEnabled ? { deviceId: choices.videoDeviceId } : false
          }
          audio={
            choices?.audioEnabled ? { deviceId: choices.audioDeviceId } : false
          }
          onDisconnected={() => {
            setLeft(true);
            setGrant(undefined);
          }}
          onError={(e) => notify(`Ошибка связи: ${e.message}`, true)}
          data-lk-theme="default"
          className="live-room"
        >
          <CallSurface notify={notify} />
        </LiveKitRoom>
      </div>
    );
  return (
    <div className="join-page">
      <header>
        <Link to="/">
          <Brand />
        </Link>
        <span className="subtle">
          <ShieldCheck size={15} />
          Ваше пространство для встреч
        </span>
      </header>
      <main className="join-main">
        {!info && !error ? (
          <div className="full-loader">
            <Spinner />
          </div>
        ) : left ? (
          <div className="standalone-card">
            <div className="empty-icon">
              <CheckCircle2 size={29} />
            </div>
            <h1>До следующей встречи.</h1>
            <p>Вы вышли из комнаты. Спасибо за разговор.</p>
            <Button
              className="primary full"
              onClick={() => {
                setLeft(false);
                void load();
              }}
            >
              Вернуться во встречу
              <ArrowRight size={17} />
            </Button>
            <Link className="back-link" to="/">
              На главную
            </Link>
          </div>
        ) : (
          <>
            <div className="join-intro">
              <span className="eyebrow">ГОТОВЫ К РАЗГОВОРУ?</span>
              <h1>{info?.room.title ?? "Войти во встречу"}</h1>
              {info?.room.description && <p>{info.room.description}</p>}
              <div className="join-meta">
                {info?.room.startsAt && (
                  <span>
                    <CalendarDays size={15} />
                    {date(info.room.startsAt)}
                  </span>
                )}
                <span>
                  <ShieldCheck size={15} />
                  Проверьте устройства перед входом
                </span>
              </div>
            </div>
            <ErrorBox error={error} />
            {info?.room.status === "closed" ? (
              <div className="standalone-card">
                <Empty
                  icon={DoorOpen}
                  title="Эта встреча завершена"
                  text="Организатор закрыл комнату. Попросите у него ссылку на новую встречу."
                  action={
                    <Link to="/" className="button">
                      На главную
                    </Link>
                  }
                />
              </div>
            ) : info && !config.mediaConfigured ? (
              <div className="standalone-card">
                <Empty
                  icon={Video}
                  title="Видеосвязь пока недоступна"
                  text="Администратор еще подключает сервер видеосвязи. Комната сохранена, попробуйте войти позднее."
                  action={
                    <Link to="/" className="button">
                      На главную
                    </Link>
                  }
                />
              </div>
            ) : info ? (
              <div
                className={`prejoin-wrap ${busy ? "is-busy" : ""}`}
                data-lk-theme="default"
              >
                <label className="sr-only" htmlFor="username">
                  Ваше имя
                </label>
                <PreJoin
                  defaults={{
                    username:
                      user?.name ??
                      localStorage.getItem("imon.displayName") ??
                      "",
                    audioEnabled: true,
                    videoEnabled: true,
                  }}
                  onSubmit={(values) => {
                    localStorage.setItem("imon.displayName", values.username);
                    void enter(values);
                  }}
                  onError={(e) =>
                    setError(`Проверьте доступ к устройствам: ${e.message}`)
                  }
                  userLabel="Ваше имя"
                  joinLabel={
                    busy ? "Подключаемся..." : "Присоединиться к встрече"
                  }
                  micLabel="Микрофон"
                  camLabel="Камера"
                  persistUserChoices={false}
                />
                {busy && (
                  <div className="joining-overlay">
                    <Spinner />
                    <span>Подключаемся к встрече</span>
                  </div>
                )}
                <p className="prejoin-note">
                  <ShieldCheck size={14} />
                  Имя будет видно другим участникам встречи.
                </p>
              </div>
            ) : null}
            {!user && info && (
              <p className="join-account-link">
                Уже есть аккаунт?{" "}
                <button
                  onClick={() => {
                    sessionStorage.setItem("imon.returnTo", location.pathname);
                    go("/login");
                  }}
                >
                  Войти в пространство
                </button>
              </p>
            )}
          </>
        )}
      </main>
      <footer>IMON Meets · Хорошая работа начинается с разговора.</footer>
    </div>
  );
}
