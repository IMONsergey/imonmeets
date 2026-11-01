import type { Room } from "./api";

type CalendarRoom = Pick<
  Room,
  | "id"
  | "workspaceId"
  | "title"
  | "description"
  | "slug"
  | "startsAt"
  | "durationMinutes"
>;

// RFC 5545 text escaping and folding count UTF-8 octets, not UTF-16 code units.
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function foldLine(line: string): string {
  const encoder = new TextEncoder();
  let result = "";
  let length = 0;
  for (const character of line) {
    const size = encoder.encode(character).length;
    if (length + size > 75) {
      result += "\r\n ";
      length = 1;
    }
    result += character;
    length += size;
  }
  return result;
}

function utcDate(value: Date): string {
  if (
    !Number.isFinite(value.getTime()) ||
    value.getUTCFullYear() < 1 ||
    value.getUTCFullYear() > 9999
  ) {
    throw new Error("У встречи некорректная дата. Проверьте расписание.");
  }
  return value
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

export function createMeetingCalendar(
  room: CalendarRoom,
  origin: string,
  now = new Date(),
): { content: string; filename: string } {
  if (!room.startsAt) {
    throw new Error("Сначала укажите дату и время встречи.");
  }
  if (!Number.isInteger(room.durationMinutes) || room.durationMinutes <= 0) {
    throw new Error("Укажите положительную длительность встречи.");
  }
  const baseUrl = new URL(origin);
  if (!["https:", "http:"].includes(baseUrl.protocol)) {
    throw new Error("Некорректный адрес встречи.");
  }
  const url = new URL(`/join/${encodeURIComponent(room.slug)}`, baseUrl).href;
  const start = new Date(room.startsAt);
  const end = new Date(start.getTime() + room.durationMinutes * 60_000);
  const description = [room.description, `Присоединиться к встрече: ${url}`]
    .filter(Boolean)
    .join("\n\n");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//IMON//Meets//RU",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${encodeURIComponent(room.workspaceId)}.${encodeURIComponent(room.id)}@${baseUrl.hostname}`,
    `DTSTAMP:${utcDate(now)}`,
    `DTSTART:${utcDate(start)}`,
    `DTEND:${utcDate(end)}`,
    `SUMMARY:${escapeText(room.title)}`,
    `DESCRIPTION:${escapeText(description)}`,
    `URL:${url}`,
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  const name = Array.from(
    room.title
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N}-]+/gu, "-")
      .replace(/^-+|-+$/g, ""),
  )
    .slice(0, 60)
    .join("")
    .replace(/-+$/, "");
  return {
    content: lines.map(foldLine).join("\r\n") + "\r\n",
    filename: `imon-meets-${name || "meeting"}.ics`,
  };
}

export function downloadMeetingCalendar(room: CalendarRoom): void {
  const { content, filename } = createMeetingCalendar(room, location.origin);
  const blob = new Blob([content], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function localMeetingDateTime(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "shortOffset",
  })
    .format(new Date(value))
    .replace("GMT", "UTC");
}

export function localDateTimeInput(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "";
  return new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

export function parseLocalMeetingStart(
  value: string,
  original?: string | null,
): string {
  // A datetime-local input cannot distinguish the two occurrences of a fall-DST
  // hour. Preserve the original instant (and seconds) when its display is unchanged.
  if (original && value && localDateTimeInput(original) === value)
    return original;
  const parsed = new Date(value);
  // A missing spring-DST hour must not silently move the scheduled meeting.
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ||
    localDateTimeInput(value) !== value
  ) {
    throw new Error("Укажите существующую дату и время в вашем часовом поясе.");
  }
  return parsed.toISOString();
}
