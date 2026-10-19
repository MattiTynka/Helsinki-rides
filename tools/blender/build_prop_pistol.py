"""Original low-poly pistol prop (prop-pistol.glb) per content/assets/character.contract.json.

Built from bmesh boxes: slide, frame, grip, trigger guard and muzzle. Authored in Blender with the barrel
along -Y and +Z up; export_yup turns that into the contract's +Z barrel / +Y up. Origin at the grip centre,
overall length 0.19 m, one dark-grey material, well under 600 triangles.

  blender --background --factory-startup --disable-autoexec --python build_prop_pistol.py -- \
      --contract content/assets/character.contract.json --out data/work/m0/blender-character
"""
import argparse
import datetime
import hashlib
import json
import math
import struct
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Vector
sys.path.insert(0, str(Path(__file__).resolve().parent))
import release_pin  # noqa: E402

release_pin.require()

LENGTH = 0.19


def box(bm, centre, size, rot_x=0.0):
    verts = bmesh.ops.create_cube(bm, size=1.0)["verts"]
    m = Matrix.Translation(Vector(centre)) @ Matrix.Rotation(rot_x, 4, "X") @ Matrix.Diagonal(Vector(size).to_4d())
    bmesh.ops.transform(bm, matrix=m, verts=verts)
    return verts


def build():
    bm = bmesh.new()
    # Grip centre is the origin; the barrel points -Y. Muzzle at y = -0.12, hammer end at y = +0.07.
    box(bm, (0.0, -0.025, 0.065), (0.028, 0.19, 0.03))        # slide
    box(bm, (0.0, -0.03, 0.044), (0.026, 0.165, 0.016))       # frame rail
    box(bm, (0.0, 0.012, 0.0), (0.028, 0.034, 0.10), rot_x=math.radians(-15))  # grip, raked back
    box(bm, (0.0, -0.038, 0.01), (0.008, 0.045, 0.006))       # trigger guard bottom
    box(bm, (0.0, -0.058, 0.024), (0.008, 0.006, 0.03))       # trigger guard front
    box(bm, (0.0, -0.028, 0.026), (0.006, 0.006, 0.02))       # trigger
    box(bm, (0.0, -0.116, 0.065), (0.014, 0.008, 0.014))      # muzzle block, flush with the slide at y = -0.12
    box(bm, (0.0, -0.09, 0.085), (0.006, 0.012, 0.008))       # front sight
    box(bm, (0.0, 0.06, 0.085), (0.014, 0.008, 0.008))        # rear sight
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new("prop-pistol")
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = False
    mat = bpy.data.materials.new("pistol-dark-grey")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (0.045, 0.047, 0.05, 1.0)
    bsdf.inputs["Metallic"].default_value = 0.0
    bsdf.inputs["Roughness"].default_value = 0.8
    me.materials.append(mat)
    obj = bpy.data.objects.new("prop-pistol", me)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def read_glb(path):
    raw = path.read_bytes()
    _, _, length = struct.unpack("<III", raw[:12])
    offset, doc = 12, None
    while offset < length:
        clen, ctype = struct.unpack("<II", raw[offset:offset + 8])
        if ctype == 0x4E4F534A:
            doc = json.loads(raw[offset + 8:offset + 8 + clen].decode("utf-8"))
        offset += 8 + clen
    return doc, raw


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--contract", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    contract = json.loads(args.contract.read_text(encoding="utf-8"))
    args.out = args.out.resolve()
    args.out.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    obj = build()
    me = obj.data
    xs = [v.co.x for v in me.vertices]
    ys = [v.co.y for v in me.vertices]
    zs = [v.co.z for v in me.vertices]
    length = max(ys) - min(ys)
    tris = sum(len(p.vertices) - 2 for p in me.polygons)
    glb = args.out / contract["prop"]["file"]
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(filepath=str(glb), export_format="GLB", use_selection=True, export_yup=True, export_apply=True,
                              export_normals=True, export_texcoords=False, export_materials="EXPORT", export_animations=False,
                              export_skins=False, export_extras=False, export_cameras=False, export_lights=False,
                              export_copyright="Original procedural asset")
    doc, raw = read_glb(glb)
    acc = doc["accessors"][doc["meshes"][0]["primitives"][0]["attributes"]["POSITION"]]
    gl_tris = sum(doc["accessors"][p["indices"]]["count"] // 3 for m in doc["meshes"] for p in m["primitives"])
    entry = {
        "id": contract["prop"]["id"], "status": "EXPORTED_NOT_VERIFIED_IN_RUNTIME", "source": "procedural (bmesh), no external file",
        "glb": {"path": glb.name, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()},
        "triangles": gl_tris, "materials": [m.get("name") for m in doc.get("materials", [])], "textures": [],
        "boundsBlender": {"min": [round(min(xs), 4), round(min(ys), 4), round(min(zs), 4)], "max": [round(max(xs), 4), round(max(ys), 4), round(max(zs), 4)]},
        "boundsGltf": {"min": [round(c, 4) for c in acc["min"]], "max": [round(c, 4) for c in acc["max"]]},
        "lengthMeters": round(length, 4), "barrelAxisGltf": "+Z", "originNote": "grip centre at the origin; muzzle at glTF z=+0.12, grip base at y=-0.05",
        "deviations": [] if (gl_tris < 600 and abs(length - LENGTH) < 1e-3 and len(doc.get("materials", [])) == 1) else ["budget or length check failed"],
    }
    report_path = args.out / "blender-report.json"
    report = {"schemaVersion": 1, "kind": "blender-report", "assets": {}}
    if report_path.exists():
        try:
            report = json.loads(report_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    report.setdefault("assets", {})[entry["id"]] = entry
    report["generated"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    report["blender"] = bpy.app.version_string
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"id": entry["id"], "bytes": len(raw), "triangles": gl_tris, "length": round(length, 4), "boundsGltf": entry["boundsGltf"]}))


if __name__ == "__main__":
    main()
