# 0010 Reference-led facade reconstruction

Date: 2026-10-17. The owner reports photographed trees remaining on facades after
the destructive erasure was removed. The new screenshot is Topelia, Unioninkatu 38.
This is additional work after the accepted stair-junction repair in decision 0009.

## Working rule

Use the [facade cleanup protocol](../facade-cleanup-protocol.md) for the repeatable
reference, reconstruction, preservation, runtime review and activation procedure.

When a visible facade contains photographed foliage or another source occlusion,
identify the actual building and elevation, inspect the corresponding location in
Google Maps Street View, then reconstruct the obscured architecture. Record the
reference location, panorama date and observed details. Inspect a second angle
when the first view itself hides the relevant windows or entrance.

Google views provide visual reference only. Build inputs remain licensed city
masters, separately credited compatible photographs and original authored work;
do not copy Google imagery into textures.
Prefer intact, corresponding bays from the same building where the reference
confirms matching architecture. Preserve window count and centres, storey heights,
doors, corner details, plinths and cornices. Bind every source-specific mapping to
the source image hash, and keep a reproducible before/after record.

Do not erase foliage with a generic colour mask, blur, plaster-shaped patch or
unreviewed repetition. If a bay differs, reconstruct its actual architectural
pattern. Review the final compressed facade in the running game from close,
front-on and oblique views. Numerical texture checks do not establish appearance.

Trees belong in separate world instances at supported real locations. Check the
existing city tree register and published placements first; do not duplicate
trees or add them merely to conceal a bad facade. Where real trees are missing,
add separate instances with appropriate ground support and gameplay clearance.

The 2017 mesh remains removed. Facade work should preserve accepted ground,
collision, geometry and gameplay unless a separately identified defect requires
changing one of those surfaces. Verify preservation from actual exported payloads.

## Current implementation and verification

The active local release is `senate-20261017-cbd20b69`, reconstructed from
`data/work/facade-cleanup-20261017/cells-v3`. The named elevations passed 81 opened
runtime captures, source/geometry preservation checks, both native performance
presets, ten gameplay journeys with matching replays and the ordinary-build smoke.
See [the verification record](../benchmarks/reference-led-facade-reconstruction.md)
and `data/evidence/facade-cleanup-20261017/reference-notes.md` for actual layouts,
references and exact candidate identities.

Holy Trinity Church's east apse remains an explicit exception: its full window
and painted false-window arrangement could not be resolved from available
references. It retains its original source photography and service door. This
does not waive reference-led reconstruction for subsequent reported defects;
it records the precise unimplemented area without inventing hidden architecture.
