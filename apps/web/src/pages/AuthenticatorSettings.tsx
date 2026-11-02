import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  CheckCircle2,
  Copy,
  KeyRound,
  Link2,
  ShieldCheck,
} from "lucide-react";
import { api } from "../api";
import type { User } from "../api";
import { Button, ErrorBox, Field, Modal } from "../ui";
import type { Session } from "../ui";
import { downloadPrivateFile } from "./DataSettings";

export function AuthenticatorSettings({
  user,
  refresh,
  notify,
  googleEnabled = false,
}: {
  user: User;
  refresh: () => Promise<Session>;
  notify: (text: string, error?: boolean) => void;
  googleEnabled?: boolean;
}) {
  const [googleLinked, setGoogleLinked] = useState<boolean | null>(null);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [googleError, setGoogleError] = useState("");
  const [action, setAction] = useState<"enable" | "disable" | "codes">();
  const [setup, setSetup] = useState<{
    totpURI?: string;
    backupCodes: string[];
  }>();
  const [verified, setVerified] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [qrError, setQrError] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!googleEnabled || !user.emailVerified) return;
    let active = true;
    void api<Array<{ providerId?: string }>>("/auth/list-accounts")
      .then((accounts) => {
        if (active)
          setGoogleLinked(
            accounts.some((account) => account.providerId === "google"),
          );
      })
      .catch((e) => {
        if (active) {
          setGoogleLinked(false);
          setGoogleError((e as Error).message);
        }
      });
    return () => {
      active = false;
    };
  }, [googleEnabled, user.emailVerified]);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const callbackError = params.get("error");
    if (!callbackError) return;
    setGoogleError(
      callbackError === "access_denied"
        ? "Связывание Google отменено."
        : "Не удалось связать Google. Убедитесь, что выбран тот же адрес почты.",
    );
    params.delete("error");
    const query = params.toString();
    history.replaceState(
      history.state,
      "",
      `${location.pathname}${query ? `?${query}` : ""}${location.hash}`,
    );
  }, []);
  async function linkGoogle() {
    if (googleBusy || !googleEnabled || !user.emailVerified) return;
    setGoogleBusy(true);
    setGoogleError("");
    try {
      const result = await api<{ url?: string }>("/auth/link-social", {
        provider: "google",
        callbackURL: window.location.href,
        errorCallbackURL: window.location.href,
      });
      if (!result.url) throw new Error("Google не вернул адрес авторизации.");
      window.location.assign(result.url);
    } catch (e) {
      setGoogleError((e as Error).message);
      setGoogleBusy(false);
    }
  }
  useEffect(() => {
    if (!setup?.totpURI || verified || !canvas.current) return;
    let active = true;
    const target = canvas.current;
    void import("qrcode")
      .then(({ default: QRCode }) =>
        QRCode.toCanvas(target, setup.totpURI!, {
          width: 224,
          margin: 3,
          errorCorrectionLevel: "M",
          color: { dark: "#161b26", light: "#ffffff" },
        }),
      )
      .catch(() => {
        if (active) setQrError(true);
      });
    return () => {
      active = false;
    };
  }, [setup?.totpURI, verified]);
  const begin = (next: "enable" | "disable" | "codes") => {
    setAction(next);
    setSetup(undefined);
    setVerified(false);
    setSaved(false);
    setError("");
    setQrError(false);
  };
  const close = () => {
    if (busy || (verified && setup && !saved)) return;
    setAction(undefined);
    setSetup(undefined);
    setError("");
  };
  let manualSecret = "";
  try {
    manualSecret =
      new URL(setup?.totpURI ?? "").searchParams.get("secret") ?? "";
  } catch {
    /* Setup has not started. */
  }
  return (
    <>
      {googleEnabled && (
        <section className="data-section mfa-section google-account-section">
          <div className="mfa-heading">
            <h3>Аккаунт Google</h3>
            <span
              className={`workspace-status ${googleLinked ? "success" : "neutral"}`}
            >
              {googleLinked === null
                ? "Проверка"
                : googleLinked
                  ? "Подключен"
                  : "Не подключен"}
            </span>
          </div>
          <p>
            Связывание доступно только после входа в подтвержденный аккаунт IMON
            Meets. Адрес Google должен совпадать с адресом вашего аккаунта.
            Автоматического объединения аккаунтов нет.
          </p>
          {googleError && <ErrorBox error={googleError} />}
          {!user.emailVerified ? (
            <p className="form-note">
              Сначала подтвердите адрес почты IMON Meets.
            </p>
          ) : googleLinked ? (
            <p className="form-note">
              Вход через Google связан с этим аккаунтом.
            </p>
          ) : (
            <Button
              className="primary"
              busy={googleBusy}
              disabled={googleBusy || googleLinked === null}
              onClick={linkGoogle}
            >
              <Link2 size={17} />
              Привязать Google
            </Button>
          )}
        </section>
      )}
      <section className="data-section mfa-section">
        <div className="mfa-heading">
          <h3>Двухфакторная аутентификация</h3>
          <span
            className={`workspace-status ${user.twoFactorEnabled ? "success" : "neutral"}`}
          >
            {user.twoFactorEnabled ? "Включена" : "Не включена"}
          </span>
        </div>
        <p>
          Подтверждайте вход одноразовым кодом из приложения-аутентификатора.
          Резервные коды помогут войти при потере телефона.
        </p>
        {user.twoFactorEnabled ? (
          <div className="ownership-actions">
            <Button onClick={() => begin("codes")}>
              <KeyRound size={17} />
              Новые резервные коды
            </Button>
            <Button className="danger-quiet" onClick={() => begin("disable")}>
              Отключить второй фактор
            </Button>
          </div>
        ) : (
          <Button className="primary" onClick={() => begin("enable")}>
            <ShieldCheck size={17} />
            Настроить второй фактор
          </Button>
        )}
        {action && (
          <Modal
            title={
              action === "disable"
                ? "Отключить второй фактор?"
                : action === "codes"
                  ? "Резервные коды"
                  : "Настроить второй фактор"
            }
            onClose={close}
          >
            <p className="modal-intro">
              {action === "disable"
                ? "Для входа останется только пароль. Подтвердите изменение текущим паролем."
                : action === "codes"
                  ? "Создание новых резервных кодов отменит все предыдущие. Каждый код можно использовать один раз."
                  : "Добавьте IMON Meets в приложение-аутентификатор и подтвердите настройку шестизначным кодом."}
            </p>
            <ErrorBox error={error} focus />
            {!setup ? (
              <form
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (busy) return;
                  setBusy(true);
                  setError("");
                  const password = new FormData(event.currentTarget).get(
                    "password",
                  );
                  try {
                    if (action === "disable") {
                      await api("/auth/two-factor/disable", { password });
                      await refresh();
                      setAction(undefined);
                      notify("Второй фактор отключен");
                    } else if (action === "codes") {
                      const data = await api<{ backupCodes: string[] }>(
                        "/auth/two-factor/generate-backup-codes",
                        { password },
                      );
                      setSetup(data);
                      setVerified(true);
                    } else {
                      setSetup(
                        await api<{ totpURI: string; backupCodes: string[] }>(
                          "/auth/two-factor/enable",
                          { password, method: "totp" },
                        ),
                      );
                    }
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Field label="Текущий пароль">
                  <input
                    type="password"
                    name="password"
                    required
                    autoComplete="current-password"
                  />
                </Field>
                <div className="modal-actions">
                  <Button type="button" disabled={busy} onClick={close}>
                    Отмена
                  </Button>
                  <Button
                    type="submit"
                    className={action === "disable" ? "danger" : "primary"}
                    busy={busy}
                  >
                    {action === "disable"
                      ? "Отключить"
                      : action === "codes"
                        ? "Создать новые коды"
                        : "Продолжить"}
                  </Button>
                </div>
              </form>
            ) : !verified ? (
              <>
                <div className="mfa-qr">
                  <canvas
                    ref={canvas}
                    aria-label="QR-код для настройки приложения-аутентификатора"
                    role="img"
                  />
                </div>
                {qrError && (
                  <p className="form-note">
                    Не удалось показать QR-код. Добавьте аккаунт вручную с
                    помощью ключа ниже.
                  </p>
                )}
                <Field
                  label="Ключ для ручного ввода"
                  hint="В приложении выберите код на основе времени (TOTP)."
                >
                  <div className="copy-field">
                    <input
                      value={manualSecret}
                      readOnly
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <Button
                      type="button"
                      aria-label="Скопировать ключ настройки"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(manualSecret);
                          notify("Ключ скопирован");
                        } catch {
                          setError("Выделите ключ и скопируйте вручную.");
                        }
                      }}
                    >
                      <Copy size={17} />
                    </Button>
                  </div>
                </Field>
                <p className="form-note">
                  QR-код создается в вашем браузере. Не передавайте этот ключ
                  другим людям.
                </p>
                <form
                  onSubmit={async (event) => {
                    event.preventDefault();
                    if (busy) return;
                    setBusy(true);
                    setError("");
                    try {
                      await api("/auth/two-factor/verify-totp", {
                        code: new FormData(event.currentTarget).get("code"),
                        trustDevice: false,
                      });
                      await refresh();
                      setVerified(true);
                      notify("Двухфакторная аутентификация включена");
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <Field label="Код из приложения">
                    <input
                      name="code"
                      inputMode="numeric"
                      pattern="[0-9]{6}"
                      maxLength={6}
                      autoComplete="one-time-code"
                      required
                      placeholder="000000"
                    />
                  </Field>
                  <div className="modal-actions">
                    <Button type="button" disabled={busy} onClick={close}>
                      Настроить позже
                    </Button>
                    <Button type="submit" className="primary" busy={busy}>
                      Подтвердить код
                    </Button>
                  </div>
                </form>
              </>
            ) : (
              <>
                <div className="workspace-confirmation">
                  <CheckCircle2 size={20} />
                  <span>
                    {action === "codes"
                      ? "Новые резервные коды созданы"
                      : "Второй фактор включен"}
                  </span>
                </div>
                <p className="form-note">
                  Сохраните коды в надежном месте. Они показываются только
                  сейчас и дают доступ к аккаунту.
                </p>
                <div className="backup-code-list" aria-label="Резервные коды">
                  {setup.backupCodes.map((code) => (
                    <code key={code}>{code}</code>
                  ))}
                </div>
                <Button
                  onClick={() =>
                    downloadPrivateFile(
                      {
                        service: "IMON Meets",
                        email: user.email,
                        backupCodes: setup.backupCodes,
                      },
                      "imonmeets-recovery-codes.json",
                    )
                  }
                >
                  <ArrowDownToLine size={17} />
                  Скачать коды
                </Button>
                <Button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(
                        setup.backupCodes.join("\n"),
                      );
                      notify("Резервные коды скопированы");
                    } catch {
                      setError(
                        "Не удалось скопировать коды. Скачайте файл или выделите их вручную.",
                      );
                    }
                  }}
                >
                  <Copy size={17} />
                  Скопировать коды
                </Button>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={saved}
                    onChange={(event) => setSaved(event.target.checked)}
                  />
                  <span>Я сохранил резервные коды</span>
                </label>
                <div className="modal-actions">
                  <Button className="primary" disabled={!saved} onClick={close}>
                    Готово
                  </Button>
                </div>
              </>
            )}
          </Modal>
        )}
      </section>
    </>
  );
}
