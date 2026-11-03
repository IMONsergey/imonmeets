# Read-only merged Compose preflight

`scripts/check-compose-cutover.mjs` checks the final rendered application deployment before an operator starts migration or replaces a container. It reads an explicit JSON file and optional Docker image metadata. It never invokes Docker, reads the environment, contacts a service, writes a file, initializes a journal or deploys anything.

The check addresses a concrete cutover risk: the existing final private runtime overlay can replace the candidate image or omit the effective Resend settings. Checking `.env` or a single YAML file cannot establish what `app` and `migrate` will receive after all overlays are merged.

## Prepare the input privately

Use the exact reviewed project directory, environment file and complete overlay list intended for the operation, including the final private runtime overlay. Ask Compose to render `config --format json` directly into a new private file. Capture renderer stderr privately too: interpolation errors can contain private input. Do not print or commit the rendered configuration, and do not use `config --no-env-resolution` or `--no-interpolate`.

The validator accepts normalized Compose service/environment/mount objects. It does not parse raw YAML or a dotenv file. Both service images must equal the expected immutable references; mutable tags are rejected. The base manifests retain `build` metadata, so this validator does not reject the mere presence of `build`. Continue to use the reviewed `--no-build`/no-pull deployment procedure.

Run the checker with concrete accepted image and source values, substituting the private input paths:

```sh
node scripts/check-compose-cutover.mjs \
  --compose /private/path/merged-compose.json \
  --expected-image sha256:ACCEPTED_IMAGE_ID \
  --expected-commit ACCEPTED_SOURCE_COMMIT \
  --image-inspect /private/path/accepted-image-inspect.json
```

The capitalized placeholders above must be replaced by an actual 64-hex image ID and 40-hex Git commit. The checker refuses placeholders. `--expected-migrate-image` may be supplied explicitly; otherwise migration must use the same expected image as the app.

`--image-inspect` accepts the unchanged JSON array produced by `docker image inspect` for the expected image or images. Obtain this separately through authorized tooling and redirect it privately, since image metadata may contain environment values. The checker compares `Id`, `RepoDigests`, `Config.Labels["org.opencontainers.image.revision"]` and any baked `RELEASE_COMMIT` value. It never trusts a source label attached only to the Compose service.

An image ID (`sha256:…`) and a registry reference (`repository@sha256:…`) are different identifiers. For a registry reference, inspect metadata is mandatory to resolve the manifest reference to its actual image ID. `RELEASE_IMAGE_DIGEST` is checked against that image ID, as used by the existing release-manifest workflow. It is not incorrectly compared with the registry manifest digest.

Without inspect metadata, an exact image-ID comparison is still useful, but `sourceMetadataVerified` stays false. `--expected-commit` additionally binds both services' `RELEASE_COMMIT` to the operator's accepted commit. Image metadata consistency is not cryptographic build attestation: retain and verify the separate archive-bound build receipt.

## Checks

- `app` and `migrate` exist, use the expected images, declare production mode and consistent release identities.
- The selected origins use HTTPS. This static gate deliberately does not turn an `:8443` preview into accepted public port443 service.
- Both services preserve external Resend configuration with a nonempty key and sender. Quotas follow `loadConfig`: absent limits use45/45/1000; resolved values must be positive integers no greater than those limits. This catches the base Compose defaults500/100/15000 if the private Resend override is accidentally omitted.
- Shared database, app origin, identity, mail, media and deletion authority values do not diverge between app and migration. Values are compared only in memory.
- The app's configured deletion journal has exactly one writable absolute host bind, no automatic host-path creation and no child bind or tmpfs overlay hiding journal data. Normalized Compose may omit `create_host_path:false`; omission is accepted. Short-bind rendering with `create_host_path:true` is rejected.
- The app has the required journal key, HTTPS witness address, token and public-key presence. Migration is not incorrectly required to have a journal mount: the actual deletion overlay mounts it only for `app`.

## Output and limits

Exit0 means these static checks passed; exit1 means invalid input or one or more failed checks. JSON output includes only fixed diagnostic codes, known service names and allowlisted field names. It never includes environment values, endpoint values, filesystem paths or raw parser errors. Input must be a regular nonsymlink file no larger than4MiB. The script does not modify it.

Every result explicitly states `productionChanges:false`, `deployed:false` and `runtimeAccepted:false`. A passing result does not prove host-directory existence/permissions, journal genesis/enrollment, witness TLS or independence, restored-data consistency, running image identity, mail delivery, public ingress, media, recording, legal approval or commercial readiness. Complete those separate gates in the deployment cutover runbook.

The script compares the rendered model the operator supplies. It cannot discover an omitted overlay or prove that a later deploy uses that same model. Preserve the exact render invocation privately, the accepted image/build receipts and the safe checker result with the operation record.

## Focused regression suite

```sh
node --test scripts/test-compose-cutover.mjs
```

Tests exercise stale app/migrate image overrides, declared and inspected source mismatches, registry-manifest versus image-ID identity, loss of mail configuration, excessive quotas, divergent database targets, invalid/shadowed journal mounts, malformed input, CLI exit codes and secret-safe failures. They use synthetic normalized Compose and Docker inspect objects and private temporary files; no Docker daemon, provider, database or network is contacted.
