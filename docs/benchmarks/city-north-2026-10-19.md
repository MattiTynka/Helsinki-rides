# Northern city expansion — 19 October 2026

The locally active city now extends along northern Mannerheimintie and the public
approaches around Töölöntori, Sandelsinkatu, Välskärinkatu and Runeberginkatu.
Play area is 4.152384 km² (+523,584 m²), with 304 cells, 1,695 source building IDs
(119 new) and 6,672 scenery instances (1,043 new). Hakaniemi provides a separately
checked context/drop-in; no playable bridge connection to it is claimed. The
removed 2017 mesh remains absent.

| Binding | Value |
| --- | --- |
| World | `senate-20261019-08b1f804` |
| Manifest SHA-256 | `6f1e5b68f16fb8b34ad8ad1f02f2a03e05fb36fcfac5510c4f5fe3fd22e2858b` |
| Frozen runtime inventory | `e37f1e8c20ee1b1f2c5c5ff8a6a80e17a1249f27a8c1b57056f5cd19089f8ae8` |
| Review runtime SHA-256 | `55d19842f3693e7d1824cbae69626f1f61025792319302c42016ee679d5541a0` |
| Ordinary runtime SHA-256 | `fb0725f0f2e5830ea629ebed0d5861047c3dbede71cc549f0ac46ad3f2e27718` |
| Browser/backend | Desktop Chrome 153.0.8010.12, vulkan |
| Viewport | 1280 × 720, both presets |
| GPU reported by browser | ANGLE (NVIDIA, Vulkan 1.4.351 (NVIDIA NVIDIA GeForce RTX 3070 Ti (0x00002482)), NVIDIA) |
| Local URL | http://127.0.0.1:5317/ |

The selected final static report passes all 22 checks, including
4,982,356 full-width tyre-footprint support probes, exact preservation
of the 3,632,793 accepted authored terrain samples and the original accepted
assets. Source-bound bank restoration corrects the municipal-land/OSM-water
conflict; it does not authorize walkable floors elsewhere in source water.
Meripaviljonki's new collider follows all 569 exact source/native triangles
instead of its previous flat bounding prism. The accepted Allas sauna remains
byte exact and is independently declared as a visible floating structure.

The final bounded Välskärinkatu ground repair and source-aligned road registration
are recorded in 1 SHA-256-bound PASS verification
receipt selected by the final scope. The
linked proofs define the actual local repair boundary and registration checks;
no additional repair dimensions or measurements are inferred here.

Six focused sidecar/ground-patch tests and the world typecheck also pass in a
separate source-fix receipt. The selected ground patch retains its frozen v9 build identity, with
seven proof sidecars restored by the guarded helper. The subsequent general
source preservation fix retains byte-identical ground and visual algorithms.

World producer v8 closes 382 distinct tests: 381 initial passes and the missing
immutable-fixture case closed in its four-test rerun. The new water-building
repair adds six tests. The final precision checks add 16 tests; world and verify
typechecks pass. The unchanged runtime reuses its separately recorded 373 tests
and five typechecks: all 2,417 frozen files (4,060,951,680 bytes) were rehashed
against the same runtime inventory in this expansion. Runtime test reuse is
separate from the new exact-world browser, travel and replay measurements below.

| Native gate | Observed result |
| --- | --- |
| Continuous walking | 469/469 checkpoints, 5637.4 m, no recovery; one document |
| LOW settled fixtures | 64 views, max 444,647 triangles / 186 calls; caps 500,000 / 350 |
| Standard settled fixtures | 64 views, max 1,017,827 triangles / 201 calls; caps 1,200,000 / 600 |
| LOW browser gate | 9/9 checks; lowest scene mean 137.6 FPS |
| Standard browser gate | 9/9 checks; lowest scene mean 133.9 FPS |
| Directed real driving | 6072.0 m planned roads, eight goals, 0 recoveries, real entry/return/exit |
| Driving replay | 39,260 ticks, hash `4ffb2366`, zero divergence |
| Gameplay endings/replays | 2/2 runs: wasted, busted; both command replays match |
| New-area request failures | 10/10 checks; 404 retry and delayed completion |
| Ordinary UI | 8/8 checks; default world, bounded loading, three UI drop-ins, review adapter absent |

All seven selected native jobs belong to `final-native-v4`; their reports,
manifest/runtime identity, commands and hashes are retained under `data/evidence/city-north-20261019`.
The gameplay report's older format is bound through its exact report hash in
the selected suite. Every selected job passes; the drive replay also matches
the browser hash with no first divergence. All four ordinary UI captures were
opened and hashed after activation.

Initial readiness was 14.46 s; control and initial
visual settlement took 15.30 s in this
local run. All static collision (150.9 MiB)
and terrain (15.9 MiB) remain resident from
startup. Visual meshes and scenery load and evict as the character moves;
collision does not stream. Retained texture caps stay 160/320 MiB, and detail/
distant geometry caps stay 96/64 MiB on LOW.

The startup owned-browser snapshot sums
2344.0 MiB working set and
2451.0 MiB private commit.
The largest sampled owned-browser working set was
2535.8 MiB. These are process
snapshots; shared pages can be counted more than once. They are not continuous
memory peaks or GPU-only measurements. This desktop result does not establish
mobile, 1080p, whole-city RAM or network-speed performance.

The LOW tour's raw sampled triangle peak was
451,580; texture residency
peaked at 155.51 MiB and sampled JS heap at
851.7 MiB. Settled-view caps and movement samples are
separate measurements. The two Senate returns retain respectively
154 / 154 textures and
368 / 368 geometry objects.

16 selected exact final native images were opened and
hashed. Their journal records the actual observations; this is not approval of
every city elevation. Runeberginkatu 55a's residential facade has a bounded
same-building texture restoration, but foliage in the protected uncertain
lower-left commercial opening remains. Other raw municipal facade imagery,
including the previously documented Malminkatu 3/5 foliage, also remains.
The source's coarse berm/rock and ground approximations are not surveyed hero
models. Google Street View inspection was unavailable; the qualified facade
reference and protected masks are recorded in the source repair evidence.

At Runeberginkatu the finite ground edge at Z=-1152
remains visible as a sky band below facade geometry outside the supported map.
The selected proof classifies this reported band as off-map boundary exposure.
It reconstructs the camera from the recorded capture pose, frozen runtime
formula and collision pull-in; the actual render presentation matrix was not
recorded. This reconstruction limits the conclusion to the tested view and
controls. The edge remains a visible appearance limitation.

The complete naturally terminating bank repair and vertical closures preserve
existing dry ground, buildings and accepted scenery. New tree seating corrects
94 heights and omits four incompatible new instances while retaining all 5,629
accepted instances. The tested hotel access uses a source-bound 3 m paved
support strip; this is not a surveyed width, public-access ruling or parking
lock. Hakaniemi's fixture is not a bridge-travel proof.

Local activation changes only the two current world pointers. Ordinary HTML
and runtime remain unchanged, with rollback files at `data/work/city-north-20261019/activation-rollback-v1`.
The existing server remains on port 5317; it was not restarted, and no second
game port or external publication was created. Final local integration checks
the served identity, matching current pointers and the four opened ordinary
captures.

| Evidence | SHA-256 |
| --- | --- |
| [Final scope](../../data/work/city-north-20261019/final-verification-scope-v1.json) | `e2093ab55b20ac80e861afec0d6ade6e5cc2975b07328f1f39d3898cfc906608` |
| [Static audit](../../data/evidence/city-north-20261019/static-world-v4/world.json) | `dad11cd6ee8ab71fac53f8fd7613c84d7704800cf40ff3d94e169f830268876e` |
| [Native suite](../../data/evidence/city-north-20261019/final-native-v4/suite.json) | `2356960504e6ec9c47e508105975f1e41fa4d1d1211b0eed9a105cd87c4f116e` |
| [Opened native views](../../data/evidence/city-north-20261019/opened-final-views-v2.json) | `be8a1c8b40a3b6e5f74c4aa973292a723a971f187abf4e92567370538e8e81ef` |
| [Road-repair verification 1](../../data/evidence/city-north-20261019/road-final-repair-v1.json) | `5fe3503d1fc5816f082001882bed08f33b2e49302faf938134ddfbc6d58bc7d7` |
| [Northern boundary appearance](../../data/work/city-north-20261019/verification/runeberg-boundary-view-final-v1.json) | `4411c2ff6c7540c7caab965b7fa95f299ac26abc000eb3b5378a7b94b458c3b0` |
| [Ordinary smoke](../../data/evidence/city-north-20261019/ordinary-v1/results.json) | `40b1f8fbb60bf5c6fc0269f458a1d7c64880c43da12542de89b24c97b816ac02` |
| [Activation](../../data/evidence/city-north-20261019/activation-v1.json) | `f04c8a4538e1ceca264c7e6e734e5c39d3430b7867b05e313090a40771115c08` |
| [Final local integration](../../data/evidence/city-north-20261019/integration-final-v1.json) | `47f2ff59f437c21747e422558734998216d420a4ee4949f42a8119bba0052b4c` |

Source choices, finite repair boundaries and remaining appearance work are in
the [northern expansion record](../city-north-2026-10-19.md).
