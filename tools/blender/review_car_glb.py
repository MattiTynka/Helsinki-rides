"""Re-import a vehicle GLB into a fresh Blender scene, list its node transforms and render review stills.

The glTF importer's default axis conversion turns the asset's +Y up / +Z forward into Blender +Z up / -Y
forward, so a car that faces +Z in the file must face -Y here: headlights at the most negative Y, the
front wheels (WHEEL_F*) at negative Y, the driver's seat on +X. A grey ground plane at z = 0 shows
whether the tyres touch the ground. Positions are also printed in glTF axes (x, z, -y).

blender --background --factory-startup --disable-autoexec --python review_car_glb.py -- \
    --glb vehicle.glb --out-dir review/ --prefix lumi
"""
import argparse
import json
import math
from pathlib import Path
import sys

import bpy
from mathutils import Vector
sys.path.insert(0, str(Path(__file__).resolve().parent))
import release_pin  # noqa: E402

release_pin.require()

VIEWS = {  # name: direction from the car centre to the camera (Blender axes)
    "front-left": (0.85, -1.0, 0.42), "rear-right": (-0.85, 1.0, 0.42), "side-left": (1.0, 0.0, 0.12), "top": (0.0, -0.001, 1.0)}


def to_gltf(p):
    return [round(p[0], 4), round(p[2], 4), round(-p[1], 4)]


def world_bounds(obj):
    corners = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
    lo = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
    hi = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
    return lo, hi


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--glb", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--prefix", default="car")
    parser.add_argument("--size", type=int, nargs=2, default=(640, 400))
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    glb, out_dir = args.glb.resolve(), args.out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(glb))
    scene = bpy.context.scene
    imported = [o for o in bpy.data.objects]
    nodes = {}
    for o in imported:
        loc = o.matrix_world.translation
        entry = {"type": o.type, "parent": o.parent.name if o.parent else None, "blender": [round(c, 4) for c in loc],
                 "gltf": to_gltf(loc), "extras": {k: (o[k] if isinstance(o[k], (int, float, str, bool)) else str(o[k]))
                                                   for k in o.keys() if not k.startswith("_")}}
        if o.type == "MESH":
            entry["triangles"] = sum(len(p.vertices) - 2 for p in o.data.polygons)
            entry["materials"] = [m.name for m in o.data.materials if m]
            lo, hi = world_bounds(o)
            entry["worldBoundsBlender"] = {"min": [round(c, 4) for c in lo], "max": [round(c, 4) for c in hi]}
        nodes[o.name] = entry
    meshes = [o for o in imported if o.type == "MESH"]
    lo_all, hi_all = None, None
    for o in meshes:
        lo, hi = world_bounds(o)
        lo_all = lo if lo_all is None else Vector((min(lo_all.x, lo.x), min(lo_all.y, lo.y), min(lo_all.z, lo.z)))
        hi_all = hi if hi_all is None else Vector((max(hi_all.x, hi.x), max(hi_all.y, hi.y), max(hi_all.z, hi.z)))
    summary = {"glb": str(glb), "nodes": nodes, "materials": sorted(m.name for m in bpy.data.materials),
               "images": [im.name for im in bpy.data.images], "triangles": sum(nodes[o.name]["triangles"] for o in meshes),
               "allMeshBoundsBlender": {"min": [round(c, 4) for c in lo_all], "max": [round(c, 4) for c in hi_all]},
               "expect": "car faces -Y in Blender: WHEEL_F* at negative Y, headlight sockets at the most negative Y"}

    # Ground plane and lighting, then four stills.
    bpy.ops.mesh.primitive_plane_add(size=14.0, location=(0.0, 0.0, 0.0))
    ground = bpy.context.active_object
    ground.name = "REVIEW_GROUND"
    gm = bpy.data.materials.new("review_ground")
    gm.use_nodes = True
    gm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.35, 0.36, 0.37, 1.0)
    gm.diffuse_color = (0.35, 0.36, 0.37, 1.0)
    ground.data.materials.append(gm)
    sun = bpy.data.objects.new("REVIEW_SUN", bpy.data.lights.new("REVIEW_SUN", "SUN"))
    sun.data.energy = 3.0
    sun.rotation_euler = (math.radians(50), 0.0, math.radians(-35))
    scene.collection.objects.link(sun)
    world = bpy.data.worlds.new("REVIEW_WORLD")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.55, 0.6, 0.7, 1.0)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.8
    scene.world = world
    engine = None
    for candidate in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT", "BLENDER_WORKBENCH"):
        try:
            scene.render.engine = candidate
            engine = candidate
            break
        except TypeError:
            continue
    if engine == "BLENDER_WORKBENCH":
        scene.display.shading.light = "STUDIO"
        scene.display.shading.color_type = "MATERIAL"
    scene.render.resolution_x, scene.render.resolution_y = args.size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    centre = (lo_all + hi_all) / 2
    radius = (hi_all - lo_all).length / 2
    cam_data = bpy.data.cameras.new("REVIEW_CAM")
    cam_data.lens = 40
    cam = bpy.data.objects.new("REVIEW_CAM", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    stills = []
    for name, d in VIEWS.items():
        direction = Vector(d).normalized()
        cam.location = centre + direction * radius * 2.4
        cam.rotation_euler = (centre - cam.location).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = str(out_dir / f"{args.prefix}-{name}.png")
        try:
            bpy.ops.render.render(write_still=True)
        except RuntimeError as error:  # no GPU context: fall back to Workbench once
            if engine == "BLENDER_WORKBENCH":
                raise
            scene.render.engine = engine = "BLENDER_WORKBENCH"
            scene.display.shading.light = "STUDIO"
            scene.display.shading.color_type = "MATERIAL"
            summary["renderFallback"] = str(error)
            bpy.ops.render.render(write_still=True)
        stills.append(scene.render.filepath)
    summary["engine"] = engine
    summary["stills"] = stills
    (out_dir / f"{args.prefix}-review.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"engine": engine, "triangles": summary["triangles"], "materials": summary["materials"],
                      "images": summary["images"], "bounds": summary["allMeshBoundsBlender"],
                      "wheels": {n: nodes[n]["gltf"] for n in nodes if n.startswith("WHEEL_")}}))


if __name__ == "__main__":
    main()
