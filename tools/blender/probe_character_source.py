"""Read-only probe of a Blender Studio character file for build_game_character.py.

Reports deform bones (name, head, tail, parent, world space), every mesh object's vertex groups,
materials, image textures (with PNG header sizes read from disk, not loaded), UV layers, modifiers
and bounds, plus the installed glTF exporter's option names. Never saves the source file.

blender --background --factory-startup --disable-autoexec --python probe_character_source.py -- \
    --blend character.blend --output probe.json
"""
import argparse
import json
import struct
import sys
from pathlib import Path

import bpy
sys.path.insert(0, str(Path(__file__).resolve().parent))
import release_pin  # noqa: E402

release_pin.require()


def png_size(path):
    try:
        with open(path, "rb") as fh:
            head = fh.read(33)
        if head[:8] != b"\x89PNG\r\n\x1a\n" or head[12:16] != b"IHDR":
            return None
        w, h = struct.unpack(">II", head[16:24])
        return [w, h]
    except OSError:
        return None


def image_info(img):
    path = bpy.path.abspath(img.filepath, library=img.library) if img.filepath else ""
    tiles = [t.number for t in img.tiles] if img.source == "TILED" else []
    sizes = {}
    if path:
        if tiles:
            for t in tiles:
                p = path.replace("<UDIM>", str(t))
                sizes[str(t)] = png_size(p)
        else:
            sizes["0"] = png_size(path)
    return {"name": img.name, "filepath": img.filepath, "abspath": path, "source": img.source,
            "tiles": tiles, "colorspace": img.colorspace_settings.name, "packed": img.packed_file is not None,
            "exists": bool(path) and Path(path.replace("<UDIM>", str(tiles[0]) if tiles else "")).exists(),
            "sizes": sizes}


def material_info(mat):
    if mat is None:
        return None
    out = {"name": mat.name, "use_nodes": mat.use_nodes, "images": [], "nodes": [], "blend_method": mat.blend_method}
    if mat.use_nodes and mat.node_tree:
        for n in mat.node_tree.nodes:
            row = {"type": n.type, "name": n.name}
            if n.type == "TEX_IMAGE" and n.image:
                row["image"] = n.image.name
                row["links_to"] = [(l.to_node.name, l.to_socket.name) for l in n.outputs[0].links]
                out["images"].append(image_info(n.image))
            if n.type == "BSDF_PRINCIPLED":
                bc = n.inputs["Base Color"]
                row["base_color"] = list(bc.default_value)[:3]
                row["base_color_linked_from"] = [(l.from_node.name, l.from_node.type, l.from_socket.name) for l in bc.links]
                row["roughness"] = n.inputs["Roughness"].default_value
                row["alpha_linked"] = bool(n.inputs["Alpha"].links)
            if n.type == "GROUP" and n.node_tree:
                row["group"] = n.node_tree.name
                row["inputs"] = {i.name: (list(i.default_value) if hasattr(i.default_value, "__len__") else i.default_value)
                                 for i in n.inputs if hasattr(i, "default_value") and not i.links and i.type in ("RGBA", "VALUE")}
                row["linked_inputs"] = [(i.name, l.from_node.name, l.from_node.type) for i in n.inputs for l in i.links]
                # Images used inside the group
                for gn in n.node_tree.nodes:
                    if gn.type == "TEX_IMAGE" and gn.image:
                        out["images"].append({**image_info(gn.image), "via_group": n.node_tree.name,
                                              "links_to": [(l.to_node.name, l.to_socket.name) for l in gn.outputs[0].links]})
            out["nodes"].append(row)
    return out


def modifier_info(m):
    row = {"name": m.name, "type": m.type, "show_viewport": m.show_viewport, "show_render": m.show_render}
    for attr in ("levels", "render_levels", "vertex_group", "invert_vertex_group", "thickness", "offset", "object",
                 "armature", "mode", "threshold", "use_mirror_merge", "iterations", "factor", "target"):
        if hasattr(m, attr):
            v = getattr(m, attr)
            row[attr] = v.name if hasattr(v, "name") else v
    return row


def mesh_info(obj):
    me = obj.data
    groups = {g.index: g.name for g in obj.vertex_groups}
    totals = {}
    counts = {}
    for v in me.vertices:
        for g in v.groups:
            if g.weight > 1e-4:
                name = groups.get(g.group, "?")
                totals[name] = totals.get(name, 0.0) + g.weight
                counts[name] = counts.get(name, 0) + 1
    bb = [obj.matrix_world @ __import__("mathutils").Vector(c) for c in obj.bound_box]
    mn = [min(p[i] for p in bb) for i in range(3)]
    mx = [max(p[i] for p in bb) for i in range(3)]
    return {
        "name": obj.name, "data": me.name, "vertices": len(me.vertices), "polygons": len(me.polygons),
        "tris_estimate": sum(len(p.vertices) - 2 for p in me.polygons),
        "hide_viewport": obj.hide_viewport, "hide_render": obj.hide_render, "hide_get": obj.hide_get() if obj.name in bpy.context.view_layer.objects else None,
        "visible_get": obj.visible_get() if obj.name in bpy.context.view_layer.objects else None,
        "collections": [c.name for c in obj.users_collection],
        "parent": obj.parent.name if obj.parent else None, "parent_type": obj.parent_type, "parent_bone": obj.parent_bone,
        "matrix_world": [list(r) for r in obj.matrix_world], "bounds_world": [mn, mx],
        "uv_layers": [u.name for u in me.uv_layers], "materials": [material_info(s.material) for s in obj.material_slots],
        "material_slot_links": [s.link for s in obj.material_slots],
        "face_material_counts": {str(i): sum(1 for p in me.polygons if p.material_index == i) for i in range(max(1, len(obj.material_slots)))},
        "vertex_groups": [{"name": n, "vertices": counts[n], "total_weight": round(t, 2)} for n, t in sorted(totals.items())],
        "modifiers": [modifier_info(m) for m in obj.modifiers],
        "shape_keys": [k.name for k in me.shape_keys.key_blocks] if me.shape_keys else [],
        "custom_props": [k for k in obj.keys() if not k.startswith("_")],
    }


def bone_rows(rig):
    rows = []
    mw = rig.matrix_world
    for b in rig.data.bones:
        if not b.use_deform:
            continue
        rows.append({"name": b.name, "parent": b.parent.name if b.parent else None,
                     "head": [round(c, 5) for c in (mw @ b.head_local)], "tail": [round(c, 5) for c in (mw @ b.tail_local)],
                     "roll_x_axis": [round(c, 4) for c in (mw.to_3x3() @ b.x_axis)], "bbone_segments": b.bbone_segments,
                     "collections": [c.name for c in b.collections], "use_connect": b.use_connect})
    return rows


def collection_tree(coll, depth=0):
    out = [{"name": coll.name, "depth": depth, "hide_viewport": coll.hide_viewport, "hide_render": coll.hide_render,
            "objects": [o.name for o in coll.objects]}]
    for c in coll.children:
        out += collection_tree(c, depth + 1)
    return out


def layer_collection_tree(lc, depth=0):
    out = [{"name": lc.name, "depth": depth, "exclude": lc.exclude, "hide_viewport": lc.hide_viewport}]
    for c in lc.children:
        out += layer_collection_tree(c, depth + 1)
    return out


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--blend", required=True, type=Path)
    ap.add_argument("--output", required=True, type=Path)
    args = ap.parse_args(argv)
    bpy.ops.wm.open_mainfile(filepath=str(args.blend.resolve()), load_ui=False, use_scripts=False)
    scene = bpy.context.scene
    rigs = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    report = {
        "blend": str(args.blend), "blender": bpy.app.version_string,
        "scenes": [s.name for s in bpy.data.scenes], "active_scene": scene.name,
        "collections": collection_tree(scene.collection), "layer_collections": layer_collection_tree(bpy.context.view_layer.layer_collection),
        "rigs": [{"name": r.name, "bones": len(r.data.bones), "matrix_world": [list(x) for x in r.matrix_world],
                  "pose_position": r.data.pose_position, "deform_bones": bone_rows(r)} for r in rigs],
        "meshes": [mesh_info(o) for o in bpy.data.objects if o.type == "MESH"],
        "lattices": [o.name for o in bpy.data.objects if o.type == "LATTICE"],
        "images": [image_info(i) for i in bpy.data.images],
        "gltf_export_options": sorted(p.identifier for p in bpy.ops.export_scene.gltf.get_rna_type().properties),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=1), encoding="utf-8")
    print(json.dumps({"rigs": [(r["name"], len(r["deform_bones"])) for r in report["rigs"]],
                      "meshes": len(report["meshes"]), "output": str(args.output)}))


if __name__ == "__main__":
    main()
