# Northern Helsinki extension

Status: LIVE LOCAL INTEGRATION, WITH DOCUMENTED APPEARANCE LIMITS.
Both local world pointers select `senate-20261019-08b1f804`, assembled from
`cells-road-fixed-v1` with 304 cells. Bank, vertical closures, tree seating,
the partial Runeberginkatu 55a facade and Meripaviljonki's source-mesh collider
and the bounded Välskärinkatu road repair are applied. All 22 static checks,
seven exact-world native groups and eight ordinary UI checks pass. Sixteen
selected native captures and all four ordinary captures have been opened.
The [benchmark](benchmarks/city-north-2026-10-19.md) records exact identities,
budgets and measurements; [final integration](../data/evidence/city-north-20261019/integration-final-v1.json)
binds the matching pointers and served HTML, runtime and manifest. The existing
server stays on port 5317, with its ordinary HTML/runtime unchanged and no restart.

The earlier `fc67e53d` / final-native-v3 run completed the 469-point walking return and both graphics
preset checks, then failed the zero-recovery drive on Välskärinkatu. Its own
19,745-tick replay reproduces the same failure. A single source road-grid node
creates an approximately 75 cm depression; the centered car loses tyre support
and then strikes the existing curb. The one-node correction and source-aligned
road graph now pass controlled physical checks in both directions with both car
definitions. The new exact candidate's full native-v4 suite starts with driving
and passes all seven groups. Its eight-goal browser drive returns to Senate
Square without recovery, with a matching 39,260-tick replay. The earlier failed
candidate and its reports remain separate historical evidence.

The northern boundary moves from Z −950 to −1152 metres, retaining
X −1792..800 and the southern boundary at Z 450. The addition is 523,584 m²;
the resulting rectangle covers 4.152384 km². It adds northern Mannerheimintie,
the western edge of Töölöntori, Sandelsinkatu, Välskärinkatu and northern
Runeberginkatu. Hakaniementori provides eastern context and an isolated
drop-in. Connected travel across Pitkäsilta or Hakaniemensilta is not claimed.

The municipal textured LoD2 and terrain vintages are unchanged. Acquisition
adds 45 LoD2 tiles, 142 terrain tiles and 173 tree tiles using 46,107,096 new
network bytes. It appends 119 converted buildings while preserving the 1,576
accepted buildings, source binary prefix and 2,586 original texture pages.
All 3,632,793 accepted authored height samples remain bitwise identical.
The monument, facade repairs, character and eight asset files are retained;
the 2017 mesh remains absent.

The source road and pedestrian graphs extend northward. A source-bound
walking plan has 469 waypoints, including a continuous Senate approach and
return. Actual browser walking completes all 469 waypoints over 5,637.4 metres
without recovery in one document. The directed eight-goal browser drive follows
6,072.0 metres of planned roads, visiting the new streets and returning to Senate
Square with zero recoveries. CPU planning and collision preflight are retained
separately from this final actual-control evidence.

Municipal paving classifications remain local: northern Mannerheimintie is
predominantly asphalt, with separately mapped stone islands, while the
Töölöntori square uses granite setts. Four original OSM tram ways contribute
415.770877 metres of track axes within the new strip. Rails are visual detail
on the actual native ground, using the confirmed one-metre gauge. Their
cross section is an approximation; overhead wires and physical rail bumps
are not added.

The integration includes bounded source corrections. An open hotel forecourt at
Mannerheimintie 50/46 contains a spurious terrain mound on OSM service way
1352652165. A bounded ground adjustment follows that actual 14.395 m access,
preserves the public crossing and buildings, and passes dense support and
controlled physical vehicle checks. Its assumed three-metre pavement width
is an authoring approximation supported by the opened municipal aerial
reference. The car's projected body corner can overhang that assumed strip
by 0.153 m during the tested reverse turn; all tyre witnesses stay inside,
the sampled two-dimensional building-footprint clearance is at least 0.820 m,
and there are no body/skid contacts. The three-second handbrake hold permits
up to 0.305 m of rollback; these CPU fixtures establish neither a parking
lock nor browser driving acceptance.

On Välskärinkatu, the imported source-grade node at X −1736 / N 1008 is
0.785784721 m below the interpolation of its two opposite four-metre neighbours
in the same municipal asphalt carriageway, part 52449. Replacing that single
coefficient uses its original triangular basis, restricted to
X [−1740,−1732] / Z [−1012,−1004]. The actual road, curb and adjoining sidewalk
receive the same displacement, retaining the curb's relative 12 cm rise and
footprint, original finishes and UV mapping. Raw terrain bytes, buildings,
scenery, exterior ground and the runtime safety field remain unchanged.
Independent decoded detail/distant checks include vertical seals and 4,225
support probes; visual/collision difference and boundary displacement are zero.
Measured inverse-source UV residual is below 9e−16, and only explicitly recorded
triangles with exactly zero Float32 3D area are discarded.

The derived physical lane graph also registers four Välskärinkatu lanes and
their two seam connectors against municipal carriageways 52449 and 52206.
Maximum horizontal shift is 0.6751 m. A 20 m approach transition is zero at
Z ≥ −925 and fully registered by −945; the Sandelsinkatu junction endpoints,
all IDs, topology, turn metadata and every unrelated graph item stay exact.
Inserted graph heights follow actual repaired native asphalt. The original
three-metre lane-width metadata remains an approximation, not a new survey or
traffic rule. All 510 continuous body/tyre sweep and rotation checks fit the
actual carriageway union. Four controlled CPU fixtures retain four-wheel
contact at about 10 m/s, with no body/skid contact or static intersections and
all 25,524 tyre samples inside the source carriageway. These checks are separate
from the completed connected browser journey. The
[repair evidence](../data/evidence/city-north-20261019/road-final-repair-v1.json)
and [source handoff](../data/work/city-north-20261019/verification/valskari-source-HANDOFF.md)
bind the actual outputs and retain failed controls.

The offline ground patcher's provenance clone now retains nested untouched
sidecars with hash verification and conflict/link refusal; six focused tests
and the world typecheck pass. The selected artifact uses frozen producer v9
plus the separately recorded restoration of seven exact sidecars. Its full
descendant audit verifies those files and all unrelated geometry/resources.

At Töölönlahti, the original OSM coastline cuts through a bank shown as land
in municipal terrestrial part 527816 and the opened 2025 aerial reference.
The complete naturally terminating conflict is 5,347.711008 m², including
3,432.060328 m² in the old rectangle. Its exact footprint is restored, with
explicit municipal water parts 527803/527804 retained. This avoids an
artificial shoreline at the old boundary and retains the eight newly
registered trees whose actual roots belong on that bank. The applied repair is
additive: existing dry ground, buildings, scenery and authored height data
are protected. Native floor and true shoreline faces are added only within
the qualified component; only the corresponding detailed and coarse water
faces are clipped. The source mask, report context and conservative runtime
fallback use the same correction. Its 4,357 raised fallback samples are
restricted to formerly false water with actual visible and collision-floor
coverage; the earlier qualified north-frontier lowerings remain intact.
The [application evidence](../data/evidence/city-north-20261019/coastal-bank-v2.json)
and [independent preservation check](../data/work/city-north-20261019/verification/preservation-bank-v2-v3.json)
record that bounded exception separately from unchanged source terrain.

After the bank repair, 10,929 source-qualified vertical seals were applied
across 36 cells, adding 42,708 triangles. The
[decoded collision check](../data/evidence/city-north-20261019/vertical-closure-v1.json)
finds exactly vertical faces, no added horizontal floor area and unchanged
original collider-array prefixes. The old protected interior remains outside
the general closure authority; the bank's actual shore is covered by its
separate exact source registration.

Tree registration now retains 1,043 of the 1,047 new source instances:
94 receive qualified vertical corrections and 949 keep their source placement.
Four individually reviewed new instances are omitted because the selected
model conflicts with an actual ground barrier, a registered building, the
play-area edge, or explicit municipal water. The water case concerns model
and source compatibility; it does not assert that the real tree is absent.
Raw municipal records remain unchanged. All 5,629 accepted scenery instances
are protected, and only the corresponding new trunk colliders move or are
omitted. The
[independent applied-tree delta](../data/work/city-north-20261019/verification/tree-soil-applied-v1-delta-v1.json)
checks those changes against `cells-closed-v1`, including unchanged ground
and unrelated collider arrays.

The Runeberginkatu 55a repair targets only the Tykistönkatu-facing quad of
VTJ `103219240W`. It reconstructs four obscured residential rows from the
intact fifth row on the same licensed municipal source face, with separate
donors for the wider western window return. The cornice, clean window cores,
chart junctions and unique commercial frontage remain protected. An opened
Helsinki City Museum photograph by Sari Schulman (CC BY 4.0) supplies visual
reference; museum pixels are not shipped, and no Google Street View
inspection is claimed. The
[source and pixel qualification](../data/work/city-north-20261019/service-ground/newfacade-diagnosis/newrepair/panel-qualification-v2.json)
covers the source repair. The actual application changes one embedded atlas
image in the new owner cell, with all geometry, UVs, collision and neighboring
images preserved. Three compressed front/ground/oblique captures at the
pre-road-repair candidate have been opened: exposed residential rows show the repair, while real tree crowns
occlude part of the cornice and western return.

This is a partial residential repair. Baked foliage remains in the protected
ground-floor shopfront, especially the unresolved left opening; its actual
appearance is not sufficiently established to reconstruct it. The original
right opening and canopy also remain. Do not describe this facade as fully
cleaned. The existing Malminkatu 3/5 source-photo foliage limitation remains
documented in the [previous continuation](city-continuation-2026-10-19.md).
Other new municipal photographic elevations, including neighboring
Sandelsinkatu facades, also retain foliage. This extension does not claim that
every building facade has been reconstructed.

The northern Runeberginkatu view exposes the finite ground edge at Z −1152
below facades beyond the supported rectangle. Eight checked background rays,
924 supported foreground floor probes and residency records identify boundary
exposure. The [coordinate check](../data/work/city-north-20261019/verification/runeberg-boundary-view-final-v1.json)
retains its reconstructed-camera limitation and uncertainty controls; the exact
presentation matrix was not captured. The visible northern edge remains an
appearance limitation of this bounded map slice.

The exact new Meripaviljonki floating restaurant, VTJ `103171023H`, exposed a
flat prism roof 0.658–1.613 m above its visible source roof at five water probes.
Its collider now uses all 569 original source triangles, independently matched
to the unchanged decoded native model. The old item identity, surface-tag table
and every unrelated collider remain intact; only this new building's collider
kind changes from `prism` to `citymodel`. The operator's own floating-restaurant
description and current municipal register establish identity. An opened
operator photograph is an interior view, despite its historical local filename;
it is not used to invent an exterior roof. A separately registered accepted
Allas sauna receives an exact water-structure declaration with no payload change.

The final static audit recomputes both original source and native roof heights,
retaining the original 35 mm alignment tolerance and strict absence of ground
or fallback floors over water. Two old exact-heightfield-vertex ray differences
receive a separate complete-world proof: source/runtime/native height bits and
local floor triangles are unchanged, off-grid queries agree, and centered
physical contacts match within the unchanged 200 micrometre bound. All raw
failures and failed diagnostic attempts remain; no coordinate exclusion or
broader ground/water tolerance was introduced.

Visual meshes continue to stream with player movement using the existing
runtime and unchanged residency budgets. Static collision and terrain are
still resident; this extension does not implement collision streaming.
The only local game server remains port 5317.

Build inputs, source ledgers and diagnostics are under
`content/helsinki/city-north-20261019`, `data/raw/city-north-20261019`,
`data/work/city-north-20261019` and `data/evidence/city-north-20261019`.
Earlier phases retain their own immutable producer identities. The following
acceptance record selects the final release and its actual native-v4 results.
Intermediate checks and failed predecessor reports remain available separately.

| Final acceptance item | Completed state / evidence |
| --- | --- |
| Final cells, release ID and manifest | `cells-road-fixed-v1`; `senate-20261019-08b1f804`; manifest `6f1e5b68f16fb8b34ad8ad1f02f2a03e05fb36fcfac5510c4f5fe3fd22e2858b`; 617 packaged GLBs validate. |
| Preservation, source terrain, tree output, support and static world | Independent final descendant and bounded road repair PASS; [all 22 static checks PASS](../data/evidence/city-north-20261019/static-world-v4/world.json). |
| Native LOW/STANDARD residency and performance | Both preset browser gates pass 9/9 checks. Each preset has 64 settled views within unchanged budgets; maximum LOW 444,647 triangles / 186 calls, standard 1,017,827 / 201. Desktop Chrome/Vulkan at 1280 × 720 only. [Measured benchmark](benchmarks/city-north-2026-10-19.md). |
| Continuous walk, drive, gameplay and replay | 469/469 walking checkpoints over 5,637.4 m; eight driving goals over 6,072.0 m planned roads with zero recoveries. Drive replay: 39,260 ticks, hash `4ffb2366`, zero divergence. Wasted/busted runs and both replays pass; request-failure checks 10/10. [Seven-group suite](../data/evidence/city-north-20261019/final-native-v4/suite.json). |
| Opened facade, forecourt, bank and return views | 13 historical predecessor facade/forecourt/bank captures are retained with unchanged source assets. [16 selected final native views](../data/evidence/city-north-20261019/opened-final-views-v2.json), including all four road-repair crossing views, have been opened and hashed. Shopfront foliage, coarse terrain and the visible northern edge remain explicit limitations. |
| Activation and ordinary production UI | Both pointers select `08b1f804`; [rollback receipt](../data/evidence/city-north-20261019/activation-v1.json) retained. Ordinary page passes 8/8 checks with all four captures opened; detail cells load 16/304 at startup and 54 after three UI drop-ins. [Final integration](../data/evidence/city-north-20261019/integration-final-v1.json) verifies served identities; no server restart or runtime edit. |
