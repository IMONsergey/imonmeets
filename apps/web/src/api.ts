export type Workspace = {
  id: string;
  name: string;
  role: "owner" | "admin" | "member";
  createdAt: string;
};
export type User = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
};
export type Room = {
  id: string;
  workspaceId: string;
  slug: string;
  title: string;
  description: string;
  startsAt: string | null;
  durationMinutes: number;
  allowGuests: boolean;
  maxParticipants: number;
  status: "open" | "closed";
  createdBy: string;
  createdAt: string;
};
export type Recording = {
  id: string;
  roomId: string;
  roomTitle: string;
  status: "starting" | "active" | "ending" | "complete" | "failed";
  startedAt: string;
  endedAt: string | null;
  sizeBytes: number | null;
  error: string | null;
  canManage?: boolean;
};
export type Config = {
  appName: string;
  registrationEnabled: boolean;
  emailVerificationRequired: boolean;
  emailConfigured: boolean;
  emailDelivery: "capture" | "external";
  mediaConfigured: boolean;
  recordingConfigured: boolean;
};
export type Member = {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: Workspace["role"];
};
export type Invitation = {
  id: string;
  email: string;
  role: "admin" | "member";
  expiresAt: string;
};
export async function api<T>(
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    credentials: "include",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new ApiError(
      data.error?.message ??
        data.message ??
        "Не удалось выполнить запрос. Попробуйте еще раз.",
      response.status,
      data.error?.code ?? data.code,
    );
  return data as T;
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}
export const date = (value: string | null, time = true) =>
  value
    ? new Intl.DateTimeFormat("ru-RU", {
        day: "numeric",
        month: "short",
        ...(time ? { hour: "2-digit", minute: "2-digit" } : {}),
      }).format(new Date(value))
    : "Без расписания";
export const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
export const meetingUrl = (slug: string) =>
  `${location.origin}/join/${encodeURIComponent(slug)}`;
