# Source register

Finn vehicle entry/seating is a project-authored adaptation of the already credited
Snow-derived Finn rig, generated locally with Blender math/IK by
`tools/blender/build_finn_vehicle_poses.py`. No new motion library, checkpoint or
external asset is introduced. The separate `finn-vehicle-poses.json` records the
pinned source and actual packaged character/car hashes; world GLBs remain intact.
Rig inspection and skinned cabin-fit evidence: `data/evidence/car-entry-20261017/`.

The Rain officer replacement uses the owner's already uniformed, animated
`Snow_v4.2/motion/out/rain.glb`, pinned as
`c2aec924a23100aeae0d1ea9d006af5aea3dd6b37c76359a3bf262b679fe1e58`.
The identical game copy, manifest, source runtime and authoring reports are
recorded in `data/raw/rain-native-20261017/ledger.json`. Rain remains credited to
Blender Studio, CC BY 4.0; the supplied report identifies `rain_police_v3.blend`.
All eleven supplied native gait tracks are retained, with six new gameplay
actions and pistol/head sockets. Adaptations are KTX2 texture encoding and a
source-bound correction of 3,756 underarm RGB texels (0.02239% of one atlas).
Source geometry, UVs, skin weights, inverse binds and original clip buffers are
byte-exact. No external model inference or asset service was used in this task.

Every dataset and asset that reaches the released world, with its licence, the snapshot that was used and where the
hash lives. The release manifest (`apps/game/public/world/<release>/manifest.json`, `sources[]`) is generated from
`content/helsinki/sources.json` and the ledgers below by `tools/world/publish_release.ts`; this page is the
human-readable index. Rule 18.3 of the plan applies: the public game never requests `kartta.hel.fi`, never uses Google
3D Tiles or CesiumJS, and georeferenced data is never fitted or nudged.

| Source | Used for | Licence | Snapshot and hash | Ledger |
| --- | --- | --- | --- | --- |
| City of Helsinki 3D city information model, textured LoD2 buildings (3D Tiles) | Every building in the pilot cells except the Cathedral's visual (decisions 0004 and 0005): facades and roofs colour-graded (decisions 0003 and 0005), flat colours from the textured walls and roofs for the surfaces without a texture; the Cathedral model's wall and roof colours; `citymodel` colliders for the 3 unmatched buildings | CC BY 4.0 | `senate-district`, 19 tiles, tileset version 303357262605, retrieved 2026-10-16T07:17:51Z, sha256 `4928e128…` | `data/raw/helsinki-lod2/ledger.json` |
| City of Helsinki terrain model 2021 (quantized-mesh, layer `2021_terrain` "Maastomalli") | Terrain heightfield (sampled linearly on the 1 m grid, heights as delivered) and the origin height (decision 0005). Mirrored for offline tooling only; the game never requests it | CC BY 4.0 | `senate-district`, zoom 18, 80 tiles, layer version 1.1708423032937557, retrieved 2026-10-16T17:05:25Z, sha256 `84d6c06e…` | `data/raw/helsinki-terrain/ledger.json` |
| City of Helsinki building footprints with register attributes (WFS `Rakennukset_alue_rekisteritiedot`) | Footprint matching (60 matched, 0 ambiguous, 3 unmatched, median offset 0.3 cm), prism colliders, the Cathedral model's placement, addresses for the drop-in list | CC BY 4.0 | `senate-district`, 61 features, retrieved 2026-10-15T22:16:54Z, sha256 `88294a41…` | `data/raw/helsinki-building-register/ledger.json` |
| City of Helsinki building footprints (WFS `Rakennukset_alue`) | Reference only (97 features); not in the release | CC BY 4.0 | `senate-square-pilot`, retrieved 2026-10-15T21:53:28Z, sha256 `a740eaf0…` | `data/raw/helsinki-buildings/ledger.json` |
| City of Helsinki public area register, street and green parts (WFS `YLRE_Katu_ja_viherosat_kaikki_alue`) | Ground surfaces (road / raised, finish per part), kerbs, parking slots | CC BY 4.0 | `senate-district`, 482 features, retrieved 2026-10-15T22:16:54Z, sha256 `55bc8969…` | `data/raw/helsinki-street-parts/ledger.json` |
| OpenStreetMap | Road graph (lanes, connectors, turn restrictions, footways for the minimap); flights of steps (width, step count), entrance terraces next to steps ways, retaining walls (decision 0005) | ODbL 1.0 | `senate-district`, bbox 24.9497–24.9557 E / 60.1673–60.1725 N, retrieved 2026-10-16T05:50:36Z, newest element edit 2026-10-15T23:46:18Z, sha256 `4d1e50a8…` | `data/raw/osm/ledger.json` |
| Owner's **Finn12**, derived from Blender Studio **Snow** (v4.2) | Player with supplied 71-joint native rig and eleven movement clips; six added gameplay actions | Snow CC BY 4.0; supplied Kimodo motion provenance below | Portable source `finn.glb`, sha256 `2d4516c7…`; source scene and inputs fingerprinted | `data/raw/finn12-20261017/ledger.json` |
| Owner-supplied native **Rain**, derived from Blender Studio Rain | Poliisi officer, 70-joint native rig and eleven supplied movement clips | Rain CC BY 4.0; supplied motion provenance retained | `motion/out/rain.glb`, sha256 `c2aec924…` | `data/raw/rain-native-20261017/ledger.json` |
| Quaternius Universal Animation Library, free Standard edition | Historical reduced Rain and Snow locomotion; superseded by the supplied native exports | CC0-1.0 | Official itch.io Standard archive retrieved 2026-10-17; archive sha256 `cc73fc4e…`, in-place GLB `69591853…`, root-motion GLB `be684571…`; license saved beside them | `data/raw/quaternius-animation/ual1-standard-20261017/ledger.json` |
| [Rigged Mustang GT500](https://sketchfab.com/3d-models/ford-mustang-gt-500-with-pro-rig-for-free-f26a29f766844f46910547d6d2cc291d) by NoOb StUfFs, supplied by the owner | Fictional "Lumi GT" sports car and patrol variant; badges, lettering, plates and source textures removed; game geometry, wheels, materials and nodes adapted | CC BY 4.0; independently verified through Sketchfab's public API on 2026-10-20 | `models/ford-mustang-gt-500-with-pro-rig-for-free/source/ford mustang fully rigged.blend`, sha256 `d0494048…` in `data/work/m0/blender-car/blender-report.json` | `content/releases/asset-credits.json` |
| [Rigged Veyron](https://sketchfab.com/3d-models/bugatti-veyron-fully-rigged-5ca18dc84d074655966a6fe7165aa157) by NoOb StUfFs, supplied by the owner | Fictional Revontuli; emblems, lettering, plates and source textures removed; scale, wheels, cabin, materials and gameplay nodes adapted | CC BY 4.0; independently verified through Sketchfab's public API on 2026-10-20 | Source and adaptation contract: `content/assets/vehicle-revontuli.contract.json` | `content/releases/asset-credits.json` |
| [Helsinki Cathedral - Finland](https://www.printables.com/model/486571-helsinki-cathedral-finland) by Dany Sánchez / MiniWorld3D, optimized by Jukka Seppänen (@kijaidesign), supplied as low-poly STL | Cathedral visual, scaled and placed on its register building and LoD2 height, materials adapted and light-baked (decision 0005) | CC BY 4.0 per owner declaration on 2026-10-20; authorship corroborated, exact supplied version's original license not independently retrieved | `models/Helsinki-cathedral-lowpoly.stl`, 38,754 triangles, sha256 `4a3fbc3d…` in `data/work/m0/cathedral/placement.json` | `content/releases/asset-credits.json` |
| Generated ground textures | Asphalt, setts, cobbles, slabs, gravel, grass, yard (seeded procedural, `tools/world/lib/textures.ts`) | Original | deterministic from the seed in `content/helsinki/cells.json` | — |

The 2017 photo-mesh is no longer a source of the release (decision 0005); its mirror and the pilot tools that read
it were deleted on 2026-10-16.

Google Street View was used only as a visual reference, by eye, to judge the buildings against the real street
(decisions 0003, 0005, 0009 and 0010). Nothing from it is a build input or part of the release.

The facade repair in decision 0009 restores damaged atlas pages from the untouched licensed LoD2 masters.
The University northeast wing's obscured lower elevation is reconstructed from the same building's matching
five-bay opposite wing on texture page 44, with illumination matching; its upper 41% remains original before
the existing grade and compression. The mapping is bound to source SHA-256
`d7b3b3ee2fd8b1cb64c6ff3496f8fb42db77149e571f077e52089fa68526f90b`.
This is a documented reconstruction, not recovery of the hidden photographed surface.

Decision 0010 extends this method to individually reviewed street elevations at Topelia, the National Library,
the Bank of Finland, Holy Trinity Church, Rauhankatu 19 and Kirkkokatu 12/14/16. The actual window layouts and entrances are checked
against corresponding street views; obscured architecture is reconstructed from the same licensed building's
clean bays and authored detail. The shared facade registry records exact source hashes, original world/UV
triangles, modified charts and protected details. Unreviewed charts remain original; this is not a claim that
every aerial-photo occlusion throughout the city has been recovered.

The House of the Estates additionally uses **Josefiina Alanen's CC BY 4.0 photographs**:

- [House of the Estates Facade 2021-06-08](https://commons.wikimedia.org/wiki/File:House_of_the_Estates_Facade_2021-06-08.jpg),
  SHA-256 `cd718a6b4599947c9b4e1626617a852c5c2c059e4866061b2ab0f94758bf60f3`.
- [House of the Estates Park 2022-07-20](https://commons.wikimedia.org/wiki/File:House_of_the_Estates_Park_2022-07-20.jpg),
  SHA-256 `efd0f1412d04a3fc388d9abd16a2abbd7c5cade05f08248b7cf92db91b4df516`.

The hashes above identify the original downloaded files. The source export strips
non-rendering EXIF/XMP metadata from these two photographs without changing
pixels. Exported `credits.json` records `sourceSha256` and the current `sha256`;
the exported restoration module pins the latter. Public author/license credits
remain intact.

Both were retrieved on 2026-10-17 and are licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
They are cropped, reprojected and reconstructed with clean same-building donors to remove foreground
occluders. Source JPEGs, metadata and adaptations are retained in `content/assets/facades/estates/`;
`data/raw/estates-facades/ledger.json` supplies both photograph hashes to the release manifest. Google images,
the CC BY-SA side-view reference and unused CC0 preparation photographs do not supply production pixels.

## Attribution shown in the game

The Finn player replacement uses the owner's Finn12 modification of Blender Studio
Snow (CC BY 4.0) and the supplied `game/public/assets/finn.glb`. Its geometry,
native rig and eleven movement clips are retained. The input file, clip manifest,
export report and source report are copied with hashes into
`data/raw/finn12-20261017/`; the original source scene and textures are fingerprinted
in `data/evidence/finn12-20261017/baseline.json`. The supplied export records
`Snow/finn12/snow_studio.blend` as its model source. Source scripts are archived as
provenance references and are not executed by the Helsinki adapter.

Those movement clips were generated by the supplied project's NVIDIA
Kimodo-SOMA-RP-v1.2 workflow, selected, aligned into left-strike loops and retargeted
to Finn's native deform rig. The supplied generation script records seed 7,
100 steps, three samples and constrained root paths/headings. Kimodo's code is
Apache 2.0; its checkpoint licence is separately the
[NVIDIA Open Model License](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/).
The exact original checkpoint revision/hash is not recorded in the supplied
integration inputs; reproducibility here is from the pinned exported GLB, not a
claim to reproduce model inference. Six missing gameplay actions are authored
using this project's existing pose code and Finn's own rest skeleton. Texture
resizing/KTX2 conversion, gameplay actions and sockets are recorded adaptations.
An explicit 89-vertex lower-neck skin-weight patch follows the existing shirt
deformation to fix collar clipping also seen in the supplied demo. Positions,
face shape, native animation arrays and every other skin weight are preserved.
Patch SHA-256: `eefa0d30c1be79aafd6b838716dadb0c31e193ae9c7fd2ee67dbb18d7e93fa02`.
Two source head triangles proved fully hidden beneath the shirt are also removed
to prevent their interiors poking through; all retained indices stay in order.
Face-patch SHA-256: `59cb5cecdedfacc695824689e4edaeee61478f0777d5210fc5f2b8279165aa2f`.
Quaternius is retained as historical provenance; the new Rain officer uses the
supplied native motion export.

Finn's later jump phases are newly authored from the same pinned native skeleton
using this project's Blender pose/IK helpers. No new external motion library or
model inference is involved. `content/assets/finn-jump-poses.json` contains eight
phase variants; `data/work/finn-jump-20261017/v2/report.json` binds source,
authoring script, solver and output hashes. These bundled runtime poses do not
modify the accepted GLB or its original motion arrays. Snow's attribution remains
applicable to the modified character.

The HUD attribution line is the manifest's `attribution[]`: buildings © City of Helsinki 3D city model (CC BY 4.0,
modified), terrain © City of Helsinki (CC BY 4.0, resampled), building register and street areas © City of Helsinki,
road and steps data © OpenStreetMap contributors (ODbL), characters derived from Snow and Rain © Blender Studio
(CC BY 4.0, modified), the supplied native Finn and Poliisi Rain movement exports,
the Mustang-derived Lumi GT/patrol and Veyron-derived Revontuli credited to
NoOb StUfFs (CC BY 4.0, modified), and the Cathedral credited to Dany Sánchez /
MiniWorld3D with optimizations by Jukka Seppänen (@kijaidesign), CC BY 4.0 per
the supplied-owner declaration. The exact evidence and verification limits are
in `content/releases/asset-credits.json`. Kaamos / GT40 was removed on
20 October 2026 following the owner's report of a redistribution restriction.
Quaternius remains historical provenance for the superseded character assets;
it is no longer the active officer's locomotion credit. The two House of the Estates photographs
are credited to Josefiina Alanen with their titles, Wikimedia Commons source and CC BY 4.0 license link,
and are marked as cropped, reprojected and reconstructed.

## Central Helsinki expansion, 2026-10-18

The expanded district uses the same City of Helsinki information-model and
terrain vintages as the accepted Senate district. Frozen ledgers are under
`data/raw/central-expansion-20261017/`; counts, hashes, overlap comparisons and
reproduction commands are in [the build recipe](central-expansion-build.md).
The active source configuration for this expansion is
`content/helsinki/central-expansion/sources.json`. The game loads locally packaged
assets, not live map-service tiles. The removed 2017 mesh is not used.

`models/Alexander/Alexander-improved.glb` is the project owner's supplied sculpture.
Its original SHA-256 is
`a70d9cabb2bc5b2ad76d8f46af44866c315ddff9cf5e4a6ad1d93c5f4baafc50`.
Placement uses the established square-centre origin. Height calibration uses
[HAM's Alexander II record](https://www.hamhelsinki.fi/en/sculptures/alexander-ii/).
The original file remains untouched; production derivatives compress textures
and provide separately bounded geometry variants for low/distant rendering.

The Pohjoisesplanadi 31 scaffold-covered front uses a rectified and bounded
reconstruction from Marja Valtonen's photograph, Helsinki City Museum, CC BY 4.0:
[museum record](https://hkm.finna.fi/Record/hkm.0930CD28-8917-4792-A315-631BC6E7A029).
Its file and reference-only sources are pinned in
`content/assets/facades/esplanadi/source-ledger.json`; production photo SHA-256 is
`ec4314fbe12857b8794836bd99ddccb3767d0eb36fd757a7595baadd64a5c4b0`.
Nearby repairs use licensed city pixels. Google Street View could not be opened
in this session, so the facade protocol's official museum/building-control
reference fallback is recorded explicitly. No Google imagery is used in textures.

## Mannerheimintie and Uspenski expansion, 2026-10-18

The next bounded district retains the same projected origin, 128 m cells and
accepted city-model prefix. Its fresh source ledgers are under
`data/raw/district-expansion-20261018/`; the release source configuration is
`content/helsinki/district-expansion/sources.json`. The snapshot contains 2,494
city tiles, 1,182 building-register features, 9,708 deduplicated street parts,
and an unfiltered OSM union. Shared city payloads, street parts, road nodes,
road ways and turn restrictions match the previous district. The acquisition
report separately records three changed cycling-route relations. The removed
2017 mesh remains excluded.

Water boundaries come from the pinned OSM coastline/water geometry. Registered
street-area bridge decks remain physical surfaces. The displayed water plane
uses N2000 zero as a cartographic convention, not a measured tide. Build inputs,
bridge exclusions and reproduction commands are described in
[the district recipe](district-expansion-build.md).

The Parliament front is original procedural geometry, fitted to the city
building's existing front envelope. KIVI's geotechnical report 20/2024,
Figure 11, and the official architectural descriptions are visual references;
their photograph pixels do not enter the asset. The reference ledger and
opened photograph are under
`data/evidence/district-expansion-20261018/parliament-reference/`.

Finlandia Hall's bounded facade restoration uses licensed same-building city
texture pixels and authored marble/glazing details. Alvar Aalto Foundation
photographs, the architect's exterior gallery, and City of Helsinki building
control's four-elevation drawing are reference-only. No Google imagery is used.
Street View could not be opened in the sanctioned browsers, so the facade
protocol's primary architectural-reference fallback is recorded explicitly.
The repair ledger identifies exact charts, protected openings and any remaining
unverified sections; source geometry is preserved.

## Western Kamppi and Töölö continuation, 2026-10-19

The additive source archive is `data/raw/city-continuation-20261019/`, with release
credits in `content/helsinki/city-continuation/sources.json`. It retains the
accepted LoD2 vintage `303357262605` and terrain layer version
`1.1708423032937557`, EPSG:3879/N2000 and the existing origin. It adds 101 LoD2
tiles and 231 terrain tiles, fetching 94,665,538 new bytes across all layers.
The combined register contains 1,508 building footprints and 11,324 street parts.
Accepted source records are retained; OSM appends 10,287 IDs. Eleven changed
duplicate OSM records have explicit witnesses: seven tree attributes, three bus
routes and a cycleway whose changed segment lies outside the playable rectangle.

The source acquisition and conflict receipts are under
`data/work/city-continuation-20261019/acquisition/`. Temppeliaukio's public
approach uses complete OSM footway/entrance nodes and the church's official
[visiting information](https://temppeliaukionkirkko.fi/index/suunnittelevierailusi.html).
No reference photograph pixels are shipped. Runeberginkatu's Baana bridge remains
excluded from the driving graph: the configured outer tyre strip exceeds the
surveyed carriageway and the single-height terrain conflates its upper and lower
levels. Existing supported crossings provide the detour; this expansion does
not authorize an invented deck. The same exclusion includes its source-bound
7.807 m terminal road approach (OSM way `24466500`, municipal bridge part `47800`);
the preceding public junction remains usable.

The mapped driveway `1382288051` beside Lapinlahdenkatu 16 was checked against
the City's `Ortoilmakuva_2025_5cm` WMS layer. Exact request, retrieval time and
opened image hash are in
`data/work/city-continuation-20261019/verification/v4-driveway-reference-v1.json`.
The image supports an open-air paved access; canopy and shadows do not establish
its measured width or legal access. A separate, explicitly authored 1.117 m
half-width buffer of the unchanged OSM axis repairs a terrain pit using native
grading. It is labelled `AUTHORED_OSM_DRIVEWAY_1382288051`, never passed off as a
municipal feature. Original register bytes and reference pixels remain unmodified
and unshipped respectively.

See [the continuation record](city-continuation-2026-10-19.md) for selected bounds,
the measured old-frontier ground repair, final candidate and verification status.

## Original canalside facade charts, 2026-10-18

The Presidential Palace east/Mariankatu elevation (VTJ `1032494093`), Main
Guard south/Kanavaranta elevation (VTJ `103017640N`) and Parliament's south lower
front wing (VTJ `1031902037`) have original procedural artwork, dedicated under
CC0-1.0. The chart profile selects only 14 Palace, 18 Guard and two Parliament
existing wall triangles at each tier; source geometry and other elevations
remain unchanged. The artwork, exact source bindings, opening counts,
approximations and reference hashes are recorded in
[the combined chart ledger](../content/helsinki/district-expansion/facade-charts/canalside-v3/source-ledger.json).
The approved source artwork requires a separately bound application profile and
runtime verification; this register does not claim release activation.

Actually opened appearance references are the
[Office of the President's exterior photographs](https://www.presidentti.fi/en/pictures/presidential-palace/)
(Matti Porre), the Finnish Heritage Agency's
[complete east elevation](https://www.finna.fi/Record/museovirasto.CD4234EC063271791B3E54AC4FF9844D)
and [Mariankatu view](https://www.finna.fi/Record/museovirasto.9434E8449CCD91F7DF6016F25860D541),
and Volker von Bonin's canal photograph, Finnish Heritage Agency, published in
[Yle's Main Guard article](https://yle.fi/a/3-11446975). Photograph pixels remain
reference-only evidence and are not copied into the artwork or shipped assets.
Parliament's eleven arched openings are verified in the tree-free aerial,
image 2 of the [City Museum architecture record](https://www.finna.fi/Record/hkm.C070A514-709A-4A40-9F6D-D8413A6AD6D4),
with contemporary colour/material corroboration from the
[official Parliament aerial](https://www.parliament.fi/fi/vieraile-ja-osallistu/eduskuntatalo)
(Lev Karavanov / Mostphotos). Only source triangles 665/666 on the 38 m south
lower-wing front receive that chart. The separate stair-side return 661/662 and
all upper-front authoring remain unchanged. Textureless distant triangles retain
their geometry and use a corner-colour approximation rather than full window
detail; runtime tier/appearance review remains required.
The Guard continuation adds four recessed south-plane faces and two southeast
faces. The six-bay south rhythm retains its original world stations across the
recess; the separate southeast elevation has five blind arches and five high
windows, verified in image 2 of the
[City Museum Main Guard record](https://www.finna.fi/Record/hkm.E7295B4D-1D26-4351-9F57-1D2A3DC096A2).
Recess window and sill heights remain aligned; the extra source height uses
original blue plaster without inferred openings. Two new atlas strips occupy
only proven unused Palace UV space, preserving all previously used base texels.
Their generated mip levels still require native appearance review. The two
identified source-flat background buildings at Pohjoisranta 2 remain outside
this named repair; their source IDs and limitation are retained in the ledger.
Street View was attempted through the sanctioned browser controls, but no
browser surface was enabled; the facade protocol's official/museum fallback
was used without a headless Maps bypass. The source configuration credits the
new original pixels separately from those reference-only photographs.

## Origin

`senate-square-statue-v2`: EPSG:3879 / N2000 `[25497350, 6672960, 7.50]` (`content/helsinki/world-origin.json`). The
origin height comes from a least-squares plane through the city terrain model on an 8 to 20 m annulus around the
statue (1,057 of 1,064 samples kept, 0.052 m RMS; `tools/world/derive_origin_height.ts`). It supersedes
`senate-square-statue-v1` (height 7.29 from the lowest 2017 mesh surface; decision 0005). Three control points
(Cathedral, Railway Station, Market Square quay) are the permanent re-tiling test; only the Cathedral lies inside the
pilot.

## Shoreline tree reference imagery, 2026-10-18

City of Helsinki, City Survey Services: the 2025 orthophotograph, 5 cm layer
`avoindata:Ortoilmakuva_2025_5cm`, retrieved from the official
[open WMS](https://kartta.hel.fi/ws/geoserver/avoindata/wms).
The City's [open geographic data terms](https://www.hel.fi/en/decision-making/information-on-helsinki/maps-and-geospatial-data/make-better-use-of-geospatial-data/open-geographic-data)
state [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
Attribution: Data and maps © City of Helsinki, City Survey Services.
The layer is listed in the [official WMS catalogue](https://kartta.hel.fi/avoindata/dokumentit/Aineistolista_wms_avoindata.html).

Three georeferenced shoreline crops were opened to investigate new-area tree
points against the source coastline and actual supported bank. Their exact
requests, EPSG:3879 bounds, retrieval times and SHA-256 hashes are retained in
`data/evidence/district-expansion-20261018/tree-shore-reference/retrieval.json`
and `tree-bank-reference/retrieval.json`. These are reference-only evidence;
no orthophotograph pixels enter the shipped geometry, materials or textures.
Canopy and shadows obscure some exact root footings. The imagery therefore
does not authorize invented dry land beneath unresolved water-side points.

The same layer was also opened for the northern Meritullinkatu planting throat.
Its exact request and image hash are in
`data/evidence/district-expansion-20261018/meritulli-source-reference-v1/retrieval.json`.
That reference corroborates the planting and narrow western path; it does not
by itself establish legal vehicle access beneath canopy or shadow. The source
topology and routing decision are recorded separately in `road-layout-v6/source-lock.json`.

## Original street paving and embedded tram artwork, 2026-10-18

Regular and fan-pattern granite paving textures (256 × 256) and the 44 × 4
cross-rail stripe texture are original procedural project artwork, CC0-1.0.
Grey granite colour, approximate 20 × 10 cm rectangular setts, 10 cm cube stones
and 4 mm joints are authored appearance choices, not measured construction
dimensions. The regular tile uses physical UV repeats for rectangular setts or
cube stones; a separate fan tile serves the square's reviewed panels. No Google,
municipal photograph or operator-image pixels enter these assets. The separate
[production credit ledger](../content/helsinki/district-expansion/streets-v1/production-credits-v1.json)
and immutable [source/reference ledger](../content/helsinki/district-expansion/streets-v1/source-ledger.json)
record the source plans, licences and reference roles. Final producer receipts
bind actual encoded artwork and selected faces; these credits do not imply
coverage approval, runtime acceptance or release activation.

Footprints and original material classifications remain from the City of
Helsinki public area register, CC BY 4.0, snapshot SHA-256
`c853f169944e20c7a77b0c06f434ecc04bb95b59f153d10c5ca14adc198983a6`.
The 14-region source plan identifies 383 explicitly typed `Nupukivi`/`Noppakivi`
parts on Mannerheimintie, both Esplanadi streets, Senaatintori and five named
Senate streets. The supplementary streets are bounded to the accepted Senate
rectangle. Selection also requires the matching existing stone finish and
complete upward-face containment; asphalt, slabs, grass and park ground are not
blanket-replaced. Only the 50 square panels `58148`–`58197` receive fan paving.
The outer concrete walkway `58145`, pale stone inserts, monument ring and
source geometry remain separate. The
[opened municipal material map](../data/evidence/district-expansion-20261018/street-surfaces-v1/senate-source-material-map.png)
shows those exact source divisions; it is a source-derived diagnostic, not an
aerial photograph.

The following corresponding panoramas were actually opened through sanctioned
Chrome controls and used only as appearance references:

- [Mannerheimintie/Lasipalatsi, August 2024](https://www.google.com/maps/@60.170354,24.9375878,3a,75y,220h,90t/data=!3m7!1e1!3m5!1sXsxhGDr8ASn5EdMn-nbhEA!2e0!7i16384!8i8192): grey rectangular roadway setts, separate red asphalt bicycle surface, slab walkway and concrete-slab tram corridor.
- [Pohjoisesplanadi 21, August 2024](https://www.google.com/maps/@60.1678257,24.9496958,6a,75y,90h,90t/data=!3m7!1e1!3m5!1sAXVzrnoAL1M_Y0yYY3ukaQ!2e0!7i16384!8i8192): rectangular sett roadway, separate slab walks and small-cobble tree pits.
- [Eteläesplanadi 14, August 2026](https://www.google.com/maps/@60.1671628,24.9476383,8a,75y,86.72h,90t/data=!3m7!1e1!3m5!1sNhFmSmtZmqvTwmZ2mVQ09A!2e0!7i16384!8i8192): independently checked rectangular sett roadway and slab sidewalk; park gravel/green remains separate.
- [Senate Square, August 2022](https://www.google.com/maps/@60.1694794,24.9522867,3a,75y,88.59h,90t/data=!3m8!1e1!3m6!1sCIHM0ogKEICAgIDuvN6ACQ!2e10!3e11!7i4608!8i2304): Xavi Terns Mas's contributor 360 panorama, not Google car Street View; grey/reddish cube fans inside pale straight panel borders.
- [Aleksanterinkatu 18, August 2024](https://www.google.com/maps/@60.169101,24.9539697,8a,75y,90h,90t/data=!3m7!1e1!3m5!1seQ0hfRuNK8sl8mdB-2Rh8A!2e0!7i16384!8i8192): rectangular sett roadway, slab sidewalk and embedded parallel/turnout tram rails beside the square.

These views do not independently photograph every metre of the supplementary
Senate streets; their exact municipal material polygons remain the authority.
The northern Mannerheim statue panorama that defaulted to August 2014 was not
used as current 2026 appearance evidence. Earlier facade tasks' unavailable
Street View records remain historical; the five street references above were
opened later in this session.

Tram axes retain the pinned OpenStreetMap snapshot, ODbL 1.0, SHA-256
`fe31bf359524e5801c6a607d62a6562736c8dfb0dea13ea45be20bd8c697c1c9`.
The bounded Mannerheim profile contains 92 actual separately mapped track ways
and their original ordered nodes, including junction curves; no second track
is invented from a road centreline. The operator's
[official terminology](https://kaupunkiliikenne.fi/termisto/) defines the
centreline between rail measuring points and straight-track gauge as exactly
1,000 mm between those points. The City's
[tram paving guidance](https://kaupunkitilaohje.hel.fi/kortti/raitiotie/)
(draft, updated 8 May 2024) specifies paving 0–5 mm below rail running level
and source-specific adjoining materials. These are technical references only.
The visual rails follow final decoded ground with an authored 3 mm lift;
physical ground and collision remain unchanged. Rail section/groove detail is
a visual approximation, not an engineering or as-built track survey.
The original stripe's 24/14/6 pixel bands represent the authored 60/35/15 mm
head/groove/guard widths; the 1,000 mm gauge remains defined at measuring points.

## Malminkatu facade investigation, 2026-10-19

The [Malminkatu 5 owner's listing](https://www.etuovi.com/kohde/47918247)
and the City's [Kampin family-centre page](https://www.hel.fi/fi/sosiaali-ja-terveyspalvelut/lasten-ja-perheiden-palvelut/perhekeskukset/kampin-perhekeskus)
supplied reference photographs only. The official family-centre photo is credited
to Kaisa Sunimento; its source filename records 16 August 2022. The associated
[2026 renovation plan](https://ahjojulkaisu.hel.fi/A77A50F5-B92B-C2C4-96B3-9C7A79400000.pdf)
supplies project context, not a complete visible elevation. Retrieval URLs,
response/file hashes and opened diagnostic panels are retained under
`data/work/city-continuation-20261019/references/` and
`acquisition/walk005-facade-diagnosis-v1/` in that work root.

These photographs show different facade sections from the concealed lower
openings on city-model pages 2460 and 1299. No image pixels or inferred hidden
window grid from these references enter production. A source-only wall-band
preview was rejected as ineffective and never applied. Google Street View was
not accessible through the computer-use connection in this investigation.
The municipal public-area polygon identifies the actual affected exterior as
Malminkatu pedestrian part 47150; the broader native route label does not replace
that geographic authority. See the [continuation record](city-continuation-2026-10-19.md)
for the exact unresolved chart bounds and preservation requirements.

## Northern source expansion, 2026-10-19

The `city-north` snapshots under `data/raw/city-north-20261019/` extend the
accepted source coverage without changing municipal vintages: textured LoD2
`303357262605`, terrain 2021 layer `1.1708423032937557`, street/park trees
`303007720360`, and plot/forest trees `300497315794`. Municipal data remains
CC BY 4.0; OpenStreetMap remains ODbL 1.0. New acquisition totals 46,107,096
bytes: 45 LoD2, 142 terrain and 173 tree tiles, plus register/OSM responses.
Conversion adds 119 buildings. The release-source configuration is
`content/helsinki/city-north-20261019/sources.json`; individual raw ledgers
retain payload identities and retrieval records.

Combined `city-north` snapshot SHA-256 values (tile rows identify tile indexes):

| Raw ledger directory | Snapshot SHA-256 |
| --- | --- |
| `lod2` | `d86ab2b294bb4f1a3da80a6d34c96ebc2e04f2afa55c0dfbfe91b36d5b720601` |
| `terrain` | `2ac2db9f088fe6b5807438d6996e3bb5915c804013cee140d13daf1a39d935e4` |
| `trees/street` | `70bd6cb13da8ec4c14d8e469546914a5e05f8ce9a9599d0030f0dade1825bf50` |
| `trees/plot` | `2b41e2a6ab21aeb848b68fbcdc15bc36b3da6b258ac34fb8e5d49ea8f47e1569` |
| `building-register` | `a193f6e0b2567b216ae59ab36faea68631f876d465eb6295ee97733f947049a3` |
| `street-parts` | `f920ab43145e1721247ad76bddb6fd2de591efe317800d2ae88e067aa91ded94` |
| `osm` | `707388efff3d70d40c3e71898d22dbdb908d1137a67f6dac2e3b13ef26c49c1a` |

Opened official 2025 orthophotos are reference-only. The
[service-access receipt](../data/work/city-north-20261019/verification/service-1352652165-reference-v1.json)
supports the forecourt interpretation; its three-metre working width is an
authoring approximation. The
[full-bank receipt](../data/work/city-north-20261019/coastal-bank/bank-full-reference-v1.json)
supports restoring the complete municipal terrestrial part `527816` intersection
with OSM coastline `24629633`'s water, excluding explicit municipal water
`527803`/`527804`. Neither image supplies production pixels. Four individually
qualified new tree-model omissions address a ground barrier, registered
building, map edge and true-water model incompatibility; they are not claims
that real trees are absent. Raw records remain unchanged.

For Runeberginkatu 55a's Tykistönkatu elevation, the opened
[exact building photograph](https://www.finna.fi/Record/hkm.335C42C2-031B-4BFD-A721-1158C9AD7668)
is **Sari Schulman / Helsinki City Museum, CC BY 4.0**, visual reference only.
Production donors come exclusively from the same building's licensed municipal
texture page 2624. The partial residential repair changes 10,281 texels at
512-pixel production size, preserving geometry, UVs, other charts, cornice and
protected ground frontage. Baked foliage at the unresolved ground shopfront
remains; this is not complete facade cleanup. Google Maps/Street View was
unavailable in this investigation; earlier documented opened panoramas remain
separate evidence. These source records establish neither final native
acceptance nor activation.
## Floating structures qualified during the northern extension

The current municipal register identifies Meripaviljonki at Säästöpankinranta 3
as VTJ `103171023H`, feature `Rakennukset_alue_rekisteritiedot.40743`, type
`Muu rakennus`. The [operator's English page](https://meripaviljonki.fi/english/)
identifies the floating restaurant. Its original municipal source/native roof,
rather than a new photographic reconstruction, supplies the 569-face exterior
collision shell. The retrieved operator image is an interior dining-room view;
its historical local `exterior.avif` filename does not establish an exterior
reference. Operator imagery is reference only and no pixels are shipped.

The separately registered Allas sauna VTJ `104015441T`, feature
`Rakennukset_alue_rekisteritiedot.79287`, retains its accepted model and collision.
The [Allas sauna page](https://www.allaspool.fi/en/saunas/) and opened operator
photo establish the floating-sauna context. Source/native roof difference is
79 micrometres, within the unchanged 35 mm structure alignment check.
Exact retrieval URLs, hashes, register identities and original failed samples
are retained in `data/work/city-north-20261019/service-ground/water-static-diagnosis`.
These finite declarations permit their visible buildings over water; ground,
terrain and undeclared structure checks remain strict.
