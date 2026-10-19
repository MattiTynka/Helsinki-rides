"""Review stills of an exported character GLB: re-import into a fresh scene and render a few views.

blender --background --factory-startup --disable-autoexec --python review_game_character.py -- \
    --glb data/work/m0/blender-character/character-snow.glb --out data/work/m0/blender-character/review --prefix snow

Views: front/left/back of the idle pose, the walk clip at mid-stride, the aim pose (three-quarter) and the
drive pose (side). Cycles CPU, 512x512, few samples: enough to judge facing, deformation and colours.
"""
import argparse
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector
sys.path.insert(0, str(Path(__file__).resolve().parent))
import release_pin  # noqa: E402

release_pin.require()


def set_action(rig, action):
    bpy.context.view_layer.update()
    ad = rig.animation_data or rig.animation_data_create()
    ad.action = action
    if action is not None:
        ad.action_slot = action.slots[0]


def setup_scene(scene):
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 24
    scene.cycles.use_denoising = False
    scene.cycles.use_adaptive_sampling = False
    scene.render.resolution_x = scene.render.resolution_y = 512
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "Standard"
    world = bpy.data.worlds.new("W")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.45, 0.48, 0.52, 1.0)
    world.node_tree.nodes["Background"].inputs[1].default_value = 1.0
    scene.world = world
    key = bpy.data.objects.new("KEY", bpy.data.lights.new("KEY", "SUN"))
    key.data.energy = 3.0
    key.data.angle = math.radians(8)
    key.rotation_euler = (math.radians(55), 0.0, math.radians(-30))
    scene.collection.objects.link(key)
    fill = bpy.data.objects.new("FILL", bpy.data.lights.new("FILL", "SUN"))
    fill.data.energy = 1.0
    fill.rotation_euler = (math.radians(60), 0.0, math.radians(150))
    scene.collection.objects.link(fill)
    floor = bpy.data.meshes.new("FLOOR")
    floor.from_pydata([(-4, -4, 0), (4, -4, 0), (4, 4, 0), (-4, 4, 0)], [], [(0, 1, 2, 3)])
    fobj = bpy.data.objects.new("FLOOR", floor)
    mat = bpy.data.materials.new("floor")
    mat.use_nodes = True
    mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.35, 0.35, 0.33, 1.0)
    floor.materials.append(mat)
    scene.collection.objects.link(fobj)
    # An arrow on the floor pointing -Y (the authoring "forward"): the character should face it.
    arrow = bpy.data.meshes.new("ARROW")
    arrow.from_pydata([(-0.05, -0.6, 0.002), (0.05, -0.6, 0.002), (0.0, -0.95, 0.002)], [], [(0, 1, 2)])
    amat = bpy.data.materials.new("arrow")
    amat.use_nodes = True
    amat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.9, 0.2, 0.1, 1.0)
    arrow.materials.append(amat)
    scene.collection.objects.link(bpy.data.objects.new("ARROW", arrow))
    cam_data = bpy.data.cameras.new("CAM")
    cam_data.lens = 60
    cam = bpy.data.objects.new("CAM", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    return cam


def aim_camera(cam, angle_deg, target_z, dist):
    a = math.radians(angle_deg)
    cam.location = (dist * math.sin(a), -dist * math.cos(a), target_z + 0.1)
    direction = Vector((0.0, 0.0, target_z)) - cam.location
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def render(scene, path):
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    if not path.exists():
        raise RuntimeError(f"render not written: {path}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--glb", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--prefix", required=True)
    parser.add_argument("--walk-frame", type=int, default=7)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    args.out = args.out.resolve()  # Blender resolves relative render paths itself: hand it absolute ones
    args.out.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = 30
    cam = setup_scene(scene)
    bpy.ops.import_scene.gltf(filepath=str(args.glb.resolve()), bone_heuristic="BLENDER", guess_original_bind_pose=False)
    rigs = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    meshes = [o for o in bpy.data.objects if o.type == "MESH" and o.name not in ("FLOOR", "ARROW")]
    if not rigs:
        raise SystemExit("no armature imported")
    rig = rigs[0]
    actions = {a.name: a for a in bpy.data.actions}
    info = {"armature": rig.name, "bones": len(rig.data.bones), "actions": sorted(actions),
            "meshes": [(m.name, len(m.data.polygons), [s.material.name if s.material else None for s in m.material_slots]) for m in meshes],
            "images": [(i.name, list(i.size)) for i in bpy.data.images], "renders": []}
    print(json.dumps(info), flush=True)

    def shot(name, clip, frame, angle, target_z=0.95, dist=3.6):
        act = actions.get(clip)
        set_action(rig, act)
        scene.frame_set(frame)
        aim_camera(cam, angle, target_z, dist)
        path = args.out / f"{args.prefix}-{name}.png"
        render(scene, path)
        info["renders"].append(path.name)

    shot("idle-front", "idle", 0, 0.0)
    shot("idle-left", "idle", 0, 90.0)
    shot("idle-back", "idle", 0, 180.0)
    shot(f"walk-f{args.walk_frame}-left", "walk", args.walk_frame, 90.0)
    shot(f"walk-f{args.walk_frame}-front34", "walk", args.walk_frame, 35.0)
    shot("run-f5-left", "run", 5, 90.0)
    shot("aim-front34", "aim", 0, -40.0, target_z=1.1, dist=3.0)
    shot("drive-left", "drive", 0, 90.0, target_z=0.0, dist=3.2)
    shot("death-end-front34", "death", 42, 40.0, target_z=0.3, dist=3.4)
    shot("arrested-front", "arrested", 0, 0.0)
    shot("head-front", "idle", 0, 20.0, target_z=1.6, dist=1.0)
    set_action(rig, None)
    print(json.dumps({"renders": info["renders"]}), flush=True)
    (args.out / f"{args.prefix}-review.json").write_text(json.dumps(info, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
