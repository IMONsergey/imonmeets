# Private recording deployment

This optional overlay connects LiveKit Egress to a private SeaweedFS S3 bucket. It is an intentionally small deployment for the existing shared host. Application configuration alone does not prove that capture, upload, authorized download, or deletion works. Keep `RECORDING_ENABLED=false` until the acceptance checks below pass.

## Resource budget

| Component         | Limit                                       | Consequence                                                                                                                                                                       |
| ----------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Egress            | 2 CPU, 4 GiB RAM, no swap                   | Initial shared-host profile. Upstream recommends at least 4 CPU and 4 GiB for a recording worker. Measure the actual workload before promising customer capacity.                 |
| Video             | H.264 Main, 1280 × 720, 15 fps, 1200 kbit/s | Explicit API encoding options; no implicit 1080p preset.                                                                                                                          |
| Audio             | AAC, 48 kHz, 64 kbit/s                      | Interoperable MP4 audio.                                                                                                                                                          |
| Capture           | One active recording application-wide       | `MAX_ACTIVE_RECORDINGS=1`; worker admission also reserves 1.5 CPU per composite job.                                                                                              |
| Duration and size | 30 minutes; worker stop threshold 350 MiB   | Egress `session_limits` stop the capture. A completed matching file is retained with the limit warning. Polling and final muxing can take the completed file past the size threshold. |
| Temporary output  | 512 MiB tmpfs                               | Bounded temporary MP4 space, inside the container RAM limit. No recording spillover to the host root filesystem.                                                                  |
| S3 filesystem     | Dedicated 1 GiB filesystem                  | Hard total limit shared by objects, metadata and compaction. The generator and container reject a filesystem larger than 1.1 GiB or smaller than 512 MiB.                         |
| S3 processes      | 0.5 CPU, 512 MiB RAM, no swap               | Single-node storage for the initial deployment.                                                                                                                                   |
| Retention         | 3 days                                      | API denies expired downloads immediately and the deletion worker retries physical removal. Keep the API running for retention cleanup.                                            |

The size setting is a stop threshold sampled over the job's temporary output directory every 15 seconds, followed by EOS and mux finalization. The final MP4 can be larger. The existing 512 MiB output tmpfs is the hard staging ceiling; the backup validator accepts completed objects up to that ceiling while retaining its separate 1 GiB aggregate ciphertext guard. See [boundary verification](verification/recording-boundary-20261103.md). The short isolated verification does not establish the final 30-minute RoomComposite or external storage acceptance.

The configured stream rates produce approximately 285 MB for a 30-minute file before container overhead. This is an estimate, not a fixed object size or a storage guarantee. Five 128 MiB SeaweedFS volumes leave space for metadata and one-volume compaction; approximately two full-length recordings can fit with this budget. Short recordings, deleted objects awaiting compaction, metadata growth and interrupted uploads affect capacity. A small filesystem deliberately causes recording/upload failure before it can exhaust the shared host. Existing meetings do not require the storage worker.

The new images also consume host disk space. Reserve free host space separately from the recording filesystem, monitor both, and expand or move storage before commercial recording usage. This deployment is a single copy of recording media. The PostgreSQL backup does not contain MP4 objects.

## Images, source and sandbox

The overlay pins these official release manifests:

- `livekit/egress:v1.15.0@sha256:ac244a40268ce1dd1510fbff6eb529609ec68aceff1602343f79be8ca08c355b`
- `chrislusf/seaweedfs:4.51@sha256:f7a49e3f3972ebed5be2ed4befa4a0c68eb7bdddba6e692d42729ceb545134b8`

Egress runs as UID 1001, GID 0 in this pinned image. Its root filesystem is read-only, all Linux capabilities are removed, and `no-new-privileges` is set. Chrome sandboxing is explicitly enabled. The upstream seccomp profile permits the namespace operations required by Chrome; no `SYS_ADMIN`, privileged container, or unconfined seccomp setting is used. The host must support unprivileged user namespaces under its existing kernel/AppArmor policy. Test this with a real capture; a healthy idle Egress process does not exercise Chrome.

The public [Egress template](../deploy/egress.yaml) contains placeholders. The generated copy contains LiveKit credentials, has mode `0400`, and is mounted directly into Egress. `deploy/egress-chrome-seccomp.json` is derived from the pinned upstream source with one targeted change: the `chroot` syscall is allowed without Docker's `CAP_SYS_CHROOT` inclusion condition. Chromium invokes it while establishing its private user-namespace sandbox. With `cap_drop: ALL`, Docker otherwise removes this syscall rule before the process starts, causing sandbox initialization to fail. Allowing the syscall does not grant a container capability; kernel capability checks still apply, and neither `CAP_SYS_CHROOT` nor `SYS_ADMIN` is added to the container. The upstream Apache-2.0 license and notice are retained in `deploy/egress-LICENSE.txt` and `deploy/egress-NOTICE.txt`.

Primary references:

- [Official Egress deployment requirements and sandbox setup](https://docs.livekit.io/transport/self-hosting/egress/)
- [Egress v1.15.0 configuration fields and session size limit](https://github.com/livekit/egress/blob/v1.15.0/pkg/config/base.go)
- [Egress v1.15.0 admission configuration](https://github.com/livekit/egress/blob/v1.15.0/pkg/config/service.go)
- [Pinned Egress Chrome seccomp profile](https://github.com/livekit/egress/blob/v1.15.0/chrome-sandboxing-seccomp-profile.json)
- [Chromium sandbox credentials and `ChrootToSafeEmptyDir` implementation](https://chromium.googlesource.com/chromium/src/+/lkgr/sandbox/linux/services/credentials.cc)
- [SeaweedFS 4.51 mini flags](https://github.com/seaweedfs/seaweedfs/blob/4.51/weed/command/mini.go)
- [SeaweedFS S3 authentication and scoped actions](https://github.com/seaweedfs/seaweedfs/blob/4.51/weed/s3api/auth_credentials.go)
- [SeaweedFS object routes, including deletion under the Write action](https://github.com/seaweedfs/seaweedfs/blob/4.51/weed/s3api/s3api_server.go)

## Storage and credentials

Prepare and persist a dedicated 1 GiB filesystem mounted at:

```text
/home/sergey/.local/share/imonmeets-recordings
```

The host operator owns filesystem provisioning, reboot mount ordering, and host disk monitoring. A directory on the main filesystem is insufficient. On every container start a second guard inspects the filesystem capacity through `/data`; this blocks accidental writes to the main disk if the host mount disappears after a reboot. The bind mount also sets `create_host_path: false`.

The preparation script reads existing LiveKit settings from `.env` without executing it. It creates two distinct random S3 identities and persists them for subsequent runs:

- Application: `Read:imon-recordings`, `Write:imon-recordings`, `List:imon-recordings`. SeaweedFS uses `Write` for object upload, multipart upload and object deletion; the application gets no bucket administration or ACL-changing action.
- Bootstrap administrator: separate credentials kept in the private configuration directory; never placed in application environment variables. Both identities belong to the same storage account. The `mini` command creates the one required bucket at startup.

No anonymous identity is defined. WebDAV, administrative UI, embedded IAM API, Iceberg, Lance and telemetry are disabled. Only S3 port 8333 is published on the host, bound to `127.0.0.1`. The other SeaweedFS component ports remain inside the project's Docker network. Do not attach unrelated containers to this network or publish the filer, master, volume, or admin ports.

Run preparation as root after mounting storage. This writes private files but does not start services or turn on recording:

```sh
sudo python3 scripts/prepare-recording.py \
  --storage-path /home/sergey/.local/share/imonmeets-recordings \
  --public-endpoint https://YOUR_API_HOST:8443 \
  --apply-env
```

`--public-endpoint` must be an HTTPS origin without a bucket path. The script creates these ignored files under `deploy/recording-private/`:

| File               | Owner and permissions | Purpose                                                       |
| ------------------ | --------------------- | ------------------------------------------------------------- |
| `credentials.json` | root, `0600`          | Stable source for both identities; protected operator backup. |
| `admin.json`       | root, `0600`          | Bootstrap/diagnostic client configuration.                    |
| `s3.json`          | 1000:1000, `0400`     | SeaweedFS identity configuration.                             |
| `egress.yaml`      | 1001:0, `0400`        | LiveKit worker configuration.                                 |
| `recording.env`    | root, `0600`          | Application S3 settings and conservative limits.              |

The directory itself is root-owned `0700`. The services bind only their specific file; they do not receive the whole directory. Existing application S3 credentials are never silently replaced. Re-running preparation preserves the keys and an already accepted `RECORDING_ENABLED=true`, but never changes a disabled feature to enabled. Existing `.env` ownership is retained and its mode is restricted to `0600`. None of these files may be committed or included in the application build context.

Use the existing project overlays, including recording, for every subsequent deploy:

```sh
export COMPOSE_FILE=compose.yml:compose.public.yml:compose.turn.yml:compose.recording.yml
docker compose config --quiet
docker compose up -d recording-storage egress
docker compose ps recording-storage egress
```

Use `config --quiet`: full `docker compose config` prints interpolated secrets. Egress graceful shutdown can wait for the current capture and upload; allow the configured 32-minute grace period or explicitly stop a recording through the product before restarting its worker.

## Private downloads through nginx

The API writes and deletes objects at `http://recording-storage:8333`. It signs browser download URLs against `S3_PUBLIC_ENDPOINT`, using path-style S3 URLs and a 60-second lifetime. The reverse proxy must preserve the original `Host` including `:8443`, the exact path, query string and signed request parameters. A rewritten host, stripped query parameter, or removed bucket prefix invalidates SigV4.

On the existing API TLS virtual host, the operator must add only the `/imon-recordings/` object prefix proxy to `http://127.0.0.1:8333`. Block the exact bucket roots `/imon-recordings` and `/imon-recordings/`; permit only GET and HEAD for object paths. Do not expose the storage root, bucket listing, PUT, POST, DELETE, administrative routes or the filer. Do not log signed query strings; use an access-log format that omits arguments, or disable access logging for this private object location. Use `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, and `X-Content-Type-Options: nosniff`.

Do not add an anonymous-read bucket policy to make a broken signature work. A copied signed URL is a bearer capability until it expires; the application issues it only after workspace membership, recording lifecycle and retention checks. Authorized deletion and expiry deny new links immediately and request physical object deletion, making existing links unusable when removal completes.

## Acceptance before enabling capture

The local preparer tests check scoped identities, no anonymous access configuration, credential separation and reuse, missing/oversized mount rejection, safe environment parsing, private file permissions, and symlink rejection. The API recording test checks that the RPC receives private S3 output and the explicit MP4 encoding profile. These are configuration/regression checks, not a real media test:

```sh
python3 scripts/test-prepare-recording.py
npm run typecheck -w @imonmeets/api
node --import tsx --test apps/api/test/media.test.ts
```

The operator must then exercise the deployed services:

1. Confirm container health, correct non-root UID, resource limits and the dedicated storage mount. Confirm that anonymous S3 list and object requests are denied. Confirm that the app identity can upload/read/delete inside `imon-recordings` and cannot create a bucket, access another bucket or modify ACLs.
2. Confirm nginx denies bucket listing and every modifying HTTP method. Check an authorized presigned GET through the public TLS origin and a tampered signature. Confirm the unsigned version is denied and the signed URL stops working after expiry.
3. Join with two real browser participants, start recording through an authorized manager, observe the visible recording state for both, and capture audio/video. A second recording must be rejected while the first is reserved or active.
4. Stop through the product; wait for complete state. Download and play the MP4, verify audio/video with `ffprobe`, and check the exact object key, encoding, size and duration. A browser from a different workspace and a guest must not obtain a download link.
5. Delete through the product. Wait for physical deletion, verify old links fail, and check retry behavior during a temporary storage outage. Test expiry using an isolated disposable recording, not by altering unrelated production rows.
6. Exercise short duration and size limits using a separate disposable worker. Verify the limited file remains usable, shows a duration-or-size limit warning, and completes backup/restore. Then separately accept the target worker's existing 30-minute/350 MiB profile at its real boundary. A worker failure or interrupted upload must not become a fictitious complete recording.
7. Verify worker restart, duplicate/out-of-order webhook handling, capacity reservation reconciliation, and storage-full failure without affecting unrelated services. Keep headroom and duration observations in the deployment report.

After the deployed acceptance passes, set `RECORDING_ENABLED=true` in the private application environment and recreate the application container using the complete overlay set. This document does not assert that acceptance has passed. Keep transcription and AI workers disabled on this resource budget; they need separate capacity and their own full-cycle acceptance.
