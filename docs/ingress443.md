# Commercial HTTPS, signaling and TURN on port 443

Status: implementation and isolated nginx/HAProxy acceptance complete; no live cutover has been performed. A second assigned public IPv4, DNS, valid certificates and external media acceptance are still required. Existing VPN address and listeners remain in service.

## Topology

| Public name                 | Protocol and public port     | Private destination                                                 |
| --------------------------- | ---------------------------- | ------------------------------------------------------------------- |
| Application hostname        | HTTPS 443                    | HAProxy SNI, nginx TLS on 127.0.0.1:8445, API/web on 127.0.0.1:3540 |
| Separate signaling hostname | WSS 443                      | Same nginx, admission subrequest, LiveKit on 127.0.0.1:7880         |
| Separate recording hostname | HTTPS 443                    | Same nginx, read-only signed-object path, S3 on 127.0.0.1:8333      |
| Separate TURN hostname      | TURN/TLS 443                 | HAProxy passes the original TLS stream to coturn on 127.0.0.1:5349  |
| Existing VPN address        | Existing protocols and ports | Unchanged                                                           |

`INGRESS_PUBLIC_IP` must differ from `VPN_PUBLIC_IP`. Both addresses must be explicitly supplied. The generator refuses missing addresses, shared hostnames, nonstandard public ports and a disabled signaling guard. DNS A records for the four names point to the new IPv4. Publish AAAA records only after the entire IPv6 path is separately configured and accepted.

The public URL is `https://<application-host>` without a port suffix. Public signaling is `wss://<signaling-host>`. The TURN URI advertises 443. The remaining numbers above are internal routing ports or direct WebRTC transport ports; they do not appear in the website URL.

## Admission and trusted addresses

HAProxy sends PROXY v2 only to nginx. Nginx accepts that protocol exclusively on a loopback listener and trusts only 127.0.0.1. It replaces incoming forwarded-address headers with the address supplied by HAProxy. The API additionally checks `ORIGIN_PROXY_SECRET`; a caller cannot establish a trusted IP by supplying their own `X-Forwarded-For`.

Every supported LiveKit client entry point, `/rtc`, `/rtc/validate`, `/rtc/v1`, and `/rtc/v1/validate`, requires an internal admission subrequest. The original query token is saved before the subrequest, which deliberately has no query string. The API receives the token in a private header, plus `LIVEKIT_SIGNALING_AUTH_SECRET` and the origin proxy secret. The backend checks the signed token, participant grant, room generation, expiry and revocation. A failed or unavailable check never reaches LiveKit. WebSocket upgrades pass only after admission.

Public `/api/internal/` requests, the admission subrequest URL and LiveKit administrative HTTP endpoints are blocked. Direct external access to the private signaling port must remain closed. Egress and server SDKs continue to use their private LiveKit address.

LiveKit may refresh an existing participant token. Revocation is therefore bound to the participant identity and room generation in the database, not merely one serialized token. Removal still calls LiveKit to disconnect an existing session; the durable retry path handles RPC uncertainty. External acceptance must demonstrate that a removed participant cannot reconnect with either their initial or refreshed token.

Request logging is disabled on these virtual hosts because a signaling query or signed recording URL can contain a credential. Admission failures and availability should be counted with sanitized API/monitor metrics. Do not enable raw URI logging to troubleshoot a real user call.

## Preparation

Use the release checkout, not the running checkout. Required configuration:

| Variable                                  | Required value                                                              |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| `INGRESS_PUBLIC_IP`                       | A second address actually assigned and routable by the provider             |
| `VPN_PUBLIC_IP`                           | The existing VPN address, used to prevent a listener collision              |
| `APP_URL`                                 | HTTPS application origin, standard 443                                      |
| `LIVEKIT_URL`                             | WSS signaling origin, standard 443                                          |
| `TURN_PUBLIC_HOST`                        | A distinct DNS name covered by the TURN certificate                         |
| `S3_PUBLIC_ENDPOINT`                      | A distinct HTTPS origin when recording is enabled                           |
| `LIVEKIT_PUBLIC_IP`                       | Existing direct SFU/relay address; changing it is a separate network change |
| `TLS_CERT_NAME`                           | The reviewed certificate lineage covering all four names                    |
| `ORIGIN_PROXY_SECRET`                     | Existing or separately prepared random secret, 32+ base64url characters     |
| `LIVEKIT_SIGNALING_AUTH_SECRET`           | Separate random secret, 32+ base64url characters                            |
| `LIVEKIT_SIGNALING_AUTH_ENABLED`          | `true`, only with the new API and protected ingress                         |
| `TURN_INGRESS_443` / `TURN_TLS_PORT`      | `true` / `443`                                                              |
| `RELEASE_COMMIT` / `RELEASE_IMAGE_DIGEST` | Exact full commit and sha256 image identity of the deployed build           |

Run `node scripts/prepare-ingress443.mjs` with the reviewed configuration loaded by the operator's secret-management process. The output is `deploy/ingress443-private`, mode 0700, containing private files mode 0600 and a public routing plan. An existing output directory is rejected; retain old candidates separately for rollback. The command does not install files, acquire certificates, change DNS, bind sockets or reload any service.

After issuance of a matching certificate, `node scripts/prepare-turn.mjs` with `TURN_INGRESS_443=true` prepares coturn with loopback listening and the existing public relay IP. Its LiveKit configuration advertises TLS 443 only. Legacy preparation continues to advertise TLS 5349 and UDP 3478 when the flag is false. Do not publish UDP 3478 candidates for a loopback-only listener.

The nginx candidate references two private include files at `/etc/nginx/snippets/imonmeets-commercial-trust.conf` and `/etc/nginx/snippets/imonmeets-signaling-auth.conf`. Install those as root-owned 0600 files. Never paste their contents in a ticket, log, release receipt or chat. Install the nginx candidate only after confirming the new IP and certificate paths. The HAProxy overlay uses the same reviewed candidate file and a pinned image digest.

## Cutover order and acceptance

1. Obtain the concrete additional IPv4 allocation and price approval if it is a paid order. Verify the address on the host and record the provider/network configuration. Do not replace the VPN address or default route.
2. Review DNS records, create the application/signaling/recording/TURN names and validate certificate coverage and renewal. Bootstrap ACME on the new address if required. Do not advertise unreachable AAAA records.
3. Build and identify the exact release, run migrations on an isolated restored database, and keep the prior image plus configuration for rollback. Preserve database backups and active recording state.
4. Load the new API configuration and exact release identity. Install private nginx includes and candidate configuration. Run `nginx -t`. Verify that existing VPN and prior ingress still work before starting HAProxy.
5. Validate HAProxy configuration, then start only `ingress443` with `compose.ingress443.yml`. Start/reload the reviewed coturn/LiveKit configuration in a controlled window after active calls and recordings are accounted for. Never use `docker compose down` for this cutover.
6. From an external network verify the normal HTTPS URL, valid certificate, HTTP redirect, login/cookie/CSRF flows, Google callback when configured, invite links, recording download signatures and SDK base URLs. Ensure no link redirects to `:8443` or the old preview hostname.
7. Test at least two actual devices on different networks. Force a TURN/TLS-only connection on 443 and inspect the selected ICE pair. Test normal UDP, blocked UDP, reconnection, screen sharing, host removal and old-token rejoin denial. Confirm VPN connectivity independently.
8. Run the target capacity and duration acceptance, record build/configuration fingerprints, then produce a fresh launch-readiness receipt. Tests of TLS routing or localhost clients alone do not satisfy the external media requirement.
9. Keep a monitored rollback window. Retire the preview ingress only after old links are redirected and external acceptance remains stable. Renewal must refresh nginx and coturn certificates without leaving stale private copies.

## Rollback

Before cutover retain the previous app image, deployment environment, nginx configuration, generated TURN/LiveKit files and DNS values. If acceptance fails, stop only the new `ingress443` service, restore the prior reviewed configuration and DNS, validate nginx, and restore the prior app/worker image as appropriate. The VPN IP/listener is not part of this change. Do not restore a database snapshot over newer user data merely to roll back code; use the migration compatibility assessment.

## Reproducible isolated test

`python3 scripts/test-ingress443.py` starts its own loopback-only high-port nginx instance and a uniquely named, bounded HAProxy container. Synthetic API, signaling, storage and TLS services check routing and trust boundaries. Only those owned test processes are removed in cleanup. It never reloads system nginx or touches production containers.

The 2026-11-03 run passed 18 checks, including all four client paths, authorized WebSocket upgrade, revoked/expired/unavailable admission denial, actual client-IP preservation, forged-header replacement, signed-object request preservation, read-only storage routing, HTTP redirect/ACME, unknown-SNI rejection and unsafe-input refusal. This is configuration evidence, not a claim that coturn allocations or external WebRTC calls have passed.

References: [nginx auth_request](https://nginx.org/en/docs/http/ngx_http_auth_request_module.html), [HAProxy PROXY protocol](https://www.haproxy.com/documentation/haproxy-configuration-tutorials/proxying-essentials/client-ip-preservation/enable-proxy-protocol/), and the installed LiveKit client 2.23.0 `src/api/utils.ts` / `src/api/SignalClient.ts` for the versioned entry points.
