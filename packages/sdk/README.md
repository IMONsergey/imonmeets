# IMON Meets SDK

Two integration options are provided: a complete guest meeting widget with the existing IMON Meets interface, and a lower-level transport client for a custom interface. The package is source-distributed in this repository and its browser modules are served with the app. It has not been published to npm.

## Ready-to-use guest widget

The widget includes the device check, waiting room, real audio/video, screen sharing when supported by the browser, participant list, persistent meeting chat and connection/exit states. It never signs the guest into an existing account. It sends API requests without account cookies and keeps admission/media/chat grants inside the frame. Cameras and microphones start disabled; the participant chooses whether to enable them and when to join.

The service administrator must first set `EMBED_ALLOWED_ORIGINS` to a comma-separated list of **exact HTTPS origins** and redeploy the backend, for example:

```dotenv
EMBED_ALLOWED_ORIGINS=https://example.com,https://www.example.com
```

No origin is allowed by default. Wildcards, paths, credentials and non-loopback HTTP are rejected. `http://localhost:PORT` and `http://127.0.0.1:PORT` are supported for isolated development. The published `/embed/:slug` response receives a server-generated `frame-ancestors` CSP from the same configuration. Account pages retain their framing prohibition. This does not open cross-origin API access.

Use the slug at the end of a meeting's guest link. Guest access must be enabled for that meeting; the widget respects host admission, guest restrictions, room closure and link rotation.

```html
<div id="meeting"></div>
<p id="meeting-status" role="status"></p>
<button id="leave-meeting" type="button">Выйти из встречи</button>

<script type="module">
  import { mountMeeting } from "https://imonmeets.vercel.app/sdk/v1/embed.js";

  const status = document.getElementById("meeting-status");
  const meeting = mountMeeting({
    container: document.getElementById("meeting"),
    appUrl: "https://imonmeets.vercel.app",
    room: "REPLACE_WITH_ROOM_SLUG",
    name: "Имя участника", // Optional prefill, never sent in the iframe URL.
    height: 680,
    onEvent(event) {
      if (event.type === "state" && event.state === "left")
        status.textContent = "Вы вышли из встречи";
    },
  });
  meeting.ready.catch(() => {
    status.textContent =
      "Виджет недоступен. Проверьте разрешенный домен или откройте обычную ссылку на встречу.";
  });
  document
    .getElementById("leave-meeting")
    .addEventListener("click", () => meeting.leave());

  // In an SPA, call this on route/component cleanup:
  // meeting.destroy();
</script>
```

For a self-hosted deployment, replace both origins with your canonical app origin. The build emits three plain ES modules under `/sdk/v1/`; they use relative imports and need no bundler or third-party runtime. These public JS files allow anonymous cross-origin reads. The meeting itself communicates with its own API origin from inside the iframe. A copyable complete page is in [examples/embedded-meeting.html](examples/embedded-meeting.html).

The SDK creates an iframe with `allow="camera; microphone; display-capture; fullscreen; autoplay"`, a descriptive title, a no-referrer policy and a sandbox without top-page navigation. Your site's own Permissions-Policy and browser permission settings must also permit the chosen devices. Delegation does not grant device permission or bypass the user's browser prompt. An ordinary `/join/:slug` link is the fallback for environments that prevent framed camera/microphone access.

### Widget API and events

| API                    | Behavior                                                                                                                                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ready: Promise<void>` | Resolves after the frame has checked its configured parent origin and completed the channel handshake. It does not mean that the guest has joined the call.                                                                                               |
| `leave()`              | Leaves an active call, cancels a pending admission request, or closes the device check. It cannot end the meeting for other participants.                                                                                                                 |
| `destroy()`            | Removes the iframe and message listener. Removing the frame stops its local media. Admission cancellation during unload is best-effort; the server expires abandoned requests. Call `leave()` and observe `left` first when you need a visible exit flow. |
| `iframe`               | The created iframe element, for application layout or accessibility adjustments.                                                                                                                                                                          |

`onEvent` receives only the following sanitized data:

```ts
{ type: "ready" }
{ type: "state", state: "prejoin" | "waiting" | "connecting" | "joined" | "reconnecting" | "left" }
{ type: "error", code: "CONNECTION_ERROR" | "REQUEST_FAILED" | "INITIALIZATION_FAILED" }
```

The parent never receives media or chat tokens, account information, participant names, chat contents or arbitrary error text. Both sides verify the exact sender window, origin, protocol version and random per-frame channel. Name prefill is a message sent only after this handshake. Parent commands cannot switch on devices, admit guests, record, send chat messages or acquire host privileges.

The optional `height` is an integer from 420 to 2160 pixels (default 680); width follows the container. `timeoutMs` is 1000 to 60000 milliseconds (default 20000). An initialization timeout removes the frame and rejects `ready` with `EMBED_TIMEOUT`. Calling `destroy()` before readiness rejects it with `EMBED_DESTROYED`.

## Custom-interface transport client

`ImonMeetsClient` supports guest room metadata, host admission, cancellation and persistent chat. LiveKit's client SDK renders audio/video using the short-lived grant returned after admission.

## Integration boundary

Use a **same-origin backend proxy in your embedding application**, pointing to the canonical IMON Meets `/api/rooms/...` endpoints. A server integration may call the canonical API directly. Browser cross-origin CORS is deliberately not enabled for arbitrary websites. This SDK does not bypass waiting rooms, guest restrictions, expired links or room closure.

The existing full account dashboard keeps its clickjacking protection. Use the guest widget above for a complete interface, or build a custom meeting view with this transport client and LiveKit React components/the LiveKit JavaScript client. Neither integration creates rooms, manages billing, impersonates signed-in members or issues administrator credentials.

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

Run `npm run test:sdk` from the repository root. Browser acceptance for the hosted widget is in `apps/web/src/embed.browser.test.ts`: real cross-origin frames and ES modules, mocked API fixtures, no real media server. Live provider acceptance is recorded separately in the release verification document.
