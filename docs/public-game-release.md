# Public browser beta

The project owner authorized public source and GitHub Pages publication on
19 October 2026. The source repository is
[MattiTynka/Helsinki-rides](https://github.com/MattiTynka/Helsinki-rides).
The intended game URL is
[Helsinki Rides](https://mattitynka.github.io/Helsinki-rides/).

## Pages packaging

This release keeps the complete 304-cell central Helsinki map. The original
desktop world is `senate-20261019-08b1f804`, manifest SHA-256
`6f1e5b68f16fb8b34ad8ad1f02f2a03e05fb36fcfac5510c4f5fe3fd22e2858b`.
Its 1,684,371,576 bytes exceed GitHub Pages' published-site size limit.

The owner selected smaller web textures rather than an external asset account.
`tools/release/prepare-pages-world.py` makes a separate world using the existing
KTX2 mip chain for city atlases above 1024 pixels. This copies the retained
compressed image levels exactly. Geometry, collision, navigation, gameplay,
character animations and the supplied hero assets remain unchanged. The
authoring inputs and the local active-world pointer are preserved.

The committed `content/releases/pages.json` descriptor pins the derived world,
its manifest, a GitHub Release archive and the archive's exact hash and size.
The archive is a release download, outside the source Git tree. The manually
triggered Pages workflow verifies the packet, builds the ordinary production
application, and stages both into one Pages artifact. The published game needs
no account, API credentials, paid asset host or gameplay server. Visual cells
continue to stream as the player moves.

The packet verifier checks regular archive entries, exact file inventories,
manifest references and hashes, and both world and complete-site size limits.
Build and deploy jobs have separate permissions. Forks and non-main refs cannot
use the publishing job. The review adapter is excluded from the production
bundle, including when a visitor supplies `?review=1`.

## Content notices

Known City of Helsinki, photographer and Blender Studio credits stay in the
manifest and in-game attribution. The packet includes a notice, the exact
OpenStreetMap source publication extract and ledger, and the generated road database.
OpenStreetMap database content remains under ODbL 1.0. MIT covers original code
and documentation; it does not relicense models, photographs or databases.

The owner requested publication and supplied additional copyright information
on 20 October 2026. The Lumi GT/patrol Mustang source and Revontuli Veyron source
are by NoOb StUfFs under CC BY 4.0, independently verified using Sketchfab's
public model API. The supplied Cathedral is credited to Dany Sánchez /
MiniWorld3D with optimizations by Jukka Seppänen (@kijaidesign), under CC BY 4.0
as declared by the owner. Its authorship is corroborated; its supplied version's
exact original license has not been independently retrieved. The
[asset credit ledger](../content/releases/asset-credits.json) distinguishes that
declaration from independent verification and records the exact source links.

Kaamos / GT40 is removed following the owner's report of a redistribution
restriction. Remaining Alexander and custom character/motion copyright details
are pending. No new copyright or open-license grant is invented for them.

## Verification and limitations

The source check and privacy audit of commit
`98fb1e5ef6fe825c9d36d7de52ff6260223c7ef2` passed before visibility changed.
World publication checks cover all 926 original files, 617 GLB JSON chunks,
their embedded image metadata, and all 925 manifest payload references.
They found no credential or operator-private metadata.

The deployment workflow repeats portable source tests, TypeScript checks,
release-tool tests and packet verification. Hosted smoke evidence is stored
locally under ignored `build/release-audit/`; it records the exact deployed
source/world, browser errors, ordinary keyboard/UI interactions and captures.
Images require visual inspection before an appearance claim. Desktop beta
performance is device dependent, and the initial simulation data download is
large. Earlier local journey/performance results remain bound to the builds
named in their benchmark records.

## Releasing and rolling back

1. Prepare a fresh derivative and regular-file archive with
   `tools/release/prepare-pages-world.py`; retain its local receipt.
2. Audit its JSON, model/image metadata and exact file inventory. Keep source
   notices and machine-readable database material with the packet.
3. Upload the audited archive as `pages-world.tar.gz` on an identified GitHub
   Release. Record its immutable expected hash and byte counts in the descriptor.
4. Commit the descriptor and source, then run the manual Pages workflow from
   `main`. The workflow refuses an altered or oversized packet.
5. Open the actual Pages URL and run `tools/verify/smoke-pages.mjs`. Inspect its
   screenshots and record the deployment identity and any remaining failures.

For a later rollback, restore a tested source/descriptor pair whose asset rights
remain cleared and run the workflow again. Remove restricted historical packets
from public release downloads, Git references and deployment artifacts. A source
or packet that contains the removed GT40/Kaamos must not be used for rollback.
An already open old session must reload to select the replacement world.

The [travel and memory retention correction](streaming-memory-fix-2026-10-19.md)
documents subsequent request cancellation, actor GPU cleanup and production
recording changes. It keeps the same world packet and visual residency limits.

The [Revontuli and Kaamos integration](decisions/0021-revontuli-and-kaamos-cars.md)
records their earlier local and public integration. That acceptance is
historical: the 20 October 2026 credit correction removes Kaamos and retains
Revontuli alongside the Lumi GT. The replacement desktop world is
`senate-20261020-credits`; its Pages derivative is
`senate-pages-20261020-credits-tex1024`. The committed Pages descriptor and packet
receipt are the authority for their hashes and byte counts. The complete
304-cell map remains, with the existing web texture policy. Reload after
deployment to select the replacement world and its updated credits.

The replacement Pages world contains 934 files and 942,316,787 bytes; its
archive is 664,697,272 bytes. The descriptor pins the exact archive and manifest
digests. All 304 existing city cells and the retained model payloads are byte
identical to the preceding packet. Gameplay changes remove only the Kaamos
definition and its `car-4` spawn; source credits and publication notices are
updated. The removed archive on `pages-cars-20261020` and its Pages Actions
artifact are withdrawn. Model binaries were never part of the public Git tree
or its history.

The loading screen links the two car sources and their author, City of Helsinki,
Cathedral creators, Blender Studio and OpenStreetMap to their source and license
pages. Links open separately without starting play. The panel scrolls on short
screens. Publication checks reject Kaamos/GT40 asset and gameplay identities
and the withdrawn GLB's exact SHA-256, including renamed copies of that export.

The subsequent [Senate Square reference repair](senate-square-repair-2026-10-20.md)
starts from deployed source `9bbbba7` and the optimized `m1-cb` world. It repairs
the University and Government Palace entrances and restores selected blank
facades with original artwork informed by Street View. It retains the full
304-cell map and reduced-texture tier. The committed Pages descriptor remains
the authority for the current archive and manifest; the live deployment receipt
binds them to the published source commit.
