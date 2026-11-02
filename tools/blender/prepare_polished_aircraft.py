"""Convert the licensed Cessna FBX and Mi-17 source into bounded mechanical game rigs.

Run in the project's isolated Blender 5.2 container. Input is the safely extracted
originals folder; output is a new work folder, never the original distributions.
"""
import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

assert bpy.app.version[:2] == (5, 2), bpy.app.version_string
p = argparse.ArgumentParser()
p.add_argument('--input', type=Path, required=True)
p.add_argument('--output', type=Path, required=True)
args = p.parse_args(sys.argv[sys.argv.index('--') + 1:])
args.output.mkdir(parents=True, exist_ok=True)


def principled(name, color=(0.35, 0.38, 0.34, 1), metallic=0.0, roughness=0.65):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = color
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Roughness'].default_value = roughness
    return m, bsdf


def image_node(material, image):
    n = material.node_tree.nodes.new('ShaderNodeTexImage')
    n.image = image
    material.node_tree.nodes.active = n
    return n


def empty(name, location):
    o = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(o)
    o.location = location
    return o


def spin(pivot, axis, turns=1):
    pivot.rotation_mode = 'XYZ'
    for frame, angle in [(1, 0), (9, math.pi / 2 * turns), (17, math.pi * turns),
                         (25, math.pi * 1.5 * turns), (33, math.pi * 2 * turns)]:
        pivot.rotation_euler[axis] = angle
        pivot.keyframe_insert(data_path='rotation_euler', frame=frame)
    action = pivot.animation_data.action
    action.name = pivot.name + '_spin'
    for layer in action.layers:
        for strip in layer.strips:
            for slot in action.slots:
                channelbag = strip.channelbag(slot)
                if channelbag:
                    for fc in channelbag.fcurves:
                        for key in fc.keyframe_points:
                            key.interpolation = 'LINEAR'
    track = pivot.animation_data.nla_tracks.new()
    track.name = 'spin'
    track.strips.new('spin', 1, action)
    pivot.animation_data.action = None


def rebuild_plane_materials():
    for material in list(bpy.data.materials):
        name = material.name
        file_name = name.replace(' ', '_') + '_Base_Color.jpeg'
        image_path = args.input / 'cessna/textures' / file_name
        if not image_path.exists():
            raise RuntimeError('Missing aircraft base texture: ' + file_name)
        image = bpy.data.images.load(str(image_path), check_existing=False)
        image.scale(1024 if name == 'Main' else 512, 1024 if name == 'Main' else 512)
        material.use_nodes = True
        material.node_tree.nodes.clear()
        bsdf = material.node_tree.nodes.new('ShaderNodeBsdfPrincipled')
        out = material.node_tree.nodes.new('ShaderNodeOutputMaterial')
        material.node_tree.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
        bsdf.inputs['Roughness'].default_value = 0.4 if name in ('Main', 'Altbody') else 0.65
        material.node_tree.links.new(image_node(material, image).outputs['Color'], bsdf.inputs['Base Color'])
        if name == 'windows':
            # Transparent glazing keeps the supplied cockpit and seated pilot visible.
            bsdf.inputs['Alpha'].default_value = 0.28
            bsdf.inputs['Roughness'].default_value = 0.2
            material.surface_render_method = 'DITHERED'


def bake_heli_materials(meshes):
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 1
    scene.render.bake.use_pass_direct = False
    scene.render.bake.use_pass_indirect = False
    scene.render.bake.use_pass_color = True
    scene.render.bake.use_clear = False
    scene.render.bake.margin = 4
    used = {m for o in meshes for m in o.data.materials if m}
    replacements = {}
    targets = {}
    for index, material in enumerate(sorted(used, key=lambda m: m.name)):
        glass = 'glass' in material.name.lower()
        textured = material.use_nodes and any(n.type == 'TEX_IMAGE' and n.image and n.image.size[0] for n in material.node_tree.nodes)
        color = (0.13, 0.22, 0.25, 0.32) if glass else tuple(material.diffuse_color)
        if material.use_nodes and not textured and not glass:
            diffuse = next((n for n in material.node_tree.nodes if n.type == 'BSDF_DIFFUSE'), None)
            if diffuse:
                color = tuple(diffuse.inputs['Color'].default_value)
        if material.name == 'Tires':
            color = (0.025, 0.028, 0.03, 1)
            textured = False
        m, bsdf = principled('mi17_material_' + str(index), color,
                            0.65 if material.name in ('silver', 'Light rims', 'Material.001') else 0,
                            0.2 if glass else 0.68)
        if glass:
            bsdf.inputs['Alpha'].default_value = color[3]
            m.surface_render_method = 'DITHERED'
        elif textured:
            size = 1024 if material.name == 'matte chopper' else 256
            image = bpy.data.images.new('mi17_colour_' + str(index), width=size, height=size, alpha=False)
            image.generated_color = color
            node = image_node(material, image)
            node.select = True
            targets[material] = image
            m.node_tree.links.new(image_node(m, image).outputs['Color'], bsdf.inputs['Base Color'])
        replacements[material] = m
    for o in meshes:
        if not o.data.uv_layers or not any(m in targets for m in o.data.materials):
            continue
        bpy.ops.object.select_all(action='DESELECT')
        o.hide_set(False)
        o.hide_render = False
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        # Every material slot needs a target for Blender's object bake. Flat slots
        # use a disposable target; their final material stays a compact constant.
        for m in o.data.materials:
            if m and m not in targets:
                image_node(m, bpy.data.images.new('bake_scratch', width=16, height=16))
        bpy.ops.object.bake(type='DIFFUSE')
    for o in meshes:
        for slot in o.material_slots:
            if slot.material:
                # Several source objects share mesh data and therefore slots.
                if slot.material in replacements:
                    slot.material = replacements[slot.material]
                else:
                    assert slot.material in replacements.values()


def convert(kind):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    relative, expected = (
        ('cessna/source/planedone.fbx.fbx', '8c37ad1283b3747773e0829d40ed948b1c0acc854444b6259947120170edeeb3')
        if kind == 'plane' else
        ('mi17/Mi-17 Helicopter.blend', '7da490069c58a5fafb7aa04584362b43e14fb654e1dd1691b8199c0772f7c980'))
    with (args.input / relative).open('rb') as source:
        assert hashlib.file_digest(source, 'sha256').hexdigest() == expected, 'Aircraft source differs from the reviewed original'
    if kind == 'plane':
        bpy.ops.import_scene.fbx(filepath=str(args.input / 'cessna/source/planedone.fbx.fbx'), use_anim=True)
    else:
        bpy.ops.wm.open_mainfile(filepath=str(args.input / 'mi17/Mi-17 Helicopter.blend'), load_ui=False, use_scripts=False)
        scene = bpy.context.scene
    scene.frame_set(1)
    excluded = {'Cube', 'Plane.129', 'Plane.130', 'Plane.131'} if kind == 'helicopter' else set()
    meshes = [o for o in bpy.data.objects if o.type == 'MESH' and o.name not in excluded]
    originals = {o: o.matrix_world.copy() for o in bpy.data.objects}
    for o in bpy.data.objects:
        o.animation_data_clear()
    if kind == 'plane':
        rebuild_plane_materials()
        scale = 11 / 12.702555656433105
        transform = Matrix.Diagonal((-scale, -scale, scale, 1))
        pivots = {'trainer_propeller': ('propelting', 1), 'trainer_elevator': ('haleror', 0), 'trainer_rudder': ('halerorvert', 2)}
        part_names = {'xtras_3': 'trainer_propeller', 'haleror_2': 'trainer_elevator', 'halerorvert_2': 'trainer_rudder'}
    else:
        # Keep the original curved body, evaluate one subdivision, then simplify
        # the result to a bounded silhouette-preserving runtime mesh.
        for o in meshes:
            for mod in o.modifiers:
                if mod.type == 'SUBSURF':
                    mod.levels = 1 if o.name == 'Chopper' else 0
                    mod.render_levels = mod.levels
        bake_heli_materials(meshes)
        scale = 21.3 / 49.554195404052734
        hub = originals[bpy.data.objects['Propellor Controller']].translation
        transform = Matrix.Rotation(math.pi / 2, 4, 'Z') @ Matrix.Diagonal((scale, scale, scale, 1)) @ Matrix.Translation((-hub.x, -hub.y, 0))
        pivots = {'helicopter_rotor_main': ('Propellor Controller', 2), 'helicopter_rotor_tail': ('Rear Propellor Controller', 0)}
        part_names = {'Blades': 'helicopter_rotor_main', 'Circle.005': 'helicopter_rotor_tail', 'Circle.006': 'helicopter_rotor_tail'}
    deps = bpy.context.evaluated_depsgraph_get()
    converted = []
    for index, original in enumerate(meshes):
        evaluated = original.evaluated_get(deps)
        mesh = bpy.data.meshes.new_from_object(evaluated, preserve_all_data_layers=True, depsgraph=deps)
        mesh.transform(transform @ originals[original])
        if not mesh.uv_layers:
            # Procedural source details have no UVs. Keep them constant-colour
            # rather than exporting a texture binding without TEXCOORD_0.
            for slot_index, material in enumerate(mesh.materials):
                if material and material.use_nodes:
                    bsdf = material.node_tree.nodes.get('Principled BSDF')
                    if bsdf and bsdf.inputs['Base Color'].is_linked:
                        flat, _ = principled('mi17_unmapped_' + str(index) + '_' + str(slot_index), (0.2, 0.23, 0.14, 1))
                        mesh.materials[slot_index] = flat
        obj = bpy.data.objects.new(kind + '_part_' + str(index), mesh)
        scene.collection.objects.link(obj)
        # Thin main blades lose their tips under generic edge collapse. Preserve
        # their source geometry; the fuselage/detail savings fund the rotor.
        target = (24000 if original.name == 'Chopper' else 13000 if original.name == 'Blades' else 3400 if original.name == 'Circle.005' else 800) if kind == 'helicopter' else 30000
        triangles = sum(len(p.vertices) - 2 for p in mesh.polygons)
        if triangles > target:
            mod = obj.modifiers.new('web_silhouette', 'DECIMATE')
            mod.ratio = target / triangles
            deps.update()
            simplified = bpy.data.meshes.new_from_object(obj.evaluated_get(deps), preserve_all_data_layers=True, depsgraph=deps)
            obj.modifiers.clear()
            obj.data = simplified
        converted.append((original.name, obj))
    # Derive ground from the actual exported vertices, excluding authoring controls.
    ground = min(v.co.z for _, o in converted for v in o.data.vertices)
    rig = {}
    for name, (source, axis) in pivots.items():
        loc = transform @ originals[bpy.data.objects[source]].translation
        loc.z -= ground
        rig[name] = empty(name, loc)
    for original_name, o in converted:
        for v in o.data.vertices:
            v.co.z -= ground
        pivot = rig.get(part_names.get(original_name))
        if pivot:
            o.data.transform(Matrix.Translation(-pivot.location))
            if original_name == 'Blades':
                radius = max(math.hypot(v.co.x, v.co.y) for v in o.data.vertices)
                o.data.transform(Matrix.Diagonal((10.65 / radius, 10.65 / radius, 1, 1)))
            o.parent = pivot
            o.location = (0, 0, 0)
    # Export only our clean geometry and normalized pivots. Source cameras,
    # foliage cards, wire controls, user properties and original actions stay out.
    keep = {o for _, o in converted} | set(rig.values())
    for o in list(bpy.data.objects):
        if o not in keep:
            bpy.data.objects.remove(o, do_unlink=True)
    for name, (_, axis) in pivots.items():
        if 'propeller' in name or 'rotor' in name:
            spin(rig[name], axis)
    scene.frame_start = 1
    scene.frame_end = 33
    scene.render.fps = 32
    scene.frame_set(1)
    bpy.ops.object.select_all(action='DESELECT')
    for o in keep:
        o.select_set(True)
    destination = args.output / ('trainer.glb' if kind == 'plane' else 'helicopter.glb')
    bpy.ops.export_scene.gltf(filepath=str(destination), export_format='GLB', use_selection=True,
      export_yup=True, export_animations=True, export_animation_mode='NLA_TRACKS',
      export_force_sampling=True, export_frame_range=True, export_extras=False,
      export_image_format='AUTO', export_cameras=False, export_lights=False)
    points = [v.co + (o.parent.location if o.parent else Vector()) for _, o in converted for v in o.data.vertices]
    receipt = dict(blender=bpy.app.version_string, sourceSha256=expected, triangles=sum(sum(len(p.vertices)-2 for p in o.data.polygons) for _,o in converted),
      boundsBlender={'min':[min(v[i] for v in points) for i in range(3)],'max':[max(v[i] for v in points) for i in range(3)]},
      pivotsBlender={name:list(o.location) for name,o in rig.items()},
      changes='Normalized metres and pivots; rebuilt PBR materials; baked legacy helicopter colours; simplified evaluated helicopter geometry; omitted authoring-only geometry; downscaled textures; supplied mechanical spin loop.')
    (args.output / (kind + '-conversion.json')).write_text(json.dumps(receipt, indent=2))
    print('CONVERTED', kind, receipt['triangles'], flush=True)


for kind in ['plane', 'helicopter']:
    convert(kind)
