# Google scope guard and paid-VPS ingress integration

Status: **INTEGRATED_CANDIDATE_NOT_DEPLOYED**. This branch combines reviewed code
and tooling; it does not activate Google login, public port 443 or the witness.
It is separate from `main` and `release/resumed-20261103`.

## Source and evidence

Integration branch: `release/integrated-google-edge-20261103`, based on
`2718c9fb181eb646d76d1ed9d70fc979f29d9387`.

| Change                             | Reviewed source                          | Integrated cherry-pick |
| ---------------------------------- | ---------------------------------------- | ---------------------- |
| Google identity-only scope guard   | 34beb48afdc80d369d0242371e0cb2505c186cf5 | 6b3bf55                |
| Separate VPS TLS ingress generator | f5eb135d30c650b6a32c39a9d4c8bf124ec9ce19 | bd57484                |

The cherry-picks applied without conflicts. CI retains the Google, external-media
and Compose-cutover checks and adds the edge-generator check. Exact integrated
source bytes passed all four pure suites on the isolated scratch host:
**50/50, no failures or skips** (6 Google, 17 edge, 11 media policy, 16 Compose).
The CI YAML was parsed separately and all four gates occur once.

The primary agent verified successful Google-branch
[GitHub CI run 41646676289](https://github.com/IMONsergey/imonmeets/actions/runs/41646676289),
job 125953724412: all 26 steps succeeded, including full typecheck/build, tests,
UI, an immutable image build and installed-package inventory. Artifact
13236340119 (`imonmeets-candidate-evidence`) has archive digest
`sha256:f9a03ba2d24eaa9ded0b455e48e4963299fe2b09bc45b48b96eb665ef03cbaab`.
This is the artifact archive digest, not a Docker image ID.

The integration's 145 tracked runtime/build-input files under `apps`, `packages`,
the Dockerfile, package manifests/lock and TypeScript configuration match that
Google commit byte for byte. The source-tree listing SHA256 is
`472a01d713f6f010dee445a03bf305d2e7f29a0b7792a67d98c78e61a655a80a`.
The earlier focused Google receipt also matches all seven non-CI inputs; the
eighth input is CI, changed only to add the edge gate. Its handler/provider result
remains available in [the focused receipt](../verification/google-oauth-focused-20261103.json).

The duplicate local API typecheck/build job was not submitted after this CI
evidence arrived. A new CI run and source-bound image receipt for the **final
integration commit** remain required after publication. The older cfa4a1ca image
and 21-stage receipt are historical evidence, not an image built from this branch.
No main-server Docker metadata request or image stage was retried or routed
through another execution path.

## Isolated HAProxy runtime evidence

The standalone loopback harness passed **19/19 actual TCP/TLS routing checks**
in a disposable restricted container on the Mac's local Docker Desktop.
Both the unchanged candidate and adapted loopback configuration passed HAProxy
syntax checks. Eleven positive cases reached the expected backend; all eight
negative cases closed without a backend connection. Final accepts were nginx 6,
TURN 3 and witness 2. The fixture self-checks also passed 11/11.

This used a fixture derivative of the pinned official HAProxy image, with the
original HAProxy executable and original scanned shared-library files unchanged.
The container ran as UID/GID 65534 with network disabled, no published ports or
host data mounts, a read-only root filesystem, all capabilities dropped,
no-new-privileges, 256 MiB memory, 0.5 CPU and 64 PIDs. It exited 0 without OOM
and was removed. The detailed stdout evidence was captured before tmpfs expiry.
The rejected privileged main-server Docker operation was never repeated.

The result proves parser acceptance and the adapted local routing contracts,
including PROXY v2 only at nginx, raw TLS for TURN and witness, fragmented
ClientHello and TLS 1.2. It does not accept the untouched deployment image's
startup or privilege transition, real tunnel behavior, public reachability,
nginx/coturn application behavior or witness enrollment. The harness remains
separate from the ordinary pure CI gate. See the
[loopback runbook](../edge-vps-loopback-validation.md) and
[full fixture receipt](../verification/edge-vps-loopback-harness-20261103.json).

## Current provider and application state

The purchased VPS owns 94.249.188.77; the primary server retains 94.249.186.240
and its existing VPN. No additional IP purchase, DNS change or deployment was
performed by this integration. The witness remains `STAGED_NOT_ENROLLED`.

Chrome reconnected. The existing **IMON Meets Web** client was checked again with
origin `https://meets.imon.world` and callback
`https://meets.imon.world/api/auth/callback/google`. Google's policy acceptance
and client creation are complete. The current client detail page no longer
offers viewing/downloading the original secret. No matching original credential
JSON was found in standard Downloads; this is not a claim about every possible
download location. No secret has been transferred to Meets configuration.

The next credential step is the owner's **Add secret** action on that existing
client and immediate private capture/download of the new JSON, followed by a
controlled transfer into the closed configuration. This is not another policy
approval. No client identifier or secret is included here. See Google's
[client-secret management guidance](https://support.google.com/cloud/answer/15549257#client-secret-hashing).

A separate provider gate remains: Audience is External, publishing status is
Testing, and the UI shows 0 configured test users out of 100. Publish app is
blocked until Branding configuration is completed. The application name and
support contact are present, while home/privacy/terms URLs still require the
canonical HTTPS site and the completed legal pages. No publishing action or
test-user addition was performed. Capturing a new secret alone will not make
production OAuth ready.

The latest live checks of the existing :8443 public-document API returned 404
for both `/api/public-documents/privacy` and `/api/public-documents/terms`. The
candidate API explicitly reports an unpublished document when content is absent.
The intended public legal routes are `/privacy` and `/terms`; they must contain
published, reviewed legal documents before being represented as usable Branding
links. No legal content was edited or published during this work.

The primary agent's latest read-only live checks returned `/api/health` HTTP 200
with status `ok`, and `/api/config` HTTP 200 with `googleOAuthConfigured:false`,
`registrationEnabled:false` and `billingEnabled:false`. Provider setup and passing code tests
do not establish a completed real Google login.

## Latest automatic offsite backup observation

The primary agent verified the ordinary automatic Mac cycle at
`2026-11-03T15:16:19.135596+00:00`: `ok`, `backupOk`, `automatic`,
`recordingSyncOk` and `serverHealthOk` were all true. Its server-health sample
was checked at `15:15:06.181Z`, and the backup was created at
`15:01:09.369924Z` on the same day. No manual pull, monitor run or receiver
change was used to produce this recovery.

An earlier automatic cycle at 15:10:54Z had successful database and recording
backup but a failed health subprocess. An isolated read-only health probe then
succeeded at 15:13:05.709Z, followed by the successful automatic cycle above.
The historical subprocess/network cause was not retained and is not inferred.

## Smallest remaining main-side implementation

The existing edge generator is deliberately TLS-only. Its remote destinations
do not exist merely because a tunnel address has been selected. Implement the
following small, separate candidate before any network commissioning:

| Component to prepare                             | Fixed contract                                                                                                                                            |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main TCP bridge generator and standalone overlay | Bind only the reviewed main tunnel IPv4 on 8445 and 5349; admit only the reviewed edge tunnel source; forward to main loopback 8445 and 5349 respectively |
| Main nginx TLS-only generator                    | Reuse the accepted app/signaling/recordings TLS server blocks, without the original generator's public HTTP binding                                       |

For the bridge, reuse the pinned HAProxy image already used by the edge. The
nginx stream must preserve the **one existing PROXY v2 prefix** from the edge.
The bridge must neither consume that prefix with `accept-proxy` nor add another
one with `send-proxy`. Coturn receives unchanged TLS with no PROXY prefix. A
bridge connection to loopback preserves nginx's existing loopback trust boundary;
do not widen `set_real_ip_from` or expose API:3540, signaling:7880 or S3:8333.

Generate the main TLS blocks through a shared pure rendering helper extracted
from `scripts/prepare-ingress443.mjs`, while retaining the original single-host
generator's default output and refusal rules. The new main mode must not require
assigning the VPS public address to the primary host. It must preserve signaling
admission, client-IP replacement, blocked internal routes, signed-object
Host/path/query handling and the existing private include-file contract.

`scripts/prepare-turn.mjs` already supports the needed loopback TLS5349 listener
with `TURN_INGRESS_443=true`. Keep its public relay/SFU address on the primary
server. Moving coturn or changing its peer allowlist to the VPS is unnecessary
for this design.

Actual tunnel technology, interface and address allocation remain operator
inputs after route/collision review. Source ACLs and private IPs do not provide
encryption or tunnel confinement. The host must independently enforce the
approved interface/peer restriction and fail closed when the transport fails.
The candidate generators must not create a tunnel, alter firewall/default routes
or bind any listener themselves.

Focused negative acceptance for this slice: public/loopback/colliding tunnel
inputs; wrong source peer; tunnel loss without public fallback; duplicate or
missing PROXY headers; raw TURN prefix corruption; client-IP forgery; revoked
signaling admission; and preservation of signed recording requests. The
unchanged single-host renderer must retain its prior contract. Real bounded
HAProxy/nginx checks on the shared host belong in the existing `imon-job` queue.

## Remaining HTTP, ACME and certificate slice

Keep application/RTC/recording/TURN private keys on the primary host, where those
TLS sessions terminate, and the witness TLS key on the VPS. This avoids adding
private-key distribution to the first implementation.

Prepare an edge nginx configuration with public HTTP80 and a separate local
witness TLS listener on 127.0.0.1:8446:

- Permit only the five reviewed hostnames. Ordinary known-host HTTP requests
  redirect to the corresponding HTTPS origin; unknown hosts fail closed.
- For the four main-host names, forward only the exact read-only HTTP-01
  challenge path to a dedicated main-side challenge endpoint over the same
  protected transport. Its nonconflicting port is an explicit reviewed input,
  not a guessed port or an existing application endpoint. Restrict the endpoint
  to the edge peer and ACME webroot; it must not become a general HTTP proxy.
- Serve the witness challenge locally on the VPS. The local TLS8446 wrapper
  forwards only `GET /health`, `POST /intents` and `POST /checkpoint` to the
  witness's existing loopback HTTP3551, preserving its bearer authentication and
  request-size limits. Disable request URI/body/authorization logging.

Do not install the complete current single-host nginx output on the primary
server using the VPS IPv4: that renderer also binds public HTTP to its ingress
address. The TLS-only extraction and dedicated challenge routing are required.
No certificate issuance, challenge serving, endpoint installation or DNS change
is performed by this integration.

Reuse the existing certificate validation and `--cert-only` behavior in
`scripts/prepare-turn.mjs`. Adapt the renewal hook with explicit allowed lineage,
runtime context and reviewed Compose files for each host. The current
`deploy/renew-nginx.sh` delegates TURN refresh, while `scripts/install-ops.py`
generates a hook using `.env` and implicit `docker compose restart turn`; it also
installs/enables unrelated operational timers. Do not execute that broad installer
just to commission this edge path. Preserve effective private runtime settings,
validate replacement material/configuration before use and define scoped reload
and rollback behavior for nginx, coturn and the witness TLS wrapper.

## Publication and commissioning boundary

The next code slice is the main bridge plus TLS-only main nginx generator,
followed by the HTTP/ACME and per-host certificate hooks above. These are bounded
extensions to the current edge contract, not an application or TURN migration.

After code and exact-commit CI acceptance, actual route/firewall/tunnel checks,
certificate renewal, DNS cutover, witness enrollment/recovery, external TURN443
media and long recording/resource acceptance remain separate operational gates.
Neither pure checks nor localhost fixture traffic proves public-network reachability
or commercial readiness. See [the edge candidate contract](../edge-vps-ingress.md)
and [the integration receipt](../verification/integrated-google-edge-20261103.json).
