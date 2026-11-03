import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { Button, ErrorBox } from "../ui";

// A Google-only account must establish its own IMON Meets credential before a
// password-confirmed operation. The API still enforces every sensitive action.
export function PasswordGate({ children }: { children: ReactNode }) {
  const [security, setSecurity] = useState<{
    hasPassword: boolean;
    addPasswordAvailable: boolean;
  }>();
  const [error, setError] = useState("");
  const [requested, setRequested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ hasPassword: boolean; addPasswordAvailable: boolean }>(
      "/me/security",
      undefined,
      undefined,
      { signal: controller.signal },
    )
      .then((result) => {
        if (!controller.signal.aborted) setSecurity(result);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError((e as Error).message);
      });
    return () => controller.abort();
  }, [attempt]);
  if (security?.hasPassword) return <>{children}</>;
  return (
    <div
      className="password-enrollment"
      role="region"
      aria-label="Подтверждение доступа"
    >
      <ErrorBox error={error} />
      {!security ? (
        <>
          <p>
            {error
              ? "Не удалось проверить способ подтверждения."
              : "Проверяем способ подтверждения…"}
          </p>
          {error && (
            <Button
              onClick={() => {
                setError("");
                setAttempt((n) => n + 1);
              }}
            >
              Повторить проверку
            </Button>
          )}
        </>
      ) : (
        <>
          <h3>Добавьте пароль IMON Meets</h3>
          <p>
            В аккаунте пока нет пароля IMON Meets. Создайте отдельный пароль для
            подтверждения важных действий и управления двухфакторной защитой.
          </p>
          <p>
            Подтвердите добавление по ссылке на вашу почту в том же браузере и
            сеансе. Ссылка действует 15 минут. Вход через Google и включенная
            двухфакторная защита сохранятся.
          </p>
          {!security.addPasswordAvailable ? (
            <p className="form-note">
              Почта временно недоступна. Для добавления пароля обратитесь к
              администратору.
            </p>
          ) : requested ? (
            <p className="success-box" role="status">
              Запрос принят. Откройте письмо в том же браузере. После создания
              пароля войдите заново и повторите действие.
            </p>
          ) : (
            <Button
              className="primary"
              busy={busy}
              onClick={async () => {
                if (busy) return;
                setBusy(true);
                setError("");
                try {
                  await api("/me/password/request", {});
                  setRequested(true);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Получить ссылку для добавления пароля
            </Button>
          )}
        </>
      )}
    </div>
  );
}
