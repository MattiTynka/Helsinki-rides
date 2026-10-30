# External world delivery

The game can keep its application shell on Pages while loading a pinned, immutable
world from a separately selected HTTPS asset origin. This is an explicit delivery
mode. It does not change the existing Pages descriptor, limits or live deployment.

`tools/release/prepare-external-world.py` validates a finished world and produces a
byte-preserving archive and provider-neutral upload inventory. It requires no
provider, hostname, credentials or network access. Supply measured budgets rather
than treating the hard ceilings as targets:

```powershell
python tools/release/prepare-external-world.py --source FINAL_WORLD --out FRESH_PACKET --expected-manifest MANIFEST_SHA256 --world-budget-bytes WORLD_BUDGET --archive-budget-bytes ARCHIVE_BUDGET
```

Uppercase arguments are required candidate-specific values. The source is the
directory containing the final native `manifest.json`; the output must not exist.
The command verifies every referenced payload, exact reference closure, decoded
simulation limits, shared texture dependencies, reduced mip preservation, collision
bounds, character/vehicle publication rules and public text/GLB metadata. It never
resizes textures or rewrites accepted payloads. The output contains:

- `pages-world.tar.gz`: deterministic regular-file USTAR/gzip archive, preserving
  every original file byte under `world/RELEASE/`.
- `upload-inventory.json`: hashes, sizes, MIME types, CORS/cache/compression contract
  and `LOCAL_VALIDATED_NOT_PUBLISHED` status. Provider and base URL remain `null`.

The external hard ceilings are 4,000,000,000 world bytes, 2,000,000,000 archive
bytes and 20,000,000 shell bytes. Each candidate must declare budgets at or below
them. File count (10,000), manifest size (8 MB), gameplay size (8 MB) and individual
decoded simulation size (64 MiB) remain unchanged. Pages mode still enforces its
960 MB world/980 MB archive and complete-artifact ceilings; the append/legacy
preparer's stricter 950 MB Pages ceiling also remains unchanged.

After provider selection, an external descriptor uses all existing descriptor
fields, changes `schemaVersion` to `2`, and adds exactly:

| Field | Required value |
| --- | --- |
| `deliveryMode` | `external` |
| `worldOrigin` | Explicit selected public HTTPS asset origin, without path or port |
| `worldBaseUrl` | Directory under that exact origin, ending in `/` |
| `corsOrigin` | `https://mattitynka.github.io` |
| `worldBudgetBytes` | Explicit positive integer, at most 4,000,000,000 |
| `archiveBudgetBytes` | Explicit positive integer, at most 2,000,000,000 |
| `shellBudgetBytes` | Explicit positive integer, at most 20,000,000 |

`archiveUrl` retains the approved repository's GitHub release-asset allowlist.
`archiveBytes`, `archiveSha256`, `worldBytes` and `manifestSha256` come from the
validated packet. The release directory is immutable; a new world needs a new
release ID. Do not create a descriptor with an invented deployment domain.

Validate the descriptor and build the shell using the three emitted
`VITE_WORLD_*` variables, then stage with:

```powershell
python tools/release/stage-pages-world.py validate --descriptor EXTERNAL_DESCRIPTOR --github-env ENV_FILE
python tools/release/stage-pages-world.py stage --descriptor EXTERNAL_DESCRIPTOR --archive FRESH_PACKET/pages-world.tar.gz --out BUILT_SHELL --source-sha SOURCE_COMMIT --world-out FRESH_UPLOAD_DIRECTORY
```

`--world-out` must be a new directory separate from the built shell. It receives
the validated world and upload inventory. The shell receives only its release
receipt and `.nojekyll`; it never contains the external world. The receipt says
`LOCAL_VALIDATED_NOT_PUBLISHED`. The built shell must use this descriptor's exact
base URL, release ID and manifest hash. Staging does not establish that a remote
origin exists or serves the bytes.

The Pages deployment workflow refuses generic external descriptors until that
provider has a served-object verification gate. The explicit GitHub raw profile
below has such a gate; every hosted object must pass before the shell artifact can
be uploaded. Ordinary Pages releases retain their existing limits and path.

Upload each inventory object under the selected base directory plus its `key`.
Refuse overwrites. Serve the listed MIME types and required headers. In particular,
`.gz` payloads use `application/gzip` **without** HTTP `Content-Encoding`: the
runtime verifies the stored compressed bytes and performs decompression itself.
Disable automatic image optimization, compression and directory fallbacks. The
exact Pages origin must be permitted by CORS, without credentials. Verify GET/HEAD,
all bytes/hashes/headers, 404 behavior, failed/retried streaming, cold/warm browser
loads and native traversal/performance gates before changing the shell pointer.

Retain the old source/descriptor/world tuple. Rollback rebuilds the shell with that
tuple; it never rewrites objects inside an existing release directory. The native
service worker keys the bounded cache by the selected release/build and already
accepts the explicit immutable world prefix. Hosted cache behavior still requires
verification on the actual origin.

Run the portable release suite and existing runtime deployment tests with:

```powershell
python -m unittest discover -s tools/release/test -p 'test_*.py'
node --test apps/game/test/deployment.test.ts
```

## Explicit GitHub raw profile

Schema version `3` adds exactly `deliveryProvider: "github-raw"` to the version-2
external descriptor. It accepts only
`https://raw.githubusercontent.com/MattiTynka/Helsinki-rides/FULL_40_HEX_COMMIT/world/`.
Branches, tags, abbreviated commits, other repositories and alternative prefixes
are rejected. `worldOrigin` is `https://raw.githubusercontent.com`; `corsOrigin`
remains the intended requesting Pages origin. The production descriptor is not
changed by preparing a candidate.

This public-data profile explicitly permits wildcard response CORS without
credentials, `text/plain` JSON and `application/octet-stream` stored gzip. HTTP
gzip is allowed for ordinary files only when the decoded response exactly matches
the manifest. A stored `.gz` file must have **no** HTTP Content-Encoding, and its
compressed bytes must match. The reviewed HTTP cache policy is `max-age=300`,
not a one-year immutable header. Full commit paths, manifest/payload hashes and
the native bounded service-worker cache provide content identity; they do not
guarantee provider availability. JavaScript, WASM and Basis decoders remain in the
Pages shell. The strict generic-provider contract above is unchanged.

Prepare the validated archive first with `prepare-external-world.py`. Then create
a fresh isolated **local** asset repository and descriptor draft:

```powershell
python tools/release/prepare-github-raw-world.py --source FINAL_WORLD --packet VALIDATED_PACKET --out FRESH_LOCAL_ASSET_PACKET --expected-manifest MANIFEST_SHA256 --world-budget-bytes WORLD_BUDGET --repository-budget-bytes REPOSITORY_BUDGET --archive-tag REVIEWED_RELEASE_TAG
```

For later releases, add `--previous-assets-repo ACCEPTED_LOCAL_ASSETS_GIT
--previous-asset-commit ACCEPTED_FULL_COMMIT`. The previous repository is read-only;
output cannot overlap it, the world or the archive packet, including through a
junction or Windows case alias. The initial commit has no parent. Later commits
retain the accepted asset commit as their parent so old commit URLs remain
reachable for rollback. The current tree contains `.gitattributes` (`* -text`) and
only the current world. Git blobs are written without filters, reread, and compared
to every source SHA-256 and byte count. No remote is configured or contacted.
The commit uses the already-reviewed public display name with no email address.

The output contains `assets.git`, `measured-push.pack`,
`preparation-receipt.json`, `upload-inventory.json`, and
`descriptor.local-not-published.json`. The receipt measures all local refs and
reachable object bytes, enforces a declared repository budget up to 5 GB, rejects
objects above 100 MiB, and counts the actual prepared push pack below a conservative
2,000,000,000-byte ceiling (also below 2 GiB). An incremental pack assumes the
declared previous commit is already on GitHub. It is not proof of a successful
push or available provider capacity. The final CI staging still extracts and
validates the independently pinned archive; archive hashing alone is not that gate.

Policy refresh, 30 October 2026: GitHub still limits a published Pages site to
[1 GB](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits).
Normal Git rejects files over [100 MiB](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github),
and the [repository limits](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits)
document an enforced 2 GB push limit. This profile's 5,000,000,000-byte repository
budget is a conservative project bound, not a claim of a universal hard GitHub
repository limit. The documentation recommends keeping repositories small and
storing generated files outside Git. The selected transport therefore retains
its bounded immutable project-asset inventory, measured pack, complete served
verification and rollback checks; local size acceptance alone is insufficient.

Only after full central asset, license, privacy, real-control and performance
gates pass, review the exact local asset commit and source/descriptor pair. The
authorized publisher must compare the remote `world-assets` ref with the declared
previous commit (or confirm it is absent for the first release), publish only
that prepared asset commit, and publish the pinned `pages-world.tar.gz` release
asset. A lease protects against concurrent advancement; never use `--mirror`,
`--all`, or an unqualified force push. These are manual promotion steps: neither
preparer nor verifier contains a network-write operation. Recheck actual remote
ref/pack assumptions before pushing, rather than treating a previous local count
as a hosting guarantee.

After authorized publication, stage the shell and separate world as above, then:

```powershell
python tools/release/verify-github-raw-world.py --descriptor FINAL_DESCRIPTOR --world VALIDATED_UPLOAD/world/RELEASE --out FRESH_SERVED_PROOF --shell BUILT_SHELL
```

The verifier accepts at most four concurrent requests, only descriptor-derived
allowlisted HTTPS URLs, no redirects, bounded transport/decompression, exact
GET bodies and HEAD/CORS/MIME/cache headers, and a direct missing-object 404.
It revalidates the complete local world before any request. Optional `--shell`
records the verified object-result digest only when the shell receipt matches
the descriptor/commit/manifest and still fits its unchanged 20 MB maximum budget.
This HTTP gate sends the Pages Origin header; actual browser-origin loading,
original-loaded response identity, controls, streaming and performance checks
remain distinct required promotion evidence.

The workflow initially checks out only the selected source commit at depth one,
then fetches its complete source ancestry without tags or asset refs for the
existing history/privacy audit. `audit-source-history.py` records the selected
SHA, exact audited ref set and ancestor count, and rejects shallow or unrelated
ref coverage. It does not claim to audit all remote refs. Normal all-branch clones
can still download asset history; source developers should select only `main`.

GitHub enforces file/push limits and may throttle excessive file hosting. Its
guidance recommends keeping repositories small and storing generated files in
object storage. This route has no bandwidth or availability guarantee; unchanged
Git blobs deduplicate, but changed binary versions accumulate. See the official
[repository limits](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits),
[large-file guidance](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github),
and [bandwidth policy](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies#9-excessive-bandwidth-use).
