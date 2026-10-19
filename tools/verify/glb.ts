// Minimal GLB reader for offline checks: JSON chunk, node world matrices and accessor bounds.
// Not a renderer or a full validator; Khronos glTF-Validator runs alongside it.

export interface GltfNode {
  name?: string;
  mesh?: number;
  children?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  matrix?: number[];
  extras?: Record<string, unknown>;
  skin?: number;
}

export interface GltfJson {
  asset: { version: string; generator?: string; copyright?: string };
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: GltfNode[];
  meshes?: { name?: string; primitives: { attributes: Record<string, number>; indices?: number; material?: number; mode?: number }[] }[];
  accessors?: { count: number; type: string; componentType: number; min?: number[]; max?: number[] }[];
  materials?: { name?: string; extensions?: Record<string, unknown> }[];
  textures?: unknown[];
  images?: { bufferView?: number; mimeType?: string; uri?: string }[];
  bufferViews?: { byteOffset?: number; byteLength: number }[];
  skins?: { name?: string; joints: number[]; inverseBindMatrices?: number; skeleton?: number }[];
  animations?: {
    name?: string;
    samplers: { input: number; output: number; interpolation?: string }[];
    channels: { sampler: number; target: { node?: number; path: string } }[];
  }[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
}

export interface Glb { json: GltfJson; bin: Uint8Array | null; bytes: number }

export function parseGlb(data: Uint8Array): Glb {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) throw new Error('Not a GLB file');
  if (view.getUint32(4, true) !== 2) throw new Error('Only glTF 2.0 GLB is supported');
  if (view.getUint32(8, true) !== data.byteLength) throw new Error('GLB length header does not match file size');
  let offset = 12;
  let json: GltfJson | null = null;
  let bin: Uint8Array | null = null;
  while (offset + 8 <= data.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const chunk = data.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk)) as GltfJson;
    else if (type === 0x004e4942) bin = chunk;
    offset += 8 + length;
  }
  if (!json) throw new Error('GLB has no JSON chunk');
  return { json, bin, bytes: data.byteLength };
}

type Mat4 = number[];

function compose(node: GltfNode): Mat4 {
  if (node.matrix) return node.matrix.slice();
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const x2 = qx! + qx!, y2 = qy! + qy!, z2 = qz! + qz!;
  const xx = qx! * x2, xy = qx! * y2, xz = qx! * z2, yy = qy! * y2, yz = qy! * z2, zz = qz! * z2;
  const wx = qw! * x2, wy = qw! * y2, wz = qw! * z2;
  // Column-major, as glTF stores matrices.
  return [
    (1 - (yy + zz)) * sx!, (xy + wz) * sx!, (xz - wy) * sx!, 0,
    (xy - wz) * sy!, (1 - (xx + zz)) * sy!, (yz + wx) * sy!, 0,
    (xz + wy) * sz!, (yz - wx) * sz!, (1 - (xx + yy)) * sz!, 0,
    tx!, ty!, tz!, 1,
  ];
}

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += a[k * 4 + r]! * b[c * 4 + k]!;
    out[c * 4 + r] = sum;
  }
  return out;
}

export function transformPoint(m: Mat4, [x, y, z]: readonly number[]): [number, number, number] {
  return [
    m[0]! * x! + m[4]! * y! + m[8]! * z! + m[12]!,
    m[1]! * x! + m[5]! * y! + m[9]! * z! + m[13]!,
    m[2]! * x! + m[6]! * y! + m[10]! * z! + m[14]!,
  ];
}

/** World matrix for every node reachable from the default scene, keyed by node index. */
export function worldMatrices(json: GltfJson): Map<number, Mat4> {
  const result = new Map<number, Mat4>();
  const nodes = json.nodes ?? [];
  const visit = (index: number, parent: Mat4) => {
    const node = nodes[index];
    if (!node) throw new Error(`Missing node ${index}`);
    const world = multiply(parent, compose(node));
    result.set(index, world);
    for (const child of node.children ?? []) visit(child, world);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const root of json.scenes?.[json.scene ?? 0]?.nodes ?? []) visit(root, identity);
  return result;
}

/** World-space AABB of a node's mesh from accessor min/max (corners transformed). */
export function nodeBounds(json: GltfJson, index: number, world: Mat4): { min: number[]; max: number[] } | null {
  const mesh = json.meshes?.[json.nodes?.[index]?.mesh ?? -1];
  if (!mesh) return null;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const primitive of mesh.primitives) {
    const accessor = json.accessors?.[primitive.attributes.POSITION ?? -1];
    if (!accessor?.min || !accessor.max) throw new Error(`Mesh ${mesh.name} POSITION lacks min/max`);
    for (let corner = 0; corner < 8; corner++) {
      const local = [0, 1, 2].map(i => ((corner >> i) & 1 ? accessor.max![i]! : accessor.min![i]!));
      const p = transformPoint(world, local);
      for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i]!, p[i]!); max[i] = Math.max(max[i]!, p[i]!); }
    }
  }
  return { min, max };
}

export function triangleCount(json: GltfJson): number {
  let total = 0;
  for (const node of json.nodes ?? []) {
    const mesh = node.mesh === undefined ? undefined : json.meshes?.[node.mesh];
    for (const p of mesh?.primitives ?? []) {
      if ((p.mode ?? 4) !== 4) continue;
      const count = p.indices !== undefined ? json.accessors?.[p.indices]?.count : json.accessors?.[p.attributes.POSITION ?? -1]?.count;
      total += Math.floor((count ?? 0) / 3);
    }
  }
  return total;
}
