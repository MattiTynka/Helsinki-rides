#!/usr/bin/env python3
"""Check a staged Helsinki world manifest and byte hashes, not gameplay correctness."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re
from datetime import date


def require(condition, message):
    if not condition:
        raise ValueError(message)


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def vector(value, size, name):
    require(isinstance(value, list) and len(value) == size and all(finite(x) for x in value),
            f"{name} must contain {size} finite numbers")
    return value


def label(value, name):
    require(isinstance(value, str) and bool(value.strip()) and len(value) <= 2048,
            f"{name} must be a nonempty bounded string")
    require(not re.search(r"TODO|REPLACE|PLACEHOLDER", value, re.I), f"Unfilled {name}")
    return value


def safe_file(root, relative):
    require(isinstance(relative, str) and bool(relative), "Asset path must be a string")
    require(not re.search(r"[\\:%?#\x00-\x1f]", relative) and not relative.startswith("/"), "Unsafe asset path")
    require(all(part not in ("", ".", "..") for part in relative.split("/")), "Unsafe asset path component")
    target = root
    for part in relative.split("/"):
        target = target / part
        require(not target.is_symlink(), "Symlink asset paths are not accepted")
    require(target.is_file() and target.resolve().is_relative_to(root), "Missing or escaped asset file")
    return target


def digest(file):
    h = hashlib.sha256()
    with file.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


def validate(data, root):
    root = Path(root).resolve(strict=True)
    require(root.is_dir(), "Asset root must be a directory")
    require(isinstance(data, dict) and data.get("schemaVersion") == 1, "Unsupported manifest schema")
    label(data.get("buildId"), "buildId")
    coords = data.get("coordinates", {})
    require(coords.get("crs") == "EPSG:3879", "World must use the agreed EPSG:3879 project CRS")
    require(coords.get("heightDatum") == "N2000", "World height datum must be N2000")
    require(coords.get("units") == "meter", "World units must be meter")
    require(coords.get("runtimeAxes") == "X-east,Y-up,Z-south", "Runtime axes mismatch")
    vector(coords.get("originProjected"), 3, "originProjected")
    size = data.get("tileSizeMeters")
    require(finite(size) and 0 < size <= 4096, "Invalid tileSizeMeters")
    sources = data.get("sources")
    require(isinstance(sources, list) and len(sources) > 0, "Source ledger is required")
    source_ids = set()
    for source in sources:
        sid = label(source.get("id"), "source id")
        require(sid not in source_ids, "Duplicate source id")
        source_ids.add(sid)
        for field in ("url", "license", "attribution", "retrievedAt", "sha256"):
            label(source.get(field), f"source {field}")
        require(source["url"].startswith(("https://", "urn:")), "Source URL must be https or a local urn")
        date.fromisoformat(source["retrievedAt"])
        require(re.fullmatch(r"[0-9a-f]{64}", source["sha256"]) is not None, "Invalid source hash")
    tiles = data.get("tiles")
    require(isinstance(tiles, list) and 0 < len(tiles) <= 100000, "Tiles must be a nonempty bounded array")
    tile_ids, cells, assets = set(), set(), {}
    for tile in tiles:
        tid = label(tile.get("id"), "tile id")
        require(tid not in tile_ids, "Duplicate tile id")
        tile_ids.add(tid)
        x0, z0, x1, z1 = vector(tile.get("boundsXZ"), 4, "boundsXZ")
        require(abs(x1-x0-size) < 1e-6 and abs(z1-z0-size) < 1e-6, "Tile bounds must span tileSizeMeters")
        cell = (round(x0 / size), round(z0 / size))
        require(abs(x0 / size-cell[0]) < 1e-8 and abs(z0 / size-cell[1]) < 1e-8, "Tile grid is misaligned")
        require(cell not in cells, "Duplicate tile cell")
        cells.add(cell)
        refs = tile.get("sourceIds")
        require(isinstance(refs, list) and refs and all(s in source_ids for s in refs), "Tile has missing/unknown sourceIds")
        visuals = tile.get("visual")
        require(isinstance(visuals, list) and visuals, "Visual LODs required")
        last_distance = 0
        for index, visual in enumerate(visuals):
            require(type(visual.get("lod")) is int and visual["lod"] == index, "Visual LODs must be contiguous from zero")
            distance = visual.get("maxDistanceMeters")
            require(finite(distance) and distance > last_distance, "LOD distances must strictly increase")
            last_distance = distance
        records = [(f"visual-{i}", v) for i, v in enumerate(visuals)]
        records += [(role, tile.get(role)) for role in ("collision", "nav", "roads")]
        role_paths = set()
        for role, record in records:
            require(isinstance(record, dict), f"Tile {tid} requires separate {role} data")
            relative = record.get("path")
            file = safe_file(root, relative)
            require(relative not in role_paths, "Tile roles must not share the same asset path")
            role_paths.add(relative)
            expected_bytes, expected_hash = record.get("bytes"), record.get("sha256")
            require(type(expected_bytes) is int and expected_bytes > 0, "Asset bytes must be a positive integer")
            require(isinstance(expected_hash, str) and re.fullmatch(r"[0-9a-f]{64}", expected_hash), "Invalid asset SHA-256")
            if relative not in assets:
                assets[relative] = (file.stat().st_size, digest(file))
            actual_bytes, actual_hash = assets[relative]
            require(expected_bytes == actual_bytes, f"Byte length mismatch: {relative}")
            require(expected_hash == actual_hash, f"SHA-256 mismatch: {relative}")
    return {"status": "STRUCTURE_AND_HASHES_PASS", "buildId": data["buildId"], "tiles": len(tiles),
            "uniqueAssets": len(assets), "uniqueAssetBytes": sum(v[0] for v in assets.values()),
            "limitations": ["Does not decode GLB, collision, road or nav payloads",
                            "Does not verify source-file hashes, source CRS truth or license sufficiency",
                            "Does not prove seam continuity, connectivity, streaming behavior or performance"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    try:
        require(args.manifest.stat().st_size <= 32*1024*1024, "Manifest exceeds 32 MiB")
        data = json.loads(args.manifest.read_text(encoding="utf-8-sig"))
        print(json.dumps(validate(data, args.root), indent=2, allow_nan=False))
    except (ValueError, OSError, TypeError, KeyError, AttributeError) as error:
        parser.exit(1, f"Manifest rejected: {error}\n")


if __name__ == "__main__":
    main()
