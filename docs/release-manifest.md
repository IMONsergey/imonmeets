# Exact release identity

Build the application from the clean integrated release commit and pass that full SHA as Docker build argument `VCS_REF`. The runtime image records it in `org.opencontainers.image.revision`. An image without a matching full commit cannot produce a release manifest.

After the build, run `node scripts/create-release-manifest.mjs --image <reviewed-image> --env <reviewed-env-file> --output <new-manifest-path>`. Add `--sudo-docker` when the operator uses passwordless Docker through sudo. The command only inspects Git and the local image. It does not start or change containers, update the environment or deploy code.

The manifest records the exact local Docker image ID, matching Git commit, image creation time, migration-source checksums and hashes of each capability's reviewed configuration. It includes only the three deployment identity values that must be applied: `APP_IMAGE`, `RELEASE_COMMIT`, `RELEASE_IMAGE_DIGEST`. Passwords, connection strings, provider keys and raw evidence are excluded.

Use the immutable image ID from the manifest as `APP_IMAGE`. A mutable tag is accepted only as an input to resolve that exact ID. `environmentIdentityMatches=false` means the candidate environment still needs its identity values updated before deployment. The manifest always starts with `deployed=false` and `acceptance=not-evaluated`; artifact identity is not a substitute for migration, rollback or external service acceptance.

Keep the approved manifest with the deployment record and corresponding fresh launch-readiness result. Record the previous image ID and reviewed configuration before a rollout. Migration compatibility and a successful isolated restore are required before applying schema changes to production.
