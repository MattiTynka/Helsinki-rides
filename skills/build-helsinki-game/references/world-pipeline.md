# Helsinki world pipeline

## Sources and provenance

Official [Helsinki 3D](https://www.hel.fi/en/decision-making/information-on-helsinki/maps-and-geospatial-data/helsinki-3d) describes an OBJ mesh, ETRS-GK25/N2000 and CC BY 4.0, and explains its aerial-photo artifacts. The [open geographic data page](https://www.hel.fi/en/decision-making/information-on-helsinki/maps-and-geospatial-data/make-better-use-of-geospatial-data/open-geographic-data) identifies EPSG:3879 and N2000 and links the WFS. These were checked on 2026-10-15. Recheck the selected dataset's own metadata and license at acquisition; a general city page does not establish every file's vintage or axis order.

Use [mesh archives](https://3d.hel.ninja/data/mesh/) or the official download selector for bounded offline acquisition. Record actual vintage, source URL, bounding region, horizontal CRS, vertical datum, axis order, units, download date, input SHA-256, license and required credit. Version a source ledger, conversion parameters and output hashes. Serve processed game content; do not make players bulk-fetch city WFS or public map tiles.

For terrain, verify [NLS Elevation Model 2 m](https://www.maanmittauslaitos.fi/en/maps-and-spatial-data/datasets-and-interfaces/product-descriptions/elevation-model-2-m) metadata. A DEM in EPSG:3067 must be reprojected into the project CRS before joining city data. For OSM roads, verify [OSM licensing](https://www.openstreetmap.org/copyright), extract date, completeness and attribution. Store geometry and license provenance separately from original gameplay code. Do not assume a centerline includes authoritative lanes, turns, traffic-light phases or heights. Verify road-service availability at implementation time instead of inheriting an old Digiroad endpoint.

## Coordinate contract: never import huge coordinates first

1. Choose one projected project CRS, default EPSG:3879, and one N2000 height origin. Record `E0,N0,H0` from verified data. Do not guess an origin from this document.
2. Reproject differing horizontal CRSs with a reviewed GIS tool such as GDAL/PROJ using explicit input and output CRS and axis order. Confirm vertical datums separately; an XY transform is not a geoid/height conversion. WGS84 longitude/latitude are angular, not metres. Use known landmarks to detect axis swaps.
3. Parse coordinates as float64 and subtract the origin before constructing Blender meshes, typed float32 arrays, Rapier bodies or compressed geometry. Importing global coordinates into float32 and translating afterwards cannot restore lost precision.
4. For Blender world geometry use `(E-E0, N-N0, H-H0)`. Configure the OBJ importer to preserve this numeric ENU convention; OBJ has no reliable universal axis metadata. Check the installed operator settings.
5. Let the verified glTF Y-up export map it to `(E-E0, H-H0, -(N-N0))`. Do not rotate it again in Three.js. A standalone character with +Z forward faces south at world yaw zero; the entity transform supplies heading.
6. Import an asymmetric marker with labelled east, north and up arms, a 1 m cube and three surveyed control points. Check distance, handedness, heights and north in the actual game before batching.

The bundled localizer only performs step 3 and keeps ENU axes. Example with synthetic numbers, **not a surveyed Senate Square origin**:

```bash
python SKILL_ROOT/scripts/localize_obj.py --input SOURCE/tile.obj --output WORK/tile-local.obj --report WORK/tile-local.json --crs EPSG:3879 --origin 25496000 6673000 0 --max-distance 2000
```

Input must already be confirmed E,N,H metres in the stated CRS/N2000. The output/report must be new paths. It preserves normals, UVs, faces, groups and material directives and checks finite vertices; it does not validate their topology. Audit MTL paths and stage their textures with the same relative layout beside the output before Blender import. Geometry-only inspection is possible without claiming textured completeness. EPSG:3067 input is supported for isolated preprocessing, but must be reprojected before integration into the default EPSG:3879 world.

## Build four representations

| Representation | Preparation | Runtime purpose |
| --- | --- | --- |
| Visual | Clip, remove baked vehicles from playable corridors, repair near-field facades, LOD, UV/texture bake, mesh/texture compression | Recognizable appearance |
| Collision | Smooth drivable surfaces, curbs and simplified walls; watertight coverage where gameplay requires it | Stable character and vehicle physics |
| Pedestrian nav | Bake walkable collision-derived surfaces; annotate stairs, crossings and links | Routes with valid clearance |
| Vehicle graph | Directed lane approximations with turn connectors, junction priority, stop lines, speed hints and vertical level | Traffic and police route planning |

Do not infer roads by walking triangle adjacency across photogrammetry. Do not let nav meshes bridge water or connect stacked roads because XY matches. Bridges need authored elevations and underpass clearance. Photogrammetric parked cars are static lumps: remove/cover them in playable streets before spawning dynamic replacements. Keep landmarks recognizable; hand-author interiors only when missions require them. Census collision outputs numerically (no loose, wire or degenerate geometry, consistent winding, declared shell count) before any visual check; see [Blender workflow](blender-workflow.md).

## Tile contract

Trial 128 m tiles; switch to 256 m only on measured request/CPU/overdraw evidence. Runtime bounds use XZ. `floor(x/tileSize), floor(z/tileSize)` handles negative coordinates correctly. Use half-open ownership of semantic objects to avoid duplicate spawns. A visual border may overlap; do not duplicate collision faces at a shared seam.

Each tile has stable ID, XZ bounds, source IDs, visual LODs and separate collision/nav/roads payloads. Every payload has a relative path, byte size and SHA-256. `assets/world-manifest.template.json` is deliberately incomplete. The validator requires a uniform grid anchored at runtime (0,0); document a schema change if another layout is needed.

```bash
python SKILL_ROOT/scripts/validate_world.py --manifest BUILD/world.json --root BUILD
```

Pack sources outside the web runtime. Content hashes in URLs plus a manifest revision prevent code/asset cache mismatches. Keep uncompressed editable sources and conversion parameters for rebuilds. Run full glTF validation and runtime decoding separately; the manifest helper proves only structure and byte integrity.

## Streaming behavior

States: absent → requested → decoded → collision-ready → active → retiring. Jobs carry tile ID and generation token so cancelled/stale results cannot activate old content. Budget fetch, decode, GPU upload and collider creation separately; use workers where measured beneficial and cap work per frame. Share compressed textures/materials deliberately and reference-count them.

Prioritize player occupancy and predicted motion. The collision-ready envelope must exceed travel during worst-case fetch/decode/activation latency plus braking distance and margin. Compute it from measured latency and maximum permitted speed; a fixed '3×3 tiles' promise is insufficient. Pin current contacts, nearby active vehicles and the mission area until safe retirement. Never unload a collider under an actor. If data is late, constrain movement at a covered boundary and show loading recovery; do not let the player fall into missing space.

Test seam crossing on foot and at maximum car speed, sharp U-turns, rapid teleport only as a fixture, cancellation, retry/404, background-tab resume and unload/reload. Check terrain height/normal continuity and collider/nav/road connections independently. Preserve sparse NPC/mission state by stable ID without keeping every mesh loaded.
