# Closed main endpoints for the paid edge VPS

Status: **CANDIDATE_NOT_DEPLOYED**. The generator writes a new private staging
directory. It does not install a listener, assign an address, create a tunnel,
change DNS/firewall/routes, acquire certificates or reload any running service.
The application and its old ingress remain outside this preparation step.

The subsequent [HTTP/certificate slice](edge-http-certificates.md) adds two
explicit opt-ins: `EDGE_MAIN_ACME_PORT=18080` appends an approved source-restricted
raw HTTP bridge to loopback 18080, and `EDGE_MANAGED_TLS=true` selects the
versioned main certificate snapshot. With these inputs absent, the original
two-port bridge and Certbot-lineage nginx paths are preserved. The shared main
nginx never binds the tunnel address; only the separately ordered bridge does.

This is the main-host counterpart to [edge-vps-ingress.md](edge-vps-ingress.md).
The edge keeps public TCP 443. The main server receives two streams over an
independently configured authenticated transport:

| Main listener | Allowed source | Main backend | Bytes forwarded |
| --- | --- | --- | --- |
| `EDGE_MAIN_TUNNEL_IP:8445` | `EDGE_TUNNEL_LOCAL_IP/32` | `127.0.0.1:8445` | One existing edge PROXY v2 header, then the original TLS stream |
| `EDGE_MAIN_TUNNEL_IP:5349` | `EDGE_TUNNEL_LOCAL_IP/32` | `127.0.0.1:5349` | Original TURN TLS stream, without a PROXY header |

HAProxy rejects another TCP source at connection admission. It opens its backend
connection from `127.0.0.1`, and neither consumes nor adds a PROXY header. It does
not terminate TLS, inspect application messages or log requests. A single
PROXY prefix therefore reaches the same loopback-only nginx trust boundary;
coturn receives the native stream it expects.

The peer ACL is not encryption, interface confinement or a defense against an
attacker controlling the authorized edge. The host must separately restrict the
listener to the intended authenticated tunnel interface and peer, including
when that transport fails. An RFC1918 address alone proves none of those things.
The generator never selects real tunnel addresses or promises that they are
present, noncolliding or reachable.

## TLS-only nginx context

`scripts/ingress-nginx-tls.mjs` holds the shared protected TLS server blocks. The
existing single-host renderer calls that helper with its existing HTTP blocks.
The new main candidate calls it without HTTP. Its only listener is
`127.0.0.1:8445 ssl proxy_protocol`, including a default TLS rejection server.
No VPS address or public HTTP listener is placed on the main host.

The shared output preserves these existing contracts:

- nginx trusts PROXY addresses only from `127.0.0.1`; forwarded client-address
  headers are replaced, and the API still checks the private origin secret.
- Public `/api/internal/` requests are blocked. All four supported signaling
  entry paths use the internal admission check, retaining its token handling,
  revocation behavior, private headers and failure responses.
- Long-lived WebSocket upgrade handling and timeouts are preserved.
- Recording downloads keep the original signed Host, path and query. Only the
  private recording-object path supports read access; other storage paths fail.
- The two private include files remain separate from public configuration and
  from the secrets-free plan. Request URI and authorization logging stay off.

The new TLS-only nginx configuration and the complete single-host commercial
nginx configuration are alternatives. Do not include both in the same nginx
HTTP context: they contain the same map and TLS virtual hosts. Existing unrelated
8443/VPN configuration is not an output of this generator and must be handled by
the controlled installation/rollback plan.

## Inputs and private preparation

Supply every input required by the edge generator, unchanged: the two distinct
public IPv4 addresses, the two distinct literal RFC1918 tunnel IPv4 addresses,
canonical application and signaling origins, dedicated TURN/witness names,
explicit recording setting and enabled signaling admission guard. The complete
strict edge validation is reused, including hostname collisions and URL input
normalization rejection. The VPS public address is retained as plan metadata;
it is not bound or assigned on the main host.

The main candidate additionally requires:

| Input | Required meaning |
| --- | --- |
| `TLS_CERT_NAME` | Explicit reviewed certificate lineage, lowercase letters/digits/hyphens, at most 64 characters |
| `ORIGIN_PROXY_SECRET` | Existing intended API/nginx origin secret, 32–256 base64url characters |
| `LIVEKIT_SIGNALING_AUTH_SECRET` | Intended API/nginx signaling admission secret, 32–256 base64url characters |
| `S3_BUCKET` | Exactly `imon-recordings` when recording is enabled |

The two secrets must match the intended API configuration. This generator
validates their format; it does not create, rotate or install keys, and does not
establish their entropy or agreement with a running service. Keep them in the
operator's private configuration mechanism and do not put them on a command
line, in shell history or in an acceptance report.

With that reviewed environment available to the process:

```sh
node scripts/prepare-edge-main-ingress.mjs --output /absolute/new/private/staging-directory
```

The parent must exist and be operator-controlled, with stable ancestors. The
leaf is created exclusively with mode 0700; an existing file, directory or
symlink is refused. These mode-0600 files are created:

| File | Role |
| --- | --- |
| `haproxy-main.cfg` | Closed two-port byte-preserving bridge |
| `nginx.tls.conf` | Protected TLS-only nginx HTTP-context include |
| `imonmeets-commercial-trust.conf` | Private origin-secret header include |
| `imonmeets-signaling-auth.conf` | Private signaling-secret header include |
| `plan.json` | Written last; public config hashes and explicit pending gates |

The successful CLI output contains fixed status flags and public configuration
hashes only. It never prints secret values, private include hashes or raw
filesystem exceptions. A missing plan is incomplete generation. Exclusive leaf
creation does not protect an output parent that another writer can replace.

## Standalone bridge manifest

`compose.edge-main-ingress.yml` belongs only on the main host and is not an
application or edge-VPS overlay. Its `edge-main-candidate` profile and
`restart: "no"` avoid startup through ordinary default-profile use. Explicitly
targeting the service can still start it and remains a separate operational
action. `EDGE_MAIN_HAPROXY_CONFIG` must reference the exact reviewed absolute
configuration, installed root-owned with mode 0600.

The pinned HAProxy process starts as UID/GID 0 to read that private file and then
drops to its existing `haproxy` user/group. Only `SETUID` and `SETGID` are added;
there is no `NET_ADMIN` or low-port bind capability. The host-network container
has a read-only filesystem/configuration, no-new-privileges, 128 MiB memory and
swap bounds, 0.5 CPU, 32 PID limit and one HAProxy thread. Limits are not measured
capacity. No host path is auto-created and the manifest starts no nginx, coturn,
application or tunnel service.

Before installation, check existing listeners for both exact addresses/ports.
Do not resolve a collision by stopping the VPN, widening a bind or changing a
default route. Deploy the intended protected API first through its own reviewed
release process; merely setting the admission flag does not supply that backend.

## Verification and remaining gates

The focused suite passed **36/36 checks** in scratch, with no failures or skips.
The source and result receipt is
[verification/edge-main-ingress-20261103.json](verification/edge-main-ingress-20261103.json).
The suite also checks byte-for-byte preservation of 12 legacy outputs
across three fixtures captured from `f2cb148` before extracting the helper. It
includes recording on/off and the custom layout used by isolated acceptance.
Those hashes are fixed baseline evidence, not recomputed from the new renderer.
Future LiveKit acceptance receipts also hash the imported TLS renderer and the
small source-evidence collector, in addition to the generator entrypoint. The
historical monolithic generator override remains supported separately.

```sh
node --test scripts/test-ingress443-config.mjs scripts/test-edge-vps-ingress.mjs scripts/test-edge-main-ingress.mjs
```

These checks verify emitted contracts and private file behavior. They are not a
HAProxy/nginx runtime parser or a live source-ACL test. The historical 19-case
edge fixture and earlier single-host nginx acceptance do not accept this new
main bridge. The edge fixture's source pin and seven-file Docker COPY list now
include the explicit helper dependency. Its **11/11 fixture self-checks** passed
against implementation snapshot `07216f7`, and its generated edge configuration
is byte-identical to the historical fixture. Historical runtime receipts remain
unchanged; native edge routing was not rerun for this maintenance change.

Before public cutover, complete actual native syntax and two-hop TLS acceptance,
including wrong-source denial, unchanged PROXY v2 tuples, raw TURN bytes,
protected signaling and signed downloads. Then verify interface confinement,
tunnel loss, certificate coverage/renewal, the separate HTTP/ACME path, DNS,
witness enrollment, external media and long recording/resource bounds. Neither
the plan nor these pure checks marks any of those gates accepted.
