"""Record the installed OBJ importer and glTF exporter options before relying on keyword arguments."""
import argparse
import json
from pathlib import Path
import sys

import bpy


def operator_properties(op):
    props = {}
    for prop in op.get_rna_type().properties:
        if prop.identifier == "rna_type":
            continue
        entry = {"type": prop.type}
        if prop.type == "ENUM":
            entry["items"] = [item.identifier for item in prop.enum_items]
            entry["default"] = sorted(prop.default_flag) if prop.is_enum_flag else prop.default
        elif getattr(prop, "is_array", False):
            entry["default"] = list(prop.default_array)
        elif prop.type in {"BOOLEAN", "INT", "FLOAT", "STRING"}:
            entry["default"] = prop.default
        props[prop.identifier] = entry
    return props


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    import io_scene_gltf2
    report = {
        "blender": bpy.app.version_string,
        "gltfAddonVersion": list(io_scene_gltf2.bl_info["version"]),
        "objImport": operator_properties(bpy.ops.wm.obj_import),
        "gltfExport": operator_properties(bpy.ops.export_scene.gltf),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=1, default=str), encoding="utf-8")
    print(json.dumps({"blender": report["blender"], "gltf": report["gltfAddonVersion"]}))


if __name__ == "__main__":
    main()
