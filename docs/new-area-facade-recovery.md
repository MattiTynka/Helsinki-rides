# Recovering native city facades

This extends [the facade cleanup protocol](facade-cleanup-protocol.md) for the
optimized external-texture delivery format described in
[the web delivery handoff](handoff-2026-10-20-web-delivery.md). It is a production
method and evidence contract, not a claim that every expansion facade is finished.

## Establish what is missing

Inspect the native CityJSON building's actual parts and triangles. An atlas URI
does not prove facade detail: the native cell builder assigns source-null walls
and roofs to separate solid-colour atlas tiles. Count wall, roof and underside
areas separately, retaining exact BID, VTJ, source part/triangle, oriented face key,
owner cell and manifest-pinned near/far payloads.

`census_delivery_new_area_facades.ts` performs that census. Its finite public-road
axis and occlusion screening selects investigation candidates; it does not establish
that a wall is a street elevation. Courtyards, party walls, steep roof facets,
foundation strips, internal stands and small ancillary structures need their own
disposition. Report matched/unmatched wall area and the largest remaining facet,
not just triangle counts or the presence of an image.

The initial 1,230-building expansion census contained 904 buildings with detailed
wall textures, seven with detailed walls and null roofs, and 319 with null walls.
Exact current municipal appearance research found 2024 wall images for 183 of the
319, then 2021 wall images for six more. The remaining 130 have no image in either
accepted theme. These are source-availability counts. They are not visual acceptance
or whole-building reconstruction counts.

## Recover official appearance before redrawing

The current public viewer at <https://kartta.hel.fi/3d/> advertises the municipal
CityGML exporter. Request only exact selected public BIDs, LoD2 geometry and the
`rgbTexture_2024` theme. Try `rgbTexture_2021` only for missing or unsuitable current
appearance, binding it to the same current source vertices. Do not use 2017 mesh or
appearance. Helsinki describes the data and license on its
[official 3D information page](https://www.hel.fi/en/decision-making/information-on-helsinki/maps-and-geospatial-data/helsinki-3d).

`fetch_delivery_facade_appearances.py` reads the public viewer's exporter credential
into memory, restricts all requests and redirects to the pinned municipal HTTPS
endpoint, caps responses/archives, and saves sanitized receipts. Never publish the
viewer configuration, credential, raw FME response or server paths. Do not send an
email address or account information to acquire public building data. Raw source
archives and photographic pages belong in the ignored work cache, not Git.

`prepare_delivery_native_facade_sources.py` verifies the downloaded archive, native
city JSON and binary hashes. Every selected native source-null wall triangle must
match all three vertices of one unambiguous exact-BID/VTJ CityGML polygon, including
its image and ring UV binding. The accepted maximum source identity distance is
5mm; actual projection/quantization differences were below3.2mm. This is solely a
texture-source identity allowance. Native render coordinates, winding and physical
collision geometry remain literal. Reversed source-polygon conventions do not
authorize reversing native triangles. Ambiguous image or UV bindings fail.

The preparer accepts only the requested 2024 or2021 theme, safe bounded image paths,
and XML without document types or entities. It records unmatched native triangles
explicitly. An image-bearing model with no mapped wall area remains unresolved.

## Qualify the surface and the camera

Open the actual corresponding Google Maps/Street View panorama. Record the observed
capture date, panorama ID, heading and factual facade layout. Older leafless views
can clarify openings hidden in summer imagery; compare their materials and layout
with the current view. A panorama's address label identifies its camera location,
not necessarily the building being viewed. Confirm the target from source geometry,
street alignment, entrance number and adjacent buildings. Reference pixels are not
downloaded into production art.

Before calling an image wrong, prove which native surface is visible. Place the
camera on actual decoded ground/HCOL support, at an explicit eye height, and ray-test
the intended wall against nearby native faces. Being outside a building's bounding
rectangle is insufficient: another building can be closer to the camera. Being
inside that rectangle is also insufficient to prove an indoor view: an entrance
court can be open. Internal stadium seating and true exterior cladding must not be
assigned the same semantic role merely because they share a building ID.

An early Stadium prototype illustrates this gate. Its27 apparently suspicious
seating/track-textured faces were subsequently proven behind the true south outer
shell;23 were visible from inside the bowl and20 had inward normals. The original
timber overlay for those faces was rejected. Retain the licensed inner-surface
appearance and inspect the actual outer shell from qualified exterior cameras.

Contact sheets can reveal image quality and baked trees, but a sheet of one
candidate wall per building does not prove every elevation. The physical rectifier
stores its own vertical chart direction; display inspection crops with physical
upward Y, independently of the atlas's stored row direction. Runtime UVs must be
checked using their own actual source correspondence.

## Transfer or author only selected material coordinates

For accepted photographs, `delivery-new-area-facades-rectify.ts` allocates bounded
physical wall charts and samples the actual native triangles' source UVs using
barycentric interpolation. It does not invent a quadrilateral homography or change
triangulation. The atlas contains facade pixels rather than large unused roofs,
roads and photograph context. Planar charts retain a2mm plane gate; non-planar
source groups split into their unchanged native triangles. Edge bleed extends
existing edge colour, not invented architectural detail.

If the source lacks an image or the actual visible wall has unsuitable baked
occluders, make original reference-led art. Bind a profile to exact native oriented
face keys and per-plane charts. Keep observed floor/window groups and materials;
do not tile generic apartment windows onto a stadium, church or sports hall.
Determine ground levels from actual visual/HCOL street support so windows and doors
do not extend below the street. Record approximations and unseen elevations.

`author_delivery_bulevardi_facades.ts` is a source-qualified example: the observed
Bulevardi 22 northwest front has yellow plaster, cream frames, four upper opening
rows, ground shop glazing and native rounded/polygonal bays. Its 53 native facets
share an original projected elevation while keeping independent exact planes.
The reusable `chartInProjectedElevation` gate rejects reversed or off-plane targets.
Original art contains no Google photograph pixels or embedded external images.
The same author supports individually qualified Bulevardi 11 and 13 fronts, with
separate source selectors and asymmetric Jugend drawings. An outward vector is
`[-uAxis.z, uAxis.x]`; using its reverse silently probes inside the building.
Require actual rendered-ground and HCOL agreement for each exterior sample.

`apply_delivery_original_facades.ts` accepts the existing `DeliveryFacadeProfile`
contract. It verifies the author's pinned baseline manifest and baseline tier
hashes, then rebinds exact source BID/VTJ/face keys against the current derivative.
Original PNG pixels, chart UVs and chosen material settings are retained before
encoding; they are not regraded as municipal aerial photographs.

For a declared complete flat elevation, set `completeElevationPlane` in its
observed plan. `assertCompleteSelectedFacadePlane` checks every source-null wall
triangle on the same native plane inside the selected elevation bounds. This
prevents a tiny numerical normal difference in a source-plane census from leaving
an unpainted diagonal across an otherwise repaired wall. It is a complete-plane
check, not a claim that every building elevation has been repaired.

For a bayed elevation, `completeElevationSupportPlanes` checks each selected
native support plane independently within its explicitly selected projected
elevation. It catches omitted coplanar diagonals on a second bay plane while
leaving entirely unselected planes unqualified. The per-triangle chart projector
still enforces the same2mm physical plane gate; it never flattens the geometry.

Adjacent independently observed originals in one owner can share a compact block
atlas through `combine_delivery_original_facade_profiles.ts`. It verifies both
pinned source PNGs are reproduced by their original SVGs, re-rasterizes the two
elevations into separate508x1020 regions with a four-pixel gutter, and preserves
every exact source face/chart binding. This is not permission to use the same
window arrangement on both buildings. Inspect both Standard and Low afterwards.

Keep storeys level on sloping streets. A few named, individually qualified plans
use an explicit nine-sample source-floor profile and a separate horizontal
opening datum. The Bernhardinkatu annex follows those samples only with its
stone-plinth polygon; the hotel follows them at each ground glazing bottom.
Upper windows and cornices retain a single horizontal datum. These narrow gates
pin the selected native triangles, building, baseline, all nine floor heights
and declared datum. Changed floors require requalification. They do not widen
the generic author's one-metre ground-range guard or change physical geometry.

## Plain walls and access/age exceptions

Use `author_delivery_observed_facade_finish.ts` for an individually observed
uninterrupted party-wall/utility finish. A pinned plan declares exact source
part/triangle pairs, building BID and explicit VTJ or null, actual architectural
role, references and limitations. The author checks complete native support-plane
coverage and writes original512px plain or single-plane brick material art. For
several explicitly separate planes, an uninterrupted plain colour can share the
same tile. Brick planes instead receive their own metric drawings in a bounded
1024px atlas with a common physical pixel density and eight-pixel gutters. The
source ledger records each placement. Never stretch the first plane's brick
image onto differently sized returns: that changes the physical brick module.
The single-plane and grouped-plain paths preserve the prior artwork bytes.
The author infers no
ground height, storeys, windows or doors through a neighboring roof. Grouped
profiles accept an explicit null VTJ for an anonymous source building; a missing
or empty VTJ is rejected, and the exact BID/null pair must still match the source
and owner. The legacy single-owner profile keeps its original non-null contract.

An OSM footway with no private tag is a camera candidate, not proof that a closed
military gate or residential court is publicly accessible. Record actual access
and first-hit evidence. A panorama snapped to a neighboring street must not be
used to paint an unseen courtyard elevation. An unsuccessful search is not proof
the wall is plain or invisible.

Also compare the reference date with source-building identity. The Kaartin block
illustrates why: the old Fabianinkatu2 C/D curtain-wall offices were demolished
from2022 and replaced for2024/2025, according to the
[official developer](https://www.senaatti.fi/hankkeet/suojelupoliisin-uusi-toimitila/).
Opened2020 and2024 Street View appearances differ materially. Do not paint a new
building onto obsolete massing and claim exact current geometry, or reproduce
temporary construction screens as its permanent facade. Qualify the replacement
source or record the explicit limited historical/held disposition before repair.

## Write the delivery derivative

Run `apply_delivery_native_facades.ts` for prepared municipal profiles, or
`apply_delivery_original_facades.ts` for original profiles. Both require an exact
current manifest hash, profile hash, native city source and pinned grade config.
The original adapter additionally requires the author's baseline world. Output
must be a fresh independent directory. Apply against fresh actual cells after
ground, bridge, road and tram work, so a facade patch cannot replace a newer cell
with an older payload.

`prepare_delivery_native_facade_atlases.ts` can encode each actual owner atlas once
into a hash-pinned reusable cache. The cache binds the source profile, grade,
geometry selectors, physical charts, encoded textures and exact Low mip tails.
It does not authorize overwriting newer owner GLBs: rebind its exact native faces
against the final post-road/tram world. If the measured closure needs relief,
first measure the opt-in `--rdo-quality 1` recipe at the same source dimensions.
The default0 recipe delegates directly to the original facade encoder and is
tested for byte identity. RDO1 changes the encoder's rate/distortion setting for
new municipal atlases only; it does not change source pixels, physical charts,
geometry, UVs, resolution or mip count. Encode a new immutable cache and retain
the original cache. The cache records the explicit recipe and raw RGBA digest.
`verify_delivery_native_facade_atlas_derivative.ts` compares every owner's exact
source face positions/UVs/vertex colours/rectification and mip dimensions against
the pinned original cache, and verifies its new exact Low tail. Legacy caches
have no raw pixel digest, so that comparison does not claim a full legacy RGBA
replay. Required image/runtime review and final closure measurement still apply.

If same-resolution encoding is insufficient and a separately measured new-only
mip plan is approved,
`plan_delivery_native_facade_atlas_mips.ts` measures eligible new-photo atlas tails
and chooses the fewest owners needed for the requested bytes. It rejects shared
payload groups rather than making an unsupported optimality claim.
`trim_delivery_native_facade_atlases.ts` reuses literal lower encoded levels without
re-encoding, changing old textures or raising caps. Minimum physical density is a
planning gate; actual Standard/Low image review remains required.

Near payloads retain the original BIN prefix and all unselected descriptors,
images and UVs. The selected native coordinates/winding multiset remains exact;
only material coordinates and drawing partitions change. New opaque atlases are
external KTX2 with sides no larger than1024. Low uses the exact encoded mip tail,
not a second lossy encode. Distinct source atlases sharing identical lower mips
must retain both source-to-Low mappings. Distant tiers replace selected vertex
colours within existing draws: no new far draw or far photograph atlas.

Run `census_delivery_native_facade_tiers.ts` before applying a complete source
profile. Near coverage must include every selected exact face. A simplified
coarse tier may have different triangulation: the distant writer can explicitly
use the exact-key intersection while recording every unmapped source key, count
and near-source wall area. It leaves unmatched coarse geometry and colours
unchanged. This is intentionally a flat-colour distant representation, not full
texture coverage. Never loosen the near identity gate or guess a coarse union
selector to hide a mismatch. Inspect actual near/coarse silhouettes and colour
transitions; an unexplained grey stripe is not an acceptable disposition.

The Bulevardi11 turret has one explicitly qualified colour-only exception to the
exact-key coarse subset. Three detailed triangles507/509/510 simplify into two
coarse triangles1279/1280. Its separate `coarse-colour-plan.json` pins all native
vertices, the exact source topology, coarse points and the measured simplification
difference polygon. A named B11-only gate requires that exact fingerprint, normal
agreement and elevation containment, and confirms the entire difference bounds
remain inside the same observed upper plaster colour. It is not a generic area
tolerance or image/physical identity claim. The colour writer rejects shared
vertices used by an unselected neighboring face and retains all accessors,
positions, indices, UVs, meshes and draw counts literally. Only its colour buffer
view receives a new encoded payload; all original BIN bytes remain a prefix.
If an entire existing near primitive is selected, replace its material in place
instead of emitting an empty original draw. Preserve its original geometry and
all existing BIN/accessor prefixes.

Run Khronos validation using the actual pinned external resources, structural
geometry checks, exact M1 checks, immutable source checks and closure accounting.
Preserve HCOL, terrain, gameplay, roads, scenery, old images and unselected geometry.
Retain the existing 950MB/10,000-file closure, 64MiB per decoded compressed payload
guard, unchanged runtime preset texture budgets, and near/far draw limits. If the
eligible new-city textures need mip trimming to fit, use the accepted delivery
optimization method; do not raise the caps or degrade protected existing assets.

## Review the actual runtime

Capture Standard and Low views of the exact candidate and its HTTP-requested assets.
Open every relevant front/oblique image. Check alignment, horizontal/vertical flips,
diagonal seams, baked vegetation, window/door ground placement, corners, near/far
appearance and memory/draw counts. A passing script is not visual acceptance.
Keep natural3D trees distinct from trees baked into a wall photograph.

Asset-fixture bundles with private camera placement helpers are valid bounded asset
checks, not a substitute for the final normal production bundle, startup behavior,
journeys, adversarial review and deployed Pages verification. Report exact selected
facade coverage, remaining plain/held faces and whether evidence is local or hosted.
