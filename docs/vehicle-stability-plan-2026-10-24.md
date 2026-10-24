# Car stability: kerb kicks, inverted damping and a rollover harness

Date: 24 October 2026. Status: implementation plan, not yet started. Base: `main` at `295a74e`
(the weak-GPU pass). The decision record for the implemented change will be `0024`.

The owner's request: cars flip onto their roof too easily, and after a flip they usually keep
rolling instead of coming to rest on the roof. Some rolling on is expected when the spin energy is
high; the complaint is about ordinary driving. This note records what was measured, why the cars
behave as they do, the change that fixes it, how to test it and how to ship it.

## Summary

Three findings from a headless Node harness built on the unmodified `packages/sim` (details and
numbers in "What was measured"):

1. **Flat-ground cornering never rolls a car.** Full-lock step steers at 15, 22 and 30 m/s, flicks,
   and handbrake turns at 25 m/s stay within 2–3° of level on every car. The static stability factor
   (half track / centre-of-mass height) is 2.16 for the Lumi GT and patrol car and 2.12 for the
   Revontuli; a real car is 1.2–1.5. Lowering the centre of mass, softening the tyres or changing
   the chassis friction is not where the problem is.
2. **Flips come from the raycast suspension meeting a surface edge-on.** When a wheel ray lands on
   a kerb riser (normal·up = 0) Rapier's vehicle controller, like Bullet's, multiplies the spring by
   `1 / max(0.1, |normal · ray|)` and lets the tyre friction use that uncapped spring force. One tick
   on a 12 cm riser produced a 62–68 kN spring (cap 40.5 kN) and a 3.4–3.6 kN·s side impulse at
   road level: a 2–5 rad/s roll rate from a single tick, which is enough to put the car on its roof
   from a straight 21 m/s run that drifts into the kerb at 2–3°. The same amplification fires when
   the wheels of a tumbling car graze the ground at a steep ray angle, which is what keeps a flipped
   car rolling (6.5 rad/s kick measured on a side landing).
3. **A car that lands flat on its roof stays there**, even with 12 rad/s of roll and a 12 m/s slide:
   the roof-edge impact takes 84 % of the spin because the inertia about the roof edge is six times
   the roll inertia. Cars roll on only when they arrive tilted with sideways speed, and then the
   wheel-ray kicks above add energy. A car on its side cannot rest there (the centre of mass sits
   3 cm inside the skid box's bottom edge) and tips onto its roof within two seconds; that is fine
   and keeps the existing flipped exits valid.

The change is confined to `packages/sim/src/vehicle.ts` (no content, world, collision-mesh or
asset change, so it ships with the game shell like the weak-GPU pass):

- **A.** Ignore, for the tick, any wheel hit whose surface faces more than 60° away from the wheel
  ray, and cap the tyre friction at the capped suspension load. Implemented as a two-pass
  `updateVehicle`: run, inspect the wheel hits, and on the rare offending tick restore the chassis
  velocities and rerun with those wheels' forces zeroed or scaled.
- **B.** Angular damping 3 s⁻¹ (instead of 0.5) while the chassis is tilted past 60°; upright and
  airborne behaviour unchanged.
- **C.** No wheel forces at all while the chassis is past 60° (the wheel rays point sideways then
  and can hit kerb tops and walls).

Measured effect on the harness: every kerb case drops from a 2–5 rad/s kick and a roof landing to a
5–8° bump; side landings at 8 rad/s with 10–15 m/s of sideways speed come to rest on the roof after
0.19 of a turn instead of rolling a full turn; the 12 rad/s tumble ends on the roof instead of on its
side; flat handling and the 45° ramp hop are unchanged. Cases above roughly 12 rad/s with 15 m/s
sideways still roll once more before resting, which matches the owner's expectation that high spin
energy rolls on.

## What was measured

### Harness

`build/vehicle-stability-2026-10-24/veh-stab.ts` (kept outside the source tree; results in
`veh-stab2-lumi.txt` and `veh-stab2-revontuli.txt` beside it). It imports the unmodified sim by
file URL, builds a flat 400 × 400 m world with one 12 cm kerb (riser at x = 10, pavement for
x > 10) and one 45° ramp 0.5 m high (x −60 … −50, z 50 … 200), spawns a `Vehicle` from the
content definition, drives it with a speed-holding throttle, and steps `Vehicle.step` plus
`world.physics.step()` at 60 Hz, exactly as `Simulation.step` does. Candidate fixes are applied
from outside through the controller and body API, so the measurements are of the shipped code. Per
run it records the largest tilt from vertical, the largest roll rate about the car's long axis, the
net roll turns, the largest one-tick angular-velocity change produced by `Vehicle.step` alone
("kick"), the number of ticks a fix intervened, when the car came to rest and the final pose
(wheels, side, roof). It runs in about two seconds per car on one thread.

### Baseline (Lumi GT; the patrol car shares its geometry, Revontuli figures in brackets)

| Scenario | Result |
| --- | --- |
| Step steer to full lock at 15 / 22 / 30 m/s, flick at 22 / 30 m/s, handbrake turn at 25 m/s | tilt 2–3°, no flip (same) |
| 21 m/s straight, drifting into the 12 cm kerb at 2° | one-tick kick 4.03 rad/s, tilt 22°, recovers (roof after 0.48 turns) |
| same at 3° | kick 5.33 rad/s, thrown 1.8 m up, **roof**, rest after 5.8 s (tilt 21°, kick 3.99) |
| same at 4° | kick 1.41 rad/s, tilt 13° (tilt 8°) |
| 21 m/s parallel to the kerb, wheels 3 cm from the riser, ±0.05 steer wobble | kick 2.30 rad/s, thrown 2.2 m up, **roof** after 0.51 turns (tilt 25°, kick 4.25) |
| Sideways slide into the kerb at 10 and 18 m/s, level car | tilt 3–5°, rides over the kerb (same) |
| Arrives rolled 110° with 5 rad/s and 15 m/s sideways | roof after 0.19 turns, rest 2.1 s |
| Rolled 110°, 8 rad/s, 10 m/s sideways | rolls on 0.69 turns, back on its wheels, still moving; kick 2.46 rad/s from the wheel rays landing |
| Rolled 110°, 8 rad/s, 15 m/s sideways | rolls a full 1.19 turns, kick **6.54 rad/s** from the wheel rays landing (spring 55–66 kN, side 2.9–3.3 kN·s) |
| Rolled 110°, 12 rad/s, 15 m/s sideways | 1.45 turns, thrown 4.6 m up, ends on its **side** |
| Tumble from 1 m: roll 8, pitch 3, yaw 2 rad/s, 8 m/s sideways | roof after 0.42 turns, rest 2.0 s |
| Tumble: roll 12, 14 m/s sideways | 1.33 turns, ends on its **side** |
| Dropped flat on the roof with 9 or 12 rad/s, 0 or 12 m/s slide | stays on the roof, rest within 1.8 s |
| Released on its side | tips onto the roof in about 2 s (both sides) |
| 45° ramp at 12 m/s / 21 m/s | 51° pitch, 1.94 m hop / 5.1 m flight, lands on the roof |

The kick signature is always the same: the offending wheel reports a contact normal with y = 0.00
(kerb) or a spring force far above the 2.5 g cap (landing), and a side impulse equal to
`frictionSlip × uncappedSpring × dt` (3.2 × 68 019 N / 60 = 3 628 N·s, as logged). This confirms
the root cause recorded in `docs/backlog-m2.md` item 8 on 2026-10-16 and extends it to landings.

### Candidate fixes

| Fix | Kerb 2° / 3° / wobble | Side landing 8 rad/s, 15 m/s | Tumble 12 rad/s | Flat / ramp |
| --- | --- | --- | --- | --- |
| baseline | 22° / roof / roof | 1.19 turns, roof, kick 6.5 | side, 1.33 turns | 2–3° / 1.94 m |
| **A** contact filter (two-pass, 60°, friction at capped load) | 5° / 5° / 8°, kick ≤ 0.22, 1–25 ticks | 1.19 turns, kick 1.9 | side | unchanged, ≤ 7 ticks at the ramp foot |
| **B** damping 3 while tilted past 60° | no effect | **0.19 turns, roof, rest 2.1 s** | **roof, 0.42 turns** | unchanged |
| **A + B (+ C)** | 5° / 5° / 8° | 0.19 turns, kick 0 | roof, 0.42 turns, kick 1.4 | unchanged |
| damping 3 while tilted *or airborne* | no effect | as B | as B | changes jumps: 21 m/s ramp flight 5.1 → 3.9 m |
| centre of mass 0.38 → 0.30 m | 23° / roof (7.2 rad/s) / roof | 1.21 turns | wheels, 1.18 turns | car can rest on its side |
| tyre frictionSlip 3.2 → 2.0 | 27° / 15° / 11°, kicks 3.9–4.1 | 1.20 turns | side | changes handling |
| chassis friction 0.4 → 0.8 | no effect | 1.20 turns | roof after 1.78 turns | no effect |
| chassis friction 0.4 → 0.2 | no effect | car ends on its side | | |

The 12 rad/s, 15 m/s side landing ends on the roof with A + B after 1.15 turns (baseline: on its
side after 1.45 turns); that is the "high spin energy" case and it is not an acceptance target.

A per-wheel "roll influence" (Bullet's trick of applying the side friction nearer the centre of mass)
was also tried from outside the controller and rejected: the controller's `wheelSideImpulse`
getter does not expose the applied impulse in a way that can be inverted reliably, the emulation
destabilised the car, and the flat-ground data shows nothing for it to fix.

## Root causes, stated precisely

1. `Vehicle.step` calls `controller.updateVehicle` once per tick. Inside, for each wheel ray hit the
   suspension force is `stiffness × compression × clippedInvDot × chassisMass`, where
   `clippedInvDot = 1 / |normal · rayDirection|`, clipped at 10 when the surface is within 84° of
   the ray. The impulse is applied along the contact normal at the contact point, so on a kerb riser
   it is a horizontal shove at road level. `setWheelMaxSuspensionForce` (2.5 g per wheel,
   `vehicle.ts:102`) caps the suspension impulse but not the friction cap, which is
   `frictionSlip × uncappedForce × dt`. The friction basis is also degenerate on a near-vertical
   surface, so that impulse can point almost vertically. Net effect: a one-tick angular impulse of a
   few thousand N·m·s against a roll inertia of 574 kg·m².
2. The same amplifier fires on landings when the chassis is pitched or rolled relative to the
   ground, which is why a tumbling car gets kicked back into the air (6.5 rad/s in one tick).
3. Once past 60° the wheel rays point sideways and can still hit kerb tops, stairs and walls, and
   the only energy sink is the chassis' angular damping of 0.5 s⁻¹ (`vehicle.ts:59`) plus contact
   friction. Nothing distinguishes a car on its side from a car on its wheels.

## Design

All of it lives in `packages/sim/src/vehicle.ts`. Constants go in one exported object so tests and
the decision record can name them:

```ts
/** Rollover guards; measured in docs/vehicle-stability-plan-2026-10-24.md. */
export const VEHICLE_STABILITY = {
  /** A wheel hit whose surface faces more than 60° (cos 0.5) away from the wheel ray is ignored for the tick. */
  contactCos: 0.5,
  /** Chassis up·Y below which the car counts as past 60°: no wheel forces, inverted damping. */
  tiltUp: 0.5,
  /** Angular damping while past 60°; `uprightDamping` is today's value. */
  invertedDamping: 3,
  uprightDamping: 0.5,
} as const;
```

### A. Wheel-contact filter (two-pass update)

In `step()`, after the per-wheel input loop and the aero forces, replace the single
`updateVehicle` call (line 183) with:

1. Set every wheel's max suspension force to `massKg × 9.81 × 2.5` and its friction slip as today
   (the loop already sets the slip; add the max force so the overrides below always reset).
2. Copy `body.linvel()` and `body.angvel()` (Rapier returns fresh objects).
3. `updateVehicle` as today.
4. For each wheel with `wheelIsInContact(i)`: read `wheelContactNormal(i)` and
   `wheelSuspensionForce(i)` (the uncapped spring force). With `down = rotate(rotation, [0, -1, 0])`
   and `facing = -(normal · down)`:
   - `facing < contactCos` → the hit is a riser, wall or grazing landing: mark the wheel
     "ignored" (max suspension force 0, friction slip 0).
   - else if `force > maxForce` → mark "capped": friction slip × `maxForce / force`, so the tyre
     cannot grip harder than the suspension load that is actually applied.
5. If any wheel was marked: restore the copied velocities, apply the per-wheel overrides, run
   `updateVehicle` again with the same filter, then restore the max suspension force on the marked
   wheels (the slip is rewritten at the top of the next tick anyway).

Why a rerun rather than a pre-cast: the controller's own ray result is what decides the forces, so
inspecting it after the fact is exact, and the rerun is deterministic (same state, same rays, same
velocities; no randomness anywhere in the controller). The only internal state the first pass
leaves behind is the wheel's cosmetic rotation counter, which the game does not use (it computes
`wheelRotation` itself, lines 187–190). The alternative, casting the four rays first with
`world.physics.castRayAndGetNormal` and the same groups, gives the same normals (verified in the
harness: identical flagged ticks) but cannot see the spring force without re-deriving the
controller's formula, so it loses the landing rule. The extra update costs one more set of four
rays on the rare ticks it triggers (1–25 ticks in the kerb cases, 0 elsewhere).

Why 60°: a 45° ramp face gives `facing` 0.71 and must stay live; kerb risers give 0.00; the
amplifier is already 2× at 60°. Nothing in the city is a drivable surface steeper than 60°, and
the Cathedral's stair risers become invisible to the rays while the treads stay live, which should
make stairs smoother rather than bouncy.

### B. Inverted damping

At the top of `step()`: `body.setAngularDamping(up[1] < tiltUp ? invertedDamping : uprightDamping)`.
Orientation only, no hysteresis (flicker at exactly 60° is harmless), not airborne (the airborne
variant changes jump trajectories, see the table). 3 s⁻¹ removes 63 % of the spin per third of a
second; it is enough for the 8 rad/s cases and leaves the 12 rad/s cases rolling once more, which
is the intended "spin energy" behaviour. The constructor's `setAngularDamping(0.5)` stays as the
initial value.

### C. Wheel forces off while past 60°

When `up[1] < tiltUp`, skip the inspection and instead run the single `updateVehicle` with every
wheel's max suspension force and friction slip at 0 (same mechanism as A's "ignored" state).
Wheel contact flags and suspension lengths keep updating for the visuals. This covers rays that
hit a kerb top, stairs or a wall while the car is on its side; the harness has no such geometry,
so C is included on reasoning, not measurement, and it costs nothing.

### Not changing

- Content: `centreOfMass`, suspension, tyres, chassis boxes and friction stay as they are, so no
  world release, no `gameplay.json` edit and no asset work. Decision 0002's conclusion (centre of
  mass stays at 0.38 m) is confirmed by the new numbers.
- Collision meshes: bevelling kerb risers would also work but means a world release and does not
  cover landings or stairs.
- Recovery (hold X), the flipped exits (`exitFlipped`, `exitFlippedPassenger`) and the journey
  harness' recover rule ("on its side or roof for more than a second") are unchanged. The side
  pose stays unstable on purpose: the exits have no clip for a car on its side.
- `Vehicle.upright` (up·Y > 0.5) and `VEHICLE_INTERACTION.uprightUp / flippedUp` (0.9 / −0.7) are
  untouched; `tiltUp` deliberately equals the `upright` threshold.

## Tests

New file `packages/sim/test/vehicle-stability.test.ts`, sized like the neighbours (about 150 lines),
built the way `simulation.test.ts` builds its world (encoded terrain and collision bundle in the
test file, car definitions embedded with the content values for the Lumi GT, patrol car and
Revontuli). Drive the `Vehicle` directly (`new Vehicle(world, …)`, set `input`, call
`v.step(world, () => true)` then `world.physics.step()`), which is what `Simulation.step` does
without the player machinery. Fixture geometry: the harness world (flat ground, 12 cm kerb at
x = 10, 45° ramp 0.5 m high in a z band away from the flat runs).

| Test | Assertion |
| --- | --- |
| kerb clip at 2°, 3°, 4° and the 3 cm wobble, for all three cars | max tilt ≤ 12°, largest one-tick angular-velocity change ≤ 1 rad/s, ends on its wheels above 15 m/s |
| side landing: rolled 110°, 8 rad/s, 15 m/s sideways | up·Y < −0.7 and at rest within 3 s, net roll turns ≤ 0.5 |
| tumble: roll 12, pitch 3, yaw 2 rad/s, 14 m/s sideways | on the roof within 3 s, net roll turns ≤ 0.6 |
| roof drop: flat on the roof, 9 rad/s, 12 m/s slide | stays on the roof, at rest within 2 s |
| flat handling: step steer at 22 m/s, handbrake turn at 25 m/s | max tilt ≤ 5° |
| 45° ramp at 12 m/s | peak height within 10 % of 1.94 m (guards against the filter touching ramps) |
| determinism | the kerb-clip 3° run twice gives identical position and rotation after 600 ticks |
| existing | `simulation.test.ts` flipped-exit tests (`rollOver()` fixture) pass unchanged |

The thresholds are the measured post-change values (5–8°, 0.12–0.22 rad/s, 0.19 turns, 2.0–2.1 s)
with margin. Do not loosen them to pass; a failure means the implementation differs from the
harness. No existing test pins a physics digest (the one hash in `police-dispatch.test.ts` is a
world-manifest SHA), so nothing else needs re-pinning.

## Verification beyond unit tests

1. `pnpm typecheck`, `pnpm test:source` (CI parity; two threads).
2. Replays of the recorded kerb flips, in Node, against their recorded release:
   `data/evidence/journey-m1-try7/run-02-recording.json` (Snellmaninkatu, the backlog 8 case) and
   `data/evidence/car-exit-20261018/exit-tools/flip.json`. Expected: the first no longer rolls, or
   rolls and rests on its roof; the second may no longer produce a flip at all, in which case the
   flipped-exit browser evidence from decision 0020 needs a new trigger (the review API can place
   the car; the sim tests already cover the exits through `rollOver()`). These files live in the
   workspace `data/evidence`, not in the source distribution; record the outcome in the decision.
3. One journey run through `tools/verify/play-journey.ts` on Vulkan (`HELSINKI_VERIFY_ANGLE=vulkan`,
   one Chromium) for browser/Node hash parity, since the two-pass update runs on both sides.
4. The backlog 8 acceptance: the Node responder probe over ten seeds without a flipped patrol car
   (the AI driver uses the same `Vehicle` class).
5. Manual play on a local shell: Senate Square kerbs and the Snellmaninkatu kerb line at speed,
   a deliberate roll (ramp or a hard side swipe) to see the settle-on-roof behaviour, and the
   Cathedral stairs.

Run nothing on more than two threads and one Chromium at a time.

## Rollout

The change is sim code bundled into the game shell. It ships through the same path as `295a74e`:
push to `main`, wait for `Source checks`, dispatch `Deploy game to Pages`; the current pinned
bridge-corrected world is unchanged and no new world archive upload is needed. Rollback is a
one-commit revert. Old recordings will replay differently (expected; their hashes were never
pinned in tests). The release audit checks committed files and history for private paths, credentials and
unapproved personal metadata before deployment.

## Risks and open points

- The Rapier internals above (the `1/dot` amplifier, the friction cap from the uncapped spring, the
  getter semantics) were established from the measured numbers and Bullet's source, not from
  Rapier's Rust source, which is not available offline. The numbers match to the newton, but the
  reviewer should confirm `wheelSuspensionForce` returns the uncapped spring force in
  `@dimforge/rapier3d-deterministic-compat` 0.21.0 before relying on the landing rule.
- The inverted damping is a visible arcade behaviour: a car past 60° settles rather than
  barrel-rolling. That is the request. Crashes above about 12 rad/s with 15 m/s sideways still roll
  once more.
- Hard landings now grip a little less for a tick (friction follows the capped load). The 45° ramp
  hop is unchanged in the harness; keep the ramp test as the guard.
- Surfaces steeper than 60° no longer support wheels. None are meant to be driven; stairs change
  from bouncy to stepped, which should be checked by eye.
- The two-pass rerun doubles the wheel-ray cost on the ticks it triggers; a few ticks per kerb,
  none in normal driving. If profiling ever shows otherwise, the pre-cast variant is the fallback.
- A car swiped at the body box (0.55–1.35 m, above the 0.38 m centre of mass) by a police ram can
  still be rolled by the contact itself. That is ordinary rigid-body behaviour and is out of scope;
  if it proves common, the next lever is the skid box's length, not the centre of mass.

## Work breakdown

1. **Code** (`packages/sim/src/vehicle.ts`, about 40 lines): `VEHICLE_STABILITY`, the per-tick
   damping switch, the past-60° force gate, the two-pass update. Keep the existing comments' style
   and reference this note.
2. **Tests** (`packages/sim/test/vehicle-stability.test.ts`): the table above.
3. **Docs**: decision `docs/decisions/0024-car-rollover-guards.md` (cause, the three rules, the
   harness numbers before and after, what was rejected and why); `docs/backlog-m2.md` item 8
   updated to point at the decision and its acceptance; a short "how to reproduce" paragraph
   pointing at the harness file.
4. **Verification**: the five items above, two threads, evidence under
   `build/vehicle-stability-2026-10-24/` (local) and `data/evidence/` for the replays.

Estimated at one working day. The acceptance criteria are the test table and the verification list.
