# Western city continuation — 19 October 2026

The locally active game now covers western Kamppi and Temppeliaukio's public
approach. Play area is 3.6288 km² (+0.6188), with 276 cells, 1,576 source building
IDs and 5,629 scenery instances. The removed 2017 mesh remains absent. This is
bounded city travel/resource acceptance, with the facade limits below.

| Binding | Value |
| --- | --- |
| World | `senate-20261019-809c1a14` |
| Manifest SHA-256 | `9acf7069c977b9314d75e1cf69b62b8174263f014acdee60129d783a2ab6230f` |
| Frozen runtime inventory | `e37f1e8c20ee1b1f2c5c5ff8a6a80e17a1249f27a8c1b57056f5cd19089f8ae8` |
| Review runtime SHA-256 | `55d19842f3693e7d1824cbae69626f1f61025792319302c42016ee679d5541a0` |
| Ordinary runtime SHA-256 | `fb0725f0f2e5830ea629ebed0d5861047c3dbede71cc549f0ac46ad3f2e27718` |
| Browser/backend | 153.0.8010.12, vulkan |
| Viewport | 1280 × 720, both presets |
| GPU reported by browser | ANGLE (NVIDIA, Vulkan 1.4.351 (NVIDIA NVIDIA GeForce RTX 3070 Ti (0x00002482)), NVIDIA) |
| Local URL | http://127.0.0.1:5317/ |

All 373 frozen runtime tests and all five typechecks pass. The world producer's
351-test run and final static audit are separately bound to their frozen source
and exact inputs. The 21 static checks pass, including 4,493,798 full-width road
samples, exact authored terrain preservation and unchanged accepted assets.
All 561 packaged GLBs validate. Later renderer work changes no world payload.
The image-only owner repair adapter separately passes nine focused tests and
both real owner-atlas byte-identical negative controls; no artwork was applied.

| Native gate | Observed result |
| --- | --- |
| Continuous walking | 520/520 checkpoints, 5747.7 m, no recovery; one document |
| LOW settled fixtures | 48 views, max 449,313 triangles / 166 calls; caps 500,000 / 350 |
| Standard settled fixtures | 48 views, max 933,400 triangles / 206 calls; caps 1,200,000 / 600 |
| LOW browser gate | 9/9 checks; lowest scene mean 140.8 FPS |
| Standard browser gate | 9/9 checks; lowest scene mean 129.3 FPS |
| Directed real driving | 8554.6 m planned roads, eight goals, 0 recoveries, real entry/return/exit |
| Driving replay | 54,866 ticks, hash `f73a14aa`, zero divergence |
| Gameplay endings/replays | 2/2 runs: wasted, busted |
| New-area request failures | 10/10 checks; 404 retry and delayed completion |
| Ordinary UI | 8/8 checks; default world, bounded loading, three UI drop-ins, adapter absent even with review query |

The selected native suites are `native-v2-drive` and `native-v3` under
`data/evidence/city-continuation-20261019`. Each carries exact manifest/runtime identity, command arguments,
browser/backend and raw reports. The six-job runner checks served HTML/module/
manifest identity before and after each job, including gameplay's older report
format. The initial failed `native-v1` report remains historical: its real
walk passed but West Kamppi submitted 558,833 triangles. Runtime v7 repairs LOW
foliage submission with full near crowns, nested distant cards and unchanged
trunks, source poses, textures and standard behavior. No budget was raised.

Initial readiness was 11.20 s; control and initial
visual settlement took 11.97 s on this
local test. All static collision (130.6 MiB)
and terrain (13.9 MiB) load at startup.
The owned-browser startup snapshot sums 2274.1 MiB
working set and 2398.5 MiB private
commit. These are process snapshots, not continuous peaks or GPU-only measures;
shared pages can be counted twice in summed working sets. Retained texture caps
remain 160/320 MiB. Visual meshes stream and evict; collision does not. This is
not a mobile, 1080p, whole-city RAM or network-speed claim. Settled view limits
are distinct from raw movement peaks retained in the reports.

The LOW tour's sampled triangle peak was 457,567;
texture residency peaked at 155.76 MiB. Its JS heap
samples peaked at 873.8 MiB. The largest owned-browser
working-set snapshot was 2402.7 MiB;
it is not a continuous process-memory peak. Both repeated Senate returns retain
154 textures and
331 geometry objects.

18 selected exact final native images were opened and hashed
in `opened-final-views-v1.json`. The ordinary UI's four captures were also
opened; the capture journal records observations. This is not approval of every
city elevation. The Cygnaeuksenkatu foundation's closest street view remained
source-occluded; its numerical geometry/colour proof is separate.

Malminkatu 3 page1299/part6/triangles0–3 and Malminkatu 5 page2460/part1/
triangles47–48,101–102 retain baked source foliage. Exact municipal geometry
places them beside public Malminkatu footway47150. Available primary photographs
do not establish the concealed lower openings. The source-visible wall-band
preview was rejected as ineffective and never shipped. Chrome's computer-use
inventory remained empty; Google Street View was not checked. The reference
disposition and exact next repair boundary are in the
[continuation record](../city-continuation-2026-10-19.md).

Runeberginkatu's unsupported Baana bridge and its 7.807 m terminal approach
remain excluded; the tested drive uses the supported Fredrikinkatu detour.
The driveway's 1.117 m authoring buffer is not a surveyed width or access ruling.

Local activation changed only the two current pointers and ordinary HTML index,
with preserved rollback files at `data/work/city-continuation-20261019/activation-rollback-v1`. No server was
restarted, no second game port was created and no external site was published.
Activation receipt SHA-256: `db2d8587853f165c22de2af6c9497adc7281db4c760be05ba5cd591c8e9eed05`.
The final `integration-final-v1.json` closes the activation receipt's ordinary-
smoke-pending phase with HTTP identity, both current pointers and four opened
ordinary captures; SHA-256 `8c7eb4807f964d03b54fc543ba3d1a01ba870e90fa46dec7e702f492cdcf849d`.
