import { test } from "node:test";
import assert from "node:assert/strict";
import { mountMeeting } from "./embed.js";
import {
  exactOrigin,
  frameEvent,
  frameParameters,
  packet,
  parentCommand,
} from "./embed-protocol.js";

const room = "room_12345678901234567890";
function browserFixture() {
  const listeners = new Map(),
    timers = new Map(),
    posts = [],
    children = [];
  let timerId = 0;
  class Element {
    ownerDocument = document;
    style = {};
    attributes = {};
    setAttribute(name, value) {
      this.attributes[name] = value;
    }
    append(child) {
      children.push(child);
    }
    remove() {
      children.splice(children.indexOf(this), 1);
    }
  }
  const host = {
    HTMLElement: Element,
    crypto,
    location: { origin: "https://customer.example" },
    addEventListener: (event, listener) => listeners.set(event, listener),
    removeEventListener: (event) => listeners.delete(event),
    setTimeout: (callback) => {
      const id = ++timerId;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  const document = {
    defaultView: host,
    createElement: () =>
      Object.assign(new Element(), {
        contentWindow: {
          postMessage: (body, origin) => posts.push({ body, origin }),
        },
      }),
  };
  const container = new Element();
  return { host, container, listeners, timers, posts, children };
}

test("embedding rejects ambiguous origins, malformed channels and unbounded names", () => {
  for (const origin of [
    "https://customer.example/",
    "https://customer.example/path",
    "http://customer.example",
    "null",
    "https://a:b@example.com",
    "https://example.com?x=1",
    "https://example.com#x",
    "https://*.example.com",
    "data:text/html,x",
  ]) {
    assert.equal(exactOrigin(origin), null, origin);
  }
  assert.equal(exactOrigin("http://127.0.0.1:4444"), "http://127.0.0.1:4444");
  const channel = "ab".repeat(16);
  assert.deepEqual(
    frameParameters(
      `#origin=https%3A%2F%2Fcustomer.example&channel=${channel}`,
    ),
    { origin: "https://customer.example", channel },
  );
  assert.equal(
    frameParameters(
      `#origin=https%3A%2F%2Fcustomer.example&channel=${channel}&token=secret`,
    ),
    null,
  );
  assert.equal(
    frameParameters(`#origin=https%3A%2F%2Fcustomer.example&channel=guess`),
    null,
  );
  assert.equal(
    parentCommand(packet(channel, { type: "enable-camera" }), channel),
    null,
  );
  assert.equal(
    parentCommand(
      packet(channel, { type: "configure", name: "a".repeat(81) }),
      channel,
    ),
    null,
  );
  assert.deepEqual(
    frameEvent(
      packet(channel, {
        type: "state",
        state: "joined",
        token: "never exposed",
      }),
      channel,
    ),
    { type: "state", state: "joined" },
  );
  const { container } = browserFixture();
  assert.throws(() =>
    mountMeeting({ container, appUrl: "https://meet.example/path", room }),
  );
  assert.throws(() =>
    mountMeeting({
      container,
      appUrl: "https://meet.example",
      room: "../settings",
    }),
  );
  assert.throws(() =>
    mountMeeting({
      container,
      appUrl: "https://meet.example",
      room,
      name: "a".repeat(81),
    }),
  );
});

test("parent iframe channel ignores other windows, origins and forged messages; never forwards grants", async () => {
  const fixture = browserFixture(),
    events = [];
  const widget = mountMeeting({
    container: fixture.container,
    appUrl: "https://meet.example",
    room,
    name: "Private participant",
    onEvent: (event) => events.push(event),
  });
  const url = new URL(widget.iframe.src),
    channel = new URLSearchParams(url.hash.slice(1)).get("channel");
  assert.equal(url.search, "");
  assert.equal(url.href.includes("Private"), false);
  assert.equal(widget.iframe.referrerPolicy, "no-referrer");
  assert.equal(
    widget.iframe.attributes.sandbox.includes("allow-top-navigation"),
    false,
  );
  const receive = fixture.listeners.get("message"),
    source = widget.iframe.contentWindow;
  receive({
    source: {},
    origin: url.origin,
    data: packet(channel, { type: "ready" }),
  });
  receive({
    source,
    origin: "https://attacker.example",
    data: packet(channel, { type: "ready" }),
  });
  receive({
    source,
    origin: url.origin,
    data: packet("cc".repeat(16), { type: "ready" }),
  });
  receive({
    source,
    origin: url.origin,
    data: packet(channel, { type: "state", state: "joined" }),
  });
  assert.deepEqual(events, []);
  receive({
    source,
    origin: url.origin,
    data: packet(channel, { type: "ready" }),
  });
  await widget.ready;
  assert.equal(fixture.posts[0].origin, "https://meet.example");
  assert.equal(fixture.posts[0].body.name, "Private participant");
  receive({
    source,
    origin: url.origin,
    data: packet(channel, {
      type: "state",
      state: "joined",
      token: "secret-token",
      chatToken: "secret-chat",
    }),
  });
  receive({
    source,
    origin: url.origin,
    data: packet(channel, {
      type: "error",
      code: "ARBITRARY_ERROR",
      message: "secret",
    }),
  });
  assert.deepEqual(events, [
    { type: "ready" },
    { type: "state", state: "joined" },
  ]);
  widget.leave();
  assert.equal(fixture.posts.at(-1).body.type, "leave");
  assert.equal(fixture.posts.at(-1).origin, "https://meet.example");
  widget.destroy();
  assert.equal(fixture.children.length, 0);
  assert.equal(fixture.listeners.size, 0);
  assert.equal(fixture.timers.size, 0);
  widget.destroy();
});

test("frame never grants device commands and initialization failures are observable", async () => {
  const fixture = browserFixture();
  const widget = mountMeeting({
    container: fixture.container,
    appUrl: "https://meet.example",
    room,
  });
  widget.destroy();
  await assert.rejects(
    widget.ready,
    (error) => error.code === "EMBED_DESTROYED",
  );
  const next = browserFixture(),
    events = [];
  const timed = mountMeeting({
    container: next.container,
    appUrl: "https://meet.example",
    room,
    onEvent: (event) => events.push(event),
  });
  [...next.timers.values()][0]();
  await assert.rejects(timed.ready, (error) => error.code === "EMBED_TIMEOUT");
  assert.deepEqual(events, [{ type: "error", code: "INITIALIZATION_FAILED" }]);
  assert.equal(next.children.length, 0);
  assert.equal(next.listeners.size, 0);
  timed.destroy();
});
