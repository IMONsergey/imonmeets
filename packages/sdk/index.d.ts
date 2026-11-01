export declare class ImonMeetsError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string);
}
export type JoinedMeeting = {
  status: "joined";
  token: string;
  chatToken: string;
  identity: string;
  serverUrl: string;
  roomName: string;
  canManage: boolean;
};
export type WaitingMeeting = {
  status: "waiting";
  requestId: string;
  waitingToken: string;
  expiresAt: string;
};
export type ChatMessage = {
  id: string;
  identity: string;
  name: string;
  text: string;
  createdAt: string;
};
export type ChatPage = {
  messages: ChatMessage[];
  nextCursor: string | null;
  hasEarlier: boolean;
  hasMore: boolean;
};
export declare class ImonMeetsClient {
  constructor(options: {
    baseUrl: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
  });
  getRoom(
    slug: string,
    options?: { signal?: AbortSignal },
  ): Promise<{
    room: {
      title: string;
      description: string;
      startsAt: string | null;
      durationMinutes: number;
      maxParticipants: number;
      status: "open" | "closed";
      waitingRoom: boolean;
      allowGuests: boolean;
    };
    canManage: boolean;
  }>;
  join(
    slug: string,
    options: { name: string; waitingToken?: string; signal?: AbortSignal },
  ): Promise<JoinedMeeting | WaitingMeeting>;
  waitingStatus(
    slug: string,
    token: string,
    options?: { signal?: AbortSignal },
  ): Promise<{
    status: "waiting" | "admitted" | "denied" | "expired";
    expiresAt: string;
  }>;
  cancelWaiting(
    slug: string,
    token: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ ok: true }>;
  readMessages(
    slug: string,
    token: string,
    options?: { after?: string; before?: string; signal?: AbortSignal },
  ): Promise<ChatPage>;
  sendMessage(
    slug: string,
    token: string,
    options: { text: string; clientId?: string; signal?: AbortSignal },
  ): Promise<{ message: ChatMessage }>;
}
