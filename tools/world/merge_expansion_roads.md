# Source-qualified expansion roads

`merge_expansion_roads.ts` preserves the accepted native graph and appends explicitly selected native lane/connector identities. Shared OSM nodes, way direction/access/level, restrictions, source carriageway polygons, serialized road collision and directed outward/return connectivity are checked. Coordinate proximity alone cannot authorize a join. Fresh records sharing an accepted ID require exact before/after conflict witnesses; these preserve the accepted record.

The qualification job binds the accepted manifest, candidate roads, OSM snapshot, street parts, native cell index, qualified supported-area document and selection. Use the exact native-plus-coarse index consumed by delivery preparation. Final receipts bind every used collision payload, the mask and merged road bytes. They remain pending final frontier collision and real runtime travel.

```powershell
node tools/world/merge_expansion_roads.ts --plan QUALIFICATION_JOB.json --out FRESH_RESULT
```

The accepted gameplay definitions supply every usable vehicle's body, skid and tyre dimensions. Each definition's actual projected hull includes 0.10m clearance; source and native collision samples keep the existing 0.2m height tolerance. The maximum symmetric envelope and nominal lane-width edge outliers are diagnostics. Float32 position/quaternion poses use the runtime continuous oriented transition guard, including connector endpoint rotations. These are upright zero-steer geometric proofs; actual driving, steering, pitch and roll remain runtime gates. Newly exposed accepted tails are enumerated, and the same runtime footprint guard separates certified admissible intervals from named closed boundary intervals.

Old road and footway heights may have been clamped outside the previous playable area. `project_expansion_roads.ts` can repair explicitly selected outside portions against a unique native road or hard-pavement level. It inserts exact original boundary-interpolation points and preserves the entire old inside piecewise geometry, IDs and metadata. Unsupported protected boundary heights fail; no nearest-level choice or height tolerance expansion is permitted. The receipt enumerates exact changed records. Append independently runs `assertOutsideOnlyRoadGraphRepair` and requires the final merge receipt as well as this pending projection receipt.

Near-coincident new straight connectors can contain reversing minimum cubic handles. The bounded repair requires the same explicit OSM node, aligned source tangents and an original span at most 0.05m. It trims only selected new lane source polylines by 0.10m, constructs forward cubic handles bounded by the new span, projects native heights and records complete before/after records. Accepted lane endpoints remain exact; every repaired connector still passes source, collision, supported-area and continuous vehicle sweep gates.

```powershell
node tools/world/project_expansion_roads.ts --plan PROJECTION_JOB.json --out FRESH_PROJECTION
node tools/world/diagnose_projected_roads.ts --plan PROJECTION_JOB.json --projection PROJECTION_RECEIPT.json --native-cells NATIVE_CELLS --supported-area QUALIFIED_AREA.json --out FRESH_DIAGNOSTIC
node tools/world/prepare_projected_road_merge.ts --plan PROJECTION_JOB.json --projection PROJECTION_RECEIPT.json --native-cells NATIVE_PLUS_COARSE_CELLS --supported-area QUALIFIED_AREA.json --out FRESH_MERGE_INPUT
```

For a limited playable milestone, `prepare_road_loop_supported_area.ts` forms the exact accepted area union the intersection of the qualified public mask and an explicit loop corridor. It never fills source holes or adds land. Every additional retained road exposed by this smaller mask still needs qualification. The broader city expansion remains pending until its own roads, walking routes and physical seams pass.

```powershell
node tools/world/prepare_road_loop_supported_area.ts --plan PROJECTION_JOB.json --projection PROJECTION_RECEIPT.json --public-area QUALIFIED_PUBLIC_AREA.json --half-width 5 --out FRESH_LOOP_MASK
node --test tools/world/test/expansion-road-merge.test.ts tools/world/test/road-outside-repair.test.ts tools/world/test/road-connector-repair.test.ts tools/world/test/expansion-footway-merge.test.ts
```

Walking selection adds public native footway/crossing records and audits every newly exposed retained footway. Foot access, source levels and exact shared OSM node connectivity are required. A closed accepted-to-new-to-accepted circuit must pass 0.38m capsule coverage and native hard-pavement support; this contains the player guard and the pedestrian proposal clearance. Cycleways without explicit pedestrian access are excluded.

`prepare_walk_corridor_supported_area.ts` intersects an explicit source-connected walking corridor with the qualified municipal mask. A real municipal partition sliver can be handled only by the separate `qualify_walk_surface_seam.ts` job: exact public-footway source segment, serialized native pavement intersection, bounded location/area, source-bound projected footway level and complete added polygon evidence. It cannot fill arbitrary holes. After any mask change, rerun projection and the complete road/walking merge.

```powershell
node tools/world/prepare_walk_corridor_supported_area.ts --plan WALKING_SOURCE_JOB.json --out FRESH_WALK_MASK
node tools/world/qualify_walk_surface_seam.ts --plan EXPLICIT_SOURCE_NATIVE_SEAM_JOB.json --out FRESH_SEAM_MASK
node tools/world/prepare_expansion_walk_plan.ts --walking-plan WALKING_SOURCE_JOB.json --road-merge FINAL_MERGE_RECEIPT.json --accepted-osm-ledger ACCEPTED_PUBLIC_OSM_LEDGER.json --out FRESH_WALK_PLAN.json
node tools/verify/verify-district-expansion.mjs --walk-only --plan FRESH_WALK_PLAN.json --release CANDIDATE_WORLD --runtime-sha256 REVIEW_JS_SHA --out FRESH_WALK_EVIDENCE
```

The travel-plan producer binds the accepted public OSM derivative to the accepted graph's original source hash, finds a public source-node approach from Senate Square, follows the exact qualified new circuit and returns without fixture teleportation. Plan generation and static capsule checks do not prove actual travel.
