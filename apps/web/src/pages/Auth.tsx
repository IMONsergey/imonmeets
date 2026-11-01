import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { ArrowLeft, ArrowRight, CheckCircle2, LogOut } from "lucide-react";
import {
  api,
  ApiError,
  authCallbackURL,
  getReturnTo,
  takeReturnTo,
} from "../api";
import type { Config, User, Workspace } from "../api";
import { Brand, Button, ErrorBox, Field, Link, go } from "../ui";
import type { Session } from "../ui";
import { DataSettings } from "./DataSettings";
import { AuthenticatorSettings } from "./AuthenticatorSettings";
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
  const [needsVerification, setNeedsVerification] = useState(false);
  const [twoFactor, setTwoFactor] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState(false);
  const [email, setEmail] = useState(session?.user.email ?? "");
  const [confirmed, setConfirmed] = useState(
    Boolean(session?.user.emailVerified),
  );
  const isRegister = path === "/register",
    isForgot = path === "/forgot-password",
    isReset = path === "/reset-password",
    isVerify = path === "/verify-email";
  const reviewMode =
    config.emailDelivery === "capture" && !config.registrationEnabled;
  const registrationClosed = isRegister && !config.registrationEnabled;
  const emailRequestUnavailable =
    (isForgot || isVerify) && (reviewMode || !config.emailConfigured);
  useEffect(() => {
    setError("");
    setSuccess("");
    setNeedsVerification(false);
    setTwoFactor(false);
    setRecoveryCode(false);
    getReturnTo();
  }, [path]);
  useEffect(() => {
    if (!isVerify) return;
    let active = true;
    void onSession()
      .then((result) => {
        if (!active) return;
        setConfirmed(result.user.emailVerified);
        setEmail(result.user.email);
      })
      .catch((error) => {
        if (!active) return;
        setConfirmed(false);
        if (
          !(error instanceof ApiError) ||
          (error.status !== 401 &&
            error.code !== "EMAIL_UNVERIFIED" &&
            error.code !== "REQUEST_ABORTED")
        )
          setError((error as Error).message);
      });
    return () => {
      active = false;
    };
  }, [isVerify, onSession, session?.user.id]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    if (emailRequestUnavailable) {
      setError(
        "Для восстановления доступа или подтверждения почты обратитесь к администратору.",
      );
      return;
    }
    setBusy(true);
    setError("");
    const values = new FormData(e.currentTarget);
    try {
      if (twoFactor) {
        await api(
          recoveryCode
            ? "/auth/two-factor/verify-backup-code"
            : "/auth/two-factor/verify-totp",
          { code: String(values.get("code") ?? "").trim(), trustDevice: false },
        );
        await onSession();
        go(takeReturnTo());
      } else if (isForgot) {
        await api("/auth/request-password-reset", {
          email,
          redirectTo: authCallbackURL("/reset-password"),
        });
        setSuccess(
          "Если аккаунт с таким адресом существует, мы отправили письмо со ссылкой для восстановления.",
        );
      } else if (isReset) {
        const token = new URLSearchParams(location.search).get("token");
        if (!token)
          throw new Error(
            reviewMode
              ? "Ссылка восстановления неполная. Обратитесь к администратору."
              : "В ссылке нет токена восстановления. Запросите новое письмо.",
          );
        await api("/auth/reset-password", {
          newPassword: values.get("password"),
          token,
        });
        setSuccess("Пароль изменен. Теперь вы можете войти в аккаунт.");
      } else if (isVerify) {
        await api("/auth/send-verification-email", {
          email,
          callbackURL: authCallbackURL(),
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
          callbackURL: authCallbackURL(),
        });
        try {
          await onSession();
          go(takeReturnTo());
        } catch (error) {
          if (
            error instanceof ApiError &&
            error.status !== 401 &&
            error.code !== "EMAIL_UNVERIFIED"
          )
            throw error;
          setSuccess(
            config.emailVerificationRequired
              ? "Аккаунт создан. Подтвердите адрес по ссылке в письме, затем войдите."
              : "Аккаунт создан. Войдите с вашим адресом почты и паролем.",
          );
        }
      } else {
        const result = await api<{ twoFactorRedirect?: boolean }>(
          "/auth/sign-in/email",
          {
            email,
            password: values.get("password"),
          },
        );
        if (result.twoFactorRedirect) {
          setTwoFactor(true);
          setRecoveryCode(false);
          return;
        }
        await onSession();
        go(takeReturnTo());
      }
    } catch (e) {
      if (
        e instanceof ApiError &&
        ["EMAIL_NOT_VERIFIED", "EMAIL_UNVERIFIED"].includes(e.code ?? "")
      ) {
        setNeedsVerification(true);
        setError("Подтвердите адрес почты, чтобы войти в аккаунт.");
      } else if (
        e instanceof ApiError &&
        e.code === "INVALID_EMAIL_OR_PASSWORD"
      ) {
        setError(
          "Неверный адрес почты или пароль. Проверьте данные и попробуйте снова.",
        );
      } else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const title = twoFactor
    ? recoveryCode
      ? "Резервный код"
      : "Подтвердите вход"
    : registrationClosed
      ? "Регистрация закрыта"
      : isRegister
        ? "Создать аккаунт"
        : isForgot
          ? "Восстановить доступ"
          : isReset
            ? "Новый пароль"
            : isVerify
              ? "Подтвердите вашу почту"
              : "Войти";
  return (
    <div className="auth-layout">
      <header className="auth-header">
        <Link to="/login" title="IMON Meets">
          <Brand />
        </Link>
      </header>
      <main className="auth-form-side">
        <div className="auth-card">
          {reviewMode && (
            <div className="review-access-note">
              <span className="review-badge">Версия для знакомства</span>
              <p>
                Вход через тестовый аккаунт. Доступ предоставит администратор.
              </p>
            </div>
          )}
          <h1>{title}</h1>
          <p>
            {twoFactor
              ? recoveryCode
                ? "Введите один из сохраненных резервных кодов. После входа этот код больше не будет действовать."
                : "Введите шестизначный код из приложения-аутентификатора."
              : registrationClosed
                ? "Новые аккаунты пока не создаются. Если у вас уже есть аккаунт, войдите."
                : isRegister
                  ? "Создайте аккаунт и пригласите вашу команду."
                  : isForgot
                    ? reviewMode
                      ? "В этой версии восстановить доступ можно через администратора."
                      : "Отправим ссылку для смены пароля на вашу почту."
                    : isReset
                      ? "Придумайте надежный пароль от 10 символов."
                      : isVerify
                        ? reviewMode
                          ? "Для подтверждения адреса обратитесь к администратору."
                          : "Подтвержденный адрес нужен для приглашений и безопасной работы."
                        : "Введите адрес почты и пароль вашего аккаунта."}
          </p>
          {confirmed && isVerify && (
            <div className="success-box">
              Адрес подтвержден. Обновите данные аккаунта или войдите.
            </div>
          )}
          <ErrorBox error={error} id="auth-form-error" focus />
          {needsVerification && (
            <p className="form-note">
              <Link to="/verify-email">
                Подтвердить почту или запросить новое письмо
              </Link>
            </p>
          )}
          {registrationClosed ? (
            <div className="registration-closed">
              <p>Нужен доступ? Обратитесь к администратору пространства.</p>
              <Link to="/login" className="button primary full">
                Перейти ко входу <ArrowRight size={18} />
              </Link>
            </div>
          ) : confirmed && isVerify ? (
            <Button className="primary full" onClick={() => go(takeReturnTo())}>
              Продолжить
            </Button>
          ) : success ? (
            <div className="success-box">
              <CheckCircle2 size={21} />
              <span>{success}</span>
            </div>
          ) : (
            <form
              onSubmit={submit}
              aria-describedby={error ? "auth-form-error" : undefined}
            >
              {twoFactor ? (
                <Field
                  label={recoveryCode ? "Резервный код" : "Код из приложения"}
                >
                  <input
                    key={recoveryCode ? "recovery" : "totp"}
                    name="code"
                    autoFocus
                    required
                    inputMode={recoveryCode ? "text" : "numeric"}
                    pattern={recoveryCode ? undefined : "[0-9]{6}"}
                    maxLength={recoveryCode ? 128 : 6}
                    autoComplete="one-time-code"
                    spellCheck={false}
                    placeholder={recoveryCode ? "Резервный код" : "000000"}
                  />
                </Field>
              ) : (
                isRegister && (
                  <Field label="Ваше имя">
                    <input
                      name="name"
                      required
                      maxLength={100}
                      autoComplete="name"
                      placeholder="Как к вам обращаться"
                    />
                  </Field>
                )
              )}
              {!isReset && !twoFactor && (
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
              {!isForgot && !isVerify && !twoFactor && (
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
              {!isRegister &&
                !isForgot &&
                !isReset &&
                !isVerify &&
                !twoFactor &&
                !reviewMode && (
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
                  emailRequestUnavailable
                }
                aria-describedby={
                  emailRequestUnavailable ? "auth-delivery-note" : undefined
                }
              >
                {twoFactor
                  ? "Подтвердить вход"
                  : isRegister
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
              {twoFactor && (
                <div className="mfa-login-options">
                  <Button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => {
                      setRecoveryCode((value) => !value);
                      setError("");
                    }}
                  >
                    {recoveryCode
                      ? "Использовать приложение"
                      : "Использовать резервный код"}
                  </Button>
                  <Button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => {
                      setTwoFactor(false);
                      setError("");
                    }}
                  >
                    Вернуться ко входу
                  </Button>
                </div>
              )}
              {emailRequestUnavailable && (
                <p className="form-note" id="auth-delivery-note">
                  {reviewMode
                    ? "Письма на внешнюю почту в этой версии не отправляются. Для восстановления доступа или подтверждения адреса обратитесь к администратору."
                    : "Почтовый сервис пока не настроен. Обратитесь к администратору."}
                </p>
              )}
            </form>
          )}
          {isVerify && !confirmed && (
            <Button
              className="full"
              busy={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const result = await onSession();
                  if (!result.user.emailVerified)
                    throw new Error(
                      "Адрес пока не подтвержден. Откройте ссылку из письма и повторите проверку.",
                    );
                  setConfirmed(true);
                  notify("Адрес почты подтвержден");
                  go(takeReturnTo());
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
          {!registrationClosed && !twoFactor && (
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
              ) : config.registrationEnabled ? (
                <>
                  Впервые здесь? <Link to="/register">Создать аккаунт</Link>
                </>
              ) : (
                <>
                  Регистрация новых аккаунтов сейчас закрыта.{" "}
                  <Link to="/register">Условия доступа</Link>
                </>
              )}
            </div>
          )}
        </div>
      </main>
      <footer className="auth-bottom">IMON Meets</footer>
    </div>
  );
}

export function Onboarding({
  refresh,
  onWorkspace,
  user,
  logout,
  notify,
}: {
  refresh: () => Promise<Session>;
  onWorkspace: (id: string) => void;
  user: User;
  logout: () => void;
  notify: (text: string, error?: boolean) => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  return (
    <div className="onboarding">
      <header>
        <Brand />
        <div className="onboarding-account">
          <span>{user.name}</span>
          <Button
            className="text-button"
            onClick={() => setAccountOpen((value) => !value)}
          >
            {accountOpen ? "Назад" : "Мой аккаунт"}
          </Button>
          <Button className="text-button" onClick={logout}>
            <LogOut size={17} />
            Выйти
          </Button>
        </div>
      </header>
      <div className="onboarding-card">
        {accountOpen ? (
          <>
            <DataSettings user={user} notify={notify} />
            <AuthenticatorSettings
              user={user}
              refresh={refresh}
              notify={notify}
            />
          </>
        ) : (
          <>
            <h1>Создать рабочее пространство</h1>
            <p>
              Создайте пространство для вашей команды. Здесь будут ваши встречи,
              комнаты и записи.
            </p>
            <ErrorBox error={error} id="workspace-form-error" focus />
            <form
              aria-describedby={error ? "workspace-form-error" : undefined}
              onSubmit={async (e) => {
                e.preventDefault();
                if (busy) return;
                setError("");
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
            <p className="onboarding-foot">
              Вы станете владельцем пространства и сможете пригласить
              участников.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
