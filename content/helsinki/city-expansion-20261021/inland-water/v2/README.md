# Inland features and the sea mask

`profile.json` identifies ten inland OpenStreetMap water features in the new
northern strip. Near-coastal way 725901862 stays unchanged, as recorded in the ledger. Their exact projected rings and complete source tags are checked
against `osm-public-v3.json`. The accompanying ledger records the original City
of Helsinki terrain survey identity and municipal part IDs. OpenStreetMap data
is ODbL 1.0; municipal terrain and ground data retain CC BY 4.0 attribution.

The original coastal producer treated every `natural=water` polygon as sea:
it removed ground and lowered fallback terrain to the sea safety floor. These
features include intermittent rock pools, freshwater ponds and artificial ride
canals. Their native source elevations do not establish one common water level.
The new repair therefore restores the literal original municipal ground inside
the selected source rings, excluding source decks already retained by the
coastal producer. It removes their incorrectly placed sea plane. Inland water
surfaces and ride structures remain unmodeled pending an appropriate elevation
source; no level pond floor or photographic height is invented.

The pre-coast ground replay uses the same frozen producer and inputs as the
native northern build, with only coastal processing omitted. Before applying a
repair, replaying the original sea safety cut must reproduce the complete
original post-coast terrain field exactly. Only changed inland safety samples
may then be restored, and a later conflicting terrain change fails the build.
Clipping interpolates the native height and UV values. Rendered and solid
triangles come from those same restored faces.

Existing GLB binary data, attribute accessors, images, materials and texture
references remain literal. Water edits append replacement indices; new ground
faces reuse the corresponding native material. Every existing collision array
is retained as a prefix, and every unrelated collider remains unchanged. The
builder validates each changed GLB, records payload hashes and checks the
existing delivery limits. Native traversal and Standard/Low visual review are
separate requirements before release acceptance.

Run `tools/world/repair_delivery_inland_water.ts` with an immutable input world,
the exact profile and manifest hashes, both pinned native cache receipts, the
original source root, and a fresh output directory. Private acquisition/cache
paths stay outside the public packet. Its publication receipt retains source
hashes, the frozen producer inventory and per-cell changes without those paths.

The builder also reconstructs the water mask with the selected qualifications removed, so independently covered water from other source ways, relations and coastlines remains protected. It verifies that the public source reconstructs the original complete water mask before applying the repair.
