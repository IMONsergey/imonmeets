import { test } from "node:test";
import assert from "node:assert/strict";
import { ImonMeetsClient, ImonMeetsError } from "./index.js";
const token = "a".repeat(43);
const clientId = "08bed2a1-cbf1-432a-9a41-6a4e6dfe58a5";

test("guest admission keeps capability tokens out of URLs and drops account cookies", async () => {
  const calls = [];
  const sdk = new ImonMeetsClient({
    baseUrl: "https://meeting.example/api",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ status: "waiting", waitingToken: token });
    },
  });
  await sdk.join("room-slug", { name: "Guest", waitingToken: token });
  await sdk.waitingStatus("room-slug", token);
  await sdk.cancelWaiting("room-slug", token);
  for (const call of calls) {
    assert.equal(call.url.includes(token), false);
    assert.equal(call.init.credentials, "omit");
    assert.equal(JSON.parse(call.init.body).waitingToken, token);
  }
});

test("chat uses opaque session header, stable retry id and bounded cursors", async () => {
  let call;
  const sdk = new ImonMeetsClient({
    baseUrl: "https://meeting.example/api",
    fetch: async (url, init) => {
      call = { url, init };
      return Response.json({ message: {} });
    },
  });
  await sdk.sendMessage("room", token, { text: " hello ", clientId });
  assert.equal(call.init.headers["X-Imon-Room-Session"], token);
  assert.deepEqual(JSON.parse(call.init.body), { text: "hello", clientId });
  assert.throws(() =>
    sdk.readMessages("room", token, { after: "1", before: "2" }),
  );
  assert.throws(() =>
    sdk.readMessages("room", token, { after: "1&escape=true" }),
  );
  assert.throws(() => sdk.getRoom("../private"));
});

test("unsafe transport and redirect bases rejected", () => {
  for (const baseUrl of [
    "http://remote.example/api",
    "https://user:password@example.com/api",
    "https://example.com/api?secret=1",
    "ftp://example.com",
  ])
    assert.throws(() => new ImonMeetsClient({ baseUrl }));
  assert.doesNotThrow(
    () => new ImonMeetsClient({ baseUrl: "http://localhost:3540/api" }),
  );
});

test("structured product errors and explicit request cancellation reach the integrator", async () => {
  const sdk = new ImonMeetsClient({
    baseUrl: "https://meeting.example/api",
    fetch: async () =>
      Response.json(
        { error: { code: "ROOM_CLOSED", message: "Встреча закрыта." } },
        { status: 409 },
      ),
  });
  await assert.rejects(
    sdk.getRoom("room"),
    (e) =>
      e instanceof ImonMeetsError &&
      e.code === "ROOM_CLOSED" &&
      e.status === 409,
  );
  const controller = new AbortController(),
    reason = new Error("cancelled by caller");
  controller.abort(reason);
  const cancelled = new ImonMeetsClient({
    baseUrl: "https://meeting.example/api",
    fetch: async (_url, init) => {
      init.signal.throwIfAborted();
    },
  });
  await assert.rejects(
    cancelled.getRoom("room", { signal: controller.signal }),
    (e) => e === reason,
  );
});
