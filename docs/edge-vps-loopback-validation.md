# Isolated HAProxy loopback validation

Historical result for `f5eb135` on 2026-11-03:
**PASS_ISOLATED_FIXTURE_LOOPBACK_ONLY**. That unchanged candidate passed HAProxy
syntax checking, and **19 real TCP/TLS routing checks
passed** in a restricted, disposable Linux container on the Mac's local Docker
Desktop. This was a fixture derivative of the exact pinned official image.
The main server's privileged Docker access was not retried.

Scratch initially had Python, Node and OpenSSL but no HAProxy, Docker or Podman
runtime. Its blocked receipt is retained as an earlier environment result, not
the final routing outcome. Its **11 fixture self-checks** also passed.
Detailed evidence, source hashes and the runtime boundary are recorded in
[verification/edge-vps-loopback-harness-20261103.json](verification/edge-vps-loopback-harness-20261103.json).
This is an additional validation tool for the
[edge VPS candidate](edge-vps-ingress.md), not an ingress deployment.

The current harness source pin follows the reviewed TLS-helper extraction at
`07216f70401b22049ecd4e4ea6be3d6446787448`. The edge-generated fixture configuration
remains byte-identical; the new source dependency is pinned explicitly. This
maintenance change does not turn the historical runtime receipt into a new
native test or acceptance of the separate main bridge. See
[edge-main-ingress.md](edge-main-ingress.md) for that candidate and its pending
runtime boundary.

## Files and source identity

`scripts/verify-edge-vps-loopback.py` is a standalone Python program with no pip
dependencies. It uses the existing Node generator and invokes OpenSSL to create
short-lived local fixture certificates. It does not use Docker, sudo, cloud
APIs, DNS resolution, provider credentials, existing certificates or key files.

The current input source snapshot is commit
`07216f70401b22049ecd4e4ea6be3d6446787448`. The harness checks SHA256 for:

- `scripts/prepare-edge-vps-ingress.mjs`
- `scripts/prepare-ingress443.mjs`
- `scripts/ingress-nginx-tls.mjs`
- `compose.edge-vps-ingress.yml`

These source hashes were independently compared with `git show` for that commit.
An integration commit containing the same bytes is accepted: the harness does
not require its checkout HEAD to equal the candidate commit. Any changed source
requires a new review and an intentional update of the hashes.

The generator receives fixed synthetic `.example.test` names and fixture IPs.
The public and private fixture addresses are never assigned or contacted. The
original generated configuration is written as `candidate.cfg` and is only
passed to HAProxy's `-c` parser. HAProxy documents that `-c` exits before binding.

## Execution prerequisites

Use an isolated, authorized machine with:

- Python 3.10 or later, Node, and OpenSSL already available on PATH.
- A trusted, preinstalled HAProxy **3.0.x** executable. The harness records the
  executable SHA256 and `-vv` output; it does not fetch a binary or image.
- Existing OS user and group `haproxy`, so the **unaltered** candidate's
  `user haproxy` and `group haproxy` directives pass the original syntax check.
  The harness does not create users or groups. A failure here blocks the run.
- Permission to open ordinary loopback TCP sockets on ephemeral high ports.

The evidence directory must be a new absolute path under an existing,
operator-controlled parent. Existing directories are refused. No root
privileges are required by the loopback test itself, but an execution as UID 0
is recorded honestly and is not described as rootless. The scratch fixture run
used UID/EUID 0.

Run the actual runtime check only where that trusted runtime already exists:

```sh
python3 scripts/verify-edge-vps-loopback.py \
  --haproxy /absolute/path/to/haproxy \
  --output /absolute/new/edge-runtime-evidence
```

The default repository root is the parent of `scripts`. An explicit
`--repo-root /absolute/checkout` can be supplied. If HAProxy is absent, the
command produces a receipt with `BLOCKED_HAPROXY_RUNTIME_UNAVAILABLE` and exits
**2**, before opening fixture listeners or generating fixture keys.

On a shared host, any real runtime run must use the existing `imon-job` queue.
This document grants no additional host, container, service or privilege access.
In particular, it is not a replacement path around a denied main-server Docker
operation. The ordinary npm and pure CI commands do not invoke this harness.

## What the real runtime check will exercise

The harness first runs `haproxy -c` against the unchanged generated candidate.
It then creates a separate loopback configuration using exactly six checked
substitutions:

| Original element | Loopback substitution |
| --- | --- |
| `user haproxy` | Removed for the isolated process |
| `group haproxy` | Removed for the isolated process |
| Public bind on TCP 443 | `127.0.0.1` and an ephemeral high port |
| Main nginx destination and source | Local TLS fixture and loopback source; `send-proxy-v2` retained |
| Main TURN destination and source | Local TLS fixture and loopback source; no PROXY option added |
| Witness destination | Local TLS fixture on an ephemeral high port |

Every original line must match exactly once. The ACLs, route order, rejection
rules, TCP mode, timeouts and connection limits are preserved. Both generated
configuration hashes and every substitution are included in the receipt. A
second `-c` checks this adapted configuration before foreground `-db` startup.
Only this adapted configuration is ever started.

Three Python TLS fixtures model the wire contracts. They are not nginx, coturn
or the witness application. Each has a different temporary certificate and
response token. The client verifies the expected certificate chain and its
exact certificate hash, completes a TLS handshake and checks the response
token. Certificate hostname checking is disabled only for these synthetic
fixtures; the distinct pinned certificate is the backend identity oracle.
Successful delivery to the wrong TLS fixture cannot pass.

The real runtime scenario contains **19 checks**, all passed in the recorded run:

| Checks | Required observation |
| --- | --- |
| Five allowed names and uppercase application SNI | Expected backend, original SNI, correct certificate and response |
| Fragmented ClientHello for nginx, TURN and witness | Delayed TCP writes split the TLS record header and the SNI hostname; full TLS exchange still succeeds |
| Explicit TLS 1.2 for nginx and TURN | Full exchange; default clients also negotiate the runtime's supported TLS version |
| Foreign, suffix-confused, trailing-dot and absent SNI | EOF or reset, and zero backend connections |
| Plain HTTP, idle socket, truncated ClientHello and malformed TLS | EOF or reset within the preserved five-second inspection bound plus a two-second scheduling allowance; zero backend connections |

The nginx fixture requires the exact PROXY v2 signature, PROXY command,
TCP/IPv4 family and 12-byte address block before TLS. It verifies both original
client and frontend addresses **and ports**. The TURN and witness fixtures
require TLS bytes at the start of the stream and reject a PROXY prefix.

Backend TCP accepts are counted before TLS parsing. A failed handshake alone
does not qualify as a rejection. A client-side timeout is a failure, not proof
of fail-closed behavior. Per-case counts and a final exact count of nginx **6**,
TURN **3**, witness **2** catch stray or delayed backend connections. HAProxy is
terminated and reaped after the run, fixtures close their sockets, and the
temporary certificates and private keys are removed.

## Fixture self-check and present evidence

The fixture infrastructure can be tested without HAProxy:

```sh
python3 scripts/verify-edge-vps-loopback.py \
  --self-test \
  --output /absolute/new/edge-fixture-evidence
```

The **11 fixture checks** cover direct TLS to all three receivers, a genuinely
fragmented ClientHello, TLS 1.2, rejecting PROXY bytes at TURN and witness,
rejecting missing/invalid PROXY framing at nginx, and rejecting a wrong backend
certificate. They make only loopback connections and use fresh disposable
fixture keys. The self-check status is `PASS_FIXTURE_SELF_CHECK_ONLY`; all
HAProxy runtime gates remain `PENDING`.

The earlier blocked receipt and fixture receipt are kept together with the
subsequent real HAProxy result in the tracked evidence file. The first two do
not certify HAProxy. The separate Mac runtime receipt contains the 19 actual
HAProxy checks, parser results and exact backend accept counts.

## Recorded Docker fixture execution

The Mac's `desktop-linux` context was checked to use a local Unix socket, and
Docker Desktop 29.5.3 reported Linux/amd64. Its daemon was started normally;
no Docker policy or sign-in dialog was accepted. This is a different machine
and execution boundary from the denied privileged main-server Docker action.

The build context contained only six explicit files: the three files under
`scripts` used by this harness, `compose.edge-vps-ingress.yml`, and the two
files under `tools/edge-vps-loopback`. No whole checkout, environment file,
credential, certificate or user directory was sent to Docker.

`tools/edge-vps-loopback/Dockerfile` derives from the exact pinned official
HAProxy image and adds only the official Alpine packages `python3`, `openssl`
and `nodejs` for the fixtures. `image-provenance.py` records the original binary
and the original files under `/lib` and `/usr/lib` before and after installation.
It fails the build if the HAProxy executable changes.

Observed runtime:

| Property | Recorded value |
| --- | --- |
| HAProxy | `3.0.30-47d806b`, build date 2026-10-14 |
| HAProxy binary SHA256 | `d1e3d6d9f2b113705f24a155863898e54efd2a0fe729c6ba6d7d67f4d54ecca1` |
| Fixture image ID | `sha256:8ba7bd2d4d7eba067d8b5e6137100676c67f6d6bff967e932770fda203150f68` |
| Original scanned files | 21; only `/lib/apk/db/installed` and `/lib/apk/db/scripts.tar.gz` changed |
| Node | `24.22.1` |
| OpenSSL | `3.5.9` |
| Process UID/GID | `65534:65534` |
| Network | `none`, with only in-container loopback |
| Host port publication / host data mounts | None |
| Root filesystem | Read-only |
| Capabilities | All dropped; none added |
| Privilege escalation | `no-new-privileges` |
| Limits | 256 MiB memory and memory+swap ceiling, 0.5 CPU, 64 PIDs |
| Writable area | `/tmp` tmpfs, 64 MiB, `nosuid,nodev,noexec` |

All original shared-library files in the scanned directories remained unchanged.
The two differing files are Alpine package-manager metadata. The actual
container settings were inspected before startup. All temporary containers were
removed afterwards; no broad image, volume or container cleanup was used.

There were two runs on the same immutable fixture image and harness bytes. The
first passed all 19 checks, but copying its `/tmp` evidence after container exit
failed because the tmpfs no longer existed. Its successful console summary is
retained. A single repeat exported the complete evidence archive through stdout
**before** exit. This second full receipt supplies the detailed acceptance
evidence. No production changes or external requests occurred in either run.
An intermediate container never started because an optional logging setting was
invalid. It was removed, and the successful repeat restored the first run's
default logging settings. This setup failure is retained separately and is not
counted as a test execution or a passing run.

For a later authorized reproduction, construct a context from the current
explicit seven-file allowlist, which adds the extracted TLS helper, rather than
passing the entire repository to `docker build`:

```sh
tar -cf - \
  scripts/prepare-edge-vps-ingress.mjs \
  scripts/prepare-ingress443.mjs \
  scripts/ingress-nginx-tls.mjs \
  scripts/verify-edge-vps-loopback.py \
  compose.edge-vps-ingress.yml \
  tools/edge-vps-loopback/Dockerfile \
  tools/edge-vps-loopback/image-provenance.py |
docker --context desktop-linux build --platform linux/amd64 \
  --file tools/edge-vps-loopback/Dockerfile \
  --tag imon-edge-loopback-fixture:unique-validation-run -
```

Use a new operator-owned tag/container name, resolve the resulting image ID,
and run that immutable ID with the recorded restrictions above. Do not publish
ports, attach a Docker socket or mount existing user/production data. Package
download belongs to the build phase; the validation container must have
`--network none`. Export `/tmp/runtime-evidence` while the process is still
running or through stdout before it exits; `docker cp` after exit cannot recover
tmpfs contents. Keep the original image provenance separately. The tracked
receipt includes the exact export-wrapper hash and artifact hashes used here.

## Remaining acceptance boundary

The successful native HAProxy run reports
`PASS_NATIVE_LOOPBACK_ROUTING_PINNED_IMAGE_PENDING`. It can establish the
unchanged candidate's parser acceptance in that native environment and the
adapted configuration's local routing behavior. It cannot establish the exact
pinned container's startup, user/group transition, capabilities, mount
permissions or resource limits. The pinned image remains:

```text
haproxy:3.0-alpine@sha256:f06f6cc1c25c7071e62d955d8e67a33d6935066ced8fac496cdd0ad9ffdd17f3
```

The recorded fixture establishes the official binary's original syntax and
loopback routing behavior, with its original scanned shared libraries. It is
still a derivative image running an adapted loopback configuration. Acceptance
of the untouched deployment image's actual startup, privilege transition,
mounts, bind addresses and capabilities remains pending. The harness never
claims image identity from a version string. No existing privileged Docker
denial should be retried or bypassed to obtain additional evidence.

The following remain outside this local test: real tunnel routes and loss
behavior, main-side nginx client-IP/admission/signed-object handling, coturn
allocation and external media, witness enrollment or recovery, VPN continuity,
public DNS, public port 443, trusted public certificates and renewal, recording
acceptance and measured VPS capacity. All related acceptance flags remain false.

Protocol references:
[HAProxy 3.0 management guide](https://docs.haproxy.org/3.0/management.html)
for `-c` and `-db`, and the
[PROXY protocol specification](https://www.haproxy.org/download/3.0/doc/proxy-protocol.txt)
for binary v2 framing and TCP/IPv4 address fields.
