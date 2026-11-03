import { useEffect, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  LockKeyhole,
  Mail,
  MessageCircle,
  Monitor,
  Users,
  Video,
} from "lucide-react";
import { api } from "../api";
import type { Config } from "../api";
import { Brand, ErrorBox, Link, Spinner } from "../ui";

export const publicPaths = ["/about", "/help", "/privacy", "/terms"];
export const publicTitles: Record<string, string> = {
  "/about": "О сервисе",
  "/help": "Помощь",
  "/privacy": "Конфиденциальность",
  "/terms": "Условия использования",
};

export function SupportContact({ config }: { config: Config }) {
  return config.publicInformation?.supportEmail ? (
    <div className="public-support-contact">
      <a href={`mailto:${config.publicInformation.supportEmail}`}>
        <Mail size={17} aria-hidden="true" />
        {config.publicInformation.supportEmail}
      </a>
      {config.publicInformation.supportHours && (
        <p>{config.publicInformation.supportHours}</p>
      )}
    </div>
  ) : (
    <p>
      Если вам прислали приглашение или ссылку на встречу, свяжитесь с
      организатором. Он поможет проверить доступ к пространству.
    </p>
  );
}

export function PublicFrame({
  children,
  signedIn = false,
}: {
  children: React.ReactNode;
  signedIn?: boolean;
}) {
  return (
    <div className="public-layout">
      <a className="public-skip" href="#public-main">
        Перейти к содержимому
      </a>
      <header className="public-header">
        <Link to="/" aria-label="IMON Meets, главная">
          <Brand />
        </Link>
        <nav aria-label="Информация о сервисе">
          <Link to="/about">О сервисе</Link>
          <Link to="/help">Помощь</Link>
          <Link to={signedIn ? "/rooms" : "/login"} className="button primary">
            {signedIn ? "Мои встречи" : "Войти"}
          </Link>
        </nav>
      </header>
      <main id="public-main" className="public-main">
        {children}
      </main>
      <footer className="public-footer">
        <span>IMON Meets</span>
        <nav aria-label="Документы и помощь">
          <Link to="/privacy">Конфиденциальность</Link>
          <Link to="/terms">Условия использования</Link>
          {signedIn && <Link to="/consent">Документы и ваш выбор</Link>}
          <Link to="/help">Помощь</Link>
        </nav>
      </footer>
    </div>
  );
}

export function PublicHome({
  config,
  signedIn,
}: {
  config: Config;
  signedIn: boolean;
}) {
  return (
    <PublicFrame signedIn={signedIn}>
      <section className="public-hero">
        <p className="public-eyebrow">Встречи вашей команды</p>
        <h1>Обсуждайте, показывайте, принимайте решения.</h1>
        <p className="public-lead">
          IMON Meets объединяет видеовстречи, демонстрацию экрана и чат в одном
          рабочем пространстве. Участники могут подключиться по ссылке в
          браузере.
        </p>
        <div className="public-actions">
          <Link
            to={
              signedIn
                ? "/rooms"
                : config.registrationEnabled
                  ? "/register"
                  : "/login"
            }
            className="button primary"
          >
            {signedIn
              ? "Перейти к встречам"
              : config.registrationEnabled
                ? "Создать аккаунт"
                : "Войти в аккаунт"}
            <ArrowRight size={18} aria-hidden="true" />
          </Link>
          <Link to="/help" className="button">
            Как подключиться
          </Link>
        </div>
        {!config.registrationEnabled && (
          <p className="public-access-note">
            Регистрация новых аккаунтов пока закрыта. Если у вас есть ссылка на
            встречу, откройте ее, чтобы проверить гостевой доступ.
          </p>
        )}
        {!config.mediaConfigured && (
          <p className="public-access-note" role="status">
            Видеовстречи временно недоступны. Доступ к аккаунту и данным
            сохраняется.
          </p>
        )}
      </section>
      <section className="public-feature-grid" aria-label="Возможности">
        <article>
          <Video aria-hidden="true" />
          <h2>Встреча в браузере</h2>
          <p>
            Выберите камеру и микрофон до входа. Демонстрируйте экран, когда
            нужно показать документ или обсудить работу.
          </p>
        </article>
        <article>
          <MessageCircle aria-hidden="true" />
          <h2>Общий контекст</h2>
          <p>
            Сообщения встречи сохраняются в рабочем пространстве. Завершенные
            встречи можно убрать в архив, сохранив историю.
          </p>
        </article>
        <article>
          <Users aria-hidden="true" />
          <h2>Понятный доступ</h2>
          <p>
            Организатор управляет гостевым доступом и залом ожидания. Настройки
            встречи определяют, кто сможет подключиться.
          </p>
        </article>
      </section>
      <section className="public-section">
        <h2>Подготовьте встречу за несколько шагов</h2>
        <ol className="public-steps">
          <li>
            <strong>Создайте пространство</strong>
            <p>
              Пригласите коллег и создайте встречу с нужными настройками
              доступа.
            </p>
          </li>
          <li>
            <strong>Отправьте ссылку</strong>
            <p>Участники откроют ее в браузере и проверят звук и камеру.</p>
          </li>
          <li>
            <strong>Проведите встречу</strong>
            <p>
              Используйте видео, экран и чат. История остается доступной
              команде.
            </p>
          </li>
        </ol>
      </section>
      {(config.recordingConfigured ||
        config.transcriptionConfigured ||
        config.summaryConfigured) && (
        <section className="public-section">
          <h2>После встречи</h2>
          <ul className="public-available">
            {config.recordingConfigured && (
              <li>
                <CheckCircle2 aria-hidden="true" />
                Запись с уведомлением участников и ограниченным сроком хранения.
              </li>
            )}
            {config.transcriptionConfigured && (
              <li>
                <CheckCircle2 aria-hidden="true" />
                Расшифровка готовой записи, которую нужно проверить перед
                использованием.
              </li>
            )}
            {config.summaryConfigured && (
              <li>
                <CheckCircle2 aria-hidden="true" />
                AI-резюме для последующей проверки человеком.
              </li>
            )}
          </ul>
          <p>
            Доступность и ограничения зависят от настроек пространства и
            действующего тарифа. Синхронный перевод пока не входит в доступные
            функции.
          </p>
        </section>
      )}
      <section className="public-section public-contact">
        <h2>Нужна помощь с доступом?</h2>
        <SupportContact config={config} />
      </section>
    </PublicFrame>
  );
}

export function HelpPage({
  config,
  signedIn,
}: {
  config: Config;
  signedIn: boolean;
}) {
  return (
    <PublicFrame signedIn={signedIn}>
      <div className="public-document">
        <p className="public-eyebrow">Помощь</p>
        <h1>Подключение и работа со встречами</h1>
        <section>
          <h2>
            <Video aria-hidden="true" /> Как войти во встречу
          </h2>
          <p>
            Откройте ссылку организатора. До подключения проверьте выбранные
            устройства и укажите имя. Если включен зал ожидания, дождитесь
            разрешения организатора. Для закрытой встречи потребуется аккаунт с
            доступом к пространству.
          </p>
        </section>
        <section>
          <h2>
            <Monitor aria-hidden="true" /> Не работают камера или микрофон
          </h2>
          <p>
            Проверьте разрешения сайта в адресной строке браузера и доступ
            приложения к устройствам в настройках операционной системы.
            Убедитесь, что выбрано нужное устройство. Закройте программы,
            которые могут его занимать, и повторно откройте встречу.
          </p>
          <p>
            Для устойчивой связи используйте актуальную версию браузера и
            стабильное соединение. Если корпоративная сеть ограничивает
            видеосвязь, попробуйте другую разрешенную сеть и сообщите
            организатору об ошибке.
          </p>
        </section>
        <section>
          <h2>
            <Users aria-hidden="true" /> Кто видит историю
          </h2>
          <p>
            Рабочее пространство предназначено для общей работы команды.
            Участники пространства имеют доступ к встречам, истории чата и
            доступным записям этого пространства. Зал ожидания управляет
            подключением к звонку и не делает историю приватной внутри команды.
          </p>
          <p>
            Для отдельного круга участников используйте отдельное пространство и
            проверьте его состав перед встречей. Гость по ссылке не получает
            доступ к списку всех встреч пространства.
          </p>
        </section>
        <section>
          <h2>
            <LockKeyhole aria-hidden="true" /> Как защитить аккаунт
          </h2>
          <p>
            В разделе «Настройки → Безопасность» подключите
            приложение-аутентификатор и сохраните резервные коды. Проверьте
            активные сеансы и завершите те, которыми не пользуетесь.
          </p>
        </section>
        <section>
          <h2>Запись и AI</h2>
          <p>
            Запись запускает участник с соответствующими правами, остальные
            участники видят уведомление. Доступность записи, расшифровки и
            AI-резюме отображается в настройках пространства. Проверяйте имена,
            числа и решения по исходной записи: автоматический текст может
            содержать ошибки.
          </p>
          <p>
            Перевод речи в реальном времени пока проходит разработку и не
            предоставляется как готовая функция.
          </p>
        </section>
        <section>
          <h2>Обратная связь</h2>
          <p>
            При обращении укажите время ошибки, браузер, действие перед ошибкой
            и ее текст. Не отправляйте пароль, резервные коды, токены входа или
            приватное содержимое встречи.
          </p>
          <SupportContact config={config} />
        </section>
      </div>
    </PublicFrame>
  );
}

type LegalResponse = {
  version: string;
  publishedAt: string;
  operator: { name: string; registration: string; address: string };
  document: {
    title: string;
    sections: Array<{ heading: string; paragraphs: string[] }>;
  };
};
export function LegalPage({
  kind,
  config,
  signedIn,
}: {
  kind: "privacy" | "terms";
  config: Config;
  signedIn: boolean;
}) {
  const [result, setResult] = useState<LegalResponse>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setResult(undefined);
    setError("");
    if (config.publicInformation?.legalVersion)
      void api<LegalResponse>(
        `/public-documents/${kind}`,
        undefined,
        undefined,
        { signal: controller.signal },
      )
        .then(setResult)
        .catch((e) => {
          if (!controller.signal.aborted) setError(e.message);
        });
    return () => controller.abort();
  }, [kind, config.publicInformation?.legalVersion]);
  return (
    <PublicFrame signedIn={signedIn}>
      <div className="public-document">
        <h1>{result?.document.title || publicTitles[`/${kind}`]}</h1>
        {!config.publicInformation?.legalVersion ? (
          <section>
            <p>
              Документ еще не опубликован. Публичные коммерческие продажи не
              открыты.
            </p>
            <p>
              По вопросам доступа и обработки данных обратитесь к организатору
              пространства или в поддержку.
            </p>
            <SupportContact config={config} />
          </section>
        ) : error ? (
          <ErrorBox error={error} />
        ) : !result ? (
          <Spinner />
        ) : (
          <>
            <p className="public-document-version">
              Версия {result.version} ·{" "}
              {new Date(result.publishedAt).toLocaleDateString("ru-RU", {
                timeZone: "UTC",
              })}
            </p>
            <p>
              {result.operator.name}. {result.operator.registration}.{" "}
              {result.operator.address}.
            </p>
            {result.document.sections.map((section, index) => (
              <section key={index}>
                <h2>{section.heading}</h2>
                {section.paragraphs.map((paragraph, i) => (
                  <p key={i}>{paragraph}</p>
                ))}
              </section>
            ))}
            <section>
              <h2>Контакт</h2>
              <SupportContact config={config} />
            </section>
          </>
        )}
      </div>
    </PublicFrame>
  );
}

export function NotFoundPage({ signedIn }: { signedIn: boolean }) {
  return (
    <PublicFrame signedIn={signedIn}>
      <section className="public-not-found">
        <p className="public-eyebrow">404</p>
        <h1>Страница не найдена</h1>
        <p>
          Возможно, ссылка устарела или адрес написан с ошибкой. Проверьте его
          или вернитесь к началу.
        </p>
        <Link to="/" className="button primary">
          На главную <ArrowRight size={18} aria-hidden="true" />
        </Link>
      </section>
    </PublicFrame>
  );
}
