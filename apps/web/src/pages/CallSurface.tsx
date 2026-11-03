import { useEffect, useRef, useState } from "react";
import {
  DisconnectButton,
  StartAudio,
  TrackToggle,
  VideoConference,
  useChat,
  useConnectionState,
  useMediaDeviceSelect,
  useParticipants,
  useIsRecording,
} from "@livekit/components-react";
import { ConnectionState, Track } from "livekit-client";
import {
  DoorOpen,
  MessageSquare,
  Mic,
  MonitorUp,
  Send,
  Settings,
  Users,
  Video,
  X,
} from "lucide-react";
import { Button, ErrorBox, Field, Spinner } from "../ui";
import { api, date } from "../api";
import type { WaitingRequest } from "../api";
import { WaitingList } from "./WaitingRoom";
import { useRoomChat } from "./useRoomChat";
import type { MeetingEmbedState } from "../../../../packages/sdk/embed-protocol.js";

type ManagedParticipant = {
  identity: string;
  name: string;
  isGuest: boolean;
  canRemove?: boolean;
  microphoneMuted: boolean;
  cameraEnabled: boolean;
  screenSharing: boolean;
};

function DeviceSelect({
  kind,
  label,
  notify,
}: {
  kind: MediaDeviceKind;
  label: string;
  notify: (s: string, e?: boolean) => void;
}) {
  const { devices, activeDeviceId, setActiveMediaDevice } =
    useMediaDeviceSelect({
      kind,
      requestPermissions: false,
      onError: (e) => notify(`Нет доступа к устройству: ${e.message}`, true),
    });
  return (
    <Field label={label}>
      <select
        value={activeDeviceId}
        onChange={(e) =>
          void setActiveMediaDevice(e.target.value).catch((error) =>
            notify(`Не удалось выбрать устройство: ${error.message}`, true),
          )
        }
      >
        {devices.length ? (
          devices.map((device, index) => (
            <option key={device.deviceId || index} value={device.deviceId}>
              {device.label || `${label} ${index + 1}`}
            </option>
          ))
        ) : (
          <option value="">Устройства не найдены</option>
        )}
      </select>
    </Field>
  );
}

/** LiveKit's conference layout and audio rendering with local controls and Russian chat. */
export function CallSurface({
  slug,
  chatToken,
  notify,
  management,
  request = api,
  onConnectionStateChange,
}: {
  slug: string;
  chatToken?: string;
  notify: (s: string, e?: boolean) => void;
  management?: { workspaceId: string; roomId: string };
  request?: typeof api;
  onConnectionStateChange?: (state: MeetingEmbedState) => void;
}) {
  const [chatOpen, setChatOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const [managedParticipants, setManagedParticipants] =
    useState<ManagedParticipant[]>();
  const [blockedParticipants, setBlockedParticipants] = useState<
    { id: string; name: string }[]
  >([]);
  const [participantError, setParticipantError] = useState("");
  const [moderating, setModerating] = useState("");
  const [participantRefresh, setParticipantRefresh] = useState(0);
  const [waitingRequests, setWaitingRequests] = useState<WaitingRequest[]>();
  const [waitingError, setWaitingError] = useState("");
  const [message, setMessage] = useState("");
  const [canScreenShare, setCanScreenShare] = useState(false);
  const { chatMessages, send, isSending } = useChat();
  const persistentChat = useRoomChat(slug, chatToken, request, chatOpen);
  const shownMessages = chatToken
    ? persistentChat.messages.map((entry) => ({
        id: entry.id,
        name: entry.name,
        text: entry.text,
        timestamp: new Date(entry.createdAt).getTime(),
      }))
    : chatMessages.map((entry, index) => ({
        id: `${entry.timestamp}-${index}`,
        name: entry.from?.name || "Участник",
        text: entry.message,
        timestamp: entry.timestamp,
      }));
  const sending = chatToken ? persistentChat.sending : isSending;
  const participants = useParticipants();
  const isRecording = useIsRecording();
  const connection = useConnectionState();
  useEffect(() => {
    if (connection === ConnectionState.Connected)
      onConnectionStateChange?.("joined");
    else if (connection === ConnectionState.Reconnecting)
      onConnectionStateChange?.("reconnecting");
    else if (connection === ConnectionState.Connecting)
      onConnectionStateChange?.("connecting");
  }, [connection, onConnectionStateChange]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const followMessages = useRef(true);
  useEffect(() => {
    if (!management) return;
    const controller = new AbortController();
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const data = await api<{ requests: WaitingRequest[] }>(
          `/workspaces/${management.workspaceId}/rooms/${management.roomId}/waiting`,
          undefined,
          undefined,
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) {
          setWaitingRequests(
            data.requests.filter((request) => request.status === "waiting"),
          );
          setWaitingError("");
        }
      } catch (e) {
        if (!controller.signal.aborted) setWaitingError((e as Error).message);
      } finally {
        inFlight = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [management?.workspaceId, management?.roomId, participantRefresh]);
  useEffect(() => {
    if (!participantsOpen || !management) return;
    const controller = new AbortController();
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const data = await api<{
          participants: ManagedParticipant[];
          blocked?: { id: string; name: string }[];
        }>(
          `/workspaces/${management.workspaceId}/rooms/${management.roomId}/participants`,
          undefined,
          undefined,
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) {
          setManagedParticipants(data.participants);
          setBlockedParticipants(data.blocked ?? []);
          setParticipantError("");
        }
      } catch (e) {
        if (!controller.signal.aborted)
          setParticipantError((e as Error).message);
      } finally {
        inFlight = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [
    participantsOpen,
    management?.workspaceId,
    management?.roomId,
    participantRefresh,
  ]);
  useEffect(() => {
    setCanScreenShare(
      typeof navigator.mediaDevices?.getDisplayMedia === "function",
    );
  }, []);
  useEffect(() => {
    if (chatOpen) followMessages.current = true;
  }, [chatOpen]);
  useEffect(() => {
    if (chatOpen && followMessages.current)
      bottomRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
  }, [shownMessages.at(-1)?.id, chatOpen]);
  const error = (e: Error) =>
    notify(`Не удалось включить устройство: ${e.message}`, true);
  return (
    <div className="conference-shell">
      {!!waitingRequests?.length && !participantsOpen && (
        <div className="call-waiting-notice" role="status">
          <Users size={17} />
          <span>Ожидают входа: {waitingRequests.length}</span>
          <button
            onClick={() => {
              setParticipantsOpen(true);
              setChatOpen(false);
              setSettingsOpen(false);
            }}
          >
            Открыть зал ожидания
          </button>
        </div>
      )}
      {isRecording && (
        <div className="call-recording-notice" role="status">
          <span aria-hidden="true">●</span> Идет запись встречи. Ваши звук,
          видео и демонстрация экрана могут быть сохранены.
        </div>
      )}
      <div className="conference-body">
        <div className="conference-video">
          <VideoConference />
          {connection !== ConnectionState.Connected && (
            <div className="connection-banner" role="status">
              {connection === ConnectionState.Reconnecting
                ? "Восстанавливаем соединение..."
                : connection === ConnectionState.Connecting
                  ? "Подключаемся к встрече..."
                  : "Соединение прервано"}
            </div>
          )}
          <StartAudio className="allow-audio" label="Включить звук встречи" />
        </div>
        {chatOpen && (
          <aside className="meeting-chat" aria-label="Чат встречи">
            <div className="chat-heading">
              <h2>Чат встречи</h2>
              <button
                className="icon-button"
                aria-label="Закрыть чат"
                onClick={() => setChatOpen(false)}
              >
                <X size={18} />
              </button>
            </div>
            <p className="chat-privacy">
              {chatToken
                ? "Сообщения сохраняются в пространстве и доступны его участникам после встречи."
                : "Сообщения доступны участникам во время встречи. История не сохраняется."}
            </p>
            {chatToken && <ErrorBox error={persistentChat.error} />}
            <div
              className="chat-messages"
              role="log"
              aria-label="Сообщения встречи"
              aria-live="polite"
              onScroll={(event) => {
                const list = event.currentTarget;
                followMessages.current =
                  list.scrollHeight - list.scrollTop - list.clientHeight < 90;
              }}
            >
              {chatToken &&
                (persistentChat.hasEarlier || shownMessages.length >= 500) && (
                  <p className="chat-history-note">
                    Показаны последние сообщения.
                  </p>
                )}
              {chatToken && persistentChat.loading && <Spinner />}
              {shownMessages.length ? (
                shownMessages.map((entry) => (
                  <div className="chat-message" key={entry.id}>
                    <div>
                      <strong>{entry.name}</strong>
                      <time dateTime={new Date(entry.timestamp).toISOString()}>
                        {chatToken
                          ? date(new Date(entry.timestamp).toISOString())
                          : new Intl.DateTimeFormat("ru", {
                              hour: "2-digit",
                              minute: "2-digit",
                            }).format(new Date(entry.timestamp))}
                      </time>
                    </div>
                    <p>{entry.text}</p>
                  </div>
                ))
              ) : (
                <div className="chat-empty">
                  <MessageSquare size={26} />
                  <span>Сообщений пока нет</span>
                </div>
              )}
              <div ref={bottomRef} />
            </div>
            <form
              className="chat-compose"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!message.trim() || sending) return;
                const sentText = message.trim();
                followMessages.current = true;
                try {
                  if (chatToken) await persistentChat.send(sentText);
                  else await send(sentText);
                  setMessage((current) =>
                    current.trim() === sentText ? "" : current,
                  );
                } catch (e) {
                  notify(
                    `Сообщение не отправлено: ${(e as Error).message}`,
                    true,
                  );
                }
              }}
            >
              <input
                aria-label="Сообщение команде"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Написать сообщение..."
                maxLength={4000}
              />
              <button
                aria-label="Отправить сообщение"
                type="submit"
                disabled={sending || !message.trim()}
              >
                <Send size={17} />
              </button>
            </form>
          </aside>
        )}
        {participantsOpen && (
          <aside
            className="meeting-chat meeting-participants"
            aria-label="Участники встречи"
          >
            <div className="chat-heading">
              <h2>Участники ({participants.length})</h2>
              <button
                className="icon-button"
                aria-label="Закрыть список участников"
                onClick={() => setParticipantsOpen(false)}
              >
                <X size={18} />
              </button>
            </div>
            {management ? (
              <>
                <WaitingList
                  requests={waitingRequests}
                  error={waitingError}
                  management={management}
                  onRefresh={() => setParticipantRefresh((value) => value + 1)}
                  notify={notify}
                />
                <p className="chat-privacy">
                  Можно выключить микрофон участника. Включить его снова может
                  только сам участник.
                </p>
                <ErrorBox error={participantError} />
                <Button
                  onClick={() => setParticipantRefresh((value) => value + 1)}
                >
                  Обновить участников
                </Button>
                {!managedParticipants && !participantError && <Spinner />}
                {managedParticipants?.map((participant) => (
                  <div
                    className="call-participant-row"
                    key={participant.identity}
                  >
                    <div>
                      <strong>{participant.name || "Участник"}</strong>
                      <small>
                        {participant.isGuest
                          ? "Гость"
                          : "Участник пространства"}
                        {participant.screenSharing
                          ? " · Демонстрация экрана"
                          : ""}
                      </small>
                    </div>
                    <Button
                      disabled={
                        participant.microphoneMuted ||
                        !!moderating ||
                        !!participantError
                      }
                      busy={moderating === participant.identity}
                      aria-label={`Выключить микрофон: ${participant.name || "Участник"}`}
                      onClick={async () => {
                        setModerating(participant.identity);
                        try {
                          await api(
                            `/workspaces/${management.workspaceId}/rooms/${management.roomId}/participants/${encodeURIComponent(participant.identity)}/microphone`,
                            { muted: true },
                            "PATCH",
                          );
                          setParticipantRefresh((value) => value + 1);
                          notify("Микрофон участника выключен");
                        } catch (e) {
                          notify((e as Error).message, true);
                        } finally {
                          setModerating("");
                        }
                      }}
                    >
                      {participant.microphoneMuted
                        ? "Микрофон выключен"
                        : "Выключить микрофон"}
                    </Button>
                    {participant.canRemove && (
                      <div className="call-participant-actions">
                        {[false, true].map((ban) => (
                          <Button
                            key={String(ban)}
                            disabled={
                              Boolean(moderating) || Boolean(participantError)
                            }
                            className={ban ? "danger-quiet" : ""}
                            aria-label={`${ban ? "Заблокировать" : "Удалить"}: ${participant.name || "Участник"}`}
                            onClick={async () => {
                              const explanation = ban
                                ? "Участник будет отключен. Повторный вход с прежними данными доступа запрещен. Новые гости будут ждать разрешения организатора."
                                : "Участник будет отключен от встречи. Он сможет запросить новый вход по ссылке.";
                              if (!confirm(explanation)) return;
                              setModerating(participant.identity);
                              try {
                                await api(
                                  `/workspaces/${management.workspaceId}/rooms/${management.roomId}/participants/${encodeURIComponent(participant.identity)}/remove`,
                                  { ban },
                                );
                                notify(
                                  ban
                                    ? "Участник заблокирован в этой встрече"
                                    : "Участник удален из встречи",
                                );
                              } catch (e) {
                                notify((e as Error).message, true);
                              } finally {
                                setModerating("");
                                setParticipantRefresh((value) => value + 1);
                              }
                            }}
                          >
                            {ban ? "Заблокировать" : "Удалить"}
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {blockedParticipants.length > 0 && (
                  <section aria-label="Заблокированные участники">
                    <p className="chat-privacy">
                      Заблокированы в этой встрече. После отмены блокировки
                      потребуется новый вход; прежний сеанс останется закрытым.
                    </p>
                    {blockedParticipants.map((blocked) => (
                      <div className="call-participant-row" key={blocked.id}>
                        <strong>{blocked.name}</strong>
                        <Button
                          disabled={Boolean(moderating)}
                          onClick={async () => {
                            setModerating(blocked.id);
                            try {
                              await api(
                                `/workspaces/${management.workspaceId}/rooms/${management.roomId}/blocked/${blocked.id}`,
                                undefined,
                                "DELETE",
                              );
                              notify(
                                "Блокировка отменена. Участник может запросить новый вход.",
                              );
                            } catch (e) {
                              notify((e as Error).message, true);
                            } finally {
                              setModerating("");
                              setParticipantRefresh((value) => value + 1);
                            }
                          }}
                        >
                          Отменить блокировку
                        </Button>
                      </div>
                    ))}
                  </section>
                )}
              </>
            ) : (
              participants.map((participant) => (
                <div
                  className="call-participant-row"
                  key={participant.identity}
                >
                  <div>
                    <strong>
                      {participant.name || "Участник"}
                      {participant.isLocal ? " (вы)" : ""}
                    </strong>
                    <small>
                      {participant.isMicrophoneEnabled
                        ? "Микрофон включен"
                        : "Микрофон выключен"}
                      {participant.isScreenShareEnabled
                        ? " · Демонстрация экрана"
                        : ""}
                    </small>
                  </div>
                </div>
              ))
            )}
          </aside>
        )}
      </div>
      {settingsOpen && (
        <div className="call-device-panel">
          <div className="chat-heading">
            <h2>Устройства встречи</h2>
            <button
              className="icon-button"
              aria-label="Закрыть настройки устройств"
              onClick={() => setSettingsOpen(false)}
            >
              <X size={18} />
            </button>
          </div>
          <DeviceSelect kind="audioinput" label="Микрофон" notify={notify} />
          <DeviceSelect kind="videoinput" label="Камера" notify={notify} />
        </div>
      )}
      <div className="meeting-controls">
        <button
          className="participant-count"
          aria-label="Участники встречи"
          aria-pressed={participantsOpen}
          onClick={() => {
            setParticipantsOpen(!participantsOpen);
            setChatOpen(false);
            setSettingsOpen(false);
          }}
        >
          <Users size={16} />
          <span>Участники ({participants.length})</span>
          {!!waitingRequests?.length && (
            <small className="waiting-count">{waitingRequests.length}</small>
          )}
        </button>
        <div className="meeting-main-controls">
          <TrackToggle
            showIcon={false}
            source={Track.Source.Microphone}
            onDeviceError={error}
            aria-label="Включить или выключить микрофон"
            title="Микрофон"
          >
            <Mic size={18} />
            <span>Микрофон</span>
          </TrackToggle>
          <TrackToggle
            showIcon={false}
            source={Track.Source.Camera}
            onDeviceError={error}
            aria-label="Включить или выключить камеру"
            title="Камера"
          >
            <Video size={18} />
            <span>Камера</span>
          </TrackToggle>
          {canScreenShare && (
            <TrackToggle
              className="screen-share-control"
              showIcon={false}
              source={Track.Source.ScreenShare}
              onDeviceError={error}
              aria-label="Начать или остановить демонстрацию экрана"
              title="Демонстрация экрана"
            >
              <MonitorUp size={18} />
              <span>Демонстрация экрана</span>
            </TrackToggle>
          )}
          <Button
            className={chatOpen ? "control-selected" : ""}
            aria-label="Чат встречи"
            aria-pressed={chatOpen}
            onClick={() => {
              setChatOpen(!chatOpen);
              setParticipantsOpen(false);
            }}
          >
            <MessageSquare size={18} />
            <span>Чат</span>
            {shownMessages.length > 0 && <small>{shownMessages.length}</small>}
          </Button>
          <Button
            className={settingsOpen ? "control-selected" : ""}
            onClick={() => setSettingsOpen(!settingsOpen)}
            aria-label="Настройки устройств"
            aria-pressed={settingsOpen}
          >
            <Settings size={18} />
            <span>Настройки</span>
          </Button>
        </div>
        <DisconnectButton className="leave-meeting" aria-label="Выйти">
          <DoorOpen size={18} />
          <span>Выйти</span>
        </DisconnectButton>
      </div>
    </div>
  );
}
