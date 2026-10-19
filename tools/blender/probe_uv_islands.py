"""Diagnostic: UV island counts and bounds of the game parts before and after decimation (read-only).

blender --background --factory-startup --disable-autoexec --python probe_uv_islands.py -- --source X.blend --variant snow
"""
import sys
from pathlib import Path

import bpy

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_game_character as bgc  # noqa: E402
import release_pin  # noqa: E402

release_pin.require()


def describe(label, obj):
    me = obj.data
    layer = next((l for l in me.uv_layers if l.active_render), me.uv_layers[0])
    islands = bgc.uv_islands(me, layer)
    big = sorted(islands, key=lambda i: -(i["size"].x * i["size"].y))[:4]
    print(f"{label}: {obj.name} faces={len(me.polygons)} islands={len(islands)} "
          + " ".join(f"[min=({i['min'].x:.2f},{i['min'].y:.2f}) size=({i['size'].x:.2f},{i['size'].y:.2f}) faces={len(i['faces'])}]" for i in big), flush=True)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    source, variant = Path(argv[argv.index("--source") + 1]), argv[argv.index("--variant") + 1]
    cfg = bgc.VARIANTS[variant]
    bpy.ops.wm.open_mainfile(filepath=str(source.resolve()), load_ui=False, use_scripts=False)
    bgc.prepare_source(cfg)
    coll = bpy.data.collections.new("GAME")
    bpy.context.scene.collection.children.link(coll)
    for name, group, target, opts in cfg["parts"]:
        part = bgc.extract_part(name, group, target, opts, coll)
        describe("before", part["obj"])
        bgc.decimate_to(part)
        describe("after ", part["obj"])


if __name__ == "__main__":
    main()
