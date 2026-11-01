# Guest meeting embedding

The existing account application keeps its framing prohibition. A separate
`/embed/:slug` document renders only the guest meeting interface, with no
account navigation or account-cookie requests. The guest still needs a valid
share link, enabled guest access and admission when the waiting room is on.

## Configuration and publication

1. Set `EMBED_ALLOWED_ORIGINS` privately in the service environment to the exact
   HTTPS origins that will host the widget. The default empty list denies all
   embedding. Wildcards, credentials, paths and non-HTTPS production origins
   are rejected at startup. The value is public configuration, not a secret.
2. Build and publish the same source revision to the backend and Vercel. The
   Docker build includes `packages` because the frame imports the shared SDK
   protocol. No new runtime package is needed.
3. Regenerate the existing IMON Meets Nginx configuration using
   `scripts/prepare-public.mjs`, retain the existing optional offsite/storage
   includes, run `nginx -t` and reload only after validation. The new `/embed/`
   proxy uses the existing 8443 listener and does not change the VPN listener.
4. Vercel proxies only the validated `/embed/:slug` path to the backend with the
   existing private origin credential. The backend produces the framing CSP
   and an uncacheable document. Other page paths keep their deny policy.
5. Import `mountMeeting` from the hosted `/sdk/v1/embed.js` module on an allowed
   site. The three public SDK modules have anonymous CORS and five-minute
   caching. API responses do not receive this CORS permission.

The SDK waits for an exact-window, exact-origin, random-channel handshake before
sending the optional participant name. Only readiness, bounded meeting states
and fixed error codes return to the parent. Room tokens, chat messages, media
tracks and signed-in account data do not enter that message channel. Camera
and microphone are initially disabled; the participant controls them.

`leave()` cancels waiting or disconnects this participant. `destroy()` removes
the frame and listener. Unload cancellation is best-effort, with server expiry
for abandoned waiting requests. Neither command closes the room for others.

## Verification

The repository contains three independent checks:

- `apps/api/test/embedding.test.ts`: real built HTML/module responses, framing
  headers, origin validation, proxy authentication and the closed API CORS
  boundary. Build before running the API suite.
- `apps/web/src/embed.browser.test.ts`: real browser iframe and hosted ES
  modules with controlled API fixtures; waiting, cookie isolation, no implicit
  device activation, wrong-source/origin/channel rejection and cleanup.
- `tests/e2e/embed.spec.ts`: an already provisioned review account, the actual
  published SDK, HTML, API and LiveKit. Only the parent host HTML is a local
  test fixture on the configured allowed origin. The test checks live
  admission, bidirectional synthetic media, chat, device cleanup and rejection
  by CSP on an unapproved host. It removes only its own test workspace.

For the live test, inject `REVIEW_EMAIL` and `REVIEW_PASSWORD` from a private
operator file, set `BASE_URL` and `EMBED_TEST_HOST`, and run:

```sh
PLAYWRIGHT_CHANNEL=chrome npx playwright test tests/e2e/embed.spec.ts --reporter=line
```

Credentialed acceptance disables screenshots, tracing and videos. Its success
does not establish real mobile-device behavior or compatibility with every
host's Permissions-Policy. Check every `/assets/*` URL from the proxied HTML
after publication; mixing backend and frontend revisions can break the frame.
