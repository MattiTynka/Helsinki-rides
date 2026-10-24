"""Count what a render cannot show for mesh objects in a .blend or GLB, against a JSON spec.

blender --background --factory-startup --disable-autoexec --python-exit-code 1 --python mesh_census.py -- \
    (--blend scene.blend | --glb asset.glb) --spec census.json --output census-report.json [--fail-on-threshold]

Spec (lengths are Blender units, which the glTF exporter writes 1:1 as metres):
{
  "require_version": "5.2",
  "objects": ["COL_body"], "prefix": "COL_",
  "evaluated": true,
  "weld_distance": 1e-6,
  "degenerate_area": 1e-8,
  "self_overlap": {"enabled": true, "max_faces": 200000, "epsilon": 1e-5},
  "limits": {"nonmanifold_interior_edges": 0, "flipped_edges": 0, "loose_vertices": 0, "wire_edges": 0,
             "degenerate_faces": 0, "self_overlap_pairs": 0, "shells": 1},
  "dimensions": [{"object": "COL_body", "size": [4.5, 1.8, 1.4], "tolerance": 0.01}],
  "unit_scale": 1.0,
  "applied_transforms": true
}
Without "objects"/"prefix" every mesh object in the scene (for --glb: every imported mesh) is
measured. "evaluated" (default) measures modifier results through the depsgraph, as an export
with apply-modifiers sees them; false measures the stored mesh. "weld_distance" (default 1e-6 for
--glb, 0 for --blend) merges co-located vertices in the measured copy only: glTF stores a separate
vertex per normal or UV discontinuity and the importer cannot rejoin vertices whose normals differ,
so unwelded a flat-shaded box reads as six open shells. Boundary edges of open sheets
(terrain tiles, foliage cards, photogrammetry) are counted apart from edges shared by three or
more faces, so open visual meshes can be judged without demanding manifold solids. Dimensions
are the measured mesh extents times object scale. A limit on a count that was not measured
(self-overlap skipped above max_faces) fails. Counts prove topology, transforms and size; they
do not prove appearance, collision behaviour, materials or glTF conformance.
"""
import argparse
import json
import os
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils.bvhtree import BVHTree
import numpy as np

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from census_spec import judge, validate_spec  # noqa: E402


def report_path(target, report):
    """Path relative to the report's folder (a file on another drive by name only), never local folders."""
    try:
        return os.path.relpath(Path(target).resolve(), Path(report).resolve().parent)
    except ValueError:
        return Path(target).name


def shells(bm):
    """Connected face components; faces joined only through a shared vertex count as one shell."""
    parent = list(range(len(bm.faces)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for vert in bm.verts:
        faces = list(vert.link_faces)
        if len(faces) < 2:
            continue
        root = find(faces[0].index)
        for face in faces[1:]:
            other = find(face.index)
            if other != root:
                parent[other] = root
    return sum(1 for i in range(len(parent)) if find(i) == i)


def measure(obj, spec, depsgraph, weld):
    evaluated = spec.get("evaluated", True)
    source = obj.evaluated_get(depsgraph) if evaluated else obj
    mesh = source.to_mesh() if evaluated else obj.data
    try:
        bm = bmesh.new()
        bm.from_mesh(mesh)
        stored_vertices = len(bm.verts)
        if weld > 0:
            bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=weld)
        bm.verts.ensure_lookup_table()
        bm.edges.ensure_lookup_table()
        bm.faces.ensure_lookup_table()
        bm.faces.index_update()
        area = spec.get("degenerate_area", 1e-8)
        counts = {
            "stored_vertices": stored_vertices, "vertices": len(bm.verts), "edges": len(bm.edges), "faces": len(bm.faces),
            "triangles": sum(len(f.verts) - 2 for f in bm.faces),
            "materials": len({slot.material.name for slot in obj.material_slots if slot.material}),
            "boundary_edges": sum(1 for e in bm.edges if e.is_boundary),
            "nonmanifold_edges": sum(1 for e in bm.edges if not e.is_manifold),
            "nonmanifold_interior_edges": sum(1 for e in bm.edges if len(e.link_faces) > 2),
            "flipped_edges": sum(1 for e in bm.edges if e.is_manifold and not e.is_contiguous),
            "wire_edges": sum(1 for e in bm.edges if not e.link_faces),
            "loose_vertices": sum(1 for v in bm.verts if not v.link_faces),
            "degenerate_faces": sum(1 for f in bm.faces if f.calc_area() <= area),
            "shells": shells(bm),
        }
        notes = []
        overlap = spec.get("self_overlap", {})
        if overlap.get("enabled", False):
            limit = overlap.get("max_faces", 200000)
            if len(bm.faces) <= limit:
                tree = BVHTree.FromBMesh(bm, epsilon=overlap.get("epsilon", 1e-5))
                pairs = tree.overlap(tree)
                counts["self_overlap_pairs"] = len(pairs)
                counts["self_overlap_faces"] = len({index for pair in pairs for index in pair})
            else:
                counts["self_overlap_pairs"] = counts["self_overlap_faces"] = None
                notes.append(f"self-overlap skipped: {len(bm.faces)} faces exceed max_faces {limit}")
        bm.free()
        coords = np.empty(len(mesh.vertices) * 3, dtype=np.float64)
        mesh.vertices.foreach_get("co", coords)
        coords = coords.reshape(-1, 3)
        matrix = np.array(obj.matrix_world, dtype=np.float64)
        scale = [abs(s) for s in obj.scale]
        if len(coords):
            extents = coords.max(axis=0) - coords.min(axis=0)
            world = coords @ matrix[:3, :3].T + matrix[:3, 3]
            dimensions = [round(float(e * s), 6) for e, s in zip(extents, scale)]
            bounds = {"min": [round(float(v), 6) for v in world.min(axis=0)], "max": [round(float(v), 6) for v in world.max(axis=0)]}
        else:
            dimensions, bounds = [0.0, 0.0, 0.0], None
            notes.append("mesh has no vertices")
    finally:
        if evaluated:
            source.to_mesh_clear()
    rotation = [round(float(r), 9) for r in obj.rotation_euler]
    applied = all(abs(s - 1.0) < 1e-9 for s in obj.scale) and all(abs(r) < 1e-9 for r in rotation)
    return {
        "name": obj.name, "parent": obj.parent.name if obj.parent else None, "evaluated": evaluated, "weld_distance": weld,
        "modifiers": [m.type for m in obj.modifiers], "counts": counts, "dimensions": dimensions,
        "world_bounds": bounds, "location": [round(float(v), 6) for v in obj.location],
        "rotation_euler_deg": [round(float(np.degrees(r)), 6) for r in rotation], "scale": [round(float(s), 9) for s in obj.scale],
        "transforms_applied": applied, "negative_scale": obj.matrix_world.determinant() < 0, "notes": notes,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--blend", type=Path)
    source.add_argument("--glb", type=Path)
    parser.add_argument("--spec", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--fail-on-threshold", action="store_true")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    if args.output.exists():
        raise SystemExit(f"Refusing to overwrite {args.output}")
    spec = validate_spec(json.loads(args.spec.read_text(encoding="utf-8")))
    source_file = args.blend or args.glb
    if not source_file.is_file():
        raise SystemExit(f"Source not found: {source_file}")
    if args.blend:
        bpy.ops.wm.open_mainfile(filepath=str(args.blend.resolve()), load_ui=False, use_scripts=False)
        candidates = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    else:
        before = set(bpy.data.objects.keys())
        bpy.ops.import_scene.gltf(filepath=str(args.glb.resolve()))
        candidates = [o for o in bpy.data.objects if o.name not in before and o.type == "MESH"]
    names = set(spec.get("objects", []))
    prefix = spec.get("prefix")
    if names or prefix:
        chosen = [o for o in candidates if o.name in names or (prefix and o.name.startswith(prefix))]
        missing = sorted(names - {o.name for o in chosen})
        if missing:
            raise SystemExit(f"Mesh objects not found: {missing}")
    else:
        chosen = candidates
    if not chosen:
        raise SystemExit("Census selected no mesh objects")
    depsgraph = bpy.context.evaluated_depsgraph_get()
    weld = spec.get("weld_distance", 1e-6 if args.glb else 0.0)
    objects = [measure(obj, spec, depsgraph, weld) for obj in sorted(chosen, key=lambda o: o.name)]
    units = bpy.context.scene.unit_settings
    report = {
        "source": report_path(source_file, args.output), "format": "blend" if args.blend else "glb",
        "spec": report_path(args.spec, args.output),
        "blender": {"version": list(bpy.app.version), "version_string": bpy.app.version_string,
                    "python": sys.version.split()[0], "background": bpy.app.background},
        "unit_system": units.system, "length_unit": units.length_unit, "unit_scale": units.scale_length,
        "objects": objects,
    }
    checks, failed = judge(spec, report)
    report.update({"checks": checks, "failed": failed, "status": "MEASURED",
                   "limits": "Topology, transform and size counts only; not appearance, collision behaviour, materials or glTF conformance"})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"source": report["source"], "blender": report["blender"]["version_string"], "objects": len(objects),
                      "checks": len(checks), "failed": failed}))
    if args.fail_on_threshold and failed:
        print(f"{failed} census check(s) failed; see {args.output}", file=sys.stderr)
        sys.exit(3)


if __name__ == "__main__":
    main()
