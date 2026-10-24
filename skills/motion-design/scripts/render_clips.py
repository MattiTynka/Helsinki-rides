"""Render a contact sheet per retargeted clip: evenly spaced frames over one cycle, side and front rows.
Read-only on the .blend. Use it to judge motion and skinning before any engine work.

The camera frames the character from its rest-pose bounds (clips are in place), facing from the profile.
EEVEE with a sun, a sky colour and a ground plane, so contacts and silhouettes read clearly.

blender -b --factory-startup --python render_clips.py -- --blend clips.blend --profile rig.json
    --out-dir /abs/qa [--actions walk run] [--frames 8] [--size 360] [--samples 16]
"""
import argparse
import json
import math
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector

ap = argparse.ArgumentParser()
ap.add_argument("--blend", required=True)
ap.add_argument("--profile", required=True)
ap.add_argument("--out-dir", required=True)
ap.add_argument("--actions", nargs="*")
ap.add_argument("--frames", type=int, default=8)
ap.add_argument("--size", type=int, default=360)
ap.add_argument("--samples", type=int, default=16)
args = ap.parse_args(sys.argv[sys.argv.index("--") + 1:])

prof = json.load(open(args.profile))
bpy.ops.wm.open_mainfile(filepath=args.blend, load_ui=False, use_scripts=False)
scene = bpy.context.scene
rig = bpy.data.objects[prof.get("game_rig", "GAME_rig")]
meshes = [o for o in scene.objects if o.type == "MESH" and any(m.type == "ARMATURE" and m.object == rig for m in o.modifiers)]
for ob in scene.objects:
    if ob.type in {"CAMERA", "LIGHT"} or (ob.type == "MESH" and ob not in meshes):
        ob.hide_render = True
out_dir = Path(args.out_dir).resolve()
out_dir.mkdir(parents=True, exist_ok=True)

FACING = {"-Y": (0, -1), "+Y": (0, 1), "+X": (1, 0), "-X": (-1, 0)}
fx, fy = FACING[prof.get("facing", "-Y")]
FWD, LEFT = Vector((fx, fy, 0)), Vector((-fy, fx, 0))

# Rest bounds -> camera distance
pts = [ob.matrix_world @ Vector(c) for ob in meshes for c in ob.bound_box]
lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
height = hi.z - lo.z
center = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z + height * 0.5))

scene.render.engine = "BLENDER_EEVEE"
scene.eevee.taa_render_samples = args.samples
scene.render.resolution_x = scene.render.resolution_y = args.size
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.film_transparent = False
world = bpy.data.worlds.new("qa_sky")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.55, 0.65, 0.8, 1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.8
scene.world = world
sun = bpy.data.objects.new("qa_sun", bpy.data.lights.new("qa_sun", "SUN"))
sun.data.energy = 3.5
sun.rotation_euler = (math.radians(50), 0, math.radians(30))
scene.collection.objects.link(sun)
bpy.ops.mesh.primitive_plane_add(size=height * 6, location=(center.x, center.y, lo.z))
floor = bpy.context.active_object
fmat = bpy.data.materials.new("qa_floor")
fmat.diffuse_color = (0.75, 0.72, 0.68, 1)
floor.data.materials.append(fmat)
cam = bpy.data.objects.new("qa_cam", bpy.data.cameras.new("qa_cam"))
cam.data.lens = 50
scene.collection.objects.link(cam)
scene.camera = cam
dist = height * 2.6


def aim(view):
    d = {"side": LEFT, "front": FWD}[view]
    cam.location = center + d * dist + Vector((0, 0, height * 0.05))
    cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()


actions = [a for a in bpy.data.actions if "source" in a.keys() and (not args.actions or a.name in args.actions)]
ad = rig.animation_data or rig.animation_data_create()
sheets = {}
for act in actions:
    ad.action = act
    ad.action_slot = act.slots[0]
    f0, f1 = (int(x) for x in act.frame_range)
    n = args.frames
    if act.get("loop"):  # loop: the last key repeats the first, so span [f0, f1)
        frames = [round(f0 + (f1 - f0) * k / n) for k in range(n)]
    else:
        frames = [round(f0 + (f1 - f0) * k / max(1, n - 1)) for k in range(n)]
    rows = []
    for view in ("side", "front"):
        aim(view)
        row = []
        for f in frames:
            scene.frame_set(f)
            path = out_dir / f"{act.name}_{view}_{f:04d}.png"
            scene.render.filepath = str(path)
            bpy.ops.render.render(write_still=True)
            img = bpy.data.images.load(str(path))
            px = np.array(img.pixels[:], dtype=np.float32).reshape(args.size, args.size, 4)
            bpy.data.images.remove(img)
            path.unlink()
            row.append(px)
        rows.append(np.concatenate(row, axis=1))
    sheet = np.concatenate(rows[::-1], axis=0)  # pixel rows start at the bottom: side row ends up on top
    img = bpy.data.images.new(f"{act.name}_sheet", sheet.shape[1], sheet.shape[0])
    img.pixels.foreach_set(sheet.ravel())
    img.filepath_raw = str(out_dir / f"{act.name}_sheet.png")
    img.file_format = "PNG"
    img.save()
    sheets[act.name] = {"sheet": img.filepath_raw, "frames": frames}
    print("wrote", img.filepath_raw, flush=True)
json.dump(sheets, open(out_dir / "sheets.json", "w"), indent=1)
