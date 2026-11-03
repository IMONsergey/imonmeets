import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type {
  LegalConsentStatus,
  LegalDocument,
  LegalDocuments,
  User,
} from "../api";
import { Button, ErrorBox, Link, Spinner } from "../ui";
import { PublicFrame } from "./Public";
import { DataSettings } from "./DataSettings";

type Review = LegalConsentStatus & { documents: LegalDocuments | null };
function DocumentText({ document }: { document: LegalDocument }) {
  return (
    <details className="consent-document">
      <summary>{document.title}</summary>
      {document.sections.map((section, index) => (
        <section key={index}>
          <h3>{section.heading}</h3>
          {section.paragraphs.map((paragraph, paragraphIndex) => (
            <p key={paragraphIndex}>{paragraph}</p>
          ))}
        </section>
      ))}
    </details>
  );
}

export function LegalConsent({
  onAccepted,
  logout,
  hasWorkspace,
}: {
  onAccepted: () => Promise<void>;
  logout: () => Promise<void>;
  hasWorkspace: boolean;
}) {
  const [review, setReview] = useState<Review>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [terms, setTerms] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setReview(undefined);
    setTerms(false);
    setPrivacy(false);
    try {
      setReview(
        await api<Review>("/me/legal-consent", undefined, undefined, {
          signal,
        }),
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch((e) => {
      if (!controller.signal.aborted) setError((e as Error).message);
    });
    return () => controller.abort();
  }, [load]);
  const edition = review?.current;
  const documents = review?.documents;
  const ready = Boolean(
    edition &&
    documents &&
    edition.version === documents.version &&
    edition.publishedAt === documents.publishedAt,
  );
  async function accept(event: React.FormEvent) {
    event.preventDefault();
    if (busy || loading || !ready || !terms || !privacy || !edition) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{
        accepted: true;
        receipt: NonNullable<LegalConsentStatus["receipt"]>;
      }>("/me/legal-consent", {
        version: edition.version,
        manifestSha256: edition.manifestSha256,
        termsSha256: edition.termsSha256,
        privacySha256: edition.privacySha256,
        termsAccepted: true,
        privacyAcknowledged: true,
      });
      setReview(
        (old) => old && { ...old, accepted: true, receipt: result.receipt },
      );
      await onAccepted();
    } catch (e) {
      if (e instanceof ApiError && e.code === "LEGAL_VERSION_CHANGED") {
        setError(
          "Документы обновились. Прочитайте новую версию и отметьте свой выбор заново.",
        );
        await load().catch((error) => setError((error as Error).message));
      } else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <PublicFrame signedIn>
      <div className="public-document legal-consent">
        <h1>Документы и ваш выбор</h1>
        <p>
          Прочитайте опубликованные документы перед подтверждением. Просмотр
          страницы и вход в аккаунт не означают принятие условий.
        </p>
        <ErrorBox error={error} focus />
        {loading ? (
          <div role="status">
            <Spinner /> Загрузка документов
          </div>
        ) : !ready ? (
          <>
            <p>
              Утверждённые документы пока недоступны. Ваш выбор не сохранён.
            </p>
            <Button
              onClick={() => {
                setError("");
                void load().catch((e) => setError((e as Error).message));
              }}
            >
              Обновить документы
            </Button>
          </>
        ) : (
          <>
            <p className="public-document-version">
              Версия {edition!.version} · опубликована{" "}
              {new Intl.DateTimeFormat("ru-RU", { dateStyle: "long" }).format(
                new Date(edition!.publishedAt),
              )}
            </p>
            <p>
              {documents!.operator.name} · {documents!.operator.registration}
              <br />
              {documents!.operator.address}
            </p>
            <DocumentText document={documents!.terms} />
            <DocumentText document={documents!.privacy} />
            {review!.accepted ? (
              <div className="consent-receipt" role="status">
                <p>
                  Ваш выбор для этой версии сохранён{" "}
                  {new Intl.DateTimeFormat("ru-RU", {
                    dateStyle: "long",
                    timeStyle: "short",
                  }).format(new Date(review!.receipt!.acceptedAt))}
                  .
                </p>
                <Button
                  onClick={() => {
                    void onAccepted().catch((e) =>
                      setError((e as Error).message),
                    );
                  }}
                >
                  Продолжить
                </Button>
              </div>
            ) : (
              <form onSubmit={accept} className="consent-form">
                <label>
                  <input
                    type="checkbox"
                    checked={terms}
                    required
                    disabled={busy}
                    onChange={(e) => setTerms(e.target.checked)}
                  />
                  <span>
                    Я прочитал(а) и принимаю Условия использования, версия{" "}
                    {edition!.version}.
                  </span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={privacy}
                    required
                    disabled={busy}
                    onChange={(e) => setPrivacy(e.target.checked)}
                  />
                  <span>
                    Я ознакомился(-лась) с Политикой обработки данных, версия{" "}
                    {edition!.version}.
                  </span>
                </label>
                <Button type="submit" disabled={!terms || !privacy} busy={busy}>
                  Подтвердить выбор и продолжить
                </Button>
              </form>
            )}
          </>
        )}
        <div className="consent-alternatives">
          <p>
            Вы можете выйти или перейти к экспорту и удалению своих данных без
            принятия новой версии.
          </p>
          <Link to="/settings?section=data" className="button">
            Мои данные и удаление аккаунта
          </Link>
          {hasWorkspace && (
            <Link to="/recordings" className="button">
              Остановить или удалить записи
            </Link>
          )}
          <Button
            disabled={busy}
            onClick={() => {
              void logout().catch((e) => setError((e as Error).message));
            }}
          >
            Не принимать и выйти
          </Button>
        </div>
      </div>
    </PublicFrame>
  );
}

/** Personal privacy controls must not require creating a workspace first. */
export function PersonalDataPage({
  user,
  notify,
}: {
  user: User;
  notify: (text: string, error?: boolean) => void;
}) {
  return (
    <PublicFrame signedIn>
      <div className="public-document">
        <h1>Мои данные</h1>
        <DataSettings user={user} notify={notify} />
        <p>
          <Link to="/consent">Документы и ваш выбор</Link>
        </p>
      </div>
    </PublicFrame>
  );
}
