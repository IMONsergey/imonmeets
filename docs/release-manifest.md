# Exact release identity

Build the application from the clean integrated release commit and pass that full SHA as Docker build argument `VCS_REF`. The runtime image records it in `org.opencontainers.image.revision`. An image without a matching full commit cannot produce a release manifest.

After the build, run `node scripts/create-release-manifest.mjs --image <reviewed-image> --env <reviewed-env-file> --build-receipt <build-receipt.json> --output <new-manifest-path>`. Add `--sudo-docker` when the operator uses passwordless Docker through sudo. The command checks a bounded build receipt against the fresh Git archive hash and the inspected immutable image. The OCI label alone is insufficient. It does not start or change containers, update the environment or deploy code.

The manifest records the exact local Docker image ID, matching Git commit, image creation time, migration-source checksums and hashes of each capability's reviewed configuration. It includes only the three deployment identity values that must be applied: `APP_IMAGE`, `RELEASE_COMMIT`, `RELEASE_IMAGE_DIGEST`. Passwords, connection strings, provider keys and raw evidence are excluded.

Use the immutable image ID from the manifest as `APP_IMAGE`. A mutable tag is accepted only as an input to resolve that exact ID. `environmentIdentityMatches=false` means the candidate environment still needs its identity values updated before deployment. The manifest always starts with `deployed=false` and `acceptance=not-evaluated`; artifact identity is not a substitute for migration, rollback or external service acceptance.

Keep the approved manifest with the deployment record and corresponding fresh launch-readiness result. Record the previous image ID and reviewed configuration before a rollout. Migration compatibility and a successful isolated restore are required before applying schema changes to production.

## Bounded candidate build

On the audited workstation, run `python3 scripts/build-release-image.py --output-dir <new-private-directory>` from a clean committed checkout under the shared verification lock. It builds a Git archive of that exact commit, excluding ignored and untracked deployment files, and invokes the installed Docker legacy builder explicitly with one CPU and 2GiB memory/swap-total per RUN step. The runner observes actual Docker container limits, records the archive hash and image ID, and removes only build containers carrying its unique scope label on failure or timeout. The existing builder is deprecated; migration to a pinned BuildKit container is a separate toolchain task. The build receipt is a trusted local operational record, not an external cryptographic attestation. It does not imply production, migration, rollback or external capability acceptance.
