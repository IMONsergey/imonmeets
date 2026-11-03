# Installed runtime npm inventory

The candidate gate verifies the production dependency closure in the immutable application image. It does not install packages or contact the network. A complete full-lock CycloneDX document is kept separately from the derived installed-runtime document.

## Why two inventories

With npm 11.19.0, `npm sbom --omit=dev` in the production-only image rejects omitted root/workspace development dependencies. Its error is preserved in the original acceptance evidence. Changing it to `--package-lock-only --omit=dev` is insufficient: the observed image had 198 installed package identities including the root and workspaces, while that command omitted 33 installed transitive identities.

The verifier therefore:

1. Runs `npm ls --omit=dev --all --long --json` in the actual immutable image and requires a successful exit.
2. Rejects missing required, invalid, extraneous or conflicting installed entries.
3. Matches every installed location, canonical package name and exact version to lockfile v3. Workspace links must stay inside the application root. Ordinary names come from the lock location when npm omits the name; explicit names preserve npm aliases.
4. Generates complete lock metadata using `npm sbom --package-lock-only --include=dev --sbom-format=cyclonedx`.
5. Matches canonical npm package URLs, not display names, and retains only components represented in the validated installed tree.
6. Rebuilds the dependency graph from actual `npm ls` edges. Full-lock development edges between otherwise installed components are not copied.
7. Saves both inventories, raw installed tree, exact hashes and a receipt into a new private output directory. Existing evidence is never overwritten.

The unit suite includes deliberate same-version identity substitution, missing and dev-only graph edges, scoped names, aliases, optional dependencies, workspace display names, path escapes and npm command failures. Earlier negative attempts remain available.

## Execution

After committing all candidate changes, `scripts/build-release-image.py` creates an image from the exact clean Git archive with bounded Docker RUN steps. The external acceptance runner binds the verifier read-only, invokes it by immutable image digest, disables network, sets CPU/memory/process limits and supplies the expected source commit.

```text
node /verification.mjs --expected-commit <full-image-source-sha> --output-dir /evidence/runtime-inventory
```

The source SHA must match the image's RELEASE_COMMIT. The outer build receipt must separately bind that image digest, source archive and commit; an environment-variable match alone is not build attestation. CI runs the same unit gate and the image check, and preserves receipts.

## Limits

This is the production dependency closure reported by npm, including its installed locations and exact lock metadata. It is not a byte-level integrity scan, an independent scan of every filesystem file, an operating-system vulnerability scan or legal approval of licenses. Development/tooling packages appear only in the clearly named full-lock document. Dependency vulnerability checking remains a separate gate.

The inventory gate does not deploy the image and cannot establish public ingress, provider configuration, payment acceptance, capacity, disaster recovery or commercial readiness.
