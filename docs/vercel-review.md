# Vercel review deployment

Canonical application URL: **https://imonmeets.vercel.app**.

This is a restricted review deployment using real accounts, PostgreSQL and LiveKit. Registration is closed. The owner receives a dedicated account verified through the normal captured-email flow. Passwords, activation/reset links, session state and proxy credentials must never be committed or put into screenshots.

On **2026-11-01**, Vercel reported the deployment from Git commit `051f3245` **READY**, and [GitHub Actions run 41287860916](https://github.com/IMONsergey/imonmeets/actions/runs/41287860916) passed. Public HTTPS/API access is established. A browser test run on the SFU host passed the meeting flow; independent external media acceptance remains outstanding. This is not a claim of general public-network readiness.

## Architecture

Vercel builds `apps/web` and serves the React application. Requests to `/api/*` are rewritten to the persistent Fastify origin over TLS. Browser media connects directly to the separate LiveKit WSS endpoint and its public media transport. PostgreSQL and Valkey remain private.

The current origin names use sslip.io for IP-based DNS until an application-owned API/media domain is configured. TLS uses HTTP-01 certificates and a dedicated Nginx listener on 8443. Port 443 remains allocated to the host's existing service. This is a pilot topology: restrictive networks can block 8443 or direct media. TURN/TLS on a suitable port/address is a separate requirement for broad network compatibility.

| Endpoint                                           | Publication                                            |
| -------------------------------------------------- | ------------------------------------------------------ |
| Frontend and browser-facing API                    | Vercel HTTPS on 443                                    |
| Upstream API and media signaling                   | Native Nginx TLS on the selected public IPv4, TCP 8443 |
| ACME certificate challenge                         | Selected public IPv4, TCP 80; other paths return 404   |
| LiveKit media                                      | Selected public IPv4, TCP 7881 and UDP 7882            |
| Fastify 3540, LiveKit signaling 7880, Mailpit 3541 | Loopback only                                          |
| PostgreSQL and Valkey                              | Docker network only                                    |

## Origin authentication

`vercel.json` attaches `x-imon-proxy-secret` to upstream **requests** using the private production variable `ORIGIN_PROXY_SECRET`. The transform replaces a client-supplied value. The API checks it using a timing-safe comparison; only its minimal health endpoint is exempt. Never expose this value through `VITE_*` variables or a response header.

After authenticating the proxy, the API accepts only a single valid address in Vercel's overwritten `X-Forwarded-For` header for rate limiting and authentication. Nginx preserves this value without appending a proxy address. Blanket `trustProxy` remains disabled.

API responses are uncacheable. Cookies stay host-only, Secure and HttpOnly. `APP_URL` is the exact canonical Vercel URL; other preview hostnames do not automatically gain trusted-origin access. The origin does not return the proxy secret.

See [Vercel's origin-protection documentation](https://vercel.com/docs/routing/rewrites#restricting-your-origin-to-vercel-traffic).

## Environment and host setup

The existing private `.env` retains database, authentication and media credentials. Set these additional non-secret values as appropriate:

```dotenv
APP_URL=https://imonmeets.vercel.app
APP_ENV=production
REGISTRATION_ENABLED=false
EMAIL_DELIVERY_MODE=capture
LIVEKIT_CONFIG_PATH=./deploy/livekit.public.yaml
COMPOSE_FILE=compose.yml:compose.public.yml
LIVEKIT_PUBLIC_IP=YOUR_SERVER_IPV4
PUBLIC_API_HOST=YOUR_API_HOSTNAME
PUBLIC_MEDIA_HOST=YOUR_MEDIA_HOSTNAME
TLS_CERT_NAME=imonmeets-preview
LIVEKIT_URL=wss://YOUR_MEDIA_HOSTNAME:8443
```

Set the same independently generated, random `ORIGIN_PROXY_SECRET` in the private server environment and the Vercel project's **Production Secret**. Keep `DEV_ALLOW_UNVERIFIED_EMAIL=false`. The source contains no value for this secret.

`node --env-file=.env scripts/prepare-public.mjs` generates ignored ACME, Nginx TLS and LiveKit configuration files. It does not install them or change the host. Review them first. The explicit `LIVEKIT_CONFIG_PATH` is essential: the public Compose override changes media bindings but does not select the media configuration itself.

The generator explicitly applies `chmod 0644` after writing these non-secret configuration files. A `writeFile` mode alone is filtered by the process umask: under the deployment shell's `umask 077`, LiveKit initially received a permission-denied error reading its bind-mounted configuration. Preserve the explicit chmod so the container's non-root process can read it. This permission applies to generated configuration, not the private `.env`, certificate keys or credential files.

Bootstrap only the generated ACME listener, create `/var/lib/imonmeets-acme`, and obtain a certificate with `certbot certonly --webroot`. Serve challenges directly on port 80; do not redirect them to 8443. After the certificate exists and the protected API is running, install the generated TLS configuration, validate with `nginx -t`, and reload Nginx. Install `deploy/renew-nginx.sh` as a root-owned Certbot deploy hook and verify the renewal timer plus a renewal dry run.

Use `docker compose config --quiet` before `docker compose up -d --build --wait`. Do not print resolved Compose configuration. Docker-published ports are an exposure boundary independently of UFW; the override publishes only the intended media ports on the selected IPv4.

## Review access and email

`EMAIL_DELIVERY_MODE=capture` means messages go only to private Mailpit. This is not external email delivery. Production refuses this configuration if registration is enabled. The interface explains review access, hides public signup, disables unavailable mail actions, and keeps normal login and one-time password setup available.

Before enabling customer registration, configure real external SMTP, set `EMAIL_DELIVERY_MODE=external`, and verify actual delivery. Production external SMTP requires STARTTLS unless implicit TLS is selected. Recording stays disabled until Egress/storage acceptance.

Before exposing this deployment, all five previously generated synthetic browser-test account passwords were rotated through the normal reset flow, which invalidates their old sessions. Those accounts were retained, not deleted. The owner and QA review accounts use separately generated credentials in private operator-controlled files outside the repository.

## Original review verification

This section records the original review deployment at `64b4419`, before the hardening and TURN work. For current results and remaining gates, see the [remediation record](audit-remediation-2026-11-01.md) and [operations runbook](operations.md).

The host-run public review test passed **1/1 in 13.2 seconds** after the generated-file permission correction. It used the canonical Vercel URL and checked the flow below. Because its browsers ran on the same machine as LiveKit, that pass does not prove external media reachability.

An independent Chrome 156 attempt through the environment's HTTP egress proxy reached HTTPS, login, calendar export and WSS, but failed ICE with `could not establish pc connection`. Direct TCP checks from that environment immediately returned `ECONNREFUSED` on both 8443 and 7881, although HTTPS through its proxy reached the same 8443 origin. This supports an environment network restriction but does not prove the exact ICE failure cause or external media readiness. At that revision, successful external audio/video remained a publication limitation. External SMTP, Egress/S3 recording, TURN/TLS on 443 and restrictive-network operation had not been accepted. Registration was closed; external mail delivery, recording and TURN were disabled.

The TLS certificate is valid. Certbot renewal dry run and the custom `nginx -t`/reload deploy hook passed. Canonical `/api/config` returned 200 even with a forged client-supplied proxy-secret header, confirming Vercel's overwrite; the direct-origin endpoint without the secret returned 403. Both responses were `Cache-Control: no-store` and exposed no proxy-secret response header. The latest API suite passed 9 tests with no skips, the calendar suite passed 7, and type, build and formatting checks passed. Historical local results and the scope of each check are preserved in [verification.md](verification.md).

The dedicated `tests/e2e/review.spec.ts` exercises the canonical deployment with an already verified account. It checks closed signup, login and secure cookies, scheduled-room creation, actual calendar download, two-browser video/chat, closure and cached-token rejection. It requires private `REVIEW_EMAIL` and `REVIEW_PASSWORD`; inject them from an operator-controlled file without printing them. Trace, video and automatic failure screenshots are disabled for this credentialed test.

Run only this test against the review environment:

```bash
BASE_URL=https://imonmeets.vercel.app PLAYWRIGHT_CHANNEL=chrome npx playwright test tests/e2e/review.spec.ts
```

The generic registration tests target a separate local development deployment, where captured email and open registration are intentional. Do not run them against the closed-registration review deployment.

For an independent installed browser, set `PLAYWRIGHT_EXECUTABLE_PATH`. Test results and remaining connectivity limits are recorded in [verification.md](verification.md).
