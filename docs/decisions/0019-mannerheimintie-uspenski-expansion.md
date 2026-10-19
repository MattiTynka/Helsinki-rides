# Mannerheimintie, Uspenski and source-backed coastal ground

Status: LIVE_LOCAL_PREVIEW, 2026-10-18. Offline implementation, seven affected
native jobs, activation/restart/HTTP and ordinary browser/image integration pass.
The active local preview is `http://127.0.0.1:5317/`. Selected content is
`senate-20261018-7fc03703`, manifest SHA-256
`954782564d93cc59a6919c9e598cd77f3813b2b9860d766fe389b0df5d5b089d`.
Both local pointers now select `senate-20261018-7fc03703`.

The owner requested further city expansion, especially Mannerheimintie and
Uspenski Cathedral. The bounded next area is X `[-1350,800]`, Z `[-950,450]`,
3.01 square kilometres. It retains the previous origin, grid, source vintage,
Finn/Rain/car assets, Alexander monument and facade reconstructions. The 2017
mesh stays removed. See the [build record](../district-expansion-build.md).

The official city layers and OSM are frozen offline. Accepted city-model
buildings, texture indices and binary data remain exact prefixes, so existing
source-bound facade maps retain their meaning. Trees retain accepted placement
and trunk-collider policy even where the larger road graph changes proximity.
The enlarged registered parking inventory remains source-derived. The two named
hero/patrol placements, player spawn, weapons and police settings stay fixed.
Six generated parked cars follow the expanded inventory. All eight placements
then remain exact throughout the subsequent v3-to-v8 road repairs.

The coastal extension needs a representation absent from the inland pilot.
Directed OSM coastlines (land on their left), closed water polygons and complete
water relations define the shoreline and canal. Missing inland chain endpoints
fail the build. Actual ground triangles are clipped against water with their
existing heights and UVs interpolated at the cut. Unaffected pieces retain their
original arrays. Source-dry accepted ground remains subject to strict preservation
checks; the former fallback paving over a small accepted harbour corner is
intentionally corrected.

Water is a textureless mesh in ordinary streamed cells, without a walking
collider. Its static plane is N2000 zero, an explicit cartographic convention
rather than a tide observation. Only the derived safety heightfield is lowered
under water, below the existing kill plane; source terrain heights stay exact.
Falling into water uses the existing safe respawn. Swimming is outside this change.

The city's `Silta` street parts provide real carriageway and pedestrian bridge
decks, previously ignored by the ground classifier. These source polygons retain
their measured terrain heights over the canal. Routing exceptions require an
explicit source way and decoded full-width support checks. Katajanokanlaituri
`24336451` has a supported 6.5 m lane envelope. Kanavakatu `24336449` retains its
visual and physical deck but remains excluded from AI routing: its nominal four
lanes occupy 13 m against an approximately 11.56 m registered deck. Do not shrink
the deck or relax support checks to hide that graph discrepancy.

The first complete decoded-world gate exposed coastal omissions and unsuitable
road heights. Exact closed OSM pier polygons, including Halkolaituri, are real
structural decks even where the coastline passes beneath them. Explicit city
`Silta` polygons and tightly bounded, adjacent bridge-end street parts likewise
retain their source footprints; no buffered road corridor becomes land.
The ferry boarding approach to Suomenlinna remains outside static vehicle
routing. Merihaankatu ways `1130701663` and `1130701665` are explicitly bound to
survey bridge parts `646585` and `646588` and excluded until deck elevations
are established. Their missing OSM bridge tags do not make the 2021 terrain
a valid road surface.

The ordinary-carriageway correction is an authored grade derived from the pinned
terrain, with source-bound pavement footprints and an unchanged accepted area
plus a protective margin. It is not a surveyed road-elevation claim. The
correction must close shared ground edges and preserve building bases; uncertain
bridges are excluded from this correction. The final
[21-check world gate](../../data/evidence/district-expansion-20261018/world-bank-v1-final/world.json)
passes on the selected final bank/paving/tram/closure cells and runtime roads-v8. Native travel
and graphics acceptance remain separate.

The imported source has several basement gaps even before grade correction.
Independent decoded visual/HCOL cross sections and transverse rays distinguish
an exposed wall face from a deeper perpendicular skirt that closes only its
corner. Eighteen reviewed intervals across five new-area buildings are bound
to the frozen cell index and original palette edges in `foundation-repairs.json`.
The ground repair may extend those vertical strips to 0.30 m below the final
adjacent dry surface, using the exact existing palette material and UV. It may
not change original facade arrays or textures, add horizontal paving, fabricate
an absent VTJ, or modify accepted-area buildings. An interval already closed by
the final grade receives no duplicate strip. Two further frozen source faces on
building `BID_94647ab5-6d84-4dea-8d2c-94f42505f3df` are conditional on the selected
grade. The [completed decoded closure proof](../../data/evidence/district-expansion-20261018/foundation-final-v3.json)
covers all 20 declarations and 626 samples, including 214 closure probes, with
zero failures. It is a bounded source-face proof, not a citywide runtime
appearance claim.

The negative water check distinguishes the explicitly declared Allas floating
sauna from spurious paving. A permitted roof hit must match its current source
register identity, visible decoded roof and preserved building collider, with a
separate ray proving that no hidden ground remains beneath it. This exception
does not permit terrain or generic ground under water.

Road registration must follow physical lane count. A two-way `lanes=1` street
has two graph directions sharing one physical corridor. Unlaned service roads
and living streets use a declared shared-corridor default; explicit lane counts
remain authoritative. Constant placement tags locate lane centres relative to
the OSM axis. Ambiguous or transitional placement retains its prior geometry
with an explicit diagnostic. Total `width` is not divided into travel lanes on
ordinary roads because it can include parking and cycle lanes. These distinctions
follow the OSM [lanes](https://wiki.openstreetmap.org/wiki/Key:lanes),
[placement](https://wiki.openstreetmap.org/wiki/Key:placement) and
[width](https://wiki.openstreetmap.org/wiki/Key:width) definitions.

Where an axis lies outside the city's actual carriageway, prefer a bounded,
source-declared lane and connector registration into that carriageway. Preserve
rock, walls, steps, building footprints, directions and turn restrictions. Exact
source footprints and measured vehicle clearance constrain each correction. A
narrow shared VÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¤likatu approach needs a declared 50 mm clearance margin rather
than the ordinary 100 mm margin; the actual 0.967 m tyre half-width stays strict.
The source road is never widened. Retained service roads receive the same new-area
vehicle support and continuity checks as public roads; absent private-access tags
do not justify excluding a fault. A wholly isolated component behind an unmodelled
building passage may instead receive an explicit, source-proven routing closure.

Small reviewed shared-surface or driveway crossings may join the same constrained
grade field as ordinary roads. Their exact retained vehicle corridors intersect
only declared source parts and avoid real stairs, walls, rock, bushes, buildings
and decks. They share the field's grid nodes and end heights. Local exact masks
protect nearby building bases from interpolation across long triangles; this does
not authorize a citywide change to unrelated ground protection.

New tree registrations must be checked against the final visible ground. The
earlier unpublished build is not an accepted baseline: it contains genuine metre
scale floating and buried trunks. Qualified new trees retain their X/Z, dimensions,
variant and collider policy, but their root Y follows continuous final soil with
the existing 0.30 m sink. Walls, buildings, steep discontinuities and partial wet
footprints require source-specific review. The 810 accepted placements stay exact.
Five shoreline centres have neither supported model ground nor proven dry soil
in the city's 2025 aerial reference. If still unsupported, omit only those bound
runtime instances and trunk colliders while retaining their raw source points.
Do not invent land or treat a broad meadow polygon as proof of dry shoreline.
Two source retaining-wall crossings and three decoded bark/wall-or-facade
intersections have separate conditional omission authorities. Each condition is
recomputed on the final mesh; a broad source-mask overlap alone is insufficient.
Reviewed continuous steep soil can receive an individual profile-bound sink
exception. Two partially wet shoreline trees may retain their supported bank
centres with submerged roots, provided the final dry-root profile is continuous,
at least half the actual bark rim remains on dry soil, all missing root samples
are source water and no visible obstacle intersects the trunk. These decisions
change instances and matching trunk colliders, never the shoreline or buildings.

Visual residency retains the existing 160/320 MiB texture limits and fixed
detail/coarse cell and buffer caps. Static physics remains resident in this
bounded milestone; its payload, startup and heap costs must be measured and
reported separately. The final gate includes source preservation, water with
no walkable support, bridge width, road continuity, both graphics presets,
repeated district returns, real traversal and the existing gameplay journey.

The northern Meritullinkatu OSM axis is a planted pedestrian throat: its north
node joins only footways, and municipal part `231914` is explicitly the northern
planting area. The bush and building leave less than the accepted car's 1.934 m
tyre width. The official 2025 orthophoto confirms planting and a narrow western
path. Routing stops at existing source node `8879808377`, before the first
southern motor driveway. Raw legal tags, pedestrian links, planting and southern
motor access are preserved. This is a project-car model-support boundary,
not a real-world legal closure. The
[source-axis proof](../../data/evidence/district-expansion-20261018/meritulli-source-axis-feasibility-v1.json)
and [reference retrieval](../../data/evidence/district-expansion-20261018/meritulli-source-reference-v1/retrieval.json)
record the basis; final actual tyre and body support are bound by the road handoff.

The source-fitted Ankkurikatu axis passes its full tyre profile without extra
grade. The only additional shared-surface grade is service `34918441:1`, clipped
to 42.1003 square metres of actual asphalt in part `58384`. Round end caps remain
inside the 1.117 m treatment half-width; the physical 0.967 m tyre half-width
passes source support, protection and decoded visual/HCOL/Rapier checks. The
fresh-source proof removes ten tyre steps without raw-deck, protected-source or
foundation-interior changes; all 45 nearby wall/skirt/prism probes pass.
The selected final world gate confirms the rebuilt result. Its authoring plan
continues to pin roads-v6 SHA-256
`f47fbc0ab5974fc41377ba47bf0ee363287baee550bb71222216a0e07b5b798d`;
later topology-only removals do not authorize rewriting those source/cache pins.

## Runtime topology and real-drive failure

The predecessor native journey reached Finlandia and returned to Lasipalatsi,
then failed around 401 seconds on the Stockmann leg at the actual retaining wall
near `[-870.73,0.88]`. Its zero-recovery limit correctly failed the run. The
[raw journey](../../data/evidence/district-expansion-20261018/drive-final-v1/journey.json)
is a failed predecessor result, not evidence that final travel passed.

The underground parking portal way `317360902` and tunnel `51707747` were
already excluded, but propagation had left four unnamed unclassified approaches:
`28584320`, `216650212`, `317360908` and `317360906`. The false endpoint generated
a 3.493 m U-turn, routing through the unsupported ramp toward source retaining
wall `304050566`. The bounded correction propagates the existing unsupported
portal cut only along an unbranched unnamed approach; named/ref roads, actual
multiway junctions, artwork and source turn restriction `57339` remain intact.
The [source diagnosis](../../data/evidence/district-expansion-20261018/road-layout-v7/source-lock.json)
binds the real wall, raw topology and exact removed chain.

Runtime roads-v8 additionally suppresses 30 reversing connectors at source-cut
endpoints that still have an omitted drivable continuation in the complete OSM
source. A cut cannot manufacture turnaround space. Genuine source driveway ends
remain under their existing policy. Against authoring v6, the combined correction
removes ten lanes, 45 connectors and four internal nodes; all retained values are
exact. All 511 parking spaces, 4,623 footways and the complete gameplay payload,
including eight car placements, are unchanged.

The runtime graph is `roads-v8/roads.json`, SHA-256
`25ec73e7bf1e063f89f35cdcca427c53be4ce830575c3624c3debcc9017f1c51`.
Its [source lock](../../data/evidence/district-expansion-20261018/road-layout-v8/source-lock.json)
and [handoff](../../data/evidence/district-expansion-20261018/road-layout-v8/handoff.json)
keep this distinct from the unchanged v6 ground-authoring graph.

Final drive goal index 9 is the supported Katajanokanlaituri city-bank lane
`[276.351,160.667]`, radius 3 m, after the westbound bridge `24336451` crossing.
The old Kanavakatu checkpoint required a fabricated U-turn at an excluded bridge
cut. All other goals and required ways remain exact. The final plan SHA-256 is
`ca06433d434d740eb1255b630d36b4a9a04106091f1a824f28f049819be21f75`.
Its eleven directed goals and planned return are
[source-reachable](../../data/evidence/district-expansion-20261018/road-layout-v8/route-plan.json);
the corrected full real-control journey later passed on a706b755. The final
bank candidate has the fresh eastern coverage recorded below.

## Final material and visual scope

Native review exposed photographed foliage in two previously protected lower
columns on Finlandia chart `1016-18`. Their protected tops change only from Y
2.2 m to 1.7 m at along-wall intervals `[1017,1019.6]` and `[1024.3,1027.1]`.
The exposed bands use the existing licensed same-building granite donor from
page 1013/chart `1013-0`. Hidden lower entrances are not invented; the central
upper bank remains exact. An
[exact support-envelope proof](../../data/evidence/district-expansion-20261018/finlandia-ground-margin-exact-v2.json)
places the repaired bottom at least 0.10011 m beneath final supported ground.

The separate-copy `cells-facades-v2` index SHA-256 is
`c1cb6c103b7a54b2327f8793186991ff86b561c137bb2c5716cb6c4be7ef9a5d`.
Exactly 904 native source texels and one embedded detailed atlas change.
Geometry/compressed payloads, all 36 decoded accessors, UVs, materials, other
images, collision, terrain, scenery and existing tiers remain exact. The
[repair lock](../../data/evidence/district-expansion-20261018/finlandia-material-repair-lock-v2.json)
and [recipe](../../data/evidence/district-expansion-20261018/finlandia-material-repair-recipe-v2.json)
bind source material, independent copies and preservation. Both final compressed
south views were opened at
[low pitch](../../data/evidence/district-expansion-20261018/finlandia-south-final-v1/finlandia-congress-south-yaw3.142-pitch0.06.png)
and [higher pitch](../../data/evidence/district-expansion-20261018/finlandia-south-final-v1/finlandia-congress-south-yaw3.142-pitch0.30.png);
the exposed green base strip is gone. These runtime-v3 captures validate that
bounded appearance fix; later runtime-v6 gameplay/performance results are
separately bound below.

Uspenski's pictured base has a separate
[bounded diagnosis](../../data/evidence/district-expansion-20261018/uspenski-visible-base-diagnosis-v1.json).
Nine pictured solid faces have coincident visual/HCOL intersections; 369 view
rays lose no prior support and all 231 vertical probes retain ground. Source
stair `48746` and immediate wall planes match the prior profile within 0.002 m.
Adjacent road/grass grades do change. None of the foundation declarations covers
Uspenski, and no whole-base identity or architectural fidelity is claimed.
No introduced hole was found in those sampled solid faces. That bounded review
did not cover the later fixture-007 lateral curb/base opening. The opening was
real and is closed by the source-bound dry-interface phase below; downward
support and the prior nine rays could not establish its lateral closure.

## Required vertical boundary closure

Opened native views exposed source-water bank cuts without vertical faces,
curb/wall bottoms separated from graded floors by up to about 0.15 m, and a
partial floor-edge join at the Music Centre with millimetre height differences.
Downward support checks can pass while these lateral openings reveal sky.
Qualification therefore uses actual boundary triangles and existing face
coverage, with source water/deck masks, accepted-area protection and exact
visual/HCOL correspondence. Ambiguous interfaces remain rejected.

All corrections append exactly vertical faces to existing ground primitives,
existing HCOL ground items and matching distant ground. Original BIN and decoded
attribute/index prefixes, collider item count/order, buildings and floor heights
remain unchanged. No horizontal paving or water-floor collider is introduced.
Uncovered polygon domains are the outer ring minus the union of holes. A
station-decomposed Float32 mesh preserves that domain and gives each triangle a
same-XZ vertical pair. An earlier earcut output with near-horizontal Float32
slivers was rejected.

The selected phases are:

- `cells-facades-v2` to `cells-closed-v2`: 4,616 source-coast quads and 45,580
  dry-interface polygons, producing 200,306 vertical triangles. All 88,215 dry
  source HCOL side/floor triangles have exact visual counterparts. The
  [actual-output rays](../../data/evidence/district-expansion-20261018/final-ground-closure-rays-v2.json)
  close the original twelve lateral controls.
- `cells-closed-v2` to `cells-closed-v3`: the
  [floor v3 plan](../../data/evidence/district-expansion-20261018/floor-interface-plan-v3.json),
  SHA-256 `f310b30bc57baf2494eb0fb0a8b8c933ece1677584870cbe9e0ff149e0e8321c`,
  qualifies 13,340 sections in 122 cells with 7,870 exact visual bindings.
  It emits 49,596 triangles; 526 sections collapse safely to zero. The
  [actual compressed proof](../../data/evidence/district-expansion-20261018/floor-interface-output-positive-v3.json)
  verifies prefixes and all 37 Music Centre sky rays against LOD0, LOD2 and HCOL.
- `cells-closed-v3` to `cells-closed-v4`: the
  [shore v4 plan](../../data/evidence/district-expansion-20261018/coastal-shore-plan-v4.json),
  SHA-256 `050694720a19faa70aa37812807500b8df55b8374fdfef9cc5eb67e64d404cfb`,
  clips residual source-bank edge endpoints at actual triangle boundaries.
  Its 39 quads in 11 cells add 142 triangles. The
  [actual-output proof](../../data/evidence/district-expansion-20261018/coastal-actual-output-closed-v4.json)
  closes all 228 recorded sky pixels plus the primary and legacy ray controls;
  the other 226 cells remain exact.

The closed-v4 index is
`579e5d5c748a479858a785d5dff539e085787b9eb53f876f2c5b3f4f8a86d319`.
After the later chart, paving, tram and bank phases, the
[final vertical audit](../../data/evidence/district-expansion-20261018/vertical-ground-bank-v1.json)
verifies all 250,136 appended triangles with exactly zero normal Y.
Real bridge/deck tops and open water beneath spans remain protected.

This is a mandatory pipeline phase after every fresh cell/grade build. Generate
new source-bound shore/dry plans, append their reviewed selection, generate and
apply floor joins, then recheck residual shores. Plans bind indices, reports,
payloads, helpers, dependencies and source inputs; they must not be repinned
simply to bypass drift. The [build recipe](../district-expansion-build.md)
records the generic commands and historical authority/source locks. Final
compressed-output and native-view checks remain separate from qualification.

## Original art on untextured source facades

Reference review established that the blank Presidential Palace east facade
and Main Guard south facade are exterior architectural faces, not party walls.
The approved third chart restores Parliament's eleven-arched lower front wing
on source faces `665/666` only. Original procedural CC0 artwork is based on
opened reference layouts; reference and Google image pixels are not shipped.
The Palace chart distinguishes its three-storey main wing from the low wing.
Guard ownership includes the main south plane, the centre recess and southeast
chamfer; unrelated source planes remain untouched.

The adapter targets 34 existing triangles: 14 Palace, 18 Guard and two
Parliament. Detailed/distant keys must map bijectively to those exact source
faces, rather than admitting all coplanar geometry. It preserves their source
coordinates and winding, all HCOL/terrain/scenery and every ground/water/closure
triangle. Existing atlases, untargeted UVs and palette mappings stay exact.
Target draw partitioning, isolated materials/UVs and corresponding distant
vertex colours are intentional; far small-window geometry is not claimed.

One original 768 by 256 atlas, SHA-256
`2a8c76c3a1c17ee5ca8d2c75b72671d4c0d47e47178733c9ca0a86fd2ca581a5`,
is used by three owner cells, with one extra draw per owner in LOD0/LOD2.
The full RGBA mip fallback totals exactly 3 MiB; estimated BC7 storage totals
786,576 bytes. These estimates do not replace actual native residency gates.
The [hash-only profile rebind](../../data/evidence/district-expansion-20261018/facade-chart-profile-rebind-v4.json)
binds closed-v4 without changing selectors, chart frames, art or reference
declarations. Its application-profile SHA-256 is
`31661a26a617269bb171669f485dd9cc4890b0411855777ec5e0bd7ab1b8f9ec`.

The chart base `cells-charts-v3` index SHA-256 is
`610300aa9966fc60ee412e9777ac6579fb7c742698992bfa74ab00c2f20b5fbb`.
Its [actual adapter proof](../../data/work/district-expansion-20261018/cells-charts-v3/facade-chart-proof.json)
records exact source ownership and preservation. All work uses fresh outputs;
staged hardlinked files and earlier selected artifacts remain immutable.

## Reference-guided stone paving and tram tracks

The subsequent owner request explicitly includes stone paving in Mannerheimintie,
Esplanadi and the accepted Senate district, with tram tracks in central
Mannerheimintie. This authorizes the selected appearance changes in accepted
cells; physical geometry and HCOL remain unchanged. Paving/tram postprocessing is
`cells-charts-v3` to `cells-streets-v1` to `cells-trams-v1`, followed by the
source-bound bridge-bank completion below.

The [surface profile](../../content/helsinki/district-expansion/streets-v1/surface-source-profile.json)
binds 383 municipal stone-paving parts in 14 regions. Opened Street View shows
grey rectangular granite setts at Mannerheimintie and small grey/reddish fan/arc
cube courses within Senate Square panels. References determine pattern and scope;
Google pixels are not shipped. Asphalt cycle paving, concrete/slab sidewalks,
stairs and planting are preserved. Extra named Senate streets qualify only
inside X/Z `[-100,-290,150,210]`, not along whole source polygons beyond that
boundary. Square fan ownership is exactly the 50 Noppakivi panels `58148`?`58197`;
outer concrete walkway `58145` is excluded. The
[source ledger](../../content/helsinki/district-expansion/streets-v1/source-ledger.json)
records the opened references and explicit boundaries.

Two original deterministic 256 by 256 CC0 albedos support ordinary rectangular
setts/cubes and the square's separate fan courses. UV bases maintain approximately
20 by 10 cm setts or 10 cm cubes and 10 cm fan radial courses across cell borders.
Ordinary cube/setts share one actual image/material per owner, despite different
UV scale. Only four Senate cells also own the fan tile. At most two paving draws
and 174,816 BC7 mip bytes are added per cell; no normal/displacement map is added.
The original [ordinary](../../data/evidence/district-expansion-20261018/street-surfaces-v4/original-paving-setts.png)
and [fan](../../data/evidence/district-expansion-20261018/street-surfaces-v4/original-paving-fan-cobble.png)
previews were opened and approved; final native/ordinary appearance evidence
is separately bound below.

The [selected authority](../../data/evidence/district-expansion-20261018/street-surfaces-plan-v4.json)
selects 26,176 existing floor triangles in 38 cells. Whole source-polygon and ROI
coverage is strict. Float32 boundary witnesses require an independently derived
half-ULP world-coordinate rounding bound and a convex actual-source-edge capsule
proof for every outside fragment, with only 10 nm clip allowance. Diagnostic
subdivision does not alter source triangles. Real source crossings, holes and
ambiguous ownership remain unpainted. The
[coverage receipt](../../data/evidence/district-expansion-20261018/street-surfaces-v3/coverage-summary.json)
accounts for every part, all 50 square panels and 543 retained faces. It reports
4,118.854551 square metres of qualified fan faces against 4,119.511158 square
metres of source footprint. One eligible face, part `58170`, detailed triangle
`459` in `c_m01_p00_ground_cobble`, area 0.534761 square metres, conservatively
retains existing cobble. The remaining 0.121846 square-metre source-footprint
difference is not claimed as eligible floor. No tolerance was raised to force
that face through the gate.

A failed application preflight exposed JSON metadata negative-zero serialization,
not a geometry mismatch. The bounded correction canonicalizes certificate JSON
numbers while preserving exact binary triangle keys; no failed candidate was
created. The [replay](../../data/evidence/district-expansion-20261018/street-surfaces-v4/actual-signed-zero-replay.json)
and [authority equivalence](../../data/evidence/district-expansion-20261018/street-surfaces-v4/authority-equivalence.json)
bind unchanged coverage, artwork and targets. The
[actual paving proof](../../data/work/district-expansion-20261018/cells-streets-v1/ground-resurfacing-proof.json)
verifies source coordinates/winding, old payload prefixes, all physical and
building data, and accepted LOD1/distant consistency. Selected UV/material
partition and textureless distant colour changes are intentional. Its cell index
is `5508b1714df10e604b686ef73369e1ae585544bc61fefef5d70ef6d344f10de8`.

The [tram profile](../../content/helsinki/district-expansion/streets-v1/tram-source-profile.json)
selects 92 actual OSM tram ways, 4,271.545657 m of mapped axes and two mainlines
in 18 cells. Measuring faces are 1,000 mm apart. Tracks follow actual floor
triangles and source axes, not invented road-centreline parallels. Original
44 by 4 CC0 rail art distinguishes head, groove and guard. Widths and a 3 mm
visual lift are rendering approximations, not an as-built steel survey; there
are no sleepers, ballast, physical rail bumps or new colliders.

The [final tram authority](../../data/evidence/district-expansion-20261018/street-surfaces-v1/tram-final-plan-v1.json)
binds resurfaced and reference ground with the same coordinate/winding multiset.
It adds 22,451 detailed and 21,497 coarse triangles, one detailed draw per owner
and zero additional coarse batches. Each detailed stripe's full RGBA mips cost
956 bytes. Earlier lower prospective authoring caps blocked the measured result;
25,000/25,000 are the approved producer caps. Native 500,000-triangle, 350-draw
and 160 MiB low-preset limits remain unchanged. The explicit 0.001409
square-metre raw fringe is covered only by individual Float32/Boolean proofs,
without enlarging source ground. The
[actual compressed-output proof](../../data/evidence/district-expansion-20261018/street-surfaces-v1/tram-actual-output-v2.json)
checks all 36 modified detailed/distant payload suffixes, exact original BIN/
accessor/image/material prefixes, every HCOL/terrain/scenery byte and 219
unaffected cells. The pre-bank `cells-trams-v1` index is
`0c800253d6a2edf8a29e72d03f025bbf7ed08a75b610ad89ff910cb0956e2c90`.

All stages use new outputs and freshly bound authorities. Reusable producer
commands and selected authority hashes are in the [build recipe](../district-expansion-build.md).
The earlier 717a9536 native attempt was superseded by this explicit surface
request and remains incomplete diagnostic evidence.

## Final source-bound bridge-bank completion

The a706b755 predecessor completed all eight native jobs. Subsequent closer
Kanavakatu east-abutment review still found a real lateral sky opening: nine
exact camera rays and 1,005 sky pixels missed old LOD0, LOD2 and HCOL. Downward
support checks could pass beside that opening. The
[actual-camera diagnosis](../../data/evidence/district-expansion-20261018/abutment-exact-rays-v1.json)
therefore remains a real defect, rather than an appearance explanation.

The selected [bank authority](../../data/evidence/district-expansion-20261018/bridge-abutments-plan-v2.json),
SHA-256 `f4e3f6eca41d6cd38a28d00b0433ce83312329279ff78450e5c2729b7bbc7431`,
uses exact source bridge endpoints, `Silta` footprints and adjacent canonical
shore/dry components. It follows actual decoded bank tops down to water Y -7.5 m,
subtracting existing face coverage and preserving open spans. Six source
intervals totaling 13.876106 m emit 23 quads/92 triangles in three cells.
Existing ground primitives, matching distant geometry and HCOL ground items
receive vertical suffixes. Original floors, typed-array/BIN prefixes, collider
item counts/order/handles, textures and materials remain unchanged. HCOL bytes
intentionally change; this is a visual and physical correction.

The [actual compressed output](../../data/evidence/district-expansion-20261018/bridge-abutments-actual-output-v2.json),
SHA-256 `0907105813a6ac08f780c4e160e9cf799ab8d776d84a49004187aeda18840263`,
verifies all 237 collider-ID lists, nine changed payloads and every one of the
1,005 old sky-pixel rays hitting front-facing actual LOD0/LOD2/HCOL faces.
The final `cells-abutments-v1` index is
`f3d37e78be20236d6ab970e8d08052ac90fd0f2e3e1491799cfd320f64a8198b`.
Root opened [28 component views](../../data/evidence/district-expansion-20261018/opened-bank-images-v1.json):
seven natural images per preset and seven forced LOD2 images per preset, with
the targeted opening absent. Capture receipts retain `CAPTURED_NOT_REVIEWED`;
opened verdicts are separately bound. Forced LOD2 views are component appearance
evidence, not streaming/performance proof. Root also opened
[18 actual native images](../../data/evidence/district-expansion-20261018/opened-bank-native-v1.json),
nine selected eastern-walk images plus all nine eastern-drive images.

The [cross-release prior-input comparison](../../data/evidence/district-expansion-20261018/bank-replay-v1/comparison.json)
is a strict **FAIL**, preserved without tolerance changes. It replays the original
50,062 drive commands against both worlds: old final hash `f8e65e75`, new
`6b61aca5`. All compared public numeric state/body/event fields match through
tick 35,937; car-1 velocities first differ at 35,938, by about 2.116e-6 m/s.
The first differing tick still has the same native rounded hash. No later control
trace or complete new-release trajectory is certified.

Read-only in-memory probes found no chassis/skid manifold. State, inputs and
force/torque match before `controller.updateVehicle`; velocities differ just
after that call, before physics stepping. Reported wheel/ray results match and
the nearest added face is 58.4315 m away, ruling out direct new-bank contact.
The fixed cell body's automatically computed mass properties change (mass
37,420.2734 to 37,364.6328, plus raw inverse mass and centre of mass). They are a
candidate mediator inside vehicle processing, not proof of private controller
causality or BVH ordering. Global density/mass settings are not changed merely
to recover the old hash. Public-state equality does not assert equality of every
private cache or whole static physics snapshot.

The immutable [scoped acceptance plan](../../data/evidence/district-expansion-20261018/scoped-acceptance-bank-v1.json),
SHA-256 `ef7f342d5125654060095c7ce6d23c367c0025bf8b6c4c33718f0ff990686767`,
records the strict failure, exact artifact bindings and transcript-only probe
limits. Its status is `PLANNED_AFFECTED_ACCEPTANCE`, not PASS or activation
authorization. Original western native reachability remains historical under
a706. Unchanged western geometry and the compared driving-state prefix support
selecting fresh eastern checks. There is no claim of a new full western walk or
eleven-goal city drive, and no post-35,938 equivalence claim. Police can roam the
whole graph, so player distance alone is not used to prove all queries unaffected.

## Acceptance boundary

The selected bank candidate passes
[all 21 final world checks](../../data/evidence/district-expansion-20261018/world-bank-v1-final/world.json)
and 483 GLB validations with zero errors. The final
[physical proof](../../data/evidence/district-expansion-20261018/road-physical-bank-v1/result.json)
records 512 BODY/SKID queries without intersections and 2,412 tyre probes without
missing support. The
[stage receipt](../../data/evidence/district-expansion-20261018/stage-bank-v1.json)
binds 7fc03703, 724 payloads, 1,240,551,957 bytes and unchanged pointers. The
[vertical audit](../../data/evidence/district-expansion-20261018/vertical-ground-bank-v1.json)
verifies all 250,136 appended closure triangles with exactly zero normal Y.
These content checks do not establish final native runtime acceptance.

The selected [runtime-v6 inventory](../../data/evidence/district-expansion-20261018/runtime-source-v6.json)
has fingerprint
`593e49cdd532be3f35343e37ed1d2759def8b3619eb9cc9a0fbe71cbfba589cd`.
Its [five TypeScript projects and 365 tests pass](../../data/evidence/district-expansion-20261018/frozen-checks-v6.json),
with zero skips. The [review and production builds](../../data/evidence/district-expansion-20261018/runtime-build-v6.json)
and their [revalidation](../../data/evidence/district-expansion-20261018/runtime-build-v6-revalidation.json)
are separately bound. Review JavaScript SHA-256 is
`8ee16a7706240a82a766f85051a148cb5d46a3464d5011f598d2da346a9d33ce`.
The [namespaced review entry](../../data/evidence/district-expansion-20261018/stage-runtime-v6-namespaced.json)
preserves the ordinary entry and accepted pointers.

Runtime-v6 retains coarse-cell batching, verifier bend preview and the optional
per-car pose path. Relative to v5 it preserves two audited renderer edits plus
their required static Kaamos/Revontuli pose-JSON imports. Existing Lumi/patrol
defaults and eight shipped assets remain exact; new vehicle GLBs/contracts and
parallel central-expansion gameplay remain outside this city release. The
[compatibility audit](../../data/evidence/district-expansion-20261018/runtime-v6-vehicle-compatibility-audit-v1.json)
records that boundary. Historical runtime-v3/v4/v5 checks cannot certify v6.

The final bank producers have an independent
[source lock](../../data/evidence/district-expansion-20261018/bank-producer-lock-v1.json)
for snapshot `bank-producer-v1`, inventory fingerprint
`88b92161bfbc4cf8f9e7c1674ff83a26095926b3052d23d59aacbe16a5a2d1f5`:
225 files, [104 passing producer tests and two TypeScript checks](../../data/evidence/district-expansion-20261018/bank-producer-final-checks-v1.json).
Its parent street archive has 222 files/96 passing tests and remains a historical
source lock. Runtime-v6's bindings remain unchanged.

The complete [a706 native suite](../../data/evidence/district-expansion-20261018/gpu-suite-closure-v5.json)
passed eight jobs; its full western/eastern walking, eleven-goal driving and
gameplay recordings retain a706 identity. The new
[seven affected native jobs](../../data/evidence/district-expansion-20261018/gpu-suite-bank-v1.json)
all pass on 7fc03703/runtime-v6, completed at 2026-10-18T20:17:43.322Z:

- Eastern walk: 212 checks, all 188 unchanged source waypoints and 1,893.877239 m,
  followed by the repeated low fixtures.
- Both browser/resource presets and all standard fixtures pass.
- Six-goal eastern drive: zero recoveries, 23,198 commands, own browser/Node
  replay hash `425b872c` and no divergence.
- Both gameplay endings and their own replays pass; streaming failures pass 10/10.

The [final scoped disposition](../../data/evidence/district-expansion-20261018/scoped-acceptance-bank-v2.json),
SHA-256 `8a47610fbdf2f758e75669307163deaf870c4574d8abfee5bec977482baf889c`,
is `PASS_AFFECTED_ACCEPTANCE`. It preserves planned v1 and the strict old-input
replay FAIL. The [new drive replay](../../data/evidence/district-expansion-20261018/east-drive-bank-v1/replay.json)
belongs to this new candidate; it does not relabel the failed cross-release
comparison. The [route-plan receipt](../../data/work/district-expansion-20261018/bank-affected-plans-v1.json)
records retained eastern source paths and the explicit western omission. No new
complete western continuous journey or eleven-goal city drive is claimed.

Local activation, owned preview restart and HTTP identity pass. The
[activation receipt](../../data/evidence/district-expansion-20261018/activation-bank-v1.json),
SHA-256 `ef84742acbc84c8dbc5c980a544386892e01f906a418ba07f262bdbead7561b0`,
binds both pointers to 7fc03703, ordinary index
`a14ba681c0ec30ee18d61154820fb5495ebf8f2770cdd279be1a729420139d59`
and `/district-ordinary-v7-assets/index-RJvTkfS8.js`, production hash
`d05d80c892ff4e92e10e9265ae84256ce42e213c3148d46db619521509358db5`.
The review `8ee16a77...` runtime remains separately identified; it is not substituted
for ordinary production proof. Rollback index/pointers remain preserved.

Restart v1 failed in `Stop-Process` without changing either server. The
[failure receipt](../../data/evidence/district-expansion-20261018/preview-restart-cmdlet-failure-v1.json)
records the preserved exact commands, creation times and listeners. The
[guarded v2 helper](../../data/work/district-expansion-20261018/restart-game-preview-bank-v2.ps1)
retains all guards and substitutes native single-PID `taskkill`, with no tree or
other-process target. The [successful restart](../../data/evidence/district-expansion-20261018/preview-restart-bank-v1.json)
binds helper SHA-256
`9b5146129f7dfc7a7471251c172e67f74a0a7e82c859f25713ad71a867f756e6`
and new game PID 37360/5317, created 2026-10-18 at 23:22:08.731749 Helsinki time.
Motion Lab PID 2344/5173 remains unchanged. The
[HTTP receipt](../../data/evidence/district-expansion-20261018/http-bank-v1.json)
verifies actual served index/current/manifest/ordinary-module hashes after restart.
The separate [ordinary browser smoke](../../data/evidence/district-expansion-20261018/ordinary-bank-v1/results.json)
passes all eight checks against actual production `d05d80c8...`/manifest `95478256...`.
It observes default 7fc03703, no review adapter on default or `?review=1`,
16 detailed cells loaded at startup out of 237 and 51 distinct details across
three UI drop-ins, visible HUD/credits and zero errors. It establishes startup/
on-demand UI behavior, not an additional full journey or performance benchmark.

Root opened all four ordinary PNGs. The [final integration receipt](../../data/evidence/district-expansion-20261018/integration-bank-v1.json),
SHA-256 `39db16e4887d56431a0b2646f55881512019bd8a49f0a721d01c8fcc798f964f`,
is `PASS_LOCAL_ACTIVE_ORDINARY`; it binds actual activation, successful v2
restart, HTTP, scoped acceptance, native opened images and ordinary results
(SHA-256 `53a7900146931d692a442c3ae1173c1d47f0eecaae1c90bc649aaaed682f4d89`).
There are 50 opened final views in total: 28 bank component, 18 native and four
ordinary images. Forced coarse views remain component appearance evidence only.

The 160/320 MiB texture limits and existing draw/geometry budgets remain unchanged.
Settled low views have a 500,000-triangle gate; historical moving samples peaked
at 507,309 walking and 540,663 driving triangles. Their settled-view PASS is not
a blanket under-500,000 travel claim. Labelled fixtures and CPU/replay proofs do
not replace fresh affected native keyboard travel. Actual startup/heap cost and
ordinary production startup/UI/image checks remain separately reported. Both pointers
select 7fc03703 and final local ordinary integration passes. This is a local
preview result, with no external-hosting, mobile or new full-western journey
claim.
