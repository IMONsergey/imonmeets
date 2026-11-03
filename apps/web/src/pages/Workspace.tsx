import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Clock3,
  Copy,
  CreditCard,
  Database,
  Film,
  FileText,
  Mail,
  Mic,
  Plus,
  Settings,
  ShieldCheck,
  Square,
  Trash2,
  Users,
  Video,
} from "lucide-react";
import { api, date, initials, rememberReturnTo, takeReturnTo } from "../api";
import type { Invitation, Member, Recording, User, Workspace } from "../api";
import {
  Brand,
  Button,
  Empty,
  ErrorBox,
  Field,
  Link,
  Modal,
  Spinner,
  go,
  roleLabel,
} from "../ui";
import type { PageProps, Session } from "../ui";
import { PageHeading } from "./Meetings";
import { DataSettings, WorkspaceOwnership } from "./DataSettings";
import { AuthenticatorSettings } from "./AuthenticatorSettings";
import { PasswordGate } from "./PasswordGate";
import { Transcript } from "./Transcript";
import { PlanSettings } from "./Billing";
const recordingLabels: Record<Recording["status"], string> = {
  starting: "Запускается",
  active: "Идет запись",
  ending: "Обрабатывается",
  complete: "Готова",
  failed: "Ошибка",
};
export function Recordings({ workspace, config, notify }: PageProps) {
  const [recordings, setRecordings] = useState<Recording[]>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [deleting, setDeleting] = useState<Recording>();
  const [transcript, setTranscript] = useState<Recording>();
  const [deleteError, setDeleteError] = useState("");
  const [downloadReady, setDownloadReady] = useState<{
    id: string;
    url: string;
  }>();
  const load = useCallback(
    () =>
      api<{ recordings: Recording[] }>(`/workspaces/${workspace.id}/recordings`)
        .then((r) => {
          setRecordings(r.recordings);
          setError("");
        })
        .catch((e) => setError(e.message)),
    [workspace.id],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (
      recordings?.some(
        (r) =>
          ["starting", "active", "ending"].includes(r.status) ||
          r.deletionPending,
      )
    ) {
      const timer = setInterval(() => void load(), 10000);
      return () => clearInterval(timer);
    }
  }, [recordings, load]);
  return (
    <div className="workspace-page">
      <PageHeading
        eyebrow=""
        title="Записи встреч"
        text="Облачные записи встреч вашего пространства."
      >
        <Button onClick={() => void load()}>Обновить</Button>
      </PageHeading>
      <ErrorBox error={error} />
      {!config.recordingConfigured && (
        <div className="workspace-notice">
          <Film size={19} />
          <span>
            <strong>Запись встреч пока не подключена.</strong> Администратору
            сервера нужно настроить сервис записи и защищенное хранилище.
          </span>
        </div>
      )}
      <div className="panel workspace-panel">
        <div className="workspace-section-heading">
          <h2>
            Все записи
            {recordings && (
              <span className="workspace-count">{recordings.length}</span>
            )}
          </h2>
          <span className="workspace-muted">
            <ShieldCheck size={14} />
            Доступны вашей команде
          </span>
        </div>
        {!recordings && !error ? (
          <div className="workspace-loading">
            <Spinner />
          </div>
        ) : recordings?.length ? (
          <div className="workspace-recording-list">
            <div
              className="workspace-table-head workspace-recording-head"
              aria-hidden="true"
            >
              <span>Название встречи</span>
              <span>Статус</span>
              <span>Действия</span>
            </div>
            {recordings.map((r) => (
              <div className="workspace-recording-row" key={r.id}>
                <div className="workspace-recording-icon">
                  <Film size={22} />
                </div>
                <div className="workspace-recording-details">
                  <h3>{r.roomTitle}</h3>
                  <p>
                    {date(r.startedAt)}
                    {r.sizeBytes !== null && (
                      <> · {(r.sizeBytes / 1024 / 1024).toFixed(1)} МБ</>
                    )}
                  </p>
                  {r.expiresAt && (
                    <small className="recording-retention">
                      Хранится до {date(r.expiresAt)}
                    </small>
                  )}
                  {r.error && <small className="danger-text">{r.error}</small>}
                </div>
                <span
                  className={`workspace-status ${r.status === "complete" ? "success" : r.status === "failed" ? "error" : r.status === "active" ? "info" : "neutral"}`}
                >
                  {r.status === "active" && <span className="status-dot" />}
                  {r.deletionPending ? "Удаляется" : recordingLabels[r.status]}
                </span>
                <div className="workspace-row-actions">
                  {r.status === "complete" &&
                    !r.deletionPending &&
                    (config.transcriptionConfigured || r.hasTranscript) && (
                      <Button onClick={() => setTranscript(r)}>
                        <FileText size={17} />
                        Расшифровка
                      </Button>
                    )}
                  {r.status === "complete" &&
                    !r.deletionPending &&
                    config.recordingConfigured && (
                      <Button
                        busy={busy === r.id}
                        onClick={async () => {
                          const downloadWindow = window.open(
                            "about:blank",
                            "_blank",
                          );
                          if (downloadWindow) downloadWindow.opener = null;
                          setBusy(r.id);
                          try {
                            const data = await api<{ url: string }>(
                              `/workspaces/${workspace.id}/recordings/${r.id}/download`,
                            );
                            const url = new URL(data.url);
                            if (
                              url.protocol !== "https:" &&
                              !(
                                location.protocol === "http:" &&
                                url.protocol === "http:"
                              )
                            )
                              throw new Error(
                                "Получена некорректная ссылка на запись.",
                              );
                            if (downloadWindow)
                              downloadWindow.location.replace(url.toString());
                            else
                              setDownloadReady({
                                id: r.id,
                                url: url.toString(),
                              });
                          } catch (e) {
                            downloadWindow?.close();
                            notify((e as Error).message, true);
                          } finally {
                            setBusy("");
                          }
                        }}
                      >
                        <ArrowDownToLine size={17} />
                        Скачать
                      </Button>
                    )}
                  {downloadReady?.id === r.id && !r.deletionPending && (
                    <a
                      className="button"
                      href={downloadReady.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Открыть файл
                    </a>
                  )}
                  {config.recordingConfigured &&
                    r.canManage &&
                    r.status === "active" && (
                      <Button
                        busy={busy === r.id}
                        onClick={async () => {
                          setBusy(r.id);
                          try {
                            await api(
                              `/workspaces/${workspace.id}/recordings/${r.id}/stop`,
                              {},
                            );
                            await load();
                            notify("Запись остановлена");
                          } catch (e) {
                            notify((e as Error).message, true);
                          } finally {
                            setBusy("");
                          }
                        }}
                      >
                        <Square size={15} />
                        Остановить
                      </Button>
                    )}
                  {r.canManage && ["complete", "failed"].includes(r.status) && (
                    <Button
                      className="icon-button danger-quiet"
                      disabled={r.deletionPending || !!busy}
                      aria-label={`Удалить запись: ${r.roomTitle}`}
                      onClick={() => {
                        setDeleting(r);
                        setDeleteError("");
                      }}
                    >
                      <Trash2 size={17} />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <Empty
            icon={Film}
            title="Не удалось загрузить записи"
            text="Повторите запрос."
            action={<Button onClick={() => void load()}>Повторить</Button>}
          />
        ) : (
          <Empty
            icon={Film}
            title="Записей пока нет"
            text={
              config.recordingConfigured
                ? "Начните запись из комнаты встречи. Готовое видео появится здесь."
                : "Записи появятся здесь после подключения сервиса записи."
            }
          />
        )}
      </div>
      {deleting && (
        <Modal
          title="Удалить запись?"
          onClose={() => {
            if (!busy) setDeleting(undefined);
          }}
        >
          <p className="modal-intro">
            Запись встречи «{deleting.roomTitle}» от {date(deleting.startedAt)}{" "}
            будет удалена из хранилища. Скачайте нужную копию перед удалением.
          </p>
          <ErrorBox error={deleteError} focus />
          <div className="modal-actions">
            <Button disabled={!!busy} onClick={() => setDeleting(undefined)}>
              Отмена
            </Button>
            <Button
              className="danger"
              busy={busy === deleting.id}
              onClick={async () => {
                setBusy(deleting.id);
                try {
                  await api(
                    `/workspaces/${workspace.id}/recordings/${deleting.id}`,
                    undefined,
                    "DELETE",
                    { timeoutMs: 30_000 },
                  );
                  setDownloadReady(undefined);
                  setDeleting(undefined);
                  await load();
                  notify("Запись удаляется из хранилища");
                } catch (e) {
                  setDeleteError((e as Error).message);
                } finally {
                  setBusy("");
                }
              }}
            >
              Удалить запись
            </Button>
          </div>
        </Modal>
      )}
      {transcript && (
        <Transcript
          recording={transcript}
          workspace={workspace}
          config={config}
          notify={notify}
          onClose={() => setTranscript(undefined)}
        />
      )}
    </div>
  );
}

export function Team({
  workspace,
  user,
  notify,
}: {
  workspace: Workspace;
  user: User;
  notify: (s: string, e?: boolean) => void;
}) {
  const [data, setData] = useState<{
    members: Member[];
    invitations: Invitation[];
  }>();
  const [error, setError] = useState("");
  const [invite, setInvite] = useState(false);
  const [busy, setBusy] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  const [inviteDelivery, setInviteDelivery] = useState("");
  const load = useCallback(
    () =>
      api<{ members: Member[]; invitations: Invitation[] }>(
        `/workspaces/${workspace.id}/members`,
      )
        .then((value) => {
          setData(value);
          setError("");
        })
        .catch((e) => setError(e.message)),
    [workspace.id],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const manage = workspace.role !== "member";
  return (
    <div className="workspace-page">
      <PageHeading
        eyebrow=""
        title="Управление участниками"
        text={workspace.name}
      >
        <Button onClick={() => void load()}>Обновить</Button>
        {manage && (
          <Button
            className="primary"
            onClick={() => {
              setInvite(true);
              setInviteUrl("");
            }}
          >
            <Plus size={18} />
            Пригласить участника
          </Button>
        )}
      </PageHeading>
      <ErrorBox error={error} />
      <div className="panel workspace-panel">
        <div className="workspace-section-heading">
          <h2>
            Участники{" "}
            {data && (
              <span className="workspace-count">{data.members.length}</span>
            )}
          </h2>
          <span className="workspace-muted">{workspace.name}</span>
        </div>
        {!data && !error ? (
          <div className="workspace-loading">
            <Spinner />
          </div>
        ) : !data && error ? (
          <Empty
            icon={Users}
            title="Не удалось загрузить команду"
            text="Повторите запрос."
            action={<Button onClick={() => void load()}>Повторить</Button>}
          />
        ) : (
          <div className="workspace-member-list">
            <div
              className="workspace-table-head workspace-member-head"
              aria-hidden="true"
            >
              <span>Имя и адрес почты</span>
              <span>Роль</span>
              <span>Действия</span>
            </div>
            {data?.members.map((member) => (
              <div className="workspace-member-row" key={member.id}>
                <div className="workspace-person">
                  <div className="workspace-avatar">
                    {initials(member.name)}
                  </div>
                  <div className="workspace-member-details">
                    <h3>
                      {member.name}
                      {member.userId === user.id && (
                        <span className="workspace-you-label">Это вы</span>
                      )}
                    </h3>
                    <p>{member.email}</p>
                  </div>
                </div>
                <span className="workspace-role">{roleLabel[member.role]}</span>
                <div className="workspace-row-actions">
                  {workspace.role === "owner" && member.role !== "owner" && (
                    <select
                      aria-label={`Роль участника ${member.name}`}
                      value={member.role}
                      disabled={busy === member.id}
                      onChange={async (e) => {
                        const role = e.target.value;
                        if (
                          !confirm(
                            `Изменить роль ${member.name} на «${roleLabel[role as "admin" | "member"]}»?`,
                          )
                        )
                          return;
                        setBusy(member.id);
                        try {
                          await api(
                            `/workspaces/${workspace.id}/members/${member.id}`,
                            { role },
                            "PATCH",
                          );
                          await load();
                          notify("Роль обновлена");
                        } catch (e) {
                          notify((e as Error).message, true);
                        } finally {
                          setBusy("");
                        }
                      }}
                    >
                      <option value="member">Участник</option>
                      <option value="admin">Администратор</option>
                    </select>
                  )}
                  {manage &&
                    member.role !== "owner" &&
                    member.userId !== user.id &&
                    (workspace.role === "owner" ||
                      member.role === "member") && (
                      <Button
                        className="icon-button danger-quiet"
                        busy={busy === member.id}
                        aria-label={`Удалить участника ${member.name}`}
                        onClick={async () => {
                          if (
                            !confirm(
                              `Удалить ${member.name} из пространства? Встречи, для которых ему выдавался доступ, будут прерваны для всех участников. Их гостевые ссылки изменятся. Остальным понадобится войти заново по новой ссылке. Это не запрещает анонимный вход по новой гостевой ссылке.`,
                            )
                          )
                            return;
                          setBusy(member.id);
                          try {
                            const result = await api<{
                              affectedRooms: number;
                              mediaPending?: boolean;
                            }>(
                              `/workspaces/${workspace.id}/members/${member.id}`,
                              undefined,
                              "DELETE",
                            );
                            await load();
                            notify(
                              `Участник удален. Доступ обновлен для встреч: ${result.affectedRooms}.${result.mediaPending ? " Отключение прежних подключений еще выполняется." : ""}`,
                            );
                          } catch (e) {
                            notify((e as Error).message, true);
                          } finally {
                            setBusy("");
                          }
                        }}
                      >
                        <Trash2 size={17} />
                      </Button>
                    )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {manage && data && data.invitations.length > 0 && (
        <div className="panel workspace-panel workspace-invitations-panel">
          <div className="workspace-section-heading">
            <h2>
              Ожидают приглашения{" "}
              <span className="workspace-count">{data.invitations.length}</span>
            </h2>
          </div>
          {data.invitations.map((i) => (
            <div className="workspace-member-row" key={i.id}>
              <div className="workspace-person">
                <div className="workspace-avatar">
                  <Mail size={19} />
                </div>
                <div className="workspace-member-details">
                  <h3>{i.email}</h3>
                  <p>Действует до {date(i.expiresAt, false)}</p>
                </div>
              </div>
              <span className="workspace-role">{roleLabel[i.role]}</span>
              <Button
                className="text-button"
                busy={busy === i.id}
                onClick={async () => {
                  setBusy(i.id);
                  try {
                    await api(
                      `/workspaces/${workspace.id}/invitations/${i.id}`,
                      undefined,
                      "DELETE",
                    );
                    await load();
                    notify("Приглашение отменено");
                  } catch (e) {
                    notify((e as Error).message, true);
                  } finally {
                    setBusy("");
                  }
                }}
              >
                Отменить
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="workspace-permission-note">
        <ShieldCheck size={18} />
        <p>
          Владельцы и администраторы управляют пространством. Участники могут
          создавать встречи и управлять своими комнатами.
        </p>
      </div>
      {invite && (
        <Modal title="Пригласить в команду" onClose={() => setInvite(false)}>
          {inviteUrl ? (
            <>
              <div className="workspace-confirmation">
                <CheckCircle2 size={21} />
                <span>
                  {inviteDelivery === "accepted"
                    ? "Приглашение создано. Письмо принято почтовым сервисом."
                    : "Приглашение создано. Отправка письма не подтверждена — передайте ссылку коллеге."}
                </span>
              </div>
              <Field label="Личная ссылка приглашения">
                <div className="workspace-copy-field">
                  <input value={inviteUrl} readOnly />
                  <Button
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(inviteUrl);
                        notify("Ссылка скопирована");
                      } catch {
                        notify("Выделите ссылку и скопируйте вручную", true);
                      }
                    }}
                    aria-label="Скопировать приглашение"
                  >
                    <Copy size={17} />
                  </Button>
                </div>
              </Field>
              <p className="form-note">
                Войти по ссылке сможет только человек с указанной и
                подтвержденной почтой.
              </p>
              <Button className="primary full" onClick={() => setInvite(false)}>
                Готово
              </Button>
            </>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setError("");
                setBusy("invite");
                try {
                  const f = new FormData(e.currentTarget);
                  const r = await api<{
                    inviteUrl?: string;
                    emailDelivery?: string;
                  }>(`/workspaces/${workspace.id}/invitations`, {
                    email: f.get("email"),
                    role: f.get("role"),
                  });
                  await load();
                  setInviteDelivery(r.emailDelivery ?? "");
                  if (r.inviteUrl) setInviteUrl(r.inviteUrl);
                  else {
                    setInvite(false);
                    notify("Приглашение создано");
                  }
                } catch (e) {
                  notify((e as Error).message, true);
                } finally {
                  setBusy("");
                }
              }}
            >
              <p className="modal-intro">
                Коллега получит доступ к комнатам и встречам этого пространства.
              </p>
              <Field label="Почта коллеги">
                <input
                  type="email"
                  name="email"
                  required
                  placeholder="colleague@company.ru"
                />
              </Field>
              <Field label="Роль в пространстве">
                <select name="role" defaultValue="member">
                  <option value="member">Участник</option>
                  {workspace.role === "owner" && (
                    <option value="admin">Администратор</option>
                  )}
                </select>
              </Field>
              <p className="form-note">
                Приглашение действительно 7 дней. Для принятия нужен
                подтвержденный адрес почты.
              </p>
              <div className="modal-actions">
                <Button type="button" onClick={() => setInvite(false)}>
                  Отмена
                </Button>
                <Button
                  type="submit"
                  className="primary"
                  busy={busy === "invite"}
                >
                  Создать приглашение
                  <ArrowRight size={16} />
                </Button>
              </div>
            </form>
          )}
        </Modal>
      )}
    </div>
  );
}

function MicrophoneCheck() {
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [level, setLevel] = useState(0);
  const resources = useRef<{
    stream?: MediaStream;
    context?: AudioContext;
    frame?: number;
  }>({});
  const request = useRef(0);
  const stop = useCallback(() => {
    request.current++;
    const current = resources.current;
    current.stream?.getTracks().forEach((track) => track.stop());
    if (current.frame !== undefined) cancelAnimationFrame(current.frame);
    void current.context?.close();
    resources.current = {};
  }, []);
  useEffect(() => stop, [stop]);
  return (
    <div className="workspace-microphone-check">
      <h3>Проверка микрофона</h3>
      <p>
        Произнесите несколько слов. Индикатор показывает уровень входящего
        звука; звук не записывается и не отправляется.
      </p>
      <ErrorBox error={error} />
      <meter min={0} max={100} value={level} aria-label="Уровень микрофона" />
      <Button
        busy={busy}
        onClick={async () => {
          if (active) {
            stop();
            setActive(false);
            setLevel(0);
            return;
          }
          setBusy(true);
          setError("");
          const id = ++request.current;
          try {
            const stream = await navigator.mediaDevices.getUserMedia({
              audio: true,
              video: false,
            });
            if (id !== request.current) {
              stream.getTracks().forEach((track) => track.stop());
              return;
            }
            resources.current.stream = stream;
            const context = new AudioContext();
            resources.current.context = context;
            await context.resume();
            if (id !== request.current) return;
            const analyser = context.createAnalyser();
            analyser.fftSize = 256;
            context.createMediaStreamSource(stream).connect(analyser);
            const samples = new Uint8Array(analyser.fftSize);
            const measure = () => {
              if (id !== request.current) return;
              analyser.getByteTimeDomainData(samples);
              const rms = Math.sqrt(
                samples.reduce(
                  (sum, value) => sum + ((value - 128) / 128) ** 2,
                  0,
                ) / samples.length,
              );
              setLevel(Math.min(100, Math.round(rms * 400)));
              resources.current.frame = requestAnimationFrame(measure);
            };
            setActive(true);
            measure();
          } catch {
            if (id === request.current) {
              stop();
              setActive(false);
              setError(
                "Микрофон недоступен. Проверьте подключение и разрешение браузера.",
              );
            }
          } finally {
            if (id === request.current || !resources.current.stream)
              setBusy(false);
          }
        }}
      >
        {active ? <Square size={16} /> : <Mic size={16} />}
        {active ? "Остановить проверку микрофона" : "Проверить микрофон"}
      </Button>
    </div>
  );
}

type AccountSession = {
  id: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  current: boolean;
};
function SessionSettings({
  notify,
}: {
  notify: (s: string, e?: boolean) => void;
}) {
  const [sessions, setSessions] = useState<AccountSession[]>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const load = useCallback(async () => {
    setError("");
    try {
      setSessions(
        (await api<{ sessions: AccountSession[] }>("/sessions")).sessions,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section className="workspace-sessions">
      <div className="workspace-section-heading">
        <h3>Активные сеансы</h3>
        <Button onClick={() => void load()}>Обновить</Button>
      </div>
      <ErrorBox error={error} />
      {!sessions && !error && <Spinner />}
      {sessions?.map((session) => (
        <div className="workspace-session" key={session.id}>
          <div>
            <strong>{session.current ? "Этот браузер" : "Другой сеанс"}</strong>
            <p>{session.userAgent || "Браузер не указан"}</p>
            <small>
              {session.ipAddress || "Адрес не указан"} · Последняя активность:{" "}
              {date(session.updatedAt)}
            </small>
          </div>
          {!session.current && (
            <Button
              busy={busy === session.id}
              onClick={async () => {
                setBusy(session.id);
                try {
                  await api(
                    `/sessions/${encodeURIComponent(session.id)}`,
                    undefined,
                    "DELETE",
                  );
                  await load();
                  notify("Сеанс завершен");
                } catch (e) {
                  notify((e as Error).message, true);
                } finally {
                  setBusy("");
                }
              }}
            >
              Завершить
            </Button>
          )}
        </div>
      ))}
      {sessions?.some((session) => !session.current) && (
        <Button
          busy={busy === "others"}
          onClick={async () => {
            if (!confirm("Завершить все сеансы, кроме текущего браузера?"))
              return;
            setBusy("others");
            try {
              await api("/sessions/revoke-others", {});
              await load();
              notify("Другие сеансы завершены");
            } catch (e) {
              notify((e as Error).message, true);
            } finally {
              setBusy("");
            }
          }}
        >
          Завершить другие сеансы
        </Button>
      )}
    </section>
  );
}

export function AccountSettings({
  user,
  workspace,
  config,
  refresh,
  notify,
}: PageProps & { user: User; refresh: () => Promise<Session> }) {
  const [busy, setBusy] = useState("");
  const readSection = () => {
    const requested =
      new URLSearchParams(location.search).get("section") ?? "profile";
    return [
      "profile",
      "security",
      "workspace",
      "plan",
      "data",
      "devices",
      "services",
    ].includes(requested)
      ? requested
      : "profile";
  };
  const [section, setSection] = useState(readSection);
  const settingsNav = useRef<HTMLElement>(null);
  useEffect(() => {
    const reveal = () => {
      const nav = settingsNav.current;
      const active = nav?.querySelector<HTMLElement>("[aria-current='page']");
      if (!nav || !active || nav.scrollWidth <= nav.clientWidth) return;
      const frame = nav.getBoundingClientRect(),
        selected = active.getBoundingClientRect();
      if (selected.left < frame.left)
        nav.scrollLeft += selected.left - frame.left;
      else if (selected.right > frame.right)
        nav.scrollLeft += selected.right - frame.right;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    if (settingsNav.current) observer.observe(settingsNav.current);
    return () => observer.disconnect();
  }, [section]);
  useEffect(() => {
    const changed = () => setSection(readSection());
    addEventListener("popstate", changed);
    return () => removeEventListener("popstate", changed);
  }, []);
  const settingsSections = [
    { id: "profile", label: "Профиль", icon: Users },
    { id: "security", label: "Безопасность", icon: ShieldCheck },
    { id: "workspace", label: "Пространство", icon: Users },
    { id: "plan", label: "Тариф", icon: CreditCard },
    { id: "data", label: "Мои данные", icon: Database },
    { id: "devices", label: "Видео и звук", icon: Video },
    { id: "services", label: "Сервисы", icon: Settings },
  ];
  const [devices, setDevices] = useState<MediaDeviceInfo[]>();
  const [deviceError, setDeviceError] = useState("");
  const [preview, setPreview] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const previewRequestRef = useRef(0);
  useEffect(
    () => () => {
      previewRequestRef.current++;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );
  useEffect(() => {
    if (section !== "devices") {
      previewRequestRef.current++;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      setPreview(false);
    }
  }, [section]);
  const capability = (
    label: string,
    enabled: boolean,
    description: string,
    status?: string,
  ) => (
    <div className="workspace-capability-row">
      <div>
        <strong>{label}</strong>
        <p>{description}</p>
      </div>
      <span className={`workspace-status ${enabled ? "success" : "neutral"}`}>
        {enabled ? <Check size={13} /> : <Clock3 size={13} />}{" "}
        {status ?? (enabled ? "Доступно в сервисе" : "Пока недоступно")}
      </span>
    </div>
  );
  return (
    <div className="workspace-page">
      <PageHeading
        eyebrow=""
        title="Настройки"
        text="Профиль, безопасность и параметры устройств."
      />
      <div className="workspace-settings">
        <nav
          ref={settingsNav}
          className="workspace-settings-nav"
          aria-label="Разделы настроек"
        >
          {settingsSections.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={section === id ? "selected" : ""}
              aria-current={section === id ? "page" : undefined}
              aria-controls={`settings-${id}`}
              onClick={() => {
                setSection(id);
                const query = new URLSearchParams(location.search);
                query.set("section", id);
                if (id !== "plan") query.delete("payment");
                history.replaceState({}, "", `/settings?${query}`);
              }}
            >
              <Icon size={17} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="workspace-settings-content">
          <section
            className="panel workspace-settings-panel"
            id="settings-profile"
            hidden={section !== "profile"}
          >
            <div className="workspace-section-heading">
              <h2>Личный профиль</h2>
              <Settings size={18} />
            </div>
            <div className="workspace-profile-summary">
              <div className="workspace-avatar workspace-avatar-large">
                {initials(user.name)}
              </div>
              <div>
                <h3>{user.name}</h3>
                <p>{roleLabel[workspace.role]}</p>
              </div>
            </div>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy("profile");
                try {
                  await api("/auth/update-user", {
                    name: new FormData(e.currentTarget).get("name"),
                  });
                  await refresh();
                  notify("Профиль обновлен");
                } catch (e) {
                  notify((e as Error).message, true);
                } finally {
                  setBusy("");
                }
              }}
            >
              <Field label="Ваше имя">
                <input
                  name="name"
                  required
                  maxLength={100}
                  defaultValue={user.name}
                />
              </Field>
              <Field label="Почта">
                <input value={user.email} readOnly />
              </Field>
              <div className="workspace-email-status">
                <span
                  className={`workspace-status ${user.emailVerified ? "success" : "neutral"}`}
                >
                  {user.emailVerified ? (
                    <CheckCircle2 size={13} />
                  ) : (
                    <Mail size={13} />
                  )}{" "}
                  {user.emailVerified
                    ? "Почта подтверждена"
                    : "Нужно подтверждение"}
                </span>
                {!user.emailVerified && (
                  <Link to="/verify-email">Подтвердить</Link>
                )}
              </div>
              <Button
                type="submit"
                className="primary"
                busy={busy === "profile"}
              >
                Сохранить изменения
              </Button>
            </form>
          </section>
          <section
            className="panel workspace-settings-panel"
            id="settings-security"
            hidden={section !== "security"}
          >
            <div className="workspace-section-heading">
              <h2>Безопасность</h2>
              <ShieldCheck size={18} />
            </div>
            {section === "security" && (
              <PasswordGate>
                <p className="workspace-settings-description">
                  Для смены пароля укажите текущий пароль. Другие сеансы будут
                  завершены.
                </p>
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const form = e.currentTarget;
                    const f = new FormData(form);
                    setBusy("password");
                    try {
                      await api("/auth/change-password", {
                        currentPassword: f.get("currentPassword"),
                        newPassword: f.get("newPassword"),
                        revokeOtherSessions: true,
                      });
                      form.reset();
                      notify("Пароль изменен");
                    } catch (e) {
                      notify((e as Error).message, true);
                    } finally {
                      setBusy("");
                    }
                  }}
                >
                  <Field label="Текущий пароль">
                    <input
                      type="password"
                      name="currentPassword"
                      autoComplete="current-password"
                      required
                    />
                  </Field>
                  <Field label="Новый пароль" hint="Не менее 10 символов">
                    <input
                      type="password"
                      name="newPassword"
                      autoComplete="new-password"
                      required
                      minLength={10}
                      maxLength={128}
                    />
                  </Field>
                  <Button
                    type="submit"
                    className="primary"
                    busy={busy === "password"}
                  >
                    Обновить пароль
                  </Button>
                </form>
              </PasswordGate>
            )}
            {section === "security" && (
              <>
                <AuthenticatorSettings
                  user={user}
                  refresh={refresh}
                  notify={notify}
                  googleEnabled={config.googleOAuthConfigured}
                />
                <SessionSettings notify={notify} />
              </>
            )}
          </section>
          <section
            className="panel workspace-settings-panel"
            id="settings-data"
            hidden={section !== "data"}
          >
            {section === "data" && <DataSettings user={user} notify={notify} />}
          </section>
          <section
            className="panel workspace-settings-panel"
            id="settings-plan"
            hidden={section !== "plan"}
          >
            {section === "plan" && <PlanSettings workspace={workspace} />}
          </section>
          <section
            className="panel workspace-settings-panel"
            id="settings-devices"
            hidden={section !== "devices"}
          >
            <div className="workspace-section-heading">
              <h2>Камера и микрофон</h2>
              <Video size={18} />
            </div>
            <p className="workspace-settings-description">
              Проверьте доступ к устройствам. Перед каждой встречей вы сможете
              выбрать камеру и микрофон.
            </p>
            <ErrorBox error={deviceError} />
            <div
              className={`workspace-device-preview ${preview ? "workspace-preview-active" : ""}`}
            >
              <video ref={videoRef} autoPlay playsInline muted />
              {!preview && (
                <>
                  <Video size={30} />
                  <span>Предпросмотр устройства</span>
                </>
              )}
            </div>
            <Button
              busy={busy === "devices"}
              onClick={async () => {
                if (preview) {
                  streamRef.current?.getTracks().forEach((t) => t.stop());
                  setPreview(false);
                  return;
                }
                setBusy("devices");
                setDeviceError("");
                const requestId = ++previewRequestRef.current;
                try {
                  const stream = await navigator.mediaDevices.getUserMedia({
                    video: true,
                    audio: false,
                  });
                  if (requestId !== previewRequestRef.current) {
                    stream.getTracks().forEach((track) => track.stop());
                    return;
                  }
                  streamRef.current = stream;
                  if (videoRef.current) videoRef.current.srcObject = stream;
                  setPreview(true);
                  setDevices(await navigator.mediaDevices.enumerateDevices());
                } catch {
                  setDeviceError(
                    "Нет доступа к камере. Проверьте разрешение браузера и подключение устройства. Микрофон можно проверить отдельно.",
                  );
                } finally {
                  setBusy("");
                }
              }}
            >
              {preview ? <Square size={16} /> : <Video size={17} />}{" "}
              {preview ? "Выключить предпросмотр" : "Проверить камеру"}
            </Button>
            {section === "devices" && <MicrophoneCheck />}
            {devices && (
              <div className="workspace-device-list">
                {devices
                  .filter(
                    (d) => d.kind === "videoinput" || d.kind === "audioinput",
                  )
                  .map((d) => (
                    <div key={d.deviceId}>
                      {d.kind === "videoinput" ? (
                        <Video size={14} />
                      ) : (
                        <Mic size={14} />
                      )}
                      <span>{d.label || "Устройство без названия"}</span>
                    </div>
                  ))}
              </div>
            )}
          </section>
          <section
            className="panel workspace-settings-panel"
            id="settings-services"
            hidden={section !== "services"}
          >
            <div className="workspace-section-heading">
              <h2>Возможности сервиса</h2>
              <Settings size={18} />
            </div>
            <p className="workspace-settings-description">
              Возможности сервиса и защита вашего аккаунта. Ограничения
              пространства указаны в разделе «Тариф».
            </p>
            {capability(
              "Видеосвязь",
              config.mediaConfigured,
              "Видео, звук, чат и демонстрация экрана",
            )}
            {capability(
              "Зал ожидания",
              true,
              "Организатор может включить предварительное разрешение на вход во встречу",
            )}
            {capability(
              "История чата",
              true,
              "Сообщения сохраняются в пространстве",
            )}
            {capability(
              "Двухфакторная аутентификация",
              Boolean(user.twoFactorEnabled),
              "Коды из приложения и резервные коды для входа",
              user.twoFactorEnabled ? "Включена у вас" : "Выключена у вас",
            )}
            {capability(
              "Записи встреч",
              config.recordingConfigured,
              "Сервис записи и защищенное хранилище",
            )}
            {capability(
              "Расшифровки",
              Boolean(config.transcriptionConfigured),
              "Текстовая версия готовых записей встреч",
            )}
            {capability(
              "Резюме AI",
              Boolean(config.summaryConfigured),
              "Краткие итоги по тексту встречи с обязательной проверкой результата",
            )}
            {capability(
              "Почтовые уведомления",
              config.emailConfigured && config.emailDelivery === "external",
              config.emailDelivery === "capture"
                ? "Сообщения доступны в тестовом ящике. Внешняя доставка не подключена."
                : "Подтверждение почты, восстановление доступа и приглашения",
              config.emailConfigured && config.emailDelivery === "capture"
                ? "Тестовый режим"
                : undefined,
            )}
            <p className="form-note">
              <Link to="/settings?section=security">
                Проверить защиту аккаунта
              </Link>
              {" · "}
              <Link to="/help">Помощь и поддержка</Link>
            </p>
          </section>
          <section
            className="panel workspace-settings-panel"
            id="settings-workspace"
            hidden={section !== "workspace"}
          >
            <div className="workspace-section-heading">
              <h2>Пространство</h2>
              <Users size={18} />
            </div>
            <p className="workspace-settings-description">
              {workspace.name} · {roleLabel[workspace.role]}
            </p>
            {workspace.role !== "member" && (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  setBusy("workspace");
                  try {
                    await api(
                      `/workspaces/${workspace.id}`,
                      { name: new FormData(e.currentTarget).get("name") },
                      "PATCH",
                    );
                    await refresh();
                    notify("Название пространства обновлено");
                  } catch (e) {
                    notify((e as Error).message, true);
                  } finally {
                    setBusy("");
                  }
                }}
              >
                <Field label="Название пространства">
                  <input
                    name="name"
                    defaultValue={workspace.name}
                    required
                    maxLength={100}
                  />
                </Field>
                <Button
                  className="primary"
                  type="submit"
                  busy={busy === "workspace"}
                >
                  Сохранить название
                </Button>
              </form>
            )}
            <h3>Новое пространство</h3>
            <p className="form-note">
              Отдельная команда со своими встречами и участниками. Вы станете
              владельцем.
            </p>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const form = e.currentTarget;
                setBusy("new-workspace");
                try {
                  await api("/workspaces", {
                    name: new FormData(form).get("name"),
                  });
                  await refresh();
                  form.reset();
                  notify(
                    "Пространство создано. Выберите его в меню пространств.",
                  );
                } catch (e) {
                  notify((e as Error).message, true);
                } finally {
                  setBusy("");
                }
              }}
            >
              <Field label="Название нового пространства">
                <input
                  name="name"
                  required
                  maxLength={100}
                  placeholder="Название команды"
                />
              </Field>
              <Button type="submit" busy={busy === "new-workspace"}>
                <Plus size={16} />
                Создать пространство
              </Button>
            </form>
            {section === "workspace" && (
              <WorkspaceOwnership
                workspace={workspace}
                refresh={refresh}
                notify={notify}
              />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

export function Invite({
  session,
  refresh,
  notify,
  onWorkspace,
}: {
  session: Session | null;
  refresh: () => Promise<Session>;
  notify: (s: string, e?: boolean) => void;
  onWorkspace: (id: string) => void;
}) {
  const [token, setToken] = useState(
    () => new URLSearchParams(location.hash.slice(1)).get("token") ?? "",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const update = () => {
      setToken(new URLSearchParams(location.hash.slice(1)).get("token") ?? "");
      setError("");
    };
    addEventListener("hashchange", update);
    addEventListener("popstate", update);
    return () => {
      removeEventListener("hashchange", update);
      removeEventListener("popstate", update);
    };
  }, []);
  useEffect(() => {
    if (token) rememberReturnTo(`/invite#token=${encodeURIComponent(token)}`);
  }, [token]);
  return (
    <div className="workspace-invite-page">
      <Brand />
      <div className="panel workspace-invite-card">
        <div className="workspace-invite-icon">
          <Users size={28} />
        </div>
        <h1>Приглашение в пространство</h1>
        <p>
          Присоединитесь к пространству с адресом почты, на который отправлено
          приглашение.
        </p>
        <ErrorBox error={error} />
        {!token ? (
          <ErrorBox error="Ссылка приглашения неполная. Попросите отправить ее заново." />
        ) : !session ? (
          <>
            <p className="form-note">
              Войдите или создайте аккаунт с адресом почты, на который вас
              пригласили.
            </p>
            <Button
              className="primary full"
              onClick={() => {
                rememberReturnTo(location.pathname + location.hash);
                go("/login");
              }}
            >
              Войти и принять приглашение
              <ArrowRight size={17} />
            </Button>
          </>
        ) : !session.user.emailVerified ? (
          <>
            <div className="workspace-notice">
              Для принятия приглашения подтвердите адрес {session.user.email}.
            </div>
            <Button
              className="primary full"
              onClick={() => {
                rememberReturnTo(location.pathname + location.hash);
                go("/verify-email");
              }}
            >
              Подтвердить почту
              <Mail size={17} />
            </Button>
          </>
        ) : (
          <>
            <div className="workspace-invite-account">
              <span className="workspace-avatar">
                {initials(session.user.name)}
              </span>
              <span>{session.user.email}</span>
            </div>
            <Button
              className="primary full"
              busy={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  const { workspace } = await api<{ workspace: Workspace }>(
                    "/invitations/accept",
                    { token },
                  );
                  await refresh();
                  takeReturnTo();
                  onWorkspace(workspace.id);
                  history.replaceState({}, "", "/");
                  go("/");
                  notify("Вы присоединились к команде");
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Присоединиться к команде
              <ArrowRight size={17} />
            </Button>
          </>
        )}
        {session && token && (
          <Button
            className="full"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                rememberReturnTo(`/invite#token=${encodeURIComponent(token)}`);
                await api("/auth/sign-out", {});
                go("/login");
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Войти с другой почтой
          </Button>
        )}
        <Link to="/" className="back-link">
          <ArrowLeft size={15} />
          На главную
        </Link>
      </div>
    </div>
  );
}
