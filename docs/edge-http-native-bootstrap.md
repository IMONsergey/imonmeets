# Dedicated native HTTP bootstrap

Status: **CANDIDATE_NOT_DEPLOYED**. This is an explicit operations-only path for
establishing HTTP-01 delivery before the final application environment, renewal
context or main Docker execution path is available. It does not import an image,
issue a certificate, install files, open a listener or change DNS. The immutable
application release remains `05cc907784afe09c156026cc822d3f6bf08bd4c3`; this later
operations source must be identified separately in the deployment receipt.

`prepare-edge-http-bootstrap.mjs` emits six nonsecret configurations/units and
`plan.json`. There are no certificate paths, TLS includes, Certbot configuration,
renewal hooks/timers, witness receiver or application/Compose commands. The full
`prepare-edge-certificates.mjs` output remains byte-identical to the original
05cc source for the captured fixtures, including its complete plans. HTTP route
rendering is shared so the edge challenge behavior cannot silently diverge.

## Topology and inputs

| Role | Dedicated listener | Caller / destination |
| --- | --- | --- |
| Main | `10.203.77.2:18080` | Actual peer `10.203.77.1` only; static `/var/lib/imonmeets-acme` |
| Edge HTTP | `94.249.188.77:80` | Main-name challenges to `10.203.77.2:18080`, explicitly sourced from `10.203.77.1` |
| Edge witness challenge | Same public HTTP listener | Static `/var/lib/imonmeets-witness-acme`, no receiver proxy |

The dedicated main nginx has no inherited/global configuration and no PROXY or
real-IP directives. A server-level check uses the actual `$remote_addr`, including
before early 404/405 responses. The valid challenge location additionally has
`allow 10.203.77.1/32; deny all`. Both protections are supplementary to the already
commissioned transport and its interface/source/port guard; neither replaces it.

The existing main HTTP handler for `meets.imon.world` continues to serve the same
main webroot on public port 80. Keep its A record on `94.249.186.240` during
bootstrap. Main private 18080 is owned by a separate process/service, so shared
nginx startup and the existing VPN/public 443/8443 remain independent of WG.

Supply only the public topology inputs. The Node process must use the reviewed
Node 24 runtime and an isolated checkout of the new operations source, not the
unchanged 05cc application worktree. After those two absolute paths are recorded,
the generator argv is:

```sh
env \
  EDGE_PUBLIC_IP=94.249.188.77 \
  VPN_PUBLIC_IP=94.249.186.240 \
  EDGE_TUNNEL_LOCAL_IP=10.203.77.1 \
  EDGE_MAIN_TUNNEL_IP=10.203.77.2 \
  EDGE_MAIN_ACME_PORT=18080 \
  APP_URL=https://meets.imon.world \
  LIVEKIT_URL=wss://rtc.imon.world \
  TURN_PUBLIC_HOST=turn.imon.world \
  EDGE_WITNESS_HOST=witness.imon.world \
  RECORDING_ENABLED=true \
  S3_PUBLIC_ENDPOINT=https://recordings.imon.world \
  LIVEKIT_SIGNALING_AUTH_ENABLED=true \
  "$REVIEWED_NODE" "$OPS_SOURCE/scripts/prepare-edge-http-bootstrap.mjs" \
  --output "$NEW_PRIVATE_STAGING"
```

The admission flag validates the intended topology only; this command does not
activate admission in the old application. The generator never reads private
environment values, certificate material or renewal contexts. Output creation
is exclusive, directory mode 0700, files 0600, with the manifest written last.
Existing directories/files/symlinks are refused. Use an operator-controlled
parent; no recursive parent creation or existing-file replacement occurs.

## Exact installation boundary

Installation is a separately reviewed action. Before it, check the exact
destination files, unit names, public/private listeners and assigned IPs again.
An existing file or unit must cause a review, not an overwrite. The current
transport's three-port allowlist needs no modification for HTTP bootstrap.

| Candidate | Install on | Destination |
| --- | --- | --- |
| `nginx.main.conf` | Main | `/etc/imonmeets-http-bootstrap/main/nginx.conf` |
| `nginx.main-http.conf` | Main | `/etc/imonmeets-http-bootstrap/main/http.conf` |
| `imonmeets-main-acme-bootstrap.service` | Main | `/etc/systemd/system/imonmeets-main-acme-bootstrap.service` |
| `nginx.edge.conf` | Edge | `/etc/imonmeets-http-bootstrap/edge/nginx.conf` |
| `nginx.edge-http.conf` | Edge | `/etc/imonmeets-http-bootstrap/edge/http.conf` |
| `imonmeets-edge-http-bootstrap.service` | Edge | `/etc/systemd/system/imonmeets-edge-http-bootstrap.service` |

The new `/etc/imonmeets-http-bootstrap` parent and role directory are root-owned
0755; installed nonsecret configurations and units are root-owned 0644. Candidate
0600 files cannot simply retain that mode because both services run as www-data.
Do not change permissions on the existing private `/etc/imonmeets` tree. The
main webroot and its challenge files must already be readable by www-data;
inspect the exact paths and do not recursively chown/chmod that existing root.
Create only the new edge witness webroot/challenge subdirectories as root-owned,
readable directories. Certificate material never belongs in these webroots.

Both services run foreground nginx with their own prefix, PID, RuntimeDirectory
and all five temp paths. Main has no capabilities; edge has only
`CAP_NET_BIND_SERVICE` for port 80. `NoNewPrivileges`, a read-only system view,
read-only webroot, private temporary space, 128 MiB/50% CPU/32-task limits are
explicit. Critical startup/configuration errors go to stderr/journal. Each
server suppresses request/access/error URI logging. There is no global
`nginx -s`, ExecReload, package/default-site include or implicit configuration
test. systemd sends SIGQUIT only to the owned foreground master/cgroup.

On edge, nginx is the only new runtime prerequisite for this HTTP-only slice.
Node can generate both hosts' files on main; Certbot/Node on edge are later
certificate prerequisites. Review the exact official package transaction and
suppress package-maintainer auto-start before installing nginx. Keep the stock
edge `nginx.service` masked/inactive so its distribution default site cannot
claim port 80. Preserve any pre-existing package policy exactly. Never mask or
modify the already active shared `nginx.service` on main.

After reviewed installation and unit grammar validation, the bounded starts are
`systemctl start imonmeets-main-acme-bootstrap.service` on main and
`systemctl start imonmeets-edge-http-bootstrap.service` on edge. They require,
bind to and start after `imon-meets-transport.service`. Do not enable boot startup
until current-host acceptance passes. No shared nginx reload is needed.

**`nginx -t` can bind/listen.** The earlier native receipt did not satisfy a
non-listening boundary. Do not rerun that harness as a read-only check. Any new
native parser attempt must explicitly allow socket operations on the assigned
host/address/owned port; these units perform their normal parse during the
separately authorized actual start. Successful `systemctl start` alone does not
establish a listening/healthy HTTP service; obtain the probes below.

## HTTP acceptance before changing meets A

Create a fresh harmless 22–128-character base64url probe filename and short body
under each intended `webroot/.well-known/acme-challenge/` using exclusive file
creation. Record only its digest and observed statuses; remove only the exact
owned probe files in a cleanup/finally step. No real ACME account token, user
request, Authorization header or existing file is needed.

1. From outside the intended HTTP process, request the main probe through
   `http://meets.imon.world/...` pinned to main `94.249.186.240`; require 200 and
   the expected body. This accepts the unchanged public-main challenge path.
2. Pin each of meets/rtc/recordings/turn to edge `94.249.188.77` with curl
   `--resolve <host>:80:94.249.188.77 --noproxy '*' --path-as-is`. Require 200 and
   that same main probe body. Pinning meets to edge tests the future route
   without changing its A record. HEAD must return 200 without a body.
3. Pin witness to edge and require its separate local probe body. Test the
   private route from edge with source `10.203.77.1`, Host `rtc.imon.world` and
   destination `10.203.77.2:18080`. A main-local request to its own private IP is
   deliberately blocked by the transport and is not a substitute.
4. Against the new handlers, unknown Host, missing token, query suffix, encoded
   path and normalized path aliases must return 404; POST to a valid challenge
   must return 405. On main private 18080, `/api/health` and `/` return 404. On
   edge a normal known-host path returns the fixed HTTPS 308, never general
   forwarding. Spoofed real/forwarded-address headers cannot change the actual
   peer admission. Use bounded timeouts and `--path-as-is` for negative paths.
5. Check exact sockets and owned main PIDs, plus unchanged main public
   80/443/5349/8443 and 8443 `/api/health` HTTP 200. Test dedicated service stop
   without affecting shared nginx. At an approved lifecycle gate, transport
   stop must stop its dependent HTTP service and fail closed. After normal
   transport start, explicitly start its HTTP consumer; BindsTo does not provide
   automatic consumer recovery or a WireGuard handshake watchdog.

The authoritative DNS gate is independent: both ns1.reg.ru and ns2.reg.ru must
return the intended A records, with no conflicting AAAA; inspect child and parent
CAA before issuance. At 17:29Z the read-only inventory still saw NXDOMAIN for the
four new names; the coordinator's later 17:37Z authoritative check confirmed
them on both servers. The earlier receipt is historical, not current DNS state.
Public HTTP reachability, including any provider/host firewall restriction,
remains an actual probe requirement and is not inferred from DNS alone.

## Explicit ownership handoff and later certificate/application work

Port 18080 has one owner. Do not start the full main bridge while this native
service owns `10.203.77.2:18080`. The eventual full bridge binds all three private
ports, 5349/8445/18080, not just ACME. During a controlled handoff with no in-flight
issuance, prepare the existing full loopback `127.0.0.1:18080` handler, stop the
native main bootstrap unit, start the separately accepted bridge and repeat the
HTTP probe. On failure, stop only that bridge and explicitly restart the native
main bootstrap unit. Disable the retired unit only after ownership is verified;
never leave two boot-enabled owners for the same private bind.

The edge HTTP-only service also differs from the eventual full edge nginx service
that adds witness TLS. They cannot both own public port 80. Transfer that listener
with an explicit stop/start and repeat the HTTP probes; retain an exact rollback
to the previously accepted owner.

Issuance, initial managed snapshots, protected TLS, TURN, renewal timers, witness
enrollment and the application A switch remain separate transitions. Final
renewal contexts must name the actual private env/ordered Compose/TURN paths and
root-owned code, with isolated Certbot directories. Never fabricate those values
to obtain HTTP output. Main initial TURN preparation needs explicit
`TURN_OUTPUT_DIR`; its defaults are code-relative. The immutable CI application
image is still unimported, and HTTP readiness does not resolve the existing
Docker queue/access restriction or authorize a bypass.

Before the eventual meets A switch, preserving the main 8443 listener alone is
not enough for clients that resolve `meets.imon.world:8443`: verify the offsite
Mac monitor's effective origin/address pin and a fresh automatic backup,
recording and health cycle as a separate cutover gate.

## Verification

The focused tests cover the new contract and the existing ingress/certificate
suite. Frozen pre-refactor evidence checks all 39 full-candidate file hashes and
three complete-plan hashes across recording on/off and the planned topology;
the earlier single-host golden outputs also remain covered. Tests use synthetic
runtime contexts only inside the historical full-output regression fixtures.
The actual HTTP-only builder never reads or requires those contexts.

```sh
node --test scripts/test-edge-http-bootstrap.mjs scripts/test-edge-certificates.mjs \
  scripts/test-edge-main-ingress.mjs scripts/test-edge-vps-ingress.mjs \
  scripts/test-ingress443-config.mjs
```

These checks do not start native nginx/systemd or accept real source ACLs,
capabilities, webroot permissions, HTTP delivery or boot behavior. Preserve those
limits in the deployment receipt and keep all generated acceptance flags false
until the appropriate actual-host evidence exists.

The source-bound local result and planned-output hashes are recorded in
[verification/edge-http-native-bootstrap-20261103.json](verification/edge-http-native-bootstrap-20261103.json).
