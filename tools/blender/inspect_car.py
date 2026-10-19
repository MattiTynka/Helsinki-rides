"""Read-only inventory of a rigged car .blend: objects, hierarchy, bounds, counts, materials, modifiers,
constraints, armatures, images and units. Writes one JSON report; never saves the source.

blender --background --factory-startup --disable-autoexec --python inspect_car.py -- \
    --source "<file>.blend" --output car-inspect.json
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys

import bpy
from mathutils import Vector
sys.path.insert(0, str(Path(__file__).resolve().parent))
import release_pin  # noqa: E402

release_pin.require()


def rounded(v, n=4):
    return [round(float(c), n) for c in v]


def world_bounds(obj):
    if obj.type != "MESH" or not obj.data.vertices:
        return None
    corners = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
    lo = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
    hi = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
    return {"min": rounded(lo), "max": rounded(hi), "size": rounded(hi - lo), "centre": rounded((lo + hi) / 2)}


def custom_props(owner):
    out = {}
    for key in owner.keys():
        if key.startswith("_"):
            continue
        value = owner[key]
        if isinstance(value, (int, float, str, bool)):
            out[key] = value
        else:
            out[key] = repr(value)[:80]
    return out


def describe_object(obj):
    mesh = obj.data if obj.type == "MESH" else None
    d = {
        "name": obj.name, "type": obj.type, "parent": obj.parent.name if obj.parent else None,
        "parentType": obj.parent_type, "parentBone": obj.parent_bone or None,
        "collections": [c.name for c in obj.users_collection],
        "hideViewport": obj.hide_viewport, "hideRender": obj.hide_render, "hideGet": obj.hide_get() if obj.name in bpy.context.view_layer.objects else None,
        "location": rounded(obj.location), "rotationEuler": rounded(obj.rotation_euler), "scale": rounded(obj.scale),
        "worldLocation": rounded(obj.matrix_world.translation), "worldScale": rounded(obj.matrix_world.to_scale()),
        "dimensions": rounded(obj.dimensions), "worldBounds": world_bounds(obj),
        "modifiers": [{"name": m.name, "type": m.type, "show_viewport": m.show_viewport, "show_render": m.show_render,
                       **({"object": m.object.name if m.object else None} if hasattr(m, "object") else {}),
                       **({"levels": m.levels, "render_levels": m.render_levels} if m.type == "SUBSURF" else {}),
                       **({"use_axis": [bool(a) for a in m.use_axis], "mirror_object": m.mirror_object.name if m.mirror_object else None} if m.type == "MIRROR" else {}),
                       **({"ratio": m.ratio} if m.type == "DECIMATE" else {}),
                       **({"thickness": m.thickness} if m.type == "SOLIDIFY" else {}),
                       **({"width": m.width, "segments": m.segments} if m.type == "BEVEL" else {}),
                       } for m in obj.modifiers],
        "constraints": [{"name": c.name, "type": c.type, "target": getattr(getattr(c, "target", None), "name", None)} for c in obj.constraints],
        "customProps": custom_props(obj),
        "drivers": len(obj.animation_data.drivers) if obj.animation_data else 0,
        "action": obj.animation_data.action.name if obj.animation_data and obj.animation_data.action else None,
    }
    if mesh:
        mesh_tris = sum(len(p.vertices) - 2 for p in mesh.polygons)
        d.update({
            "vertices": len(mesh.vertices), "faces": len(mesh.polygons), "trianglesBase": mesh_tris,
            "materials": [m.name if m else None for m in mesh.materials],
            "uvLayers": [uv.name for uv in mesh.uv_layers], "colorAttributes": [c.name for c in mesh.color_attributes],
            "vertexGroups": [g.name for g in obj.vertex_groups][:40], "vertexGroupCount": len(obj.vertex_groups),
            "shapeKeys": [k.name for k in mesh.shape_keys.key_blocks] if mesh.shape_keys else [],
            "meshUsers": mesh.users, "meshName": mesh.name,
        })
    if obj.type == "ARMATURE":
        bones = obj.data.bones
        d.update({
            "boneCount": len(bones), "bones": [b.name for b in bones][:200],
            "poseBoneConstraints": sum(len(pb.constraints) for pb in obj.pose.bones),
            "poseDrivers": len(obj.animation_data.drivers) if obj.animation_data else 0,
            "posePosition": obj.data.pose_position,
            "armatureProps": custom_props(obj.data),
        })
    if obj.type == "EMPTY":
        d.update({"emptyDisplayType": obj.empty_display_type, "emptyDisplaySize": obj.empty_display_size,
                  "instanceCollection": obj.instance_collection.name if obj.instance_collection else None})
    return d


def describe_material(mat):
    images = []
    nodes = []
    if mat.node_tree:
        for n in mat.node_tree.nodes:
            nodes.append(n.type)
            if n.type == "TEX_IMAGE" and n.image:
                images.append(n.image.name)
    principled = None
    if mat.node_tree:
        for n in mat.node_tree.nodes:
            if n.type == "BSDF_PRINCIPLED":
                principled = {k: rounded(n.inputs[k].default_value) if hasattr(n.inputs[k].default_value, "__len__") else round(float(n.inputs[k].default_value), 3)
                              for k in ("Base Color", "Metallic", "Roughness", "Alpha", "Emission Strength", "Coat Weight") if k in n.inputs}
                break
    return {"name": mat.name, "users": mat.users, "useNodes": mat.use_nodes, "nodeTypes": sorted(set(nodes)),
            "images": sorted(set(images)), "principled": principled, "blendMethod": getattr(mat, "surface_render_method", None),
            "diffuseColor": rounded(mat.diffuse_color)}


def islands(obj, max_entries=600):
    """Connected components of a mesh (world space): triangle count, bounds, centroid and material histogram."""
    import numpy as np
    mesh = obj.data
    nv, nf = len(mesh.vertices), len(mesh.polygons)
    if nv == 0:
        return []
    co = np.empty(nv * 3)
    mesh.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    m = np.array(obj.matrix_world)
    world = co @ m[:3, :3].T + m[:3, 3]
    edges = np.empty(len(mesh.edges) * 2, dtype=np.int64)
    mesh.edges.foreach_get("vertices", edges)
    edges = edges.reshape(-1, 2)
    parent = np.arange(nv)

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for a, b in edges.tolist():
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra
    labels = np.array([find(i) for i in range(nv)])
    _, labels = np.unique(labels, return_inverse=True)
    n = labels.max() + 1
    loop_total = np.empty(nf, dtype=np.int64)
    loop_start = np.empty(nf, dtype=np.int64)
    mesh.polygons.foreach_get("loop_total", loop_total)
    mesh.polygons.foreach_get("loop_start", loop_start)
    loop_verts = np.empty(len(mesh.loops), dtype=np.int64)
    mesh.loops.foreach_get("vertex_index", loop_verts)
    face_label = labels[loop_verts[loop_start]]
    mat_index = np.empty(nf, dtype=np.int64)
    mesh.polygons.foreach_get("material_index", mat_index)
    nmat = max(1, len(mesh.materials))
    tris = np.bincount(face_label, weights=loop_total - 2, minlength=n)
    faces = np.bincount(face_label, minlength=n)
    verts = np.bincount(labels, minlength=n)
    hist = np.bincount(face_label * nmat + np.minimum(mat_index, nmat - 1), minlength=n * nmat).reshape(n, nmat)
    lo = np.full((n, 3), np.inf)
    hi = np.full((n, 3), -np.inf)
    np.minimum.at(lo, labels, world)
    np.maximum.at(hi, labels, world)
    centroid = np.zeros((n, 3))
    np.add.at(centroid, labels, world)
    centroid /= np.maximum(verts, 1)[:, None]
    names = [mt.name if mt else "None" for mt in mesh.materials] or ["None"]
    order = np.argsort(-tris)
    out = []
    for i in order[:max_entries]:
        mats = {names[k]: int(hist[i, k]) for k in np.nonzero(hist[i])[0]}
        out.append({"id": int(i), "tris": int(tris[i]), "faces": int(faces[i]), "verts": int(verts[i]),
                    "min": rounded(lo[i], 3), "max": rounded(hi[i], 3), "size": rounded(hi[i] - lo[i], 3),
                    "centroid": rounded(centroid[i], 3), "materials": mats})
    return {"count": int(n), "listed": len(out), "islands": out}


def bones_world(obj):
    m = obj.matrix_world
    out = []
    for b in obj.data.bones:
        head, tail = m @ b.head_local, m @ b.tail_local
        out.append({"name": b.name, "parent": b.parent.name if b.parent else None, "head": rounded(head), "tail": rounded(tail),
                    "deform": b.use_deform, "length": round(float((tail - head).length), 4)})
    return out


def render_views(out_dir, targets):
    """Workbench stills of the given mesh objects from four directions; nothing else is rendered."""
    from mathutils import Euler
    import math
    scene = bpy.context.scene
    for o in bpy.data.objects:
        o.hide_render = o not in targets
    lo, hi = None, None
    for o in targets:
        b = world_bounds(o)
        if not b:
            continue
        l, h = Vector(b["min"]), Vector(b["max"])
        lo = l if lo is None else Vector((min(lo.x, l.x), min(lo.y, l.y), min(lo.z, l.z)))
        hi = h if hi is None else Vector((max(hi.x, h.x), max(hi.y, h.y), max(hi.z, h.z)))
    centre, radius = (lo + hi) / 2, (hi - lo).length / 2
    cam_data = bpy.data.cameras.new("InspectCam")
    cam = bpy.data.objects.new("InspectCam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "MATERIAL"
    scene.display.shading.show_cavity = False
    scene.render.resolution_x, scene.render.resolution_y = 640, 400
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    views = {"front-left": (-0.8, -1.0, 0.45), "rear-right": (0.8, 1.0, 0.45), "side-left": (-1.0, 0.0, 0.15), "top": (0.0, -0.001, 1.0)}
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    for name, d in views.items():
        direction = Vector(d).normalized()
        cam.location = centre + direction * radius * 2.6
        cam.rotation_euler = (centre - cam.location).to_track_quat("-Z", "Y").to_euler()
        cam_data.lens = 45
        scene.render.filepath = str(out_dir / f"source-{name}.png")
        bpy.ops.render.render(write_still=True)
        written.append(scene.render.filepath)
    return written


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--islands", nargs="*", default=[], help="mesh object names to split into connected parts")
    parser.add_argument("--render-dir", type=Path, default=None, help="write Workbench stills of the visible meshes here")
    parser.add_argument("--rest-pose", action="store_true", help="put every armature in rest position before measuring")
    parser.add_argument("--max-islands", type=int, default=600, help="largest islands listed per object")
    args = parser.parse_args(argv)
    source = args.source.resolve()
    args.output = args.output.resolve()
    if args.render_dir:
        args.render_dir = args.render_dir.resolve()  # Blender resolves relative render paths against the drive root
    sha = hashlib.sha256(source.read_bytes()).hexdigest()
    bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False, use_scripts=False)
    scene = bpy.context.scene
    unit = scene.unit_settings
    if args.rest_pose:
        for o in bpy.data.objects:
            if o.type == "ARMATURE":
                o.data.pose_position = "REST"
        bpy.context.view_layer.update()

    def collection_tree(col):
        return {"name": col.name, "objects": [o.name for o in col.objects],
                "hideViewport": col.hide_viewport, "hideRender": col.hide_render,
                "children": [collection_tree(c) for c in col.children]}

    def layer_tree(lc):
        return {"name": lc.name, "exclude": lc.exclude, "hideViewport": lc.hide_viewport,
                "children": [layer_tree(c) for c in lc.children]}

    objects = [describe_object(o) for o in bpy.data.objects]
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    all_lo, all_hi = None, None
    for o in meshes:
        b = world_bounds(o)
        if not b:
            continue
        lo, hi = Vector(b["min"]), Vector(b["max"])
        all_lo = lo if all_lo is None else Vector((min(all_lo.x, lo.x), min(all_lo.y, lo.y), min(all_lo.z, lo.z)))
        all_hi = hi if all_hi is None else Vector((max(all_hi.x, hi.x), max(all_hi.y, hi.y), max(all_hi.z, hi.z)))
    report = {
        "source": str(source), "sha256": sha, "bytes": source.stat().st_size, "blender": bpy.app.version_string,
        "fileVersion": list(bpy.data.version),
        "units": {"system": unit.system, "scaleLength": unit.scale_length, "lengthUnit": unit.length_unit},
        "scene": {"name": scene.name, "frameStart": scene.frame_start, "frameEnd": scene.frame_end, "frameCurrent": scene.frame_current,
                  "cameras": [o.name for o in bpy.data.objects if o.type == "CAMERA"]},
        "counts": {"objects": len(bpy.data.objects), "meshes": len(meshes), "armatures": sum(1 for o in bpy.data.objects if o.type == "ARMATURE"),
                   "empties": sum(1 for o in bpy.data.objects if o.type == "EMPTY"), "materials": len(bpy.data.materials),
                   "images": len(bpy.data.images), "actions": len(bpy.data.actions),
                   "trianglesBaseTotal": sum(o["trianglesBase"] for o in objects if o["type"] == "MESH"),
                   "verticesTotal": sum(o["vertices"] for o in objects if o["type"] == "MESH")},
        "allMeshWorldBounds": {"min": rounded(all_lo), "max": rounded(all_hi), "size": rounded(all_hi - all_lo)} if all_lo else None,
        "collections": collection_tree(scene.collection),
        "viewLayer": layer_tree(bpy.context.view_layer.layer_collection),
        "objects": objects,
        "materials": [describe_material(m) for m in bpy.data.materials],
        "images": [{"name": im.name, "size": list(im.size), "filepath": im.filepath, "packed": im.packed_file is not None,
                    "colorspace": im.colorspace_settings.name, "users": im.users, "hasData": im.has_data, "source": im.source}
                   for im in bpy.data.images],
        "actions": [{"name": a.name, "frameRange": rounded(a.frame_range), "users": a.users} for a in bpy.data.actions],
        "texts": [t.name for t in bpy.data.texts],
        "libraries": [l.filepath for l in bpy.data.libraries],
        "restPose": args.rest_pose,
        "bones": {o.name: bones_world(o) for o in bpy.data.objects if o.type == "ARMATURE"},
        "islands": {name: islands(bpy.data.objects[name], args.max_islands) for name in args.islands if name in bpy.data.objects},
    }
    if args.render_dir:
        targets = [o for o in meshes if o.name in args.islands] if args.islands else meshes
        report["renders"] = render_views(args.render_dir, targets)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=1, default=str), encoding="utf-8")
    print(json.dumps({"objects": report["counts"], "units": report["units"], "bounds": report["allMeshWorldBounds"]}))


if __name__ == "__main__":
    main()
