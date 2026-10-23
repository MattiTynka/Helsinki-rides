# Mobile verification follow-up

This follow-up repairs verification tools for the published mobile release.
The application, simulation, world descriptor and asset packet are unchanged.

The mobile production check waits for the actual touch target after streaming,
then observes a tick advance after Resume instead of assuming the cosmetic HUD
counter refreshes within exactly 500 ms. Missing controls and a resume that does
not advance within five seconds still fail. English and Finnish native Chromium
touch checks passed, including pause, resume, firing and portrait layout.

The desktop journey now follows clipped, densely sampled road points and
completes its turn onto Unioninkatu before pursuing. Its ram target stays with
an upright active patrol rather than switching between nearby vehicles. Reverse
escape steering accounts for the direction of travel. A confirmed blocked exit
causes a driving manoeuvre before another exit attempt. These are keyboard
controller corrections; they do not change game physics, collisions or police.

The Wasted journey passed all 18 checks in 57.1 simulated seconds against the
unchanged 75-second limit. Its 3,506-command recording replayed exactly with hash
`d429da56`. Escape covered 6.5 metres over three seconds and reached 9.9 metres
of patrol separation. A separate Busted journey passed in 65.3 simulated seconds,
with 3,998 commands replaying exactly as `88212386`. Chromium reported no console
errors in either run. These are two recorded journeys, not the ten-run M1
reliability gate or a whole-city performance result.

These checks used `senate-20261022-mobile-safe-v3`, manifest SHA-256
`86ec02dc2f28e4c9dd93819b1c8ef44fbbd0a1c8c619dc266209065ade7b16b2`,
with Chromium 153 on Windows using ANGLE Vulkan. Mobile rendering was emulated
at DPR 3 and selected a 675 by 312 drawing buffer for an 844 by 390 viewport.
Physical iPhone Safari and Android Chrome performance, memory and thermal
verification remain unrun.
