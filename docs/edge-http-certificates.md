# Edge HTTP, ACME and witness TLS bootstrap

Status: **CANDIDATE_NOT_DEPLOYED**. Generation creates only a new private staging
directory. It does not issue certificates, install hooks/units/configuration,
change DNS, start listeners, enroll the witness or reload any running service.
The implementation uses Node built-ins, the existing TURN preparation script,
and the operator's already installed nginx/Certbot/Compose tools.

When the final renewal context or main Docker path is not ready, the separate
[native HTTP-only bootstrap](edge-http-native-bootstrap.md) can prepare just the
HTTP challenge path. It uses its own main and edge nginx services, no TLS files
or certificate hooks, and requires explicit ownership handoff before a future
main bridge binds port 18080. The full candidate described below is unchanged.

## Observed starting point and bootstrap order

Read-only main-host inspection on 2026-11-03 found nginx 1.24.0 listening on
`94.249.186.240:80`. Its existing `meets.imon.world` HTTP virtual host serves
`/var/lib/imonmeets-acme` for HTTP-01 and returns 404 otherwise. Other projects
and preview names have separate virtual hosts on that same address. No existing
HTTP configuration needs replacement for this bootstrap.

The existing application serves TLS on `94.249.186.240:8443`, using the
`/etc/letsencrypt/live/meets-imon-world` lineage. Public TLS inspection returned
only `meets.imon.world` in its SAN, with expiry 2027-01-31. The preview lineage
covers only its two sslip names. Certificate files were not readable by the
ordinary user; only the already served public certificates were inspected.
Private keys and private nginx include contents were not read.

The new main certificate can therefore be obtained **before changing the
application A record**:

1. Keep `meets.imon.world` on the main public IP. Keep the existing main HTTP
   challenge handler and webroot. Review all existing A/AAAA records; an old AAAA
   record must not send validation to an unprepared IPv6 endpoint.
2. Commission the separately reviewed transport and its exact peer restrictions.
   TCP **18080** was explicitly approved with transport/root, in addition to
   5349 and 8445. For the reviewed allocation this means edge `10.203.77.1` to
   main `10.203.77.2` through `wg-meets`. No other port was added.
3. Prepare the new main bridge with `EDGE_MAIN_ACME_PORT=18080`. It appends a
   third raw TCP frontend, binding only the main tunnel address and admitting
   only the edge `/32`, forwarding from `127.0.0.1` to `127.0.0.1:18080`.
   With this input absent the original two-port output is unchanged.
4. Include `nginx.main-acme.conf` in the existing main nginx HTTP context after
   reviewing its name/listener collisions and passing `nginx -t`. It listens
   **only on loopback 18080**. The system nginx can therefore boot without the
   tunnel address. The private-address bridge, not the shared nginx service,
   depends on the transport unit. Do not enable global `ip_nonlocal_bind`.
5. On the edge, install only the dedicated HTTP root/config and service first,
   with an empty TLS include directory. The service requires and binds to
   `imon-meets-transport.service`. It never loads the distribution's default
   public site. Its main challenge proxy explicitly binds the private edge
   source address; it has no public fallback or DNS-resolved upstream.
6. Prepare the new RTC, TURN, recording and witness A records on the edge. Check
   HTTP challenge delivery through each intended path with fresh harmless probe
   tokens. The application probe still travels directly to the existing main
   webroot. A main-local request to its own private address is not a substitute
   for a peer-path test and is deliberately blocked by the transport guard.
7. Run the host's exact `plan.commands.<role>.issueDryRun` argv, then the reviewed
   `issue` argv. These use webroot-only `certonly`, without an installer, deploy
   hook or service changes. The main request covers the application, RTC,
   recording and TURN names together. Its challenge files all live on main;
   the edge forwards only the other names' read-only challenge requests there.
   The witness request and its key stay on the edge.
8. Run the exact `stageInitial` argv on each host. It validates the certificate,
   exact SAN set, dates and matching key, creates a private immutable snapshot
   and publishes `current`. It performs no service action and refuses an existing
   current snapshot. The parent `/etc/imonmeets/tls` must already be private and
   operator-controlled. Public CA-chain/served-certificate acceptance is separate.
9. Generate main TLS with `EDGE_MANAGED_TLS=true`; it reads the managed main
   snapshot. Prepare the intended TURN runtime with the existing generator and
   `TURN_CERTIFICATE_DIR=/etc/imonmeets/tls/main/current`. Install the witness TLS
   include only after its snapshot exists. Validate both nginx configurations
   and the bounded two-hop HTTPS/TURN/witness paths before public app cutover.

Certificate bootstrap does not authorize witness initialization/enrollment or an
application release. The production rollout, deletion authority transition and
external media/recording checks remain coordinated by the release operator.

## Candidate inputs and outputs

Run `node scripts/prepare-edge-certificates.mjs --output /absolute/new/staging`
with the reviewed environment available through the private operator mechanism.
The generator reuses the full strict edge input contract, including IP/origin/
SNI collisions and the explicit recording/admission settings. It additionally
requires:

| Input | Meaning |
| --- | --- |
| `EDGE_MAIN_ACME_PORT` | Exactly `18080`, the approved transport extension |
| `EDGE_MANAGED_TLS` | Exactly `true` for this certificate lifecycle |
| `TLS_CERT_NAME` | New main certificate name in its dedicated Certbot directory |
| `EDGE_WITNESS_TLS_CERT_NAME` | A distinct witness certificate name |
| `ACME_EMAIL` | Reviewed ACME account contact; included only in private candidate config |
| `EDGE_MAIN_RENEWAL_CONTEXT` | JSON with explicit node/code/project/environment/Compose/TURN paths |
| `EDGE_WITNESS_RENEWAL_CONTEXT` | JSON with explicit `node` and `codeDirectory` |

The main context contains exactly `node`, `codeDirectory`, `projectDirectory`,
`projectName`, `envFile`, `composeFiles` and `turnDirectory`. All paths must be
absolute and safe as literal argv; `composeFiles` is an explicit ordered list.
The environment file must be the effective private production configuration,
including TURN identity and preserved settings. It is not an implicit `.env`.
The code directory must contain the reviewed renewal/policy scripts and the
unchanged, hash-checked `prepare-turn.mjs`. Copy no private environment content
into source, command arguments, reports or logs.
Install these hook scripts and their parent directory under root ownership,
without group/other write permission, using the reviewed Node executable. Do not
point a root timer at a user-writable development checkout or executable.

The new staging leaf is mode 0700, all files 0600, and `plan.json` is written
last. Existing files/directories/symlinks are refused. No runtime key or certificate
is read during generation. Output placement is explicit:

| Candidate file | Reviewed installation destination |
| --- | --- |
| `nginx.main-acme.conf` | A new main nginx HTTP-context include, never a replacement for public/8443 files |
| `nginx.edge.conf` | `/etc/imonmeets/edge-nginx/nginx.conf` |
| `nginx.edge-http.conf` | `/etc/imonmeets/edge-nginx/http.conf` |
| `nginx.edge-witness-tls.conf` | `/etc/imonmeets/edge-nginx/tls/witness.conf`, only after issuance/staging |
| `imonmeets-edge-nginx.service` | Dedicated edge service; no existing nginx service replacement |
| `<role>-certbot.ini` | `/etc/imonmeets/certificates/<role>-certbot.ini` |
| `<role>-renewal.json` | `/etc/imonmeets/certificates/<role>-renewal.json`, root-owned 0600 |
| `imonmeets-<role>-cert-renew.service/.timer` | Only that host's scoped renewal units, enabled after operational acceptance |

Use role `main` only on main and role `witness` only on edge. The generated ini
contains the ACME terms agreement for the later issuance command; generation
does not register an account or contact the CA. Obtain the ordinary operator
approval for any account/issuance action under the deployment procedure.

## HTTP and witness restrictions

Unknown HTTP hosts return 404. Ordinary requests to reviewed names redirect to
their fixed HTTPS origin. Only raw `/.well-known/acme-challenge/<token>` paths
with 22–128 base64url characters, without query/encoding/path aliases, enter the
challenge handler. GET and HEAD are allowed; other methods fail. The main proxy
strips incoming headers/body, supplies a literal approved Host, and connects
only from the edge private IP to the main private IP on 18080. The main nginx
handler serves only files under the existing webroot, with symlink following
disabled. Private-peer source admission occurs at the main TCP bridge; nginx
admits only its loopback connection. No API/storage/general HTTP proxy is added.

The witness TLS wrapper listens only on `127.0.0.1:8446`, without PROXY protocol.
The default TLS server rejects unknown names and explicitly permits only TLS1.2/
TLS1.3. The named server forwards only raw `GET /health`, `POST /intents` and
`POST /checkpoint` to the existing loopback 3551 receiver. Query strings,
normalized aliases, other methods and other paths fail. The original bearer
Authorization header is preserved; the receiver still authenticates every
operation. The request bound is 36 KiB, matching the receiver. Access/error URI
logging is off, and neither body nor authorization content is logged.

## Scoped renewal, retry and rollback

New Certbot configuration lives under `/etc/imonmeets/acme/main` or
`/etc/imonmeets/acme/witness`, with separate work/log directories and explicit
`--config`, `--cert-name` and `--no-directory-hooks`. This keeps the existing
host-wide Certbot timer and broad legacy hooks away from these lineages. Do not
run `install-ops.py` for this setup or replace global hooks.

Before activating the new TURN lifecycle, inspect the actual existing
`/usr/local/lib/imonmeets/renew-turn` dispatch and its target directory without
printing its private environment. The repository's legacy installer generates
that hook with an implicit `.env` and Compose context. Renewing an old preview
lineage could still invoke it and overwrite the same TURN copies, even though
the new lineages are isolated. After the controlled TURN transition, archive or
disable only this obsolete project-specific TURN dispatch if it targets the new
runtime; preserve the global nginx renewal action needed by existing 8443 and
other projects. Confirm no legacy invocation is in flight. Do not leave two
certificate writers targeting the same TURN directory, and do not run the broad
installer later to recreate the obsolete hook. This is an explicit commissioning
step; the candidate does not inspect or modify that live hook.

`renew-edge-certificate.mjs` accepts only the generated exact role/name/lineage
contract. Foreign deploy-hook events are ignored before reading material. The
operator's `--reconcile` command selects that same validated lineage explicitly.
The hook copies verified material into an immutable private snapshot; it syncs
the files, snapshot and versions directory before atomically publishing current.
A private lock prevents concurrent activation.

For main, before publication it validates the explicit merged Compose model and
the single actual running TURN container: project/service labels, host network,
user, read-only `/run/imon-turn` bind, real source path and file ownership must
match. It invokes the unchanged `prepare-turn.mjs --cert-only` into a private
temporary directory using only the explicit private environment. Generated
`turnserver.conf` must be byte-identical to the active file. Environment drift
cannot silently change relay IP, realm, secret or listener mode. The LiveKit
file is not rewritten. Docker commands use the local socket explicitly and no
ambient Compose context.

After publication, `nginx -t` runs before any reload. Main refreshes only the two
TURN certificate copies while preserving their ownership, reloads system nginx,
and restarts only `turn` through the exact Compose argv. Witness reloads only
`imonmeets-edge-nginx.service`; the receiver is never restarted. Unchanged active
material avoids all reloads/restarts; changed TURN copies remain a hard failure.

On a parser/reload/restart failure the hook restores the prior current link and
TURN copies, and attempts the corresponding scoped reload/restart when needed.
The previously good immutable snapshot is retained. A failed rollback preserves
both snapshots and the lock and returns a fixed hard failure for operator
recovery. Do not remove a lock until the failed process is gone and current,
both TURN copies, service state and served certificates have been inspected.

The renewal oneshot also runs the generated `reconcile` argv after Certbot. This
retries activation of an already issued certificate after a prior rollback,
even when the lineage is no longer due. If Certbot itself fails, systemd reports
the failure; run the explicit reconcile command after reviewing the cause.
Monitor both renewal unit failures and actual served expiry. Certbot issuance
success alone does not prove activation. Interrupted processes leave a lock;
power loss between the two TURN file replacements requires explicit recovery
from the retained snapshot before another restart. No rollback is claimed for
arbitrary concurrent operator edits or untested crash recovery.

## Canonical application cutover dependencies

The old preview RTC virtual host on 8443 can bypass the new protected signaling
entry points. Before enabling the new application/admission contract, drain
active sessions, review the exact existing RTC virtual host, and either retire
that RTC route or apply the same admission guard. Do not leave a direct
`127.0.0.1:7880` route publicly reachable. Do not disable all 8443: the existing
offsite `_ops`/export/health routes are still used by the Mac monitor and need
their separate compatibility/retirement plan.

The release coordinator also observed that recording storage receives CORS
origins through `-s3.allowedOrigins=${APP_URL}` in Compose interpolation. A new
app environment alone does not update an already running storage container.
The canonical private interpolation environment must retain the intended
APP_URL/LIVEKIT_URL/S3 endpoint values, and storage needs its reviewed scoped
recreation or equivalent CORS update after upload/recording drain checks. This
certificate generator never performs that application/storage transition.

## Evidence and remaining acceptance

The focused suite includes 15 new checks covering emitted routing boundaries,
private writing, real synthetic X.509/key validation, actual temporary snapshot
changes, unchanged-material reconciliation, source/runtime drift rejection and
fault-injected rollback. It runs with the prior 36 ingress checks, preserving all
12 immutable legacy output hashes. The main TURN fixture executes the unchanged
certificate/config generator; this scratch user namespace maps only UID/GID 0,
so its non-root ownership branch is simulated for that subprocess. Actual
chown, Docker state/actions and nginx processes are not certified by this suite.
The source-bound result is recorded in
[verification/edge-certificates-20261103.json](verification/edge-certificates-20261103.json).

Native nginx parser/HTTP/TLS behavior, exact served chains, real main/edge source
admission, tunnel loss/boot, actual container access, operational renewal and
failure recovery remain deployment gates. All candidate acceptance flags stay
false until separate receipts establish them.

Certbot references: [webroot and renewal behavior](https://eff-certbot.readthedocs.io/en/stable/using.html#renewing-certificates)
and [directory/hook/config options](https://eff-certbot.readthedocs.io/en/stable/man/certbot.html).

## Subsequent native parser observation

The source-bound e9b6852 candidate reached nginx `syntax is ok` in all seven
private synthetic fixture checks as ordinary user sergey. Four complete `-t`
commands exited 0; three edge cases then failed while attempting to bind the
edge public IP, which is not assigned on main. This established that `nginx -t`
can open test sockets. Brief loopback binds/listeners were not instrumented, so
absence of such sockets is not asserted and the requested non-listening
boundary was not met. No worker cycle, service start or reload was requested;
fixtures and synthetic keys were removed, and no host test was repeated.

The receipt records every fixture-path adaptation, binary/source hashes, all
seven command results, a correction to the original no-listener assumption,
and a sanitized review of the actual legacy renew-turn dispatch:
[verification/edge-certificates-nginx-syntax-20261103.json](verification/edge-certificates-nginx-syntax-20261103.json).
The originally executed harness is preserved as a text artifact. Its maintained
script now refuses execution without an explicit acknowledgement that `-t` can
bind/listen in a separately approved context. This guard was checked locally
without invoking nginx. Actual edge commissioning and full runtime acceptance
remain separate; no listener address, capability or global bind policy was
weakened to make the failed tests pass.
