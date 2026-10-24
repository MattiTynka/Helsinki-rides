"""Build a synthetic test character that differs from Snow on purpose: Mixamo-style bone names,
character facing +Y, A-pose arms, three-bone fingers without metacarpals, and an FBX-like object
transform (90 degrees about X, scale 0.01, bones authored in centimetres). Each limb chain is one
continuous tube with distance-blended weights, so skin_check sees real joint deformation.

blender -b --factory-startup --python make_test_rig.py -- --output /abs/test_rig.blend
"""
import math
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

out = sys.argv[sys.argv.index("--") + 1:][sys.argv[sys.argv.index("--") + 1:].index("--output") + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)
P = "mixamorig:"
M = Matrix.Rotation(math.radians(90), 4, "X") @ Matrix.Scale(0.01, 4)  # FBX-style import transform
Minv = M.inverted()

# World-space joints (metres, Z up, facing +Y, character left = -X)
J = {}
spine = [("Hips", 0.98, 1.08), ("Spine", 1.08, 1.20), ("Spine1", 1.20, 1.32), ("Spine2", 1.32, 1.48),
         ("Neck", 1.48, 1.58), ("Head", 1.58, 1.76)]
bones = []  # (name, head, tail, parent)
prev = None
for n, z0, z1 in spine:
    bones.append((n, Vector((0, 0, z0)), Vector((0, 0.005, z1)), prev))
    prev = n
for side, sx in (("Left", -1), ("Right", 1)):
    hip = Vector((0.09 * sx, 0, 0.94))
    knee = Vector((0.09 * sx, 0.012, 0.52))
    ankle = Vector((0.09 * sx, 0, 0.09))
    ball = Vector((0.09 * sx, 0.13, 0.025))
    toe = Vector((0.09 * sx, 0.21, 0.02))
    bones += [(f"{side}UpLeg", hip, knee, "Hips"), (f"{side}Leg", knee, ankle, f"{side}UpLeg"),
              (f"{side}Foot", ankle, ball, f"{side}Leg"), (f"{side}ToeBase", ball, toe, f"{side}Foot")]
    sh0 = Vector((0.03 * sx, 0.0, 1.44))
    sh1 = Vector((0.17 * sx, 0.0, 1.45))
    down = Vector((0.7071 * sx, 0, -0.7071))  # A-pose, 45 degrees
    elbow = sh1 + down * 0.28
    wrist = elbow + down * 0.25 + Vector((0, 0.01, 0))
    hand_end = wrist + down * 0.08
    bones += [(f"{side}Shoulder", sh0, sh1, "Spine2"), (f"{side}Arm", sh1, elbow, f"{side}Shoulder"),
              (f"{side}ForeArm", elbow, wrist, f"{side}Arm"), (f"{side}Hand", wrist, hand_end, f"{side}ForeArm")]
    for k, (f, off) in enumerate((("Index", 0.022), ("Middle", 0.007), ("Ring", -0.008), ("Pinky", -0.022))):
        base = hand_end + Vector((0, off, 0))
        p = f"{side}Hand"
        for i in range(3):
            a = base + down * (0.028 * i)
            b = base + down * (0.028 * (i + 1))
            bones.append((f"{side}Hand{f}{i + 1}", a, b, p))
            p = f"{side}Hand{f}{i + 1}"
    t0 = wrist + down * 0.02 + Vector((0, 0.03, 0))
    tdir = (down + Vector((0, 0.8, 0))).normalized()
    p = f"{side}Hand"
    for i in range(3):
        a, b = t0 + tdir * (0.03 * i), t0 + tdir * (0.03 * (i + 1))
        bones.append((f"{side}HandThumb{i + 1}", a, b, p))
        p = f"{side}HandThumb{i + 1}"

arm = bpy.data.armatures.new("TestArmature")
rig = bpy.data.objects.new("TestArmature", arm)
bpy.context.scene.collection.objects.link(rig)
rig.matrix_world = M
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode="EDIT")
for n, h, t, par in bones:
    eb = arm.edit_bones.new(P + n)
    eb.head, eb.tail = Minv @ h, Minv @ t
    eb.roll = 0.3 * len(n) % 1.0  # arbitrary rolls: the pipeline must not assume a roll convention
    if par:
        eb.parent = arm.edit_bones[P + par]
        eb.use_connect = (eb.parent.tail - eb.head).length < 1e-6
bpy.ops.object.mode_set(mode="OBJECT")


# --- Skin: one tube per chain, weights blended by distance to bone segments ---------------------------
def seg_dist(p, a, b):
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / ab.length_squared))
    return (p - (a + ab * t)).length


def tube(name, chain, radius, rings_per_m=60, sides=12):
    pts = [bones_by[c][0] for c in chain] + [bones_by[chain[-1]][1]]
    bm = bmesh.new()
    rings = []
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        d = (b - a).normalized()
        u = d.orthogonal().normalized()
        v = d.cross(u)
        n = max(2, int((b - a).length * rings_per_m))
        for k in range(n + (1 if i == len(pts) - 2 else 0)):
            c = a + (b - a) * (k / n)
            r = radius(i, k / n)
            rings.append([bm.verts.new(c + (u * math.cos(2 * math.pi * s / sides) + v * math.sin(2 * math.pi * s / sides)) * r)
                          for s in range(sides)])
    for r0, r1 in zip(rings, rings[1:]):
        for s in range(sides):
            bm.faces.new((r0[s], r0[(s + 1) % sides], r1[(s + 1) % sides], r1[s]))
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    cand = chain + [c for c in bones_by if bones_by[c][2] in chain and c not in chain]
    if bones_by[chain[0]][2]:
        cand.append(bones_by[chain[0]][2])
    for c in cand:
        ob.vertex_groups.new(name=P + c)
    for v in me.vertices:
        p = v.co
        w = np.array([1.0 / (seg_dist(p, bones_by[c][0], bones_by[c][1]) ** 4 + 1e-7) for c in cand])
        w /= w.sum()
        for c, wi in zip(cand, w):
            if wi > 0.01:
                ob.vertex_groups[P + c].add([v.index], float(wi), "REPLACE")
    me.transform(Minv)  # store in the same FBX-style object space as the rig
    ob.matrix_world = M
    ob.parent = rig
    ob.matrix_parent_inverse = rig.matrix_world.inverted()
    mod = ob.modifiers.new("Armature", "ARMATURE")
    mod.object = rig
    mat = bpy.data.materials.new(name + "_mat")
    mat.use_nodes = True
    mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.2, 0.45, 0.8, 1)
    me.materials.append(mat)
    return ob


bones_by = {n: (h, t, par) for n, h, t, par in bones}
tube("Body", ["Hips", "Spine", "Spine1", "Spine2", "Neck", "Head"], lambda i, f: [0.13, 0.14, 0.15, 0.13, 0.05, 0.09][i])
for side in ("Left", "Right"):
    tube(f"{side}LegMesh", [f"{side}UpLeg", f"{side}Leg", f"{side}Foot"], lambda i, f: [0.075 - 0.02 * f, 0.05 - 0.01 * f, 0.04][i])
    tube(f"{side}ArmMesh", [f"{side}Arm", f"{side}ForeArm", f"{side}Hand"], lambda i, f: [0.045, 0.038 - 0.008 * f, 0.025][i])
bpy.ops.wm.save_as_mainfile(filepath=out)
print("saved", out, "bones", len(bones))
