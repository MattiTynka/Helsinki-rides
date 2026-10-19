# Western Kamppi and Töölö continuation

Status: LIVE LOCAL INTEGRATION, WITH THE MALMINKATU APPEARANCE LIMIT BELOW.
Active world `senate-20261019-809c1a14` passes seven exact-candidate native jobs
and all eight ordinary UI checks; root opened 18 selected native and four
ordinary captures. The first low fixture failure at West Kamppi (558,833
triangles) is retained. Runtime v7 adds source-preserving foliage LOD and passes
all six locations in four headings over two rounds at a maximum of 449,313
triangles and 166 calls. All 373 frozen runtime tests and five typechecks pass.
See the [final benchmark](benchmarks/city-continuation-2026-10-19.md) and
[handoff](handoff-2026-10-19.md) for identities, measurements and the ordinary
page integration receipt.

The next contiguous area extends the western boundary from X −1350 to −1792 m,
retaining X max 800 and Z −950..450. This adds 618,800 m², bringing the playable
rectangle to 3.6288 km². It includes Temppeliaukio's public approach and more of
western Kamppi, Runeberginkatu and the streets around the church. Existing Senate
Square, Mannerheimintie, Esplanadi, Uspenski, facade repairs, paving, rails,
Alexander monument and character/car assets are retained. The 2017 mesh remains absent.

The source uses the existing EPSG:3879/N2000 origin and 128 m cells. Its official
textured LoD2 vintage remains `303357262605`, terrain remains
`1.1708423032937557`. Acquisition reused immutable cached tiles and fetched
94,665,538 new bytes across the necessary layers. The
[acquisition report](../data/work/city-continuation-20261019/acquisition/acquisition-report-v1.json)
records actual source URLs, hashes, licenses and bounded network recovery.
The old source model's 1,238 buildings, 2,096 texture pages and 20,389,104 binary
bytes remain exact prefixes; 338 buildings and 490 pages are appended.

OpenStreetMap retains all accepted elements and appends 10,287 new IDs. Eleven
changed duplicates are recorded individually: tree attributes, bus-route relations
and a cycleway entirely outside the playable southern boundary. Accepted
geometry is not silently replaced. The main church entrance is checked against
the official [visiting information](https://temppeliaukionkirkko.fi/index/suunnittelevierailusi.html)
and complete OSM footway nodes. No reference photograph pixels enter the game.

The authored terrain extension copies every accepted Float32 height bit for bit,
including the monument. New cells are built separately, with old building IDs
excluded before atlasing. A measured boundary repair replaces only ground west
of X −1345: the old ground extended to −1352 with terrain clamped at −1350,
creating steps as large as 3.10 m against the new source. Native ground meets the
retained interior at −1345 within 15.7 mm over 2,800 dense samples. This repair
preserves all buildings, facade images, other colliders and interior ground.
The derived fallback field needs 207 downward corrections confined to that outer
five-metre band; the authored source heights remain unchanged. Changed ground
accessors are appended without re-encoding accepted building resources.
Unchanged payloads and immutable source textures use hardlinks to limit disk
duplication. The exact repair/preservation receipts remain part of acceptance.

The integrated candidate has 276 cells: 216 accepted cells are byte-identical,
21 accepted boundary cells receive appended or bounded ground updates, and 39
cells are new. A full-width audit of 923 western public/service lanes sampled
1,043,404 points, including 725,421 physical vehicle-footprint points, with no
missing support, visual/collision disagreement or mandatory steps above 0.35 m.
Lapinrinne's surveyed shared street and one mapped open-air driveway receive
bounded native ground repairs; no building geometry moves. The driveway's
1.117 m half-width authoring buffer is a vehicle-feasibility approximation,
not a measured municipal street width. Original survey inputs remain immutable.

Runeberginkatu's Baana crossing remains excluded from vehicle routing because
the source ground does not yet represent both vertical levels correctly. The
7.807 m terminal approach belongs to that same unsupported crossing; the
preceding public junction and Runeberginkatu remain connected. The tested drive
uses supported streets through Fredrikinkatu instead.

The continuous walking plan retains its 518 original coordinates and inserts
two surveyed-sidewalk control points around an unchanged projecting building
bay. It has 520 points, four boundary crossings and all four new landmarks.
Its 5.74 km CPU traversal passes. The final browser's continuous real-control
route passes all 520 points over 5,747.7 m without fall/recovery; eight directed
driving goals also pass with zero recoveries and an exact own-recording replay.

Final integration closes 25,918 qualified ground interfaces with 102,088
exactly vertical triangles; independent HCOL verification proves that no floor
area or height changes. One source-bound skirt at Cygnaeuksenkatu 6 receives
28 visual triangles per tier, reusing its existing palette texel. The remaining
new trees are seated against actual decoded soil: 214 Y corrections, 1,336
unchanged placements and 13 explicitly documented omissions where this trunk
model crosses source walls or the playable boundary. Raw source records and
all 4,079 accepted scenery instances remain exact. Independent serialized
output verification also proves all ground, terrain, buildings and accepted
tree colliders unchanged by the tree registration.

Candidate manifest SHA-256:
`9acf7069c977b9314d75e1cf69b62b8174263f014acdee60129d783a2ab6230f`.
The final cells index is
`420bd6b2f7d823ebd615f53d3e521193efb05b616f54d840cf05dc1bd78a622f`.
All 351 world tests and the world typecheck pass. All 120 changed/new cell GLBs
validate; 433 cell GLBs reuse exact accepted bytes. The 21-check static world
audit passes, including 4,493,798 full-width road samples and 278,135 accepted
interior preservation samples. Five initial query-edge failures are retained
with native Float32, exact triangle, opposing-ray and shape-cast proofs; focused
negative tests still reject real finite gaps and displaced colliders. No sample
or payload was removed to make that audit pass.

Runtime v7 inherits frozen v6 plus only LOW foliage rendering changes. Full
source leaves remain within 120 m of the conservative crown sphere; nested
160/80-card subsets serve more distant crowns with hysteresis. All original
trunk/branch geometry, leaf attributes, tree positions and standard-preset
behavior remain exact. Six shared index buffers add 8,640 bytes and no textures.
Visual residency limits remain unchanged.
Static collision and terrain remain resident; this is not collision streaming.
Selected verification binds this exact world and runtime to preservation,
terrain, seams, vehicle support, actual-control travel across the old boundary
and back, both preset fixtures, request-failure recovery, opened captures and
ordinary production integration. Source acquisition and code tests alone do
not establish those outcomes. The [verification plan](../data/work/city-continuation-20261019/verification/native-verification-plan.md)
records the original command interfaces and limits; final selected identities
and executed results are in the benchmark.

## Malminkatu appearance limitation

Opened native captures exposed photographed trees on two source elevations:
Malminkatu 5, VTJ 103074995U, source page 2460/part 1/triangles 47–48 and
101–102; and Malminkatu 3, VTJ 1030750022, page 1299/part 6/triangles 0–3.
The municipal street polygon puts both beside Malminkatu pedestrian part
47150. The broader waypoint label mentioning Pohjoinen Rautatiekatu is not
the exact street identity. These are not presumed inaccessible courtyard walls.

The owner's listing photographs and official family-centre photograph were
opened and bound to hashes. They establish materials and other frontages,
but do not resolve these elevations' concealed lower openings. Chrome is on
according to the user, while the computer-use connection still reports no
browsers; no Google Street View inspection is claimed. A bounded partial
reconstruction of known solid bands was inspected and rejected: it leaves
96.43% of the diagnostic green-colour proxy and all six traced problem pixels
unchanged, producing isolated stripes. No production pixels were changed.

The [reference disposition](../data/work/city-continuation-20261019/acquisition/walk005-facade-diagnosis-v1/reference-disposition-and-bounded-plan.json)
and [partial review](../data/work/city-continuation-20261019/acquisition/walk005-facade-diagnosis-v1/partial-scope-v1/partial-restoration-review.json)
record exact source bounds, protected architecture and the additional reference
needed. `repair_owner_facades.ts` is implemented and tested for this appended
world: numeric image ownership, exact original atlas negative controls and
preservation of geometry, unrelated pixels and derived tiers. Its plan remains
reference-pending. This continuation does not claim those two facades cleaned.
