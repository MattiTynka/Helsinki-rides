"""texture-mapping-3d: headless Blender entry point (target release pinned by --require, default 5.2).

Run through the launcher so the exit code, version pin and logs are wired:
    python run_blender.py -- <command> [options]

Commands: inspect, calibrate, recolour, project, tone, render, handoff, transfer, apply, verify, selftest.
Analysis commands open the .blend with scripts disabled and never save it. Only `apply` writes a
new .blend, always to a path that does not exist yet.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))

import numpy as np
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

import tm3d_lib as L

VIEW_LABELS = ('front', 'back', 'left', 'right', 'top', 'bottom')
IMAGE_EXT = ('.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff', '.bmp', '.exr')


# ====================================================================== basics

def log(msg):
    print(f'[tm3d] {msg}', flush=True)


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def write_json(path, data):
    Path(path).write_text(json.dumps(data, indent=2, default=_json_default), encoding='utf-8')


def _json_default(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    raise TypeError(type(o))


def fresh_dir(path):
    p = Path(path).resolve()
    if p.exists() and any(p.iterdir()):
        raise SystemExit(f'Output directory {p} already has files; choose a new run directory instead of overwriting')
    p.mkdir(parents=True, exist_ok=True)
    return p


def require_version(target):
    want = tuple(int(x) for x in target.split('.')[:2])
    if bpy.app.version[:2] != want:
        raise SystemExit(f'Blender {bpy.app.version_string} does not match the pinned release {target}')


TEXTURE_DIRS = []  # extra folders searched for missing image files (--texture-dir)
PATH_FIXES = []  # in-memory repairs made by the last open_blend


def open_blend(path, resolve=True):
    """Open a .blend with scripts disabled. With resolve, images whose files are missing are
    pointed (in memory only) at same-named files near the .blend so their pixels can be read."""
    path = str(Path(path).resolve())
    bpy.ops.wm.open_mainfile(filepath=path, load_ui=False, use_scripts=False)
    PATH_FIXES[:] = resolve_missing_images(path, TEXTURE_DIRS) if resolve else []
    for fix in PATH_FIXES:
        log(f"image path {'repaired in memory' if fix['resolved'] else 'MISSING'}: {fix['image']} -> {fix['resolved'] or fix['missing']}")
    return path


def warn_missing_textures(cmd):
    missing = [f['image'] for f in PATH_FIXES if not f['resolved']]
    if missing:
        log(f"{cmd}: WARNING {len(missing)} texture file(s) missing ({', '.join(missing[:4])}{', ...' if len(missing) > 4 else ''}); "
            'the render is not what the file should look like. Apply with --repair-paths')


def resolve_missing_images(blend_path, extra_dirs=()):
    base = Path(blend_path).parent
    dirs = [Path(d) for d in extra_dirs] + [base, base / 'textures', base / 'Textures', base.parent / 'textures']
    dirs += sorted(p for p in base.iterdir() if p.is_dir())
    fixes = []
    for im in bpy.data.images:
        if im.packed_file or im.library or im.source not in ('FILE', 'TILED') or not im.filepath:
            continue
        probe = image_tile_path(im, image_tiles(im)[0])
        if os.path.exists(probe):
            continue
        name = probe.replace('\\', '/').rsplit('/', 1)[-1]
        hit = next((d / name for d in dirs if (d / name).is_file()), None)
        if hit is None:
            fixes.append({'image': im.name, 'missing': probe, 'resolved': None})
            continue
        new = str(hit)
        if im.source == 'TILED':
            new = re.sub(r'\.\d{4}(?=\.[A-Za-z0-9]+$)', '.<UDIM>', new)
        im.filepath = new
        im.reload()
        fixes.append({'image': im.name, 'missing': probe, 'resolved': new})
    return fixes


def set_pose(mode, frame=None):
    scene = bpy.context.scene
    if frame is not None:
        scene.frame_set(int(frame))
    for ob in bpy.data.objects:
        if ob.type == 'ARMATURE':
            ob.data.pose_position = 'REST' if mode == 'rest' else 'POSE'
    bpy.context.view_layer.update()
    return {'mode': mode, 'frame': scene.frame_current}


def safe_stem(name):
    stem = re.sub(r'\.(\d{4}|<UDIM>)(?=\.[A-Za-z0-9]+$)', '', name)
    stem = re.sub(r'\.[A-Za-z0-9]+$', '', stem)
    return re.sub(r'[^A-Za-z0-9._-]+', '_', stem) or 'texture'


# ====================================================================== scene analysis

def _visible_collections():
    visible = set()

    def walk(lc, parent_ok):
        ok = parent_ok and not lc.exclude and not lc.collection.hide_render
        if ok:
            visible.add(lc.collection.name)
        for child in lc.children:
            walk(child, ok)

    walk(bpy.context.view_layer.layer_collection, True)
    return visible


def render_meshes():
    """Mesh objects a render would show (object and collection render flags, view-layer exclusion)."""
    cols = _visible_collections()
    out = []
    for ob in bpy.context.view_layer.objects:
        if ob.type != 'MESH' or ob.hide_render or len(ob.data.polygons) == 0:
            continue
        if any(c.name in cols for c in ob.users_collection):
            out.append(ob)
    return out


def is_rigged(ob):
    if any(m.type == 'ARMATURE' and m.object for m in ob.modifiers):
        return True
    p = ob.parent
    while p is not None:
        if p.type == 'ARMATURE':
            return True
        p = p.parent
    return False


def character_meshes(names=None, include=None, exclude=None):
    """Render meshes that belong to the character.

    names: exact list (from views.json). Otherwise --objects regex, else the rigged meshes when
    any exist (so studio floors, backdrops and props are left out), minus --exclude regex.
    """
    meshes = render_meshes()
    if names is not None:
        wanted = set(names)
        return [ob for ob in meshes if ob.name in wanted]
    if include:
        meshes = [ob for ob in meshes if re.search(include, ob.name)]
    elif any(is_rigged(ob) for ob in meshes):
        meshes = [ob for ob in meshes if is_rigged(ob)]
    if exclude:
        meshes = [ob for ob in meshes if not re.search(exclude, ob.name)]
    if not meshes:
        raise SystemExit('No character meshes selected; check --objects / --exclude')
    return meshes


def _resolve_link(link, stack):
    node, sock = link.from_node, link.from_socket
    while node.type == 'REROUTE':
        if not node.inputs[0].is_linked:
            return None, None, stack
        link = node.inputs[0].links[0]
        node, sock = link.from_node, link.from_socket
    return node, sock, stack


MASK_SOCKETS = ('Factor', 'Fac', 'Alpha')


def upstream_images(socket, stack=(), seen=None, role='color', depth=0):
    """Image Texture nodes feeding `socket`, entering node groups, in socket order.

    Returns [(node, stack, role, depth)]: role is 'mask' when the path passes through a mix
    Factor/Fac/Alpha input or any scalar input such as a ColorRamp factor (the image steers
    colours rather than being one), else 'color'.
    """
    seen = set() if seen is None else seen
    found = []
    for link in socket.links:
        if link.is_muted or not link.is_valid:
            continue
        node, sock, st = _resolve_link(link, stack)
        if node is None:
            continue
        key = (node.id_data.name, node.name, sock.identifier, tuple(n.name for n in st), role)
        if key in seen:
            continue
        seen.add(key)
        if node.type == 'TEX_IMAGE':
            if node.image:
                found.append((node, st, role, depth))
        elif node.type == 'GROUP' and node.node_tree:
            for inner in node.node_tree.nodes:
                if inner.type == 'GROUP_OUTPUT':
                    for inp in inner.inputs:
                        if inp.identifier == sock.identifier:
                            found += upstream_images(inp, st + (node,), seen, role, depth + 1)
        elif node.type == 'GROUP_INPUT' and st:
            outer = st[-1]
            for inp in outer.inputs:
                if inp.identifier == sock.identifier:
                    found += upstream_images(inp, st[:-1], seen, role, depth + 1)
        else:
            for inp in node.inputs:
                if inp.is_linked:
                    scalar = inp.type == 'VALUE' or (inp.name in MASK_SOCKETS and node.type in ('MIX', 'MIX_RGB', 'MIX_SHADER'))
                    r = 'mask' if scalar else role
                    found += upstream_images(inp, st, seen, r, depth + 1)
    return found


def uv_of_image_node(node, stack):
    """'' = object's render UV layer, a name = explicit UV Map node, None = unsupported mapping."""
    if getattr(node, 'projection', 'FLAT') != 'FLAT':
        return None
    sock = node.inputs.get('Vector')
    if sock is None or not sock.is_linked:
        return ''
    src, out, st = _resolve_link(sock.links[0], stack)
    if src is None:
        return ''
    if src.type == 'UVMAP':
        return src.uv_map
    if src.type == 'TEX_COORD' and out.name == 'UV':
        return ''
    if src.type == 'GROUP_INPUT' and st:
        outer = st[-1]
        for inp in outer.inputs:
            if inp.identifier == out.identifier:
                if not inp.is_linked:
                    return ''
                n2, o2, st2 = _resolve_link(inp.links[0], st[:-1])
                if n2 is not None and n2.type == 'UVMAP':
                    return n2.uv_map
                if n2 is not None and n2.type == 'TEX_COORD' and o2.name == 'UV':
                    return ''
    return None


def base_color_nodes(material, roles=('color',)):
    """Image nodes feeding Base Color of Principled (or Color of Diffuse) BSDFs, at any group depth.

    Returns [(node, stack, role, depth)] in socket order, so the first entry is the primary colour map.
    """
    found = []

    def walk(tree, stack):
        for node in tree.nodes:
            if node.type == 'BSDF_PRINCIPLED':
                found.extend(upstream_images(node.inputs['Base Color'], stack))
            elif node.type == 'BSDF_DIFFUSE':
                found.extend(upstream_images(node.inputs['Color'], stack))
            elif node.type == 'GROUP' and node.node_tree:
                walk(node.node_tree, stack + (node,))

    if material and material.node_tree:
        walk(material.node_tree, ())
    return [f for f in found if f[2] in roles]


def flat_base_color(material):
    if material and material.node_tree:
        for node in material.node_tree.nodes:
            if node.type == 'BSDF_PRINCIPLED' and not node.inputs['Base Color'].is_linked:
                return list(node.inputs['Base Color'].default_value)[:3]
    if material:
        return list(material.diffuse_color)[:3]
    return [0.6, 0.6, 0.6]


def render_uv_name(ob):
    for layer in ob.data.uv_layers:
        if layer.active_render:
            return layer.name
    return ob.data.uv_layers[0].name if ob.data.uv_layers else None


def image_tiles(image):
    return [t.number for t in image.tiles] if image.source == 'TILED' else [1001]


def image_tile_path(image, tile):
    path = bpy.path.abspath(image.filepath_raw or image.filepath)
    if image.source == 'TILED':
        return path.replace('<UDIM>', str(tile)) if '<UDIM>' in path else re.sub(r'\.\d{4}\.', f'.{tile}.', path)
    return path


def bsdf_color_inputs(material):
    """Top-level Principled 'Base Color' / Diffuse 'Color' inputs of a material: [(node, socket)]."""
    out = []
    if material and material.node_tree:
        for node in material.node_tree.nodes:
            if node.type == 'BSDF_PRINCIPLED':
                out.append((node, node.inputs['Base Color']))
            elif node.type == 'BSDF_DIFFUSE':
                out.append((node, node.inputs['Color']))
    return out


NEW_DENSITY, NEW_MIN, NEW_MAX = 2048, 256, 2048  # new base-colour images: texels per metre, size limits


def target_stem(t):
    if t.get('kind') == 'new':
        return re.sub(r'[^A-Za-z0-9._-]+', '_', t['material']) + '_basecolor'
    return safe_stem(t['image'])


def _layout_new_target(t):
    """Tiles and a square size for a new image from the users' UV layout and surface area."""
    world, uv_area, tiles = 0.0, 0.0, set()
    for user in t['users']:
        ob = bpy.data.objects[user['object']]
        me = ob.data
        me.calc_loop_triangles()
        n = len(me.loop_triangles)
        loops = np.empty(n * 3, np.int32)
        me.loop_triangles.foreach_get('loops', loops)
        mat = np.empty(n, np.int32)
        me.loop_triangles.foreach_get('material_index', mat)
        area = np.empty(n, np.float32)
        me.loop_triangles.foreach_get('area', area)
        uv = np.empty(len(me.loops) * 2, np.float32)
        me.uv_layers[user['uv']].data.foreach_get('uv', uv)
        sel = np.isin(mat, user['slots'])
        tri_uv = uv.reshape(-1, 2)[loops.reshape(-1, 3)[sel]].astype(np.float64)
        e1, e2 = tri_uv[:, 1] - tri_uv[:, 0], tri_uv[:, 2] - tri_uv[:, 0]
        uv_area += 0.5 * float(np.abs(e1[:, 0] * e2[:, 1] - e1[:, 1] * e2[:, 0]).sum())
        world += float(area[sel].sum()) * abs(np.linalg.det(np.array(ob.matrix_world)[:3, :3])) ** (2.0 / 3.0)
        c = tri_uv.mean(axis=1)
        tiles |= set(L.udim_of(c[:, 0], c[:, 1]).tolist())
    res = NEW_DENSITY * math.sqrt(world / uv_area) if world > 0 and uv_area > 0 else NEW_MIN
    res = int(2 ** round(math.log2(max(NEW_MIN, min(NEW_MAX, res)))))
    t['tiles'] = sorted(tiles) or [1001]
    t['source'] = 'TILED' if len(t['tiles']) > 1 else 'FILE'
    t['size'] = [res, res]
    t['surface_m2'] = round(world, 5)
    t['uv_area'] = round(uv_area, 5)


def color_targets(meshes=None):
    """Base-colour targets and the (object, slot, uv layer) faces that sample them.

    kind 'image': an existing image that is (part of) a base colour; projection writes a new
    version of it. kind 'new' (key 'new:<material>'): the material's base colour has no colour
    image (flat, vertex colour, ramp or procedural); projection writes a new image that `apply`
    wires into the Base Color input, leaving the old nodes in place but unlinked.
    """
    meshes = meshes if meshes is not None else render_meshes()
    targets = {}
    for ob in meshes:
        for slot_index, slot in enumerate(ob.material_slots):
            found = base_color_nodes(slot.material, roles=('color', 'mask'))
            first_color = next((i for i, f in enumerate(found) if f[2] == 'color'), None)
            if first_color is None and bsdf_color_inputs(slot.material):
                mat = slot.material
                inputs = bsdf_color_inputs(mat)
                t = targets.setdefault('new:' + mat.name, {
                    'image': 'new:' + mat.name, 'kind': 'new', 'material': mat.name, 'source': 'FILE', 'tiles': [1001],
                    'size': [0, 0], 'colorspace': 'sRGB', 'filepath': None, 'packed': False, 'role': 'color',
                    'primary_in': [mat.name], 'users': [], 'unsupported': [], 'bsdf_nodes': [n.name for n, _ in inputs],
                    'replaces': sorted({(s.links[0].from_node.bl_idname if s.is_linked else 'flat colour') for _, s in inputs})})
                uv_name = render_uv_name(ob)
                if uv_name is None:
                    t['unsupported'].append(f'{ob.name}[{slot_index}] has no UV layer')
                else:
                    user = next((u for u in t['users'] if u['object'] == ob.name and u['uv'] == uv_name), None)
                    if user is None:
                        t['users'].append({'object': ob.name, 'uv': uv_name, 'slots': [slot_index]})
                    elif slot_index not in user['slots']:
                        user['slots'].append(slot_index)
            for rank, (node, stack, role, depth) in enumerate(found):
                img = node.image
                uv = uv_of_image_node(node, stack)
                t = targets.setdefault(img.name, {'image': img.name, 'kind': 'image', 'source': img.source, 'tiles': image_tiles(img),
                                                  'size': list(img.size), 'colorspace': img.colorspace_settings.name,
                                                  'filepath': bpy.path.abspath(img.filepath), 'packed': bool(img.packed_file),
                                                  'role': role, 'primary_in': [], 'users': [], 'unsupported': []})
                if rank == first_color and slot.material.name not in t['primary_in']:
                    t['primary_in'].append(slot.material.name)
                if uv is None:
                    t['unsupported'].append(f'{ob.name}[{slot_index}] uses a non-UV mapping or box projection')
                    continue
                uv_name = uv or render_uv_name(ob)
                if uv_name not in ob.data.uv_layers:
                    t['unsupported'].append(f'{ob.name}[{slot_index}] UV layer {uv_name!r} missing')
                    continue
                user = next((u for u in t['users'] if u['object'] == ob.name and u['uv'] == uv_name), None)
                if user is None:
                    t['users'].append({'object': ob.name, 'uv': uv_name, 'slots': [slot_index]})
                elif slot_index not in user['slots']:
                    user['slots'].append(slot_index)
    for t in targets.values():
        if t.get('kind') == 'new' and t['users']:
            _layout_new_target(t)
    return targets


def slot_shading(meshes):
    """(object, slot) -> ('image', image name, uv) or ('color', rgb) for previews."""
    table = {}
    for ob in meshes:
        for i, slot in enumerate(ob.material_slots):
            nodes = base_color_nodes(slot.material)
            entry = None
            for node, stack, _, _ in nodes:
                uv = uv_of_image_node(node, stack)
                if uv is not None:
                    entry = ('image', node.image.name, uv or render_uv_name(ob))
                    break
            table[(ob.name, i)] = entry or ('color', flat_base_color(slot.material))
        if not ob.material_slots:
            table[(ob.name, 0)] = ('color', [0.6, 0.6, 0.6])
    return table


# ====================================================================== evaluation

class MeshData:
    """World-space evaluated mesh arrays for one object."""

    def __init__(self, ob, uv_names, disable_types, keep_subsurf):
        self.name = ob.name
        toggled = []
        for m in ob.modifiers:
            if m.show_viewport and (m.type in disable_types or (m.type == 'SUBSURF' and not keep_subsurf)):
                m.show_viewport = False
                toggled.append(m)
        ob.hide_viewport = False
        try:
            ob.hide_set(False)
        except RuntimeError:
            pass
        bpy.context.view_layer.update()
        dg = bpy.context.evaluated_depsgraph_get()
        eo = ob.evaluated_get(dg)
        me = eo.to_mesh()
        try:
            mw = np.array(eo.matrix_world, dtype=np.float64)
            co = np.empty(len(me.vertices) * 3, np.float32)
            me.vertices.foreach_get('co', co)
            co = co.reshape(-1, 3).astype(np.float64)
            self.verts = co @ mw[:3, :3].T + mw[:3, 3]
            me.calc_loop_triangles()
            lt = me.loop_triangles
            n = len(lt)
            self.tri_loops = np.empty(n * 3, np.int32)
            lt.foreach_get('loops', self.tri_loops)
            self.tri_loops = self.tri_loops.reshape(-1, 3)
            self.tri_verts = np.empty(n * 3, np.int32)
            lt.foreach_get('vertices', self.tri_verts)
            self.tri_verts = self.tri_verts.reshape(-1, 3)
            self.tri_mat = np.empty(n, np.int32)
            lt.foreach_get('material_index', self.tri_mat)
            cn = np.empty(len(me.loops) * 3, np.float32)
            me.corner_normals.foreach_get('vector', cn)
            nmat = np.array(Matrix(eo.matrix_world).to_3x3().inverted_safe().transposed(), dtype=np.float64)
            cn = cn.reshape(-1, 3).astype(np.float64) @ nmat.T
            self.corner_normals = cn / np.maximum(np.linalg.norm(cn, axis=1, keepdims=True), 1e-12)
            self.uv = {}
            for name in uv_names:
                if name and name in me.uv_layers:
                    a = np.empty(len(me.loops) * 2, np.float32)
                    me.uv_layers[name].data.foreach_get('uv', a)
                    self.uv[name] = a.reshape(-1, 2).astype(np.float64)
        finally:
            eo.to_mesh_clear()
            for m in toggled:
                m.show_viewport = True

    @property
    def tri_co(self):
        return self.verts[self.tri_verts]

    @property
    def tri_nrm(self):
        return self.corner_normals[self.tri_loops]


def evaluate_scene(meshes, uv_need, disable_types=('MASK',), keep_subsurf=True):
    return {ob.name: MeshData(ob, uv_need.get(ob.name, ()), disable_types, keep_subsurf) for ob in meshes}


def scene_bounds(mesh_data):
    pts = np.concatenate([m.verts for m in mesh_data.values()])
    lo, hi = pts.min(0), pts.max(0)
    return lo, hi, float(np.linalg.norm(hi - lo))


def occluder_bvh(mesh_data):
    verts, tris, base = [], [], 0
    for m in mesh_data.values():
        verts.append(m.verts)
        tris.append(m.tri_verts + base)
        base += len(m.verts)
    v = np.concatenate(verts)
    t = np.concatenate(tris)
    return BVHTree.FromPolygons(v.tolist(), t.tolist(), all_triangles=True)


def ray_cast_many(bvh, origins, dirs, maxd):
    n = len(origins)
    dist = np.full(n, np.inf)
    index = np.full(n, -1, np.int64)
    loc = np.zeros((n, 3))
    rc = bvh.ray_cast
    for i, (o, d, m) in enumerate(zip(origins.tolist(), dirs.tolist(), maxd.tolist())):
        hit = rc(o, d, m)
        if hit[0] is not None:
            dist[i], index[i] = hit[3], hit[2]
            loc[i] = hit[0]
    return dist, index, loc


def find_nearest_many(bvh, points, maxd):
    n = len(points)
    dist = np.full(n, np.inf)
    index = np.full(n, -1, np.int64)
    loc = np.zeros((n, 3))
    fn = bvh.find_nearest
    for i, p in enumerate(points.tolist()):
        hit = fn(p, maxd)
        if hit[0] is not None:
            dist[i], index[i] = hit[3], hit[2]
            loc[i] = hit[0]
    return dist, index, loc


# ====================================================================== image IO

def load_pixels(path=None, image=None, max_size=None):
    """Return float32 (H, W, 4) bottom-up stored values (sRGB-encoded for byte images) and is_float."""
    own = image is None
    if own:
        image = bpy.data.images.load(str(path), check_existing=False)
    try:
        w, h = image.size
        if w == 0 or h == 0:
            raise ValueError(f'Image {path or image.name} has no pixels (missing file?)')
        if max_size and max(w, h) > max_size:
            s = max_size / max(w, h)
            image.scale(max(1, int(round(w * s))), max(1, int(round(h * s))))
            w, h = image.size
        a = np.empty(w * h * 4, np.float32)
        image.pixels.foreach_get(a)
        return a.reshape(h, w, 4), bool(image.is_float)
    finally:
        if own:
            bpy.data.images.remove(image)


def load_reference(path):
    """Reference image as top-down float32 (H, W, 4) sRGB-encoded values."""
    a, is_float = load_pixels(path)
    if is_float:
        a = a.copy()
        a[..., :3] = L.linear_to_srgb(a[..., :3])
    return a[::-1].copy()


def save_png(path, arr, top_down=False):
    """Save float array (H, W, 1|3|4) of sRGB-encoded values as PNG."""
    arr = np.asarray(arr, np.float32)
    if arr.ndim == 2:
        arr = arr[..., None]
    if top_down:
        arr = arr[::-1]
    h, w, c = arr.shape
    rgba = np.ones((h, w, 4), np.float32)
    rgba[..., :3] = arr[..., :1] if c == 1 else arr[..., :3]
    if c == 4:
        rgba[..., 3] = arr[..., 3]
    img = bpy.data.images.new(Path(path).stem, w, h, alpha=True)
    try:
        img.pixels.foreach_set(np.clip(rgba, 0, 1).ravel())
        img.filepath_raw = str(path)
        img.file_format = 'PNG'
        img.save()
    finally:
        bpy.data.images.remove(img)
    return str(path)


def resize(img, h2, w2):
    h, w = img.shape[:2]
    if (h, w) == (h2, w2):
        return img
    ys, xs = np.mgrid[0:h2, 0:w2]
    x = (xs.ravel() + 0.5) * w / w2 - 0.5
    y = (ys.ravel() + 0.5) * h / h2 - 0.5
    return L.bilinear(img.reshape(h, w, -1), x, y).reshape(h2, w2, -1)


# ====================================================================== texel fragments

class Fragments:
    """Texel samples of one target image: one row per (texel, covering triangle)."""

    def __init__(self, target, md, width, height, tiled):
        self.width, self.height = width, height
        self.tiles = list(target['tiles'])
        self.tiled = tiled
        cos, nrms, uvs, objs = [], [], [], []
        self.objects = []
        for user in target['users']:
            m = md[user['object']]
            sel = np.isin(m.tri_mat, user['slots'])
            if not sel.any():
                continue
            self.objects.append(user['object'])
            cos.append(m.tri_co[sel])
            nrms.append(m.tri_nrm[sel])
            uvs.append(m.uv[user['uv']][m.tri_loops[sel]])
            objs.append(np.full(sel.sum(), len(self.objects) - 1, np.int32))
        if not cos:
            raise ValueError(f"Target {target['image']} has no faces in the evaluated scene")
        co, nrm, uv, obj = (np.concatenate(x) for x in (cos, nrms, uvs, objs))
        origin = np.floor(uv.mean(axis=1))
        tile_of = 1001 + origin[:, 0].astype(np.int64) + 10 * origin[:, 1].astype(np.int64)
        parts = {k: [] for k in ('texel', 'pos', 'nrm', 'obj')}
        self.tile_tri_counts = {}
        self.stray_tris = 0
        for rank, tile in enumerate(self.tiles):
            sel = np.nonzero(tile_of == tile)[0] if tiled else np.arange(len(uv))
            if tiled and rank == 0:
                self.stray_tris = int((~np.isin(tile_of, self.tiles)).sum())
            self.tile_tri_counts[tile] = int(len(sel))
            if len(sel) == 0:
                continue
            local = uv[sel] - origin[sel][:, None, :]
            xy = np.stack([local[..., 0] * width - 0.5, local[..., 1] * height - 0.5], axis=-1)
            r = L.rasterize(xy, width, height)
            tri = sel[r['tri']]
            b = r['bary'].astype(np.float64)
            parts['texel'].append(rank * width * height + r['y'].astype(np.int64) * width + r['x'])
            parts['pos'].append(np.einsum('nk,nkj->nj', b, co[tri]))
            nn = np.einsum('nk,nkj->nj', b, nrm[tri])
            parts['nrm'].append(nn / np.maximum(np.linalg.norm(nn, axis=1, keepdims=True), 1e-12))
            parts['obj'].append(obj[tri])
        for k, v in parts.items():
            setattr(self, k, np.concatenate(v) if v else np.zeros((0, 3) if k in ('pos', 'nrm') else 0))
        self.count = len(self.tiles) * width * height
        self.covered = np.zeros(self.count, bool)
        self.covered[self.texel] = True

    def tile_view(self, flat, rank):
        n = self.width * self.height
        return flat[rank * n:(rank + 1) * n].reshape(self.height, self.width, *flat.shape[1:])


def work_size(target, work_res):
    w, h = target['size']
    if not w or not h:
        w = h = work_res
    s = min(1.0, work_res / max(w, h))
    return max(8, int(round(w * s))), max(8, int(round(h * s)))


def compose_and_save(target, frags, sw, swv, conf, out_dir, keep_original, stem, report, tone_match=True):
    """Blend the new layer over the original tiles by confidence, fill gaps, save PNG tiles.
    With tone_match the kept original is first recoloured to the tone the images show (L.tone_gains)."""
    image = bpy.data.images.get(target['image'])
    saved, stats, tiles = [], [], []
    has_new = sw > 0
    new_lin = np.zeros((frags.count, 3), np.float32)
    new_lin[has_new] = (swv[has_new] / sw[has_new, None]).astype(np.float32)
    for rank, tile in enumerate(frags.tiles):
        cov = frags.tile_view(frags.covered, rank)
        known = frags.tile_view(has_new, rank)
        layer = frags.tile_view(new_lin, rank)
        c = frags.tile_view(conf.astype(np.float32), rank)
        layer = L.push_pull_fill(layer, known)
        c = L.box_blur(np.where(known, c, 0.0), 2) * known
        orig = None
        if keep_original and image is not None:
            try:
                path = image_tile_path(image, tile)
                if image.packed_file and image.source != 'TILED':
                    o, is_float = load_pixels(image=image)
                else:
                    o, is_float = load_pixels(path)
                orig = L.srgb_to_linear(o[..., :3]) if not is_float else o[..., :3]
            except Exception as exc:  # missing tile file: report and continue without it
                report.setdefault('warnings', []).append(f'tile {tile}: original not loaded ({exc})')
        tiles.append((tile, cov, known, layer, c, orig))
    kept = [t for t in tiles if t[5] is not None]
    gains = None
    if tone_match and kept:
        gains = L.tone_gains([resize(t[5], *t[3].shape[:2]) for t in kept], [t[3] for t in kept],
                             [t[4] for t in kept], [t[1] for t in kept])
    gain_of = dict(zip([t[0] for t in kept], gains or []))
    for tile, cov, known, layer, c, orig in tiles:
        if orig is not None:
            oh, ow = orig.shape[:2]
            if tile in gain_of:
                orig = orig * resize(gain_of[tile], oh, ow)
            layer_n = resize(layer, oh, ow)
            c_n = resize(c[..., None], oh, ow)[..., 0]
            final = orig * (1 - c_n[..., None]) + layer_n * c_n[..., None]
        else:
            final = L.push_pull_fill(layer, cov | known)
            c_n = c
        suffix = f'.{tile}.png' if target['source'] == 'TILED' else '.png'
        name = stem + suffix
        saved.append(save_png(out_dir / name, L.linear_to_srgb(final)))
        save_png(out_dir / (stem + '_confidence' + suffix), np.clip(c_n, 0, 1))
        stats.append({'tile': tile, 'covered_texels': int(cov.sum()), 'textured_texels': int((known & cov).sum()),
                      'textured_fraction_of_covered': float((known & cov).sum() / max(1, cov.sum())),
                      'mean_confidence_covered': float(c[cov].mean()) if cov.any() else None,
                      'original_kept': orig is not None, 'tone_matched': tile in gain_of, 'output': name})
    return saved, stats


# ====================================================================== commands: inspect

def fingerprint(ob):
    me = ob.data
    h = hashlib.sha256()
    co = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get('co', co)
    h.update(np.round(co, 6).tobytes())
    vi = np.empty(len(me.loops), np.int32)
    me.loops.foreach_get('vertex_index', vi)
    h.update(vi.tobytes())
    geo = h.hexdigest()
    uvs = {}
    for layer in me.uv_layers:
        a = np.empty(len(me.loops) * 2, np.float32)
        layer.data.foreach_get('uv', a)
        uvs[layer.name] = hashlib.sha256(np.round(a, 6).tobytes()).hexdigest()
    wh = hashlib.sha256()
    for v in me.vertices:
        for g in v.groups:
            wh.update(f'{v.index}:{g.group}:{g.weight:.6f};'.encode())
    keys = {}
    if me.shape_keys:
        for kb in me.shape_keys.key_blocks:
            a = np.empty(len(kb.data) * 3, np.float32)
            kb.data.foreach_get('co', a)
            keys[kb.name] = hashlib.sha256(np.round(a, 6).tobytes()).hexdigest()
    return {'vertices': len(me.vertices), 'polygons': len(me.polygons), 'geometry_sha': geo, 'uv_sha': uvs,
            'vertex_groups': [g.name for g in ob.vertex_groups], 'weights_sha': wh.hexdigest(), 'shape_keys': keys,
            'modifiers': [[m.name, m.type] for m in ob.modifiers],
            'materials': [s.material.name if s.material else None for s in ob.material_slots],
            'parent': ob.parent.name if ob.parent else None, 'parent_type': ob.parent_type, 'parent_bone': ob.parent_bone,
            'matrix_world': np.round(np.array(ob.matrix_world), 6).tolist()}


def armature_fingerprint(ob):
    h = hashlib.sha256()
    for b in ob.data.bones:
        h.update(f'{b.name}|{b.parent.name if b.parent else ""}|{tuple(round(x, 6) for x in b.head_local)}|{tuple(round(x, 6) for x in b.tail_local)}|{b.use_deform};'.encode())
    return {'bones': len(ob.data.bones), 'bones_sha': h.hexdigest()}


def scene_fingerprint():
    meshes = render_meshes()
    return {'meshes': {ob.name: fingerprint(ob) for ob in meshes},
            'armatures': {ob.name: armature_fingerprint(ob) for ob in bpy.data.objects if ob.type == 'ARMATURE'}}


def cmd_inspect(a):
    src = open_blend(a.blend)
    meshes = character_meshes(None, a.objects, a.exclude)
    excluded = [ob.name for ob in render_meshes() if ob not in meshes]
    targets = color_targets(meshes)
    objs = []
    for ob in meshes:
        me = ob.data
        tiles = {}
        for layer in me.uv_layers:
            uv = np.empty(len(me.loops) * 2, np.float32)
            layer.data.foreach_get('uv', uv)
            uv = uv.reshape(-1, 2)
            t, c = np.unique(L.udim_of(uv[:, 0], uv[:, 1]), return_counts=True)
            tiles[layer.name] = {'active_render': layer.active_render, 'active_edit': layer.active,
                                 'tiles': {int(k): int(v) for k, v in zip(t, c)}}
        arm = next((m.object.name for m in ob.modifiers if m.type == 'ARMATURE' and m.object), None)
        objs.append({'name': ob.name, 'polygons': len(me.polygons), 'triangles_estimate': sum(len(p.vertices) - 2 for p in me.polygons),
                     'uv_layers': tiles, 'materials': [s.material.name if s.material else None for s in ob.material_slots],
                     'modifiers': [[m.name, m.type, m.show_viewport, m.show_render] for m in ob.modifiers],
                     'shape_keys': len(me.shape_keys.key_blocks) if me.shape_keys else 0, 'armature': arm,
                     'vertex_groups': len(ob.vertex_groups)})
    arms = [{'name': ob.name, 'bones': len(ob.data.bones), 'deform_bones': sum(b.use_deform for b in ob.data.bones),
             'pose_position': ob.data.pose_position, 'action': ob.animation_data.action.name if ob.animation_data and ob.animation_data.action else None}
            for ob in bpy.data.objects if ob.type == 'ARMATURE']
    report = {'blender': bpy.app.version_string, 'blend': src, 'blend_sha256': sha256(src), 'frame': bpy.context.scene.frame_current,
              'character_meshes': objs, 'excluded_render_meshes': excluded, 'armatures': arms, 'color_targets': targets,
              'image_path_repairs': PATH_FIXES,
              'drivers': sum(len(o.animation_data.drivers) for o in bpy.data.objects if o.animation_data),
              'fingerprint': scene_fingerprint(),
              'notes': ['UV layer per target is the one its image node samples (render-active unless a UV Map node names one); the edit-active layer is irrelevant.',
                        'Targets are base colours only; roughness, normal and other maps are left unchanged by this skill.',
                        "kind 'new' targets get a new image wired into Base Color by apply; old nodes stay in the material, unlinked.",
                        'image_path_repairs are in memory only; the source .blend is not changed (apply --repair-paths saves them in the output).']}
    out = Path(a.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        raise SystemExit(f'{out} exists; write a new report file')
    write_json(out, report)
    log(f'inspect: {len(objs)} character meshes ({len(excluded)} other render meshes excluded: {excluded}), {len(targets)} base-colour targets -> {out}')
    for name, t in targets.items():
        if t.get('kind') == 'new':
            kind = f"NEW image for material (replaces {', '.join(t['replaces'])})"
        else:
            kind = 'PRIMARY colour' if t['primary_in'] else ('secondary colour' if t['role'] == 'color' else 'mask/factor (left alone)')
        log(f"  {kind}: {name!r} {t['source']} tiles={t['tiles']} size={t['size']} users={[(u['object'], u['slots'], u['uv']) for u in t['users']]}"
            + (f" UNSUPPORTED={t['unsupported']}" if t['unsupported'] else ''))


# ====================================================================== commands: calibrate

def discover_views(img_dir):
    """{label: path} for front/back/left/right/top/bottom (or side) images in img_dir.

    If img_dir holds no view images but exactly one subfolder does (IMG/<character>/), use it.
    """
    def scan(folder):
        found = {}
        for p in sorted(folder.iterdir()):
            if not p.is_file() or p.suffix.lower() not in IMAGE_EXT or '_mask' in p.stem.lower():
                continue
            tokens = re.split(r'[^a-z]+', p.stem.lower())
            labels = [t for t in VIEW_LABELS if t in tokens] or (['side'] if 'side' in tokens else [])
            if len(labels) == 1:
                if labels[0] in found:
                    raise SystemExit(f'Two images claim the {labels[0]!r} view: {found[labels[0]].name} and {p.name}')
                found[labels[0]] = p
        return found

    root = Path(img_dir)
    found = scan(root)
    if found:
        return found
    subs = {d: scan(d) for d in sorted(root.iterdir()) if d.is_dir()}
    subs = {d: f for d, f in subs.items() if f}
    if len(subs) == 1:
        return next(iter(subs.values()))
    if subs:
        raise SystemExit(f'{root} has view images in several subfolders {[d.name for d in subs]}; pass the one for this character')
    return {}


# Camera search per view label: azimuths (0 = in front, 90 = character's left) and elevations in degrees.
VIEW_SEARCH = {
    'front': ((0,), (-20, -10, 0, 10, 20, 30)),
    'back': ((180,), (-20, -10, 0, 10, 20, 30)),
    'left': ((90, 270), (-20, -10, 0, 10, 20, 30)),
    'right': ((270, 90), (-20, -10, 0, 10, 20, 30)),
    'side': ((90, 270), (-20, -10, 0, 10, 20, 30)),
    'top': ((0, 90, 180, 270), (30, 45, 60, 75, 90)),
    'bottom': ((0, 90, 180, 270), (-30, -45, -60, -75, -90)),
}
PERSPECTIVE = (0.0, 0.17, 0.45, 0.8)  # character height / camera distance; 0 = orthographic
# Weak prior (expected elevation, its spread in degrees) per label. Silhouettes of round or symmetric
# shapes barely change with elevation or perspective; the prior settles such near-ties toward the
# view the label names, at a cost of a few thousandths of IoU, without overriding a clearly better fit.
VIEW_PRIOR = {'front': (0, 15), 'back': (0, 15), 'left': (0, 15), 'right': (0, 15), 'side': (0, 15), 'top': (70, 40), 'bottom': (-70, 40)}
PRIOR_WEIGHT = 0.003
COARSE = dict(res=160, fit=dict(iters=2, steps=5, grid=128))
FINE = dict(res=400, fit=dict(iters=2, steps=5, grid=256))
FINAL = dict(res=1024, fit=dict(iters=3, steps=7, grid=384))
WARP_RES = 512


class ViewFitter:
    """Silhouette fit of an orbiting camera (azimuth, elevation, roll, perspective) to a reference mask."""

    def __init__(self, md, facing):
        self.tri = np.concatenate([m.tri_co for m in md.values()])
        lo, hi, _ = scene_bounds(md)
        self.target = (lo + hi) / 2
        self.frame = L.character_frame(facing)
        self.height = float((hi - lo) @ self.frame[2])

    def basis(self, p):
        return L.look_basis(p['az'], p['el'], p['roll'], self.frame)

    def distance(self, p):
        return None if p['k'] <= 1e-6 else self.height / p['k']

    def evaluate(self, p, ref_mask, level, init=None):
        fwd, right, up, _ = self.basis(p)
        a, b, ok = L.view_coords(self.tri.reshape(-1, 3), fwd, right, up, self.target, self.distance(p))
        keep = ok.reshape(-1, 3).all(axis=1)
        tri_ab = np.stack([a, b], axis=-1).reshape(-1, 3, 2)[keep]
        sil, ext = L.silhouette_mask(tri_ab, level['res'])
        return L.fit_ortho(sil, ext, ref_mask, init=init, **level['fit'])

    def spec(self, p, fit, w, h):
        fwd, right, up, out = self.basis(p)
        s = {'kind': 'ORTHO', 'width': w, 'height': h, 'forward': fwd.tolist(), 'right': right.tolist(), 'up': up.tolist(),
             'azimuth': p['az'], 'elevation': p['el'], 'roll': p['roll'], 'perspective': p['k']}
        dist = self.distance(p)
        if dist is None:
            s.update(center=(self.target + fit['a_center'] * right + fit['b_center'] * up).tolist(), pixels_per_metre=fit['ppm'])
        else:  # plane units are metres at the target's depth (see view_coords)
            s.update(kind='PERSP', position=(self.target + out * dist).tolist(), focal_px=fit['ppm'] * dist,
                     cx=(w - 1) / 2.0 - fit['ppm'] * fit['a_center'], cy=(h - 1) / 2.0 + fit['ppm'] * fit['b_center'])
        return s

    @staticmethod
    def prior(p, label, az0):
        el0, spread = VIEW_PRIOR[label]
        daz = (p['az'] - az0 + 180.0) % 360.0 - 180.0
        return PRIOR_WEIGHT * (((p['el'] - el0) / spread) ** 2 + (daz / 12.0) ** 2 + (p['roll'] / 10.0) ** 2 + (p['k'] / 0.3) ** 2)

    def refine(self, p, ref_mask, label, rounds=3, passes=3):
        """Coordinate descent on IoU minus the prior. Returns (score, iou, params, fit)."""
        az0 = p['az']
        steps = {'el': 6.0, 'az': 6.0, 'k': 0.06, 'roll': 3.0}
        fit = self.evaluate(p, ref_mask, FINE)
        best = (fit['iou'] - self.prior(p, label, az0), fit['iou'], dict(p), fit)
        for _ in range(rounds):
            for _ in range(passes):
                improved = False
                for key in ('el', 'az', 'k', 'roll'):
                    for sgn in (-1, 1):
                        q = dict(best[2])
                        q[key] += sgn * steps[key]
                        q['k'] = max(0.0, q['k'])
                        q['el'] = float(np.clip(q['el'], -90, 90))
                        if q == best[2]:
                            continue
                        f2 = self.evaluate(q, ref_mask, FINE, init=best[3])
                        score = f2['iou'] - self.prior(q, label, az0)
                        if score > best[0] + 1e-4:
                            best, improved = (score, f2['iou'], q, f2), True
                if not improved:
                    break
            steps = {k: v / 2 for k, v in steps.items()}
        return best

    def search(self, label, ref_mask):
        """Coarse grid per azimuth family, then refine each family within reach of the best.

        Returns [(family azimuth, score, iou, params, fit)] best first, and coarse scores per family.
        """
        azs, els = VIEW_SEARCH[label]
        families = {}
        for az in azs:
            for el in els:
                for k in PERSPECTIVE:
                    p = {'az': float(az), 'el': float(el), 'roll': 0.0, 'k': float(k)}
                    s = self.evaluate(p, ref_mask, COARSE)['iou'] - self.prior(p, label, az)
                    if az not in families or s > families[az][0]:
                        families[az] = (s, p)
        top = max(s for s, _ in families.values())
        refined = [(az,) + self.refine(p, ref_mask, label) for az, (s, p) in families.items() if s >= top - 0.05]
        refined.sort(key=lambda r: -r[1])
        return refined, {az: round(s, 4) for az, (s, _) in families.items()}


def scaled_camera(spec, w2, h2):
    """Same camera for an image resized to (w2, h2), keeping pixel-centre alignment."""
    sx, sy = w2 / spec['width'], h2 / spec['height']
    c = dict(spec)
    c['width'], c['height'] = int(w2), int(h2)
    if c.get('kind', 'ORTHO') == 'ORTHO':
        c['pixels_per_metre'] = spec['pixels_per_metre'] * sx
    else:
        c['focal_px'] = spec['focal_px'] * sx
    for key, s, n in (('cx', sx, spec['width']), ('cy', sy, spec['height'])):
        v = spec.get(key, (n - 1) / 2.0)
        c[key] = (v + 0.5) * s - 0.5
    return c


def warp_lookup(view, views_dir):
    """Function mapping camera pixel coordinates to reference pixel coordinates (identity without a warp)."""
    info = view.get('warp')
    if not info:
        return lambda x, y: (x, y)
    u = np.load(Path(views_dir) / info['file'], allow_pickle=False)
    sx, sy = info['width'] / view['width'], info['height'] / view['height']

    def apply(x, y):
        d = np.zeros((len(x), 2), np.float32)
        ok = np.isfinite(x) & np.isfinite(y)
        d[ok] = L.bilinear(u, (x[ok] + 0.5) * sx - 0.5, (y[ok] + 0.5) * sy - 0.5)
        return x + d[:, 0] / sx, y + d[:, 1] / sy

    return apply


def surface_samples(md, n=40000, seed=0):
    tri = np.concatenate([m.tri_co for m in md.values()])
    nrm = np.concatenate([m.tri_nrm for m in md.values()]).mean(axis=1)
    pick = np.random.default_rng(seed).choice(len(tri), size=min(n, len(tri)), replace=False)
    nrm = nrm[pick] / np.maximum(np.linalg.norm(nrm[pick], axis=1, keepdims=True), 1e-12)
    return tri[pick].mean(axis=1), nrm


def visible_samples(cam, mask, pts, nrm, bvh, diag, min_cos=0.35):
    """Indices of sample points this camera sees inside the reference foreground, and their pixels."""
    x, y, _ = cam.project(pts)
    ok = np.isfinite(x) & np.isfinite(y) & (x >= 0) & (x <= cam.width - 1) & (y >= 0) & (y <= cam.height - 1)
    ok &= (nrm * cam.towards_camera(pts)).sum(axis=1) > min_cos
    idx = np.nonzero(ok)[0]
    idx = idx[mask[np.round(y[idx]).astype(int), np.round(x[idx]).astype(int)]]
    p = pts[idx]
    if cam.kind == 'ORTHO':
        far = 2.0 * diag + 1.0
        origins, dirs, lengths = p - cam.forward * far, np.broadcast_to(cam.forward, p.shape), np.full(len(p), far)
    else:
        d = p - cam.position
        lengths = np.linalg.norm(d, axis=1)
        origins, dirs = np.broadcast_to(cam.position, p.shape), d / lengths[:, None]
    eps = 2e-3 * diag
    dist, _, _ = ray_cast_many(bvh, origins, dirs, lengths + eps)
    idx = idx[dist >= lengths - eps]
    return idx, x, y


def photo_error(samples, bvh, diag, view_a, view_b):
    """Median colour disagreement between two calibrated references on surface points both see
    (exposure-normalised), relative to chance: the same median with the shared points shuffled.
    Plain colour areas agree with anything, so only agreement beyond chance counts. Lower is more
    consistent; None when they share too few points."""
    pts, nrm = samples
    (cam_a, col_a, mask_a), (cam_b, col_b, mask_b) = view_a, view_b
    ia, xa, ya = visible_samples(cam_a, mask_a, pts, nrm, bvh, diag)
    ib, xb, yb = visible_samples(cam_b, mask_b, pts, nrm, bvh, diag)
    both = np.intersect1d(ia, ib)
    if len(both) < 200:
        return None, int(len(both))
    ca = L.bilinear(col_a, xa[both], ya[both])
    cb = L.bilinear(col_b, xb[both], yb[both])
    ca /= np.maximum(ca.mean(axis=0), 1e-4)
    cb /= np.maximum(cb.mean(axis=0), 1e-4)
    chance = np.median(np.abs(ca - cb[np.random.default_rng(0).permutation(len(both))]).sum(axis=1))
    return float(np.median(np.abs(ca - cb).sum(axis=1)) / max(chance, 1e-6)), int(len(both))


def photo_consistency(samples, bvh, diag, anchors, view):
    """photo_error of a view against every anchor view it shares surface with, weighted by shared
    points. A back-above candidate shares nothing with the front but plenty with the back, so each
    candidate is judged by the views that actually see the same surface."""
    per = {}
    for name, anchor in anchors.items():
        err, n = photo_error(samples, bvh, diag, anchor, view)
        if err is not None:
            per[name] = {'error': err, 'shared_points': n}
    total = sum(e['shared_points'] for e in per.values())
    err = sum(e['error'] * e['shared_points'] for e in per.values()) / total if total else None
    return err, total, per


def camera_mask(cam, md):
    tri = np.concatenate([m.tri_co for m in md.values()])
    x, y, _ = cam.project(tri.reshape(-1, 3))
    xy = np.stack([x, y], axis=-1).reshape(-1, 3, 2)
    r = L.rasterize(xy, cam.width, cam.height)
    mask = np.zeros((cam.height, cam.width), bool)
    mask[r['y'], r['x']] = True
    return mask


def overlay(ref_rgb, ref_mask, model_mask):
    over = np.ones(ref_mask.shape + (3,), np.float32)
    both = ref_mask & model_mask
    over[both] = 0.6 * ref_rgb[both] + 0.4 * 0.5
    over[ref_mask & ~model_mask] = [0.9, 0.15, 0.1]
    over[model_mask & ~ref_mask] = [0.1, 0.35, 0.95]
    return over


def calibrate_sheet(ref_rgba, ref_mask, model_mask, warped_mask):
    """[reference | camera fit overlay | after silhouette warp]; red = reference only, blue = model only."""
    rgb = ref_rgba[..., :3] * ref_rgba[..., 3:4] + (1 - ref_rgba[..., 3:4])
    gap = np.ones((ref_mask.shape[0], 8, 3), np.float32)
    return np.concatenate([rgb, gap, overlay(rgb, ref_mask, model_mask), gap, overlay(rgb, ref_mask, warped_mask)], axis=1)


def scene_for_pose(a):
    """Open, pose and evaluate twice.

    md_frag: Mask modifiers off, so every face that owns texels has a position (texel geometry).
    md_vis: modifiers as rendered, so masked-away parts that poke through clothing neither occlude
    nor show up in silhouettes and previews.
    """
    src = open_blend(a.blend)
    pose = set_pose(a.pose, a.frame)
    meshes = character_meshes(getattr(a, 'mesh_names', None), getattr(a, 'objects', None), getattr(a, 'exclude', None))
    targets = color_targets(meshes)
    uv_need = {}
    for t in targets.values():
        for u in t['users']:
            uv_need.setdefault(u['object'], set()).add(u['uv'])
    for ob in meshes:
        uv_need.setdefault(ob.name, set()).add(render_uv_name(ob))
    sub = not getattr(a, 'no_subsurf', False)
    md_frag = evaluate_scene(meshes, uv_need, disable_types=('MASK',), keep_subsurf=sub)
    md_vis = evaluate_scene(meshes, uv_need, disable_types=(), keep_subsurf=sub)
    return src, pose, meshes, targets, md_frag, md_vis


def describe(p):
    return f"az{p['az']:.0f} el{p['el']:.0f} roll{p['roll']:.0f} " + ('ortho' if p['k'] <= 1e-6 else f"persp{p['k']:.2f}")


def cmd_calibrate(a):
    out = fresh_dir(a.out)
    src = open_blend(a.blend)
    pose = set_pose(a.pose, a.frame)
    meshes = character_meshes(None, a.objects, a.exclude)
    md = evaluate_scene(meshes, {}, disable_types=(), keep_subsurf=False)  # as rendered, unsubdivided: silhouettes only
    lo, hi, diag = scene_bounds(md)
    views = discover_views(a.img)
    if not views:
        raise SystemExit(f'No front/back/left/right/top/bottom images found in {a.img}')
    fitter = ViewFitter(md, a.facing)
    bvh = occluder_bvh(md)
    samples = surface_samples(md)
    entries, solved = [], {}
    for label in [l for l in ('front', 'back', 'left', 'right', 'side', 'top', 'bottom') if l in views]:
        t0 = time.time()
        path = views[label]
        ref = load_reference(path)
        mask_file = next((p for p in Path(path).parent.glob(Path(path).stem + '_mask.*')), None)
        if mask_file:
            mref = load_reference(mask_file)
            ref_mask, msrc = mref[..., :3].mean(axis=2) > 0.5, f'file:{mask_file.name}'
        else:
            ref_mask, msrc = L.foreground_mask(ref, tol=a.mask_tol, shadow=None if label == 'bottom' else (0.4, 1.15))
        h, w = ref_mask.shape
        ref_lin = L.srgb_to_linear(ref[..., :3])
        refined, coarse = fitter.search(label, ref_mask)
        best = refined[0]
        runner = next((r for r in refined[1:] if r[0] != best[0]), None)
        ambiguous = runner is not None and best[1] - runner[1] < a.ambiguity
        decided, photo = 'silhouette', None
        anchors = {l: solved[l]['view'] for l in ('front', 'back', 'left', 'right', 'side') if l in solved and not solved[l]['ambiguous']}
        # Mirror-like candidates (front-above vs back-above, left vs right) differ in silhouette mostly by
        # how the reference character's proportions differ from the mesh, so let colours decide when close.
        if runner is not None and best[1] - runner[1] < a.photo_margin and anchors:
            errs = [photo_consistency(samples, bvh, diag, anchors, (L.Camera(fitter.spec(c[3], c[4], w, h)), ref_lin, ref_mask))
                    for c in (best, runner)]
            photo = {'anchors': list(anchors),
                     'best': {'candidate': describe(best[3]), 'error': errs[0][0], 'shared_points': errs[0][1], 'per_anchor': errs[0][2]},
                     'runner_up': {'candidate': describe(runner[3]), 'error': errs[1][0], 'shared_points': errs[1][1], 'per_anchor': errs[1][2]}}
            if errs[0][0] is not None and errs[1][0] is not None and min(errs[0][0], errs[1][0]) < 0.9 * max(errs[0][0], errs[1][0]):
                if errs[1][0] < errs[0][0]:
                    best, runner = runner, best
                used = sorted(set(errs[0][2]) | set(errs[1][2]), key=list(anchors).index)
                decided, ambiguous = 'photo-consistency with ' + '+'.join(used), False
        _, _, _, p, fit = best
        final = fitter.evaluate(p, ref_mask, FINAL, init=fit)
        fit = final if final['iou'] >= fit['iou'] else fit
        spec = fitter.spec(p, fit, w, h)
        # silhouette warp: absorbs proportion differences between the reference character and the mesh
        s = min(1.0, WARP_RES / max(w, h))
        w2, h2 = max(8, int(round(w * s))), max(8, int(round(h * s)))
        mm = camera_mask(L.Camera(scaled_camera(spec, w2, h2)), md)
        rm = L.resample(ref_mask.astype(np.float32), h2, w2) > 0.5
        u = np.zeros((h2, w2, 2), np.float32) if a.no_warp else L.warp_masks(mm, rm)
        mag = np.linalg.norm(u, axis=-1)
        iou_warped = L.iou(mm, L.pull_back(rm, u))
        if not a.no_warp:
            np.save(out / f'warp_{label}.npy', u.astype(np.float32), allow_pickle=False)
            spec['warp'] = {'file': f'warp_{label}.npy', 'width': w2, 'height': h2, 'iou_after': iou_warped,
                            'max_shift_px': float(mag[mm].max() / s) if mm.any() else 0.0,
                            'mean_shift_px': float(mag[mm].mean() / s) if mm.any() else 0.0}
        sheet = calibrate_sheet(L.resample(ref, h2, w2), rm, mm, L.push_forward(mm, u, rm.shape))
        spec.update({'name': label, 'image': str(Path(path).resolve()), 'image_sha256': sha256(path), 'candidate': describe(p),
                     'iou': fit['iou'], 'iou_after_warp': iou_warped,
                     'runner_up': {'candidate': describe(runner[3]), 'iou': runner[2]} if runner else None,
                     'ambiguous': bool(ambiguous), 'decided_by': decided, 'photo_check': photo, 'coarse_family_iou': coarse,
                     'mask_source': msrc, 'weight': 1.0 if label not in ('top', 'bottom') else 0.6,
                     'sheet': save_png(out / f'calibrate_{label}.png', sheet, top_down=True)})
        save_png(out / f'mask_{label}.png', ref_mask.astype(np.float32), top_down=True)
        solved[label] = {'view': (L.Camera(spec), ref_lin, ref_mask), 'ambiguous': spec['ambiguous']}
        entries.append(spec)
        flag = ' AMBIGUOUS' if spec['ambiguous'] else ''
        flag += ' LOW_IOU' if fit['iou'] < a.min_iou else ''
        log(f"calibrate {label}: {describe(p)} IoU={fit['iou']:.3f} -> {iou_warped:.3f} after warp "
            f"(mean shift {spec.get('warp', {}).get('mean_shift_px', 0):.1f} px), {decided}{flag} [{time.time() - t0:.1f} s]")
    data = {'blender': bpy.app.version_string, 'blend': src, 'blend_sha256': sha256(src), 'pose': pose, 'facing': a.facing,
            'no_subsurf': bool(a.no_subsurf), 'scene_diag_m': diag, 'meshes': [ob.name for ob in meshes], 'views': entries,
            'review': 'CALIBRATED_NOT_REVIEWED: open every calibrate_<view>.png: [reference | camera fit | after warp]; '
                      'red = reference only, blue = model only.'}
    write_json(out / 'views.json', data)
    log(f'views -> {out / "views.json"}')


# ====================================================================== commands: project

def select_targets(targets, names, skip=()):
    """Targets named with --image, or every colour target with supported users; minus --skip
    (image names, 'new:<material>' keys or material names)."""
    skip = set(skip or ())
    if not names:
        names = [k for k, t in targets.items() if t['role'] == 'color' and t['users']]
    chosen = []
    for n in names:
        if n not in targets:
            raise SystemExit(f'{n!r} is not a base-colour target; known: {sorted(targets)}')
        t = targets[n]
        if n in skip or t.get('material') in skip or any(m in skip for m in t['primary_in']):
            continue
        if not t['users']:
            raise SystemExit(f'{n!r} has no supported users: {t["unsupported"]}')
        if t['role'] == 'mask':
            raise SystemExit(f'{n!r} only steers a colour (mix factor or ramp input), it is not one; pick a colour target')
        chosen.append(t)
    if not chosen:
        raise SystemExit('No targets left to process')
    return chosen


def cmd_project(a):
    out = fresh_dir(a.out)
    views_doc = json.loads(Path(a.views).read_text(encoding='utf-8'))
    a.pose, a.frame = views_doc['pose']['mode'], views_doc['pose']['frame']
    a.no_subsurf = views_doc.get('no_subsurf', False)
    a.mesh_names = views_doc.get('meshes')
    src, pose, meshes, targets, md, md_vis = scene_for_pose(a)
    if sha256(src) != views_doc['blend_sha256']:
        raise SystemExit('views.json was calibrated against a different .blend; recalibrate')
    lo, hi, diag = scene_bounds(md_vis)
    bvh = occluder_bvh(md_vis)
    eps = a.depth_eps * diag
    far = 2.0 * diag + 1.0
    views = [v for v in views_doc['views'] if not a.views_only or v['name'] in a.views_only]
    refs = {}
    for v in views:
        ref = load_reference(v['image'])
        if (ref.shape[1], ref.shape[0]) != (v['width'], v['height']):
            raise SystemExit(f"{v['image']} size changed since calibration")
        mask_png = Path(a.views).parent / f"mask_{v['name']}.png"
        m = load_reference(mask_png)[..., 0] > 0.5 if mask_png.exists() else L.foreground_mask(ref)[0]
        edge = max(1, int(round(a.edge * max(v['width'], v['height']))))
        inner = L.erode(m, edge)
        warp = (lambda x, y: (x, y)) if a.no_warp else warp_lookup(v, Path(a.views).parent)
        refs[v['name']] = (L.srgb_to_linear(ref[..., :3]), L.edge_feather(inner, 2 * edge), warp)
    report = {'blender': bpy.app.version_string, 'blend': src, 'views': a.views, 'pose': pose, 'params': vars(a).copy(),
              'image_path_repairs': PATH_FIXES, 'targets': [], 'skipped': []}
    for target in select_targets(targets, a.image, a.skip):
        t0 = time.time()
        w, h = work_size(target, a.work_res)
        frags = Fragments(target, md, w, h, target['source'] == 'TILED')
        n = frags.count
        sw = np.zeros(n)
        swv = np.zeros((n, 3))
        best_cos = np.zeros(n)
        per_view = []
        for v in views:
            cam = L.Camera(v)
            col, feather, warp = refs[v['name']]
            x, y, _ = cam.project(frags.pos)
            x, y = warp(x, y)
            inb = np.isfinite(x) & (x >= 0) & (x <= cam.width - 1) & (y >= 0) & (y <= cam.height - 1)
            tc = cam.towards_camera(frags.pos)
            cosv = (frags.nrm * tc).sum(axis=1)
            cand = inb & (cosv > a.min_cos)
            if v.get('objects'):
                allowed = [i for i, o in enumerate(frags.objects) if o in v['objects']]
                cand &= np.isin(frags.obj, allowed)
            idx = np.nonzero(cand)[0]
            fx = feather[np.clip(np.round(y[idx]).astype(int), 0, cam.height - 1), np.clip(np.round(x[idx]).astype(int), 0, cam.width - 1)]
            idx, fx = idx[fx > 0], fx[fx > 0]
            p = frags.pos[idx]
            if cam.kind == 'ORTHO':
                origins = p - cam.forward * far
                dirs = np.broadcast_to(cam.forward, p.shape)
                lengths = np.full(len(p), far)
            else:
                d = p - cam.position
                lengths = np.linalg.norm(d, axis=1)
                dirs = d / lengths[:, None]
                origins = np.broadcast_to(cam.position, p.shape)
            dist, _, _ = ray_cast_many(bvh, origins, dirs, lengths + eps)
            vis = dist >= lengths - eps
            idx, fx = idx[vis], fx[vis]
            wgt = float(v.get('weight', 1.0)) * np.power(np.clip(cosv[idx], 0, 1), a.power) * fx
            colr = L.bilinear(col, x[idx], y[idx])
            s1, s2, _ = L.accumulate(n, frags.texel[idx], wgt, colr)
            sw += s1
            swv += s2
            np.maximum.at(best_cos, frags.texel[idx], cosv[idx] * fx)
            per_view.append({'view': v['name'], 'candidates': int(cand.sum()), 'visible': int(len(idx)),
                             'occluded_or_masked': int(cand.sum() - len(idx))})
            log(f"project {target['image']} / {v['name']}: {len(idx)} visible texel samples")
        conf = np.clip((best_cos - a.min_cos) / max(1e-6, a.full_cos - a.min_cos), 0, 1)
        covered = frags.covered.sum()
        seen = float(((sw > 0) & frags.covered).sum() / max(1, covered))
        minimum = a.min_new_coverage if target.get('kind') == 'new' else 1e-9
        if seen < minimum:
            report['skipped'].append({'image': target['image'], 'seen_fraction': seen,
                                      'reason': 'no view sees it' if seen == 0 else f'views see only {seen:.0%} of it'})
            log(f"skip {target['image']}: views see {seen:.1%} of its texels")
            continue
        saved, stats = compose_and_save(target, frags, sw, swv, conf, out, not a.no_keep, target_stem(target), report,
                                        not a.no_tone_match)
        report['targets'].append({'image': target['image'], 'kind': target.get('kind', 'image'), 'material': target.get('material'),
                                  'bsdf_nodes': target.get('bsdf_nodes'), 'source': target['source'], 'seen_fraction': seen,
                                  'work_size': [w, h], 'objects': frags.objects,
                                  'fragments': int(len(frags.texel)), 'stray_triangles_outside_tiles': frags.stray_tris,
                                  'views': per_view, 'tiles': stats, 'outputs': saved, 'seconds': round(time.time() - t0, 1)})
    report['status'] = 'PROJECTED_NOT_REVIEWED'
    write_json(out / 'report.json', report)
    log(f'project -> {out}')


# ====================================================================== commands: recolour (default local route)

def _kv(spec):
    """'name=value,name=value' -> {name: float}"""
    return {k: float(v) for k, v in (kv.rsplit('=', 1) for kv in (spec or '').split(',') if kv)}


def _original_tile(image, tile, report):
    if image is None:
        return None
    try:
        if image.packed_file and image.source != 'TILED':
            o, is_float = load_pixels(image=image)
        else:
            o, is_float = load_pixels(image_tile_path(image, tile))
        return o[..., :3] if is_float else L.srgb_to_linear(o[..., :3])
    except Exception as exc:  # missing tile file: report and paint flat region colours there
        report.setdefault('warnings', []).append(f'{image.name} tile {tile}: original not loaded ({exc})')
        return None


def cmd_recolour(a):
    """Recolour each target's ORIGINAL texture, region by region, to the colours the images show.

    Per texel only the most face-on view gives a photo colour (views are never blended, so nothing is
    doubled). A palette from one view labels those colours; labels are smoothed into regions per object;
    each region of the original texture is scaled to its photo colour, which keeps the texture's own detail
    and keeps the images' lighting out. Small bright or other-hue marks (patches, lettering) are pasted as
    decals from near face-on views. Objects outside the multi-region set get one colour each.
    """
    out = fresh_dir(a.out)
    views_doc = json.loads(Path(a.views).read_text(encoding='utf-8'))
    a.pose, a.frame = views_doc['pose']['mode'], views_doc['pose']['frame']
    a.no_subsurf = views_doc.get('no_subsurf', False)
    a.mesh_names = views_doc.get('meshes')
    src, pose, meshes, targets, md, md_vis = scene_for_pose(a)
    if sha256(src) != views_doc['blend_sha256']:
        raise SystemExit('views.json was calibrated against a different .blend; recalibrate')
    lo, hi, diag = scene_bounds(md_vis)
    bvh = occluder_bvh(md_vis)
    eps, far = a.depth_eps * diag, 2.0 * diag + 1.0
    views = [v for v in views_doc['views'] if not a.views_only or v['name'] in a.views_only]
    names = [v['name'] for v in views]
    decal_views = set(a.decal_views.split(','))
    decal_cos = {nm: _kv(a.decal_cos_view).get(nm, a.decal_cos) for nm in names}
    refs = {}
    for v in views:
        ref = load_reference(v['image'])
        if (ref.shape[1], ref.shape[0]) != (v['width'], v['height']):
            raise SystemExit(f"{v['image']} size changed since calibration")
        mask_png = Path(a.views).parent / f"mask_{v['name']}.png"
        m = load_reference(mask_png)[..., 0] > 0.5 if mask_png.exists() else L.foreground_mask(ref)[0]
        edge = max(1, int(round(a.edge * max(v['width'], v['height']))))
        warp = (lambda x, y: (x, y)) if a.no_warp else warp_lookup(v, Path(a.views).parent)
        refs[v['name']] = (L.srgb_to_linear(ref[..., :3]), L.edge_feather(L.erode(m, edge), 2 * edge), warp, m)
    pal_views = [nm for nm in a.palette_view.split(',') if nm in names] or names[:1]
    cent, group, K = L.palette([refs[nm][0][L.erode(refs[nm][3], 4)] for nm in pal_views], a.k, a.merge_chroma, a.merge_lum)

    # the most face-on view per texel; decal colours only from near face-on decal views
    data, skipped = [], []
    for t in select_targets(targets, a.image, a.skip):
        t0 = time.time()
        w, h = work_size(t, a.work_res)
        fr = Fragments(t, md, w, h, t['source'] == 'TILED')
        n = fr.count
        best, bcos, dbest = np.zeros(n), np.zeros(n), np.zeros(n)
        pcol, dcol = np.zeros((n, 3), np.float32), np.zeros((n, 3), np.float32)
        for v in views:
            cam = L.Camera(v)
            col, feather, warp, _ = refs[v['name']]
            x, y, _ = cam.project(fr.pos)
            x, y = warp(x, y)
            inb = np.isfinite(x) & (x >= 0) & (x <= cam.width - 1) & (y >= 0) & (y <= cam.height - 1)
            cosv = (fr.nrm * cam.towards_camera(fr.pos)).sum(axis=1)
            cand = inb & (cosv > a.min_cos)
            if v.get('objects'):
                cand &= np.isin(fr.obj, [i for i, o in enumerate(fr.objects) if o in v['objects']])
            idx = np.nonzero(cand)[0]
            fx = feather[np.clip(np.round(y[idx]).astype(int), 0, cam.height - 1), np.clip(np.round(x[idx]).astype(int), 0, cam.width - 1)]
            idx, fx = idx[fx > 0], fx[fx > 0]
            q = fr.pos[idx]
            if cam.kind == 'ORTHO':
                origins, dirs, lengths = q - cam.forward * far, np.broadcast_to(cam.forward, q.shape), np.full(len(q), far)
            else:
                d = q - cam.position
                lengths = np.linalg.norm(d, axis=1)
                dirs, origins = d / lengths[:, None], np.broadcast_to(cam.position, q.shape)
            dist, _, _ = ray_cast_many(bvh, origins, dirs, lengths + eps)
            vis = dist >= lengths - eps
            idx, fx = idx[vis], fx[vis]
            wgt = np.power(np.clip(cosv[idx], 0, 1), a.power) * fx
            s1, s2, _ = L.accumulate(n, fr.texel[idx], wgt, L.bilinear(col, x[idx], y[idx]))
            better = s1 > best
            pcol[better] = s2[better] / s1[better, None]
            best[better] = s1[better]
            np.maximum.at(bcos, fr.texel[idx], cosv[idx] * fx)
            if v['name'] in decal_views:
                ok = cosv[idx] >= decal_cos[v['name']]
                s1, s2, _ = L.accumulate(n, fr.texel[idx[ok]], wgt[ok], L.bilinear(col, x[idx[ok]], y[idx[ok]]))
                better = s1 > dbest
                dcol[better] = s2[better] / s1[better, None]
                dbest[better] = s1[better]
        seen = float(((best > 0) & fr.covered).sum() / max(1, fr.covered.sum()))
        if seen < (a.min_new_coverage if t.get('kind') == 'new' else 1e-9):
            skipped.append({'image': t['image'], 'seen_fraction': seen,
                            'reason': 'no view sees it' if seen == 0 else f'views see only {seen:.0%} of it'})
            log(f"skip {t['image']}: views see {seen:.1%} of its texels")
            continue
        conf = np.clip((bcos - a.min_cos) / max(1e-6, a.full_cos - a.min_cos), 0, 1).astype(np.float32)
        tobj = np.full(n, -1, np.int32)
        tobj[fr.texel] = fr.obj
        raw = np.full(n, -1, np.int32)
        raw[best > 0] = group[L.nearest_centre(L.chroma_features(pcol[best > 0]), cent)]
        data.append(dict(t=t, fr=fr, w=w, h=h, pcol=pcol, conf=conf, tobj=tobj, raw=raw, dcol=dcol, dseen=dbest > 0, seen=seen))
        log(f"recolour: sampled {t['image']} ({seen:.0%} seen) [{time.time() - t0:.1f} s]")
    if not data:
        raise SystemExit('No target is seen by the views')

    # one photo colour per label, from every confidently seen texel; labels nobody shows stay white (unused)
    tcol = np.ones((K, 3), np.float32)
    for k in range(K):
        vals = np.concatenate([d['pcol'][(d['raw'] == k) & (d['conf'] >= 0.5)] for d in data])
        if len(vals) > 200:
            tcol[k] = L.log_mode(vals)
    log('recolour: palette (sRGB) ' + ', '.join(f'{k}:{srgb8(tcol[k])}' for k in range(K)))

    # label shares per object and over the whole character; labels rare overall are marks (decals only)
    share, total = {}, np.zeros(K)
    for d in data:
        d['votes_ok'] = (d['raw'] >= 0) & (d['conf'] >= 0.3)
        for j, name in enumerate(d['fr'].objects):
            c = np.bincount(d['raw'][d['votes_ok'] & (d['tobj'] == j)], minlength=K).astype(float)
            share[name] = share.get(name, 0) + c
            total += c
    decal_only = total < a.min_share * total.sum()
    dominant = {nm: int(np.where(decal_only, -1, c).argmax()) for nm, c in share.items()}
    for nm, c in share.items():
        top = [k for k in np.argsort(-c)[:4] if c[k] > 0]
        log(f"recolour: {nm} labels " + ' '.join(f"{k}{'(mark)' if decal_only[k] else ''}:{c[k] / max(c.sum(), 1):.0%}" for k in top))
    skin_object = a.skin_object
    if skin_object is None:
        skin_object = next((nm for nm in sorted(share, key=lambda s: -share[s].sum()) if re.search(r'head|face', nm, re.I)), None)
    elif skin_object.lower() == 'none':
        skin_object = None
    skin = dominant.get(skin_object, -1) if skin_object else -1
    if a.multi is None:
        multi = set()
        tchroma = L.chroma_features(tcol)[:, :2]
        for nm, c in share.items():
            regions = np.sort(np.where(decal_only, 0, c))[::-1] / max(c.sum(), 1)
            # a mark of the object's own hue (shine on black shoes) is a highlight in the photo, not a patch
            marks = decal_only & (np.linalg.norm(tchroma - tchroma[dominant[nm]], axis=1) >= a.merge_chroma)
            # drawn highlights on hair read as light marks and would be pasted as decals
            if nm != skin_object and not re.search(r'hair|brow|lash|beard', nm, re.I) and ((len(regions) > 1 and regions[1] >= a.auto_second) or c[marks].sum() / max(c.sum(), 1) >= a.auto_marks):
                multi.add(nm)
    else:
        multi = {nm for nm in a.multi.split(',') if nm}
    log(f"recolour: multi-region objects ({'auto' if a.multi is None else 'given'}): {sorted(multi)}; skin object: {skin_object}")

    # single-region objects: one colour per target, the most common photo colour on them
    own = []
    for d in data:
        js = [j for j, nm in enumerate(d['fr'].objects) if nm not in multi]
        d['own'] = None
        if js:
            on = np.isin(d['tobj'], js) & (d['conf'] >= 0.5)
            d['own'] = K + len(own)
            own.append(L.log_mode(d['pcol'][on]) if on.sum() > 200 else tcol[dominant[d['fr'].objects[js[0]]]])
            if skin_object in [d['fr'].objects[j] for j in js] and skin >= 0:
                tcol[skin] = own[-1]  # skin on multi-region objects (arms) matches the face
    log('recolour: one-colour targets (sRGB) ' + ', '.join(f"{d['t']['image']}:{srgb8(own[d['own'] - K])}" for d in data if d['own'] is not None))

    # regions on multi-region objects: smoothed votes of the labels that object really carries
    object_share = _kv(a.object_share)
    for d in data:
        fr, n = d['fr'], d['fr'].count
        allowed = np.zeros((len(fr.objects) + 1, K), bool)
        for j, name in enumerate(fr.objects):
            allowed[j] = ~decal_only & (share[name] >= object_share.get(name, a.min_object_share) * share[name].sum())
        ok = d['votes_ok'] & allowed[d['tobj'], np.maximum(d['raw'], 0)]
        votes = np.zeros((n, K), np.float32)
        votes[np.nonzero(ok)[0], d['raw'][ok]] = d['conf'][ok]
        clean = np.zeros(n, np.int32)
        for rank in range(len(fr.tiles)):
            V = L.box_blur(fr.tile_view(votes, rank), a.radius)
            known = V.sum(-1) > 0
            if known.any():
                V = np.where(known[..., None], V, L.gaussian_blur(L.push_pull_fill(V, known), 12))
            fr.tile_view(clean, rank)[...] = V.argmax(-1)
        d['multi'] = np.zeros(n, bool)
        for j, name in enumerate(fr.objects):
            on = d['tobj'] == j
            if name in multi:
                d['multi'] |= on
            else:
                clean[on] = d['own']
        d['clean'] = clean
    tcol = np.concatenate([tcol, np.array(own, np.float32).reshape(-1, 3)])
    K = len(tcol)
    ids = np.array([L.id_colour(k) for k in range(K)], np.float32)
    calib = json.loads(Path(a.calib).read_text(encoding='utf-8')) if a.calib else {}
    calib = calib.get('scales', calib)

    report = {'blender': bpy.app.version_string, 'blend': src, 'views': a.views, 'pose': pose, 'params': vars(a).copy(),
              'image_path_repairs': PATH_FIXES, 'multi_objects': sorted(multi), 'skin_object': skin_object,
              'decal_only_labels': np.nonzero(decal_only)[0].tolist(), 'targets': [], 'skipped': skipped}
    for d in data:
        t0 = time.time()
        t, fr, w, h = d['t'], d['fr'], d['w'], d['h']
        image = bpy.data.images.get(t['image']) if t.get('kind') != 'new' else None
        stem = target_stem(t)
        mats = [m for m in (t.get('primary_in') or [t.get('material')]) if m]
        tc = tcol.copy()  # colour to paint per label: the photo colour times the render calibration
        for k in range(K):
            for m in mats:
                if f'{m}|{k}' in calib:
                    tc[k] = tc[k] * np.array(calib[f'{m}|{k}'], np.float32)
                    break
        saved, label_files = [], []
        for rank, tile in enumerate(fr.tiles):
            cov = fr.tile_view(fr.covered, rank)
            clean = fr.tile_view(d['clean'], rank)
            dseen = fr.tile_view(d['dseen'], rank)
            pc = L.push_pull_fill(fr.tile_view(d['dcol'], rank), dseen) if dseen.any() else np.zeros((h, w, 3), np.float32)
            mlt = fr.tile_view(d['multi'], rank)
            # decals: brighter or other hue than the region, of a mark label, on multi-region objects, never on skin
            dl = np.log(pc + 0.01) - np.log(tcol[clean] + 0.01)
            mark = (dl.max(-1) > a.decal_thr) | ((dl.max(-1) - dl.min(-1)) > a.decal_thr)
            dlab = group[L.nearest_centre(L.chroma_features(pc.reshape(-1, 3)), cent)].reshape(h, w)
            dm = cov & mlt & dseen & (clean != skin) & mark & decal_only[dlab]
            pc = pc * (tc[clean] / np.maximum(tcol[clean], 1e-6))
            dm = L.dilate(L.erode(dm, a.decal_clean), a.decal_clean)
            alpha = (L.box_blur(dm.astype(np.float32), 1) * L.dilate(dm, 1))[..., None]
            orig = _original_tile(image, tile, report)
            if orig is not None:
                ow_ = resize(orig, h, w)
                gain = np.ones((K, 3), np.float32)
                for k in np.unique(clean[cov]):
                    gain[k] = tc[k] / np.maximum(L.log_mode(ow_[cov & (clean == k)]), 1e-4)
                G = np.exp(L.box_blur(np.log(gain[clean]), 1))
                oh, ow = orig.shape[:2]
                final = orig * resize(G, oh, ow)
                A = resize(alpha, oh, ow)
                final = final * (1 - A) + resize(pc, oh, ow) * A
            else:
                final = tc[clean] * (1 - alpha) + pc * alpha
            suffix = f'.{tile}.png' if t['source'] == 'TILED' else '.png'
            saved.append(save_png(out / (stem + suffix), L.linear_to_srgb(final)))
            save_png(out / (stem + '_labels' + suffix), L.linear_to_srgb(tc[clean] * cov[..., None]))
            label_files.append(save_png(out / (stem + '_labelid' + suffix), ids[clean]))
        counts = np.bincount(d['clean'][fr.covered], minlength=K)
        shown = tcol[d['own']] if d['own'] is not None else tcol[counts.argmax()]
        report['targets'].append({'image': t['image'], 'kind': t.get('kind', 'image'), 'material': t.get('material'),
                                  'bsdf_nodes': t.get('bsdf_nodes'), 'source': t['source'], 'seen_fraction': d['seen'],
                                  'work_size': [w, h], 'objects': fr.objects, 'materials': mats,
                                  'multi_objects': [nm for nm in fr.objects if nm in multi],
                                  'single_objects': [nm for nm in fr.objects if nm not in multi], 'own_label': d['own'],
                                  'labels': {int(k): tcol[k].tolist() for k in np.unique(d['clean'][fr.covered])},
                                  'display_colour': shown.tolist(), 'outputs': saved, 'label_ids': label_files,
                                  'seconds': round(time.time() - t0, 1)})
        log(f"recolour: wrote {t['image']} ({len(saved)} file(s))")
    report['status'] = 'RECOLOURED_NOT_REVIEWED'
    write_json(out / 'report.json', report)
    log(f'recolour -> {out}')


def srgb8(c):
    return np.round(L.linear_to_srgb(np.clip(np.asarray(c, np.float32), 0, 1)) * 255).astype(int).tolist()


# ====================================================================== commands: tone, render (EEVEE)

FACING_XY = {'-Y': (0.0, -1.0), '+Y': (0.0, 1.0), '+X': (1.0, 0.0), '-X': (-1.0, 0.0)}


def review_camera(name, target, distance, yaw_deg, facing, lens, lift=0.0):
    """A camera `distance` from `target`, `yaw_deg` around the character from its front (+ = towards its left)."""
    fx, fy = FACING_XY[facing]
    c, s = math.cos(math.radians(yaw_deg)), math.sin(math.radians(yaw_deg))
    loc = Vector((target[0] + (fx * c - fy * s) * distance, target[1] + (fx * s + fy * c) * distance, target[2] + lift))
    cam = bpy.data.objects.new(name, bpy.data.cameras.new(name))
    bpy.context.scene.collection.objects.link(cam)
    cam.location = loc
    cam.rotation_euler = (Vector(target) - loc).to_track_quat('-Z', 'Y').to_euler()
    cam.data.lens = lens
    return cam


def character_frame_info(a):
    """Bounds, full-body framing distance (50 mm portrait) and head centre of the character as posed."""
    md = evaluate_scene(character_meshes(None, a.objects, a.exclude), {}, disable_types=(), keep_subsurf=False)
    lo, hi, _ = scene_bounds(md)
    height, width = float(hi[2] - lo[2]), float(max(hi[0] - lo[0], hi[1] - lo[1]))
    pts = np.concatenate([m.tri_co.reshape(-1, 3) for m in md.values()])
    head = pts[pts[:, 2] > hi[2] - 0.13 * height].mean(0)
    full = max(1.15 * height / 0.72, 1.1 * width / 0.54)
    return (lo + hi) / 2, height, full, head


def render_still(path, w, h):
    sc = bpy.context.scene
    sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = w, h, 100
    sc.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    im = bpy.data.images.load(str(path), check_existing=False)
    px = np.empty(w * h * 4, np.float32)
    im.pixels.foreach_get(px)
    bpy.data.images.remove(im)
    return px.reshape(h, w, 4)


def cmd_tone(a):
    """EEVEE-render the applied .blend from its camera and measure each (material, region) against its photo
    colour; write colour scales for `recolour --calib`. Read-only: the .blend is never saved."""
    out = fresh_dir(a.out)
    open_blend(a.blend)
    warn_missing_textures('tone')
    set_pose(a.pose, a.frame)
    run = Path(a.run)
    rep = json.loads((run / 'report.json').read_text(encoding='utf-8'))
    prev_doc = json.loads(Path(a.prev).read_text(encoding='utf-8')) if a.prev else {}
    prev = prev_doc.get('scales', prev_doc)
    prev_rows = {r['key']: r for r in prev_doc.get('measurements', []) if 'render' in r}
    damping = a.damping if a.damping is not None else (0.5 if prev else 1.0)
    sc = bpy.context.scene
    if not any(o.type == 'LIGHT' and not o.hide_render for o in sc.objects):
        log('tone: WARNING the scene has no lights; scales will fit its world lighting only')
    if sc.camera is None:
        centre, height, full, _ = character_frame_info(a)
        sc.camera = review_camera('TM3D_front', centre, full, 0, a.facing, 50, 0.1 * height)
        w, h = 900, 1200
    else:
        f = 1200 / max(sc.render.resolution_x, sc.render.resolution_y)
        w, h = int(round(sc.render.resolution_x * f)), int(round(sc.render.resolution_y * f))
    sc.render.engine = 'BLENDER_EEVEE'
    sc.eevee.taa_render_samples = a.samples
    beauty = L.srgb_to_linear(render_still(out / 'beauty.png', w, h)[..., :3])
    # flat ID passes: material per pixel, then region label per pixel from the run's label-id textures
    sc.render.engine = 'BLENDER_WORKBENCH'
    sh = sc.display.shading
    sh.light, sh.show_shadows, sh.show_cavity = 'FLAT', False, False
    sc.display.render_aa = 'OFF'
    sc.view_settings.view_transform, sc.view_settings.look = 'Standard', 'None'
    sc.render.dither_intensity, sc.render.film_transparent = 0.0, True
    mats = sorted({s.material.name for o in sc.objects if o.type == 'MESH' and not o.hide_render for s in o.material_slots if s.material})
    for i, m in enumerate(mats):
        bpy.data.materials[m].diffuse_color = (*L.id_colour(i), 1.0)
    sh.color_type = 'MATERIAL'
    px = render_still(out / 'material_id.png', w, h)
    pal = np.array([L.id_colour(i) for i in range(len(mats))], np.float32)
    mat_id = np.where(px[..., 3] > 0.5, L.nearest_centre(L.srgb_to_linear(px[..., :3]).reshape(-1, 3), pal).reshape(h, w), -1)
    for r in rep['targets']:
        img = bpy.data.images.load(str(run / r['label_ids'][0]), check_existing=False)
        if r['source'] == 'TILED':
            img.source = 'TILED'
        img.colorspace_settings.name = 'Non-Color'
        for m in r['materials']:
            mat = bpy.data.materials.get(m)
            if mat is None or not mat.node_tree:
                continue
            node = mat.node_tree.nodes.new('ShaderNodeTexImage')
            node.image, node.interpolation = img, 'Closest'
            mat.node_tree.nodes.active = node
    sh.color_type = 'TEXTURE'
    label_px = L.srgb_to_linear(render_still(out / 'label_id.png', w, h)[..., :3])
    scales, rows = dict(prev), []
    for r in rep['targets']:
        labels = {int(k): np.array(v, np.float32) for k, v in r['labels'].items()}
        ks = sorted(labels)
        lpal = np.array([L.id_colour(k) for k in ks], np.float32)
        for m in r['materials']:
            sel = mat_id == (mats.index(m) if m in mats else -2)
            if not sel.any():
                continue
            lab = np.array(ks)[L.nearest_centre(label_px[sel], lpal)]
            region_px = beauty[sel]
            for k in ks:
                p = region_px[lab == k]
                if len(p) < a.min_pixels:
                    continue
                seen = L.log_mode(p, 0.1)
                key = f'{m}|{k}'
                applied = prev.get(key, [1.0, 1.0, 1.0])  # the scale this file was recoloured with
                pr = prev_rows.get(key) or {}
                s, at_floor = L.tone_step(labels[k], seen, applied, pr.get('render'), pr.get('applied'), pr.get('at_floor', False), damping)
                scales[key] = s.tolist()
                rows.append({'key': key, 'photo_srgb': srgb8(labels[k]), 'render_srgb': srgb8(seen), 'pixels': int(len(p)),
                             'log_error': float(np.abs(np.log(seen + 1e-3) - np.log(labels[k] + 1e-3)).max()),
                             'render': seen.tolist(), 'applied': list(applied), 'at_floor': at_floor,
                             'scale': np.round(scales[key], 4).tolist()})
                log(f"tone {key}: photo {rows[-1]['photo_srgb']} render {rows[-1]['render_srgb']} ({len(p)} px) -> scale "
                    f"{rows[-1]['scale']}{' (at floor: brightness held)' if at_floor else ''}")
    if not rows:
        raise SystemExit('tone: no region of the run is visible from the camera')
    floors = [r['key'] for r in rows if r['at_floor']]
    reachable = [r['log_error'] for r in rows if not r['at_floor']]
    write_json(out / 'tone.json', {'blend': a.blend, 'run': str(run), 'damping': damping, 'camera': sc.camera.name,
                                   'resolution': [w, h], 'measurements': rows, 'scales': scales,
                                   'worst_log_error': max(r['log_error'] for r in rows),
                                   'worst_log_error_reachable': max(reachable, default=0.0), 'at_floor': floors})
    if floors:
        log(f"tone: {floors} can't reach the photos' brightness through base colour (shine under these lights, or the "
            "view transform compressing light colours); their brightness is held. If one looks grey and shiny, lower "
            'its Specular IOR Level (apply --set-input); otherwise accept')
    log(f"tone -> {out / 'tone.json'} (worst log error {max(r['log_error'] for r in rows):.2f}; "
        f"{max(reachable, default=0.0):.2f} without the {len(floors)} region(s) at the floor)")


def cmd_render(a):
    """EEVEE review renders of a .blend: front (its own camera when it has one), 3/4, back, face, head side
    and head back. Read-only: the .blend is never saved."""
    out = fresh_dir(a.out)
    open_blend(a.blend)
    warn_missing_textures('render')
    set_pose(a.pose, a.frame)
    facing = json.loads(Path(a.views).read_text(encoding='utf-8'))['facing'] if a.views else a.facing
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    sc.eevee.taa_render_samples = a.samples
    centre, height, full, head = character_frame_info(a)
    lift = 0.1 * height
    shots = [('front', sc.camera if sc.camera and not a.no_scene_camera else review_camera('TM3D_front', centre, full, 0, facing, 50, lift), 900, 1200),
             ('threequarter', review_camera('TM3D_34', centre, full, 37, facing, 50, lift), 900, 1200),
             ('back', review_camera('TM3D_back', centre, full, 180, facing, 50, lift), 900, 1200),
             ('face', review_camera('TM3D_face', head, 0.71 * height, 0, facing, 85), 800, 800),
             ('head_side', review_camera('TM3D_side', head - np.array([0, 0, 0.03 * height]), 0.71 * height, 90, facing, 85), 800, 800),
             ('head_back', review_camera('TM3D_hb', head - np.array([0, 0, 0.08 * height]), 0.75 * height, 155, facing, 85), 800, 800)]
    files = []
    for name, cam, w, h in shots:
        sc.camera = cam
        render_still(out / f'{name}.png', w, h)
        files.append(str(out / f'{name}.png'))
        log(f'render: {name}.png')
    write_json(out / 'render.json', {'blend': a.blend, 'renders': files,
                                     'review': 'NOT_REVIEWED: open every render; judge them as the user will see them'})
    log(f'render -> {out}')


# ====================================================================== commands: handoff

def tile_pack(uv, tiles):
    g = int(math.ceil(math.sqrt(len(tiles))))
    cell, margin = 1.0 / g, 0.004
    origin = np.floor(uv.mean(axis=1))
    tile_of = 1001 + origin[:, 0].astype(int) + 10 * origin[:, 1].astype(int)
    out = np.zeros_like(uv)
    layout = {}
    for k, tile in enumerate(tiles):
        sel = tile_of == tile
        ci, cj = k % g, k // g
        layout[int(tile)] = [ci, cj, g]
        out[sel] = ((uv[sel] - origin[sel][:, None, :]) * (cell - 2 * margin) + np.array([ci * cell + margin, cj * cell + margin]))
    return out, layout


def overlap_ratio(uv, res=1024):
    r = L.rasterize(uv * res - 0.5, res, res)
    if len(r['x']) == 0:
        return 0.0
    pix = r['y'].astype(np.int64) * res + r['x']
    order = np.lexsort((r['tri'], pix))
    p, t = pix[order], r['tri'][order]
    dup = (p[1:] == p[:-1]) & (t[1:] != t[:-1])
    return float(dup.sum() / max(1, len(np.unique(pix))))


def build_mesh(name, polys_co, faces, uvs, smooth):
    me = bpy.data.meshes.new(name)
    me.vertices.add(len(polys_co))
    me.vertices.foreach_set('co', polys_co.astype(np.float32).ravel())
    flat = np.concatenate(faces).astype(np.int32)
    me.loops.add(len(flat))
    me.loops.foreach_set('vertex_index', flat)
    starts = np.cumsum([0] + [len(f) for f in faces[:-1]]).astype(np.int32)
    me.polygons.add(len(faces))
    me.polygons.foreach_set('loop_start', starts)
    layer = me.uv_layers.new(name='UVMap')
    layer.data.foreach_set('uv', uvs.astype(np.float32).ravel())
    me.polygons.foreach_set('use_smooth', np.asarray(smooth, bool))
    me.update()
    me.validate(verbose=False)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def user_fingerprints(target):
    """Geometry and UV identity of the faces a target covers; transfer requires these to match."""
    out = {}
    for user in target['users']:
        fp = fingerprint(bpy.data.objects[user['object']])
        out[user['object']] = {'geometry_sha': fp['geometry_sha'], 'uv_sha': fp['uv_sha'].get(user['uv']),
                               'shape_keys': fp['shape_keys'], 'modifiers': fp['modifiers']}
    return out


def cmd_handoff(a):
    out = fresh_dir(a.out)
    src, pose, meshes, targets, md, md_vis = scene_for_pose(a)
    chosen = select_targets(targets, a.image, a.skip)
    proxies, manifest = [], {'blender': bpy.app.version_string, 'blend': src, 'blend_sha256': sha256(src), 'pose': pose,
                             'no_subsurf': bool(a.no_subsurf), 'proxies': []}
    for target in chosen:
        cos, nrms, uvs_orig, objs = [], [], [], []
        for user in target['users']:
            m = md[user['object']]
            sel = np.isin(m.tri_mat, user['slots'])
            cos.append(m.tri_co[sel])
            uvs_orig.append(m.uv[user['uv']][m.tri_loops[sel]])
        co = np.concatenate(cos)
        uv = np.concatenate(uvs_orig)
        tiled = target['source'] == 'TILED' or len(np.unique(L.udim_of(uv.mean(1)[:, 0], uv.mean(1)[:, 1]))) > 1
        mode, layout = a.uv, None
        if mode == 'auto':
            mode = 'pack' if tiled else 'keep'
        if mode == 'keep':
            puv = uv - np.floor(uv.mean(axis=1))[:, None, :]
        else:
            tiles = sorted(set(L.udim_of(uv.mean(1)[:, 0], uv.mean(1)[:, 1]).tolist()))
            puv, layout = tile_pack(uv, tiles)
        ov = overlap_ratio(puv)
        name = 'TM3D_' + target_stem(target)
        faces = [np.arange(3 * i, 3 * i + 3) for i in range(len(co))]
        ob = build_mesh(name, co.reshape(-1, 3), faces, puv.reshape(-1, 2), np.ones(len(co), bool))
        smart = a.uv == 'smart' or (a.uv == 'auto' and ov > a.max_overlap)
        if bpy.context.object and bpy.context.object.mode != 'OBJECT':
            bpy.ops.object.mode_set(mode='OBJECT')  # files saved in pose mode
        for o in bpy.context.view_layer.objects:
            o.select_set(False)
        ob.select_set(True)
        bpy.context.view_layer.objects.active = ob
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.mesh.remove_doubles(threshold=1e-6)  # weld the triangle soup; UVs stay per corner
        if smart:
            bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.004)
            mode, layout = 'smart', None
        bpy.ops.object.mode_set(mode='OBJECT')
        if smart:
            ov = overlap_ratio(proxy_uv_tris(ob))
        tris = sum(len(p.vertices) - 2 for p in ob.data.polygons)
        mat = bpy.data.materials.new(name + '_MAT')
        ob.data.materials.append(mat)
        if a.embed and target.get('kind', 'image') == 'image':
            emb = embed_texture(ob, target, md, a.embed_res, out / f'{name}_current.png')
            tex = mat.node_tree.nodes.new('ShaderNodeTexImage')
            tex.image = bpy.data.images.load(emb, check_existing=False)
            mat.node_tree.links.new(tex.outputs['Color'], mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'])
        proxies.append(ob)
        entry = {'proxy': name, 'target_image': target['image'], 'users': target['users'], 'triangles': tris,
                 'user_fingerprints': user_fingerprints(target),
                 'uv_mode': mode, 'tile_layout': layout, 'uv_overlap_ratio': ov,
                 'over_service_limit': tris > a.max_tris}
        if tris > a.max_tris:
            log(f'WARNING {name}: {tris} triangles exceeds {a.max_tris}; the service may simplify it (transfer still works)')
        manifest['proxies'].append(entry)
    if a.context:
        names = {u['object'] for t in chosen for u in t['users']}
        ctx = [m for k, m in md_vis.items() if k not in names]
        if ctx:
            co = np.concatenate([m.tri_co for m in ctx])
            faces = [np.arange(3 * i, 3 * i + 3) for i in range(len(co))]
            proxies.append(build_mesh('TM3D_CONTEXT', co.reshape(-1, 3), faces, np.zeros((len(co) * 3, 2)), np.ones(len(co), bool)))
            manifest['context_object'] = 'TM3D_CONTEXT'
    bpy.ops.object.select_all(action='DESELECT')
    for ob in proxies:
        ob.select_set(True)
    glb = out / 'handoff.glb'
    bpy.ops.export_scene.gltf(filepath=str(glb), export_format='GLB', use_selection=True, export_yup=True, export_apply=False,
                              export_animations=False, export_skins=False, export_morph=False, export_materials='EXPORT')
    manifest['glb'] = str(glb)
    manifest['glb_sha256'] = sha256(glb)
    manifest['status'] = 'INTERMEDIATE_NOT_A_RELEASE'
    write_json(out / 'handoff.json', manifest)
    log(f'handoff -> {glb} ({len(proxies)} objects)')


def proxy_uv_tris(ob):
    me = ob.data
    me.calc_loop_triangles()
    loops = np.empty(len(me.loop_triangles) * 3, np.int32)
    me.loop_triangles.foreach_get('loops', loops)
    puv = np.empty(len(me.loops) * 2, np.float32)
    me.uv_layers['UVMap'].data.foreach_get('uv', puv)
    return puv.reshape(-1, 2)[loops.reshape(-1, 3)].astype(np.float64)


def embed_texture(ob, target, md, res, path):
    """Resample the current target texture onto the proxy UVs by nearest surface point."""
    me = ob.data
    puv = proxy_uv_tris(ob)
    co = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get('co', co)
    vi = np.empty(len(me.loop_triangles) * 3, np.int32)
    me.loop_triangles.foreach_get('vertices', vi)
    pco = co.reshape(-1, 3)[vi.reshape(-1, 3)].astype(np.float64)
    r = L.rasterize(puv * res - 0.5, res, res)
    pos = np.einsum('nk,nkj->nj', r['bary'].astype(np.float64), pco[r['tri']])
    src = SurfaceSource.from_target(target, md, max_size=max(res, 1024))
    colr, ok = src.sample_nearest(pos)
    img = np.zeros((res * res, 3), np.float32)
    known = np.zeros(res * res, bool)
    pix = r['y'].astype(np.int64) * res + r['x']
    img[pix[ok]] = colr[ok]
    known[pix[ok]] = True
    img = L.push_pull_fill(img.reshape(res, res, 3), known.reshape(res, res))
    return save_png(path, L.linear_to_srgb(img))


# ====================================================================== surface sampling (transfer)

class SurfaceSource:
    """Triangles with UVs and per-triangle texture tiles, queried through a BVH."""

    def __init__(self, co, uv, tex_index, textures):
        self.co, self.uv, self.tex_index, self.textures = co, uv, tex_index, textures  # textures: list of {tile: (H,W,3) linear}
        flat = co.reshape(-1, 3)
        tris = np.arange(len(flat)).reshape(-1, 3)
        self.bvh = BVHTree.FromPolygons(flat.tolist(), tris.tolist(), all_triangles=True, epsilon=0.0)

    @classmethod
    def from_target(cls, target, md, max_size=None):
        image = bpy.data.images[target['image']]
        tiles = {}
        for tile in target['tiles']:
            if image.packed_file and image.source != 'TILED':
                tmp = image.copy()
                arr, is_float = load_pixels(image=tmp, max_size=max_size)
                bpy.data.images.remove(tmp)
            else:
                arr, is_float = load_pixels(path=image_tile_path(image, tile), max_size=max_size)
            tiles[tile] = arr[..., :3] if is_float else L.srgb_to_linear(arr[..., :3])
        cos, uvs = [], []
        for user in target['users']:
            m = md[user['object']]
            sel = np.isin(m.tri_mat, user['slots'])
            cos.append(m.tri_co[sel])
            uvs.append(m.uv[user['uv']][m.tri_loops[sel]])
        co, uv = np.concatenate(cos), np.concatenate(uvs)
        return cls(co, uv, np.zeros(len(co), np.int64), [tiles])

    def color_at(self, tri, loc):
        a, b, c = self.co[tri, 0], self.co[tri, 1], self.co[tri, 2]
        v0, v1, v2 = b - a, c - a, loc - a
        d00, d01, d11 = (v0 * v0).sum(1), (v0 * v1).sum(1), (v1 * v1).sum(1)
        d20, d21 = (v2 * v0).sum(1), (v2 * v1).sum(1)
        den = np.where(np.abs(d00 * d11 - d01 * d01) > 1e-30, d00 * d11 - d01 * d01, 1e-30)
        w1 = (d11 * d20 - d01 * d21) / den
        w2 = (d00 * d21 - d01 * d20) / den
        bary = np.clip(np.stack([1 - w1 - w2, w1, w2], axis=1), 0, 1)
        bary /= bary.sum(1, keepdims=True)
        uv = np.einsum('nk,nkj->nj', bary, self.uv[tri])
        out = np.zeros((len(tri), 3), np.float32)
        origin = np.floor(self.uv[tri].mean(axis=1))
        tile = 1001 + origin[:, 0].astype(int) + 10 * origin[:, 1].astype(int)
        for ti, texset in enumerate(self.textures):
            for tnum, arr in texset.items():
                sel = (self.tex_index[tri] == ti) & ((tile == tnum) | (len(texset) == 1))
                if not sel.any():
                    continue
                h, w = arr.shape[:2]
                local = uv[sel] - origin[sel]
                out[sel] = L.bilinear(arr, local[:, 0] * w - 0.5, local[:, 1] * h - 0.5, wrap=True)
        return out

    def sample_rays(self, pos, nrm, cage):
        origins = pos + nrm * cage
        dist, tri, loc = ray_cast_many(self.bvh, origins, -nrm, np.full(len(pos), 2 * cage))
        hit = tri >= 0
        miss = np.nonzero(~hit)[0]
        how = np.where(hit, 1, 0)
        if len(miss):
            d2, t2, l2 = find_nearest_many(self.bvh, pos[miss], 2 * cage)
            ok = t2 >= 0
            tri[miss[ok]], loc[miss[ok]] = t2[ok], l2[ok]
            how[miss[ok]] = 2
        found = tri >= 0
        col = np.zeros((len(pos), 3), np.float32)
        col[found] = self.color_at(tri[found], loc[found])
        return col, how

    def sample_nearest(self, pos):
        dist, tri, loc = find_nearest_many(self.bvh, pos, 1e9)
        ok = tri >= 0
        col = np.zeros((len(pos), 3), np.float32)
        col[ok] = self.color_at(tri[ok], loc[ok])
        return col, ok


def gltf_sources(objs):
    """Imported service meshes -> SurfaceSource per object, with gutter-filled base colour textures."""
    sources = {}
    for ob in objs:
        if ob.type != 'MESH' or len(ob.data.polygons) == 0:
            continue
        m = MeshData(ob, [render_uv_name(ob)], (), True)
        uvname = render_uv_name(ob)
        if uvname is None:
            log(f'skip {ob.name}: no UVs')
            continue
        texsets, tex_index = [], np.full(len(m.tri_mat), -1, np.int64)
        for slot_index, slot in enumerate(ob.material_slots):
            nodes = base_color_nodes(slot.material)
            if not nodes:
                continue
            arr, is_float = load_pixels(image=nodes[0][0].image)
            lin = arr[..., :3] if is_float else L.srgb_to_linear(arr[..., :3])
            sel = m.tri_mat == slot_index
            uv = m.uv[uvname][m.tri_loops[sel]]
            h, w = lin.shape[:2]
            local = uv - np.floor(uv.mean(axis=1))[:, None, :]
            r = L.rasterize(np.stack([local[..., 0] * w - 0.5, local[..., 1] * h - 0.5], -1), w, h)
            cov = np.zeros((h, w), bool)
            cov[r['y'], r['x']] = True
            lin = L.push_pull_fill(lin, cov)  # gutter pixels outside the service's own islands are background: refill them
            tex_index[sel] = len(texsets)
            texsets.append({1001: lin})
        keep = tex_index >= 0
        if not keep.any():
            log(f'skip {ob.name}: no base colour image')
            continue
        sources[ob.name] = SurfaceSource(m.tri_co[keep], m.uv[uvname][m.tri_loops[keep]], tex_index[keep], texsets)
    return sources


def align_source(source, ref_pts, diag, tol, iters=25):
    """Check service mesh alignment against the target; fit a similarity transform when it drifted."""
    rng = np.random.default_rng(0)
    pts = ref_pts[rng.choice(len(ref_pts), size=min(4000, len(ref_pts)), replace=False)]

    def residual():
        d, _, loc = find_nearest_many(source.bvh, pts, 1e9)
        return d, loc

    d, _ = residual()
    before = float(np.percentile(d, 90))
    info = {'p90_before_m': before, 'aligned': False}
    if before <= tol * diag:
        info['p90_after_m'] = before
        return info
    # fit source -> target: iterate closest points from the source surface to target samples
    flat = source.co.reshape(-1, 3)
    for _ in range(iters):
        _, loc = residual()
        s, r, t = L.similarity_transform(loc, pts)
        flat = (s * (r @ flat.T)).T + t
        source.co = flat.reshape(-1, 3, 3)
        source.bvh = BVHTree.FromPolygons(flat.tolist(), np.arange(len(flat)).reshape(-1, 3).tolist(), all_triangles=True, epsilon=0.0)
    d, _ = residual()
    info.update({'aligned': True, 'p90_after_m': float(np.percentile(d, 90))})
    return info


def cmd_transfer(a):
    out = fresh_dir(a.out)
    man = json.loads(Path(a.manifest).read_text(encoding='utf-8'))
    a.pose, a.frame, a.no_subsurf = man['pose']['mode'], man['pose']['frame'], man.get('no_subsurf', False)
    src, pose, meshes, targets, md, md_vis = scene_for_pose(a)
    for p in man['proxies']:
        if p['target_image'] in targets and user_fingerprints(targets[p['target_image']]) != p['user_fingerprints']:
            raise SystemExit(f"{p['target_image']}: geometry, UVs, shape keys or modifiers differ from the handoff; redo the handoff from this file")
    lo, hi, diag = scene_bounds(md_vis)
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(Path(a.source).resolve()), merge_vertices=True)
    imported = [o for o in bpy.data.objects if o not in before]
    sources = gltf_sources(imported)
    if not sources:
        raise SystemExit('The service file has no textured meshes')
    report = {'blender': bpy.app.version_string, 'blend': src, 'source': str(Path(a.source).resolve()), 'source_sha256': sha256(a.source),
              'pose': pose, 'imported_objects': [o.name for o in imported], 'targets': []}
    names = a.image or [p['target_image'] for p in man['proxies']]
    for target in select_targets(targets, names):
        proxy = next((p['proxy'] for p in man['proxies'] if p['target_image'] == target['image']), None)
        w, h = work_size(target, a.work_res)
        frags = Fragments(target, md, w, h, target['source'] == 'TILED')
        match = [k for k in sources if proxy and (k == proxy or k.startswith(proxy + '.') or k.startswith(proxy))]
        if not match:
            scores = {k: float(np.median(find_nearest_many(s.bvh, frags.pos[::max(1, len(frags.pos) // 2000)], 1e9)[0])) for k, s in sources.items()}
            match = [min(scores, key=scores.get)]
            log(f'no object named {proxy}; using nearest surface {match[0]} (median distance {scores[match[0]]:.4f} m)')
        source = sources[match[0]]
        align = align_source(source, frags.pos, diag, a.align_tol)
        if align['p90_after_m'] > a.align_tol * diag * 2:
            raise SystemExit(f"{target['image']}: service mesh does not line up with the target (p90 {align['p90_after_m']:.4f} m); check pose and scale")
        cage = a.cage * diag
        col, how = source.sample_rays(frags.pos, frags.nrm, cage)
        n = frags.count
        found = how > 0
        wgt = np.where(how == 1, 1.0, 0.5)[found]
        sw, swv, mw = L.accumulate(n, frags.texel[found], wgt, col[found])
        conf = np.clip(mw, 0, 1)
        saved, stats = compose_and_save(target, frags, sw, swv, conf, out, not a.no_keep, target_stem(target), report,
                                        not a.no_tone_match)
        report['targets'].append({'image': target['image'], 'kind': target.get('kind', 'image'),
                                  'material': target.get('material'), 'bsdf_nodes': target.get('bsdf_nodes'),
                                  'source': target['source'], 'source_object': match[0], 'alignment': align, 'work_size': [w, h],
                                  'ray_hits': int((how == 1).sum()), 'nearest_fallback': int((how == 2).sum()), 'misses': int((how == 0).sum()),
                                  'tiles': stats, 'outputs': saved})
        log(f"transfer {target['image']}: hits={int((how == 1).sum())} fallback={int((how == 2).sum())} miss={int((how == 0).sum())}")
    report['status'] = 'TRANSFERRED_NOT_REVIEWED'
    write_json(out / 'report.json', report)
    log(f'transfer -> {out}')


# ====================================================================== commands: apply

def cmd_apply(a):
    dst = Path(a.out).resolve()
    if dst.exists():
        raise SystemExit(f'{dst} exists; apply writes a new .blend only')
    src = open_blend(a.blend, resolve=a.repair_paths)
    run = Path(a.run).resolve()
    rep = json.loads((run / 'report.json').read_text(encoding='utf-8'))
    changed, shown = [], {}
    for t in rep['targets']:
        if t.get('kind') == 'new':
            changed.append(wire_new_image(t, run))
            shown[t['material']] = display_colour(t, run)
            continue
        old = bpy.data.images.get(t['image'])
        if old is None:
            raise SystemExit(f"Image {t['image']} not in {src}")
        first = run / t['outputs'][0]
        new = bpy.data.images.load(str(first), check_existing=False)
        if old.source == 'TILED':
            new.source = 'TILED'
        new.colorspace_settings.name = old.colorspace_settings.name
        new.name = safe_stem(old.name) + '_tm3d'
        users = 0
        owner = {m.node_tree: m.name for m in bpy.data.materials if m.node_tree}
        mats = set(t.get('materials') or [])
        for tree in list(owner) + list(bpy.data.node_groups):
            for node in tree.nodes:
                if node.type == 'TEX_IMAGE' and node.image == old:
                    node.image = new
                    users += 1
                    if tree in owner:
                        mats.add(owner[tree])
        for m in mats:
            shown[m] = display_colour(t, run)
        changed.append({'old': old.name, 'new': new.name, 'files': t['outputs'], 'image_nodes_relinked': users,
                        'tiles': [tl.number for tl in new.tiles] if new.source == 'TILED' else [1001]})
        log(f"apply: {old.name} -> {new.name} on {users} image nodes")
    inputs_set = [set_bsdf_input(spec) for spec in a.set_input]
    previews = []
    if not a.keep_viewport:
        # Solid view shows each material's viewport colour, not its textures: match it to the new look,
        # and open the main 3D views in Material Preview so the file shows the textures as soon as it opens.
        for m, colour in shown.items():
            bpy.data.materials[m].diffuse_color = (*colour[:3], 1.0)
            log(f'apply: {m} viewport colour {srgb8(colour)}')
        for scr in bpy.data.screens:
            if scr.name in ('Layout', 'Animation'):
                for area in scr.areas:
                    if area.type == 'VIEW_3D' and area.spaces[0].shading.type == 'SOLID':
                        area.spaces[0].shading.type = 'MATERIAL'
                        previews.append(scr.name)
    dst.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(dst), copy=True, relative_remap=True)
    write_json(dst.with_suffix('.tm3d.json'), {'source_blend': src, 'source_sha256': sha256(src), 'output_blend': str(dst),
                                               'output_sha256': sha256(dst), 'run': str(run), 'changes': changed,
                                               'viewport_colours_srgb': {} if a.keep_viewport else {m: srgb8(c) for m, c in shown.items()},
                                               'material_preview_in': sorted(set(previews)), 'inputs_set': inputs_set,
                                               'image_paths_repaired_in_output': PATH_FIXES if a.repair_paths else []})
    log(f'apply -> {dst}')


def display_colour(t, run):
    """Linear viewport colour for a target: the run's choice, else the most common colour of its first output."""
    if t.get('display_colour'):
        return t['display_colour']
    px, is_float = load_pixels(run / t['outputs'][0], max_size=256)
    lin = px[..., :3] if is_float else L.srgb_to_linear(px[..., :3])
    return L.log_mode(lin.reshape(-1, 3)).tolist()


def set_bsdf_input(spec):
    """'MATERIAL:INPUT=VALUE' -> set that input on every Principled BSDF of the material."""
    m = re.fullmatch(r'(.+?):(.+)=\s*([-+0-9.eE]+)\s*', spec)
    if not m:
        raise SystemExit(f'--set-input {spec!r}: expected MATERIAL:INPUT=VALUE')
    name, inp, value = m.group(1), m.group(2).strip(), float(m.group(3))
    mat = bpy.data.materials.get(name)
    nodes = [n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'] if mat and mat.node_tree else []
    if not nodes or inp not in nodes[0].inputs:
        raise SystemExit(f'--set-input {spec!r}: no Principled BSDF with an input {inp!r} in material {name!r}')
    old = [round(float(n.inputs[inp].default_value), 4) for n in nodes]
    for n in nodes:
        n.inputs[inp].default_value = value
    log(f'apply: {name} {inp} {old} -> {value}')
    return {'material': name, 'input': inp, 'old': old, 'new': value, 'nodes': [n.name for n in nodes]}


def wire_new_image(t, run):
    """Load a new base-colour image and link it into the material's Base Color inputs (old nodes stay, unlinked)."""
    mat = bpy.data.materials.get(t['material'])
    if mat is None or not mat.node_tree:
        raise SystemExit(f"Material {t['material']} not in this .blend")
    img = bpy.data.images.load(str(run / t['outputs'][0]), check_existing=False)
    if t.get('source') == 'TILED':
        img.source = 'TILED'
    img.colorspace_settings.name = 'sRGB'
    img.name = target_stem(t) + '_tm3d'
    nt = mat.node_tree
    bsdfs = [n for n in nt.nodes if n.name in (t.get('bsdf_nodes') or []) and n.type in ('BSDF_PRINCIPLED', 'BSDF_DIFFUSE')]
    if not bsdfs:
        raise SystemExit(f"{t['material']}: none of the recorded BSDF nodes {t.get('bsdf_nodes')} exist")
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image, tex.label, tex.name = img, 'TM3D base colour', 'TM3D base colour'
    tex.location = (bsdfs[0].location.x - 420, bsdfs[0].location.y + 220)
    replaced = []
    for node in bsdfs:
        sock = node.inputs['Base Color' if node.type == 'BSDF_PRINCIPLED' else 'Color']
        replaced.append(sock.links[0].from_node.name if sock.is_linked else 'flat colour')
        nt.links.new(tex.outputs['Color'], sock)
    log(f"apply: {t['material']} Base Color <- new image {img.name} (was {', '.join(replaced)})")
    return {'material': t['material'], 'new': img.name, 'files': t['outputs'], 'bsdf_nodes': [n.name for n in bsdfs],
            'replaced_links_from': replaced, 'tiles': [tl.number for tl in img.tiles] if img.source == 'TILED' else [1001]}


# ====================================================================== commands: verify (previews + invariants)

class TexBank:
    def __init__(self, max_size):
        self.max_size, self.cache = max_size, {}

    def get(self, name):
        if name not in self.cache:
            img = bpy.data.images.get(name)
            tiles = {}
            if img is not None:
                for tile in image_tiles(img):
                    try:
                        if img.packed_file and img.source != 'TILED':
                            tmp = img.copy()
                            arr, f = load_pixels(image=tmp, max_size=self.max_size)
                            bpy.data.images.remove(tmp)
                        else:
                            arr, f = load_pixels(path=image_tile_path(img, tile), max_size=self.max_size)
                        tiles[tile] = arr[..., :3] if f else L.srgb_to_linear(arr[..., :3])
                    except Exception as exc:
                        log(f'preview: cannot load {name} tile {tile}: {exc}')
            self.cache[name] = tiles
        return self.cache[name]


def render_preview(cam, md, shading, bank, bg=1.0, lit=True):
    tris, uvs, tex, flat = [], [], [], []
    for name, m in md.items():
        for slot in np.unique(m.tri_mat):
            sel = m.tri_mat == slot
            entry = shading.get((name, int(slot)), ('color', [0.6, 0.6, 0.6]))
            tris.append(m.tri_co[sel])
            if entry[0] == 'image' and entry[2] in m.uv:
                uvs.append(m.uv[entry[2]][m.tri_loops[sel]])
                tex.extend([entry[1]] * int(sel.sum()))
                flat.append(np.tile([0.6, 0.6, 0.6], (int(sel.sum()), 1)))
            else:
                uvs.append(np.zeros((int(sel.sum()), 3, 2)))
                tex.extend([None] * int(sel.sum()))
                # socket colours are already scene-linear
                flat.append(np.tile(entry[1][:3] if entry[0] == 'color' else [0.6, 0.6, 0.6], (int(sel.sum()), 1)))
    co, uv, flat = np.concatenate(tris), np.concatenate(uvs), np.concatenate(flat)
    tex = np.array(tex, dtype=object)
    x, y, depth = cam.project(co.reshape(-1, 3))
    xy = np.stack([x, y], -1).reshape(-1, 3, 2)
    r = L.rasterize(xy, cam.width, cam.height)
    pix = r['y'].astype(np.int64) * cam.width + r['x']
    z = (r['bary'] * depth.reshape(-1, 3)[r['tri']]).sum(1)
    keep = L.nearest_fragments(pix, z)
    pix, tri, bary = pix[keep], r['tri'][keep], r['bary'][keep].astype(np.float64)
    e1, e2 = co[tri, 1] - co[tri, 0], co[tri, 2] - co[tri, 0]
    fn = np.cross(e1, e2)
    fn /= np.maximum(np.linalg.norm(fn, axis=1, keepdims=True), 1e-12)
    pos = np.einsum('nk,nkj->nj', bary, co[tri])
    lam = np.abs((fn * cam.towards_camera(pos)).sum(1))
    color = flat[tri].astype(np.float32)
    tuv = np.einsum('nk,nkj->nj', bary, uv[tri])
    origin = np.floor(uv[tri].mean(axis=1))
    tile = 1001 + origin[:, 0].astype(int) + 10 * origin[:, 1].astype(int)
    for name in set(t for t in tex[tri] if t):
        tiles = bank.get(name)
        sel_name = tex[tri] == name
        for tnum, arr in tiles.items():
            sel = sel_name & ((tile == tnum) | (len(tiles) == 1))
            if sel.any():
                h, w = arr.shape[:2]
                local = tuv[sel] - origin[sel]
                color[sel] = L.bilinear(arr, local[:, 0] * w - 0.5, local[:, 1] * h - 0.5, wrap=True)
    shaded = color * (0.35 + 0.65 * lam[:, None]) if lit else color
    img = np.full((cam.height * cam.width, 3), bg, np.float32)
    img[pix] = L.linear_to_srgb(shaded)
    alpha = np.zeros(cam.height * cam.width, bool)
    alpha[pix] = True
    return img.reshape(cam.height, cam.width, 3), alpha.reshape(cam.height, cam.width)


def preview_camera(spec, max_dim):
    s = min(1.0, max_dim / max(spec['width'], spec['height']))
    return scaled_camera(spec, max(8, int(round(spec['width'] * s))), max(8, int(round(spec['height'] * s))))


def orbit_camera(md, yaw_deg, facing, size=640):
    lo, hi, diag = scene_bounds(md)
    mid = (lo + hi) / 2
    f, r, u = (np.asarray(v, float) for v in L.AXIS_VIEWS['front'])
    rot = {'-Y': 0, '+X': 90, '+Y': 180, '-X': 270}[facing] + yaw_deg
    c, s = math.cos(math.radians(rot)), math.sin(math.radians(rot))
    rz = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])
    f, r = rz @ f, rz @ r
    ext = max(hi[2] - lo[2], np.linalg.norm((hi - lo)[:2])) * 1.08
    return {'kind': 'ORTHO', 'width': size, 'height': size, 'forward': f.tolist(), 'right': r.tolist(), 'up': u.tolist(),
            'center': mid.tolist(), 'pixels_per_metre': size / ext}


def diff_fingerprints(fa, fb):
    issues = []
    for kind in ('meshes', 'armatures'):
        for name in sorted(set(fa[kind]) | set(fb[kind])):
            if name not in fa[kind] or name not in fb[kind]:
                issues.append(f'{kind[:-1]} {name} added or removed')
                continue
            for k, v in fa[kind][name].items():
                if fb[kind][name].get(k) != v:
                    issues.append(f'{kind[:-1]} {name}: {k} changed')
    return issues


def cmd_verify(a):
    out = fresh_dir(a.out)
    views_doc = json.loads(Path(a.views).read_text(encoding='utf-8')) if a.views else None
    pose_mode = views_doc['pose']['mode'] if views_doc else a.pose
    frame = views_doc['pose']['frame'] if views_doc else a.frame
    facing = views_doc['facing'] if views_doc else a.facing
    results = {}
    for tag, path in (('before', a.before), ('after', a.after)):
        open_blend(path)
        fp = scene_fingerprint()
        a2 = argparse.Namespace(blend=path, pose=pose_mode, frame=frame, no_subsurf=views_doc.get('no_subsurf', False) if views_doc else False,
                                mesh_names=views_doc.get('meshes') if views_doc else None, objects=a.objects, exclude=a.exclude)
        _, _, meshes, _, _, md = scene_for_pose(a2)
        shading = slot_shading(meshes)
        bank = TexBank(a.preview_tex)
        renders = {}
        # calibrated views render unlit (comparable with albedo references); orbit views are lit for shape cues
        cams = [(v['name'], preview_camera(v, a.size), False) for v in (views_doc['views'] if views_doc else [])]
        cams += [(f'orbit{y}', orbit_camera(md, y, facing, a.size), True) for y in (0, 45, 135, 180, 225, 315)]
        for name, spec, lit in cams:
            renders[name] = render_preview(L.Camera(spec), md, shading, bank, lit=lit)
        if a.pose_frame is not None:
            set_pose('current', a.pose_frame)
            md2 = evaluate_scene(meshes, {ob.name: {e[2] for k, e in shading.items() if k[0] == ob.name and e[0] == 'image'} for ob in meshes},
                                 disable_types=())
            for y in (0, 45, 180):
                renders[f'posed{y}'] = render_preview(L.Camera(orbit_camera(md2, y, facing, a.size)), md2, shading, bank)
        results[tag] = {'fingerprint': fp, 'renders': renders, 'path': path, 'sha256': sha256(path)}
    issues = diff_fingerprints(results['before']['fingerprint'], results['after']['fingerprint'])
    sheets, metrics = [], []
    gap = np.ones((1, 8, 3), np.float32)
    for name in results['after']['renders']:
        aft, am = results['after']['renders'][name]
        bef, _ = results['before']['renders'][name]
        row = [bef, aft]
        v = next((v for v in (views_doc['views'] if views_doc else []) if v['name'] == name), None)
        if v is not None:
            # the reference resampled into this camera through the calibration warp, so pixels correspond
            ref = load_reference(v['image'])
            ph, pw = aft.shape[:2]
            ys, xs = np.mgrid[0:ph, 0:pw]
            wx, wy = warp_lookup(v, Path(a.views).parent)((xs.ravel() + 0.5) * v['width'] / pw - 0.5,
                                                           (ys.ravel() + 0.5) * v['height'] / ph - 0.5)
            refs = L.bilinear(ref, wx, wy).reshape(ph, pw, ref.shape[2])
            rgb = refs[..., :3] * refs[..., 3:4] + (1 - refs[..., 3:4])
            row = [rgb] + row
            metrics.append({'view': name, 'mae_before': L.mean_abs_error(bef, rgb, am), 'mae_after': L.mean_abs_error(aft, rgb, am)})
        sheet = np.concatenate(sum([[im, np.broadcast_to(gap, (im.shape[0], 8, 3))] for im in row], [])[:-1], axis=1)
        sheets.append(save_png(out / f'verify_{name}.png', sheet, top_down=True))
    report = {'blender': bpy.app.version_string, 'before': results['before']['path'], 'after': results['after']['path'],
              'before_sha256': results['before']['sha256'], 'after_sha256': results['after']['sha256'],
              'invariant_issues': issues, 'invariants': 'PASS' if not issues else 'FAIL',
              'reference_error': metrics, 'sheets': sheets,
              'sheet_layout': '[reference |] before | after (sRGB, preview shading, not a beauty render)',
              'status': 'VERIFIED_INVARIANTS_NOT_REVIEWED' if not issues else 'FAILED_INVARIANTS'}
    write_json(out / 'verify.json', report)
    log(f"verify: invariants {report['invariants']} ({len(issues)} issues); sheets -> {out}")
    for m in metrics:
        log(f"  {m['view']}: MAE vs reference before={m['mae_before']:.4f} after={m['mae_after']:.4f}")
    if issues:
        for i in issues:
            log('  ' + i)
        raise SystemExit(3)


# ====================================================================== selftest

def cmd_selftest(a):
    out = fresh_dir(a.out)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=32, radius=0.5, location=(0, 0, 1))
    body = bpy.context.active_object
    body.name = 'BODY'
    body.scale = (0.8, 0.6, 1.4)  # an ellipsoid: unlike a sphere, its outline pins down the camera elevation
    bpy.ops.object.shade_smooth()
    bpy.ops.mesh.primitive_cube_add(size=0.3, location=(0, -0.38, 1.1))
    nose = bpy.context.active_object
    nose.name = 'NOSE'
    res = 256
    yy, xx = np.mgrid[0:res, 0:res] / (res - 1)
    bands = np.array([[0.10, 0.12, 0.35], [0.85, 0.65, 0.55], [0.75, 0.15, 0.15], [0.92, 0.92, 0.90]], np.float32)
    truth = bands[np.digitize(xx, [0.3, 0.55, 0.8])]  # costume-like flat regions (sRGB) around the body
    tex_dir = out / 'textures'
    tex_dir.mkdir()
    save_png(tex_dir / 'body_truth.png', truth)
    save_png(tex_dir / 'body_start.png', np.full_like(truth, 0.5))
    save_png(tex_dir / 'udim.1001.png', np.full((64, 64, 3), 0.5, np.float32))
    save_png(tex_dir / 'udim.1002.png', np.full((64, 64, 3), 0.5, np.float32))

    def material(name, image_path, tiled=False):
        mat = bpy.data.materials.new(name)
        node = mat.node_tree.nodes.new('ShaderNodeTexImage')
        node.image = bpy.data.images.load(str(image_path), check_existing=False)
        if tiled:
            node.image.source = 'TILED'
        mat.node_tree.links.new(node.outputs['Color'], mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'])
        return mat

    body.data.materials.append(material('BODY_MAT', tex_dir / 'body_truth.png'))
    nose.data.materials.append(material('NOSE_MAT', tex_dir / 'udim.1001.png', tiled=True))
    uvn = np.empty(len(nose.data.loops) * 2, np.float32)
    nose.data.uv_layers[0].data.foreach_get('uv', uvn)
    uvn = uvn.reshape(-1, 2)
    uvn[nose.data.loops.__len__() // 2:, 0] += 1.0  # half of the cube faces on tile 1002 (approximate split by loop order)
    nose.data.uv_layers[0].data.foreach_set('uv', uvn.ravel())
    truth_blend = out / 'truth.blend'
    bpy.ops.wm.save_as_mainfile(filepath=str(truth_blend), copy=True)
    # references: render the truth model from six axis views as flat albedo with transparent background
    img_dir = out / 'IMG'
    img_dir.mkdir()
    md = evaluate_scene(render_meshes(), {o.name: {render_uv_name(o)} for o in render_meshes()}, disable_types=())
    shading = slot_shading(render_meshes())
    bank = TexBank(1024)
    for label, key, k, scale in (('front', 'front', 0, 300), ('back', 'back', 0, 280), ('left', 'cam+x', 0, 260),
                                 ('right', 'cam-x', 0, 300), ('top', 'top', 1, 240), ('bottom', 'bottom', 0, 250)):
        f, r, u = (np.asarray(v, float) for v in L.AXIS_VIEWS[key])
        r, u = L.rotate_in_plane(r, u, k)
        spec = {'kind': 'ORTHO', 'width': 440, 'height': 520, 'forward': f, 'right': r, 'up': u,
                'center': [0.02, -0.03, 1.01], 'pixels_per_metre': scale}
        cam = L.Camera(spec)
        albedo, alpha = render_preview(cam, md, shading, bank, bg=0.0, lit=False)
        save_png(img_dir / f'{label}.png', np.concatenate([albedo, alpha[..., None].astype(np.float32)], -1), top_down=True)
    # the working file starts from a flat grey texture
    open_blend(truth_blend)
    img = bpy.data.images['body_truth.png']
    img.filepath = str(tex_dir / 'body_start.png')
    img.reload()
    work_blend = out / 'work.blend'
    bpy.ops.wm.save_as_mainfile(filepath=str(work_blend), copy=True)
    checks = {}
    ns = argparse.Namespace
    cmd_calibrate(ns(blend=str(work_blend), img=str(img_dir), out=str(out / 'cal'), pose='current', frame=None, facing='-Y',
                     no_subsurf=False, ambiguity=0.02, photo_margin=0.08, min_iou=0.9, mask_tol=0.08, no_warp=False, objects=None, exclude=None))
    views = json.loads((out / 'cal' / 'views.json').read_text())
    checks['calibration'] = {v['name']: [v['candidate'], round(v['iou'], 4), round(v['iou_after_warp'], 4)] for v in views['views']}
    expected = {'front': ('front', 0), 'back': ('back', 0), 'left': ('cam+x', 0), 'right': ('cam-x', 0), 'top': ('top', 1), 'bottom': ('bottom', 0)}

    def axes_match(v):
        f, r, u = (np.asarray(x, float) for x in L.AXIS_VIEWS[expected[v['name']][0]])
        r, u = L.rotate_in_plane(r, u, expected[v['name']][1])
        return min(np.dot(v['forward'], f), np.dot(v['right'], r), np.dot(v['up'], u)) > 0.98

    checks['calibration_ok'] = all(axes_match(v) and v['iou'] > 0.97 for v in views['views'])
    cmd_project(ns(blend=str(work_blend), views=str(out / 'cal' / 'views.json'), out=str(out / 'proj'), image=['body_truth.png', 'udim.1001.png'],
                   work_res=256, min_cos=0.2, full_cos=0.5, power=4.0, edge=0.004, depth_eps=2e-4, no_keep=False, no_tone_match=False, views_only=None,
                   skip=[], min_new_coverage=0.2, no_warp=False))
    result, _ = load_pixels(out / 'proj' / 'body_truth.png')
    conf, _ = load_pixels(out / 'proj' / 'body_truth_confidence.png')
    good = conf[..., 0] > 0.99
    err = np.abs(result[..., :3] - truth)[good].mean()
    checks['projection_mae_confident'] = float(err)
    checks['projection_confident_fraction'] = float(good.mean())
    checks['udim_tiles_written'] = sorted(p.name for p in (out / 'proj').glob('udim.*.png') if 'confidence' not in p.name)
    # recolour: the flat grey start takes the band colours the images show
    cmd_recolour(build_parser().parse_args(['recolour', '--blend', str(work_blend), '--views', str(out / 'cal' / 'views.json'),
                                            '--out', str(out / 'rec'), '--image', 'body_truth.png', '--image', 'udim.1001.png', '--work-res', '256']))
    rec, _ = load_pixels(out / 'rec' / 'body_truth.png')
    checks['start_mae'] = float(np.abs(0.5 - truth)[good].mean())
    checks['recolour_mae'] = float(np.abs(rec[..., :3] - truth)[good].mean())
    # transfer: a service-like copy with different UVs, textured with the truth
    cmd_handoff(ns(blend=str(truth_blend), out=str(out / 'hand'), image=['body_truth.png'], pose='current', frame=None, uv='smart',
                   max_overlap=0.02, max_tris=150000, embed=True, embed_res=256, context=True, no_subsurf=False, skip=[], objects=None, exclude=None))
    cmd_transfer(ns(blend=str(work_blend), manifest=str(out / 'hand' / 'handoff.json'), source=str(out / 'hand' / 'handoff.glb'),
                    out=str(out / 'xfer'), image=['body_truth.png'], work_res=256, cage=0.01, align_tol=0.002, no_keep=False, no_tone_match=False, objects=None, exclude=None))
    xres, _ = load_pixels(out / 'xfer' / 'body_truth.png')
    xconf, _ = load_pixels(out / 'xfer' / 'body_truth_confidence.png')
    cov = xconf[..., 0] > 0.99
    checks['transfer_mae'] = float(np.abs(xres[..., :3] - truth)[cov].mean())
    checks['transfer_covered_fraction'] = float(cov.mean())
    cmd_apply(ns(blend=str(work_blend), run=str(out / 'proj'), out=str(out / 'applied.blend'), repair_paths=False, set_input=[], keep_viewport=False))
    cmd_verify(ns(before=str(work_blend), after=str(out / 'applied.blend'), views=str(out / 'cal' / 'views.json'), out=str(out / 'verify'),
                  pose='current', frame=None, facing='-Y', size=256, preview_tex=512, pose_frame=None, objects=None, exclude=None))
    ver = json.loads((out / 'verify' / 'verify.json').read_text())
    checks['invariants'] = ver['invariants']
    ok = (checks['calibration_ok'] and checks['projection_mae_confident'] < 0.03 and checks['transfer_mae'] < 0.03
          and checks['recolour_mae'] < 0.05 and checks['invariants'] == 'PASS' and len(checks['udim_tiles_written']) == 2)
    checks['status'] = 'PASS' if ok else 'FAIL'
    write_json(out / 'selftest.json', checks)
    log('selftest ' + json.dumps(checks))
    if not ok:
        raise SystemExit(4)


# ====================================================================== CLI

def build_parser():
    p = argparse.ArgumentParser(prog='tm3d')
    p.add_argument('--require', default=os.environ.get('TM3D_BLENDER_RELEASE', '5.2'), help='pinned Blender MAJOR.MINOR')
    p.add_argument('--texture-dir', action='append', default=[], help='extra folder to search for missing texture files')
    sub = p.add_subparsers(dest='cmd', required=True)

    def pose_args(q):
        q.add_argument('--pose', choices=['current', 'rest'], default='current', help='armature pose used for evaluation')
        q.add_argument('--frame', type=int, default=None)
        q.add_argument('--no-subsurf', action='store_true', help='evaluate without Subdivision Surface modifiers')

    def mesh_args(q):
        q.add_argument('--objects', default=None, help='regex of character mesh names (default: rigged meshes)')
        q.add_argument('--exclude', default=None, help='regex of mesh names to leave out')

    q = sub.add_parser('inspect')
    q.add_argument('--blend', required=True)
    q.add_argument('--out', required=True)
    mesh_args(q)
    q = sub.add_parser('calibrate')
    q.add_argument('--blend', required=True)
    q.add_argument('--img', required=True, help='folder with front/back/left/right/top/bottom images (or IMG/<character>)')
    q.add_argument('--out', required=True)
    q.add_argument('--facing', choices=['-Y', '+Y', '+X', '-X'], default='-Y', help='direction the character faces')
    q.add_argument('--ambiguity', type=float, default=0.02, help='IoU margin below which a view is flagged AMBIGUOUS')
    q.add_argument('--photo-margin', type=float, default=0.08,
                   help='IoU margin within which the colour agreement with an anchor view picks between candidate families')
    q.add_argument('--min-iou', type=float, default=0.75)
    q.add_argument('--mask-tol', type=float, default=0.08, help='backdrop colour tolerance for keying references')
    q.add_argument('--no-warp', action='store_true', help='rigid camera fit only (use for exact renders of this mesh)')
    pose_args(q)
    mesh_args(q)
    q = sub.add_parser('project')
    q.add_argument('--blend', required=True)
    q.add_argument('--views', required=True)
    q.add_argument('--out', required=True)
    q.add_argument('--image', action='append', help="target name (repeatable): an image or 'new:<material>'; default all colour targets")
    q.add_argument('--skip', action='append', default=[], help='target, image or material name to leave unchanged (repeatable)')
    q.add_argument('--min-new-coverage', type=float, default=0.2, help='create a new image only if views see this fraction of it')
    q.add_argument('--no-warp', action='store_true', help='ignore the calibration warp')
    q.add_argument('--views-only', action='append', default=None)
    q.add_argument('--work-res', type=int, default=2048)
    q.add_argument('--min-cos', type=float, default=0.2)
    q.add_argument('--full-cos', type=float, default=0.5)
    q.add_argument('--power', type=float, default=4.0)
    q.add_argument('--edge', type=float, default=0.004, help='reference mask erosion as a fraction of image size')
    q.add_argument('--depth-eps', type=float, default=2e-4, help='visibility tolerance as a fraction of scene diagonal')
    q.add_argument('--no-keep', action='store_true', help='do not keep the original texture where no view sees the surface')
    q.add_argument('--no-tone-match', action='store_true', help='keep the original colours where kept, without recolouring them to the images')
    q = sub.add_parser('recolour')
    q.add_argument('--blend', required=True)
    q.add_argument('--views', required=True)
    q.add_argument('--out', required=True)
    q.add_argument('--image', action='append', help="target name (repeatable): an image or 'new:<material>'; default all colour targets")
    q.add_argument('--skip', action='append', default=[], help='target, image or material name to leave unchanged (repeatable)')
    q.add_argument('--calib', default=None, help='tone.json from `tone` (colour scales per material|label)')
    q.add_argument('--multi', default=None, help='comma list of objects that carry several colour regions or markings (default: auto)')
    q.add_argument('--skin-object', default=None, help="object whose colour is skin; decals never land on it (default: a 'head'/'face' mesh; 'none' = off)")
    q.add_argument('--auto-second', type=float, default=0.2, help='auto multi: share the second colour needs on an object')
    q.add_argument('--auto-marks', type=float, default=0.02, help='auto multi: share of mark colours (patches, lettering) on an object; marks of its own hue (shine) do not count')
    q.add_argument('--palette-view', default='front,back', help='comma list of views whose colours define the palette; the first is clustered alone, later ones add only colours it lacks')
    q.add_argument('--k', type=int, default=7, help='palette clusters before merging shades')
    q.add_argument('--merge-chroma', type=float, default=0.35)
    q.add_argument('--merge-lum', type=float, default=1.4)
    q.add_argument('--min-share', type=float, default=0.04, help='colours below this share of the character are marks (decals only)')
    q.add_argument('--min-object-share', type=float, default=0.15, help='share a colour needs on an object to become a region there')
    q.add_argument('--object-share', default='', help='per-object overrides of --min-object-share: name=value,...')
    q.add_argument('--radius', type=int, default=6, help='region smoothing radius in work texels')
    q.add_argument('--decal-thr', type=float, default=0.7, help='log-colour difference from the region that makes a mark')
    q.add_argument('--decal-clean', type=int, default=2, help='erode/dilate radius that drops specks from decals')
    q.add_argument('--decal-views', default='front,back,left,right')
    q.add_argument('--decal-cos', type=float, default=0.75, help='how face-on a view must be to give decals')
    q.add_argument('--decal-cos-view', default='front=0.4,back=0.4', help='per-view overrides of --decal-cos: view=value,...')
    q.add_argument('--min-new-coverage', type=float, default=0.2, help='create a new image only if views see this fraction of it')
    q.add_argument('--no-warp', action='store_true', help='ignore the calibration warp')
    q.add_argument('--views-only', action='append', default=None)
    q.add_argument('--work-res', type=int, default=2048)
    q.add_argument('--min-cos', type=float, default=0.2)
    q.add_argument('--full-cos', type=float, default=0.5)
    q.add_argument('--power', type=float, default=4.0)
    q.add_argument('--edge', type=float, default=0.004, help='reference mask erosion as a fraction of image size')
    q.add_argument('--depth-eps', type=float, default=2e-4, help='visibility tolerance as a fraction of scene diagonal')
    q = sub.add_parser('tone')
    q.add_argument('--blend', required=True, help='the .blend written by apply from --run')
    q.add_argument('--run', required=True, help='recolour run directory')
    q.add_argument('--out', required=True)
    q.add_argument('--prev', default=None, help='tone.json of the previous pass; scales compound')
    q.add_argument('--damping', type=float, default=None, help='exponent on each correction (default 1, or 0.5 with --prev)')
    q.add_argument('--samples', type=int, default=32)
    q.add_argument('--min-pixels', type=int, default=300)
    q.add_argument('--facing', choices=['-Y', '+Y', '+X', '-X'], default='-Y')
    pose_args(q)
    mesh_args(q)
    q = sub.add_parser('render')
    q.add_argument('--blend', required=True)
    q.add_argument('--out', required=True)
    q.add_argument('--views', help='views.json, for the facing direction')
    q.add_argument('--facing', choices=['-Y', '+Y', '+X', '-X'], default='-Y')
    q.add_argument('--samples', type=int, default=32)
    q.add_argument('--no-scene-camera', action='store_true', help="frame the front shot itself instead of using the file's camera")
    pose_args(q)
    mesh_args(q)
    q = sub.add_parser('handoff')
    q.add_argument('--blend', required=True)
    q.add_argument('--out', required=True)
    q.add_argument('--image', action='append')
    q.add_argument('--skip', action='append', default=[])
    mesh_args(q)
    q.add_argument('--uv', choices=['auto', 'keep', 'pack', 'smart'], default='auto',
                   help='auto: keep single-tile UVs, pack UDIM tiles into 0-1, Smart UV Project when overlapping')
    q.add_argument('--max-overlap', type=float, default=0.02)
    q.add_argument('--max-tris', type=int, default=150000)
    q.add_argument('--embed', action='store_true', help='embed the current texture as a starting layer')
    q.add_argument('--embed-res', type=int, default=2048)
    q.add_argument('--context', action='store_true', help='add other visible meshes as an untextured TM3D_CONTEXT object')
    pose_args(q)
    q = sub.add_parser('transfer')
    q.add_argument('--blend', required=True)
    q.add_argument('--manifest', required=True)
    q.add_argument('--source', required=True, help='GLB returned by the service')
    q.add_argument('--out', required=True)
    q.add_argument('--image', action='append')
    q.add_argument('--work-res', type=int, default=2048)
    q.add_argument('--cage', type=float, default=0.01, help='ray start offset as a fraction of scene diagonal')
    q.add_argument('--align-tol', type=float, default=0.002)
    q.add_argument('--no-keep', action='store_true')
    q.add_argument('--no-tone-match', action='store_true')
    mesh_args(q)
    q = sub.add_parser('apply')
    q.add_argument('--blend', required=True)
    q.add_argument('--run', required=True, help='recolour, project or transfer run directory')
    q.add_argument('--out', required=True, help='new .blend path')
    q.add_argument('--repair-paths', action='store_true', help='also save repaired texture paths in the output .blend')
    q.add_argument('--set-input', action='append', default=[], metavar='MATERIAL:INPUT=VALUE',
                   help="set a Principled BSDF input, e.g. 'MAT-top:Specular IOR Level=0.45' (repeatable)")
    q.add_argument('--keep-viewport', action='store_true', help='leave viewport colours and 3D view shading unchanged')
    q = sub.add_parser('verify')
    mesh_args(q)
    q.add_argument('--before', required=True)
    q.add_argument('--after', required=True)
    q.add_argument('--views')
    q.add_argument('--out', required=True)
    q.add_argument('--pose', choices=['current', 'rest'], default='current')
    q.add_argument('--frame', type=int, default=None)
    q.add_argument('--facing', choices=['-Y', '+Y', '+X', '-X'], default='-Y')
    q.add_argument('--size', type=int, default=640)
    q.add_argument('--preview-tex', type=int, default=1024)
    q.add_argument('--pose-frame', type=int, default=None, help='also render the posed character at this frame')
    q = sub.add_parser('selftest')
    q.add_argument('--out', required=True)
    return p


def main(argv):
    a = build_parser().parse_args(argv)
    require_version(a.require)
    TEXTURE_DIRS[:] = a.texture_dir
    t0 = time.time()
    {'inspect': cmd_inspect, 'calibrate': cmd_calibrate, 'recolour': cmd_recolour, 'project': cmd_project, 'tone': cmd_tone,
     'render': cmd_render, 'handoff': cmd_handoff, 'transfer': cmd_transfer, 'apply': cmd_apply, 'verify': cmd_verify,
     'selftest': cmd_selftest}[a.cmd](a)
    log(f'{a.cmd} finished in {time.time() - t0:.1f} s')


if __name__ == '__main__':
    main(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
