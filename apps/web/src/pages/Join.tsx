import { useCallback, useEffect, useRef, useState } from "react";
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
import { DisconnectReason } from "livekit-client";
import {
  api,
  date,
  rememberReturnTo,
  readLocalPreference,
  writeLocalPreference,
} from "../api";
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
type JoinProps = {
  slug: string;
  config: Config;
  user?: User;
  notify: (s: string, e?: boolean) => void;
};
export function Join(props: JoinProps) {
  return (
    <MeetingJoin
      key={`${props.slug}:${props.user?.id ?? "guest"}`}
      {...props}
    />
  );
}
function MeetingJoin({ slug, config, user, notify }: JoinProps) {
  const [info, setInfo] = useState<PublicRoom>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [grant, setGrant] = useState<JoinGrant>();
  const [choices, setChoices] = useState<LocalUserChoices>();
  const [left, setLeft] = useState(false);
  const [exitReason, setExitReason] = useState<DisconnectReason>();
  const [checkingReturn, setCheckingReturn] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [recording, setRecording] = useState<Recording>();
  const [recordingStatus, setRecordingStatus] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [actionBusy, setActionBusy] = useState(false);
  const load = useCallback(
    () =>
      api<PublicRoom>(`/rooms/${encodeURIComponent(slug)}`)
        .then((value) => {
          if (mounted.current) {
            setInfo(value);
            setError("");
          }
        })
        .catch((e) => setError(e.message)),
    [slug],
  );
  useEffect(() => {
    let cancelled = false;
    api<PublicRoom>(`/rooms/${encodeURIComponent(slug)}`)
      .then((value) => {
        if (!cancelled) {
          setInfo(value);
          setError("");
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);
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
      if (!mounted.current) return;
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
          <div className="call-meeting-identity">
            <span className="call-room-title">{info?.room.title}</span>
            <span className="call-security">
              <ShieldCheck size={13} />
              Встреча IMON Meets
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
                    setExitReason(DisconnectReason.ROOM_DELETED);
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
          onDisconnected={(reason) => {
            setLeft(true);
            setExitReason((current) =>
              current === DisconnectReason.ROOM_DELETED ? current : reason,
            );
            setGrant(undefined);
          }}
          onError={(e) => notify(`Ошибка связи: ${e.message}`, true)}
          data-lk-theme="default"
          className="live-room"
        >
          <CallSurface
            notify={notify}
            management={
              grant.canManage && grant.workspaceId && grant.roomId
                ? { workspaceId: grant.workspaceId, roomId: grant.roomId }
                : undefined
            }
          />
        </LiveKitRoom>
      </div>
    );
  return (
    <div className="join-page">
      <header>
        <Link to="/">
          <Brand />
        </Link>
        <span className="join-header-label">Вход во встречу</span>
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
            <h1>
              {exitReason === DisconnectReason.ROOM_DELETED
                ? "Встреча завершена"
                : exitReason === DisconnectReason.PARTICIPANT_REMOVED
                  ? "Вы отключены от встречи"
                  : "Вы вышли из встречи"}
            </h1>
            <p>
              {exitReason === DisconnectReason.ROOM_DELETED
                ? "Организатор завершил встречу или обновил доступ к комнате. Для продолжения попросите актуальную ссылку."
                : exitReason === DisconnectReason.PARTICIPANT_REMOVED
                  ? "Организатор удалил вас из комнаты."
                  : exitReason !== undefined &&
                      exitReason !== DisconnectReason.CLIENT_INITIATED
                    ? "Соединение прервано. Проверьте сеть и попробуйте подключиться снова."
                    : "Камера и микрофон отключены."}
            </p>
            <ErrorBox error={error} />
            {exitReason !== DisconnectReason.ROOM_DELETED &&
              exitReason !== DisconnectReason.PARTICIPANT_REMOVED && (
                <Button
                  className="primary full"
                  busy={checkingReturn}
                  onClick={async () => {
                    setCheckingReturn(true);
                    setError("");
                    try {
                      const current = await api<PublicRoom>(
                        `/rooms/${encodeURIComponent(slug)}`,
                      );
                      if (!mounted.current) return;
                      setInfo(current);
                      if (current.room.status === "closed")
                        setExitReason(DisconnectReason.ROOM_DELETED);
                      else setLeft(false);
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setCheckingReturn(false);
                    }
                  }}
                >
                  Вернуться во встречу
                  <ArrowRight size={17} />
                </Button>
              )}
            <Link className="back-link" to="/">
              На главную
            </Link>
          </div>
        ) : (
          <>
            <div className="join-intro">
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
            {!info && error && (
              <div className="standalone-card">
                <p>
                  Проверьте ссылку. Для приватной встречи войдите в аккаунт
                  участника пространства.
                </p>
                <Button
                  onClick={() => {
                    setError("");
                    void load();
                  }}
                >
                  Повторить проверку
                </Button>
                <Button
                  className="primary"
                  busy={busy}
                  onClick={async () => {
                    setBusy(true);
                    rememberReturnTo(location.pathname + location.search);
                    try {
                      if (user) await api("/auth/sign-out", {});
                      go("/login");
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {user ? "Войти с другой почтой" : "Войти в аккаунт"}
                </Button>
              </div>
            )}
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
                      readLocalPreference("imon.displayName") ??
                      "",
                    audioEnabled: true,
                    videoEnabled: true,
                  }}
                  onSubmit={(values) => {
                    writeLocalPreference("imon.displayName", values.username);
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
                    rememberReturnTo(location.pathname + location.search);
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
      <footer>IMON Meets</footer>
    </div>
  );
}
