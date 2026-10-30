# Qualified world coverage

New worlds may include `gameplay.supportedArea` alongside the rectangular
`playArea`. The rectangle remains the coarse extent; the optional mask identifies
qualified land and crossings. Worlds without the field retain their old behavior.

The native schema is `{schemaVersion:1, regions:[{id, outer, holes?}]}`. Each ring is
an array of runtime `[x,z]` metre coordinates, implicitly closed without repeating
the first point. Components must be disjoint; merge touching/overlapping inputs
before export. Hole interiors must lie inside their component and remain disjoint. Exact
point-only contacts between holes, or between a hole and its outer boundary, are
allowed; those points remain excluded. Shared nonzero edges, proper crossings,
nesting and positive interior overlaps are rejected, including overlaps whose
contacts occur only at vertices. Validation uses filtered exact-sign topology
with a local dyadic fallback, retaining true tiny edges and holes without snapping
or filling coordinates. Nonfinite coordinates, actual zero-length edges, zero-area
or self-crossing rings, and points outside `playArea` are rejected. Limits are
128 components, 512 holes per component and 4,096 vertices total; gameplay byte
limits remain unchanged. No mask is inferred from an enlarged cell rectangle.

The expansion mask must retain the accepted world's existing mask, or its previous
`playArea` when it has none, plus source-qualified new land/crossings. This change
does not retrofit new exclusions into the accepted city. Source provenance,
qualification and exact accepted-world preservation belong to the append receipt.

`containsSupportedArea` checks point and clearance radius; `supportsSegment` checks
the complete swept segment. Safe endpoints on opposite sides of a canal therefore
do not establish a supported route. A cached median-split boundary-edge index and bounded cache of 128 m interior
squares avoid repeatedly examining unrelated boundaries. Index storage and depth
are bounded by the global vertex count, including very long edges; exact existing
runtime intersection/distance predicates and their clearance epsilon are unchanged.
The caches are tied to the immutable mask object.

Characters, including jumps/climbs and civilians/officers, constrain horizontal
motion to its supported prefix. Cars constrain the complete swept conservative
footprint after the physics step and stop horizontal/angular velocity at the local edge.
The footprint projects the actual quaternion-oriented body and skid boxes plus
steered tyre bounding boxes, including unsteered physical sidewalls and the full
suspension interval, with 10 cm clearance. Roll and pitch therefore contribute
their actual projected extents. An orientation-independent circle is only a search
bound; it cannot reject a fitting upright car on a narrow road. Convex-interior
checks also reject holes wholly enclosed by a car, which edge-only tests miss.

Each movement interval uses linear translation/steering and shortest quaternion
rotation. Its endpoint convex hull is expanded by the conservative curvature bound
`R * (bodyAngle + steeringAngle)^2 / 8`; every point on the continuous path lies
inside that volume. Adaptive subdivision reduces excess bounds, and only a
certified interval is admitted. A blocked movement clips both position and rotation,
with explicit Float32 rounding slack to avoid repeated recovery at an edge. Gravity and
ordinary collision/height/road-layer checks remain active. The mask cannot certify
that terrain, a bridge deck or a road connection exists.

Recovery and local vehicle admission use the same oriented footprint, including the
Float32 pose that physics will receive. Existing native support rays, their wider
corner probes and body/skid overlap checks remain required. Pedestrian ground probes, vehicle entry/exit
routes and police exits respect the mask. Drop-ins outside it are refused; the HUD
omits those addresses and clips map features to qualified coverage. Boundary
recovery remains a fallback for an invalid externally relocated actor, while normal
travel stops locally without a repeated recovery teleport.

Synthetic regressions exercise a one-metre canal with a full collider underneath,
safe endpoints on opposite banks, fast car travel, pedestrian admission, drop-ins,
recovery and repeated movement at the edge. Native source tests still cover legacy
world behavior. Actual coastlines, routes, map appearance and performance require
candidate-bound browser checks after the source-qualified expansion mask is built.

Municipal surface unions are candidate source footprints, not final navigation
acceptance. A capsule radius can make a millimetre source gap obstruct movement.
Any join across such a gap requires explicit native-ground and physical
qualification; an area threshold alone must never remove holes or join canals,
private areas or unsupported crossings.
