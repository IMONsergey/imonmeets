# Preparing a release across Docker image stores

The CI publisher's legacy builder records the SHA-256 of the image **config** in `build-receipt.json`. A Docker Engine using the containerd image store can report the OCI **manifest** digest as the loaded image ID. These are different objects. Never replace the original receipt's image ID or accept an arbitrary ID override.

`create-release-manifest.mjs` keeps the original strict comparison by default. If the runtime ID differs, the operator can explicitly provide `--candidate-transfer /absolute/canonical/candidate-directory`. The CLI then inspects the requested immutable `sha256:…` ID and freshly verifies the transfer archive using the verifier from the committed operator checkout. A saved identity-proof JSON file cannot authorize this path.

The bridge requires the complete original transfer payload and checks its existing inventory/checksum contract; the exact private build-receipt bytes; compressed archive hash and bounded tar members; the sole index target and manifest/config blob hashes; source labels, creation time and platform; every ordered uncompressed layer, its bytes and config diff ID; and the live loaded image's ordered RootFS. Symlink aliases, foreign payload files, changed receipts, missing/reordered/extra layers and unrelated loaded images are refused. Only this publisher's uncompressed Docker-save layers are supported; other formats fail closed.

## Separate release source and operator tooling

Use `--source /absolute/release-checkout` when an operator fix is newer than the already built application image. Both checkouts must be clean and committed. The release commit, source archive and migration hashes come from `--source`; the manifest separately records `operatorTooling.commit`, Node version and hashes of the operator scripts. No application rebuild is implied by an operator-only change.

The output retains the original config ID in `buildReceipt.imageId`, records the verified relationship in `imageIdentity`, and uses the actual runtime manifest ID for `applicationImage`, `imageId` and `requiredEnvironment`. The original receipts are never modified. Preparation starts no container, performs no migration, changes no environment and grants no external-capability acceptance.

For the CI candidate at `17147a6203814b5ea81de3eea547452496b2a6eb`, the independently verified identities are:

| Object                      | SHA-256                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| Build config                | `0969e11b720d59bfafb992a8384581c5cb1ce630e5776edbfe9247eb118c0ddc` |
| Loaded runtime manifest     | `5aac16d52549090301e8bc22d2fd423fd33dea986b5796e838680e5817bf2c29` |
| Compressed transfer archive | `a68ae4bd51608fe0e583986d8f47f8a84b50a0262c2cc002a4504a4b5fc4f2bc` |

These values document distinct objects, not interchangeable identifiers. Production preparation must reverify the actual archive and live immutable inspect rather than trusting this table.

## Regression checks

`node --test scripts/test-release-manifest.mjs` retains the legacy strict-path checks, invokes the offline archive refusal suite, and checks CLI preparation with distinct clean release/tooling checkouts and a synthetic Docker-inspect fixture. The fixture runs no image and accesses no network. The existing `python3 scripts/test-ci-candidate-image.py` suite covers the reused transfer contract. Run these checks through the normal job queue; they do not rebuild the application image.
