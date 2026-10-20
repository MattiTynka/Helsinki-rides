// Append the new original entrance materials without reserializing any accepted city resource.
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {createHash} from 'node:crypto';
import {readFacadeGlb} from './facade-glb.ts';
import {packGlb} from './shared-textures.ts';
import {flatNormals} from './gltf.ts';
import type {GroundPiece} from './ground.ts';

export interface EntranceTexture {path: string; bytes: Uint8Array; sha256: string}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** Original seeded grey granite. Treads have no grid; wall joints form horizontal courses. */
export async function entranceTextures(): Promise<EntranceTexture[]> {
  const result: EntranceTexture[] = [];
  for (const coursed of [false, true]) {
    const size = 256, pixels = new Uint8Array(size * size * 4); let seed = 20261020;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      seed = Math.imul(seed ^ seed >>> 15, 2246822519); seed = Math.imul(seed ^ seed >>> 13, 3266489917); seed ^= seed >>> 16;
      const grain = (seed >>> 0) / 4294967296 * 9 - 4.5;
      const row = Math.floor(y / 64), u = (x + (row % 2) * 64) % 128;
      const joint = coursed && (y % 64 < 2 || u < 2) ? -19 : 0;
      const i = (y * size + x) * 4;
      pixels[i] = 151 + grain + joint; pixels[i + 1] = 148 + grain + joint; pixels[i + 2] = 140 + grain + joint; pixels[i + 3] = 255;
    }
    const bytes = new Uint8Array(await sharp(pixels, {raw: {width: size, height: size, channels: 4}}).png({compressionLevel: 9}).toBuffer());
    const sha256 = hash(bytes); result.push({path: `textures/${sha256}.png`, bytes, sha256});
  }
  return result;
}

/** The original JSON resource arrays and physical BIN remain literal prefixes. New near geometry
 * uses flat face normals and local face UVs; all existing images, materials and meshes stay exact. */
export function appendEntranceGlb(input: Uint8Array, pieces: readonly GroundPiece[], textures: readonly EntranceTexture[]): Uint8Array {
  if (!pieces.length) return input.slice();
  assert.equal(textures.length, 2);
  const original = readFacadeGlb(input), json = structuredClone(original.json) as any;
  const chunks: Uint8Array[] = [original.bin]; let length = original.bin.length;
  const align = () => {const pad = (4 - length % 4) % 4; if (pad) {chunks.push(new Uint8Array(pad)); length += pad;}};
  json.materials ??= []; json.images ??= []; json.textures ??= []; json.samplers ??= []; json.accessors ??= []; json.bufferViews ??= [];
  const sampler = json.samplers.length; json.samplers.push({magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497});
  const materialIds = new Map<string, number>();
  for (const [i, name] of ['granite', 'coursed-granite'].entries()) {
    const image = json.images.length; json.images.push({name: `Original Senate entrance ${name}`, uri: `../${textures[i]!.path}`, mimeType: 'image/png'});
    const texture = json.textures.length; json.textures.push({source: image, sampler});
    materialIds.set(name, json.materials.length); json.materials.push({name: `Original Senate entrance ${name}`, pbrMetallicRoughness: {baseColorTexture: {index: texture}, metallicFactor: 0, roughnessFactor: .96}});
  }
  materialIds.set('iron', json.materials.length); json.materials.push({name: 'Original Senate entrance wrought iron', pbrMetallicRoughness: {baseColorFactor: [.018, .022, .025, 1], metallicFactor: .45, roughnessFactor: .5}});
  const groups = new Map<string, GroundPiece[]>();
  for (const piece of pieces) {
    let style = /iron|grille|lamp/.test(piece.tag) ? 'iron' : /cheek|plinth|retaining/.test(piece.tag) ? 'coursed-granite' : 'granite';
    if (piece.tag.endsWith('apron')) {
      const expected = piece.tag.includes('university') ? '_ground_asphalt' : '_ground_slabs';
      const existing = json.materials.findIndex((m: any) => m.name?.endsWith(expected));
      assert.ok(existing >= 0, `Missing existing apron material ${expected}`); style = `existing-${existing}`; materialIds.set(style, existing);
    }
    if (piece.tag === 'entrance:palace-road') {
      const existing = json.materials.findIndex((m: any) => m.name === 'original-granite-paving');
      assert.ok(existing >= 0, 'Missing original granite carriageway material'); style = `existing-${existing}`; materialIds.set(style, existing);
    }
    const group = groups.get(style) ?? []; group.push(piece); groups.set(style, group);
  }
  function accessor(array: Float32Array | Uint32Array, type: string, target: number) {
    align(); const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength), view = json.bufferViews.length;
    json.bufferViews.push({buffer: 0, byteOffset: length, byteLength: bytes.length, target}); chunks.push(bytes); length += bytes.length;
    const components = type === 'VEC3' ? 3 : type === 'VEC2' ? 2 : 1, item: any = {bufferView: view, componentType: array instanceof Float32Array ? 5126 : 5125, count: array.length / components, type};
    if (target === 34962 && type === 'VEC3') {
      item.min = Array(components).fill(Infinity); item.max = Array(components).fill(-Infinity);
      array.forEach((value, i) => {item.min[i % components] = Math.min(item.min[i % components], value); item.max[i % components] = Math.max(item.max[i % components], value);});
    }
    const id = json.accessors.length; json.accessors.push(item); return id;
  }
  for (const [style, group] of groups) {
    const pos: number[] = [], uv: number[] = [], indices: number[] = [];
    for (const piece of group) for (const id of piece.indices) {
      indices.push(pos.length / 3); pos.push(...piece.positions.slice(id * 3, id * 3 + 3)); uv.push(...piece.uvs.slice(id * 2, id * 2 + 2));
    }
    const p = Float32Array.from(pos), ix = Uint32Array.from(indices), normal = flatNormals(p, ix);
    const primitive = {attributes: {POSITION: accessor(p, 'VEC3', 34962), NORMAL: accessor(normal, 'VEC3', 34962), TEXCOORD_0: accessor(Float32Array.from(uv), 'VEC2', 34962)}, indices: accessor(ix, 'SCALAR', 34963), material: materialIds.get(style), mode: 4};
    const cell = group[0]!.cell, name = `${cell}_ground_senate_entrance_${style}`, mesh = json.meshes.length;
    json.meshes.push({name, primitives: [primitive]}); const node = json.nodes.length; json.nodes.push({name, mesh}); json.scenes[json.scene ?? 0].nodes.push(node);
  }
  align(); json.buffers[0].byteLength = length;
  const bin = Buffer.concat(chunks); assert.equal(bin.length, length); assert.deepEqual(bin.subarray(0, original.bin.length), original.bin);
  for (const resource of ['meshes', 'nodes', 'materials', 'images', 'textures', 'samplers', 'accessors', 'bufferViews']) assert.deepEqual(json[resource].slice(0, (original.json[resource] as unknown[] | undefined)?.length ?? 0), original.json[resource] ?? [], `${resource} prefix changed`);
  return packGlb(json, bin);
}
