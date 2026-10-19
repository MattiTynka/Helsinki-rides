"""Headless Blender job: an authored landmark model (binary STL) -> one baked, single-material GLB in the runtime
frame, plus preview renders and landmark-model.json (decision 0005).

The STL is placed by the placement.json that tools/world/place_landmark_model.ts writes: model point modelPivot maps
to translation, after a per-axis scale and a turn about Z (working frame X east, Y north, Z up, metres from the
world origin). Coincident vertices are merged and every face gets one of three flat materials by rule, in model
units before placement:
  plinth  face centre below the base plate's top (--plate above the model's lowest point);
  roof    face normal Z >= --roof-min-nz and centre at least --roof-min-height above the lowest point (keeps the
          column bases' mouldings plaster), or the face lies on a dome: within radius r of a dome axis and at or
          above the dome's springing height (--domes "x,y,r,z;..." measured from the STL);
  wall    everything else.
Wall and roof colours come from placement.json (the LoD2 building's own texels through the facade grade); the
plinth colour is given. Light is then baked into one texture with Cycles: a uniform white sky and a sun at the
runtime's azimuth and elevation, on a ground plane at the base height, so the model carries baked light the way
the facade photos do and the runtime treats it as a `bakedLighting` material.

Usage (through the skill runner):
  --script tools/blender/build_landmark_model.py -- --placement <placement.json> --id helsinki-cathedral \
    --plinth 150,146,138 --domes "0,0,6.9,28.4;11.6,11.5,3.0,15.6;..." --out <new dir>
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector
sys.path.insert(0, str(Path(__file__).resolve().parent))
import release_pin  # noqa: E402

release_pin.require()

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument("--placement", required=True)
ap.add_argument("--id", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--plinth", required=True, help="sRGB 8-bit r,g,b")
ap.add_argument("--domes", required=True, help="x,y,radius,zmin per dome in model units, ';'-separated")
ap.add_argument("--plate", type=float, default=1.5)
ap.add_argument("--roof-min-nz", type=float, default=0.25)
ap.add_argument("--roof-min-height", type=float, default=4.0)
ap.add_argument("--texture-size", type=int, default=2048)
ap.add_argument("--samples", type=int, default=128)
ap.add_argument("--sun-azimuth", type=float, default=127.0)
ap.add_argument("--sun-elevation", type=float, default=38.0)
ap.add_argument("--sun-strength", type=float, default=1.5)
ap.add_argument("--sky-strength", type=float, default=1.0)
ap.add_argument("--merge", type=float, default=0.001, help="merge distance in model units")
args = ap.parse_args(argv)

out = Path(args.out).resolve()  # Blender resolves relative image and render paths against the drive root
if out.exists():
    raise SystemExit(f"{out} exists; the job writes into a new directory")
out.mkdir(parents=True)
placement = json.loads(Path(args.placement).read_text(encoding="utf-8"))
model_path = Path(placement["model"]["file"])
model_bytes = model_path.read_bytes()
if hashlib.sha256(model_bytes).hexdigest() != placement["model"]["sha256"]:
    raise SystemExit(f"{model_path} does not match the placement's hash")
domes = [tuple(float(v) for v in d.split(",")) for d in args.domes.split(";") if d.strip()]
srgb = lambda c: [((v / 255.0 + 0.055) / 1.055) ** 2.4 if v / 255.0 > 0.04045 else v / 255.0 / 12.92 for v in c]
colours = {"wall": placement["colours"]["wall"], "roof": placement["colours"]["roof"], "plinth": [int(v) for v in args.plinth.split(",")]}

# ---- scene ----
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.wm.stl_import(filepath=str(model_path))
obj = bpy.context.selected_objects[0]
obj.name = args.id
me = obj.data

# ---- merge, classify (model units), place ----
bm = bmesh.new()
bm.from_mesh(me)
merged_before = len(bm.verts)
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=args.merge)

bmesh.ops.recalc_face_normals(bm, faces=bm.faces)  # a few STL faces point inwards and bake black
zmin = min(v.co.z for v in bm.verts)
bm.normal_update()
names = ["wall", "roof", "plinth"]
counts = {n: 0 for n in names}
for f in bm.faces:
    c = f.calc_center_median()
    if c.z < zmin + args.plate:
        k = 2
    elif (f.normal.z >= args.roof_min_nz and c.z >= zmin + args.roof_min_height) or any(math.hypot(c.x - dx, c.y - dy) <= r and c.z >= dz for dx, dy, r, dz in domes):
        k = 1
    else:
        k = 0
    f.material_index = k
    counts[names[k]] += 1
t = placement["transform"]
pivot, scale, rot, trans = Vector(t["modelPivot"]), t["scale"], math.radians(t["rotationDeg"]), Vector(t["translation"])
place = Matrix.Translation(trans) @ Matrix.Rotation(rot, 4, "Z") @ Matrix.Diagonal((scale[0], scale[1], scale[2], 1.0)) @ Matrix.Translation(-pivot)
bm.transform(place)
bm.to_mesh(me)
bm.free()
me.shade_smooth()
me.set_sharp_from_angle(angle=math.radians(30))

for n in names:
    m = bpy.data.materials.new(n)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*srgb(colours[n]), 1.0)
    bsdf.inputs["Roughness"].default_value = 1.0
    me.materials.append(m)

# ---- UVs ----
bpy.context.view_layer.objects.active = obj
obj.select_set(True)
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.002, area_weight=0.0, scale_to_bounds=False)
bpy.ops.object.mode_set(mode="OBJECT")

# ---- bake light: white sky, sun, ground plane at the base ----
base = trans.z
bpy.ops.mesh.primitive_plane_add(size=400, location=(trans.x, trans.y, base - 0.02))
ground = bpy.context.active_object
gm = bpy.data.materials.new("ground")
gm.use_nodes = True
gm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*srgb(colours["plinth"]), 1.0)
ground.data.materials.append(gm)
world = bpy.data.worlds.new("sky")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (1, 1, 1, 1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = args.sky_strength
bpy.context.scene.world = world
sun_data = bpy.data.lights.new("sun", "SUN")
sun_data.energy = args.sun_strength
sun_data.angle = math.radians(1.0)
sun = bpy.data.objects.new("sun", sun_data)
bpy.context.scene.collection.objects.link(sun)
az, el = math.radians(args.sun_azimuth), math.radians(args.sun_elevation)
towards_sun = Vector((math.sin(az) * math.cos(el), math.cos(az) * math.cos(el), math.sin(el)))  # X east, Y north
sun.rotation_euler = towards_sun.to_track_quat("Z", "Y").to_euler()

scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = args.samples
scene.view_settings.view_transform = "Standard"
size = args.texture_size
img = bpy.data.images.new(f"{args.id}_baked", size, size, alpha=False)
for m in me.materials:
    node = m.node_tree.nodes.new("ShaderNodeTexImage")
    node.image = img
    m.node_tree.nodes.active = node
bpy.ops.object.select_all(action="DESELECT")
obj.select_set(True)
bpy.context.view_layer.objects.active = obj
bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT", "COLOR"}, margin=6, use_clear=True)
img.filepath_raw = str(out / f"{args.id}-baked.png")
img.file_format = "PNG"
img.save()

# ---- one material with the baked texture ----
baked = bpy.data.materials.new(f"{args.id}_baked")
baked.use_nodes = True
nt = baked.node_tree
tex = nt.nodes.new("ShaderNodeTexImage")
tex.image = img
bsdf = nt.nodes["Principled BSDF"]
bsdf.inputs["Roughness"].default_value = 1.0
nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
me.materials.clear()
me.materials.append(baked)
for p in me.polygons:
    p.material_index = 0

# ---- previews (baked texture under the same sky, no sun: what the bake holds) ----
sun_data.energy = 0.0
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0
scene.cycles.samples = 16
scene.render.resolution_x, scene.render.resolution_y = 960, 640
emit = nt.nodes.new("ShaderNodeEmission")
nt.links.new(tex.outputs["Color"], emit.inputs["Color"])
nt.links.new(emit.outputs["Emission"], nt.nodes["Material Output"].inputs["Surface"])
cam_data = bpy.data.cameras.new("cam")
cam_data.lens = 28
cam = bpy.data.objects.new("cam", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
previews = {}
for name, (dx, dy, dz) in {"south": (0, -95, 3.5), "south-west": (-70, -70, 20), "east": (95, 0, 3.5)}.items():
    cam.location = Vector((trans.x + dx, trans.y + dy, base + dz))
    target = Vector((trans.x, trans.y, base + 22))
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = str(out / f"preview-{name}.png")
    bpy.ops.render.render(write_still=True)
    previews[name] = f"preview-{name}.png"
nt.links.new(bsdf.outputs["BSDF"], nt.nodes["Material Output"].inputs["Surface"])
nt.nodes.remove(emit)

# ---- export: the model alone, Y up (runtime frame: X east, Y up, Z south) ----
bpy.data.objects.remove(ground)
bpy.ops.object.select_all(action="DESELECT")
obj.select_set(True)
bpy.context.view_layer.objects.active = obj
glb = out / f"{args.id}.glb"
bpy.ops.export_scene.gltf(filepath=str(glb), export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                          export_texcoords=True, export_normals=True, export_materials="EXPORT", export_image_format="AUTO",
                          export_extras=False, export_cameras=False, export_lights=False)
lo = [min(v.co[i] for v in me.vertices) for i in range(3)]
hi = [max(v.co[i] for v in me.vertices) for i in range(3)]
report = {
    "schemaVersion": 1, "id": args.id, "blender": bpy.app.version_string,
    "source": {"file": str(model_path).replace("\\", "/"), "sha256": placement["model"]["sha256"]},
    "placement": {"file": str(Path(args.placement)).replace("\\", "/"), "sha256": hashlib.sha256(Path(args.placement).read_bytes()).hexdigest(), "vtj": placement["building"]["vtj"]},
    "glb": {"file": glb.name, "sha256": hashlib.sha256(glb.read_bytes()).hexdigest(), "bytes": glb.stat().st_size},
    "mesh": {"vertices": len(me.vertices), "verticesBeforeMerge": merged_before, "triangles": sum(len(p.vertices) - 2 for p in me.polygons),
             "boundsWorking": {"min": lo, "max": hi}},
    "classification": {"plate": args.plate, "roofMinNormalZ": args.roof_min_nz, "roofMinHeight": args.roof_min_height, "domes": domes, "faces": counts},
    "colours": colours,
    "bake": {"texture": f"{args.id}-baked.png", "size": size, "samples": args.samples, "type": "DIFFUSE direct+indirect+colour",
             "sky": {"colour": [1, 1, 1], "strength": args.sky_strength}, "sun": {"azimuthDeg": args.sun_azimuth, "elevationDeg": args.sun_elevation, "strength": args.sun_strength},
             "groundPlane": {"height": base - 0.02, "colour": colours["plinth"]}},
    "previews": previews,
}
(out / "landmark-model.json").write_text(json.dumps(report, indent=1) + "\n", encoding="utf-8")
print(json.dumps({"faces": counts, "triangles": report["mesh"]["triangles"], "vertices": report["mesh"]["vertices"], "glbBytes": report["glb"]["bytes"]}))
