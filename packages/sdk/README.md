# IMON Meets SDK

Transport SDK for embedding a custom meeting interface into your product. The package is source-distributed in this repository; it has not been published to npm. It supports guest room metadata, host admission, cancellation and persistent chat. LiveKit's client SDK renders audio/video using the short-lived grant returned after admission.

## Integration boundary

Use a **same-origin backend proxy in your embedding application**, pointing to the canonical IMON Meets `/api/rooms/...` endpoints. A server integration may call the canonical API directly. Browser cross-origin CORS is deliberately not enabled for arbitrary websites. This SDK does not bypass waiting rooms, guest restrictions, expired links or room closure.

The existing full account dashboard keeps its clickjacking protection and is not an iframe widget. For embedding, build the meeting view with this SDK and LiveKit React components or the LiveKit JavaScript client. This first SDK does not create rooms, manage billing, impersonate signed-in members, or issue administrator credentials.

```js
import { ImonMeetsClient } from "./packages/sdk/index.js";
import { Room } from "livekit-client";

const meets = new ImonMeetsClient({
  baseUrl: new URL("/meeting-api", location.origin).href,
});
const controller = new AbortController();
let grant = await meets.join(sharedRoomSlug, {
  name: participantName,
  signal: controller.signal,
});

if (grant.status === "waiting") {
  // Keep waitingToken only in memory. Poll waitingStatus at most once per 5 s.
  // After status "admitted", call join again with the same name and waitingToken.
  // On "denied" or "expired", stop polling and explain the result to the user.
  showWaitingRoom(grant);
} else {
  const room = new Room();
  await room.connect(grant.serverUrl, grant.token);
  // Request microphone/camera through explicit user controls.
  // Attach tracks to your own UI and close the room on page cleanup.
  const history = await meets.readMessages(sharedRoomSlug, grant.chatToken);
  showMessages(history.messages);
}
```

The proxy must restrict requests to the known `rooms/:slug`, `join`, `waiting-status`, `waiting` and `chat` paths and supported verbs; do not create an arbitrary URL fetch endpoint. Supply the canonical IMON Meets Origin header on state-changing server requests. Forward only the `Content-Type` and `X-Imon-Room-Session` headers. Do not forward unrelated application cookies, authorization headers or user-supplied proxy secrets. The public Vercel proxy adds its own origin secret.

Tokens belong in memory, request bodies or the dedicated room-session header. Never put join grants, waiting tokens or chat tokens in URLs, analytics, exception reports, local storage or HTML source. Reuse a `clientId` when retrying an uncertain chat submission to avoid duplicate messages.

Chat cursors are decimal strings, preserving PostgreSQL bigint precision. `readMessages` returns the newest page by default; use `after` for live updates and `before` to load older pages. The host may close the room or rotate access at any time; handle `ImonMeetsError` and terminate the local media session when access is revoked.

Run `node --test --test-isolation=none packages/sdk/index.test.js` from the repository root. Live provider acceptance is recorded separately in the release verification document.
