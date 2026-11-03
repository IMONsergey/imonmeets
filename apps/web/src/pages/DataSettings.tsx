import { useEffect, useState } from "react";
import { ArrowDownToLine, Database, Trash2, Users } from "lucide-react";
import { api, notifyAuthChange } from "../api";
import type { Member, User, Workspace } from "../api";
import { Button, ErrorBox, Field, Modal, go } from "../ui";
import type { Session } from "../ui";
import { PasswordGate } from "./PasswordGate";

export function downloadPrivateFile(data: unknown, filename: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json;charset=utf-8",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function DataSettings({
  user,
  notify,
}: {
  user: User;
  notify: (text: string, error?: boolean) => void;
}) {
  const [busy, setBusy] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState("");
  return (
    <>
      <div className="workspace-section-heading">
        <h2>Ваши данные</h2>
        <Database size={18} />
      </div>
      <p className="workspace-settings-description">
        Управляйте копией персональных данных и своим аккаунтом.
      </p>
      <section className="data-section">
        <h3>Экспорт данных</h3>
        <p>
          Скачайте данные профиля, членства в пространствах и связанную с
          аккаунтом историю в формате JSON. Пароли и ключи доступа в файл не
          входят.
        </p>
        <Button
          busy={busy === "export"}
          onClick={async () => {
            setBusy("export");
            try {
              const result = await api("/me/export", undefined, undefined, {
                timeoutMs: 30_000,
              });
              downloadPrivateFile(
                result,
                `imonmeets-data-${new Date().toISOString().slice(0, 10)}.json`,
              );
              notify("Файл с данными подготовлен");
            } catch (e) {
              notify((e as Error).message, true);
            } finally {
              setBusy("");
            }
          }}
        >
          <ArrowDownToLine size={17} />
          Скачать мои данные
        </Button>
      </section>
      <section className="data-section danger-zone">
        <h3>Удаление аккаунта</h3>
        <p>
          Аккаунт {user.email} и его сеансы будут удалены. Сначала передайте
          принадлежащие вам пространства другому участнику или удалите их в
          настройках пространства.
        </p>
        <Button
          className="danger-quiet"
          onClick={() => {
            setError("");
            setConfirmation("");
            setDeleting(true);
          }}
        >
          <Trash2 size={17} />
          Удалить аккаунт
        </Button>
      </section>
      {deleting && (
        <Modal
          title="Удалить аккаунт?"
          onClose={() => {
            if (!busy) setDeleting(false);
          }}
        >
          <p className="modal-intro">
            Вы потеряете доступ к IMON Meets. Восстановить этот аккаунт после
            удаления нельзя. Ваши сообщения будут удалены. Совместные встречи
            останутся в пространствах команды, а журнал действий будет
            обезличен. Резервные копии удаляются по сроку хранения.
          </p>
          <ErrorBox error={error} focus />
          <PasswordGate>
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                if (busy || confirmation !== "DELETE") return;
                setBusy("delete");
                setError("");
                try {
                  await api(
                    "/me",
                    {
                      password: new FormData(event.currentTarget).get(
                        "password",
                      ),
                      confirmation,
                    },
                    "DELETE",
                    { timeoutMs: 30_000 },
                  );
                  notifyAuthChange("signed-out");
                  go("/login");
                  notify("Аккаунт удален");
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy("");
                }
              }}
            >
              <Field label="Текущий пароль">
                <input
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </Field>
              <Field label="Введите DELETE для подтверждения">
                <input
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  autoComplete="off"
                  required
                  spellCheck={false}
                />
              </Field>
              <div className="modal-actions">
                <Button
                  type="button"
                  disabled={!!busy}
                  onClick={() => setDeleting(false)}
                >
                  Отмена
                </Button>
                <Button
                  className="danger"
                  type="submit"
                  busy={busy === "delete"}
                  disabled={confirmation !== "DELETE"}
                >
                  Удалить навсегда
                </Button>
              </div>
            </form>
          </PasswordGate>
        </Modal>
      )}
    </>
  );
}

export function WorkspaceOwnership({
  workspace,
  refresh,
  notify,
}: {
  workspace: Workspace;
  refresh: () => Promise<Session>;
  notify: (text: string, error?: boolean) => void;
}) {
  const [members, setMembers] = useState<Member[]>();
  const [action, setAction] = useState<"transfer" | "delete">();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState("");
  useEffect(() => {
    if (workspace.role !== "owner") return;
    const controller = new AbortController();
    void api<{ members: Member[] }>(
      `/workspaces/${workspace.id}/members`,
      undefined,
      undefined,
      { signal: controller.signal },
    )
      .then((data) => {
        if (!controller.signal.aborted)
          setMembers(data.members.filter((member) => member.role !== "owner"));
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError((e as Error).message);
      });
    return () => controller.abort();
  }, [workspace.id, workspace.role]);
  if (workspace.role !== "owner") return null;
  return (
    <section className="data-section danger-zone">
      <h3>Владение пространством</h3>
      <p>
        Только владелец может передать управление пространством или удалить его
        вместе со встречами и историей чата.
      </p>
      {!action && <ErrorBox error={error} />}
      <div className="ownership-actions">
        <Button
          disabled={!members?.length}
          onClick={() => {
            setError("");
            setAction("transfer");
          }}
        >
          <Users size={17} />
          Передать владение
        </Button>
        <Button
          className="danger-quiet"
          onClick={() => {
            setError("");
            setConfirmation("");
            setAction("delete");
          }}
        >
          <Trash2 size={17} />
          Удалить пространство
        </Button>
      </div>
      {members?.length === 0 && (
        <p className="form-note">
          Для передачи владения сначала пригласите нового владельца в команду.
        </p>
      )}
      {action && (
        <Modal
          title={
            action === "transfer"
              ? "Передать владение"
              : "Удалить пространство?"
          }
          onClose={() => {
            if (!busy) setAction(undefined);
          }}
        >
          <p className="modal-intro">
            {action === "transfer"
              ? `Новый владелец получит полный контроль над пространством «${workspace.name}». Вы останетесь администратором.`
              : `Пространство «${workspace.name}», встречи и история чата будут удалены. Активные звонки будут завершены. Сначала остановите и удалите все записи.`}
          </p>
          <ErrorBox error={error} focus />
          <PasswordGate>
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                if (busy || (action === "delete" && confirmation !== "DELETE"))
                  return;
                const form = new FormData(event.currentTarget);
                setBusy(true);
                setError("");
                try {
                  if (action === "transfer")
                    await api(
                      `/workspaces/${workspace.id}/transfer-ownership`,
                      {
                        memberId: form.get("memberId"),
                        password: form.get("password"),
                      },
                    );
                  else
                    await api(
                      `/workspaces/${workspace.id}`,
                      { password: form.get("password"), confirmation },
                      "DELETE",
                      { timeoutMs: 45_000 },
                    );
                  await refresh();
                  notify(
                    action === "transfer"
                      ? "Владение передано"
                      : "Пространство удалено",
                  );
                  setAction(undefined);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {action === "transfer" && (
                <Field label="Новый владелец">
                  <select name="memberId" required>
                    <option value="">Выберите участника</option>
                    {members?.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name} · {member.email}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label="Текущий пароль">
                <input
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </Field>
              {action === "delete" && (
                <Field label="Введите DELETE для подтверждения">
                  <input
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    required
                  />
                </Field>
              )}
              <div className="modal-actions">
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => setAction(undefined)}
                >
                  Отмена
                </Button>
                <Button
                  className={action === "delete" ? "danger" : "primary"}
                  type="submit"
                  busy={busy}
                  disabled={action === "delete" && confirmation !== "DELETE"}
                >
                  {action === "transfer"
                    ? "Передать владение"
                    : "Удалить навсегда"}
                </Button>
              </div>
            </form>
          </PasswordGate>
        </Modal>
      )}
    </section>
  );
}
