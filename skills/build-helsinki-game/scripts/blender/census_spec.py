"""Validate a mesh census spec and judge measured counts. No Blender dependency.

The census answers questions a render cannot: non-manifold and flipped edges, loose and
degenerate geometry, self-overlap, shell count, size and transforms. A declared limit on a
count that was not measured fails, so an empty report can never pass.
"""
import math
import re

COUNTS = ("vertices", "edges", "faces", "triangles", "materials", "boundary_edges", "nonmanifold_edges",
          "nonmanifold_interior_edges", "flipped_edges", "wire_edges", "loose_vertices", "degenerate_faces",
          "self_overlap_pairs", "self_overlap_faces", "shells")
OVERLAP_KEYS = {"enabled", "max_faces", "epsilon"}
KNOWN = {"require_version", "objects", "prefix", "evaluated", "weld_distance", "degenerate_area", "self_overlap",
         "limits", "dimensions", "unit_scale", "applied_transforms"}


def _finite(value, minimum=0.0, strict=False):
    if type(value) not in (int, float) or not math.isfinite(value):
        return False
    return value > minimum if strict else value >= minimum


def validate_spec(spec):
    def require(condition, message):
        if not condition:
            raise ValueError(message)

    require(isinstance(spec, dict), "Census spec must be an object")
    require(not set(spec) - KNOWN, "Unknown census key: check for misspellings")
    checks = 0
    if "require_version" in spec:
        version = spec["require_version"]
        require(isinstance(version, str) and re.fullmatch(r"\d+\.\d+", version), "require_version must be 'MAJOR.MINOR'")
        checks += 1
    objects = spec.get("objects", [])
    require(isinstance(objects, list) and all(isinstance(o, str) and o for o in objects), "objects must be a list of names")
    if "prefix" in spec:
        require(isinstance(spec["prefix"], str) and spec["prefix"], "prefix must be a nonempty string")
    if "evaluated" in spec:
        require(isinstance(spec["evaluated"], bool), "evaluated must be true or false")
    if "weld_distance" in spec:
        require(_finite(spec["weld_distance"]), "weld_distance must be a finite nonnegative length")
    require(_finite(spec.get("degenerate_area", 1e-8), strict=True), "degenerate_area must be a finite positive area")
    overlap = spec.get("self_overlap", {})
    require(isinstance(overlap, dict) and not set(overlap) - OVERLAP_KEYS, "self_overlap accepts enabled, max_faces, epsilon")
    require(isinstance(overlap.get("enabled", False), bool), "self_overlap.enabled must be true or false")
    require(type(overlap.get("max_faces", 1)) is int and overlap.get("max_faces", 1) > 0, "self_overlap.max_faces must be a positive integer")
    require(_finite(overlap.get("epsilon", 0.0)), "self_overlap.epsilon must be finite and nonnegative")
    limits = spec.get("limits", {})
    require(isinstance(limits, dict), "limits must be an object")
    for key, value in limits.items():
        require(key in COUNTS, f"Unknown census count {key!r}")
        require(type(value) is int and value >= 0, f"limits.{key} needs a nonnegative integer")
        checks += 1
    if "self_overlap_pairs" in limits or "self_overlap_faces" in limits:
        require(overlap.get("enabled", False), "A self-overlap limit needs self_overlap.enabled")
    dimensions = spec.get("dimensions", [])
    require(isinstance(dimensions, list), "dimensions must be an array")
    for item in dimensions:
        require(isinstance(item, dict), "dimensions item must be an object")
        require(isinstance(item.get("object"), str) and item["object"], "dimensions need an object name")
        size = item.get("size")
        require(isinstance(size, list) and len(size) == 3 and all(_finite(v) for v in size),
                "dimensions.size needs three finite nonnegative lengths")
        require(_finite(item.get("tolerance")), "dimensions.tolerance needs a finite nonnegative length")
        checks += 1
    if "unit_scale" in spec:
        require(_finite(spec["unit_scale"], strict=True), "unit_scale must be a finite positive number")
        checks += 1
    if "applied_transforms" in spec:
        require(isinstance(spec["applied_transforms"], bool), "applied_transforms must be true or false")
        checks += spec["applied_transforms"]
    require(checks > 0, "No census checks selected")
    return spec


def version_matches(required, actual):
    """True when MAJOR.MINOR of `actual` (a version tuple/list or 'X.Y.Z' string) equals `required`."""
    parts = actual.split(".") if isinstance(actual, str) else list(actual)
    try:
        return [int(p) for p in required.split(".")] == [int(p) for p in parts[:2]]
    except (TypeError, ValueError):
        return False


def judge(spec, report):
    """Compare a measured report with the spec. Returns (checks, failed); unmeasured values fail."""
    checks = []

    def add(check, obj, value, limit, passed):
        checks.append({"check": check, "object": obj, "value": value, "limit": limit, "passed": bool(passed)})

    if "require_version" in spec:
        actual = report.get("blender", {}).get("version")
        shown = ".".join(str(p) for p in actual[:2]) if actual else None
        add("require_version", None, shown, spec["require_version"], actual is not None and version_matches(spec["require_version"], actual))
    if "unit_scale" in spec:
        actual = report.get("unit_scale")
        add("unit_scale", None, actual, spec["unit_scale"], _finite(actual, strict=True) and math.isclose(actual, spec["unit_scale"], rel_tol=1e-9))
    objects = report.get("objects", [])
    for obj in objects:
        counts = obj.get("counts", {})
        for key, limit in spec.get("limits", {}).items():
            value = counts.get(key)
            add(key, obj["name"], value, limit, type(value) is int and value <= limit)
        if spec.get("applied_transforms"):
            add("applied_transforms", obj["name"], obj.get("transforms_applied"), True, obj.get("transforms_applied") is True)
    by_name = {obj["name"]: obj for obj in objects}
    for item in spec.get("dimensions", []):
        obj = by_name.get(item["object"])
        measured = obj.get("dimensions") if obj else None
        passed = False
        if isinstance(measured, list) and len(measured) == 3:
            passed = max(abs(a - b) for a, b in zip(measured, item["size"])) <= item["tolerance"]
        add("dimensions", item["object"], measured, item["size"], passed)
    failed = sum(1 for check in checks if not check["passed"])
    return checks, failed
