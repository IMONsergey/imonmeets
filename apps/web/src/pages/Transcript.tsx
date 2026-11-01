import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownToLine, FileText, Sparkles, Trash2 } from "lucide-react";
import { api, date } from "../api";
import type { Config, Recording, Workspace } from "../api";
import { Button, Empty, ErrorBox, Field, Modal, Spinner } from "../ui";

type TranscriptJob = {
  id: string;
  status: "queued" | "running" | "complete" | "failed";
  createdAt?: string;
  completedAt?: string | null;
  error?: string | null;
  language?: string;
  text?: string;
  segments?: { start: number; end: number; text: string }[];
  duration?: number;
  model?: string;
  summary?: string;
  summaryModel?: string;
};
const timecode = (seconds: number) => {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
};

export function Transcript({
  recording,
  workspace,
  config,
  onClose,
  notify,
}: {
  recording: Recording;
  workspace: Workspace;
  config: Config;
  onClose: () => void;
  notify: (text: string, error?: boolean) => void;
}) {
  const base = `/workspaces/${workspace.id}/recordings/${recording.id}/transcript`;
  const [job, setJob] = useState<TranscriptJob | null>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [language, setLanguage] = useState("auto");
  const [summary, setSummary] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const controller = useRef<AbortController | undefined>(undefined);
  const loading = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const load = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    const activeController = new AbortController();
    controller.current = activeController;
    const signal = activeController.signal;
    const requestGeneration = generation.current;
    try {
      const result = await api<{ job: TranscriptJob | null }>(
        base,
        undefined,
        undefined,
        { signal },
      );
      if (!signal.aborted && requestGeneration === generation.current) {
        setJob(result.job);
        setError("");
      }
    } catch (e) {
      if (!signal.aborted && requestGeneration === generation.current)
        setError((e as Error).message);
    } finally {
      if (controller.current === activeController) loading.current = false;
    }
  }, [base]);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      generation.current++;
      controller.current?.abort();
      controller.current = undefined;
      loading.current = false;
    };
  }, [load]);
  useEffect(() => {
    if (!job || !["queued", "running"].includes(job.status)) return;
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [job?.status, load]);
  const active = job?.status === "queued" || job?.status === "running";
  return (
    <Modal
      title="Расшифровка встречи"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className="modal-intro">
        {recording.roomTitle} · {date(recording.startedAt)}
      </p>
      <ErrorBox error={error} focus />
      {job === undefined && !error && <Spinner />}
      {active && (
        <div className="transcript-status" role="status">
          <Spinner />
          <div>
            <strong>
              {job.status === "queued" ? "Запись в очереди" : "Распознаем речь"}
            </strong>
            <p>
              Обработка выполняется на сервере IMON Meets. Можно закрыть окно и
              вернуться к результату позже.
            </p>
          </div>
        </div>
      )}
      {job?.status === "failed" && (
        <ErrorBox
          error={
            job.error || "Не удалось обработать запись. Попробуйте еще раз."
          }
        />
      )}
      {job === null && (
        <Empty
          icon={FileText}
          title="Расшифровка еще не создана"
          text={
            recording.canManage
              ? "Создайте текстовую версию готовой записи встречи."
              : "Создать расшифровку может организатор или администратор пространства."
          }
        />
      )}
      {(job === null || job?.status === "failed") &&
        recording.canManage &&
        config.transcriptionConfigured && (
          <form
            className="transcript-options"
            onSubmit={async (event) => {
              event.preventDefault();
              if (busy) return;
              generation.current++;
              controller.current?.abort();
              loading.current = false;
              setBusy(true);
              setError("");
              try {
                const result = await api<{ job: TranscriptJob }>(base, {
                  language,
                  summary: Boolean(config.summaryConfigured && summary),
                });
                if (mounted.current) {
                  if (result.job.status !== "complete") setJob(result.job);
                  await load();
                  notify("Запись передана на расшифровку");
                }
              } catch (e) {
                if (mounted.current) setError((e as Error).message);
              } finally {
                if (mounted.current) setBusy(false);
              }
            }}
          >
            <Field label="Язык записи">
              <select
                value={language}
                onChange={(event) => setLanguage(event.target.value)}
              >
                <option value="auto">Определить автоматически</option>
                <option value="ru">Русский</option>
                <option value="en">Английский</option>
              </select>
            </Field>
            {config.summaryConfigured && (
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={summary}
                  onChange={(event) => setSummary(event.target.checked)}
                />
                <span>
                  Добавить AI-резюме
                  <small>
                    Краткие итоги и договоренности по тексту встречи
                  </small>
                </span>
              </label>
            )}
            <p className="form-note">
              Автоматическое распознавание может ошибаться. Проверьте имена,
              числа и договоренности перед использованием результата.
            </p>
            <Button type="submit" className="primary" busy={busy}>
              <FileText size={17} />
              {job?.status === "failed"
                ? "Повторить обработку"
                : "Создать расшифровку"}
            </Button>
          </form>
        )}
      {job?.status === "complete" && (
        <>
          {job.summary && (
            <section className="transcript-summary">
              <h3>
                <Sparkles size={17} />
                Резюме AI
              </h3>
              <p className="form-note">
                Сформировано автоматически. Проверьте факты и выводы по записи.
              </p>
              <div>{job.summary}</div>
            </section>
          )}
          <section className="transcript-result">
            <div className="transcript-result-heading">
              <h3>Текст встречи</h3>
              {job.duration !== undefined && (
                <span>{timecode(job.duration)}</span>
              )}
            </div>
            <div className="transcript-scroll" aria-label="Текст расшифровки">
              {job.segments?.length ? (
                job.segments.map((segment, index) => (
                  <div
                    className="transcript-segment"
                    key={`${segment.start}-${index}`}
                  >
                    <time>{timecode(segment.start)}</time>
                    <p>{segment.text}</p>
                  </div>
                ))
              ) : (
                <p>{job.text || "В этой записи не удалось обнаружить речь."}</p>
              )}
            </div>
          </section>
          <Button
            onClick={() => {
              const text = [
                recording.roomTitle,
                date(recording.startedAt),
                job.summary
                  ? `РЕЗЮМЕ AI (проверьте факты)\n${job.summary}`
                  : "",
                "РАСШИФРОВКА",
                job.segments?.length
                  ? job.segments
                      .map(
                        (segment) =>
                          `[${timecode(segment.start)}] ${segment.text}`,
                      )
                      .join("\n")
                  : (job.text ?? ""),
              ]
                .filter(Boolean)
                .join("\n\n");
              const url = URL.createObjectURL(
                new Blob([text], { type: "text/plain;charset=utf-8" }),
              );
              const link = document.createElement("a");
              link.href = url;
              link.download = `imonmeets-transcript-${recording.id}.txt`;
              document.body.append(link);
              link.click();
              link.remove();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            <ArrowDownToLine size={17} />
            Скачать текст
          </Button>
        </>
      )}
      {job && !active && recording.canManage && (
        <div className="transcript-delete">
          {confirmDelete ? (
            <>
              <p>
                Удалить текст и AI-резюме? Исходная запись останется в
                хранилище.
              </p>
              <div className="ownership-actions">
                <Button disabled={busy} onClick={() => setConfirmDelete(false)}>
                  Отмена
                </Button>
                <Button
                  className="danger"
                  busy={busy}
                  onClick={async () => {
                    generation.current++;
                    controller.current?.abort();
                    loading.current = false;
                    setBusy(true);
                    setError("");
                    try {
                      await api(base, undefined, "DELETE");
                      if (mounted.current) {
                        setJob(null);
                        setConfirmDelete(false);
                        notify("Расшифровка удалена");
                      }
                    } catch (e) {
                      if (mounted.current) setError((e as Error).message);
                    } finally {
                      if (mounted.current) setBusy(false);
                    }
                  }}
                >
                  Удалить расшифровку
                </Button>
              </div>
            </>
          ) : (
            <Button
              className="text-button danger-quiet"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={16} />
              Удалить расшифровку
            </Button>
          )}
        </div>
      )}
      <div className="modal-actions">
        <Button disabled={busy} onClick={() => void load()}>
          Проверить состояние
        </Button>
        <Button disabled={busy} onClick={onClose}>
          Закрыть
        </Button>
      </div>
    </Modal>
  );
}
