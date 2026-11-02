# Malmi aircraft

The Cessna 172 is adapted from [Plane by osmosikum](https://sketchfab.com/3d-models/plane-cedc8a07370747f7b0d14400cdf2faf9), CC BY 4.0.
The [Mi-17 Helicopter by Blendsteve (CG Geek)](https://blendswap.com/blend/12696)
is CC BY 3.0 in its original distribution. That distribution additionally marks
the helicopter as Fan Art and prohibits commercial use; this notice is retained
for the free, noncommercial game release. Credits appear at startup and in the
session menu, `THIRD_PARTY_NOTICES.md`, the asset contract and license notices.

The original FBX and Blender archives remain offline. Their hashes are recorded
in `content/assets/aircraft.contract.json`. The repeatable conversion uses
Blender 5.2.1 in a network-disabled, read-only container with embedded source
scripts disabled, bounded CPU/memory and explicit input/output mounts.
`tools/blender/prepare_polished_aircraft.py` accepts the extracted `cessna` and
`mi17` directories, then produces clean GLBs with metres, +Z forward, +Y up and
an origin at ground level. The helicopter's horizontal origin is the main hub.

The Cessna keeps its propeller and tail hinges. The Mi-17 keeps its main and tail
rotor geometry; the full main rotor sweeps a 21.3-metre diameter. Legacy materials
are converted to web PBR materials, helicopter colours are baked, evaluated body
geometry is simplified and authoring wire controls and unrelated scenery are
excluded. The original character rig and seated pose are retained; seat sockets,
collision envelopes, ground support, exit clearance and camera fit these models.

The producer `tools/assets/prepare_polished_aircraft.mjs` downsizes textures to
at most 1024 square and emits metadata-free palette PNGs, removes GLB extras,
deduplicates resources and applies native lossless Meshopt buffer compression.
Every compressed buffer view is decoded and checked byte-for-byte. Final exports:

| Aircraft | Transfer bytes | Triangles | Texture memory including RGBA mipmaps |
| --- | ---: | ---: | ---: |
| Cessna 172 | 1,341,144 | 29,700 | 12,582,916 |
| Mi-17 | 995,708 | 48,630 | 8,388,614 |
| Combined | 2,336,852 | 78,330 | 20,971,530 |

Standard and Low share these bounded assets. Both load near Malmi, rather than
at city startup, and their texture memory is deducted from city streaming's
combined budget. Model limits are 2 MiB each, 4 MiB together; the overall
application shell remains capped at 20,000,000 bytes. Admission still requires
exact contract hashes and sizes, embedded resources only, and GLB/image metadata
privacy checks. The two allowed filenames are unchanged. World content is unchanged.

The plane stand remains at runtime X 4986.982, Z -8950.456; the helicopter stand
is at X 5009.144, Z -8933.758. Airports → Malmi airport drops Snow beside the
plane without road snapping. W/S controls speed, A/D turns, Space/Ctrl controls
height, Shift boosts and F boards/exits on supported ground. Hold X to recover
when the destination collision is available. Aircraft still use the existing
fixed-step arcade flight controller; this replacement does not add crash physics
or change flight cell visibility ranges.

Reproduction after the isolated Blender conversion:

```sh
node tools/assets/prepare_polished_aircraft.mjs CONVERTED_DIRECTORY
node --test tools/verify/test/aircraft-assets.test.mjs packages/sim/test/aircraft.test.ts tools/verify/test/flight-presentation.test.ts
pnpm typecheck
pnpm test:source
python -m unittest discover -s tools/release/test -p 'test_*.py'
python tools/release/source_release.py audit --images
```

Build with the pinned world descriptor, serve `pnpm build:review` locally, and run
`node tools/verify/verify-aircraft.ts --url LOCAL_REVIEW_URL --out FRESH_DIRECTORY`.
The native journey uses real keyboard boarding, takeoff, turning, landing, safe
exit and walking between the stands. Open its captures before accepting the
visual fit. This functional journey does not qualify mobile hardware performance.
