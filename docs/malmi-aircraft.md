# Malmi aircraft

The trainer plane and light helicopter are from [Low-Poly Aircraft Kit Free by
heyheythere](https://heyheythere.itch.io/low-poly-aircraft-kit-free), licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Their rigid parts have
animated propeller, rotor and control-surface pivots. They use a mechanical
transform rig; they do not use a deforming character skeleton. Full attribution
and terms are in `THIRD_PARTY_NOTICES.md` and `content/assets/aircraft-license.md`.

The plane's southern-runway stand is at 60.24985 N, 25.0422 E, projected through
the existing EPSG:3879 origin to runtime X 4986.982, Z -8950.456. The helicopter
stand is at X 5009.144, Z -8933.758. Placement uses the real streamed Malmi ground;
unavailable terrain does not authorize a spawn. The location menu places Snow
beside the plane without snapping to a nearby road.

Flight runs at the existing 60 Hz simulation step. W/S changes plane throttle;
the selected throttle persists when released. Helicopters hover when W/S is
released. A/D turns, Space/Ctrl controls height, Shift boosts speed, and F boards
or exits a stopped aircraft on supported ground. Holding X recovers to its stand
after destination collision is available. Flight is bounded to the city's live
data region and 550 runtime metres in height. Static collision uses swept part
envelopes for the fuselage, wings, gear and complete animated rotor discs. This
is an arcade controller, with automatic leveling near landing.

Snow's accepted seated joint pose is aligned to each aircraft's seat and follows
its full orientation. The original character skeleton, skin and ordinary walking
controller are retained. Flying uses a separate occupancy field so it does not
change existing car interaction authority. Safe exits require a flat surface and
capsule clearance; pressing F in the air leaves Snow aboard.

The original atlas pixels, meshes, hierarchy and clips are retained. The producer
removes nonrendering PNG metadata, embeds the atlas and applies the native
lossless Meshopt compressor with byte-for-byte decode checks. Final assets are
47,840 bytes / 606 triangles and 32,636 bytes / 478 triangles: 80,476 bytes total.
Each has one 512-square atlas, approximately 1.34 MiB including RGBA mipmaps.
Standard and Low use these same small assets. They load near Malmi rather than
at city startup and are emitted as hashed application assets. The world packet
is unchanged; GitHub's existing artifact and push budgets are unchanged.

The source curator audits both GLB JSON and embedded PNG metadata. The Pages
stager admits only trainer/helicopter hashed filenames with exact contract
sizes and hashes, a 1 MiB individual limit and a 256 KiB combined limit.

Reproduce asset preparation from the extracted licensed sampler:

```sh
node tools/assets/prepare_aircraft.mjs INPUT_DIRECTORY
node --test tools/verify/test/aircraft-assets.test.mjs packages/sim/test/aircraft.test.ts tools/verify/test/flight-presentation.test.ts
pnpm typecheck
pnpm test:source
python -m unittest discover -s tools/release/test
```

With the pinned world configured, build `pnpm build:review`, serve it on loopback
and run `node tools/verify/verify-aircraft.ts --url LOCAL_REVIEW_URL --out FRESH_DIRECTORY`.
The journey observes native state but uses real keyboard input to board, take off,
turn, reject an airborne exit, land and leave both aircraft, walking from the
airfield drop-in to the helicopter. Captures require visual inspection.
This functional journey does not qualify mobile hardware or citywide performance.
