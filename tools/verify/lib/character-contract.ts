import type { Document, Node, Texture } from '@gltf-transform/core';
import sharp from 'sharp';
import { transformPoint } from '../glb.ts';

export interface AssetCheck { id: string; pass: boolean; detail: string }
export interface CharacterBudget {
  triangles: number; materials: number; fileBytes: number; textureMaxSize: number;
  textureMaxSizeByUsage?: { baseColor: number; other: number };
}
export interface CharacterContract {
  fps: number;
  feetAtOrigin: boolean;
  heightMeters: { min: number; max: number };
  skeleton: { root: string; joints: string[]; parents: Record<string, string>; maxJoints: number; maxInfluencesPerVertex: number };
  sockets: { node: string; parentJoint: string }[];
  clips: { name: string; seconds: number; movementSpeed: number }[];
  clipDurationToleranceSeconds?: number;
  allowAdditionalClips?: boolean;
  requiredMeshNodes?: string[];
  budgets: Partial<Record<'player' | 'npc', CharacterBudget>>;
  variants?: { id: string; role: string; contract?: string }[];
}

/** Actual POSITION samples from every reachable skinned mesh, including all primitives and transforms. */
export function skinnedBounds(document: Document): { min: number[]; max: number[]; meshes: number; vertices: number } {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const reached = new Set<Node>();
  const root = document.getRoot(), defaultScene = root.getDefaultScene();
  (defaultScene ? [defaultScene] : root.listScenes()).forEach(scene => scene.traverse(node => reached.add(node)));
  let meshes = 0, vertices = 0;
  for (const node of reached) {
    const mesh = node.getMesh();
    if (!mesh || !node.getSkin()) continue;
    meshes++;
    const matrix = node.getWorldMatrix(), position: number[] = [];
    for (const primitive of mesh.listPrimitives()) {
      const accessor = primitive.getAttribute('POSITION');
      if (!accessor) throw new Error(`Skinned mesh ${node.getName()} has no POSITION`);
      for (let i = 0; i < accessor.getCount(); i++) {
        const point = transformPoint(matrix, accessor.getElement(i, position));
        for (let axis = 0; axis < 3; axis++) {
          min[axis] = Math.min(min[axis]!, point[axis]!);
          max[axis] = Math.max(max[axis]!, point[axis]!);
        }
        vertices++;
      }
    }
  }
  return { min, max, meshes, vertices };
}

/** KTX2 dimensions come from its header; no GPU transcoding or Blender image support is needed. */
export async function imageDimensions(image: Uint8Array): Promise<{ width: number; height: number; format: string }> {
  const ktx2 = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
  if (ktx2.every((byte, i) => image[i] === byte)) {
    if (image.byteLength < 80) throw new Error('Truncated KTX2 header');
    const header = new DataView(image.buffer, image.byteOffset, image.byteLength);
    const width = header.getUint32(20, true), height = header.getUint32(24, true);
    if (!width || !height || header.getUint32(28, true) > 1 || header.getUint32(32, true) > 1 || header.getUint32(36, true) !== 1) throw new Error('Character KTX2 must be a nonempty 2D texture');
    return { width, height, format: 'ktx2' };
  }
  const metadata = await sharp(image).metadata();
  if (!metadata.width || !metadata.height) throw new Error('Image has no dimensions');
  return { width: metadata.width, height: metadata.height, format: metadata.format ?? 'unknown' };
}

export async function checkCharacter(document: Document, contract: CharacterContract, role: string, bytes: number): Promise<AssetCheck[]> {
  const checks: AssetCheck[] = [];
  const check = (id: string, pass: boolean, detail: string) => checks.push({ id, pass, detail });
  const root = document.getRoot(), nodes = root.listNodes();
  const budget = contract.budgets[role === 'player' ? 'player' : 'npc'];
  if (!budget) throw new Error(`Character contract has no ${role} budget`);
  let triangles = 0;
  for (const node of nodes) for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
    if (primitive.getMode() !== 4) throw new Error(`Character ${node.getName()} has a non-triangle primitive`);
    triangles += (primitive.getIndices() ?? primitive.getAttribute('POSITION'))!.getCount() / 3;
  }
  check('triangles', Number.isInteger(triangles) && triangles <= budget.triangles, `${triangles} (budget ${budget.triangles})`);
  check('materials', root.listMaterials().length <= budget.materials, `${root.listMaterials().length} (budget ${budget.materials})`);
  check('bytes', bytes <= budget.fileBytes, `${bytes} (budget ${budget.fileBytes})`);
  const skins = root.listSkins();
  const skeletonProblems: string[] = [];
  if (!skins.length) skeletonProblems.push('no skin');
  for (const skin of skins) {
    const names = skin.listJoints().map(joint => joint.getName());
    const missing = contract.skeleton.joints.filter(name => !names.includes(name));
    if (missing.length) skeletonProblems.push(`missing ${missing.join(', ')}`);
    if (new Set(names).size !== names.length) skeletonProblems.push('duplicate joint names');
    if (names.length > contract.skeleton.maxJoints) skeletonProblems.push(`${names.length} joints exceeds ${contract.skeleton.maxJoints}`);
  }
  check('skeleton', !skeletonProblems.length, skeletonProblems.join('; ') || `${skins.length} skin(s), ${skins.map(s => s.listJoints().length).join(', ')} joints`);
  const parentProblems: string[] = [];
  for (const [name, expected] of Object.entries(contract.skeleton.parents)) {
    const matches = nodes.filter(node => node.getName() === name);
    if (matches.length !== 1 || matches[0]?.getParentNode()?.getName() !== expected) parentProblems.push(`${name}: expected parent ${expected}, got ${matches.length === 1 ? matches[0]!.getParentNode()?.getName() ?? 'none' : `${matches.length} nodes`}`);
  }
  check('joint-parents', !parentProblems.length, parentProblems.join('; ') || `${Object.keys(contract.skeleton.parents).length} explicit parents match`);
  for (const socket of contract.sockets) {
    const matches = nodes.filter(node => node.getName() === socket.node);
    const parentName = matches.length === 1 ? matches[0]!.getParentNode()?.getName() : undefined;
    check(socket.node, matches.length === 1 && parentName === socket.parentJoint, `${matches.length} node(s); parent ${parentName ?? 'none'}, expected ${socket.parentJoint}`);
  }
  if (contract.requiredMeshNodes) {
    const meshNames = nodes.filter(node => node.getMesh() && node.getSkin()).map(node => node.getName());
    const missing = contract.requiredMeshNodes.filter(name => !meshNames.includes(name));
    check('mesh-nodes', !missing.length, missing.length ? `missing ${missing.join(', ')}` : `${contract.requiredMeshNodes.length} required skinned mesh nodes present`);
  }
  const bounds = skinnedBounds(document), height = bounds.max[1]! - bounds.min[1]!;
  check('height', bounds.vertices > 0 && Number.isFinite(height) && height >= contract.heightMeters.min && height <= contract.heightMeters.max && (!contract.feetAtOrigin || Math.abs(bounds.min[1]!) < 0.02), `${height.toFixed(4)} m tall, feet at y=${bounds.min[1]!.toFixed(4)}; ${bounds.meshes} skinned meshes, ${bounds.vertices} POSITION samples`);

  let vertices = 0, maxInfluences = 0, invalidVertices = 0;
  const weightProblems: string[] = [];
  for (const node of nodes) {
    const skin = node.getSkin();
    if (!skin) continue;
    const jointCount = skin.listJoints().length;
    for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
      const count = primitive.getAttribute('POSITION')?.getCount() ?? 0;
      const semantics = primitive.listSemantics();
      const sets = [...new Set(semantics.filter(s => /^(JOINTS|WEIGHTS)_\d+$/.test(s)).map(s => Number(s.split('_')[1])))].sort((a, b) => a - b);
      if (!sets.includes(0)) { weightProblems.push(`${node.getName()}: missing weight set 0`); continue; }
      const pairs = sets.map(set => ({ weights: primitive.getAttribute(`WEIGHTS_${set}`), joints: primitive.getAttribute(`JOINTS_${set}`) }));
      if (pairs.some(p => !p.weights || !p.joints || p.weights.getElementSize() !== 4 || p.joints.getElementSize() !== 4 || p.weights.getCount() !== count || p.joints.getCount() !== count)) {
        weightProblems.push(`${node.getName()}: malformed joint/weight accessors`); continue;
      }
      const weights: number[] = [], joints: number[] = [];
      for (let i = 0; i < count; i++) {
        let influences = 0, sum = 0, invalid = false;
        for (const pair of pairs) {
          pair.weights!.getElement(i, weights); pair.joints!.getElement(i, joints);
          for (let component = 0; component < 4; component++) {
            const weight = weights[component]!, joint = joints[component]!;
            if (!Number.isFinite(weight) || weight < 0 || weight > 1 || !Number.isInteger(joint) || joint < 0 || joint >= jointCount) invalid = true;
            if (weight > 0) influences++;
            sum += weight;
          }
        }
        maxInfluences = Math.max(maxInfluences, influences);
        if (invalid || Math.abs(sum - 1) > 1e-3 || influences > contract.skeleton.maxInfluencesPerVertex) invalidVertices++;
        vertices++;
      }
    }
  }
  check('skin-weights', !weightProblems.length && vertices > 0 && invalidVertices === 0, `${vertices} vertices, max ${maxInfluences} active weights (limit ${contract.skeleton.maxInfluencesPerVertex}), ${invalidVertices} invalid; ${weightProblems.join('; ')}`);

  const animations = root.listAnimations(), clipNames = animations.map(clip => clip.getName());
  const missing = contract.clips.filter(clip => !clipNames.includes(clip.name)).map(clip => clip.name);
  const extra = contract.allowAdditionalClips === false ? clipNames.filter(name => !contract.clips.some(clip => clip.name === name)) : [];
  check('clips', !missing.length && !extra.length && new Set(clipNames).size === clipNames.length, `missing [${missing.join(', ')}], extra [${extra.join(', ')}]; ${clipNames.join(', ')}`);
  const tolerance = contract.clipDurationToleranceSeconds ?? 1 / contract.fps + 1e-6;
  for (const expected of contract.clips) {
    const animation = animations.find(clip => clip.getName() === expected.name);
    let start = Infinity, end = -Infinity;
    for (const sampler of animation?.listSamplers() ?? []) {
      const input = sampler.getInput();
      for (let i = 0; input && i < input.getCount(); i++) { const t = input.getScalar(i); start = Math.min(start, t); end = Math.max(end, t); }
    }
    const validRange = Number.isFinite(start) && Number.isFinite(end);
    check(`clip-duration:${expected.name}`, validRange && Math.abs(start) <= tolerance && Math.abs(end - start - expected.seconds) <= tolerance, validRange ? `${end - start}s starting at ${start}s, expected ${expected.seconds}s +/- ${tolerance}s` : 'missing animation or input samples');
  }

  const baseColor = new Set<Texture>(), other = new Set<Texture>();
  for (const material of root.listMaterials()) {
    const base = material.getBaseColorTexture(); if (base) baseColor.add(base);
    for (const texture of [material.getNormalTexture(), material.getMetallicRoughnessTexture(), material.getOcclusionTexture(), material.getEmissiveTexture()]) if (texture) other.add(texture);
  }
  for (const [index, texture] of root.listTextures().entries()) {
    const use = baseColor.has(texture) && !other.has(texture) ? 'baseColor' : 'other';
    const limit = budget.textureMaxSizeByUsage?.[use] ?? budget.textureMaxSize;
    try {
      const image = texture.getImage(); if (!image) throw new Error('Image bytes missing');
      const size = await imageDimensions(image);
      check(`texture:${index}`, size.width <= limit && size.height <= limit, `${texture.getName() || index}: ${size.width}x${size.height} ${size.format}, ${use} limit ${limit}`);
    } catch (error) { check(`texture:${index}`, false, error instanceof Error ? error.message : String(error)); }
  }
  return checks;
}
