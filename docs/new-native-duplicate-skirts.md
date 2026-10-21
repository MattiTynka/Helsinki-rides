# Native foundation skirt overlap

`build_cells.ts` used terrain height minus burial depth as the skirt's lower
edge even when that height was above a native basement wall's bottom. The
resulting upward palette quad could lie on top of the intact facade and flicker
as a dark dotted strip. This is separate from facade texture reconstruction.

The builder now suppresses a render quad only when its entire area is covered
by the original source wall. Its original `skirtBottom` computation remains in
place before the render guard, so register-prism collision is unchanged.
Unproven, partly downward, noncoplanar or degenerate cases retain their existing
geometry. This guard does not claim to repair every possible native base issue.

For an existing delivery, use `plan_delivery_duplicate_skirts.ts` and
`apply_delivery_duplicate_skirts.ts` in a fresh directory. Both require the
actual manifest hash and the exact north/south source snapshots. The planner
enumerates all 1,230 new native buildings; accepted older building IDs are not
an authority for this repair. A selected quad must satisfy all of these checks:

- Its edge is an exact replay of the source wall-bottom edge predicate and
  deduplication in the builder.
- All four triangles match the generated two-sided quad recipe in an existing
  `_flat` node, with one constant palette texel and unique oriented keys.
- Its two raised vertices retain the literal source edge's X/Z coordinates.
- The original native wall triangles are still drawn in this exact tier.
- Exact Float32 coplanarity and rational polygon subtraction prove no positive
  part of the generated quad lies outside those original wall triangles.
- No selected triangle is itself an original native source triangle.

The writer replays the complete selection, then appends replacement index
accessors. Original BIN/accessor prefixes, positions, normals, UVs, images,
materials, node transforms, floors, collision, roads and scenery remain literal.
Its face multiset proof permits removal of only the selected generated
triangles, including their multiplicity and winding. Simplified distant
geometry is deliberately unchanged: a near recipe is not authority to guess
which coarse triangles should be removed.

Apply this before original or recovered facade charts in the final fresh world.
Recreate the plan against the actual post-road/post-tram input, rather than
reusing index ordinals from a diagnostic world. Validate every written GLB and
review affected wall bases in both Standard and Low at identical cameras.
Fixture captures establish appearance at the supplied camera; normal gameplay,
streaming, final startup and deployed Pages verification remain separate gates.
