import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  LogOut,
  Mic,
  ShieldCheck,
  Users,
  Video,
} from "lucide-react";
import { api } from "../api";
import type { Config, User, Workspace } from "../api";
import { Brand, Button, ErrorBox, Field, Link, go } from "../ui";
import type { Session } from "../ui";
export function Auth({
  path,
  config,
  session,
  onSession,
  notify,
}: {
  path: string;
  config: Config;
  session: Session | null;
  onSession: () => Promise<Session>;
  notify: (s: string, e?: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [email, setEmail] = useState(session?.user.email ?? "");
  const isRegister = path === "/register",
    isForgot = path === "/forgot-password",
    isReset = path === "/reset-password",
    isVerify = path === "/verify-email";
  useEffect(() => {
    setError("");
    setSuccess("");
  }, [path]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const values = new FormData(e.currentTarget);
    try {
      if (isForgot) {
        await api("/auth/request-password-reset", {
          email,
          redirectTo: `${location.origin}/reset-password`,
        });
        setSuccess(
          "Если аккаунт с таким адресом существует, мы отправили письмо со ссылкой для восстановления.",
        );
      } else if (isReset) {
        const token = new URLSearchParams(location.search).get("token");
        if (!token)
          throw new Error(
            "В ссылке нет токена восстановления. Запросите новое письмо.",
          );
        await api("/auth/reset-password", {
          newPassword: values.get("password"),
          token,
        });
        setSuccess("Пароль изменен. Теперь вы можете войти в аккаунт.");
      } else if (isVerify) {
        await api("/auth/send-verification-email", {
          email,
          callbackURL: location.origin + "/verify-email?success=1",
        });
        setSuccess(
          "Письмо отправлено. Откройте ссылку в почте, затем вернитесь сюда.",
        );
      } else if (isRegister) {
        if (!config.registrationEnabled)
          throw new Error("Регистрация пока недоступна.");
        await api("/auth/sign-up/email", {
          name: values.get("name"),
          email,
          password: values.get("password"),
          callbackURL: location.origin + "/verify-email?success=1",
        });
        try {
          await onSession();
          const next = sessionStorage.getItem("imon.returnTo") ?? "/";
          sessionStorage.removeItem("imon.returnTo");
          go(next);
        } catch {
          setSuccess(
            "Аккаунт создан. Подтвердите адрес по ссылке в письме, затем войдите.",
          );
        }
      } else {
        await api("/auth/sign-in/email", {
          email,
          password: values.get("password"),
        });
        await onSession();
        const next = sessionStorage.getItem("imon.returnTo") ?? "/";
        sessionStorage.removeItem("imon.returnTo");
        go(next);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const title = isRegister
    ? "Давайте познакомимся"
    : isForgot
      ? "Восстановить доступ"
      : isReset
        ? "Новый пароль"
        : isVerify
          ? "Подтвердите вашу почту"
          : "Рады видеть вас снова";
  return (
    <div className="auth-layout">
      <div className="auth-story">
        <Brand light />
        <div className="story-main">
          <div className="eyebrow">
            <span className="status-dot" /> IMON MEETS
          </div>
          <h1>
            Ближе к команде.
            <br />
            <span>Ближе к делу.</span>
          </h1>
          <p>
            Пространство для разговоров,
            <br />
            из которых рождаются хорошие идеи.
          </p>
          <div className="story-art" aria-hidden="true">
            <div className="art-orbit orbit-one" />
            <div className="art-orbit orbit-two" />
            <div className="art-core">
              <Video size={51} />
            </div>
            <div className="art-chip chip-one">
              <Mic size={19} />
              <span>На одной волне</span>
            </div>
            <div className="art-chip chip-two">
              <span className="status-dot" />
              Связь начинается здесь
            </div>
          </div>
        </div>
        <div className="auth-story-footer">
          Видео. Голос. Совместная работа.
        </div>
      </div>
      <div className="auth-form-side">
        <div className="auth-mobile-brand">
          <Brand />
        </div>
        <div className="auth-card">
          <span className="eyebrow">ВАШЕ РАБОЧЕЕ ПРОСТРАНСТВО</span>
          <h1>{title}</h1>
          <p>
            {isRegister
              ? "Создайте аккаунт и пригласите вашу команду."
              : isForgot
                ? "Отправим ссылку для смены пароля на вашу почту."
                : isReset
                  ? "Придумайте надежный пароль от 10 символов."
                  : isVerify
                    ? "Подтвержденный адрес нужен для приглашений и безопасной работы."
                    : "Войдите, чтобы продолжить разговор."}
          </p>
          {new URLSearchParams(location.search).get("success") && isVerify && (
            <div className="success-box">
              Адрес подтвержден. Обновите данные аккаунта или войдите.
            </div>
          )}
          <ErrorBox error={error} />
          {success ? (
            <div className="success-box">
              <CheckCircle2 size={21} />
              <span>{success}</span>
            </div>
          ) : (
            <form onSubmit={submit}>
              {isRegister && (
                <Field label="Ваше имя">
                  <input
                    name="name"
                    required
                    maxLength={100}
                    autoComplete="name"
                    placeholder="Как к вам обращаться"
                  />
                </Field>
              )}
              {!isReset && (
                <Field label="Рабочая почта">
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    placeholder="name@company.ru"
                  />
                </Field>
              )}
              {!isForgot && !isVerify && (
                <Field
                  label={isReset ? "Новый пароль" : "Пароль"}
                  hint={isRegister ? "Не менее 10 символов" : undefined}
                >
                  <input
                    type="password"
                    name="password"
                    required
                    minLength={isRegister || isReset ? 10 : undefined}
                    maxLength={128}
                    autoComplete={
                      isRegister || isReset
                        ? "new-password"
                        : "current-password"
                    }
                    placeholder="Введите пароль"
                  />
                </Field>
              )}
              {!isRegister && !isForgot && !isReset && !isVerify && (
                <div className="forgot-link">
                  <Link to="/forgot-password">Забыли пароль?</Link>
                </div>
              )}
              <Button
                type="submit"
                busy={busy}
                className="primary full"
                disabled={
                  (isRegister && !config.registrationEnabled) ||
                  ((isForgot || isVerify) && !config.emailConfigured)
                }
              >
                {isRegister
                  ? "Создать аккаунт"
                  : isForgot
                    ? "Отправить ссылку"
                    : isReset
                      ? "Сохранить пароль"
                      : isVerify
                        ? "Отправить письмо"
                        : "Войти в пространство"}
                <ArrowRight size={18} />
              </Button>
              {(isForgot || isVerify) && !config.emailConfigured && (
                <p className="form-note">
                  Почтовый сервис пока не настроен. Обратитесь к администратору.
                </p>
              )}
            </form>
          )}
          {isVerify && session && (
            <Button
              className="full"
              busy={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onSession();
                  notify("Данные аккаунта обновлены");
                  go(sessionStorage.getItem("imon.returnTo") ?? "/");
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Я подтвердил адрес
            </Button>
          )}
          <div className="auth-switch">
            {isRegister ? (
              <>
                Уже есть аккаунт? <Link to="/login">Войти</Link>
              </>
            ) : isForgot || isReset || isVerify ? (
              <Link to="/login">
                <ArrowLeft size={15} />
                Вернуться ко входу
              </Link>
            ) : (
              <>
                Впервые здесь? <Link to="/register">Создать аккаунт</Link>
              </>
            )}
          </div>
        </div>
        <div className="auth-bottom">
          <ShieldCheck size={15} />
          Ваши встречи. Ваша команда. Ваше пространство.
        </div>
      </div>
    </div>
  );
}

export function Onboarding({
  refresh,
  onWorkspace,
  user,
  logout,
}: {
  refresh: () => Promise<Session>;
  onWorkspace: (id: string) => void;
  user: User;
  logout: () => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="onboarding">
      <header>
        <Brand />
        <Button className="text-button" onClick={logout}>
          <LogOut size={17} />
          Выйти
        </Button>
      </header>
      <div className="onboarding-card">
        <div className="empty-icon">
          <Users size={28} />
        </div>
        <span className="eyebrow">НАЧАЛО БОЛЬШОЙ РАБОТЫ</span>
        <h1>{user.name.split(" ")[0]}, добро пожаловать.</h1>
        <p>
          Создайте пространство для вашей команды. Здесь будут ваши встречи,
          комнаты и записи.
        </p>
        <ErrorBox error={error} />
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const name = new FormData(e.currentTarget).get("name");
              const { workspace } = await api<{ workspace: Workspace }>(
                "/workspaces",
                { name },
              );
              await refresh();
              onWorkspace(workspace.id);
              go("/");
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Название пространства">
            <input
              name="name"
              autoFocus
              required
              minLength={2}
              maxLength={100}
              placeholder="Например, Дизайн-команда"
            />
          </Field>
          <Button type="submit" className="primary full" busy={busy}>
            Создать пространство
            <ArrowRight size={18} />
          </Button>
        </form>
        <div className="onboarding-foot">
          <ShieldCheck size={16} />
          Только вы решаете, кого пригласить.
        </div>
      </div>
    </div>
  );
}
