import { useEffect, useState } from "react";
import { MessageSquare } from "lucide-react";
import { api, date } from "../api";
import type { ChatMessage, Room, Workspace } from "../api";
import { Button, Empty, ErrorBox, Modal, Spinner } from "../ui";

export function ChatHistory({
  workspace,
  room,
  onClose,
}: {
  workspace: Workspace;
  room: Room;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>();
  const [hasEarlier, setHasEarlier] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ messages: ChatMessage[]; hasEarlier?: boolean }>(
      `/workspaces/${workspace.id}/rooms/${room.id}/chat`,
      undefined,
      undefined,
      { signal: controller.signal },
    )
      .then((data) => {
        if (controller.signal.aborted) return;
        setMessages(data.messages);
        setHasEarlier(Boolean(data.hasEarlier));
        setError("");
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError((e as Error).message);
      });
    return () => controller.abort();
  }, [workspace.id, room.id, refresh]);
  return (
    <Modal title="История чата" onClose={onClose}>
      <p className="modal-intro">
        {room.title}. Сообщения доступны участникам пространства и удаляются по
        сроку хранения, указанному в тарифе.
      </p>
      <ErrorBox error={error} />
      {!messages && !error && <Spinner />}
      {hasEarlier && messages?.length && (
        <Button
          busy={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const data = await api<{
                messages: ChatMessage[];
                hasEarlier?: boolean;
              }>(
                `/workspaces/${workspace.id}/rooms/${room.id}/chat?before=${encodeURIComponent(messages[0].id)}`,
              );
              setMessages((current) => [...data.messages, ...(current ?? [])]);
              setHasEarlier(Boolean(data.hasEarlier));
              setError("");
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Загрузить предыдущие сообщения
        </Button>
      )}
      {messages?.length ? (
        <div
          className="saved-chat"
          role="log"
          aria-label="Сохраненные сообщения"
        >
          {messages.map((message) => (
            <article className="saved-chat-message" key={message.id}>
              <div>
                <strong>{message.name}</strong>
                <time dateTime={message.createdAt}>
                  {date(message.createdAt)}
                </time>
              </div>
              <p>{message.text}</p>
            </article>
          ))}
        </div>
      ) : messages ? (
        <Empty
          icon={MessageSquare}
          title="Сообщений пока нет"
          text="Сообщения, отправленные во встрече, появятся здесь."
        />
      ) : null}
      <div className="modal-actions">
        <Button
          disabled={busy}
          onClick={() => setRefresh((value) => value + 1)}
        >
          Обновить
        </Button>
        <Button onClick={onClose}>Закрыть</Button>
      </div>
    </Modal>
  );
}
