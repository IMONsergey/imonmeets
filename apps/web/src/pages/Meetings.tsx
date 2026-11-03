import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowRight,
  CalendarDays,
  CalendarPlus,
  Clock3,
  ChevronLeft,
  ChevronRight,
  LogIn,
  Copy,
  Film,
  Globe2,
  Link2,
  MessageSquare,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Square,
  Users,
  Video,
} from "lucide-react";
import { api, meetingUrl } from "../api";
import {
  downloadMeetingCalendar,
  localDateTimeInput,
  localMeetingDateTime,
  localTimeZone,
  parseLocalMeetingStart,
} from "../calendar";
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
import { ChatHistory } from "./ChatHistory";

function CalendarExport({
  room,
  notify,
  compact = false,
}: {
  room: Room;
  notify: PageProps["notify"];
  compact?: boolean;
}) {
  if (!room.startsAt || room.status !== "open") return null;
  return (
    <Button
      className={compact ? "icon-button calendar-export" : "calendar-export"}
      title="Добавить в календарь (.ics)"
      aria-label={`Добавить в календарь: ${room.title}`}
      onClick={() => {
        try {
          downloadMeetingCalendar(room);
          notify("Файл .ics подготовлен. Откройте его в вашем календаре.");
        } catch (error) {
          notify((error as Error).message, true);
        }
      }}
    >
      <CalendarPlus size={17} aria-hidden="true" />
      {!compact && "Добавить в календарь (.ics)"}
    </Button>
  );
}

export function PageHeading({
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
        <h1>{title}</h1>
        <p>{text}</p>
      </div>
      <div className="heading-actions">{children}</div>
    </div>
  );
}
function MeetingClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="home-clock">
      <time className="home-time" dateTime={now.toISOString()}>
        {new Intl.DateTimeFormat("ru", {
          hour: "2-digit",
          minute: "2-digit",
        }).format(now)}
      </time>
      <p>
        {new Intl.DateTimeFormat("ru", {
          weekday: "long",
          day: "numeric",
          month: "long",
        }).format(now)}
      </p>
    </div>
  );
}

function JoinMeeting({ onClose }: { onClose: () => void }) {
  const [error, setError] = useState("");
  return (
    <Modal title="Присоединиться к встрече" onClose={onClose}>
      <p className="modal-intro">
        Вставьте ссылку, которую прислал организатор.
      </p>
      <ErrorBox error={error} />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const value = String(
            new FormData(event.currentTarget).get("meeting") ?? "",
          ).trim();
          let slug = value;
          try {
            if (value.includes("/")) {
              const url = new URL(value, location.origin);
              if (
                url.origin !== location.origin ||
                !url.pathname.startsWith("/join/")
              )
                throw new Error();
              slug = decodeURIComponent(url.pathname.slice(6));
            }
            if (!/^[a-zA-Z0-9_-]{16,128}$/.test(slug)) throw new Error();
            go(`/join/${encodeURIComponent(slug)}`);
          } catch {
            setError(
              "Нужна ссылка на встречу IMON Meets или код из этой ссылки.",
            );
          }
        }}
      >
        <Field label="Ссылка или код встречи">
          <input
            name="meeting"
            required
            autoFocus
            autoComplete="off"
            placeholder={`${location.origin}/join/…`}
          />
        </Field>
        <div className="modal-actions">
          <Button type="button" onClick={onClose}>
            Отмена
          </Button>
          <Button type="submit" className="primary">
            Присоединиться
          </Button>
        </div>
      </form>
    </Modal>
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
  }>();
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [joining, setJoining] = useState(false);
  const [instant, setInstant] = useState(false);
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const dashboardVersion = useRef(0);
  const load = useCallback(async () => {
    const version = ++dashboardVersion.current;
    try {
      const rooms: Room[] = [];
      let before: string | undefined;
      do {
        const page = await api<{ rooms: Room[]; nextCursor?: string | null }>(
          `/workspaces/${workspace.id}/rooms?view=open${before ? `&before=${encodeURIComponent(before)}` : ""}`,
        );
        if (version !== dashboardVersion.current) return;
        rooms.push(...page.rooms);
        if (page.nextCursor && page.nextCursor === before)
          throw new Error("Не удалось загрузить расписание. Повторите запрос.");
        before = page.nextCursor ?? undefined;
      } while (before);
      setOverview({ rooms });
      setError("");
    } catch (e) {
      if (version === dashboardVersion.current) setError((e as Error).message);
    }
  }, [workspace.id]);
  useEffect(() => {
    void load();
    return () => {
      dashboardVersion.current++;
    };
  }, [load]);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  const isToday = sameDay(selectedDate, new Date());
  const agenda =
    overview?.rooms
      .filter(
        (room) =>
          room.status === "open" &&
          room.startsAt &&
          sameDay(new Date(room.startsAt), selectedDate),
      )
      .sort((a, b) => a.startsAt!.localeCompare(b.startsAt!)) ?? [];
  function moveDay(amount: number) {
    setSelectedDate((previous) => {
      const next = new Date(previous);
      next.setDate(next.getDate() + amount);
      return next;
    });
  }
  async function start() {
    setInstant(true);
    try {
      const { room } = await api<{ room: Room }>(
        `/workspaces/${workspace.id}/rooms`,
        { title: "Быстрая встреча", allowGuests: true },
      );
      go(`/join/${room.slug}`);
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setInstant(false);
    }
  }
  return (
    <div className="home-page">
      <h1 className="home-greeting">Добрый день, {user.name.split(" ")[0]}</h1>
      <MeetingClock />
      <ErrorBox error={error} />
      <div className="quick-actions" aria-label="Действия со встречами">
        <button className="quick-action" disabled={instant} onClick={start}>
          <span className="quick-action-icon new-meeting">
            {instant ? (
              <Spinner />
            ) : (
              <Video size={29} fill="currentColor" strokeWidth={1.5} />
            )}
          </span>
          <span>Начать встречу</span>
        </button>
        <button
          className="quick-action"
          aria-label="Присоединиться"
          onClick={() => setJoining(true)}
        >
          <span className="quick-action-icon">
            <LogIn size={29} strokeWidth={1.8} />
          </span>
          <span>Войти</span>
        </button>
        <button
          className="quick-action"
          aria-label="Запланировать встречу"
          onClick={() => setEditing(true)}
        >
          <span className="quick-action-icon">
            <CalendarDays size={29} strokeWidth={1.8} />
          </span>
          <span>Запланировать</span>
        </button>
        <Link to="/team" className="quick-action">
          <span className="quick-action-icon">
            <Users size={29} strokeWidth={1.8} />
          </span>
          <span>Команда</span>
        </Link>
      </div>
      {!config.mediaConfigured && (
        <div className="notice">
          <Video size={18} />
          <span>
            Видеосвязь еще настраивается. Планирование встреч уже доступно.
          </span>
        </div>
      )}
      <section className="agenda-panel panel" aria-label="Расписание встреч">
        <div className="agenda-heading">
          <button
            className="icon-button"
            aria-label="Добавить встречу"
            onClick={() => setEditing(true)}
          >
            <Plus size={19} />
          </button>
          <h2>
            {isToday ? "Сегодня, " : ""}
            {new Intl.DateTimeFormat("ru", {
              day: "numeric",
              month: "long",
            }).format(selectedDate)}
          </h2>
          <Link
            to="/rooms"
            className="icon-button"
            title="Все встречи"
            aria-label="Все встречи"
          >
            <CalendarDays size={18} />
          </Link>
        </div>
        <div className="agenda-navigation">
          <Button className="small" onClick={() => void load()}>
            Обновить
          </Button>
          <Button className="small" onClick={() => setSelectedDate(new Date())}>
            <CalendarDays size={14} />
            Сегодня
          </Button>
          <button
            className="icon-button"
            aria-label="Предыдущий день"
            onClick={() => moveDay(-1)}
          >
            <ChevronLeft size={17} />
          </button>
          <button
            className="icon-button"
            aria-label="Следующий день"
            onClick={() => moveDay(1)}
          >
            <ChevronRight size={17} />
          </button>
          <span>{localTimeZone()}</span>
        </div>
        <div className="agenda-content">
          {!overview && !error ? (
            <div className="loading-section">
              <Spinner />
            </div>
          ) : agenda.length ? (
            agenda.map((room) => (
              <article className="agenda-event" key={room.id}>
                <div className="agenda-event-time">
                  <time dateTime={room.startsAt!}>
                    {new Intl.DateTimeFormat("ru", {
                      hour: "2-digit",
                      minute: "2-digit",
                    }).format(new Date(room.startsAt!))}
                  </time>
                  <span>{room.durationMinutes} мин</span>
                </div>
                <div className="agenda-event-details">
                  <h3>{room.title}</h3>
                  <p>
                    {room.allowGuests ? "Вход по ссылке" : "Встреча команды"}
                  </p>
                </div>
                <div className="upcoming-actions">
                  <CalendarExport room={room} notify={notify} compact />
                  <Link
                    to={`/join/${room.slug}`}
                    className="button primary small"
                    title={`Войти: ${room.title}`}
                  >
                    Войти
                  </Link>
                </div>
              </article>
            ))
          ) : error ? (
            <Empty
              icon={CalendarDays}
              title="Не удалось загрузить расписание"
              text="Повторите запрос."
              action={<Button onClick={() => void load()}>Повторить</Button>}
            />
          ) : (
            <Empty
              icon={CalendarDays}
              title="На этот день встреч нет"
              text="Запланированные встречи появятся здесь."
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
        </div>
        <div className="agenda-footer">
          <Link to="/recordings">
            <Film size={15} />
            Записи встреч
            <ChevronRight size={14} />
          </Link>
          <Link to="/rooms">
            Все встречи
            <ChevronRight size={14} />
          </Link>
        </div>
      </section>
      {editing && (
        <RoomEditor
          workspace={workspace}
          scheduledByDefault
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void load();
            notify("Встреча запланирована");
          }}
        />
      )}
      {joining && <JoinMeeting onClose={() => setJoining(false)} />}
    </div>
  );
}

function RoomEditor({
  workspace,
  room,
  onClose,
  onSaved,
  scheduledByDefault = false,
}: {
  workspace: Workspace;
  room?: Room;
  onClose: () => void;
  onSaved: (
    r: Room,
    access?: { accessReset?: boolean; mediaPending?: boolean },
  ) => void;
  scheduledByDefault?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [scheduled, setScheduled] = useState(
    !!room?.startsAt || scheduledByDefault,
  );
  const [guests, setGuests] = useState(room?.allowGuests ?? true);
  const [waitingRoom, setWaitingRoom] = useState(
    room ? Boolean(room.waitingRoom) : true,
  );
  const localDate = room?.startsAt ? localDateTimeInput(room.startsAt) : "";
  const resetsAccess = Boolean(
    room &&
    ((waitingRoom && !room.waitingRoom) || (!guests && room.allowGuests)),
  );
  return (
    <Modal
      title={room ? "Изменить встречу" : "Новая встреча"}
      onClose={onClose}
    >
      <p className="modal-intro">
        Укажите название и параметры встречи. Ссылка будет доступна после
        создания.
      </p>
      <ErrorBox error={error} />
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          if (
            resetsAccess &&
            !confirm(
              "Изменить доступ к встрече? Текущие участники будут отключены. Для продолжения им потребуется войти заново с новыми правилами доступа.",
            )
          )
            return;
          const data = new FormData(e.currentTarget);
          setError("");
          setBusy(true);
          try {
            const {
              room: saved,
              accessReset,
              mediaPending,
            } = await api<{
              room: Room;
              accessReset?: boolean;
              mediaPending?: boolean;
            }>(
              `/workspaces/${workspace.id}/rooms${room ? "/" + room.id : ""}`,
              {
                title: data.get("title"),
                description: data.get("description"),
                startsAt: scheduled
                  ? parseLocalMeetingStart(
                      data.get("startsAt") as string,
                      room?.startsAt,
                    )
                  : null,
                durationMinutes: Number(data.get("durationMinutes")),
                maxParticipants: Number(data.get("maxParticipants")),
                allowGuests: guests,
                waitingRoom,
              },
              room ? "PATCH" : "POST",
            );
            onSaved(saved, { accessReset, mediaPending });
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
          <>
            <Field label="Начало встречи">
              <input
                type="datetime-local"
                name="startsAt"
                defaultValue={localDate}
                required
                aria-describedby="meeting-local-timezone"
              />
            </Field>
            <p className="schedule-timezone-note" id="meeting-local-timezone">
              Дата и время на вашем устройстве: {localTimeZone()}. В календаре
              встреча появится в часовом поясе получателя.
            </p>
          </>
        )}
        <div className="form-columns">
          <Field label="Длительность">
            <select
              name="durationMinutes"
              defaultValue={room?.durationMinutes ?? 60}
            >
              {Array.from(
                new Set([
                  room?.durationMinutes ?? 60,
                  15,
                  30,
                  45,
                  60,
                  90,
                  120,
                  180,
                  240,
                ]),
              )
                .sort((a, b) => a - b)
                .map((n) => (
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
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={waitingRoom}
            onChange={(e) => setWaitingRoom(e.target.checked)}
          />
          <span>
            Зал ожидания
            <small>Организатор разрешает вход участников и гостей</small>
          </span>
        </label>
        {resetsAccess && (
          <p className="form-note">
            Сохранение этих настроек прервет текущие подключения. Участникам
            потребуется войти заново.
          </p>
        )}
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
  canManage,
}: {
  room: Room;
  workspace: Workspace;
  onClose: () => void;
  onUpdate: (r: Room) => void;
  notify: (s: string, e?: boolean) => void;
  canManage: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title="Пригласить на встречу" onClose={onClose}>
      <div className="share-room-title">
        <div className="stat-icon">
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
      {room.startsAt && (
        <div className="share-schedule">
          <p>
            <Clock3 size={14} aria-hidden="true" />
            <time dateTime={room.startsAt}>
              {localMeetingDateTime(room.startsAt)}
            </time>
            <span>· {room.durationMinutes} мин</span>
          </p>
          <CalendarExport room={room} notify={notify} />
          <small>
            Скачайте файл и откройте его в приложении календаря. Изменения
            встречи не обновляют сохраненное событие автоматически.
          </small>
        </div>
      )}
      <p className="form-note">
        {room.allowGuests
          ? room.waitingRoom
            ? "Человек с этой ссылкой сможет запросить вход. Организатор разрешит или отклонит его запрос."
            : "Любой человек с этой ссылкой сможет войти, указав свое имя."
          : "Отправьте ссылку коллегам, которые состоят в вашем пространстве."}
      </p>
      <ErrorBox error={error} />
      <div className="modal-actions">
        {canManage && room.status === "open" && (
          <Button
            className="text-button"
            busy={busy}
            onClick={async () => {
              if (
                !confirm(
                  "Заменить ссылку? Предыдущая ссылка перестанет работать, текущие участники будут отключены. Для продолжения им потребуется новая ссылка.",
                )
              )
                return;
              setBusy(true);
              try {
                const { room: newRoom, mediaPending } = await api<{
                  room: Room;
                  mediaPending?: boolean;
                }>(
                  `/workspaces/${workspace.id}/rooms/${room.id}/rotate-link`,
                  {},
                );
                onUpdate(newRoom);
                notify(
                  mediaPending
                    ? "Ссылка заменена. Отключение прежних подключений еще выполняется."
                    : "Создана новая ссылка. Передайте ее участникам.",
                );
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Заменить ссылку
          </Button>
        )}
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
  const [query, setQuery] = useState(
    () => new URLSearchParams(location.search).get("q") ?? "",
  );
  const [filter, setFilter] = useState(() =>
    new URLSearchParams(location.search).has("q") ? "all" : "open",
  );
  const [editor, setEditor] = useState<Room | true>();
  const [sharing, setSharing] = useState<Room>();
  const [historyRoom, setHistoryRoom] = useState<Room>();
  const [busy, setBusy] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const listVersion = useRef(0);
  const load = useCallback(
    async (before?: string) => {
      const version = ++listVersion.current;
      if (before) setLoadingMore(true);
      const queryString = new URLSearchParams({
        view: filter,
        ...(query ? { q: query } : {}),
        ...(before ? { before } : {}),
      });
      try {
        const response = await api<{
          rooms: Room[];
          nextCursor?: string | null;
        }>(`/workspaces/${workspace.id}/rooms?${queryString}`);
        if (version !== listVersion.current) return;
        setRooms((previous) =>
          before ? [...(previous ?? []), ...response.rooms] : response.rooms,
        );
        setNextCursor(response.nextCursor ?? null);
        setError("");
      } catch (e) {
        if (version === listVersion.current) setError((e as Error).message);
      } finally {
        if (version === listVersion.current) setLoadingMore(false);
      }
    },
    [workspace.id, filter, query],
  );
  useEffect(() => {
    setRooms(undefined);
    setNextCursor(null);
    const timer = setTimeout(() => void load(), 150);
    return () => {
      clearTimeout(timer);
      listVersion.current++;
    };
  }, [load]);
  useEffect(() => {
    const updateFromLocation = () => {
      const params = new URLSearchParams(location.search);
      setQuery(params.get("q") ?? "");
      if (params.has("q")) setFilter("all");
      if (params.get("new") === "1") {
        setEditor(true);
        params.delete("new");
        history.replaceState(
          {},
          "",
          `/rooms${params.size ? `?${params}` : ""}`,
        );
      }
    };
    updateFromLocation();
    addEventListener("popstate", updateFromLocation);
    return () => removeEventListener("popstate", updateFromLocation);
  }, []);
  const visible = rooms;
  const canManage = (r: Room) =>
    workspace.role !== "member" || r.createdBy === user.id;
  return (
    <>
      <PageHeading
        eyebrow="МЕСТО ДЛЯ РАЗГОВОРА"
        title="Встречи"
        text="В лимит тарифа входят только открытые комнаты. Завершенные встречи и архив сохраняют историю и записи."
      >
        <Button className="primary" onClick={() => setEditor(true)}>
          <Plus size={18} />
          Новая встреча
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
      <Button onClick={() => void load()}>Обновить список</Button>
      <div className="panel">
        <div className="list-toolbar">
          <div className="tabs">
            {[
              ["open", "Открытые"],
              ["closed", "Завершенные"],
              ["archived", "Архив"],
              ["all", "Все встречи"],
            ].map(([value, label]) => (
              <button
                key={value}
                onClick={() => setFilter(value)}
                className={filter === value ? "selected" : ""}
                aria-pressed={filter === value}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="search-field">
            <Search size={17} />
            <input
              placeholder="Найти встречу"
              aria-label="Найти встречу"
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
                      {room.archivedAt
                        ? "В архиве"
                        : room.status === "open"
                          ? "Открыта"
                          : "Завершена"}
                    </span>
                  </div>
                  {room.description && (
                    <p className="room-description">{room.description}</p>
                  )}
                  <div className="room-meta">
                    <span>
                      <CalendarDays size={14} />
                      {room.startsAt ? (
                        <time dateTime={room.startsAt}>
                          {localMeetingDateTime(room.startsAt)}
                        </time>
                      ) : (
                        "Без расписания"
                      )}
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
                    {(room.waitingRoom) && (
                      <span>
                        <ShieldCheck size={14} />
                        Зал ожидания
                      </span>
                    )}
                    <span>
                      <Users size={14} />
                      До {room.maxParticipants}
                    </span>
                  </div>
                </div>
                <div className="row-actions">
                  <Button
                    className="icon-button"
                    title="История чата"
                    aria-label={`История чата: ${room.title}`}
                    onClick={() => setHistoryRoom(room)}
                  >
                    <MessageSquare size={18} />
                  </Button>
                  {room.status === "closed" && canManage(room) && (
                    <Button
                      busy={busy === room.id}
                      disabled={Boolean(busy)}
                      onClick={async () => {
                        setBusy(room.id);
                        try {
                          await api(
                            `/workspaces/${workspace.id}/rooms/${room.id}/${room.archivedAt ? "unarchive" : "archive"}`,
                            {},
                          );
                          await load();
                          notify(
                            room.archivedAt
                              ? "Встреча возвращена в завершенные"
                              : "Встреча в архиве. История и записи сохранены.",
                          );
                        } catch (e) {
                          notify((e as Error).message, true);
                        } finally {
                          setBusy("");
                        }
                      }}
                    >
                      {room.archivedAt ? "Вернуть из архива" : "В архив"}
                    </Button>
                  )}
                  {room.status === "open" && (
                    <>
                      <CalendarExport room={room} notify={notify} compact />
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
                      <Link
                        to={`/join/${room.slug}`}
                        className="button primary small"
                        title={`Войти: ${room.title}`}
                      >
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
        ) : error ? (
          <Empty
            icon={Video}
            title="Не удалось загрузить встречи"
            text="Повторите запрос."
            action={<Button onClick={() => void load()}>Повторить</Button>}
          />
        ) : (
          <Empty
            icon={query ? Search : Video}
            title={
              query
                ? "Ничего не найдено"
                : filter === "archived"
                  ? "Архив пока пуст"
                  : filter === "closed"
                    ? "Завершенных встреч пока нет"
                    : "Встреч пока нет"
            }
            text={
              query
                ? "Попробуйте другое название комнаты."
                : "Создайте встречу и отправьте участникам ссылку."
            }
            action={
              !query && !["closed", "archived"].includes(filter) ? (
                <Button className="primary" onClick={() => setEditor(true)}>
                  <Plus size={17} />
                  Новая встреча
                </Button>
              ) : undefined
            }
          />
        )}
        {nextCursor && (
          <Button busy={loadingMore} onClick={() => void load(nextCursor)}>
            Показать еще
          </Button>
        )}
      </div>
      {editor && (
        <RoomEditor
          workspace={workspace}
          room={editor === true ? undefined : editor}
          onClose={() => setEditor(undefined)}
          onSaved={(_room, access) => {
            setEditor(undefined);
            void load();
            notify(
              access?.mediaPending
                ? "Доступ обновлен. Отключение прежних подключений еще выполняется."
                : access?.accessReset
                  ? "Доступ обновлен. Участникам потребуется войти заново."
                  : editor === true
                    ? "Комната создана"
                    : "Изменения сохранены",
            );
          }}
        />
      )}
      {historyRoom && (
        <ChatHistory
          workspace={workspace}
          room={historyRoom}
          onClose={() => setHistoryRoom(undefined)}
        />
      )}
      {sharing && (
        <ShareRoom
          room={sharing}
          canManage={canManage(sharing)}
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
