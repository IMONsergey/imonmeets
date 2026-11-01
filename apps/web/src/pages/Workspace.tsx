import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Clock3,
  Copy,
  Film,
  Mail,
  Mic,
  Plus,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Users,
  Video,
} from "lucide-react";
import { api, date, initials } from "../api";
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
  const load = useCallback(
    () =>
      api<{ recordings: Recording[] }>(`/workspaces/${workspace.id}/recordings`)
        .then((r) => setRecordings(r.recordings))
        .catch((e) => setError(e.message)),
    [workspace.id],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (
      recordings?.some((r) =>
        ["starting", "active", "ending"].includes(r.status),
      )
    ) {
      const timer = setInterval(() => void load(), 10000);
      return () => clearInterval(timer);
    }
  }, [recordings, load]);
  return (
    <>
      <PageHeading
        eyebrow="СОХРАНИТЕ ВАЖНОЕ"
        title="Записи встреч"
        text="Возвращайтесь к обсуждениям, когда это нужно."
      />
      <ErrorBox error={error} />
      {!config.recordingConfigured && (
        <div className="notice">
          <Film size={19} />
          <span>
            <strong>Запись встреч пока не подключена.</strong> Администратору
            сервера нужно настроить сервис записи и защищенное хранилище.
          </span>
        </div>
      )}
      <div className="panel">
        <div className="section-heading">
          <h2>
            Все записи
            {recordings && <span className="count">{recordings.length}</span>}
          </h2>
          <span className="subtle">
            <ShieldCheck size={14} />
            Доступны вашей команде
          </span>
        </div>
        {!recordings && !error ? (
          <div className="loading-section">
            <Spinner />
          </div>
        ) : recordings?.length ? (
          <div>
            {recordings.map((r) => (
              <div className="recording-row" key={r.id}>
                <div className="stat-icon lavender">
                  <Film size={22} />
                </div>
                <div className="recording-details">
                  <h3>{r.roomTitle}</h3>
                  <p>
                    {date(r.startedAt)}
                    {r.sizeBytes !== null && (
                      <> · {(r.sizeBytes / 1024 / 1024).toFixed(1)} МБ</>
                    )}
                  </p>
                  {r.error && <small className="danger-text">{r.error}</small>}
                </div>
                <span
                  className={`badge ${r.status === "complete" ? "green" : r.status === "failed" ? "red" : "orange"}`}
                >
                  {r.status === "active" && <span className="status-dot" />}
                  {recordingLabels[r.status]}
                </span>
                {r.status === "complete" && config.recordingConfigured && (
                  <Button
                    busy={busy === r.id}
                    onClick={async () => {
                      setBusy(r.id);
                      try {
                        const response = await fetch(
                          `/api/workspaces/${workspace.id}/recordings/${r.id}/download`,
                          { credentials: "include" },
                        );
                        if (!response.ok)
                          throw new Error(
                            "Не удалось получить ссылку на запись.",
                          );
                        if (
                          response.headers.get("Content-Type")?.includes("json")
                        ) {
                          const data = await response.json();
                          if (!data.url)
                            throw new Error(
                              "Ссылка на запись пока недоступна.",
                            );
                          window.open(
                            data.url,
                            "_blank",
                            "noopener,noreferrer",
                          );
                        } else
                          window.open(
                            response.url,
                            "_blank",
                            "noopener,noreferrer",
                          );
                      } catch (e) {
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
              </div>
            ))}
          </div>
        ) : (
          <Empty
            icon={Film}
            title="Важные разговоры останутся с вами"
            text={
              config.recordingConfigured
                ? "Начните запись из комнаты встречи. Готовое видео появится здесь."
                : "После подключения записи здесь будут сохраняться встречи вашей команды."
            }
          />
        )}
      </div>
    </>
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
  const load = useCallback(
    () =>
      api<{ members: Member[]; invitations: Invitation[] }>(
        `/workspaces/${workspace.id}/members`,
      )
        .then(setData)
        .catch((e) => setError(e.message)),
    [workspace.id],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const manage = workspace.role !== "member";
  return (
    <>
      <PageHeading
        eyebrow="ЛЮДИ, С КОТОРЫМИ ВЫ НА СВЯЗИ"
        title="Ваша команда"
        text="Одно пространство для всей команды. У каждого своя роль."
      >
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
      <div className="panel">
        <div className="section-heading">
          <h2>
            Участники{" "}
            {data && <span className="count">{data.members.length}</span>}
          </h2>
          <span className="subtle">{workspace.name}</span>
        </div>
        {!data && !error ? (
          <div className="loading-section">
            <Spinner />
          </div>
        ) : (
          <div>
            {data?.members.map((member) => (
              <div className="member-row" key={member.id}>
                <div
                  className={`avatar ${member.role === "owner" ? "peach" : ""}`}
                >
                  {initials(member.name)}
                </div>
                <div className="member-details">
                  <h3>
                    {member.name}
                    {member.userId === user.id && (
                      <span className="you-label">Это вы</span>
                    )}
                  </h3>
                  <p>{member.email}</p>
                </div>
                <span
                  className={`badge ${member.role === "owner" ? "orange" : "gray"}`}
                >
                  {member.role === "owner" && <ShieldCheck size={12} />}{" "}
                  {roleLabel[member.role]}
                </span>
                {manage &&
                  member.role !== "owner" &&
                  member.userId !== user.id &&
                  (workspace.role === "owner" || member.role === "member") && (
                    <Button
                      className="icon-button danger-quiet"
                      busy={busy === member.id}
                      aria-label={`Удалить участника ${member.name}`}
                      onClick={async () => {
                        if (!confirm(`Удалить ${member.name} из пространства?`))
                          return;
                        setBusy(member.id);
                        try {
                          await api(
                            `/workspaces/${workspace.id}/members/${member.id}`,
                            undefined,
                            "DELETE",
                          );
                          await load();
                          notify("Участник удален");
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
            ))}
          </div>
        )}
      </div>
      {manage && data && data.invitations.length > 0 && (
        <div className="panel invitations-panel">
          <div className="section-heading">
            <h2>
              Ожидают приглашения{" "}
              <span className="count">{data.invitations.length}</span>
            </h2>
          </div>
          {data.invitations.map((i) => (
            <div className="member-row" key={i.id}>
              <div className="avatar">
                <Mail size={19} />
              </div>
              <div className="member-details">
                <h3>{i.email}</h3>
                <p>Действует до {date(i.expiresAt, false)}</p>
              </div>
              <span className="badge gray">{roleLabel[i.role]}</span>
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
      <div className="info-caption">
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
              <div className="success-box">
                <CheckCircle2 size={21} />
                <span>Приглашение создано. Передайте ссылку коллеге.</span>
              </div>
              <Field label="Личная ссылка приглашения">
                <div className="copy-field">
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
                  const r = await api<{ inviteUrl?: string }>(
                    `/workspaces/${workspace.id}/invitations`,
                    { email: f.get("email"), role: f.get("role") },
                  );
                  await load();
                  if (r.inviteUrl) setInviteUrl(r.inviteUrl);
                  else {
                    setInvite(false);
                    notify("Приглашение отправлено");
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
    </>
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
  const [devices, setDevices] = useState<MediaDeviceInfo[]>();
  const [deviceError, setDeviceError] = useState("");
  const [preview, setPreview] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  useEffect(
    () => () => streamRef.current?.getTracks().forEach((t) => t.stop()),
    [],
  );
  const capability = (label: string, enabled: boolean, description: string) => (
    <div className="capability-row">
      <div>
        <strong>{label}</strong>
        <p>{description}</p>
      </div>
      <span className={`badge ${enabled ? "green" : "gray"}`}>
        {enabled ? <Check size={13} /> : <Clock3 size={13} />}{" "}
        {enabled ? "Настроено" : "Не настроено"}
      </span>
    </div>
  );
  return (
    <>
      <PageHeading
        eyebrow="ВСЕ, ЧТО ВАМ НУЖНО"
        title="Настройки"
        text="Ваш профиль, устройства и возможности пространства."
      />
      <div className="settings-grid">
        <section className="panel settings-panel">
          <div className="section-heading">
            <h2>Личный профиль</h2>
            <Settings size={18} />
          </div>
          <div className="profile-summary">
            <div className="avatar large peach">{initials(user.name)}</div>
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
            <div className="email-status">
              <span
                className={`badge ${user.emailVerified ? "green" : "orange"}`}
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
            <Button type="submit" busy={busy === "profile"}>
              Сохранить изменения
            </Button>
          </form>
        </section>
        <section className="panel settings-panel">
          <div className="section-heading">
            <h2>Безопасность</h2>
            <ShieldCheck size={18} />
          </div>
          <p className="settings-description">
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
            <Button type="submit" busy={busy === "password"}>
              Обновить пароль
            </Button>
          </form>
        </section>
        <section className="panel settings-panel">
          <div className="section-heading">
            <h2>Камера и микрофон</h2>
            <Video size={18} />
          </div>
          <p className="settings-description">
            Проверьте доступ к устройствам. Перед каждой встречей вы сможете
            выбрать камеру и микрофон.
          </p>
          <ErrorBox error={deviceError} />
          <div className={`device-preview ${preview ? "show-preview" : ""}`}>
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
              try {
                const stream = await navigator.mediaDevices.getUserMedia({
                  video: true,
                  audio: true,
                });
                streamRef.current = stream;
                if (videoRef.current) videoRef.current.srcObject = stream;
                setPreview(true);
                setDevices(await navigator.mediaDevices.enumerateDevices());
              } catch {
                setDeviceError(
                  "Нет доступа к камере или микрофону. Проверьте разрешения браузера и подключение устройств.",
                );
              } finally {
                setBusy("");
              }
            }}
          >
            {preview ? <Square size={16} /> : <Video size={17} />}{" "}
            {preview ? "Выключить предпросмотр" : "Проверить устройства"}
          </Button>
          {devices && (
            <div className="device-list">
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
                    <CheckCircle2 size={14} />
                  </div>
                ))}
            </div>
          )}
        </section>
        <section className="panel settings-panel">
          <div className="section-heading">
            <h2>Возможности сервиса</h2>
            <Sparkles size={18} />
          </div>
          <p className="settings-description">
            Текущее состояние сервисов для вашего пространства.
          </p>
          {capability(
            "Видеосвязь",
            config.mediaConfigured,
            "Видео, звук, чат и демонстрация экрана",
          )}
          {capability(
            "Записи встреч",
            config.recordingConfigured,
            "Сервис записи и защищенное хранилище",
          )}
          {capability(
            "Почтовые уведомления",
            config.emailConfigured,
            "Подтверждение почты и приглашения",
          )}
          <p className="form-note">
            Подключение сервисов выполняет администратор сервера.
          </p>
        </section>
      </div>
    </>
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
  const [token] = useState(
    () => new URLSearchParams(location.hash.slice(1)).get("token") ?? "",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="standalone">
      <Brand />
      <div className="standalone-card">
        <div className="empty-icon">
          <Users size={28} />
        </div>
        <span className="eyebrow">ВАС ПРИГЛАСИЛИ В КОМАНДУ</span>
        <h1>Работать вместе проще.</h1>
        <p>
          Примите приглашение, чтобы присоединиться к рабочему пространству
          коллег.
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
                sessionStorage.setItem(
                  "imon.returnTo",
                  location.pathname + location.hash,
                );
                go("/login");
              }}
            >
              Войти и принять приглашение
              <ArrowRight size={17} />
            </Button>
          </>
        ) : !session.user.emailVerified ? (
          <>
            <div className="notice">
              Для принятия приглашения подтвердите адрес {session.user.email}.
            </div>
            <Button
              className="primary full"
              onClick={() => {
                sessionStorage.setItem(
                  "imon.returnTo",
                  location.pathname + location.hash,
                );
                go("/verify-email");
              }}
            >
              Подтвердить почту
              <Mail size={17} />
            </Button>
          </>
        ) : (
          <>
            <div className="invite-account">
              <span className="avatar">{initials(session.user.name)}</span>
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
        <Link to="/" className="back-link">
          <ArrowLeft size={15} />
          На главную
        </Link>
      </div>
    </div>
  );
}
