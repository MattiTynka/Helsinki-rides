# 0009 Facade damage and remaining stair junctions

Date: 2026-10-17. The owner supplied new close views after release
`senate-20261017-4090689c`: a tall opening beside the Cathedral's west stair pier and
patchwork over the University's windows and pilasters. These are real defects. The
earlier downward support and selected-view checks did not cover this side opening.

## Investigation and reference

The side opening reproduces on the shipped compressed geometry and in the running
game, next to the ninth/tenth tread intervals. Horizontal and oblique rays expose it;
downward height probes do not. The stair footprint and retaining-wall cut overlap,
so the surrounding-ground edge used to close the stair cheek is missing there. The
same junction also needs inspection for overlapping, folded terrain triangles.

The surveyed stair edge lies only 8.6–43.3 mm from the OSM wall. The wall cut and
the ground-to-stair join previously disagreed over who owned that strip. The repair
uses the surveyed boundary for the authored cheek, suppresses the overlapping
secondary wall face and resolves connected caps. Actual neighboring mesh edges,
rather than a different terrain resample, close exposed raised-surface boundaries.
Raw geographic inputs remain unchanged. The intended landing passage remains open.

Native traversal exposed an excessive final landing lip after the first junction
repair. A strip no deeper than one tread now blends that lip into the existing
platform, keeping its rise within one normal riser and its grade within the
existing controller limit. Closing both width ends of this strip removes the
resulting side seams. Further oblique inspection found two approximately 10 mm
slits below finite wall-end caps. Bounded vertical return faces now join the
actual cut edges. Every nonvertical physical triangle is identical to the preceding
candidate at Float32 precision, so this final closure cannot change tread or
landing support. The two inner ends and the 2.7669 m access opening remain intact.

The University's northeast corner is on texture page 44. The earlier broad
painted-tree erase replaced intact architectural details with mismatched plaster.
The untouched city master retains the upper windows, pilasters and cornice bands.
The unpublished replacement erase also has unsafe broad growth and smoothing, so it
must not be accepted simply because it is newer.

Google Street View was inspected by eye on this pass:

- [27 Unioninkatu, August 2024](https://www.google.com/maps/@60.1699191,24.9509267,3a,75y,240.11h,102.34t/data=!3m4!1e1!3m2!1s4e7P1Zj-dNkLG2hpkLig0g!2e0): the University corner has white pilasters spanning the upper storeys, rectangular upper windows, lunettes above the main windows, continuous horizontal bands and a rusticated ground floor. The trees stand across Yliopistonkatu in the Library plot.
- [36 Unioninkatu, August 2024](https://www.google.com/maps/@60.1704548,24.9508348,3a,75y,253.61h,90t/data=!3m4!1e1!3m2!1sE_3IKXGrI8VCs6b6xq-ceQ!2e0): the National Library has a distinct frontage of Corinthian columns and two ranks of rectangular windows.
- [7 Hallituskatu, August 2022](https://www.google.com/maps/@60.1698433,24.9516312,3a,75y,5h,90t/data=!3m4!1e1!3m2!1svvYXyWdjlzkXet_RoWVL6Q!2e0): the Cathedral's west steps abut a solid vertical granite wall and pier, without the game's opening or folded triangular projection.

These views are visual references only. Google imagery, sampled colours and geometry
are not build inputs. Facades continue to derive from the licensed Helsinki LoD2
masters; the removed 2017 mesh stays removed.

## Repair contract

Close the actual wall-cut/stair junction and remove overlapping surface ownership.
Preserve genuine access openings, real tread support and the existing ground seam
precision. A regression must fail on the old geometry and test both normal and
oblique directions with the exported material's culling behavior.

Rebuild damaged facade images from untouched masters. Any local removal must have
an intact donor from the same architectural chart and preserve window alignment;
uncertain replacement must not smear or erase architecture. Repack textures without
changing existing UVs, building geometry or unrelated assets. Record retained source
occlusions honestly.

For the reported University elevation, the same source page contains a matching
five-bay opposite wing. A source-hash-bound quad reprojection reconstructs the lower
59%, matching window/plaster illumination anchors and retaining the upper 41%
before the existing grade and compression. This restores coherent architecture
where the original photo itself contains a large tree crown. It is a reconstruction;
the donor's baked cast shadows can differ. Other uncertain regions retain source
photographs instead of destructive fills. Both the normal builder and texture-only
repair use this policy.

A conservative automatic donor search was tested but still proposed a 97-texel
copy on page 41 at a window/pilaster boundary with no clear foliage. That ambiguous
change was rejected. The production path restores source photographs and applies
only the reviewed, source-bound University reconstruction; automatic removal stays
an offline calibration experiment.

Verification must include the owner's side view, the University corner, affected
facade survey views, stair traversal, compressed payload integrity, native runtime
budgets and the release journey. The previous release remains available for direct
comparison. Use one local server on strict port 5317.

Implemented and activated as `senate-20261017-605a392e`. The final exported geometry,
matching runtime views, 50 ground checks, both performance presets and ten gameplay
journeys with matching replays pass. The ordinary build was restarted and its
default URL verified. See the [verification record](../benchmarks/facade-and-stair-junction-repair.md)
for source identity, retained failed candidates, the automated test-driver repair,
opened captures and limits. The completed plan and baseline payload hashes are in
`data/work/facade-junction-20261017/plan.json` and
`data/evidence/facade-junction-20261017/baseline.json`.
