"""Export the game rig, its meshes and the retargeted clips to a GLB (one glTF animation per clip).
Never saves the input .blend.

Only clips written by retarget.py (actions with a "source" property) are exported, each through its own
NLA track. glTF reads Principled BSDF + image textures; anything else (studio node groups, UDIM tiles,
procedural textures) exports wrong or not at all, so the script lists those materials instead of guessing.
Rebuild them as plain Principled materials first (see references/pipeline.md, "Materials").

blender -b --factory-startup --python export_glb.py -- --blend clips.blend --profile rig.json
    --output /abs/char.glb [--actions walk run] [--drop-meshes REGEX ...] [--max-tex 2048] [--strict-materials]
"""
import argparse
import json
import re
import sys
from pathlib import Path

import bpy

ap = argparse.ArgumentParser()
ap.add_argument("--blend", required=True)
ap.add_argument("--profile", required=True)
ap.add_argument("--output", required=True)
ap.add_argument("--actions", nargs="*")
ap.add_argument("--drop-meshes", nargs="*", default=[], help="regex of game meshes to leave out")
ap.add_argument("--max-tex", type=int, default=2048)
ap.add_argument("--strict-materials", action="store_true", help="fail when a material is not glTF-ready")
args = ap.parse_args(sys.argv[sys.argv.index("--") + 1:])

prof = json.load(open(args.profile))
bpy.ops.wm.open_mainfile(filepath=args.blend, load_ui=False, use_scripts=False)
rig = bpy.data.objects[prof.get("game_rig", "GAME_rig")]
drop = [re.compile(p) for p in args.drop_meshes]
meshes = [o for o in bpy.data.objects if o.type == "MESH" and not any(p.search(o.name) for p in drop)
          and any(m.type == "ARMATURE" and m.object == rig for m in o.modifiers)]
for ob in list(bpy.data.objects):
    if ob != rig and ob not in meshes:
        bpy.data.objects.remove(ob, do_unlink=True)


# --- Material readiness -----------------------------------------------------------------------------
def gltf_issue(mat):
    if mat is None:
        return "empty slot"
    if mat.node_tree is None:  # plain colour material: exported as a base colour
        return None
    out = next((n for n in mat.node_tree.nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output), None)
    if out is None or not out.inputs["Surface"].is_linked:
        return "no surface output"
    shader = out.inputs["Surface"].links[0].from_node
    if shader.type != "BSDF_PRINCIPLED":
        return f"surface is {shader.type}, not Principled BSDF"
    for n in mat.node_tree.nodes:
        if n.type == "GROUP":
            return f"node group {n.node_tree.name if n.node_tree else '?'}"
        if n.type == "TEX_IMAGE" and n.image and n.image.source == "TILED":
            return f"UDIM image {n.image.name}"
    return None


issues = {}
for ob in meshes:
    for slot in ob.material_slots:
        why = gltf_issue(slot.material)
        if why:
            issues[slot.material.name if slot.material else f"{ob.name}:empty"] = why
if issues and args.strict_materials:
    sys.exit(f"materials not glTF-ready: {issues}")
for img in bpy.data.images:  # keep the GLB small; scale() works on loaded pixels
    if img.source == "FILE" and img.has_data and max(img.size) > args.max_tex:
        f = args.max_tex / max(img.size)
        img.scale(int(img.size[0] * f), int(img.size[1] * f))

# --- Actions --------------------------------------------------------------------------------------
actions = [a for a in bpy.data.actions if "source" in a.keys() and (not args.actions or a.name in args.actions)]
assert actions, "no retargeted clips found (actions written by retarget.py carry a 'source' property)"
ad = rig.animation_data or rig.animation_data_create()
bpy.context.view_layer.update()
ad.action = None
for track in list(ad.nla_tracks):
    ad.nla_tracks.remove(track)
for act in actions:  # one NLA track per clip -> one glTF animation per clip
    track = ad.nla_tracks.new()
    track.name = act.name
    strip = track.strips.new(act.name, int(act.frame_range[0]), act)
    strip.action_slot = act.slots[0]
    track.mute = False
for pb in rig.pose.bones:
    pb.matrix_basis.identity()

bpy.ops.object.select_all(action="DESELECT")
rig.select_set(True)
for ob in meshes:
    ob.select_set(True)
bpy.context.view_layer.objects.active = rig
out = str(Path(args.output).resolve())
bpy.ops.export_scene.gltf(
    filepath=out, export_format="GLB", use_selection=True, export_yup=True,
    export_apply=False, export_skins=True, export_morph=False, export_animations=True,
    export_animation_mode="NLA_TRACKS", export_force_sampling=True, export_frame_step=1,
    export_anim_slide_to_zero=True, export_optimize_animation_size=False,
    export_rest_position_armature=True, export_def_bones=False, export_leaf_bone=False,
    export_image_format="WEBP", export_image_quality=88, export_extras=True,
)
info = {"glb": out, "bytes": Path(out).stat().st_size, "actions": [a.name for a in actions],
        "meshes": [ob.name for ob in meshes], "materials_not_gltf_ready": issues,
        "fps": bpy.context.scene.render.fps}
print(json.dumps(info))
Path(out).with_suffix(".export.json").write_text(json.dumps(info, indent=1))
