import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowRight,
  CalendarDays,
  Clock3,
  Copy,
  Film,
  Globe2,
  Link2,
  Mic,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  Users,
  Video,
  DoorOpen,
} from "lucide-react";
import { api, date, meetingUrl } from "../api";
import type { Room, User, Workspace } from "../api";
import {
  Button,
  Empty,
  ErrorBox,
  Field,
  Link,
  Modal,
  Spinner,
  go,
} from "../ui";
import type { PageProps } from "../ui";
export function PageHeading({
  eyebrow,
  title,
  text,
  children,
}: {
  eyebrow: string;
  title: string;
  text: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{text}</p>
      </div>
      <div className="heading-actions">{children}</div>
    </div>
  );
}
export function Dashboard({
  workspace,
  user,
  config,
  notify,
}: PageProps & { user: User }) {
  const [overview, setOverview] = useState<{
    rooms: Room[];
    membersCount: number;
    recordingsCount: number;
  }>();
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [instant, setInstant] = useState(false);
  const load = useCallback(
    () =>
      api<{ rooms: Room[]; membersCount: number; recordingsCount: number }>(
        `/workspaces/${workspace.id}/overview`,
      )
        .then(setOverview)
        .catch((e) => setError(e.message)),
    [workspace.id],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const upcoming =
    overview?.rooms
      .filter(
        (r) =>
          r.status === "open" &&
          r.startsAt &&
          new Date(r.startsAt).getTime() >= Date.now(),
      )
      .sort((a, b) => a.startsAt!.localeCompare(b.startsAt!))
      .slice(0, 3) ?? [];
  async function start() {
    setInstant(true);
    try {
      const { room } = await api<{ room: Room }>(
        `/workspaces/${workspace.id}/rooms`,
        { title: "Быстрая встреча", allowGuests: true },
      );
      go(`/join/${room.slug}`);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setInstant(false);
    }
  }
  return (
    <>
      <PageHeading
        eyebrow="ВАШ ДЕНЬ В IMON MEETS"
        title={`Добрый день, ${user.name.split(" ")[0]}`}
        text="Все для продуктивного разговора в одном месте."
      >
        <Button className="primary" onClick={() => setEditing(true)}>
          <Plus size={18} />
          Запланировать встречу
        </Button>
      </PageHeading>
      <ErrorBox error={error} />
      <section className="welcome-panel">
        <div className="welcome-copy">
          <span className="pill">
            <span className="status-dot" />
            ВАШЕ ПРОСТРАНСТВО
          </span>
          <h2>
            Хорошие идеи
            <br />
            начинаются со встречи.
          </h2>
          <p>
            Соберите команду, обсудите важное
            <br className="desktop-break" /> и двигайтесь дальше вместе.
          </p>
          <Button className="dark-button" busy={instant} onClick={start}>
            <Video size={19} />
            Начать встречу
            <ArrowRight size={17} />
          </Button>
          <small>
            {config.mediaConfigured
              ? "Видео, звук и демонстрация экрана"
              : "Комнату можно создать. Видеосвязь еще настраивается."}
          </small>
        </div>
        <div className="meeting-art" aria-hidden="true">
          <div className="art-grid" />
          <div className="call-window">
            <div className="window-heading">
              <span />
              <span />
              <span />
              <div>IMON Meets</div>
            </div>
            <div className="call-tiles">
              <div className="person-tile person-one">
                <div className="person-head" />
                <div className="person-body" />
                <span>
                  <Mic size={11} />
                  Вы
                </span>
              </div>
              <div className="person-tile person-two">
                <div className="person-head" />
                <div className="person-body" />
                <span>
                  <Mic size={11} />
                  Команда
                </span>
              </div>
            </div>
            <div className="call-controls">
              <span>
                <Mic size={15} />
              </span>
              <span>
                <Video size={15} />
              </span>
              <span className="hangup">
                <DoorOpen size={15} />
              </span>
            </div>
          </div>
          <span className="floating-note">
            <Sparkles size={16} />
            Есть что обсудить
          </span>
        </div>
      </section>
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-icon peach">
            <Video size={21} />
          </div>
          <div>
            <span>Открытые комнаты</span>
            <strong>
              {overview ? (
                overview.rooms.filter((r) => r.status === "open").length
              ) : (
                <span className="skeleton-number" />
              )}
            </strong>
          </div>
          <Link to="/rooms" title="Перейти к комнатам">
            <ArrowRight size={18} />
          </Link>
        </div>
        <div className="stat-card">
          <div className="stat-icon lavender">
            <Users size={21} />
          </div>
          <div>
            <span>Участники команды</span>
            <strong>
              {overview ? (
                overview.membersCount
              ) : (
                <span className="skeleton-number" />
              )}
            </strong>
          </div>
          <Link to="/team" title="Перейти к команде">
            <ArrowRight size={18} />
          </Link>
        </div>
        <div className="stat-card">
          <div className="stat-icon sage">
            <Film size={21} />
          </div>
          <div>
            <span>Записи встреч</span>
            <strong>
              {overview ? (
                overview.recordingsCount
              ) : (
                <span className="skeleton-number" />
              )}
            </strong>
          </div>
          <Link to="/recordings" title="Перейти к записям">
            <ArrowRight size={18} />
          </Link>
        </div>
      </div>
      <div className="dashboard-bottom">
        <section className="panel upcoming-panel">
          <div className="section-heading">
            <h2>
              Ближайшие встречи <span className="count">{upcoming.length}</span>
            </h2>
            <Link to="/rooms">
              Все комнаты
              <ArrowRight size={15} />
            </Link>
          </div>
          {!overview && !error ? (
            <div className="loading-section">
              <Spinner />
            </div>
          ) : upcoming.length ? (
            upcoming.map((room) => (
              <div className="upcoming-row" key={room.id}>
                <div className="calendar-date">
                  <strong>{new Date(room.startsAt!).getDate()}</strong>
                  <span>
                    {new Intl.DateTimeFormat("ru", { month: "short" }).format(
                      new Date(room.startsAt!),
                    )}
                  </span>
                </div>
                <div>
                  <h3>{room.title}</h3>
                  <p>
                    <Clock3 size={13} />
                    {date(room.startsAt)}
                    <span>·</span>
                    {room.durationMinutes} мин
                  </p>
                </div>
                <Link to={`/join/${room.slug}`} className="button small">
                  Войти
                  <ArrowRight size={14} />
                </Link>
              </div>
            ))
          ) : (
            <Empty
              icon={CalendarDays}
              title="Впереди свободное время"
              text="Запланируйте встречу, и она появится здесь."
              action={
                <Button
                  className="text-button"
                  onClick={() => setEditing(true)}
                >
                  <Plus size={15} />
                  Запланировать встречу
                </Button>
              }
            />
          )}
        </section>
        <section className="team-card">
          <div className="team-card-top" aria-hidden="true">
            <div className="overlap-avatar">И</div>
            <div className="overlap-avatar">М</div>
            <div className="overlap-avatar">
              <Plus size={17} />
            </div>
          </div>
          <h2>Вместе получается больше</h2>
          <p>
            Пригласите коллег в пространство, чтобы встречи были всегда под
            рукой.
          </p>
          <Link to="/team" className="button">
            Пригласить команду
            <ArrowRight size={16} />
          </Link>
          <span className="team-card-label">
            <ShieldCheck size={14} />
            Общее пространство, понятный доступ
          </span>
        </section>
      </div>
      {editing && (
        <RoomEditor
          workspace={workspace}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void load();
            notify("Встреча запланирована");
          }}
        />
      )}
    </>
  );
}

function RoomEditor({
  workspace,
  room,
  onClose,
  onSaved,
}: {
  workspace: Workspace;
  room?: Room;
  onClose: () => void;
  onSaved: (r: Room) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [scheduled, setScheduled] = useState(!!room?.startsAt);
  const [guests, setGuests] = useState(room?.allowGuests ?? true);
  const localDate = room?.startsAt
    ? new Date(
        new Date(room.startsAt).getTime() -
          new Date(room.startsAt).getTimezoneOffset() * 60000,
      )
        .toISOString()
        .slice(0, 16)
    : "";
  return (
    <Modal
      title={room ? "Изменить встречу" : "Новая встреча"}
      onClose={onClose}
    >
      <p className="modal-intro">
        Дайте разговору название. Ссылкой можно будет поделиться сразу после
        создания.
      </p>
      <ErrorBox error={error} />
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          setBusy(true);
          try {
            const { room: saved } = await api<{ room: Room }>(
              `/workspaces/${workspace.id}/rooms${room ? "/" + room.id : ""}`,
              {
                title: data.get("title"),
                description: data.get("description"),
                startsAt: scheduled
                  ? new Date(data.get("startsAt") as string).toISOString()
                  : null,
                durationMinutes: Number(data.get("durationMinutes")),
                maxParticipants: Number(data.get("maxParticipants")),
                allowGuests: guests,
              },
              room ? "PATCH" : "POST",
            );
            onSaved(saved);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Название встречи">
          <input
            autoFocus
            name="title"
            required
            maxLength={160}
            defaultValue={room?.title}
            placeholder="Например, Планы на неделю"
          />
        </Field>
        <Field label="Описание · необязательно">
          <textarea
            name="description"
            rows={3}
            maxLength={3000}
            defaultValue={room?.description}
            placeholder="О чем будем говорить?"
          />
        </Field>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={scheduled}
            onChange={(e) => setScheduled(e.target.checked)}
          />
          <span>Запланировать дату и время</span>
        </label>
        {scheduled && (
          <Field label="Начало встречи">
            <input
              type="datetime-local"
              name="startsAt"
              defaultValue={localDate}
              required
            />
          </Field>
        )}
        <div className="form-columns">
          <Field label="Длительность">
            <select
              name="durationMinutes"
              defaultValue={room?.durationMinutes ?? 60}
            >
              {[15, 30, 45, 60, 90, 120, 180, 240].map((n) => (
                <option key={n} value={n}>
                  {n} минут
                </option>
              ))}
            </select>
          </Field>
          <Field label="Максимум участников">
            <input
              type="number"
              name="maxParticipants"
              required
              min={2}
              max={100}
              defaultValue={room?.maxParticipants ?? 20}
            />
          </Field>
        </div>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={guests}
            onChange={(e) => setGuests(e.target.checked)}
          />
          <span>
            Разрешить гостям вход по ссылке
            <small>Гостям не понадобится аккаунт</small>
          </span>
        </label>
        <div className="modal-actions">
          <Button type="button" onClick={onClose}>
            Отмена
          </Button>
          <Button type="submit" className="primary" busy={busy}>
            {room ? "Сохранить изменения" : "Создать встречу"}
            <ArrowRight size={16} />
          </Button>
        </div>
      </form>
    </Modal>
  );
}
function ShareRoom({
  room,
  workspace,
  onClose,
  onUpdate,
  notify,
}: {
  room: Room;
  workspace: Workspace;
  onClose: () => void;
  onUpdate: (r: Room) => void;
  notify: (s: string, e?: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title="Пригласить на встречу" onClose={onClose}>
      <div className="share-room-title">
        <div className="stat-icon peach">
          <Video size={23} />
        </div>
        <div>
          <h3>{room.title}</h3>
          <p>
            {room.allowGuests
              ? "Доступна гостям по ссылке"
              : "Только для участников пространства"}
          </p>
        </div>
      </div>
      <Field label="Ссылка на встречу">
        <div className="copy-field">
          <input readOnly value={meetingUrl(room.slug)} />
          <Button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(meetingUrl(room.slug));
                notify("Ссылка скопирована");
              } catch {
                setError(
                  "Не удалось скопировать. Выделите ссылку и скопируйте вручную.",
                );
              }
            }}
            aria-label="Скопировать ссылку"
          >
            <Copy size={17} />
          </Button>
        </div>
      </Field>
      <p className="form-note">
        {room.allowGuests
          ? "Любой человек с этой ссылкой сможет войти, указав свое имя."
          : "Отправьте ссылку коллегам, которые состоят в вашем пространстве."}
      </p>
      <ErrorBox error={error} />
      <div className="modal-actions">
        <Button
          className="text-button"
          busy={busy}
          onClick={async () => {
            if (
              !confirm(
                "Заменить ссылку? Предыдущая ссылка перестанет давать новые разрешения на вход.",
              )
            )
              return;
            setBusy(true);
            try {
              const { room: newRoom } = await api<{ room: Room }>(
                `/workspaces/${workspace.id}/rooms/${room.id}/rotate-link`,
                {},
              );
              onUpdate(newRoom);
              notify("Создана новая ссылка");
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Заменить ссылку
        </Button>
        <Button onClick={onClose}>Готово</Button>
      </div>
    </Modal>
  );
}
export function Rooms({
  workspace,
  user,
  config,
  notify,
}: PageProps & { user: User }) {
  const [rooms, setRooms] = useState<Room[]>();
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("open");
  const [editor, setEditor] = useState<Room | true>();
  const [sharing, setSharing] = useState<Room>();
  const [busy, setBusy] = useState("");
  const load = useCallback(
    () =>
      api<{ rooms: Room[] }>(`/workspaces/${workspace.id}/rooms`)
        .then((r) => setRooms(r.rooms))
        .catch((e) => setError(e.message)),
    [workspace.id],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const visible = rooms?.filter(
    (r) =>
      (filter === "all" || r.status === filter) &&
      r.title.toLowerCase().includes(query.toLowerCase()),
  );
  const canManage = (r: Room) =>
    workspace.role !== "member" || r.createdBy === user.id;
  return (
    <>
      <PageHeading
        eyebrow="МЕСТО ДЛЯ РАЗГОВОРА"
        title="Комнаты"
        text="Планируйте встречи и собирайте команду по одной ссылке."
      >
        <Button className="primary" onClick={() => setEditor(true)}>
          <Plus size={18} />
          Создать комнату
        </Button>
      </PageHeading>
      {!config.mediaConfigured && (
        <div className="notice">
          <Video size={18} />
          <span>
            Видеосвязь еще не настроена. Вы можете создавать комнаты и
            планировать встречи.
          </span>
        </div>
      )}
      <ErrorBox error={error} />
      <div className="panel">
        <div className="list-toolbar">
          <div className="tabs">
            {[
              ["open", "Открытые"],
              ["closed", "Завершенные"],
              ["all", "Все комнаты"],
            ].map(([value, label]) => (
              <button
                key={value}
                onClick={() => setFilter(value)}
                className={filter === value ? "selected" : ""}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="search-field">
            <Search size={17} />
            <input
              placeholder="Найти комнату"
              aria-label="Найти комнату"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </div>
        {!rooms && !error ? (
          <div className="loading-section">
            <Spinner />
          </div>
        ) : visible?.length ? (
          <div className="room-list">
            {visible.map((room) => (
              <article className="room-row" key={room.id}>
                <div
                  className={`room-row-icon ${room.status === "closed" ? "muted" : ""}`}
                >
                  <Video size={23} />
                </div>
                <div className="room-details">
                  <div className="room-name-line">
                    <h3>{room.title}</h3>
                    <span
                      className={`badge ${room.status === "open" ? "green" : "gray"}`}
                    >
                      {room.status === "open" ? "Открыта" : "Завершена"}
                    </span>
                  </div>
                  {room.description && (
                    <p className="room-description">{room.description}</p>
                  )}
                  <div className="room-meta">
                    <span>
                      <CalendarDays size={14} />
                      {date(room.startsAt)}
                    </span>
                    <span>
                      <Clock3 size={14} />
                      {room.durationMinutes} мин
                    </span>
                    <span>
                      {room.allowGuests ? (
                        <Globe2 size={14} />
                      ) : (
                        <ShieldCheck size={14} />
                      )}{" "}
                      {room.allowGuests ? "Вход по ссылке" : "Только команда"}
                    </span>
                    <span>
                      <Users size={14} />
                      До {room.maxParticipants}
                    </span>
                  </div>
                </div>
                <div className="row-actions">
                  {room.status === "open" && (
                    <>
                      <Button
                        className="icon-button"
                        title="Поделиться ссылкой"
                        aria-label={`Поделиться: ${room.title}`}
                        onClick={() => setSharing(room)}
                      >
                        <Link2 size={18} />
                      </Button>
                      {canManage(room) && (
                        <Button
                          className="icon-button"
                          aria-label={`Изменить: ${room.title}`}
                          onClick={() => setEditor(room)}
                        >
                          <Pencil size={17} />
                        </Button>
                      )}
                      <Link to={`/join/${room.slug}`} className="button small">
                        Войти
                        <ArrowRight size={15} />
                      </Link>
                      {canManage(room) && (
                        <Button
                          className="icon-button danger-quiet"
                          busy={busy === room.id}
                          title="Завершить комнату"
                          aria-label={`Завершить: ${room.title}`}
                          onClick={async () => {
                            if (
                              !confirm(
                                "Завершить комнату и отключить всех участников? Это действие нельзя отменить.",
                              )
                            )
                              return;
                            setBusy(room.id);
                            try {
                              await api(
                                `/workspaces/${workspace.id}/rooms/${room.id}/close`,
                                {},
                              );
                              await load();
                              notify("Комната завершена");
                            } catch (e) {
                              notify((e as Error).message, true);
                            } finally {
                              setBusy("");
                            }
                          }}
                        >
                          <Square size={16} />
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <Empty
            icon={query ? Search : Video}
            title={
              query
                ? "Ничего не найдено"
                : filter === "closed"
                  ? "Завершенных встреч пока нет"
                  : "Ваша следующая встреча начинается здесь"
            }
            text={
              query
                ? "Попробуйте другое название комнаты."
                : "Создайте комнату и пригласите коллег к разговору."
            }
            action={
              !query && filter !== "closed" ? (
                <Button className="primary" onClick={() => setEditor(true)}>
                  <Plus size={17} />
                  Создать комнату
                </Button>
              ) : undefined
            }
          />
        )}
      </div>
      {editor && (
        <RoomEditor
          workspace={workspace}
          room={editor === true ? undefined : editor}
          onClose={() => setEditor(undefined)}
          onSaved={() => {
            setEditor(undefined);
            void load();
            notify(editor === true ? "Комната создана" : "Изменения сохранены");
          }}
        />
      )}
      {sharing && (
        <ShareRoom
          room={sharing}
          workspace={workspace}
          onClose={() => setSharing(undefined)}
          onUpdate={(r) => {
            setSharing(r);
            void load();
          }}
          notify={notify}
        />
      )}
    </>
  );
}
