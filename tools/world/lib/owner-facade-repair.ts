// Frozen atlas owners survive append merges independently of cell IDs and image names.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Document, Node } from '@gltf-transform/core';
import { readFacadeGlb, replaceFacadeImages } from './facade-glb.ts';
import { remapUv, type Placement } from './atlas.ts';
import type { RgbaImage } from './gltf.ts';

export const facadeSha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export type PixelRectangle = readonly [number, number, number, number];
export interface SourceFacadePart { texture: number | null; positions: Float32Array; uvs: Float32Array; indices: Uint32Array }
export interface FacadeImageBinding {
  nodeName: string; nodeIndex: number; meshIndex: number; materialIndex: number; textureIndex: number;
  imageIndex: number; imageName?: string; sha256: string; bytes: Uint8Array;
}

export function facadeImageBinding(bytes: Uint8Array, nodeName: string): FacadeImageBinding {
  const { json, bin } = readFacadeGlb(bytes), nodes = json['nodes'] as { name?: string; mesh?: number; children?: number[] }[];
  const matches = nodes.map((node, index) => ({ node, index })).filter(n => n.node.name === nodeName);
  assert.equal(matches.length, 1, `facade node name must resolve uniquely: ${nodeName}`);
  const { node, index } = matches[0]!, active = new Set<number>();
  const visit = (i: number) => { if (active.has(i)) return; active.add(i); for (const c of nodes[i]?.children ?? []) visit(c); };
  for (const scene of json['scenes'] as { nodes?: number[] }[]) for (const i of scene.nodes ?? []) visit(i);
  assert.ok(active.has(index), `${nodeName}: facade node is not in a scene`);
  assert.ok(node.mesh !== undefined, `${nodeName}: no mesh`);
  const mesh = (json['meshes'] as { primitives: { material?: number }[] }[])[node.mesh]!;
  assert.equal(mesh.primitives.length, 1, `${nodeName}: expected one atlas primitive`);
  const materialIndex = mesh.primitives[0]!.material;
  assert.ok(materialIndex !== undefined, `${nodeName}: no material`);
  const material = (json['materials'] as { pbrMetallicRoughness?: { baseColorTexture?: { index: number; texCoord?: number } } }[])[materialIndex];
  const textureRef = material?.pbrMetallicRoughness?.baseColorTexture;
  assert.ok(textureRef && (textureRef.texCoord ?? 0) === 0, `${nodeName}: expected TEXCOORD_0 base colour`);
  const textureIndex = textureRef.index;
  const texture = (json['textures'] as { source?: number; extensions?: { KHR_texture_basisu?: { source: number } } }[])[textureIndex];
  const imageIndex = texture?.extensions?.KHR_texture_basisu?.source ?? texture?.source;
  assert.ok(imageIndex !== undefined, `${nodeName}: no numeric image source`);
  const image = json.images?.[imageIndex], view = image?.bufferView === undefined ? undefined : json.bufferViews[image.bufferView];
  assert.ok(view?.buffer === 0, `${nodeName}: expected embedded physical image`);
  const imageBytes = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
  return { nodeName, nodeIndex: index, meshIndex: node.mesh, materialIndex, textureIndex, imageIndex, imageName: image?.name, sha256: facadeSha(imageBytes), bytes: imageBytes };
}

export function facadeGeometrySha(node: Node): string {
  const hash = createHash('sha256'); hash.update(JSON.stringify(node.getWorldMatrix()));
  assert.ok(node.getMesh(), 'facade mesh absent');
  for (const primitive of node.getMesh()!.listPrimitives()) {
    hash.update(JSON.stringify({ mode: primitive.getMode(), targets: primitive.listTargets().length }));
    assert.equal(primitive.listTargets().length, 0, 'morphed city facade unsupported');
    for (const semantic of [...primitive.listSemantics().sort(), 'indices']) {
      const accessor = semantic === 'indices' ? primitive.getIndices() : primitive.getAttribute(semantic);
      assert.ok(accessor, `facade ${semantic} absent`); const array = accessor.getArray(); assert.ok(array);
      hash.update(JSON.stringify([semantic, accessor.getType(), accessor.getComponentType(), accessor.getNormalized()]));
      hash.update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
    }
  }
  return hash.digest('hex');
}

export function matchOwnerFacade(ownerBytes: Uint8Array, ownerDoc: Document, finalBytes: Uint8Array, finalDoc: Document, ownerNodeName: string, expectedImageSha256: string) {
  const ownerNodes = ownerDoc.getRoot().listNodes().filter(n => n.getName() === ownerNodeName);
  assert.equal(ownerNodes.length, 1, 'owner facade node must be unique');
  const owner = ownerNodes[0]!, binding = facadeImageBinding(ownerBytes, ownerNodeName);
  assert.equal(binding.sha256, expectedImageSha256, 'pinned owner image differs');
  const geometrySha256 = facadeGeometrySha(owner);
  const matches = finalDoc.getRoot().listNodes().filter(n => n.getMesh() && (n.getName() === ownerNodeName || n.getName().endsWith(`:${ownerNodeName}`)) && facadeGeometrySha(n) === geometrySha256)
    .map(node => ({ node, binding: facadeImageBinding(finalBytes, node.getName()) }))
    .filter(m => m.binding.sha256 === expectedImageSha256);
  assert.equal(matches.length, 1, 'final facade owner geometry/image correspondence must be unique');
  return { owner, ownerBinding: binding, finalNode: matches[0]!.node, finalBinding: matches[0]!.binding, geometrySha256 };
}

/** Verify source corners against the frozen decoded geometry. Quantized UV precision is explicit. */
export function verifyFacadeSourceCorners(node: Node, parts: readonly SourceFacadePart[], placements: ReadonlyMap<string, Placement>, atlasIndex: number, dimensions: readonly [number, number]) {
  const vertices = new Map<string, { p: number[]; uv: number[] }[]>(), matrix = node.getWorldMatrix();
  for (const primitive of node.getMesh()!.listPrimitives()) {
    const positions = primitive.getAttribute('POSITION'), uv = primitive.getAttribute('TEXCOORD_0'); assert.ok(positions && uv);
    for (let i = 0; i < positions.getCount(); i++) {
      const p = positions.getElement(i, []), world = [0, 1, 2].map(k => matrix[k]! * p[0]! + matrix[4 + k]! * p[1]! + matrix[8 + k]! * p[2]! + matrix[12 + k]!);
      const key = world.map(v => Math.floor(v / .05)).join(','), entries = vertices.get(key) ?? [];
      entries.push({ p: world, uv: uv.getElement(i, []) }); vertices.set(key, entries);
    }
  }
  let corners = 0, maxPositionMetres = 0, maxUv = 0;
  for (const part of parts) {
    if (part.texture === null) continue;
    const placement = placements.get(`t${part.texture}`); assert.ok(placement, 'source page absent from layout');
    if (placement.atlas !== atlasIndex) continue;
    for (const i of new Set(part.indices)) {
      const p = [...part.positions.subarray(i * 3, i * 3 + 3)], expected = remapUv(placement, ...dimensions, part.uvs[i * 2]!, part.uvs[i * 2 + 1]!);
      let best: { position: number; uv: number } | undefined;
      for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
        const key = [Math.floor(p[0]! / .05) + x, Math.floor(p[1]! / .05) + y, Math.floor(p[2]! / .05) + z].join(',');
        for (const v of vertices.get(key) ?? []) {
          const position = Math.hypot(...v.p.map((n, k) => n - p[k]!)), error = Math.max(...v.uv.map((n, k) => Math.abs(n - expected[k]!)));
          if (position < .03 && error < .0006 && (!best || position < best.position || (position === best.position && error < best.uv))) best = { position, uv: error };
        }
      }
      assert.ok(best, `source corner/UV mismatch: page${part.texture} vertex${i}`);
      corners++; maxPositionMetres = Math.max(maxPositionMetres, best.position); maxUv = Math.max(maxUv, best.uv);
    }
  }
  assert.ok(corners > 0, 'no source corner checks');
  return { corners, maxPositionMetres, maxUv, tolerances: { positionMetres: .03, uv: .0006 } };
}

/** Rectangles are half-open, in the actual capped page/atlas pixels. Alpha is always protected. */
export function proveSelectedPixelChanges(before: RgbaImage, after: RgbaImage, allowed: readonly PixelRectangle[]) {
  assert.equal(after.width, before.width); assert.equal(after.height, before.height); assert.equal(after.data.length, before.data.length);
  for (const r of allowed) assert.ok(r.length === 4 && r.every(Number.isSafeInteger) && r[0] >= 0 && r[1] >= 0 && r[2] <= before.width && r[3] <= before.height && r[2] > r[0] && r[3] > r[1], 'invalid selected pixel rectangle');
  let changedPixels = 0; const bounds = [before.width, before.height, 0, 0];
  for (let i = 0; i < before.data.length; i += 4) {
    assert.equal(after.data[i + 3], before.data[i + 3], 'facade alpha changed');
    if ([0, 1, 2].every(c => before.data[i + c] === after.data[i + c])) continue;
    const x = (i / 4) % before.width, y = Math.floor(i / 4 / before.width);
    assert.ok(allowed.some(r => x >= r[0] && x < r[2] && y >= r[1] && y < r[3]), `pixel outside selected regions changed: ${x},${y}`);
    changedPixels++; bounds[0] = Math.min(bounds[0]!, x); bounds[1] = Math.min(bounds[1]!, y); bounds[2] = Math.max(bounds[2]!, x + 1); bounds[3] = Math.max(bounds[3]!, y + 1);
  }
  return { changedPixels, bounds: changedPixels ? bounds : null, beforeRgbaSha256: facadeSha(before.data), afterRgbaSha256: facadeSha(after.data), alphaExact: true };
}

export function replaceBoundOwnerImages(bytes: Uint8Array, replacements: readonly { binding: FacadeImageBinding; originalEncoded: Uint8Array; replacement: Uint8Array }[]) {
  const byIndex = new Map<number, Uint8Array>();
  for (const r of replacements) {
    const actual = facadeImageBinding(bytes, r.binding.nodeName);
    assert.deepEqual({ ...actual, bytes: undefined }, { ...r.binding, bytes: undefined }, 'final image binding changed');
    assert.equal(facadeSha(r.originalEncoded), actual.sha256, 'baseline atlas negative control failed');
    assert.ok(!byIndex.has(actual.imageIndex), 'duplicate image replacement'); byIndex.set(actual.imageIndex, r.replacement);
  }
  const out = replaceFacadeImages(bytes, byIndex), before = readFacadeGlb(bytes), after = readFacadeGlb(out);
  for (let i = 0; i < (before.json.images?.length ?? 0); i++) if (!byIndex.has(i)) {
    const a = before.json.bufferViews[before.json.images![i]!.bufferView!]!, b = after.json.bufferViews[after.json.images![i]!.bufferView!]!;
    assert.deepEqual(after.bin.subarray(b.byteOffset ?? 0, (b.byteOffset ?? 0) + b.byteLength), before.bin.subarray(a.byteOffset ?? 0, (a.byteOffset ?? 0) + a.byteLength), `unrelated image${i} changed`);
  }
  return out;
}

export function facadeAtlasCacheKey(image: RgbaImage, encoderIdentity: string) { return facadeSha(JSON.stringify([image.width, image.height, facadeSha(image.data), encoderIdentity])); }

/** The only index changes allowed for image replacement are LOD0 file length and content hash. */
export function proveFacadeIndexPreservation(original: { cells: any[] }, candidate: { cells: any[] }, changedCells: ReadonlySet<string>) {
  const restored = structuredClone(candidate);
  for (const id of changedCells) {
    const before = original.cells.filter(c => c.id === id), after = restored.cells.filter(c => c.id === id);
    assert.equal(before.length, 1, 'changed cell absent/duplicated in original index'); assert.equal(after.length, 1, 'changed cell absent/duplicated in candidate index');
    after[0].visual.lod0.bytes = before[0].visual.lod0.bytes; after[0].visual.lod0.sha256 = before[0].visual.lod0.sha256;
  }
  assert.deepEqual(restored, original, 'facade repair changed protected index metadata or derived tiers');
  return { cells: original.cells.length, changedLod0Files: changedCells.size, protectedIndexSemanticsExact: true };
}

/** An output hardlink is never opened for writing: changed files are created separately. */
export function cloneFacadeCandidate(base: string, out: string, changed: ReadonlyMap<string, Uint8Array>) {
  const root = path.resolve(base), target = path.resolve(out);
  assert.ok(!fs.existsSync(target), 'facade output must be fresh');
  assert.ok(!target.startsWith(root + path.sep), 'facade output cannot be inside source');
  for (const relative of changed.keys()) {
    const resolved = path.resolve(root, relative), local = path.relative(root, resolved);
    assert.ok(local && !path.isAbsolute(local) && local !== '..' && !local.startsWith(`..${path.sep}`), 'replacement path escapes source');
    assert.ok(fs.statSync(resolved).isFile(), 'replacement source must exist');
  }
  const inventory: { path: string; beforeSha256: string; afterSha256: string; byteExact: boolean }[] = [];
  const visit = (directory: string) => {
    fs.mkdirSync(path.join(target, directory), { recursive: true });
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const relative = path.join(directory, entry.name), source = path.join(root, relative), destination = path.join(target, relative);
      assert.ok(!entry.isSymbolicLink(), 'symlinks unsupported in frozen facade candidate');
      if (entry.isDirectory()) { visit(relative); continue; }
      assert.ok(entry.isFile(), 'non-file payload unsupported');
      const replacement = changed.get(relative) ?? changed.get(relative.split(path.sep).join('/'));
      if (replacement) fs.writeFileSync(destination, replacement, { flag: 'wx' }); else fs.linkSync(source, destination);
      const before = facadeSha(fs.readFileSync(source)), after = facadeSha(fs.readFileSync(destination));
      if (!replacement) assert.equal(after, before);
      inventory.push({ path: relative.split(path.sep).join('/'), beforeSha256: before, afterSha256: after, byteExact: before === after });
    }
  };
  visit(''); return inventory;
}
