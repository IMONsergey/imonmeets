# Transfer the tested CI candidate image

This path exports the image already built and inspected by the existing CI
`verify` job. It does not perform a second build, run a deployment, change the
main host's job policy, migrate a database, or enroll a deletion witness.

Export and publication are limited to a `push` in `IMONsergey/imonmeets` at the
exact ref `refs/heads/release/edge-transport-acme-20261103`. Pull requests, tags,
other branches and fork repositories cannot enter these steps. All existing CI
gates remain prerequisites. The verification job retains `contents: read`.

## Objects and identities

| Object | Identity and purpose |
| --- | --- |
| Application source | Full successful workflow commit SHA |
| Docker image | Immutable image ID from `build-receipt.json`; saved by ID, never by a mutable tag |
| Image transfer | `imonmeets-app-<full-sha>.tar.gz`, its SHA256 and byte count |
| Transfer manifest | Source/image/platform/run identity and hashes of every included evidence file |
| GitHub Actions artifact | Separate immutable artifact ID; its ZIP digest is not the Docker image ID or the image tarball SHA256 |
| Candidate prerelease | New `candidate-<full-sha>` tag/release with `--target <full-sha>`, `--prerelease`, and `--latest=false` |

The existing `imonmeets-candidate-evidence` artifact contains build and inventory
receipts. It remains separate and is **not** a deployable image.

`scripts/ci-candidate-image.py export` accepts the existing build receipt and
runtime npm inventory. It saves the immutable image once, checks the saved
Docker config digest, source revision and `RELEASE_COMMIT`, and requires
`linux/amd64`. It reads the archive's metadata without extracting or running
the image. The uncompressed save is limited to 2 GiB and its gzip to 768 MiB;
each evidence JSON is limited to 5 MiB. Temporary raw data is removed after
export. The complete payload includes the build receipt, inventory receipt,
installed npm tree/inventory, both SBOMs, transfer manifest and `SHA256SUMS`.

The build uses the existing clean Git archive workflow. No production `.env`,
Google credential, private runtime overlay, database content or host key is an
input to the CI image or transfer. The export script never reads those files.

## Publication boundary

The separate `publish-candidate-image` job requires successful `verify` and the
same exact repository/event/ref guards. Only this job receives `contents: write`.
It checks out the exact successful commit with credential persistence disabled,
downloads only the artifact ID returned by that verification job, and runs the
trusted verifier from the checkout. No executable artifact content is run.

Validation binds the source, image ID, archive SHA256, manifest SHA256, workflow
run and attempt, inventory hashes, byte bounds, exact file set and checksum
list. Unknown files, symlinks, changed evidence or identity mismatches fail.

Before `gh release create`, a read-only API check must establish HTTP 404 for
both the proposed release and tag. Existing objects, permission errors and
network uncertainty stop publication. The job serializes publication for the
same source SHA and never updates a tag, edits a release, uploads with
`--clobber`, or deletes existing assets. A failed/partial publication is retained
for operator review; an automatic rerun will not replace it.

Actions transfer artifacts use a seven-day retention and no overwrite. Public
candidate release assets do not inherit that expiry and remain until separately
reviewed cleanup. They are candidates, not a release promotion or launch approval.

## Delivery and deployment are separate

After publication, the public release asset URLs can be downloaded without
copying GitHub write credentials to the main server. Before any Docker import,
use a fresh directory and the verifier from the exact reviewed source:

```sh
python3 scripts/ci-candidate-image.py verify \
  --source-commit <full-successful-commit> \
  --directory /absolute/new-transfer-directory \
  --expected-image-id <image-id-from-successful-CI> \
  --expected-archive-sha256 <archive-sha256-from-successful-CI> \
  --expected-manifest-sha256 <manifest-sha256-from-successful-CI>
```

Native image identity/runtime verification after import, complete private
configuration, backups, fenced migrations, witness adoption, and external media
and OAuth acceptance remain separate gates. This workflow does not grant a
deployment exception to `imon-job` or disable `NoNewPrivileges`.

## Verification and official references

The offline tests use synthetic metadata/tar fixtures and mocked API responses;
they do not prove a real Docker export or release publication. The first actual
eligible CI run must establish those outcomes.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-ci-candidate-image.py
```

New actions keep the existing v4 major and pin official ref resolutions checked
on 3 November 2026: upload-artifact `ea165f8d65b6e75b540449e92b4886f43607fa02`,
download-artifact `d3f86a106a0bac45b974a628896c90dbdf5c8093`, and checkout
`11d5960a326750d5838078e36cf38b85af677262`. Existing unrelated action selections
are unchanged.

- [GitHub job permissions and dependencies](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [Official upload-artifact v4 action](https://github.com/actions/upload-artifact/tree/ea165f8d65b6e75b540449e92b4886f43607fa02)
- [Official download-artifact v4 action](https://github.com/actions/download-artifact/tree/d3f86a106a0bac45b974a628896c90dbdf5c8093)
- [GitHub CLI release creation](https://cli.github.com/manual/gh_release_create)
