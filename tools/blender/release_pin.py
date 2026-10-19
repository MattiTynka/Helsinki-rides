"""The one Blender release the tools/blender scripts are written and checked against (docs/asset-pipeline.md). The
Python API moves at every release, and a script run under another installed build can fail halfway or export a
different asset without an error, so each script calls require() before it does any work. The runner finds the
pinned executable through BLENDER_PATH in the project .env."""
import bpy

RELEASE = (5, 2)


def require() -> None:
    if tuple(bpy.app.version[:2]) != RELEASE:
        raise RuntimeError(f"this script targets Blender {RELEASE[0]}.{RELEASE[1]}, not {bpy.app.version_string}; "
                           "set BLENDER_PATH or pass --blender to the runner")
