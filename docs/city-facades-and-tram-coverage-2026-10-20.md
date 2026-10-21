# Street facades, tram coverage and startup

This pass starts from deployed source `c91c7802b5fd187ad341df490dedb9e91aac48aa`,
world `senate-20261020-reference-repair-v3`, manifest SHA-256
`18e40f69a271f037b6b23b257fee437cb5716fad68c10cff808833a142ee7607`.
Public main and the live deployment receipt agreed before work started.
The source export is the publishing checkout; the unrelated authoring history
is not a release input.

## Material investigation

The offline census covers all 304 cells, 1,695 municipal building records,
609 unique visual payloads and 508 referenced shared images. It found no missing
shared-image payloads. There are 193 building records with remaining constant
wall UVs or image-free wall material; 134 have a municipal VTJ identifier and
are listed in the [baseline inventory](../content/helsinki/city-facades/baseline-inventory-20261020.json).
That inventory is a reconstruction queue, not a claim that every flat wall is
incorrect. Party walls, plinths, buried portions and genuinely blank elevations
need separate reference qualification. Deliberately textureless distant LODs
are excluded from this diagnosis.

Actual runtime before views confirmed blank public elevations on the nine
selected records below. Their required images returned HTTP 200 with matching
hashes, and source-bound ray hits showed identical UV coordinates on all three
corners of the wall triangles. These facades lacked source artwork; increasing
texture resolution or retrying their successful image requests cannot add it.

## Referenced reconstruction

Google Street View establishes architectural appearance only. The new textures
are original SVG/PNG artwork under CC0-1.0; no Google image pixels are included.
The [source plan and ledgers](../content/helsinki/city-facades/README.md) bind
each chart to exact municipal triangles, source hashes and observed panoramas.

| Municipal record | Selected public elevation |
| --- | --- |
| `103036798N`, Fabianinkatu 18 | East frontage, four regular upper rows, tall lower glazing and canopy; plinth follows the measured street grade. |
| `1030367770`, Fabianinkatu 16 | East frontage, charcoal panels, four upper window rows, glazed shops and recessed passage. |
| `103036803U`, Aleksanterinkatu 9 | Eastern south frontage, three broad groups of four glazed panes per upper row and a two-level shop base. |
| `103036799P`, Aleksanterinkatu 9 | Western south frontage, four ribbon-window rows over a glazed shop base; projecting planes share a continuous artwork frame. |
| `1030368124`, Fabianinkatu 26 | East frontage, rough granite lower zone with five arches, gridded upper glazing, oriels and a separate northern passage. |
| `1030368102`, Fabianinkatu 28 | East frontage, ochre plaster, three upper rows, two oriels, darker ground floor and off-centre arched entrance. |
| `103046222N`, Eteläesplanadi 12 | North frontage, sandstone coursing, six upper bays with ten openings per row, four differentiated rows and five ground arches. |
| `103036835V`, Mannerheimintie 5 | Referenced central 26-metre southwest elevation, five large arches and central passage; unverified corner/tower wings remain unchanged. |
| `1030367814`, Pohjoisesplanadi 25–27 | Hotel Kämp south frontage, cream rusticated base, salmon upper panels, three tall window rows, low arched attic and one observed wooden portal. Whole-front module dimensions are an authored approximation. |

There are 271 selected municipal triangles in 144 plane charts. The charts keep
the existing geometry and winding, including oriels, projecting bays and recesses.
Unselected UVs, images, materials, roofs and collision are preserved. Strong
street grades use measured visual/HCOL support profiles rather than a single
assumed ground height. Source dimensions are exact; opening details are original
approximations fitted to the observed architecture, not a survey.

Each owner cell shares one new 1024-pixel atlas across its selected buildings.
Five detailed atlases add approximately 6.667 MiB of BC7 GPU residency and one
draw per affected cell. Distant tiers sample colours without adding textures.
The grouped authoring path retains legacy profiles: regenerating all twelve
previous Senate facade source artifacts produces byte-identical output.

## Tram reference and placement

The owner requested missing physical tracks beyond the existing Mannerheimintie
coverage. The current [HSL route map](https://www.hsl.fi/matkustaminen/reitti_ja_asemakartat)
was inspected, using the 31 August 2026 map applicable on 20 October, rather than
the future November map. It corroborates the central Helsinki corridors.
The schematic and Google Street View are references; actual separately mapped
OpenStreetMap railway axes determine placement. A service diversion does not
automatically remove an existing physical track.

Track placement must preserve source node order and projection, the Helsinki
1000-mm gauge, existing Mannerheimintie rails and the actual playable bounds.
Rails follow matching decoded visual and collision ground; different valid
triangulations require a coverage proof rather than identical triangle indices.
Bridge qualification uses the actual supported deck profile and bank joins,
not an assumed straight bank-to-bank plane. New support repairs, if needed,
are recorded separately from rail-only append operations.

The 304-cell pass selects 331 source ways: 326 new ways and five tiny accepted
junction gaps. The gaps are bounded ribbon differences, not duplicate whole
ways. The additions affect 82 owner cells and contain 18,944.06 metres of
separately mapped track axes; parallel tracks count separately. All 94 previously
accepted unique way IDs retain physical coverage. Six bridge tram ways use
qualified deck profiles. Four small support repairs in three owner cells are
separate rendered/collision changes, with measured bank joins and native contact
checks. The later bridge reconstruction can replace those profiles only with
fresh geometry and traversal proof.

## Startup

The [English/Finnish language support](language-support.md) adds an accessible
flag toggle and remembers the explicit selection. The
[screenshot-backed start screen](start-screen-2026-10-20.md) uses the user's
game screenshot behind readable translucent panels, an explicit Play button,
graphics choices and the complete scrollable credits. The image is a metadata-free
142-KiB JPEG; it does not change world geometry or city streaming.

## Acceptance

The intermediate `senate-20261021-facades-trams-v1` packet has 304 cells,
1,945 files and 633,572,568 bytes. Its manifest SHA-256 is
`1bc5d57e122b02563d93ed14402b8569133e143d9e5f881cff5c755233dfd2c4`.
The Standard and Low runtime checks each captured three native approaches to
every selected facade, two views of five tram corridors and a return to the
first owner. All 76 individual images were opened and reviewed, with no
concrete new chart or rail appearance defect. Actual HTTP responses matched
the pinned textures. Both circuits evicted distant cells and requested the
first owner's GLB again on return; no console or unexpected network errors
were recorded. These results bind this intermediate packet and its runtime,
not the subsequent city/bridge extension or a hosted deployment.

The final combined world, source gates, ordinary production smoke and hosted
verification must be recorded before publication. The committed Pages descriptor
and live deployment receipt remain the authority for the published source and
payload identities. Local pilot captures do not establish hosted completion.
