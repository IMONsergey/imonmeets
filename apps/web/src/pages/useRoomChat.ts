import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { ChatMessage } from "../api";

export function useRoomChat(slug: string, token?: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(Boolean(token));
  const [sending, setSending] = useState(false);
  const [hasEarlier, setHasEarlier] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const cursor = useRef<string | undefined>(undefined);
  const pending = useRef<{ text: string; id: string } | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const merge = useCallback((entries: ChatMessage[]) => {
    setMessages((current) => {
      const all = new Map(current.map((entry) => [entry.id, entry]));
      entries.forEach((entry) => all.set(entry.id, entry));
      return [...all.values()]
        .sort((a, b) => {
          // BIGSERIAL is deliberately a string, avoiding number precision loss.
          const aa = BigInt(a.id),
            bb = BigInt(b.id);
          return aa < bb ? -1 : aa > bb ? 1 : 0;
        })
        .slice(-500);
    });
  }, []);
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    let inFlight = false;
    const sync = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        // Read bounded pages; further history catches up on the next poll.
        for (let page = 0; page < 3; page++) {
          const response = await api<{
            messages: ChatMessage[];
            nextCursor: string | null;
            hasEarlier?: boolean;
            hasMore?: boolean;
          }>(
            `/rooms/${encodeURIComponent(slug)}/chat${cursor.current ? `?after=${encodeURIComponent(cursor.current)}` : ""}`,
            undefined,
            undefined,
            {
              headers: { "x-imon-room-session": token },
              signal: controller.signal,
              sessionErrors: false,
            },
          );
          if (controller.signal.aborted) return;
          merge(response.messages);
          if (response.hasEarlier) setHasEarlier(true);
          if (response.nextCursor) cursor.current = response.nextCursor;
          setLoading(false);
          setError("");
          if (!response.hasMore) break;
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setError((e as Error).message);
          setLoading(false);
        }
      } finally {
        inFlight = false;
      }
    };
    void sync();
    const timer = setInterval(() => void sync(), 3000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [slug, token, refresh, merge]);
  const send = async (text: string) => {
    if (!token)
      throw new Error("Сеанс чата не найден. Переподключитесь к встрече.");
    const draft =
      pending.current?.text === text
        ? pending.current
        : { text, id: crypto.randomUUID() };
    pending.current = draft;
    setSending(true);
    try {
      const result = await api<{ message: ChatMessage }>(
        `/rooms/${encodeURIComponent(slug)}/chat`,
        { text, clientId: draft.id },
        "POST",
        { headers: { "x-imon-room-session": token }, sessionErrors: false },
      );
      if (!mounted.current) return;
      merge([result.message]);
      pending.current = undefined;
      setError("");
      // Do not advance the polling cursor to our own message: another sender's
      // messages could lie between the last fetched cursor and this response.
      setRefresh((value) => value + 1);
    } finally {
      if (mounted.current) setSending(false);
    }
  };
  return { messages, loading, sending, error, hasEarlier, send };
}
