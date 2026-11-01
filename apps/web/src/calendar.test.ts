import assert from "node:assert/strict";
import test from "node:test";
import {
  createMeetingCalendar,
  localDateTimeInput,
  localMeetingDateTime,
  parseLocalMeetingStart,
} from "./calendar";

const room = {
  id: "room-123",
  workspaceId: "workspace-456",
  title: "Планирование команды",
  description: "Обсудим планы",
  slug: "secret/link?with,chars",
  startsAt: "2026-11-02T12:30:00+03:00",
  durationMinutes: 45,
};
const now = new Date("2026-11-01T20:15:31.123Z");
const unfold = (value: string) => value.replace(/\r\n /g, "");

test("exports absolute UTC times, stable identity, duration and encoded current-origin join URL", () => {
  const { content } = createMeetingCalendar(
    room,
    "https://meets.example.com",
    now,
  );
  const text = unfold(content);
  assert.ok(text.includes("DTSTAMP:20261101T201531Z\r\n"));
  assert.ok(text.includes("DTSTART:20261102T093000Z\r\n"));
  assert.ok(text.includes("DTEND:20261102T101500Z\r\n"));
  assert.ok(text.includes("UID:workspace-456.room-123@meets.example.com\r\n"));
  assert.ok(
    text.includes(
      "URL:https://meets.example.com/join/secret%2Flink%3Fwith%2Cchars\r\n",
    ),
  );
  assert.ok(
    text.includes(
      "https://meets.example.com/join/secret%2Flink%3Fwith%2Cchars",
    ),
  );
  assert.equal(text.replace(/\r\n/g, "").includes("\n"), false);
  assert.ok(content.endsWith("END:VCALENDAR\r\n"));
});

test("escapes user text without permitting calendar property or component injection", () => {
  const { content } = createMeetingCalendar(
    {
      ...room,
      title: "План; бюджет, путь\\файл\r\nATTENDEE:someone@example.com",
      description: "Первое\rВторое\nТретье\u0000\u0007",
    },
    "https://meets.example.com",
    now,
  );
  const text = unfold(content);
  assert.ok(
    text.includes(
      "SUMMARY:План\\; бюджет\\, путь\\\\файл\\nATTENDEE:someone@example.com\r\n",
    ),
  );
  assert.ok(text.includes("DESCRIPTION:Первое\\nВторое\\nТретье\\n\\n"));
  assert.equal(text.includes("\r\nATTENDEE:"), false);
  assert.equal(text.includes("\u0000"), false);
  assert.equal(text.match(/BEGIN:VEVENT/g)?.length, 1);
});

test("folds long UTF-8 lines at at most 75 octets without splitting Unicode", () => {
  const title = "Важная встреча 🟠 ".repeat(20);
  const { content } = createMeetingCalendar(
    { ...room, title },
    "https://meets.example.com",
    now,
  );
  for (const line of content.split("\r\n")) {
    assert.ok(Buffer.byteLength(line, "utf8") <= 75, `Long line: ${line}`);
    assert.equal(line.includes("�"), false);
  }
  assert.ok(unfold(content).includes(`SUMMARY:${title}\r\n`));
});

test("makes bounded, safe .ics names even for empty or path-like titles", () => {
  for (const title of [
    "../../CON\\:<>?*\r\n",
    "...",
    "а".repeat(300),
    "𐐀".repeat(100),
  ]) {
    const { filename } = createMeetingCalendar(
      { ...room, title },
      "https://meets.example.com",
      now,
    );
    assert.match(filename, /^imon-meets-[\p{L}\p{N}-]+\.ics$/u);
    assert.ok(Buffer.byteLength(filename, "utf8") <= 255);
    assert.equal(
      new TextDecoder().decode(new TextEncoder().encode(filename)),
      filename,
    );
  }
});

test("calendar end preserves elapsed duration across midnight and daylight saving changes", () => {
  const { content } = createMeetingCalendar(
    { ...room, startsAt: "2027-03-14T01:45:00-05:00", durationMinutes: 90 },
    "https://meets.example.com",
    now,
  );
  assert.ok(content.includes("DTSTART:20270314T064500Z\r\n"));
  assert.ok(content.includes("DTEND:20270314T081500Z\r\n"));
  const overnight = createMeetingCalendar(
    { ...room, startsAt: "2026-12-31T23:45:00Z", durationMinutes: 30 },
    "https://meets.example.com",
    now,
  );
  assert.ok(overnight.content.includes("DTEND:20270101T001500Z\r\n"));
});

test("refuses missing/invalid schedules, nonpositive durations and non-HTTP origins", () => {
  for (const startsAt of [null, "not-a-date"]) {
    assert.throws(() =>
      createMeetingCalendar(
        { ...room, startsAt },
        "https://meets.example.com",
        now,
      ),
    );
  }
  for (const durationMinutes of [0, -1, 1.5, NaN]) {
    assert.throws(() =>
      createMeetingCalendar(
        { ...room, durationMinutes },
        "https://meets.example.com",
        now,
      ),
    );
  }
  assert.throws(() => createMeetingCalendar(room, "javascript:alert(1)", now));
});

test("local form values round-trip in browser timezone and reject missing DST hours", () => {
  const previous = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    assert.equal(
      localDateTimeInput("2027-03-14T07:30:00Z"),
      "2027-03-14T03:30",
    );
    assert.equal(
      parseLocalMeetingStart("2027-03-14T03:30"),
      "2027-03-14T07:30:00.000Z",
    );
    assert.throws(() => parseLocalMeetingStart("2027-03-14T02:30"));
    assert.throws(() => parseLocalMeetingStart("2026-02-30T11:30"));
    assert.match(localMeetingDateTime("2027-03-14T07:30:00Z"), /03:30.*UTC-4/);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
