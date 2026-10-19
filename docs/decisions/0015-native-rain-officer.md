# Native animated Rain officer

Status: **PASS, active locally**, 2026-10-17. Release
`senate-20261017-a236a318`, ordinary bundle `index-Bw7FPas1.js`.

The user supplied `Snow_v4.2/motion/out/rain.glb`, its clip manifest and the
motion-design runtime. The model already contains the navy Poliisi uniform with
front/back lettering. Both supplied GLB copies hash to
`c2aec924a23100aeae0d1ea9d006af5aea3dd6b37c76359a3bf262b679fe1e58`.

Replace the stable `character-rain` officer slot. Preserve the supplied 70-joint
hierarchy, original eleven gait tracks, mesh, skin weights and uniform materials.
The source is +Z forward, Y up, metres and approximately 1.649 m tall. Adapt the
existing directional shared-phase runtime using the supplied per-clip speeds;
do not run Finn's rig-specific jump or car overrides on Rain.

Append six native-rig gameplay actions and pistol/head sockets. Aim correction
uses the profile's `DEF-Spine1` root and the police simulation's target height.
Package source textures as KTX2 with 1024 base-colour/512 data-map limits. The
explicit native NPC contract permits the supplied 76,974 triangles and sixteen
materials; actual scene frame-time, draw-call and texture budgets must pass.

Stage a new local release replacing only Rain. Keep all other payloads byte-exact
and retain the prior release. Acceptance requires source-preservation checks,
glTF/contract validation, opened textured skin captures, actual police movement,
weapon/death behaviour and continuous gameplay/replay. The completed Finn car
checkpoint is separately preserved in `data/evidence/car-entry-20261017/`.

The apparent underarm seam was a pre-existing base-colour problem: navy sleeve
paint stopped early on the body atlas. A source-bound body-space/UV mask extends
that existing colour over 3,756 texels (0.0224% of the atlas), protecting other UV
owners and preserving alpha. No geometry or weight exception was necessary.
The adapter checks every pixel outside the mask before KTX2 encoding; the separate
preservation verifier confirms all 2,436 original non-image buffer views, rest
hierarchy, materials and eleven original motion tracks remain exact.

Rain's six supplemental actions are aim, fire, hit, death, drive and arrested.
The generic drive hold is retained for contract compatibility; AI drivers remain
hidden as before. This does not claim the cabin-specific entry fitting implemented
for Finn. Authored death contact is checked on flat ground, not as a ragdoll system.

Acceptance: 179 tests, typecheck/build, 105 GLB checks, source-preservation
verification, opened authoring and actual police gameplay captures, both graphics
presets, two uninterrupted gameplay runs with matching Node replays, and the
default-URL car regression all pass. The game preview was restarted on strict
port 5317; the default browser loads the exact native Rain asset and bundle.
See [the benchmark](../benchmarks/native-rain-officer.md) and
`data/evidence/rain-native-20261017/completion.json` for hashes and limits.
