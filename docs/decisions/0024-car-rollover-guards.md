# Car rollover guards

Date: 24 October 2026. Plan, harness and full measurements:
[vehicle stability plan](../vehicle-stability-plan-2026-10-24.md). Addresses the kerb-flip root cause in
[backlog item 8](../backlog-m2.md); keeps [decision 0002](0002-m0-m1-tuning.md)'s centre of mass.

## Problem

The owner reported that cars flip onto their roof too easily, and that a flipped car usually keeps rolling instead
of coming to rest on its roof. Some rolling on is expected when the spin energy is high; the complaint was about
ordinary driving.

## Cause

1. **Flat-ground cornering never rolls a car.** Full-lock step steers and handbrake turns stay within 2–3° of
   level. The centre of mass, tyres and chassis friction are not the problem.
2. **The raycast suspension meeting a surface edge-on.** Rapier's vehicle controller, like Bullet's, scales a
   wheel's spring by `1 / |normal · ray|` (clipped at 10) and applies it along the contact normal. On a kerb riser
   (normal Y = 0) that is a horizontal shove at road level. The suspension cap (2.5 g per wheel) limits the spring
   impulse but not the tyre grip, which uses the uncapped spring. One tick on the 12 cm riser of the test fixture
   reports a 62.8 kN spring against the 40.5 kN cap, and kicks the chassis by 4–5 rad/s. A straight 21 m/s run that
   drifts into the kerb at 2–3° ends on the roof.
3. **The same amplifier fires when a tumbling car's wheels graze the ground** at a steep ray angle. Together with
   an angular damping of only 0.5 s⁻¹, this is what keeps a flipped car rolling.

`wheelSuspensionForce` does report the uncapped spring in `@dimforge/rapier3d-deterministic-compat` 0.21.0 (the
plan's open question): on the unguarded code it reads 62.8 kN at the kerb and 92.6 kN at the ramp foot, both above
the cap it would otherwise be clamped to.

## Decision

All of it is in `packages/sim/src/vehicle.ts`; the constants are exported as `VEHICLE_STABILITY`.

| Constant | Value | Meaning |
| --- | --- | --- |
| `contactCos` | 0.5 | a wheel hit on a surface facing more than 60° away from the wheel ray is ignored for the tick |
| `tiltUp` | 0.5 | chassis up·Y below which the car counts as past 60° (equals `Vehicle.upright`'s threshold) |
| `invertedDamping` | 3 | angular damping, s⁻¹, while past 60° |
| `uprightDamping` | 0.5 | angular damping otherwise (the constructor's value) |
| `sideSettle` | 0.3 | metres by which rule D raises the centre of mass for gravity's tipping torque |
| `roofUp` | −0.7 | chassis up·Y below which the car counts as on its roof (equals the flipped exits' threshold) |

- **A. Wheel-contact filter (two-pass update).** Every tick each wheel's suspension cap is reset to
  `massKg × 9.81 × 2.5` and its friction slip set as before. After `updateVehicle`, each wheel in contact is
  inspected: if `-(contactNormal · chassisDown) < contactCos` the wheel is ignored (cap 0, slip 0); otherwise, if
  its reported spring exceeds the cap, its slip (including the handbrake's 0.45 factor) is scaled by
  `cap / spring`, so the tyre grips no harder than the load actually applied. If any wheel was marked, the chassis
  linear and angular velocities are restored and the update runs once more with those overrides; then the marked
  wheels' caps are restored. At most two controller updates per tick. The rerun sees the same state and rays, so it
  is deterministic in Node and the browser alike.
- **B. Inverted damping.** At the top of `Vehicle.step` the angular damping is `invertedDamping` while up·Y <
  `tiltUp`, else `uprightDamping`. It keys on orientation alone, in the air as on the ground: a car past 60° in
  flight is damped too, while a level car in the air, an ordinary jump, is untouched.
- **C. No wheel forces past 60°.** While up·Y < `tiltUp` there is one controller update with every wheel's cap and
  slip at 0 and no inspection. Past 60° the rays point sideways and could hit kerb tops, stairs or walls. The
  fixture has no such geometry, so C rests on reasoning, not measurement.
- **D. Side settle.** While `roofUp` < up·Y < `tiltUp` (past 60° and not yet on the roof), `Vehicle.step` adds the
  torque `sideSettle × massKg × 9.81 × (up × −Y)`. That is gravity's torque on a centre of mass `sideSettle` higher:
  it turns the up axis towards −Y, is largest with the car on its side and vanishes as the car reaches its roof.
  Below 60° and on the roof it adds nothing. It reads only the orientation, so like B it also acts on a car past 60°
  in the air and never on a level jump; it keeps no state and is deterministic.

Wheel contact flags, suspension lengths and wheel rotation still come from the final controller pass. `upright`,
`place()`, damage, recovery, the flipped exits and every caller are unchanged. No content, collision, asset or world
release change.

Why 60°: a 45° ramp face gives a facing of 0.71 and stays live; a kerb riser gives 0.00. Nothing in the city meant
to be driven is steeper than 60°. Stair risers become invisible to the rays while the treads stay live.

Why D: with rules A–C alone a car that has lost its spin can come to rest on its side. Rapier reads the
definition's centre of mass in the body box's frame, so it sits 1.33 m above the chassis origin, 2 cm inside the
roof-side edge of the side face. Lying on its side the car is therefore nearly balanced, and on 3° paving with the
roof uphill it stays there. A grid of 15 tumble releases on the Senate Square paving (x −4 to 4 m, z 8 to 16 m)
measured this. Rules A–C alone met "on the roof and still by 3 s, at most 0.6 turns" in 4 of 15 runs: 4 runs
stayed on their side for good, 2 ended on the wheels and 5 reached the roof only at 3.7–4.9 s. With D all 15 are on
the roof and still from 2.1–2.5 s after 0.32–0.39 turns; the unguarded code met 0 of 15 (1.35–1.89 turns). The same
grid of side landings is 15 of 15 with and without D (4 of 15 unguarded). `sideSettle` 0.1 m met 10 of 15 tumbles
and 0.5 m met 15 of 15; 0.3 m is the smallest value tried that meets all of them. D does not change the stairs
below: their flips are decided before the car passes 60°.

## Measurements

From `packages/sim/test/vehicle-stability.test.ts`, which prints each run's figures as test diagnostics. The fixture
is a flat world with a 12 cm kerb (riser at x = 10, pavement beyond), a 45° ramp 0.5 m high and a 20 × 40 m patch
of 3° paving. The definitions are
the content values for the Lumi GT, patrol car and Revontuli. Each car is driven with `Vehicle.step` and then the
physics step, as `Simulation.step` does. "Before" is the same test body run against `vehicle.ts` from 513c1f9, the
commit before this change. "Kick" is the largest change of angular velocity produced by one `Vehicle.step`; "reruns"
counts ticks with a second controller update.

Kerb, 21 m/s held, drifting into the kerb at 2°, 3° and 4°, or parallel with the wheels 3 cm from the riser and a
±0.05 steer wobble. Max tilt and kick before → after; every guarded run ends on its wheels at 20.7 m/s.

| Car | Drift 2° | Drift 3° | Drift 4° | Wobble 3 cm |
| --- | --- | --- | --- | --- |
| Lumi GT | 22.3°, 4.03 → 5.0°, 0.12 (2 reruns) | **roof**, 5.33 → 5.0°, 0.12 (1) | 13.4°, 1.41 → 5.0°, 0.12 (2) | **roof**, 2.30 → 8.2°, 0.22 (25) |
| Patrol car | 21.8°, 4.03 → 5.1°, 0.11 (2) | **roof**, 5.16 → 5.1°, 0.11 (1) | 8.0°, 1.10 → 5.0°, 0.12 (1) | **roof**, 5.03 → 5.4°, 0.11 (2) |
| Revontuli | **roof**, 1.94 → 4.8°, 0.13 (3) | 20.8°, 3.99 → 4.8°, 0.13 (2) | 7.7°, 1.36 → 4.7°, 0.13 (1) | 25.3°, 4.25 → 5.0°, 0.13 (2) |

Rollovers and handling, Lumi GT:

| Scenario | Before | After |
| --- | --- | --- |
| Released rolled 110° at 1.45 m, 8 rad/s roll, 15 m/s sideways | 1.20 turns, on the roof and still from 2.08 s | **0.19 turns**, on the roof and still from 2.08 s |
| Tumble from 1 m: roll 12, pitch 3, yaw 2 rad/s, 14 m/s sideways | 1.33 turns, off its roof at 10 s | **0.42 turns**, on the roof for good from 0.87 s |
| Laid still on its side across the 3° paving, roof uphill | on its side for all 8 s | **on the roof and still from 1.12 s** |
| Dropped on its roof at 1.5 m, 9 rad/s roll, 12 m/s slide | stays on the roof, still from 1.72 s | stays on the roof, still from 1.67 s |
| Full-lock step steer at 22 m/s / handbrake turn at 25 m/s | 2.1° / 2.7° | 2.1° / 2.7°, no reruns |
| 45° ramp at 12 m/s, peak chassis origin height (rests at 0.008 m) | 1.937 m | 1.937 m (7 reruns: 4 from the load cap as the front wheels meet the face, 3 from the facing filter as the pitched car crests) |

"On the roof and still" means a 30-tick window with up·Y < −0.7, |v| < 0.5 m/s and |ω| < 0.5 rad/s on every
tick. The kerb run at 3° repeated from a fresh world gives bit-identical position and rotation after 600 ticks.
These match the plan's harness figures (5–8°, kicks up to 0.22 rad/s, 1–25 reruns, 0.19 turns), which were taken
with rules A–C applied from outside the class. Without rule D the side release on the 3° paving stays on its side,
and the landing and tumble rows read 2.00 s and 0.88 s. The test also checks on every tick that no torque is added
below 60° or on the roof, so D leaves the kerb, cornering and ramp runs untouched.

Crashes above roughly 12 rad/s with 15 m/s of sideways speed still roll once more before resting (plan, harness).
That is the intended "high spin energy" behaviour and not an acceptance target.

## Rejected

From the plan's measurements:

- **Lower centre of mass (0.38 → 0.30 m):** the 3° kerb run still ends on the roof after a 7.2 rad/s kick, the side
  landing still rolls 1.21 turns, and the car can then rest on its side, which the flipped exits have no clip for.
- **Softer tyres (friction slip 3.2 → 2.0):** kerb kicks stay at 3.9–4.1 rad/s and the handling changes.
- **Chassis friction 0.8 or 0.2:** no effect on the kerb; 0.2 leaves the car on its side.
- **Damping while tilted or airborne:** the same settling, but it changes jumps (21 m/s ramp flight 5.1 → 3.9 m).
- **Casting the wheel rays before the update:** it gives the same normals, but it cannot see the controller's
  spring force, so it would lose the landing rule.
- **Bullet-style roll influence, emulated from outside the controller:** the side-impulse getter cannot be
  inverted reliably, the emulation destabilised the car, and flat cornering has nothing for it to fix.
- **Bevelled kerb risers in the collision mesh:** it needs a world release and does not cover landings or stairs.
- **The 2026-10-16 draft in backlog item 8 (ignore hits whose normal Y is below 0.6):** it tests the world's up
  axis, not the wheel ray. Rule A measures the facing against the ray, so it also catches the grazing landings of
  a tilted car.

## Reproduce

- `node --test packages/sim/test/vehicle-stability.test.ts`: the assertions and, as diagnostics, every figure in
  the tables above.
- Local aid, not part of the source distribution: the plan's harness `build/vehicle-stability-2026-10-24/veh-stab.ts`
  (gitignored) runs the same fixture with each candidate fix applied from outside the class, including the
  rejected ones.

## Residual risks

- A car past 60° settles instead of barrel-rolling. That is the request.
- A car can still come to rest on its side where the ground holds it there against rule D: on paving steeper than
  about 15° with the roof uphill (on the fixture patch it tips over at 14° and stays at 18°), or propped against a
  wall or kerb face.
- Hard landings grip a little less for a tick, because friction now follows the capped load. The ramp test guards
  jump height.
- Surfaces steeper than 60° no longer support wheels.
- **Cathedral stairs, accepted by the owner (not met).** The plan's stair runs on Senate Square at x = −3 (three
  cars, up and down at 5 and 10 m/s) leave the car off its wheels in 6 of 12 runs against 4 of 12 unguarded. Over
  six nearby lateral offsets it is 21 of 72 against 20 of 72, and the 10 m/s climbs over all seven spawns flip 6 of
  21 against 3 of 21. The guarded car now climbs the stairs at 5 and 10 m/s, where the unguarded one stops at the
  bottom. The cause is that the 12 cm riser before the stairs no longer slows the car (rule A ignores its face; the
  unguarded car loses 9.8 → 9.4 m/s there), and the body box's crash into the first steps is chaotic: at x = −3 it
  leaves 2.83 rad/s of roll against 1.38 unguarded. The owner accepted this on 24 October 2026; there is no stair
  rule and no constant is tuned for it.
- A police ram that strikes the body box above the centre of mass can still roll a car through the contact itself.
  That is ordinary rigid-body behaviour and out of scope.
- Old input recordings replay to different hashes. No test pins a physics hash.
- Real-world evidence is gathered by the release run, not by this record. That covers the Snellmaninkatu kerb lines,
  the ten-seed pursuit probe, the recorded kerb-flip replay and browser/Node replay parity.
