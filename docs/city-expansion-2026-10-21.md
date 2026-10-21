# Theatre and northern city extension

This pass starts from deployed source `c91c780` and its 304-cell
`senate-20261020-reference-repair-v3` world. The intervening facade, tram and
startup repairs are retained. The release descriptor and final verification
receipt identify the published source and world; acquisition receipts alone
are not proof of playable coverage.

The selected rectangle is X −1792 to 800, Z −2304 to 768 in the existing
Senate Square frame. Its southern addition includes Aleksanterin teatteri at
Bulevardi / Albertinkatu. Its northern addition continues through Hakaniemi,
Kallio and the Hämeentie approach towards Viikki. It does not reach Viikki
campus. The selection rectangle is 7.96 square kilometres. The final 515-cell
manifest includes complete owner-cell extents, X -1920 to 896 and Z -2304 to 768.
These data extents do not imply that every road or building has been hand rebuilt.

## Source policy

The new municipal textured LoD2 snapshot is version `305259202062`, whereas
the accepted building data used version `303357262605`. Acquisition retains
both identities. The 287 overlapping building position/winding sets were
compared in Float32 and matched; their changed raw GLB/UV descriptors are
not used to regenerate accepted buildings. Only 1,230 new strip-owned
buildings are selected, retaining their complete source geometry. Whole
buildings can extend beyond their owner cell or the play boundary.

The terrain, tree and street/register inputs retain their municipal source
ledgers. Old authored terrain bits and physical road/footway segments are
protected independently of source graph IDs. Newly available junctions can
retessellate lane endpoints and connector IDs without moving an accepted
physical road. The four Välskärinkatu lanes and two connectors keep the actual
accepted repair. The construction classification on OSM way 23815853 excludes
its new-area portion while retaining the accepted old-area portion.

OpenStreetMap contributor metadata and unrelated acquisition records remain
outside the public source distribution. Public geometry extracts must have an
ODbL notice. Street View and municipal plans guide original reconstruction;
their image pixels are not distributed as game textures.

## Delivery policy

Follow [the web delivery handoff](handoff-2026-10-20-web-delivery.md) and
[decision 0022](decisions/0022-web-delivery-collision-streaming-and-texture-tier.md).
Existing optimized geometry, image payloads, reduced mips, characters, cars,
gameplay anchors and unrelated cell content are retained. Only additions are
optimized. Boundary owner cells append the new buildings and metadata.

Both new frontiers use the native source assembly across six external and
five accepted metres. The accepted interior remains protected; any changed
fallback terrain sample within the five-metre boundary band must be lower.
Clipping preserves original planes, interpolated attributes and winding.
This is a source-ground reconstruction, not a guessed boundary ramp.

New city atlases use the existing Pages texture policy, with a smaller Low
tier made by retaining encoded mip levels. Simulation payloads retain decoded
integrity checks and exact collision extents. Distance-based visual and
collision residency remains active. The world, whole-site, file-count and
64 MiB decoded-payload limits are unchanged.

The northern inland-water repair distinguishes ten inland source water features
from the sea mask. It replays the original frozen municipal ground producer
before coastal clipping, restores only the native faces and safety samples
wrongly removed inside those exact rings, and removes the misplaced sea plane.
Original height and UV interpolation is retained. Freshwater pond surfaces and
ride structures need their own elevation authority and are not approximated by
the global sea level. The [repair protocol](../content/helsinki/city-expansion-20261021/inland-water/v2/README.md)
records the source, preservation and acceptance requirements.

At genuine sea boundaries in the new northern strip, vertical bank faces close
the gap below the actual native ground. They reuse its material and have the
same visible and solid triangles. The [coastal bank protocol](../content/helsinki/city-expansion-20261021/coastal-banks/v1/README.md)
requires literal source-floor collision twins, preserves open bridge and pier
spans, and leaves horizontal ground, water elevation and the old strip intact.

## Bridge reconstruction and acceptance

Hakaniemensilta uses the newer eastern alignment opened in 2024. The adopted
31415/1–2 plans distinguish the upper carriageways from the lower outer
walking/cycling decks. Pitkäsilta's granite arches, piers and solid parapets
are reconstructed separately from its warped source deck. Every authored
walkable surface must have matching rendered and collision geometry, a
qualified bank transition and real native traversal evidence.

Completion requires the closed final payload inventory, Standard/Low visual
review, continuous keyboard journeys, bridge contact and vehicle checks,
streaming eviction/return, privacy gates, independent adversarial review and
verification of the actual Pages deployment. See the final release receipt
for measured counts, hashes and results.

## Publication scope

The owner requested publication of the completed work before further expansion,
because local disk space was low. This beta retains the previous Senate Square
entrance/facade repairs, additional tram coverage, English/Finnish startup choice
and screenshot-backed start screen. It adds the municipal city strips, rebuilt
bridge surfaces and approaches, official facade recovery and completed original
facade profiles. The committed Pages descriptor pins the exact delivered world.

Delivery compacts unused model data without changing active geometry, and
reuses the reviewed native texture encoding. Sixteen newly recovered photographic
atlases retain one fewer encoded mip level to meet the unchanged Pages budget;
the corresponding Low textures retain the next literal mip chain. Accepted
old-city textures, Stadium/Kisahalli primary atlases and the completed original
facade artwork are preserved at their selected sizes.

The new nonruntime tram support and bridge profile JSON records are also stored
as gzip with their original decoded byte counts and SHA-256. Each conversion records the
old and new references, preserves every decoded byte and leaves all runtime
references, accepted baseline publications and operational bridge/junction chains
unchanged. This saves about 7.1 MB without changing any model or texture. The
explicit conversion tool is `tools/world/compress_delivery_publication_json.ts`.

This is a partial city expansion. The northern extent stops before Viikki campus.
Two bridge walking directions remain blocked, some source-null facades remain
plain, and further bridge-side approach and tram work is deferred. New and
accepted tree instances/colliders retain their source positions; pending soil
corrections were not applied. Unqualified facade drafts are excluded from the
world. Earlier focused checks do not establish uninterrupted travel over every
street or a long-session performance guarantee for the whole enlarged map.

Publication checks cover the sanitized source export and reachable Git history,
image metadata, every manifest-pinned world payload and archive ownership fields.
The Pages workflow repeats source, type, release-tool and packet gates against
the selected main commit. Hosted smoke checks bind the actual deployed source
and world and exercise ordinary game controls without the review adapter.

The closed publication world is `senate-20261021-city-expansion`, manifest
SHA-256 `1178aa4520c9c9bc5c371d85cd7229205a4836a123391f1ec38745448b89f8c1`.
It contains 515 cells and 3,364 files totalling 948,123,955 bytes. The committed
Pages descriptor records the compressed archive's independent digest and size.
