# Edge VPS TLS ingress candidate

Status: **CANDIDATE_NOT_DEPLOYED**. This is an isolated alternative for the
already-purchased VPS IPv4, not evidence that the public port 443 blocker has
been resolved. The VPS remains **STAGED_NOT_ENROLLED**. No listener, tunnel,
route, firewall rule, certificate, DNS record, key or witness authority is
created by this change.

The provider and host review established two different addresses:

| Address        | Role                                                   |
| -------------- | ------------------------------------------------------ |
| 94.249.186.240 | Existing primary server and VPN address                |
| 94.249.188.77  | Already-purchased small VPS, proposed external ingress |

This candidate makes no new purchase. It leaves the existing
`scripts/prepare-ingress443.mjs` and `compose.ingress443.yml` unchanged. Their
single-host acceptance does not certify this two-host path. Application, nginx,
LiveKit, coturn and recording storage stay on the primary server; this candidate
does not migrate them or change the deployed application revision.

## Fixed transport contract

`scripts/prepare-edge-vps-ingress.mjs` generates a HAProxy configuration and a
secrets-free routing plan. Its only public listener is the declared VPS IPv4 on
TCP 443. It routes the original client TLS stream using exact, distinct SNI
names:

| SNI role                                   | Expected destination           | Prefix before the client TLS bytes |
| ------------------------------------------ | ------------------------------ | ---------------------------------- |
| Application, signaling, enabled recordings | Declared main tunnel IPv4:8445 | PROXY protocol v2                  |
| TURN                                       | Declared main tunnel IPv4:5349 | None                               |
| Witness                                    | VPS loopback 127.0.0.1:8446    | None                               |

The two remote connections use the declared local tunnel IPv4 as their source.
The local witness connection does not inherit that source. HAProxy neither
terminates TLS nor adds another TLS layer to backend connections. It receives
no application, TURN, witness or certificate secrets. Missing and unknown SNI
have no default backend; ClientHello inspection has a five-second bound. SNI
selects a destination and does not authenticate the client.

The closed transport is an **operator-provided prerequisite**, not a resource
discovered or created by the generator:

1. Select noncolliding tunnel addresses only after inspecting both hosts'
   interfaces, routes and private Docker/VPN networks. Both inputs must be
   distinct literal RFC1918 IPv4 addresses. No concrete tunnel addresses have
   been selected for these hosts. Public, loopback, link-local, CGNAT, multicast,
   unspecified, IPv6, hostname and noncanonical numeric inputs are rejected.
2. Independently enforce and verify that both remote destinations are reachable
   only through the intended authenticated, protected transport, including when
   that transport fails. **A private address and HAProxy source binding do not
   create or prove tunnel confinement.** Routing and firewall enforcement remain
   unimplemented and unaccepted. There is no public-address fallback.
3. The main-side tunnel endpoints must deliver unchanged TCP bytes to the
   reviewed candidate's loopback nginx TLS:8445 and coturn TLS:5349. Assigning a
   tunnel interface alone does not provide these endpoints. Their listener or
   forwarding configuration is not part of this patch. Preserve the PROXY v2
   prefix to nginx and its existing restricted trust boundary; do not expose
   API:3540, signaling:7880 or S3:8333 publicly. Do not widen nginx trust or bind
   private listeners to all interfaces as a shortcut.
4. Nginx must still perform the accepted signaling admission checks, preserve
   signed recording Host/path/query values and block internal application
   routes. A declared signaling flag does not prove the running backend does so.
   Existing production is not assumed to provide the candidate endpoints.
5. Coturn and its relay address remain on the main server. The public TURN name
   may eventually point at the edge, but changing `LIVEKIT_PUBLIC_IP` to the VPS
   address or moving coturn is outside this contract.
6. Witness needs its own valid TLS wrapper bound only to VPS loopback:8446,
   forwarding to the existing witness HTTP loopback:3551. This wrapper, its
   certificate and renewal are not generated here. The raw witness HTTP port
   must never be used as this TLS backend. Initialization, keys, enrollment and
   recovery acceptance remain governed by [deletion-witness.md](deletion-witness.md).

## Inputs and generation

All fields are explicit, apart from the fixed ports above:

| Input                            | Required meaning                                          |
| -------------------------------- | --------------------------------------------------------- |
| `EDGE_PUBLIC_IP`                 | Assigned public unicast IPv4 of the edge VPS              |
| `VPN_PUBLIC_IP`                  | Different existing public IPv4, retained only in the plan |
| `EDGE_TUNNEL_LOCAL_IP`           | Reviewed RFC1918 source address on the VPS                |
| `EDGE_MAIN_TUNNEL_IP`            | Different reviewed RFC1918 endpoint on the primary host   |
| `APP_URL`                        | Canonical `https://` application origin                   |
| `LIVEKIT_URL`                    | Canonical `wss://` signaling origin                       |
| `TURN_PUBLIC_HOST`               | Dedicated TURN DNS hostname                               |
| `EDGE_WITNESS_HOST`              | Dedicated witness DNS hostname                            |
| `RECORDING_ENABLED`              | Exactly `true` or `false`                                 |
| `S3_PUBLIC_ENDPOINT`             | Canonical `https://` recording origin when enabled        |
| `LIVEKIT_SIGNALING_AUTH_ENABLED` | Exactly `true`, declaring the required backend contract   |

Origins have no credentials, query, fragment, path or explicit port. An optional
root slash is accepted. ASCII/punycode hostname input is normalized to lowercase
before uniqueness checks; wildcards, trailing dots, IP literals, non-ASCII names
and configuration-control characters are rejected. Public-address validation
conservatively excludes special-purpose ranges; it does not verify allocation.

After the two tunnel-address variables below have been independently reviewed,
this command only writes a new staging directory. It does not contact either
host or verify DNS:

```sh
EDGE_PUBLIC_IP=94.249.188.77 \
VPN_PUBLIC_IP=94.249.186.240 \
EDGE_TUNNEL_LOCAL_IP="${REVIEWED_EDGE_TUNNEL_IP:?Review the actual tunnel source first}" \
EDGE_MAIN_TUNNEL_IP="${REVIEWED_MAIN_TUNNEL_IP:?Review the actual tunnel endpoint first}" \
APP_URL=https://meets.imon.world \
LIVEKIT_URL=wss://rtc.imon.world \
TURN_PUBLIC_HOST=turn.imon.world \
EDGE_WITNESS_HOST=witness.imon.world \
RECORDING_ENABLED=true \
S3_PUBLIC_ENDPOINT=https://recordings.imon.world \
LIVEKIT_SIGNALING_AUTH_ENABLED=true \
node scripts/prepare-edge-vps-ingress.mjs --output /absolute/new/staging-directory
```

The parent directory must exist and be operator-controlled, with stable ancestors
that another writer cannot rename or replace during generation. Exclusive leaf
creation is not protection against concurrent parent-path replacement. The
generator refuses existing output files,
directories and symlinks. It writes `haproxy.cfg` and `plan.json` with mode 0600
inside a new directory with mode 0700. Only the completed plan with a matching
configuration SHA256 is a generation receipt; a missing plan is incomplete.
Diagnostics contain fixed codes and no input values or filesystem error text.
The plan keeps deployment, tunnel, DNS, certificate, witness, media and public
443 acceptance flags false even after successful generation.

## Runtime candidate and exclusions

`compose.edge-vps-ingress.yml` is a separate VPS deployment file. It must not be
merged with the application's Compose files. The `edge-candidate` profile and
`restart: "no"` prevent an ordinary default-profile startup from silently
activating it; explicitly targeting the service can still start it and is a
separate operational action. The required `EDGE_HAPROXY_CONFIG` must identify
the exact reviewed configuration, installed root-owned with mode 0600 for the
root-start/drop-privilege HAProxy process. The manifest explicitly selects UID/GID
0:0 for reading this file before the configured drop to the image's `haproxy`
user/group; it does not rely on the image's default user. Generation itself does
not install it.
The mount is read-only and `create_host_path` is false.

The image digest is shared with the accepted single-host HAProxy candidate.
The container has no `NET_ADMIN` capability, a read-only root filesystem, a
128 MiB memory limit, 0.5 CPU limit and a 32-process limit. The candidate uses one
HAProxy thread and at most 256 connections. These are resource bounds, not
measured capacity. Witness retains a separate service, storage and authority.
Sharing its VPS with ingress introduces a common availability and compromise
domain; resource exhaustion or VPS loss can also block deletion ACKs. This
requires explicit operational acceptance and does not establish physical
independence inside the provider.

**HTTP port 80, redirects, ACME bootstrap and certificate renewal are not included.**
The original single-host generator also binds its HTTP listener to its ingress
IP. Do not install that output on the primary server with the VPS address.
A reviewed certificate/renewal and HTTP/ACME design is still required before DNS
cutover. No main-side nginx, coturn or witness TLS configuration is installed by
this patch.

## Evidence and remaining gates

Pure checks run without sockets, Docker, network access or shared-server jobs:

```sh
node --test scripts/test-edge-vps-ingress.mjs
```

The tests exercise unsafe address classes, input injection, collisions, explicit
settings, the emitted routing table and wire-format choices, secret omission,
private output and refusal to overwrite operator files. Their static routing
oracle is not a HAProxy parser and does not emulate actual TLS handshakes.
See [verification/edge-vps-ingress-20261103.json](verification/edge-vps-ingress-20261103.json)
for the focused receipt and unchanged original-file hashes.

Pending gates, none satisfied by successful generation:

1. Exact pinned HAProxy syntax validation and isolated real TCP/TLS routing,
   including fragmented/missing/foreign SNI and delivery of PROXY v2 only to
   nginx. Shared-host runtime checks must use the existing `imon-job` queue.
2. Actual tunnel routes, access controls and tunnel-loss behavior, with no public
   fallback or interference with the existing VPN/default route.
3. Main-side endpoints and preserved client IP, admission failure behavior,
   signed recordings, long-lived WSS and reconnect behavior.
4. HTTP/ACME, valid certificates and renewal, DNS review/cutover, independent
   verification that the existing VPN remains functional.
5. Witness initialization/enrollment, durable ACK and recovery on the real
   independently operated storage, with its approved key custody.
6. External TURN443 media, constrained networks/devices, VPS resource/traffic
   capacity, and the outstanding long recording acceptance.

The small VPS remains staged. This candidate must not be reported as a live
ingress, a completed witness, or a resolution of commercial-launch gates.

References: [HAProxy 3.0 configuration manual](https://docs.haproxy.org/3.0/configuration.html)
for TCP inspection, server `source` and `send-proxy-v2`;
[IANA IPv4 special-purpose registry](https://www.iana.org/assignments/iana-ipv4-special-registry/)
for address categories; [existing ingress contract](ingress443.md) for the main
application's protected routing behavior.
