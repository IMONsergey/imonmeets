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
import {
  api,
  ApiError,
  initials,
  AUTH_CHANGED_EVENT,
  AUTH_STORAGE_KEY,
  parseJoinSlug,
  readLocalPreference,
  writeLocalPreference,
  rememberReturnTo,
  markAuthStateChanged,
  safeReturnTo,
} from "./api";
import type { Config } from "./api";
import { Brand, Button, ErrorBox, Link, Spinner, go } from "./ui";
import type { Session } from "./ui";
import { Auth, Onboarding } from "./pages/Auth";
import { LegalConsent, PersonalDataPage } from "./pages/LegalConsent";
import { Dashboard, Rooms } from "./pages/Meetings";
import { AccountSettings, Invite, Recordings, Team } from "./pages/Workspace";
import {
  HelpPage,
  LegalPage,
  NotFoundPage,
  PublicHome,
  publicPaths,
  publicTitles,
} from "./pages/Public";
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
  const sessionRequest = useRef(0);
  const refreshAbort = useRef<AbortController | null>(null);
  const refreshPending = useRef<Promise<Session> | null>(null);
  const [workspaceId, setWorkspaceId] = useState(
    () =>
      new URLSearchParams(location.search).get("workspace") ??
      readLocalPreference("imon.workspace") ??
      "",
  );
  const reviewMode =
    config?.emailDelivery === "capture" && config.registrationEnabled === false;
  const notify = useCallback(
    (text: string, error = false) => setToast({ text, error }),
    [],
  );
  const refresh = useCallback((): Promise<Session> => {
    if (refreshPending.current) return refreshPending.current;
    const requestId = ++sessionRequest.current;
    refreshAbort.current?.abort();
    const controller = new AbortController();
    refreshAbort.current = controller;
    const pending = (async () => {
      try {
        const result = await api<Session>("/me", undefined, undefined, {
          signal: controller.signal,
        });
        if (requestId === sessionRequest.current) setSession(result);
        return result;
      } catch (error) {
        if (
          requestId === sessionRequest.current &&
          error instanceof ApiError &&
          (error.status === 401 || error.code === "EMAIL_UNVERIFIED")
        )
          setSession(null);
        throw error;
      } finally {
        if (requestId === sessionRequest.current) refreshPending.current = null;
      }
    })();
    refreshPending.current = pending;
    return pending;
  }, []);
  useEffect(() => {
    const onPop = () => {
      setPath(location.pathname);
      const requestedWorkspace = new URLSearchParams(location.search).get(
        "workspace",
      );
      if (requestedWorkspace) setWorkspaceId(requestedWorkspace);
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
    const controller = new AbortController();
    const requestId = ++sessionRequest.current;
    Promise.all([
      api<Config>("/config", undefined, undefined, {
        signal: controller.signal,
      }),
      api<Session>("/me", undefined, undefined, {
        signal: controller.signal,
      }).catch((error) => {
        if (
          error instanceof ApiError &&
          (error.status === 401 || error.code === "EMAIL_UNVERIFIED")
        )
          return null;
        throw error;
      }),
    ])
      .then(([c, s]) => {
        if (active) {
          setConfig(c);
          if (requestId === sessionRequest.current) setSession(s);
        }
      })
      .catch((e) => active && setFatal(e.message))
      .finally(() => active && setBooting(false));
    return () => {
      active = false;
      controller.abort();
    };
  }, []);
  useEffect(() => {
    const invalidate = () => {
      markAuthStateChanged();
      sessionRequest.current++;
      refreshAbort.current?.abort();
      refreshPending.current = null;
      setSession(null);
    };
    const revalidate = () => {
      if (document.visibilityState === "hidden") return;
      void refresh().catch((error) => {
        if (
          error instanceof ApiError &&
          error.code !== "REQUEST_ABORTED" &&
          error.status !== 401 &&
          error.code !== "EMAIL_UNVERIFIED"
        )
          notify(
            "Не удалось обновить данные аккаунта. Проверьте подключение.",
            true,
          );
      });
    };
    const changed = (event: Event) => {
      const reason = (event as CustomEvent<{ reason?: string }>).detail?.reason;
      if (reason === "signed-out" || reason === "unauthorized") invalidate();
      else {
        sessionRequest.current++;
        refreshAbort.current?.abort();
        refreshPending.current = null;
        revalidate();
      }
    };
    const storage = (event: StorageEvent) => {
      if (event.key !== AUTH_STORAGE_KEY || !event.newValue) return;
      try {
        const reason = JSON.parse(event.newValue).reason;
        markAuthStateChanged();
        if (reason === "signed-out" || reason === "unauthorized") invalidate();
        else {
          sessionRequest.current++;
          refreshAbort.current?.abort();
          refreshPending.current = null;
          revalidate();
        }
      } catch {
        /* Ignore unrelated malformed storage events. */
      }
    };
    window.addEventListener(AUTH_CHANGED_EVENT, changed);
    window.addEventListener("storage", storage);
    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", revalidate);
    return () => {
      refreshAbort.current?.abort();
      window.removeEventListener(AUTH_CHANGED_EVENT, changed);
      window.removeEventListener("storage", storage);
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", revalidate);
    };
  }, [refresh, notify]);
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
      writeLocalPreference("imon.workspace", workspace.id);
      setWorkspaceId(workspace.id);
    }
  }, [workspace]);
  const authPath = [
    "/login",
    "/register",
    "/forgot-password",
    "/reset-password",
    "/set-password",
    "/verify-email",
  ].includes(path);
  const publicPath = publicPaths.includes(path) || (path === "/" && !session);
  const knownPath =
    publicPaths.includes(path) ||
    nav.some((item) => item.path === path) ||
    authPath ||
    path.startsWith("/join/") ||
    path === "/invite" ||
    path === "/consent";
  const needsConsent = Boolean(
    session &&
    (session.legalConsent?.required ??
      config?.publicInformation?.legalAcceptanceRequired) &&
    !session.legalConsent?.accepted,
  );
  useEffect(() => {
    const label =
      publicTitles[path] ??
      nav.find((item) => item.path === path)?.label ??
      (path.startsWith("/join/")
        ? "Встреча"
        : path === "/consent"
          ? "Документы и ваш выбор"
          : path === "/login"
            ? "Вход"
            : path === "/register"
              ? "Регистрация"
              : path === "/verify-email"
                ? "Подтверждение почты"
                : path === "/invite"
                  ? "Приглашение"
                  : knownPath
                    ? "Доступ к аккаунту"
                    : "Страница не найдена");
    document.title = `${label} | IMON Meets`;
    if (booting) return;
    const heading = document.querySelector<HTMLElement>("main h1");
    heading?.setAttribute("tabindex", "-1");
    heading?.focus({ preventScroll: true });
  }, [path, booting, workspace?.id, session?.user.id]);
  useEffect(() => {
    if (
      !booting &&
      !fatal &&
      !session &&
      !authPath &&
      !publicPath &&
      knownPath &&
      !path.startsWith("/join/") &&
      path !== "/invite"
    ) {
      rememberReturnTo(location.pathname + location.search + location.hash);
      go("/login");
    }
  }, [booting, session, path, authPath, publicPath, knownPath, fatal]);
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
  else if (!knownPath) content = <NotFoundPage signedIn={Boolean(session)} />;
  else if (publicPath)
    content =
      path === "/help" ? (
        <HelpPage config={config} signedIn={Boolean(session)} />
      ) : path === "/privacy" || path === "/terms" ? (
        <LegalPage
          key={path}
          kind={path.slice(1) as "privacy" | "terms"}
          config={config}
          signedIn={Boolean(session)}
        />
      ) : (
        <PublicHome config={config} signedIn={Boolean(session)} />
      );
  else if (
    session &&
    !authPath &&
    (path === "/consent" ||
      (needsConsent && path !== "/settings" && path !== "/recordings"))
  )
    content = (
      <LegalConsent
        key={session.user.id}
        logout={logout}
        hasWorkspace={Boolean(workspace)}
        onAccepted={async () => {
          await refresh();
          if (path === "/consent")
            go(
              safeReturnTo(
                new URLSearchParams(location.search).get("returnTo") ??
                  "/settings",
              ),
            );
        }}
      />
    );
  else if (session && !workspace && path === "/settings")
    content = <PersonalDataPage user={session.user} notify={notify} />;
  else if (path.startsWith("/join/") && !parseJoinSlug(path))
    content = (
      <div className="full-loader">
        <Brand />
        <h1>Неправильная ссылка на встречу</h1>
        <p>Проверьте ссылку или попросите организатора отправить ее заново.</p>
        <Link to="/" className="button primary">
          На главную
        </Link>
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
          slug={parseJoinSlug(path)!}
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
        notify={notify}
        googleEnabled={config.googleOAuthConfigured}
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
                <Link
                  to="/consent"
                  onClick={() => {
                    if (accountMenu.current) accountMenu.current.open = false;
                  }}
                >
                  Документы и ваш выбор
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
          <main
            className="main-content"
            key={`${session.user.id}:${workspace.id}:${path}`}
          >
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
            {needsConsent && (
              <div className="notice">
                <span>
                  Для новых действий в сервисе подтвердите выбор для
                  опубликованных документов. Управление данными доступно.
                </span>{" "}
                <Link to="/consent">Открыть документы</Link>
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
