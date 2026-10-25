"""Headless Blender job: the user's two extra cars -> one game-ready GLB each plus blender-report.json, in the Lumi
GT's node, material and socket layout (content/assets/vehicle-lumi-gt.contract.json; helpers from build_game_car.py).

- ``revontuli``: models/bugatti-veyron-fully-rigged (a converted game car on a Rigacar rig, like the Mustang).
  Doors and bonnet are separate objects with their origins on the hinges; the steering wheel is cut out of the
  body by a box.
- ``kaamos``: models/GT40.blend (no rig, +X forward, +Y left, ~2.3x life size, mirror and subdivision modifiers).
  The doors are panels of the body mesh: the body's connected parts inside each door's region become the door,
  hinged on a vertical axis at its front edge.

Both become fictional cars (plan section 18 rule 3): textures are dropped for flat materials and emblem, lettering
and number-plate parts are deleted. The source is opened read-only; meshes are evaluated (modifiers applied, with
subdivision at ``subsurf`` levels), read into numpy in the authoring frame (Blender -Y forward, +Z up, +X left, as in
build_game_car.py) and the scene is discarded. Source boxes and points below are in source world coordinates.

Usage (through the skill runner):
  --python tools/blender/build_extra_cars.py -- --car revontuli|kaamos --source <file.blend> --contract <json> --out <dir>
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree
sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_game_car as base  # noqa: E402  (pins the Blender release on import)

CLASSES = base.CLASSES
INTERIOR_CLASSES = {"interior", "alloy"}  # brushed-metal consoles stay metal inside the cabin
SEAT_ABOVE_CUSHION = 0.177  # the Lumi GT's SEAT_DRIVER socket height over its cushion (m)
DOOR_OPEN_DEG, STEERING_LOCK_DEG, EXIT_X = 65.0, 450.0, 1.5
LAMP_TAIL = {"breaklight l", "breaklight r", "left rear light", "right rear light", "revlight L", "revlight r",
             "indicator lr", "indicator rr"}
LAMP_HEAD = {"left front light", "right front light", "foglight l", "foglight r", "indicator lf", "indicator rf",
             "indicator lm", "indicator rm"}

CARS = {
    "revontuli": {
        "label": "Revontuli",
        "rig": "Car Rig",
        "frame": np.eye(3),
        "subsurf": 0,
        # Wheelbase 3.07 m in the source; 0.88 gives 2.70 m, a 4.5 m long, 2.0 m wide supercar.
        "scale": 0.88,
        "sources": {"body": ["buDEF-Body"], "bonnet": ["bonnet_ok"], "door_l": ["door_lf_ok"], "door_r": ["door_rf_ok"]},
        "nodes": {"body": "CAR_BODY", "bonnet": "CAR_BODY", "door_l": "DOOR_FL", "door_r": "DOOR_FR"},
        "tiny": {"body": 0.03, "bonnet": 0.03, "door_l": 0.025, "door_r": 0.025},
        "wheels": {"WHEEL_FL": "buDEF- Wheel.Ft.L", "WHEEL_FR": "buDEF- Wheel.Ft.R",
                   "WHEEL_RL": "buDEF- Wheel.Bk.L", "WHEEL_RR": "buDEF- Wheel.Bk.R"},
        "wheelMaterials": None,
        # The wheel objects hang off rig bones whose parent inverse was set posed: at rest they sit 19 cm outboard
        # of the arches, so they are measured in the rig's pose (the body is the same in both).
        "wheelsPosed": True,
        "hinges": {"DOOR_FL": ("origin", "door_lf_ok"), "DOOR_FR": ("origin", "door_rf_ok")},
        "materials": {"primary": "paint", "secondary": "band", "chassis.1": "trim", "chassis.2": "alloy",
                      "chassis.28": "alloy", "glass": "glass", "glass.001": "glass",
                      **{m: "interior" for m in ("chassis.15", "chassis.16", "chassis.17", "chassis.19", "chassis.20",
                                                 "chassis.21", "chassis.22", "chassis.23", "chassis_vlo.0")},
                      **{m: "lamp_tail" for m in LAMP_TAIL}, **{m: "lamp_head" for m in LAMP_HEAD}},
        "exterior": {"primary", "secondary", "glass", "glass.001", "chassis.2"},  # chassis.2: roof, pillars, scoops
        # The rear number plate, its backing and frame (textures carpback/carplate).
        "deleteMaterials": {"bump_rear_ok.6", "bump_rear_ok.7", "bump_rear_ok.8"},
        "deleteBoxes": [  # (label, box, largest island diagonal)
            ("grille emblem disc", (-0.13, 0.13, -4.20, -3.85, 0.47, 0.67), 0.30),
            ("rear emblem lettering", (-0.15, 0.15, 0.60, 1.05, 0.78, 1.00), 0.30),
            ("cabin floor emblem", (-0.12, 0.12, -1.45, -1.00, 0.20, 0.50), 0.25)],
        "nodeBoxes": [("STEERING_WHEEL", ("body",), (0.24, 0.67, -2.30, -2.05, 0.70, 1.15), 0.45)],
        # Cabin fit for Snow (short arms, tall seated height): both seats 7 cm lower and 15 cm forward, the wheel
        # 12 cm nearer and 8 cm higher. (label, node, source-key pattern, car-local box or None, offset), metres.
        "moves": [("driver seat", "CAR_INTERIOR", None, (0.12, 0.80, 0.25, 1.08, -0.50, 0.45), (0.0, -0.07, 0.15)),
                  ("passenger seat", "CAR_INTERIOR", None, (-0.80, -0.12, 0.25, 1.08, -0.50, 0.45), (0.0, -0.07, 0.15)),
                  ("steering wheel", "STEERING_WHEEL", None, None, (0.0, 0.08, -0.12))],
        "bubbles": [],
        "doorRegions": {},
        "cabin": (-0.98, 0.98, -2.95, -0.90, 0.25, 1.40),
        "seat": (0.47, -1.55),
        "doorCentre": (0.0, -1.88, 0.0),
        # Glass faces moved off CAR_GLASS by centroid box and facing: the windshield (|normal Y| above 0.25) and
        # the side windows, which the body mesh carries but which must open with the doors (|normal X| above 0.4).
        "windshield": ((-0.95, 0.95, -2.95, -1.95, 0.95, 1.40), 1, 0.25),
        "doorGlass": {"DOOR_FL": (0.6, 1.25, -2.66, -1.10, 0.85, 1.45), "DOOR_FR": (-1.25, -0.6, -2.66, -1.10, 0.85, 1.45)},
        # The source models the roof panel in its glass material; it becomes the graphite second tone (|normal Z|
        # above 0.5), so the cabin has a solid roof.
        "roofGlass": (-0.85, 0.85, -1.95, -0.80, 1.10, 1.50),
        "roofBox": (-0.3, 0.3, -1.6, -1.1),
        "planes": [],
        "paint": ((0.02, 0.36, 0.30), 0.30, 0.6, 0.6, None, 1.0),  # aurora green
        "band": ((0.035, 0.04, 0.045), 0.35, 0.5, 0.5, None, 1.0),  # graphite second tone
        "budget": {("CAR_BODY", "paint"): 9000, ("CAR_BODY", "band"): 2500, ("CAR_BODY", "trim"): 5500,
                   ("CAR_BODY", "alloy"): 2200, ("CAR_BODY", "lamp_head"): 700, ("CAR_BODY", "lamp_tail"): 800,
                   ("CAR_BODY", "glass"): 200, ("CAR_GLASS", "glass"): 900, ("WINDSHIELD", "glass"): 200,
                   ("CAR_INTERIOR", "interior"): 6500, ("CAR_INTERIOR", "alloy"): 400,
                   **{(d, c): n for d in ("DOOR_FL", "DOOR_FR") for c, n in (("paint", 300), ("band", 800),
                      ("interior", 1300), ("trim", 250), ("alloy", 150), ("glass", 60), ("lamp_head", 40))},
                   ("STEERING_WHEEL", "interior"): 800, ("STEERING_WHEEL", "alloy"): 200},
    },
    "kaamos": {
        "label": "Kaamos",
        "rig": None,
        # Source +X forward, +Y left, +Z up -> authoring -Y forward, +X left, +Z up.
        "frame": np.array([[0.0, 1.0, 0.0], [-1.0, 0.0, 0.0], [0.0, 0.0, 1.0]]),
        "subsurf": 1,
        # Wheelbase 5.61 in the source; 0.47 gives 2.63 m and a 1.14 m roof (the real car is 1.03 m tall): the
        # smallest scale whose cabin seats Snow, lying back, under the roof.
        "scale": 0.47,
        "sources": "objects",  # every mesh object, keyed by its name without the GT40_ prefix (OBJECTS below)
        "nodes": {},
        "tiny": {},
        "wheels": {"WHEEL_FL": "GT40_WheelFL", "WHEEL_FR": "GT40_WheelFR", "WHEEL_RL": "GT40_WheelBL",
                   "WHEEL_RR": "GT40_WheelBR"},
        "wheelMaterials": {"GT40_Tire1"},
        "hinges": {"DOOR_FL": ("point", (1.05, 1.95, 0.4)), "DOOR_FR": ("point", (1.05, -1.95, 0.4))},
        "materials": {"GT40_PaintBlack": "paint", "Material": "paint", "GT40_Trim1": "alloy", "GT40_Trim2": "alloy",
                      "GT40_Steer2": "alloy", "GT40_Rim1": "alloy", "GT40_Rim2": "alloy", "GT40_Pedal": "alloy",
                      "GT4_Exhaust": "alloy", "GT40_Glass": "glass", "GT40_Headlight3": "glass",
                      **{m: "lamp_head" for m in ("GT40_Headlight1", "GT40_Headlight2", "GT40_Headlight4", "GT40_Headlight5")},
                      **{m: "lamp_tail" for m in ("GT40_Tailight1", "GT40_Taillight2")},
                      **{m: "interior" for m in ("GT40_Seat1", "GT40_Seat2", "GT40_Steer1", "GT40_Steer3", "GT40_Stick1",
                                                 "GT40_Speedometer1", "GT40_Speedometer2", "GT40_SPeedometer3",
                                                 "GT40_RPM1", "GT40_Fuel1", "GT40_GearSign1", "GT40_InteriorFloor",
                                                 "GT40_Interior3", "GT40_InteriorConsole", "GT40_Button1",
                                                 "GT40_Button2", "GT40_Button3")}},
        "exterior": set(),
        "deleteMaterials": set(),
        "deleteBoxes": [],
        "nodeBoxes": [],
        # Cabin fit: both seats (shells, rails, mounts) 6 cm lower onto the floor pan and 15 cm forward; the wheel and
        # its column 25 cm nearer and 10 cm higher.
        "moves": [("driver seat", "CAR_INTERIOR", r"DriverSeat(\d|Bar|Mount)", None, (0.0, -0.06, 0.15)),
                  ("passenger seat", "CAR_INTERIOR", r"PassengerSeat(\d|Bar|Mount)", None, (0.0, -0.06, 0.15)),
                  ("steering wheel", None, r"SteeringWheel[12]", None, (0.0, 0.10, -0.25))],
        # Roof blisters over both seats (the GT40's "Gurney bubble"): the roof skin and liner raised for Snow's head.
        # (label, |x| plateau, z plateau, ramp, lift, lowest y lifted), car-local metres.
        "bubbles": [("roof blisters", (0.27, 0.48), (-0.55, 0.0), 0.08, 0.06, 0.95)],
        # Door panels of the body: connected parts fully inside the region that reach the outer skin (y beyond
        # 1.6) or lie in the roof (above z 1.1); the A-pillar strips (from the windshield base, x beyond 0.8,
        # above z 0.7) stay on the body.
        "doorRegions": {"DOOR_FL": (-1.30, 1.045, 1.15, 9.0, -0.12, 1.44), "DOOR_FR": (-1.30, 1.045, -9.0, -1.15, -0.12, 1.44)},
        "cabin": None,
        "seat": (-0.25, 0.81),
        "doorCentre": (-0.07, 0.0, 0.0),
        "windshield": None,
        "doorGlass": {},
        "roofBox": (-1.2, -0.2, -0.3, 0.3),
        # Dark panels behind the two honeycomb grilles, which are dropped (31k and 13k triangles).
        "planes": [("front grille", "x", 4.50, (-1.05, 1.05), (-0.62, -0.13)),
                   ("rear grille", "x", -4.55, (-1.36, 1.36), (0.03, 0.47))],
        "paint": ((0.05, 0.10, 0.34), 0.30, 0.6, 0.6, None, 1.0),  # polar-night blue
        "band": ((0.93, 0.93, 0.92), 0.35, 0.3, 0.5, None, 1.0),
        "budget": {("CAR_BODY", "paint"): 12000, ("CAR_BODY", "trim"): 2500, ("CAR_BODY", "alloy"): 2800,
                   ("CAR_BODY", "lamp_head"): 1400, ("CAR_BODY", "lamp_tail"): 1000, ("CAR_GLASS", "glass"): 700,
                   ("WINDSHIELD", "glass"): 200, ("CAR_INTERIOR", "interior"): 6000, ("CAR_INTERIOR", "alloy"): 1500,
                   ("CAR_DETAILS", "alloy"): 2600, ("CAR_DETAILS", "trim"): 1200,
                   **{(d, c): n for d in ("DOOR_FL", "DOOR_FR") for c, n in (("paint", 1500), ("interior", 600),
                      ("alloy", 250), ("glass", 120), ("trim", 100))},
                   ("STEERING_WHEEL", "interior"): 700, ("STEERING_WHEEL", "alloy"): 300},
    },
}
# Kaamos source objects: (name pattern, node, fixed class or None for the material table). First match wins;
# a node of None drops the object.
OBJECTS = [
    (r"Wheel[FB][LR]$|Rim[FB][LR]$", None, None),                      # replaced by procedural wheels
    (r".*Screws.*|SpoilerBolt\d|TrunkBolts", None, None),               # bolt heads, thousands of triangles
    (r"InteriorTube\d", None, None),                                    # 75k triangles of tubing under the dash
    (r"FrontGrill$|RearGrill$", None, None),                            # honeycomb meshes; dark planes instead
    (r"Studio_.*|PaintPallet\d", None, None),                           # studio floor and paint swatches
    (r"Windshield$", "WINDSHIELD", "glass"),
    (r"BackWindow\d", "CAR_GLASS", "glass"),
    (r"SteeringWheel1$", "STEERING_WHEEL", None),
    (r"DoorInteriorL|InteriorDoorHandleL|DoorHandleL|DoorTrimL|WindowL", "DOOR_FL", None),
    (r"DoorInteriorR|InteriorDoorHandleR|DoorHandleR|DoorTrimR|WindowR", "DOOR_FR", None),
    (r"(Driver|Passenger)Seat\d|(Driver|Passenger)Seat(Bar|Mount)|(Driver|Passenger)FootBar|Instrument\d|RevCounter\d|"
     r"Speedometer$|InteriorKnob\d|InteriorLight\d|InteriorVent\d|InteriorBar\d|GearShift.*|Handbrake|HandBrakeCover|"
     r"Pedal\d.*|SteeringWheel2$", "CAR_INTERIOR", None),
    (r"Engine(Block|Caps|Pipes|Springs|SuperChargers|Trim|Wires).*|Pistons\d|Radiator\d", "CAR_DETAILS", None),
    (r".*", "CAR_BODY", None),
]


# --- source extraction ----------------------------------------------------------------------------------
def evaluated_arrays(obj, depsgraph, frame):
    """base.mesh_arrays on the evaluated mesh (modifiers applied), rotated into the authoring frame."""
    ev = obj.evaluated_get(depsgraph)
    me = ev.to_mesh()
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    m = np.array(obj.matrix_world)
    world = (co.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]) @ frame.T
    nf = len(me.polygons)
    ls, lt, mi = (np.empty(nf, dtype=np.int64) for _ in range(3))
    me.polygons.foreach_get("loop_start", ls)
    me.polygons.foreach_get("loop_total", lt)
    me.polygons.foreach_get("material_index", mi)
    lv = np.empty(len(me.loops), dtype=np.int64)
    me.loops.foreach_get("vertex_index", lv)
    edges = np.empty(len(me.edges) * 2, dtype=np.int64)
    me.edges.foreach_get("vertices", edges)
    names = [s.material.name if s.material else "None" for s in obj.material_slots] or ["None"]
    ev.to_mesh_clear()
    return {"verts": world, "loop_start": ls, "loop_total": lt, "loop_verts": lv,
            "mat": np.array([names[min(i, len(names) - 1)] for i in mi.tolist()], dtype=object), "edges": edges.reshape(-1, 2)}


def concat(parts):
    out = {"verts": [], "loop_start": [], "loop_total": [], "loop_verts": [], "mat": [], "edges": []}
    v_off = l_off = 0
    for d in parts:
        out["verts"].append(d["verts"])
        out["loop_start"].append(d["loop_start"] + l_off)
        out["loop_total"].append(d["loop_total"])
        out["loop_verts"].append(d["loop_verts"] + v_off)
        out["mat"].append(d["mat"])
        out["edges"].append(d["edges"] + v_off)
        v_off += len(d["verts"])
        l_off += len(d["loop_verts"])
    return {k: np.concatenate(v) if v else np.zeros(0) for k, v in out.items()}


def inside_box(lo, hi, box):
    """box = (x0, x1, y0, y1, z0, z1) in the authoring frame."""
    return base.inside(lo, hi, box)


def to_frame_box(box, frame):
    """A source-frame box -> the authoring-frame box enclosing it."""
    corners = np.array([[x, y, z] for x in box[0:2] for y in box[2:4] for z in box[4:6]]) @ frame.T
    lo, hi = corners.min(axis=0), corners.max(axis=0)
    return (lo[0], hi[0], lo[1], hi[1], lo[2], hi[2])


def object_rule(name):
    short = name[5:] if name.startswith("GT40_") else name
    for pattern, node, cls in OBJECTS:
        if re.fullmatch(pattern, short):
            return node, cls
    return "CAR_BODY", None


# --- classification ---------------------------------------------------------------------------------------
def classify(car, key, data, isl, removed, default_node, fixed_class, tiny):
    """Per face: keep flag, node and material class (base.classify with the per-car tables)."""
    frame = car["frame"]
    n = isl["count"]
    keep = np.ones(n, dtype=bool)
    island_node = np.full(n, default_node, dtype=object)
    reasons = {}

    def drop(i, why):
        if keep[i]:
            keep[i] = False
            reasons.setdefault(why, [0, 0.0])
            reasons[why][0] += 1
            reasons[why][1] += float(isl["tris"][i])

    delete_boxes = [(label, to_frame_box(box, frame), diag) for label, box, diag in car["deleteBoxes"]]
    node_boxes = [(nd, keys, to_frame_box(box, frame), diag) for nd, keys, box, diag in car["nodeBoxes"]]
    cabin = to_frame_box(car["cabin"], frame) if car["cabin"] else None
    for i in range(n):
        dom, lo, hi, diag = isl["dominant"][i], isl["lo"][i], isl["hi"][i], isl["diag"][i]
        if diag < tiny:
            drop(i, f"{key}: debris islands under {tiny * 100:.1f} cm (bolts, clips, screws)")
            continue
        if dom in car["deleteMaterials"]:
            drop(i, f"{key}: islands of material '{dom}' (number plate, its frame and backing)")
            continue
        hit = next((label for label, box, d in delete_boxes if diag <= d and inside_box(lo, hi, box)), None)
        if hit:
            drop(i, f"{key}: {hit}")
            continue
        for nd, keys, box, d in node_boxes:
            if key in keys and diag <= d and inside_box(lo, hi, box):
                island_node[i] = nd
                break
        else:
            if cabin and default_node == "CAR_BODY" and inside_box(lo, hi, cabin) and dom not in car["exterior"]:
                island_node[i] = "CAR_INTERIOR"
            elif key == "Body":
                island_node[i] = door_of(car, lo, hi) or default_node
    for why, (count, tris) in reasons.items():
        removed.append({"what": why, "islands": count, "triangles": int(tris)})

    nf = len(data["mat"])
    fl = isl["face_label"]
    node = island_node[fl]
    cls = np.empty(nf, dtype=object)
    ls, lv, verts = data["loop_start"], data["loop_verts"], data["verts"]
    a, b, c3 = verts[lv[ls]], verts[lv[ls + 1]], verts[lv[ls + 2]]
    centre = (a + b + c3) / 3
    normal = np.cross(b - a, c3 - a)
    normal /= np.maximum(np.linalg.norm(normal, axis=1, keepdims=True), 1e-12)
    glass_boxes = []  # (node, class, box, axis, minimum |normal| on that axis)
    if car["windshield"]:
        box, axis, k = car["windshield"]
        glass_boxes.append(("WINDSHIELD", "glass", to_frame_box(box, frame), axis, k))
    for door, box in car["doorGlass"].items():
        glass_boxes.append((door, "glass", to_frame_box(box, frame), 0, 0.4))
    if car.get("roofGlass"):
        glass_boxes.append(("CAR_BODY", "band", to_frame_box(car["roofGlass"], frame), 2, 0.5))
    for f in range(nf):
        c = fixed_class or car["materials"].get(data["mat"][f], "trim")
        nd = node[f]
        if nd in ("CAR_BODY", "CAR_DETAILS") and c == "glass" and default_node != "CAR_DETAILS":
            nd = "CAR_GLASS"
            for target, target_class, box, axis, k in glass_boxes:
                if abs(normal[f][axis]) > k and inside_box(centre[f], centre[f], box):
                    nd, c = target, target_class
                    break
        elif nd in ("CAR_BODY", "CAR_DETAILS") and c == "interior":
            c = "trim"  # dark plastics outside the cabin
        elif nd in ("CAR_INTERIOR", "STEERING_WHEEL") and c not in INTERIOR_CLASSES:
            c = "interior"
        elif nd in ("CAR_GLASS", "WINDSHIELD"):
            c = "glass"
        node[f], cls[f] = nd, c
    return keep[fl], node, cls


def door_of(car, lo, hi):
    """Kaamos: the door a body island belongs to, if any (source-frame regions, see CARS)."""
    inv = car["frame"].T
    slo, shi = np.minimum(lo @ inv.T, hi @ inv.T), np.maximum(lo @ inv.T, hi @ inv.T)
    for door, (x0, x1, y0, y1, z0, z1) in car["doorRegions"].items():
        if not (slo[0] >= x0 and shi[0] <= x1 and slo[1] >= y0 and shi[1] <= y1 and slo[2] >= z0 and shi[2] <= z1):
            continue
        outer = shi[1] >= 1.6 if door == "DOOR_FL" else slo[1] <= -1.6
        if not (outer or slo[2] >= 1.1) or (slo[2] > 0.7 and shi[0] > 0.8):
            continue
        return door
    return None


def axis_frame(verts):
    """Steering wheel frame from its rim: hub = bounds centre, column axis = least-variance direction (PCA)."""
    hub = (verts.min(axis=0) + verts.max(axis=0)) / 2
    _, _, vt = np.linalg.svd(verts - verts.mean(axis=0), full_matrices=False)
    toward_driver = vt[2].copy()
    toward_driver[0] = 0.0
    toward_driver /= np.linalg.norm(toward_driver)
    if toward_driver[1] < 0:  # the driver sits behind the wheel: +Y in the authoring frame
        toward_driver = -toward_driver
    return hub, toward_driver


def plane_quad(spec, frame):
    _, axis, at, (a0, a1), (b0, b1) = spec
    pts = [(at, a0, b0), (at, a1, b0), (at, a1, b1), (at, a0, b1)] if axis == "x" else []
    return np.array(pts, dtype=np.float64) @ frame.T


# --- main ----------------------------------------------------------------------------------------------------
def apply_moves(car, key, verts, data, isl, node, log):
    """The cabin fit: whole connected parts of a node (inside a car-local box, or of matching source keys) shifted
    by a car-local offset. verts are in the CAR_ROOT authoring frame (+X driver, -Y forward, +Z up)."""
    if not car["moves"]:
        return verts
    fl, lt = isl["face_label"], data["loop_total"]
    assert np.array_equal(data["loop_start"], np.concatenate([[0], np.cumsum(lt)[:-1]]))
    vert_island = np.full(len(verts), -1)
    vert_island[data["loop_verts"]] = np.repeat(fl, lt)
    used = vert_island >= 0
    game = np.column_stack([verts[:, 0], verts[:, 2], -verts[:, 1]])  # car-local: +X driver, +Y up, +Z forward
    n = isl["count"]
    lo, hi = np.full((n, 3), np.inf), np.full((n, 3), -np.inf)
    np.minimum.at(lo, vert_island[used], game[used])
    np.maximum.at(hi, vert_island[used], game[used])
    _, first = np.unique(fl, return_index=True)
    island_node = np.full(n, None, dtype=object)
    island_node[fl[first]] = node[first]
    out = verts.copy()
    for label, nd, pattern, box, (dx, dy, dz) in car["moves"]:
        if pattern and not re.fullmatch(pattern, key):
            continue
        hit = np.ones(n, dtype=bool) if nd is None else island_node == nd
        if box:
            b = np.array(box).reshape(3, 2)
            hit &= np.all(lo >= b[:, 0], axis=1) & np.all(hi <= b[:, 1], axis=1)
        moving = hit[vert_island] & used
        out[moving] += (dx, -dz, dy)
        if hit.any():
            entry = log.setdefault(label, {"offsetCarLocal": [dx, dy, dz], "islands": 0, "triangles": 0})
            entry["islands"] += int(hit.sum())
            entry["triangles"] += int(isl["tris"][hit].sum())
    return out


def apply_bubbles(car, verts, log):
    """Roof blisters: everything above a height inside an |x|, z footprint lifted, easing out over `ramp` metres
    around the plateau and over 4 cm above the lowest height lifted. verts as in apply_moves."""
    out = verts
    for label, (x0, x1), (z0, z1), ramp, lift, y0 in car["bubbles"]:
        ax, y, z = np.abs(out[:, 0]), out[:, 2], -out[:, 1]
        ease = lambda t: (lambda c: c * c * (3 - 2 * c))(np.clip(t, 0.0, 1.0))
        w = (ease((ax - (x0 - ramp)) / ramp) * ease(((x1 + ramp) - ax) / ramp) * ease((z - (z0 - ramp)) / ramp)
             * ease(((z1 + ramp) - z) / ramp) * ease((y - y0) / 0.04))
        if not w.any():
            continue
        out = out.copy()
        out[:, 2] += lift * w
        entry = log.setdefault(label, {"liftCarLocal": lift, "vertices": 0})
        entry["vertices"] += int((w > 0).sum())
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--car", required=True, choices=sorted(CARS))
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--contract", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    car = CARS[args.car]
    source, out = args.source.resolve(), args.out.resolve()
    contract = json.loads(args.contract.read_text(encoding="utf-8"))
    out.mkdir(parents=True, exist_ok=True)
    source_bytes = source.read_bytes()
    source_sha = hashlib.sha256(source_bytes).hexdigest()
    base.BUDGET = car["budget"]  # base.build_node reads the module's budget table

    # 1. Source: rest pose, evaluated world-space arrays in the authoring frame, then the scene is thrown away.
    bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False, use_scripts=False)
    for obj in bpy.data.objects:
        if obj.type == "ARMATURE":
            obj.data.pose_position = "REST"
        for mod in getattr(obj, "modifiers", []):
            if mod.type == "SUBSURF":
                mod.levels = car["subsurf"]
                mod.show_viewport = car["subsurf"] > 0
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    frame = car["frame"]
    if car["rig"]:
        frame = np.array(bpy.data.objects[car["rig"]].matrix_world.to_3x3().inverted()) @ frame
    car = dict(car, frame=frame)
    if car["sources"] == "objects":
        sources = {}
        for obj in bpy.data.objects:
            if obj.type != "MESH" or obj.name in car["wheels"].values():
                continue
            node, cls = object_rule(obj.name)
            if node is None:
                continue
            short = obj.name[5:] if obj.name.startswith("GT40_") else obj.name
            sources[short] = ([obj.name], node, cls, 0.02 if node == "STEERING_WHEEL" else 0.012)
    else:
        sources = {key: (names, car["nodes"][key], None, car["tiny"][key]) for key, names in car["sources"].items()}
    data = {key: concat([evaluated_arrays(bpy.data.objects[n], depsgraph, frame) for n in names])
            for key, (names, _, _, _) in sources.items()}
    wheels_src = {}
    if car.get("wheelsPosed"):
        bpy.data.objects[car["rig"]].data.pose_position = "POSE"
        bpy.context.view_layer.update()
        depsgraph = bpy.context.evaluated_depsgraph_get()
    for node, name in car["wheels"].items():
        d = evaluated_arrays(bpy.data.objects[name], depsgraph, frame)
        if car["wheelMaterials"]:
            faces = np.isin(d["mat"], list(car["wheelMaterials"]))
            idx = np.unique(np.concatenate([d["loop_verts"][s:s + t] for s, t in zip(d["loop_start"][faces], d["loop_total"][faces])]))
            v = d["verts"][idx]
        else:
            v = d["verts"]
        wheels_src[node] = {"lo": v.min(axis=0), "hi": v.max(axis=0)}
    if car.get("wheelsPosed"):
        bpy.data.objects[car["rig"]].data.pose_position = "REST"
        bpy.context.view_layer.update()
    hinges_src = {}
    for node, (kind, ref) in car["hinges"].items():
        if kind == "origin":
            hinges_src[node] = np.array(bpy.data.objects[ref].matrix_world.translation) @ frame.T
        else:
            hinges_src[node] = np.array(ref, dtype=np.float64) @ frame.T
    source_summary = {
        "fileVersion": list(bpy.data.version), "units": bpy.context.scene.unit_settings.system,
        "unitScale": bpy.context.scene.unit_settings.scale_length,
        "objects": len(bpy.data.objects), "meshObjectsRead": sum(len(s[0]) for s in sources.values()),
        "armatures": sorted(o.name for o in bpy.data.objects if o.type == "ARMATURE"),
        "images": sorted(im.name for im in bpy.data.images if im.source == "FILE"),
        "materials": len(bpy.data.materials), "subsurfLevels": car["subsurf"],
        "sourceTriangles": int(sum(int((d["loop_total"] - 2).sum()) for d in data.values())),
    }
    bpy.ops.wm.read_factory_settings(use_empty=True)

    # 2. Measurements in the authoring frame, then the root transform.
    hubs = {n: (w["lo"] + w["hi"]) / 2 for n, w in wheels_src.items()}
    wheel_radius_src = float(np.mean([(w["hi"][2] - w["lo"][2]) / 2 for w in wheels_src.values()]))
    wheel_width_src = float(np.mean([w["hi"][0] - w["lo"][0] for w in wheels_src.values()]))
    ground_src = float(min(w["lo"][2] for w in wheels_src.values()))
    front_y = (hubs["WHEEL_FL"][1] + hubs["WHEEL_FR"][1]) / 2
    rear_y = (hubs["WHEEL_RL"][1] + hubs["WHEEL_RR"][1]) / 2
    track_x = float(np.mean([abs(h[0]) for h in hubs.values()]))
    root_src = np.array([float(np.mean([h[0] for h in hubs.values()])), (front_y + rear_y) / 2, ground_src])
    s = car["scale"]
    T = lambda p: (np.asarray(p, dtype=np.float64) - root_src) * s  # authoring-frame source -> CAR_ROOT space

    # 3. Classification per source part.
    removed, budget_log, moves_log = [], [], {}
    groups = {}
    for key, d in data.items():
        if not len(d["mat"]):
            continue
        _, default_node, fixed_class, tiny = sources[key]
        isl = base.islands(d)
        keep, node, cls = classify(car, key, d, isl, removed, default_node, fixed_class, tiny)
        placed = apply_bubbles(car, apply_moves(car, key, T(d["verts"]), d, isl, node, moves_log), moves_log)
        for nd in np.unique(node[keep]):
            for c in np.unique(cls[keep & (node == nd)]):
                mask = keep & (node == nd) & (cls == c)
                verts, faces = base.compact(placed, base.face_lists(d, mask))
                groups.setdefault((nd, c), []).append((verts, faces))
    if car["sources"] == "objects":
        removed.append({"what": "source objects dropped by name (OBJECTS table): wheels and rims (procedural wheels "
                                "instead), screw and bolt heads, the under-dash tubing, both honeycomb grilles (dark "
                                "panels instead), the studio floor and paint swatches"})
    for spec in car["planes"]:
        quad = T(plane_quad(spec, frame))
        groups.setdefault(("CAR_BODY", "trim"), []).append((quad, [[0, 1, 2, 3]]))

    def merged(nd):
        out_groups = {}
        for (n, c), parts in groups.items():
            if n != nd:
                continue
            vs, fs, off = [], [], 0
            for v, f in parts:
                vs.append(v)
                fs.extend([[i + off for i in face] for face in f])
                off += len(v)
            out_groups[c] = (np.concatenate(vs), fs)
        return out_groups

    # 4. Scene: root, materials, node meshes.
    scene = bpy.context.scene
    visual = bpy.data.collections.new("VISUAL")
    scene.collection.children.link(visual)
    work = bpy.data.collections.new("WORK")
    scene.collection.children.link(work)
    root = bpy.data.objects.new("CAR_ROOT", None)
    root["role"] = "asset-root"
    root["assetId"] = contract["assetId"]
    visual.objects.link(root)
    materials = {}
    for cls in CLASSES:
        spec = car["paint"] if cls == "paint" else car["band"] if cls == "band" else base.MATERIALS[cls]
        mt = bpy.data.materials.new(f"car_{cls}")
        mt.use_nodes = True
        base.set_material(mt, spec, base.EMISSION_STRENGTH.get(cls, 1.0))
        mt["role"] = "vehicle"
        materials[cls] = mt

    def adopt(obj, role, **props):
        obj.parent = root
        obj.matrix_parent_inverse = Matrix.Identity(4)
        obj["role"] = role
        for k, v in props.items():
            obj[k] = v
        return obj

    nodes = {}
    roles = {"CAR_BODY": "vehicle-body", "CAR_GLASS": "vehicle-glass", "WINDSHIELD": "vehicle-glass",
             "CAR_INTERIOR": "vehicle-interior", "CAR_DETAILS": "vehicle-details"}
    for nd, role in roles.items():
        g = merged(nd)
        if g:
            nodes[nd] = adopt(base.build_node(nd, g, visual, materials, work, budget_log, 50.0 if nd == "CAR_INTERIOR" else 38.0), role)
    door_hinges = {}
    for nd in ("DOOR_FL", "DOOR_FR"):
        hinge = T(hinges_src[nd])
        door_hinges[nd] = hinge
        local = {c: (v - hinge, f) for c, (v, f) in merged(nd).items()}
        obj = base.build_node(nd, local, visual, materials, work, budget_log)
        obj.location = hinge.tolist()
        adopt(obj, "vehicle-door", openDeg=DOOR_OPEN_DEG, openSign=-1.0 if nd == "DOOR_FL" else 1.0)
        nodes[nd] = obj
    sw_groups = merged("STEERING_WHEEL")
    rim = np.concatenate([v for v, _ in sw_groups.values()])
    hub, toward_driver = axis_frame(rim)
    r_sw = np.column_stack([[1.0, 0.0, 0.0], toward_driver, np.cross([1.0, 0.0, 0.0], toward_driver)])
    sw = base.build_node("STEERING_WHEEL", {c: ((v - hub) @ r_sw, f) for c, (v, f) in sw_groups.items()},
                         visual, materials, work, budget_log, 45.0)
    sw.matrix_world = Matrix.Translation(hub.tolist()) @ Matrix(r_sw.tolist()).to_4x4()
    adopt(sw, "steering-wheel", lockDeg=STEERING_LOCK_DEG)
    nodes["STEERING_WHEEL"] = sw
    wheel_radius, wheel_width = wheel_radius_src * s, wheel_width_src * s
    wheel_positions = {}
    for nd in car["wheels"]:
        side = 1.0 if nd.endswith("L") else -1.0
        y = front_y if nd[-2] == "F" else rear_y
        pos = T((side * track_x, y, 0.0))
        pos[2] = wheel_radius
        obj = base.build_wheel(nd, side, wheel_radius, wheel_width, visual, materials)
        obj.location = pos.tolist()
        adopt(obj, "wheel")
        nodes[nd] = obj
        wheel_positions[nd] = pos

    # Sockets.
    bpy.context.view_layer.update()

    def verts_of(obj):
        me = obj.data
        co = np.empty(len(me.vertices) * 3)
        me.vertices.foreach_get("co", co)
        return co.reshape(-1, 3) @ np.array(obj.matrix_world.to_3x3()).T + np.array(obj.matrix_world.translation)

    bco = verts_of(nodes["CAR_BODY"])
    body_lo, body_hi = bco.min(axis=0), bco.max(axis=0)
    rx0, rx1, ry0, ry1 = car["roofBox"]
    roof_lo, roof_hi = T(np.array([rx0, ry0, 0.0]) @ frame.T), T(np.array([rx1, ry1, 0.0]) @ frame.T)
    rlo, rhi = np.minimum(roof_lo, roof_hi), np.maximum(roof_lo, roof_hi)
    shell = np.concatenate([verts_of(nodes[n]) for n in ("CAR_BODY", "CAR_GLASS", "CAR_INTERIOR") if n in nodes])
    roof_mask = (shell[:, 0] > rlo[0]) & (shell[:, 0] < rhi[0]) & (shell[:, 1] > rlo[1]) & (shell[:, 1] < rhi[1])
    roof_z = float(shell[roof_mask][:, 2].max())
    seat_xy = T(np.array([*car["seat"], 0.0]) @ frame.T)
    seat_move = next((m[4] for m in car["moves"] if m[0] == "driver seat"), (0.0, 0.0, 0.0))
    seat_xy += (seat_move[0], -seat_move[2], 0.0)
    # The cushion: the first interior surface straight down from under the roof at the seat point (the highest
    # vertex nearby picked up bolsters and seat backs).
    interior = nodes["CAR_INTERIOR"]
    to_local = interior.matrix_world.inverted()
    tree = BVHTree.FromObject(interior, bpy.context.evaluated_depsgraph_get())
    hit = tree.ray_cast(to_local @ Vector((seat_xy[0], seat_xy[1], roof_z - 0.1)), to_local.to_3x3() @ Vector((0, 0, -1)))
    if hit[0] is None:
        raise ValueError("no cushion under the seat point")
    cushion = float((interior.matrix_world @ hit[0]).z)

    def lamp_centre(cls, side, front):
        pts = []
        for obj in nodes.values():
            if obj.type != "MESH":
                continue
            ci = CLASSES.index(cls)
            vw = verts_of(obj)
            for p in obj.data.polygons:
                if p.material_index == ci:
                    pts.extend(vw[list(p.vertices)])
        pts = np.array(pts)
        pts = pts[(pts[:, 0] * side > 0.1) & ((pts[:, 1] < 0) == front)]  # the front faces -Y
        return (pts.min(axis=0) + pts.max(axis=0)) / 2

    door_centre = T(np.array(car["doorCentre"]) @ frame.T)
    sockets = {"SEAT_DRIVER": np.array([seat_xy[0], seat_xy[1], cushion + SEAT_ABOVE_CUSHION]),
               "LIGHT_HEAD_L": lamp_centre("lamp_head", 1.0, True), "LIGHT_HEAD_R": lamp_centre("lamp_head", -1.0, True),
               "LIGHT_TAIL_L": lamp_centre("lamp_tail", 1.0, False), "LIGHT_TAIL_R": lamp_centre("lamp_tail", -1.0, False)}
    sockets.update({
                    "EXIT_DRIVER": np.array([EXIT_X, door_centre[1], 0.0]), "EXIT_PASSENGER": np.array([-EXIT_X, door_centre[1], 0.0]),
                    "CAMERA_CHASE": np.array([0.0, 7.5, 2.3]), "CENTER_OF_MASS": np.array([0.0, -0.15, 0.45]),
                    "LIGHTBAR": np.array([0.0, (rlo[1] + rhi[1]) / 2, roof_z + 0.005])})
    purposes = {sk["node"]: sk["purpose"] for sk in contract["sockets"]}
    for name, pos in sockets.items():
        empty = bpy.data.objects.new(name, None)
        empty.empty_display_type = "PLAIN_AXES"
        empty.empty_display_size = 0.2
        empty.location = pos.tolist()
        visual.objects.link(empty)
        adopt(empty, "socket", purpose=purposes.get(name, name))
    bpy.data.collections.remove(work)

    # 5. One variant.
    variant = contract["variants"][0]
    objects = list(visual.all_objects)
    glb = out / variant["file"]
    export_options = base.export_variant(glb, objects)
    blob = glb.read_bytes()
    tris, mats = base.node_stats(objects)
    (out / "debug").mkdir(exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(out / "debug" / f"{variant['id']}-build.blend"), compress=True)

    # 6. Report (positions in glTF asset axes: +X left, +Y up, +Z forward).
    body_size = body_hi - body_lo
    report = {
        "status": "EXPORTED_NOT_VERIFIED_IN_RUNTIME", "blender": bpy.app.version_string, "car": args.car,
        "label": car["label"], "assetId": contract["assetId"],
        "source": {"path": str(source), "bytes": len(source_bytes), "sha256": source_sha, **source_summary},
        "scale": {"factor": s, "sourceWheelbase": round(float(rear_y - front_y), 4), "sourceWheelRadius": round(wheel_radius_src, 4),
                  "rootInAuthoringFrame": base.rounded(root_src)},
        "axes": contract["axes"],
        "bodyBoundsLocal": {"min": [round(float(body_lo[0]), 4), round(float(body_lo[2]), 4), round(float(-body_hi[1]), 4)],
                            "max": [round(float(body_hi[0]), 4), round(float(body_hi[2]), 4), round(float(-body_lo[1]), 4)],
                            "lengthM": round(float(body_size[1]), 4), "widthM": round(float(body_size[0]), 4),
                            "heightM": round(float(body_hi[2]), 4), "note": "CAR_BODY only; height from the ground"},
        "wheelPositions": {n: base.to_gltf(p) for n, p in wheel_positions.items()},
        "wheelRadius": round(wheel_radius, 4), "wheelWidth": round(wheel_width, 4),
        "wheelbase": round(float((rear_y - front_y) * s), 4), "track": round(2 * track_x * s, 4),
        "doorHinges": {n: {"position": base.to_gltf(p), "openDeg": DOOR_OPEN_DEG, "openSign": -1.0 if n == "DOOR_FL" else 1.0,
                           "axis": "local +Y (vertical)"} for n, p in door_hinges.items()},
        "steeringWheel": {"position": base.to_gltf(hub), "columnAxisGltf": base.to_gltf(-toward_driver), "lockDeg": STEERING_LOCK_DEG},
        "cushionHeight": round(cushion, 4), "roofHeight": round(roof_z, 4), "cabinFit": moves_log,
        "sockets": {n: {"position": base.to_gltf(p), "purpose": purposes.get(n, n)} for n, p in sockets.items()},
        "variants": {variant["id"]: {"file": glb.name, "bytes": len(blob), "sha256": hashlib.sha256(blob).hexdigest(),
                                     "triangles": tris, "materials": mats, "materialCount": len(mats), "textures": [],
                                     "paint": variant["paint"]}},
        "decimation": budget_log,
        "removedParts": removed + [{"what": "all source textures dropped (badges, lettering and gauge faces live there); flat PBR materials instead"},
                                   {"what": "source wheels replaced by procedural tyre/rim/rotor at the measured hubs"}],
        "exportOptions": export_options,
    }
    (out / "blender-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({variant["id"]: {"bytes": len(blob), "triangles": tris["total"], "materials": len(mats),
                                      "size": report["bodyBoundsLocal"], "cushion": report["cushionHeight"], "roof": roof_z}}))


if __name__ == "__main__":
    main()
