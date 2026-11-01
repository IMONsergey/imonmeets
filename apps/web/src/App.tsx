import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import {
  ArrowRight,
  ChevronDown,
  CircleHelp,
  CheckCircle2,
  Film,
  Home,
  LogOut,
  Mail,
  Plus,
  Search,
  Settings,
  Users,
  Video,
  X,
} from "lucide-react";
import { api, ApiError, initials } from "./api";
import type { Config } from "./api";
import { Brand, Button, ErrorBox, Link, Spinner, go } from "./ui";
import type { Session } from "./ui";
import { Auth, Onboarding } from "./pages/Auth";
import { Dashboard, Rooms } from "./pages/Meetings";
import { AccountSettings, Invite, Recordings, Team } from "./pages/Workspace";
const Join = lazy(() =>
  import("./pages/Join").then((m) => ({ default: m.Join })),
);
type Toast = { text: string; error?: boolean };
const nav = [
  { path: "/", label: "Главная", icon: Home },
  { path: "/rooms", label: "Встречи", icon: Video },
  { path: "/recordings", label: "Записи", icon: Film },
  { path: "/team", label: "Команда", icon: Users },
  { path: "/settings", label: "Настройки", icon: Settings },
];
export default function App() {
  const [path, setPath] = useState(location.pathname);
  const [config, setConfig] = useState<Config>();
  const [session, setSession] = useState<Session | null>(null);
  const [booting, setBooting] = useState(true);
  const [fatal, setFatal] = useState("");
  const [toast, setToast] = useState<Toast>();
  const accountMenu = useRef<HTMLDetailsElement>(null);
  const [workspaceId, setWorkspaceId] = useState(
    localStorage.getItem("imon.workspace") ?? "",
  );
  const reviewMode =
    config?.emailDelivery === "capture" && config.registrationEnabled === false;
  const notify = useCallback(
    (text: string, error = false) => setToast({ text, error }),
    [],
  );
  const refresh = useCallback(async () => {
    const result = await api<Session>("/me");
    setSession(result);
    return result;
  }, []);
  useEffect(() => {
    const onPop = () => {
      setPath(location.pathname);
      if (accountMenu.current) accountMenu.current.open = false;
    };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (
        accountMenu.current &&
        event.target instanceof Node &&
        !accountMenu.current.contains(event.target)
      )
        accountMenu.current.open = false;
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && accountMenu.current?.open) {
        accountMenu.current.open = false;
        accountMenu.current.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeEscape);
    };
  }, []);
  useEffect(() => {
    let active = true;
    Promise.all([
      api<Config>("/config"),
      api<Session>("/me").catch((error) => {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }),
    ])
      .then(([c, s]) => {
        if (active) {
          setConfig(c);
          setSession(s);
        }
      })
      .catch((e) => active && setFatal(e.message))
      .finally(() => active && setBooting(false));
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(undefined), 5000);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  const workspace =
    session?.workspaces.find((w) => w.id === workspaceId) ??
    session?.workspaces[0];
  useEffect(() => {
    if (workspace) {
      localStorage.setItem("imon.workspace", workspace.id);
      setWorkspaceId(workspace.id);
    }
  }, [workspace]);
  const authPath = [
    "/login",
    "/register",
    "/forgot-password",
    "/reset-password",
    "/verify-email",
  ].includes(path);
  useEffect(() => {
    if (
      !booting &&
      !fatal &&
      !session &&
      !authPath &&
      !path.startsWith("/join/") &&
      path !== "/invite"
    ) {
      sessionStorage.setItem(
        "imon.returnTo",
        location.pathname + location.search + location.hash,
      );
      go("/login");
    }
  }, [booting, session, path, authPath, fatal]);
  async function logout() {
    try {
      await api("/auth/sign-out", {});
      setSession(null);
      go("/login");
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  let content: ReactNode;
  if (booting)
    content = (
      <div className="full-loader">
        <Brand />
        <Spinner />
        <p>Загрузка IMON Meets</p>
      </div>
    );
  else if (fatal || !config)
    content = (
      <div className="full-loader">
        <Brand />
        <ErrorBox error={fatal || "Сервис временно недоступен"} />
        <Button onClick={() => location.reload()}>Попробовать снова</Button>
      </div>
    );
  else if (path.startsWith("/join/"))
    content = (
      <Suspense
        fallback={
          <div className="full-loader">
            <Spinner />
          </div>
        }
      >
        <Join
          slug={decodeURIComponent(path.slice(6))}
          config={config}
          user={session?.user}
          notify={notify}
        />
      </Suspense>
    );
  else if (path === "/invite")
    content = (
      <Invite
        session={session}
        refresh={refresh}
        notify={notify}
        onWorkspace={setWorkspaceId}
      />
    );
  else if (authPath)
    content = (
      <Auth
        path={path}
        config={config}
        session={session}
        onSession={refresh}
        notify={notify}
      />
    );
  else if (!session)
    content = (
      <div className="full-loader">
        <Spinner />
      </div>
    );
  else if (!workspace)
    content = (
      <Onboarding
        refresh={refresh}
        onWorkspace={setWorkspaceId}
        user={session.user}
        logout={logout}
      />
    );
  else
    content = (
      <div className="app-layout">
        <header className="topbar">
          <Link to="/" className="brand-link" aria-label="IMON Meets, главная">
            <Brand />
          </Link>
          <form
            className="global-search"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              const query = String(
                new FormData(event.currentTarget).get("q") ?? "",
              ).trim();
              go(`/rooms${query ? `?q=${encodeURIComponent(query)}` : ""}`);
            }}
          >
            <Search size={17} aria-hidden="true" />
            <input
              name="q"
              aria-label="Поиск встреч"
              placeholder="Поиск встреч"
              autoComplete="off"
            />
            <button type="submit" aria-label="Найти встречи">
              <ArrowRight size={16} />
            </button>
          </form>
          <div className="topbar-right">
            <Link
              to="/rooms?new=1"
              className="icon-button topbar-create"
              title="Новая встреча"
              aria-label="Новая встреча"
            >
              <Plus size={21} />
            </Link>
            <div className="workspace-switch">
              <select
                aria-label="Рабочее пространство"
                value={workspace.id}
                onChange={(event) => setWorkspaceId(event.target.value)}
              >
                {session.workspaces.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={13} aria-hidden="true" />
            </div>
            {reviewMode && (
              <span
                className="review-badge"
                title="Версия для знакомства с сервисом"
              >
                Тестовый доступ
              </span>
            )}
            <details className="account-menu" ref={accountMenu}>
              <summary
                className="top-avatar"
                title={session.user.name}
                aria-label="Меню аккаунта"
              >
                {initials(session.user.name)}
                <span className="presence-dot" />
              </summary>
              <div className="account-popover">
                <div className="account-identity">
                  <strong>{session.user.name}</strong>
                  <span>{session.user.email}</span>
                </div>
                <Link
                  to="/settings"
                  onClick={() => {
                    if (accountMenu.current) accountMenu.current.open = false;
                  }}
                >
                  <Settings size={16} />
                  Настройки аккаунта
                </Link>
                <button onClick={logout}>
                  <LogOut size={16} />
                  Выйти из аккаунта
                </button>
              </div>
            </details>
          </div>
        </header>
        <aside className="sidebar">
          <nav aria-label="Главная навигация">
            {nav.map(({ path: itemPath, label, icon: Icon }) => (
              <Link
                key={itemPath}
                to={itemPath}
                className={`nav-item ${path === itemPath ? "active" : ""}`}
                aria-current={path === itemPath ? "page" : undefined}
                title={label}
              >
                <Icon size={21} strokeWidth={1.75} aria-hidden="true" />
                <span>{label}</span>
              </Link>
            ))}
          </nav>
        </aside>
        <div className="app-main">
          <main className="main-content" key={workspace.id}>
            {!session.user.emailVerified && (
              <div className="notice verification-notice">
                <Mail size={18} />
                <span>
                  {reviewMode
                    ? "Для подтверждения почты обратитесь к администратору."
                    : "Подтвердите почту, чтобы принимать приглашения команды."}
                </span>
                {!reviewMode && (
                  <Link to="/verify-email">
                    Подтвердить <ArrowRight size={14} />
                  </Link>
                )}
              </div>
            )}
            {path === "/rooms" ? (
              <Rooms
                workspace={workspace}
                user={session.user}
                config={config}
                notify={notify}
              />
            ) : path === "/recordings" ? (
              <Recordings
                workspace={workspace}
                config={config}
                notify={notify}
              />
            ) : path === "/team" ? (
              <Team workspace={workspace} user={session.user} notify={notify} />
            ) : path === "/settings" ? (
              <AccountSettings
                user={session.user}
                workspace={workspace}
                config={config}
                refresh={refresh}
                notify={notify}
              />
            ) : (
              <Dashboard
                workspace={workspace}
                user={session.user}
                config={config}
                notify={notify}
              />
            )}
          </main>
        </div>
      </div>
    );
  return (
    <>
      {content}
      {toast && (
        <div
          className={`toast ${toast.error ? "toast-error" : ""}`}
          role="status"
        >
          {toast.error ? <CircleHelp size={19} /> : <CheckCircle2 size={19} />}
          <span>{toast.text}</span>
          <button
            className="icon-button"
            onClick={() => setToast(undefined)}
            aria-label="Закрыть уведомление"
          >
            <X size={16} />
          </button>
        </div>
      )}
    </>
  );
}
