"""Headless Blender job: build the graybox car from its asset contract and export a GLB.

The contract states positions in the runtime asset frame (+Y up, +Z forward, +X left). Blender is Z-up,
and the glTF exporter maps Blender (x, y, z) -> glTF (x, z, -y), so contract (gx, gy, gz) is authored at
Blender (gx, -gz, gy): the car faces Blender -Y. Wheels are separate objects with their origin at the
hub; sockets are empties. The collider proxy is built for inspection but excluded from the export.
"""
import argparse
import hashlib
import json
from math import radians
from pathlib import Path
import sys

import bpy


def to_blender(position):
    gx, gy, gz = position
    return (gx, -gz, gy)


def size_to_blender(size):
    sx, sy, sz = size
    return (sx, sz, sy)


def flat_material(name, colour, emissive=False):
    material = bpy.data.materials.new(name)
    if material.node_tree is None:
        material.use_nodes = True
    principled = next(n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    principled.inputs["Base Color"].default_value = colour
    principled.inputs["Roughness"].default_value = 0.6
    if emissive:
        principled.inputs["Emission Color"].default_value = colour
        principled.inputs["Emission Strength"].default_value = 1.0
    return material


def box(name, centre, size, material, coll):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=to_blender(centre))
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = size_to_blender(size)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if material:
        obj.data.materials.append(material)
    move_to(obj, coll)
    return obj


def move_to(obj, coll):
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    coll.objects.link(obj)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--contract", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    contract = json.loads(args.contract.read_text(encoding="utf-8"))
    args.out.mkdir(parents=True, exist_ok=False)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    visual = bpy.data.collections.new("VISUAL"); scene.collection.children.link(visual)
    collision = bpy.data.collections.new("COLLISION"); scene.collection.children.link(collision)

    root = bpy.data.objects.new("CAR_ROOT", None)  # pivot: ground plane, centred between axles
    root["role"] = "asset-root"
    root["assetId"] = contract["assetId"]
    visual.objects.link(root)

    colours = contract["colours"]
    body_mat = flat_material("car_body", colours["body"])
    cabin_mat = flat_material("car_cabin", colours["cabin"])
    tyre_mat = flat_material("car_tyre", colours["tyre"])

    lower = box("CAR_BODY", contract["body"]["lower"]["centre"], contract["body"]["lower"]["size"], body_mat, visual)
    cabin = box("CAR_CABIN", contract["body"]["cabin"]["centre"], contract["body"]["cabin"]["size"], cabin_mat, visual)
    bpy.ops.object.select_all(action="DESELECT")
    cabin.select_set(True); lower.select_set(True)
    bpy.context.view_layer.objects.active = lower
    bpy.ops.object.join()  # one body mesh, two materials
    lower.parent = root

    for side, spec in contract["lights"].items():
        material = flat_material(f"car_light_{side}", spec["colour"], emissive=True)
        for i, centre in enumerate(spec["centres"]):
            light = box(f"CAR_LIGHT_{side.upper()}_{i}", centre, spec["size"], material, visual)
            light.parent = root

    wheel = contract["wheel"]
    sockets = {s["node"]: s for s in contract["sockets"]}
    for name in ("WHEEL_FL", "WHEEL_FR", "WHEEL_RL", "WHEEL_RR"):
        bpy.ops.mesh.primitive_cylinder_add(vertices=20, radius=wheel["radius"], depth=wheel["width"],
                                            location=to_blender(sockets[name]["position"]), rotation=(0.0, radians(90), 0.0))
        obj = bpy.context.active_object
        obj.name = name
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)  # axle along X, origin at hub
        obj.data.materials.append(tyre_mat)
        obj["role"] = "wheel"
        move_to(obj, visual)
        obj.parent = root

    for name, socket in sockets.items():
        if name.startswith("WHEEL_"):
            continue
        empty = bpy.data.objects.new(name, None)
        empty.empty_display_type = "PLAIN_AXES"
        empty.location = to_blender(socket["position"])
        empty["role"] = "socket"
        empty["purpose"] = socket["purpose"]
        visual.objects.link(empty)
        empty.parent = root

    collider = contract["collider"]
    proxy = box("CAR_COLLIDER", collider["centre"], [2 * h for h in collider["halfExtents"]], None, collision)
    proxy.display_type = "WIRE"

    bpy.ops.object.select_all(action="DESELECT")
    for obj in visual.all_objects:
        obj.select_set(True)
    glb = args.out / "car-graybox.glb"
    export_options = dict(filepath=str(glb), export_format="GLB", use_selection=True, export_yup=True,
                          export_apply=False, export_normals=True, export_texcoords=False, export_tangents=False,
                          export_vertex_color="NONE", export_materials="EXPORT", export_extras=True,
                          export_cameras=False, export_lights=False, export_copyright="Original procedural asset")
    bpy.ops.export_scene.gltf(**export_options)
    bpy.ops.wm.save_as_mainfile(filepath=str(args.out / "car-graybox.blend"), compress=True)
    data = glb.read_bytes()
    report = {"status": "EXPORTED_NOT_VERIFIED_IN_RUNTIME", "blender": bpy.app.version_string,
              "assetId": contract["assetId"],
              "exportOptions": {k: v for k, v in export_options.items() if k != "filepath"},
              "output": {"path": glb.name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}}
    (args.out / "blender-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report["output"]))


if __name__ == "__main__":
    main()
