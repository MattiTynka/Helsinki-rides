#!/usr/bin/env python3
"""Translate projected ENU OBJ vertices before Blender/float32 import; no reprojection."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import tempfile


def localize(source, output, report, crs, origin, max_distance=10000.0):
    source, output, report = map(Path, (source, output, report))
    if crs not in ("EPSG:3879", "EPSG:3067"):
        raise ValueError("Only explicitly confirmed projected metre CRS inputs are accepted")
    if len(origin) != 3 or not all(math.isfinite(x) for x in origin):
        raise ValueError("Origin needs three finite numbers: easting northing N2000 height")
    if not math.isfinite(max_distance) or max_distance <= 0:
        raise ValueError("max_distance must be finite and positive")
    if len({p.resolve() for p in (source, output, report)}) != 3:
        raise ValueError("Input, output and report must be distinct")
    if not source.is_file() or source.is_symlink():
        raise ValueError("Input must be a regular non-symlink file")
    if output.exists() or report.exists() or output.is_symlink() or report.is_symlink():
        raise ValueError("Output and report must be new paths; originals are never overwritten")
    output.parent.mkdir(parents=True, exist_ok=True)
    report.parent.mkdir(parents=True, exist_ok=True)
    lo, hi = [math.inf] * 3, [-math.inf] * 3
    count, materials = 0, []
    source_hash, output_hash = hashlib.sha256(), hashlib.sha256()
    # Temporary work prevents a malformed final vertex leaving an apparently complete OBJ.
    with tempfile.TemporaryFile() as temp, source.open("rb") as inp:
        for line_number, raw in enumerate(inp, 1):
            source_hash.update(raw)
            text = raw.decode("utf-8-sig" if line_number == 1 else "utf-8")
            code, separator, comment = text.partition("#")
            parts = code.split()
            if parts and parts[0] == "v":
                if len(parts) not in (4, 5, 7, 8):
                    raise ValueError(f"Line {line_number}: unsupported OBJ vertex layout")
                values = [float(v) for v in parts[1:]]
                if not all(math.isfinite(v) for v in values):
                    raise ValueError(f"Line {line_number}: non-finite vertex")
                if len(parts) == 5 and values[3] != 1:
                    raise ValueError("Non-unit homogeneous vertex weights need a separate conversion")
                xyz = [values[i] - origin[i] for i in range(3)]
                if max(abs(v) for v in xyz) > max_distance:
                    raise ValueError(f"Line {line_number}: outside max-distance; check CRS, axis order and origin")
                for i, value in enumerate(xyz):
                    lo[i], hi[i] = min(lo[i], value), max(hi[i], value)
                suffix = (" " + " ".join(parts[4:])) if len(parts) > 4 else ""
                text = "v " + " ".join(format(v, ".17g") for v in xyz) + suffix
                if separator:
                    text += " #" + comment.rstrip("\r\n")
                text += "\n"
                count += 1
            elif parts and parts[0] == "mtllib":
                materials.append(code.strip()[7:].strip())
            encoded = text.encode("utf-8")
            temp.write(encoded)
            output_hash.update(encoded)
        if count == 0:
            raise ValueError("No vertices found")
        metadata = {
            "schemaVersion": 1, "operation": "translation-only-before-float32",
            "sourceCrs": crs, "heightDatum": "N2000", "sourceAxes": "X-east,Y-north,Z-up",
            "outputAxes": "X-east,Y-north,Z-up", "units": "meter",
            "originProjected": list(origin), "vertices": count,
            "boundsLocalENU": {"min": lo, "max": hi},
            "sourceSha256": source_hash.hexdigest(), "outputSha256": output_hash.hexdigest(),
            "materialLibraries": materials,
            "limitations": ["CRS, axis order and N2000 must be confirmed from input metadata",
                            "No reprojection, tessellation, face validation or material packaging",
                            "MTL directives are preserved; stage and audit their texture tree beside output",
                            "Import as Z-up ENU; let glTF export perform the single Y-up conversion"]}
        created = []
        try:
            with output.open("xb") as out:
                created.append(output)
                temp.seek(0)
                while chunk := temp.read(1024 * 1024):
                    out.write(chunk)
            with report.open("x", encoding="utf-8") as out:
                created.append(report)
                json.dump(metadata, out, indent=2, allow_nan=False)
                out.write("\n")
        except Exception:
            for p in created:
                p.unlink(missing_ok=True)
            raise
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--crs", required=True, choices=["EPSG:3879", "EPSG:3067"])
    parser.add_argument("--origin", required=True, nargs=3, type=float, metavar=("E", "N", "H"))
    parser.add_argument("--max-distance", type=float, default=10000)
    args = parser.parse_args()
    try:
        result = localize(args.input, args.output, args.report, args.crs, args.origin, args.max_distance)
        print(json.dumps({"status": "LOCALIZED_NOT_VALIDATED_IN_ENGINE", "vertices": result["vertices"],
                          "boundsLocalENU": result["boundsLocalENU"]}))
    except (ValueError, OSError, UnicodeError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
