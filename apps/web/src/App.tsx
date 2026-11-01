import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  CheckCircle2,
  Film,
  LayoutDashboard,
  LogOut,
  Mail,
  Menu,
  Settings,
  ShieldCheck,
  Users,
  Video,
  X,
} from "lucide-react";
import { api, ApiError, initials } from "./api";
import type { Config } from "./api";
import { Brand, Button, ErrorBox, Link, Spinner, go, roleLabel } from "./ui";
import type { Session } from "./ui";
import { Auth, Onboarding } from "./pages/Auth";
import { Dashboard, Rooms } from "./pages/Meetings";
import { AccountSettings, Invite, Recordings, Team } from "./pages/Workspace";
const Join = lazy(() =>
  import("./pages/Join").then((m) => ({ default: m.Join })),
);
type Toast = { text: string; error?: boolean };
const nav = [
  { path: "/", label: "Обзор", icon: LayoutDashboard },
  { path: "/rooms", label: "Комнаты", icon: Video },
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
  const [workspaceId, setWorkspaceId] = useState(
    localStorage.getItem("imon.workspace") ?? "",
  );
  const [mobileNav, setMobileNav] = useState(false);
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
      setMobileNav(false);
    };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
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
        <p>Подготавливаем ваше пространство</p>
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
        <aside className={`sidebar ${mobileNav ? "is-open" : ""}`}>
          <Link to="/" className="brand-link">
            <Brand light />
          </Link>
          <div className="workspace-switch">
            <span className="workspace-avatar">{initials(workspace.name)}</span>
            <div>
              <small>Рабочее пространство</small>
              <select
                aria-label="Рабочее пространство"
                value={workspace.id}
                onChange={(e) => setWorkspaceId(e.target.value)}
              >
                {session.workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </div>
            <ChevronDown size={14} />
          </div>
          <div className="nav-caption">РАБОЧЕЕ ПРОСТРАНСТВО</div>
          <nav aria-label="Главная навигация">
            {nav.map(({ path: p, label, icon: Icon }) => (
              <Link
                key={p}
                to={p}
                className={`nav-item ${path === p ? "active" : ""}`}
              >
                <Icon size={19} />
                <span>{label}</span>
                {path === p && <span className="nav-dot" />}
              </Link>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="sidebar-note">
              <span className="status-dot" />
              <span>Место, где мы ближе</span>
            </div>
            <div className="account">
              <div className="avatar">{initials(session.user.name)}</div>
              <div className="account-copy">
                <strong>{session.user.name}</strong>
                <span>{roleLabel[workspace.role]}</span>
              </div>
              <button
                className="icon-button"
                title="Выйти из аккаунта"
                aria-label="Выйти из аккаунта"
                onClick={logout}
              >
                <LogOut size={18} />
              </button>
            </div>
          </div>
        </aside>
        {mobileNav && (
          <div className="nav-shade" onClick={() => setMobileNav(false)} />
        )}
        <div className="app-main">
          <header className="topbar">
            <div className="breadcrumb">
              <button
                className="icon-button mobile-menu"
                onClick={() => setMobileNav(!mobileNav)}
                aria-label="Открыть меню"
              >
                <Menu size={22} />
              </button>
              <span>{workspace.name}</span>
              <ChevronRight size={14} />
              <strong>
                {nav.find((n) => n.path === path)?.label ?? "Обзор"}
              </strong>
            </div>
            <div className="topbar-right">
              {reviewMode ? (
                <span
                  className="review-badge"
                  title="Версия для знакомства с сервисом"
                >
                  Тестовый доступ
                </span>
              ) : (
                <span className="secure-label">
                  <ShieldCheck size={15} />
                  Ваше пространство для встреч
                </span>
              )}
              <Link
                to="/settings"
                className="top-avatar"
                title="Настройки аккаунта"
              >
                {initials(session.user.name)}
              </Link>
            </div>
          </header>
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
          <footer className="app-footer">
            <span>IMON Meets</span>
            <span>Хорошая работа начинается с разговора.</span>
          </footer>
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
