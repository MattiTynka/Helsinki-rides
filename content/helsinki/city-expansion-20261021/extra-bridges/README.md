# Source-bound additional crossings

The active profiles are `wallininkatu-v3.json`, `porkkalankatu-v3.json`
and `lansilinkki-v1.json`. Earlier profiles are diagnostic history. These are
authored approximations of missing upper decks, constrained by municipal street
polygons, actual native bank sections, and retained lower collision floors.
Their elevations are not inferred from photographs. They are not survey models.

The shared source authorities are the sibling `osm-public-v3.json` and
`street-parts-public-v1.geojson`; each profile pins their bytes. Its working
frame comes from the recorded OSM nodes, in the existing EPSG:3879/N2000 origin.
Full-width bank witnesses include the exact source collider and triangle.
Porkkalankatu and Länsilinkki also pin bounded source-buffer bank files: these
retain the actual 2021 quantized-terrain samples and municipal classifications
needed outside the runtime raster. They do not extend the playable rectangle
or supply clamped raster heights.

Appearance references in the profiles were viewed in Google Street View.
Porkkalankatu uses a shallow concrete/girder slab, picket barriers and slim
brown columns on individually qualified parking footprints. Wallininkatu uses
the observed concrete deck, mesh/crash barriers and an angled concrete pier on
the real separator. Länsilinkki uses opaque and framed transparent noise
barriers; its upper mapped carriageways remain closed to pedestrians. No Street
View image pixels are redistributed.

## Reproduction order

Run the tools from the export checkout. Supply an immutable world directory,
its literal manifest SHA-256, a fresh output directory and release identifier.
`apply_delivery_extra_bridge.ts --apply` rechecks the actual input banks and
lower floors before replacing only source-owned upper-bank fragments. It
preserves source buildings, images, encoded BIN prefixes and unrelated lower
floors. Its public gzip receipt records all changed cells, full road-triangle
masks, collision references, and outside-mask terrain bit preservation.

Wallininkatu then needs `apply_delivery_extra_bridge_earth.ts` with
`wall-earth-source-v1.json`. The original explicit Silta exclusions had also
removed real bank fallback terrain. This file contains a bounded replay of the
same frozen producer and raw terrain, changing only the ten named Wallininkatu
Silta exclusion records. The repair recovers only missing source terrain inside
those exact outlines, subtracts retained native lower-floor footprints, and
joins their actual boundary planes. It appends the same soil geometry to near,
far and HCOL; it does not add an invented lower floor.

Porkkalankatu then needs `apply_delivery_extra_bridge_stairs.ts` with
`porkkalankatu-stair-source-v2.json`. Municipal stair48004 connects reconstructed
upper landing48003 to literal lower landing48002. The original terrain-median
stairs rose in the opposite direction after the upper deck was repaired. The
new three treads use the complete actual landing-edge profiles, with risers
bounded to 0.18m. The five-vertex municipal outline and every native edge knot
are retained. Only individually pinned old stair/join triangle identities may
be removed; their original registered flight is independently checked. The
source report hash identifies the original registration, not a photographic
height or step count. Near, far and HCOL receive the same Float32 geometry.

Native/browser acceptance is a separate gate from producing these files. Test
both upper and genuine lower public routes in both directions, including bank
joins and the Porkkalankatu stairs, and inspect actual Standard/Low views of
the whole bank context. OSM134193334's centreline cuts across retaining-wall
polygon498687; the physical walking fixture follows the adjacent actual public
48355/48003 landing instead. Do not invent pavement on the wall. New vehicle
graph enablement requires the final native common road masks and collision
proof; profile status alone is not authority to enable a bridge.
