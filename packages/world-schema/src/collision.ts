// HCOL v2: one binary blob per cell (plan section 4.1 step 9 and appendix B). A JSON header describes typed-array
// slices inside the body. Positions are runtime-frame float32 metres, indices uint32, one surface tag per triangle
// (uint16 index into `surfaceTags`). Colliders are static trimeshes grouped by kind so the sim can tag contacts
// (road, raised, kerb, wall, roof, citymodel, landmark, trunk) and `verify-collision` can gate each group separately.
export const HCOL_MAGIC = 'HCOL';
export const HCOL_VERSION = 2;

export type ColliderGroup = 'ground' | 'kerbs' | 'buildings' | 'citymodel' | 'landmarks' | 'props' | 'trees';

export interface ColliderSlice {
  readonly offset: number;
  readonly count: number;
}

export interface ColliderDescriptor {
  readonly id: string;
  readonly group: ColliderGroup;
  /** Building id for building colliders, surface id for ground, otherwise null. */
  readonly ref: string | null;
  readonly positions: ColliderSlice;
  readonly indices: ColliderSlice;
  readonly triangleTags: ColliderSlice;
}

export interface CollisionHeader {
  readonly version: typeof HCOL_VERSION;
  readonly originId: string;
  readonly frame: 'X-east,Y-up,Z-south';
  readonly cell: string;
  readonly surfaceTags: readonly string[];
  readonly colliders: readonly ColliderDescriptor[];
}

export interface TriMeshCollider {
  readonly id: string;
  readonly group: ColliderGroup;
  readonly ref: string | null;
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly triangleTags: Uint16Array;
}

export interface CollisionBundle {
  readonly header: CollisionHeader;
  readonly colliders: readonly TriMeshCollider[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function align4(n: number): number {
  return (n + 3) & ~3;
}

export function encodeCollisionBundle(header: Omit<CollisionHeader, 'colliders' | 'version'>, colliders: readonly TriMeshCollider[]): Uint8Array {
  const slices: ColliderDescriptor[] = [];
  const parts: Uint8Array[] = [];
  let offset = 0;
  const place = (a: Float32Array | Uint32Array | Uint16Array): ColliderSlice => {
    const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const at = offset;
    parts.push(bytes);
    offset = align4(offset + bytes.byteLength);
    const pad = offset - (at + bytes.byteLength);
    if (pad > 0) parts.push(new Uint8Array(pad));
    return { offset: at, count: a.length };
  };
  for (const c of colliders) {
    if (c.indices.length % 3 !== 0) throw new Error(`${c.id}: index count ${c.indices.length} is not a multiple of 3`);
    if (c.triangleTags.length !== c.indices.length / 3) throw new Error(`${c.id}: one tag per triangle required`);
    slices.push({ id: c.id, group: c.group, ref: c.ref, positions: place(c.positions), indices: place(c.indices), triangleTags: place(c.triangleTags) });
  }
  const full: CollisionHeader = { version: HCOL_VERSION, ...header, colliders: slices };
  const headerBytes = encoder.encode(JSON.stringify(full));
  const headerLength = align4(headerBytes.byteLength);
  const out = new Uint8Array(12 + headerLength + offset);
  out.set(encoder.encode(HCOL_MAGIC), 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(4, HCOL_VERSION, true);
  dv.setUint32(8, headerLength, true);
  out.set(headerBytes, 12);
  let cursor = 12 + headerLength;
  for (const p of parts) { out.set(p, cursor); cursor += p.byteLength; }
  return out;
}

export function parseCollisionBundle(bytes: Uint8Array): CollisionBundle {
  if (decoder.decode(bytes.subarray(0, 4)) !== HCOL_MAGIC) throw new Error('not an HCOL bundle');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint32(4, true);
  if (version !== HCOL_VERSION) throw new Error(`HCOL version ${version} is not ${HCOL_VERSION}`);
  const headerLength = dv.getUint32(8, true);
  const header = JSON.parse(decoder.decode(bytes.subarray(12, 12 + headerLength)).replace(/\0+$/, '')) as CollisionHeader;
  const base = bytes.byteOffset + 12 + headerLength;
  const colliders = header.colliders.map((c): TriMeshCollider => ({
    id: c.id, group: c.group, ref: c.ref,
    positions: new Float32Array(bytes.buffer, base + c.positions.offset, c.positions.count),
    indices: new Uint32Array(bytes.buffer, base + c.indices.offset, c.indices.count),
    triangleTags: new Uint16Array(bytes.buffer, base + c.triangleTags.offset, c.triangleTags.count),
  }));
  return { header, colliders };
}
