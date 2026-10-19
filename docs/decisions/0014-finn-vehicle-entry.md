# Finn entering and sitting in the car

Status: implemented and verified locally, 2026-10-17. See
[the benchmark and limitations](../benchmarks/finn-vehicle-entry.md). The clips, exit and camera
are superseded by [decision 0018](0018-finn-car-motion-and-passenger-exit.md).

The old interaction walked toward the driver door for 48 ticks and then hid Finn,
even if he had not reached it. Both doors opened together. The target stood in the
door's sweep: actual door triangles passed within 8 mm of its body centreline.
Simply showing the old `drive` animation would put his hair 12 cm through the roof
liner and soles 24 cm beneath the cabin floor.

The replacement uses the `motion-design` workflow against the accepted native
Finn skeleton and the actual Lumi GT cabin. Patrol uses the same cabin geometry.
Existing skin, face, gaits and world payloads remain the source of truth.

1. Reserve and brake a stopped car. Collision-walk around the car to a staging
   point behind the door sweep; cancel a blocked approach instead of boarding on
   a timer.
2. Run a 3.2-second, non-looping authored interaction: reach, open the driver door,
   duck through the aperture, lower onto the cushion, bring both legs inside,
   and close the door. Door and character share the simulation clock.
3. Keep the driver visible, with wrists at the wheel, soles above the cabin floor
   and hair beneath the roof liner. The vehicle owns his world transform; the
   authored motion only poses his native skeleton inside that frame.
4. Brake before exit. Reverse the entry path when the driver-side clearance is
   available, then restore the supported character capsule. Cancellation, death
   and recovery release the reserved seat and restore the existing safety rules.

Car-local coordinates are metres, +X driver side, +Y up, +Z forward. Measured
driver hinge is `[0.82861,0.67673,0.58263]`, opening −65 degrees about Y. Initial
staging is `[1.55,0,-0.95]`; wheel hub `[0.36098,0.92146,0.13336]`; cabin floor near
pedals Y≈0.325; roof liner over the seat Y≈1.378. These are geometric references,
not a substitute for inspecting the animated skin.

Evidence goes in `data/evidence/car-entry-20261017/`. Acceptance requires native
rig inspection, skinned contact/clearance measurements, opened contact sheets and
browser frames, real keyboard entry/drive/exit, lifecycle tests, and deterministic
replay. A generated clip or passing numerical probe alone is insufficient.
