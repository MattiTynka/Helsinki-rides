# Finn jumps, directional controls, aim and moving-camera repair

2026-10-17. **PASS_LOCAL** for the requested changes. Final checks are bound to
`data/evidence/finn-jump-controls-20261017/candidate.json`.
Content remains `senate-20261017-15933497`. The review bundle is
`index-CClAJTBg.js`. All 116 frozen source/config files and all 41 release files
are recorded by SHA-256. This repository has no HEAD, so no commit identity is claimed.

## Behavior and cause

Space on foot performs a normal jump, with a 0.10-second crouch/push-off and
approximately 0.9-metre rise. A second press within 0.28 seconds upgrades that same
jump once to approximately 2.8 metres. Holding Space does not auto-jump. Driving
retains the held Space handbrake; gamepad B follows the same on-foot/car distinction.
Airborne movement disables walking snap/autostep, checks ceilings and lands on
actual collision surfaces. Autostep returns on the ground. Incapacitated airborne
characters fall onto support instead of hanging in the air. Teleports synchronize
Rapier's collider before the next character sweep.

The old on-foot sideways basis was opposite to the camera's screen-right vector.
An actual baseline capture measured A moving 1.798m right and D 1.792m left.
The corrected basis agrees with the camera at every heading; driving steering is unchanged.

Shots previously followed a parallel ray from the player's eye, ignoring shoulder
offset and camera smoothing. Commands now record the displayed centre-camera ray;
the simulation resolves its target, then checks the weapon ray from the player
against cover. An optional sixth encoded command field preserves deterministic
replay and old five-field input decoding. Intentional weapon spread remains.
The authored upper-body blend also left approximately 5.44 degrees of barrel drift.
A bounded post-mixer spine rotation aligns the whole two-hand grip with the target,
including pitch, while preserving lower-body movement. Turn/pitch limits prevent
backwards torso contortion during sudden camera changes.

There is no temporal blur or accumulation renderer in this game. The duplication
complaint traced to held 60Hz actor transforms combined with a camera smoothed at
the display rate. The renderer now interpolates adjacent simulation states for
characters, vehicles, wheels and the camera together. Tests exercise the actual
chase camera at 144Hz: the old path has over 1m/s peak-to-peak camera velocity
ripple during steady motion; the corrected path has less than 1e-8m/s in that
controlled fixture. Gameplay, contacts, events and replay remain fixed at 60Hz.

## Animation and preservation

`content/assets/finn-jump-poses.json` adds eight authored normal/super phase variants,
each with 25 samples on Finn's actual 71-joint rest hierarchy. The runtime chooses
takeoff/rise/fall/landing time from simulation state and predicted support clearance.
Knees compress on impact, feet prepare for elevated contact, hands remain separate
with relaxed fingers, and the supplied running gait resumes after landing.
Aim overlays preserve the two-hand grip during flight. The ground shadow follows support.

Output SHA-256:
`b68d2462515602162ebd081683bbb95d02e528aca00d9d4e1960732e5e39b024`.
Reproduction is documented in [asset pipeline](../asset-pipeline.md#finn-jump-phases).
The authoring report binds the source GLB, scripts, native hierarchy transport and
two-bone IK solver. No downloaded library, model inference or source Python was run.
The actual GLTFLoader/mixer check measures 14 phase poses, fixed joint lengths,
unchanged original tracks and skinned shoe positions. Contact pose minima are
approximately -3mm; the capsule supplies the world jump displacement.

Finn's accepted GLB remains exactly
`c54802ad951926a1574576e6797ff73a9744c86707614a1e81e3f307f212fe86`.
All 41 world release files are unchanged, including buildings, stairs, terrain,
collision, facades, cars, Rain and scenery. Existing geometry/census evidence is
reused only for those identical bytes. The removed 2017 mesh remains removed.

## Completed evidence

| Check | Result | Evidence |
| --- | --- | --- |
| Full tests and typecheck | 134 tests pass; typecheck passes | `tests-final.log`, `typecheck-final.log` |
| Jump/physics and input | Normal/super apex, elevated landings, ceiling, held/late/third presses, handbrake, airborne death, replay state | simulation and input tests |
| Focused browser controls | All checks pass, including actual keys and continuous rAF play | `browser-final/results.json` |
| Normal / super rise | 0.90038m / 2.80045m | focused browser traces |
| Existing Cathedral stone landing | +1.19174m, grounded after real-key approach and jump | `browser-final/cathedral-jump-110.png` and trace |
| Running / driving presentation | 144Hz; 202/202 and 168/168 repeated-tick frames still move | focused browser frame records |
| Independent frame comparison | 872 comparisons; exact player/car interpolation agreement | `camera-aim-final-review.json` |
| Aim | Maximum barrel error 0.00512 degrees; target at screen centre | final level/down/up runtime checks |
| Actual firing | Nine shots within 10.64 pixels of centre, consistent with configured spread | final shot traces |
| Packaged-rig near/far aim | Eight grounded/airborne targets, maximum 0.00044 degrees; grip unchanged | sibling `finn-jump-20261017/native-pose-metrics.json` |
| Jump visual review | All 56 phase captures opened; planted compression, coherent flight and recovery | sibling `finn-jump-20261017/poses-v2/visual-review.json` |
| Standard graphics | 8/8, minimum scene average 142fps, 188 draws maximum, 147.1MiB textures | `standard-final/browser.json` |
| Low graphics | 8/8, minimum scene average 142fps, 178 draws maximum, 147.1MiB textures | `low-final/browser.json` |
| Complete gameplay journeys | 10/10 with ten matching Node replays; five deaths and five arrests, zero browser errors | `journeys-final/journey.json` |
| Ordinary default URL | Actual single/double Space and A/D; bundle and all 41 served world files verified | `production-smoke/smoke.json` |

The browser measurements use Chromium on the local RTX 3070 Ti at a 144Hz display
cadence. They do not establish performance on other hardware. The first-control
transfer remains 84.1MB, above the original 20MB target.

The phase capture fixtures use actual keyboard presses and fixed ticks, with a
paused orbit for front/side review. Separate continuous Space input and real-world
keyboard traversal prove live behavior. Aimed close-camera images crop the feet;
unarmed views and numeric contact checks establish those phases. The final source
and compiled bundle were independently compared with the frozen candidate.

## Boundaries

Jumping reaches collision-supported surfaces within its height and horizontal
travel. No hand-led mantling or individual-foot terrain IK is added. The exaggerated
super jump is intentional. The weapon uses the most recently displayed camera ray;
dynamic targets remain one interpolated tick behind authoritative collision, without
network-style lag compensation. Shots retain configured spread and nearby cover
can block them. The player remains hidden while driving, as before.

The existing native inspection adapter remains present in ordinary output; this
change does not claim its production exclusion. Nothing is committed or published
externally.

## Final local activation

All ten final journeys passed in the same document, including walking, entering,
driving, pursuit, exiting, firing, death/arrest and respawn. Each command stream
matched its fresh Node replay, including the expanded jump-state digest and
camera-ray input. Individual journeys took 39.3–43.3 simulation seconds; the
serial ten-run harness completed in approximately 461 wall seconds.

The ordinary build passed as `index-Cf8lbKo4.js`, SHA-256
`5a79824d5c9c866ab0869d01ef37f02effaf6f9c84fcc4771a3851d9703b07e6`.
The owned previous preview was stopped and restarted on strict port 5317
(PID 22400). No 4317 listener remains. The unqualified default URL was freshly
loaded, normal and super jumps were performed through real keys and both
screenshots were opened. A/D also passed without review mode. The served pointer,
compiled bundle and all 41 release files matched their expected hashes.

`completion.json` binds source preservation, gates, visual reviews, ordinary
smoke, final listener and documentation. Reload `http://127.0.0.1:5317/` to load
the new runtime. The world release ID deliberately stays the same because its
payloads did not change; the compiled bundle identifies this code revision.
