/** Index-only civilian reduction: retained vertices keep exact skin weights and UVs. */
import assert from 'node:assert/strict';
import { MeshoptSimplifier } from 'meshoptimizer';
import { readFacadeGlb } from '../world/lib/facade-glb.ts';
import { compactGlb } from '../world/lib/compact-glb.ts';

const sizes: Record<number, number> = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 };
const components: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const aligned = (n: number) => Math.ceil(n / 4) * 4;
export async function simplifySnowCivilian(source: Uint8Array) {
  await MeshoptSimplifier.ready;
  const { json: parsed, bin } = readFacadeGlb(source), json = structuredClone(parsed) as Record<string, any>;
  assert.equal(json.buffers.length, 1); assert.ok(!json.buffers[0].uri);
  const chunks: Uint8Array[] = [bin]; let length = bin.length;
  const reports: unknown[] = [];
  function element(id: number, index: number): Uint8Array {
    const a = json.accessors[id], v = json.bufferViews[a.bufferView], size = sizes[a.componentType]! * components[a.type]!;
    assert.ok(size && !a.sparse && !v.extensions && v.buffer === 0, 'Plain original accessors required');
    const offset = (v.byteOffset ?? 0) + (a.byteOffset ?? 0) + index * (v.byteStride ?? size);
    return bin.subarray(offset, offset + size);
  }
  function floats(id: number): Float32Array {
    const a = json.accessors[id]; assert.equal(a.componentType, 5126);
    const bytes = Buffer.concat(Array.from({ length: a.count }, (_, i) => element(id, i)));
    return new Float32Array(Uint8Array.from(bytes).buffer);
  }
  function append(bytes: Uint8Array, accessor: any, target: number): number {
    const offset = aligned(length); chunks.push(new Uint8Array(offset - length), bytes, new Uint8Array(aligned(bytes.length) - bytes.length));
    length = offset + aligned(bytes.length);
    const bufferView = json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target }) - 1;
    return json.accessors.push({ ...accessor, bufferView, byteOffset: 0 }) - 1;
  }
  let total = 0;
  for (const mesh of json.meshes) for (const p of mesh.primitives) {
    assert.ok(!p.targets?.length && (p.mode ?? 4) === 4, 'Triangle meshes without morphs required');
    const a = json.accessors[p.indices], count = a.count / 3;
    const material = json.materials[p.material].name;
    if (/eyes/i.test(material)) { total += count; continue; }
    const positions = floats(p.attributes.POSITION), normals = floats(p.attributes.NORMAL), uv = floats(p.attributes.TEXCOORD_0);
    const vertexCount = json.accessors[p.attributes.POSITION].count;
    const attributes = new Float32Array(vertexCount * 5), locks = new Uint8Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) attributes.set([...normals.subarray(i * 3, i * 3 + 3), ...uv.subarray(i * 2, i * 2 + 2)], i * 5);
    // Snow's eyebrows sit very close to the forehead, and the collar to the neck.
    // Preserve these layered surfaces together so reduction cannot expose skin through either layer.
    for (let i = 0; i < vertexCount; i++) {
      const x = Math.abs(positions[i * 3]!), y = positions[i * 3 + 1]!, z = positions[i * 3 + 2]!;
      if (/skin/i.test(material) && x < .19) locks[i] = 1;
      if (/clothes/i.test(material) && y > 1.29) locks[i] = 1;
      if (/hair/i.test(material) && y < 1.7 && z > .01) locks[i] = 1;
    }
    const original = Uint32Array.from({ length: a.count }, (_, i) => {
      const b = element(p.indices, i), view = new DataView(b.buffer, b.byteOffset, b.byteLength);
      return a.componentType === 5123 ? view.getUint16(0, true) : view.getUint32(0, true);
    });
    // Regularization avoids thin slivers near bending joints. No position, UV, joint or weight is interpolated.
    const ratio = /skin/i.test(material) ? .6 : /clothes/i.test(material) ? .38 : .42;
    const limit = /skin/i.test(material) ? .006 : .01;
    const [indices, error] = MeshoptSimplifier.simplifyWithAttributes(original, positions, 3, attributes, 5,
      [.1, .1, .1, .2, .2], locks, Math.floor(count * ratio) * 3, limit, ['LockBorder', 'Regularize', 'ErrorAbsolute']);
    assert.ok(error <= limit + .000001, 'Simplification exceeded the authored error bound');
    const kept = [...new Set(indices)].sort((x, y) => x - y), remap = new Map(kept.map((v, i) => [v, i]));
    for (const [name, id] of Object.entries(p.attributes) as [string, number][]) {
      const old = json.accessors[id], bytes = Buffer.concat(kept.map(i => element(id, i)));
      const next = { ...old, count: kept.length }; delete next.min; delete next.max;
      if (name === 'POSITION') {
        next.min = [0, 1, 2].map(c => Math.min(...kept.map(i => positions[i * 3 + c]!)));
        next.max = [0, 1, 2].map(c => Math.max(...kept.map(i => positions[i * 3 + c]!)));
      }
      p.attributes[name] = append(bytes, next, 34962);
    }
    const compact = Uint16Array.from(indices, i => remap.get(i)!);
    p.indices = append(new Uint8Array(compact.buffer), { componentType: 5123, type: 'SCALAR', count: compact.length }, 34963);
    total += indices.length / 3;
    reports.push({ material, before: count, after: indices.length / 3, beforeVertices: vertexCount, afterVertices: kept.length,
      lockedVertices: locks.reduce((n, v) => n + v, 0), error });
  }
  assert.ok(total <= 14000, `NPC triangle budget exceeded: ${total}`);
  json.buffers[0].byteLength = length;
  const binary = Buffer.concat(chunks), text = Buffer.from(JSON.stringify(json)), padded = Buffer.alloc(aligned(text.length), 32); text.copy(padded);
  const output = Buffer.alloc(28 + padded.length + binary.length);
  output.writeUInt32LE(0x46546c67); output.writeUInt32LE(2, 4); output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(padded.length, 12); output.writeUInt32LE(0x4e4f534a, 16); padded.copy(output, 20);
  output.writeUInt32LE(binary.length, 20 + padded.length); output.writeUInt32LE(0x004e4942, 24 + padded.length); binary.copy(output, 28 + padded.length);
  const compact = compactGlb(output);
  return { bytes: compact.bytes, receipt: { triangles: total, primitives: reports, retainedAttributes: 'exact source bytes', animations: 'unchanged' } };
}
