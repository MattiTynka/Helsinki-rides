# Skinning: authoring rig → game skeleton

A game runtime does linear blend skinning with at most 4 influences, no B-Bones, no constraints, no drivers, no
corrective smooth. `build_game_rig.py` converts the authoring rig to that, and this is where limbs start to look wrong.

## What the conversion changes

| Authoring feature | In the game rig | Risk |
| --- | --- | --- |
| B-Bones (CloudRig limbs: 10-16 segments) | rigid bone | joint blend may harden; check `bbone_bones_flattened` |
| Mechanism parents (STR/MCH/ORG) | hand-written `bones` hierarchy | wrong parent = limb pivots from the wrong place |
| Masked body under clothes | masked faces removed | hidden skin's weights must not leak into clothing |
| Face/hair micro-bones | merged into head/hair groups | facial animation lost (intended) |
| Corrective smooth, shape-key drivers | dropped | elbows/knees lose volume at extreme bends |
| Object transform (FBX 90°/0.01) | baked; rig at origin, metres | none, but scripts assert it |

## Clothing weights (the Snow thigh bug)

Clothing that is a separate mesh pokes through or pinches when its weights differ from the skin beneath. The build
therefore lets clothing vertices within `near` (2.5 cm) of the body take the body's weights, fading out by `far` (6 cm).
**Only visible skin counts.** On Snow, the body under the jeans was hidden by a mask and its leg groups still had an older
rig's names (`DEF-Thigh1.L` instead of `DEF-Thigh_1.L`), so those weights were dropped and the jeans' upper legs got
pelvis-only weights. Walking, the top of each thigh stayed with the pelvis and broke onto the thigh lower down: a hard
edge in front and a gap behind the hip. Weighting from visible skin only (mask-hidden vertices excluded, blended by the
visible fraction of the nearest face) left the jeans with their own studio weights and fixed it. The build report's
`stale_like_game_bones` lists such renamed groups directly.

## skin_check.py

Rotates one joint at a time in world space: hip flex 70° / extend 35° / abduct 35°, knee 100°, shoulder forward 70° /
back 45°, elbow 100°, spine twist 35°. Per pose and mesh:

- `stretch_cm`: largest edge lengthening (absolute, so tiny seam edges do not dominate as ratios do);
- `kink_cm`: largest difference between a vertex's displacement and its neighbours' mean, the signature of a weight step.

Calibration on Snow (1.6 m): hard hip seam 6-13 cm stretch / 3-7 cm kink, fixed weights ≤ 3.6 / 2.9 everywhere.
Defaults `--stretch-cm 5 --kink-cm 3`. A crude synthetic tube with sharp inverse-distance weights trips the knee
(3.6 cm kink): that is a real hard blend, not noise. Edge-length *ratios* were tried first and failed: they ranked the
fixed Snow rig worse than the broken one. Use the numbers to find and compare; judge the result from renders.

## Comparing with the authoring rig (when the game rig looks wrong)

To learn whether a defect is new (conversion) or inherited (source weights), pose the authoring rig through its own
controls (Snow: set `Properties["ik_left_thigh"] = 0`, rotate `FK-Thigh.L`), read the evaluated clothing mesh with
subdivision off (vertex order then matches the game mesh), take the evaluated DEF bone matrices (orthonormalised) as the
game bones' pose, skin the game mesh with linear blend, and compare per vertex. On Snow this gave: studio weights vs studio
B-Bone deformation 0.23 cm mean / 3.6 cm max (the conversion itself is faithful); broken game weights 1.06 / 15.1 cm;
fixed game weights back to 0.23 / 3.6 cm.

## Fixing weights

1. Stale or renamed groups: rename them in a copy of the source, or add a `merge_groups` entry mapping old → new name.
2. Clothing glued to the wrong bone: check `cloth.meshes` and the masks; never transfer from hidden skin.
3. A hard 0 → 1 band at a joint in the source itself: smooth the weights across the joint in the source copy
   (Blender weight smooth over the joint ring), or keep a B-Bone-like gradient by splitting the influence between parent
   and child over ~10-15 cm of the limb.
4. Rebuild, rerun `skin_check`, rerun the retarget chain (motion is unchanged by weight edits), re-export.
