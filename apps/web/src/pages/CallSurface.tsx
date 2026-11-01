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
import { api } from "../api";

type ManagedParticipant = {
  identity: string;
  name: string;
  isGuest: boolean;
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
  notify,
  management,
}: {
  notify: (s: string, e?: boolean) => void;
  management?: { workspaceId: string; roomId: string };
}) {
  const [chatOpen, setChatOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const [managedParticipants, setManagedParticipants] =
    useState<ManagedParticipant[]>();
  const [participantError, setParticipantError] = useState("");
  const [moderating, setModerating] = useState("");
  const [participantRefresh, setParticipantRefresh] = useState(0);
  const [message, setMessage] = useState("");
  const [canScreenShare, setCanScreenShare] = useState(false);
  const { chatMessages, send, isSending } = useChat();
  const participants = useParticipants();
  const isRecording = useIsRecording();
  const connection = useConnectionState();
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!participantsOpen || !management) return;
    const controller = new AbortController();
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const data = await api<{ participants: ManagedParticipant[] }>(
          `/workspaces/${management.workspaceId}/rooms/${management.roomId}/participants`,
          undefined,
          undefined,
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) {
          setManagedParticipants(data.participants);
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
    if (chatOpen)
      bottomRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
  }, [chatMessages, chatOpen]);
  const error = (e: Error) =>
    notify(`Не удалось включить устройство: ${e.message}`, true);
  return (
    <div className="conference-shell">
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
              Сообщения доступны участникам во время встречи. История не
              сохраняется.
            </p>
            <div
              className="chat-messages"
              role="log"
              aria-label="Сообщения встречи"
              aria-live="polite"
            >
              {chatMessages.length ? (
                chatMessages.map((entry, index) => (
                  <div
                    className="chat-message"
                    key={`${entry.timestamp}-${index}`}
                  >
                    <div>
                      <strong>{entry.from?.name || "Участник"}</strong>
                      <time>
                        {new Intl.DateTimeFormat("ru", {
                          hour: "2-digit",
                          minute: "2-digit",
                        }).format(new Date(entry.timestamp))}
                      </time>
                    </div>
                    <p>{entry.message}</p>
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
                if (!message.trim() || isSending) return;
                try {
                  await send(message.trim());
                  setMessage("");
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
                disabled={isSending || !message.trim()}
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
                  </div>
                ))}
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
            {chatMessages.length > 0 && <small>{chatMessages.length}</small>}
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
