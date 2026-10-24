# Rig profile

One JSON file per character tells every script which bones do what. `inspect_rig.py` drafts it; you verify it.
Examples: `assets/profiles/snow-cloudrig.json` (CloudRig, hand-written `bones`, cloth, face merge) and the
synthetic Mixamo-style draft produced by `tests/run_e2e.sh` (everything inferred).

```jsonc
{
  "name": "snow-cloudrig",
  "source": {
    "rig": "RIG-Snow",                       // armature object in the authoring file
    "extra_rig_objects": ["META-Snow"],      // objects removed with the rig (metarigs, widgets parented elsewhere)
    "exclude_meshes": ["_helper$", "_deformer$"],  // regex: bound meshes that are not visible geometry
    "mesh_rename": ["GEO-snow", "FINN"],     // optional prefix swap for game mesh names (+ "_game")
    "texture_dirs": ["textures", "../textures"]    // searched (relative to the .blend) for missing images
  },
  "game_rig": "FINN_game_rig",               // armature name in game.blend / clips.blend
  "facing": "-Y",                            // character forward in Blender: -Y (Blender/Rigify/CloudRig), +Y (many FBX), ±X
  "bones": { "DEF-Hips": "root", "DEF-Spine": "DEF-Hips", "...": "..." },  // null = all deform bones, nearest deform parent
  "merge_groups": [ { "pattern": "^DEF-Ponytail", "into": "DEF-Ponytail1" },
                    { "pattern": "^DEF-.*(Cheek|Jaw|Lip|...)", "into": "DEF-Head" } ],
  "cloth": { "body": "GEO-snow-body", "meshes": ["GEO-snow-shirt", "GEO-snow-pants"], "near": 0.025, "far": 0.06 },
  "retarget": {
    "hips": "DEF-Hips", "head": "DEF-Head", "neck": "DEF-Neck",
    "axial": ["DEF-Hips", "DEF-Spine", "DEF-RibCage", "DEF-Chest", "DEF-Neck", "DEF-Head"],
    "map": { "DEF-Thigh_1.L": ["LeftLeg", "LeftShin"], "...": ["SOMA joint", "SOMA child for rest direction"] },
    "legs": { "L": { "thigh": "DEF-Thigh_1.L", "knee": "DEF-Knee_1.L", "foot": "DEF-Foot.L" }, "R": { } },
    "twist": [ { "bone": "DEF-Forearm_2.L", "driver": "DEF-Wrist.L", "fraction": 0.5 } ]
  },
  "arms": { "L": { "upper": "DEF-UpperArm_1.L", "lower": "DEF-Forearm_1.L", "hand": "DEF-Wrist.L" }, "R": { } }
}
```

## Fields that need judgement

- **bones.** Simple rigs (Mixamo, Unreal, hand-made): `null`. Authoring rigs (CloudRig, Rigify, Auto-Rig Pro) parent DEF
  bones to mechanism bones, so the inspector reports "N deform bones have no deform parent": write the game hierarchy
  by hand, keeping only bones that carry visible weights (drop face micro-bones; merge their groups into the head).
  Bind pose is the rig's current pose, so put the rig in its default pose in the source file first.
- **facing.** The inspector derives it from the thigh positions (character left = left thigh side). Wrong facing
  rotates every clip 90° or 180°: check the first contact sheet.
- **map.** Key = game bone, value = `[SOMA joint, SOMA child]`. The child gives the source rest direction; limbs get a
  rest-direction correction so A-pose vs T-pose arms and finger splay do not offset the motion. Bones listed in
  `axial` take the source rotation change as-is (correcting slightly different spine directions adds lean).
  Unmapped bones follow their parent rigidly (twist segments, ponytails, props). SOMA-77 joints:
  `Hips Spine1 Spine2 Chest Neck1 Neck2 Head HeadEnd`, per side `<S>Shoulder <S>Arm <S>ForeArm <S>Hand`,
  fingers `<S>Hand{Thumb1-3,End}`, `<S>Hand{Index,Middle,Ring,Pinky}{1-4,End}` (1 = metacarpal),
  legs `<S>Leg <S>Shin <S>Foot <S>ToeBase <S>ToeEnd`, with `<S>` = Left/Right.
  Spine bones: spread over Spine1/Spine2/Chest by position; one neck bone → `["Neck1", "Head"]`.
  Fingers without metacarpals start at SOMA `<f>2`.
- **legs.** Thigh, knee (shin) and foot of each leg; every bone between them (twist segments) is rotated with the
  chain during foot locking. The hip-height ratio between the thighs and SOMA's legs scales hip travel.
- **twist.** A twist segment whose child is the hand takes `fraction` of the hand's twist about the forearm axis
  (CloudRig `Forearm_2`, Rigify `forearm.L.001`). Without it the wrist candy-wraps.
- **cloth.** Only for clothing that is a separate mesh over a body mesh with masks. Clothing near *visible* skin
  takes the skin's weights (prevents poke-through at sleeves and collars); see [skinning](skinning.md).
- **merge_groups.** Weight groups of bones that are not in the game skeleton but should still deform (face, hair
  chains). Order matters: first matching pattern wins.

## Verify a profile

1. `inspect_rig.py` on the built `game.blend` (with `--rig <game_rig>`) must report `draft_problems: []` and its draft
   `retarget` section should match yours; differences are either your intent or a mistake.
2. Retarget one walk and look at the contact sheet: facing, arms hanging naturally, knees bending forward, thumbs.
