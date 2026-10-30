// Minimal glTF 2.0 binary reader for the city's 3D Tiles content: the JSON and BIN chunks, accessors (interleaved,
// any component type, normalized) and EXT_structural_metadata string properties. Browser-safe DataView reads only,
// with every offset checked against the buffer (the input is a fetched file).

export interface GltfAccessor {
  bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string; normalized?: boolean; sparse?: unknown;
}
export interface GltfBufferView { buffer?: number; byteOffset?: number; byteLength: number; byteStride?: number }
export interface GltfImage { bufferView?: number; mimeType?: string; uri?: string }
/** KHR_texture_basisu puts the KTX2 image index in the extension; the city's tiles have no core `source`. */
export interface GltfTexture { source?: number; extensions?: { KHR_texture_basisu?: { source?: number } } }
export interface GltfMaterial {
  pbrMetallicRoughness?: { baseColorFactor?: number[]; baseColorTexture?: { index: number; texCoord?: number } };
}
export interface GltfFeatureIdSpec { attribute?: number; propertyTable?: number; featureCount?: number; nullFeatureId?: number }
export interface GltfPrimitive {
  attributes: Record<string, number | undefined>; indices?: number; material?: number; mode?: number;
  extensions?: { EXT_mesh_features?: { featureIds?: GltfFeatureIdSpec[] } };
}
export interface GltfMesh { primitives?: GltfPrimitive[] }
export interface GltfNode { matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[]; mesh?: number; children?: number[] }
export interface GltfPropertyTable {
  class: string; count: number;
  properties?: Record<string, { values: number; stringOffsets?: number; stringOffsetType?: string } | undefined>;
}
export interface GltfClassProperty { type: string; componentType?: string; array?: boolean; noData?: unknown }
export interface GltfJson {
  scene?: number; scenes?: { nodes?: number[] }[]; nodes?: GltfNode[]; meshes?: GltfMesh[];
  accessors?: GltfAccessor[]; bufferViews?: GltfBufferView[]; images?: GltfImage[]; textures?: GltfTexture[]; materials?: GltfMaterial[];
  extensionsRequired?: string[];
  extensions?: {
    EXT_structural_metadata?: {
      schema?: { classes?: Record<string, { properties?: Record<string, GltfClassProperty | undefined> } | undefined> };
      propertyTables?: GltfPropertyTable[];
    };
  };
}
export interface Glb { readonly json: GltfJson; readonly bin: Uint8Array }

const MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const COMPONENTS: Readonly<Record<string, number>> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
type Read = (view: DataView, at: number) => number;
/** Component type to byte size, reader and normalized-integer scale (glTF 2.0 §3.11; null: not normalizable). */
const COMPONENT_TYPES: Readonly<Record<number, readonly [number, Read, ((v: number) => number) | null]>> = {
  5120: [1, (d, o) => d.getInt8(o), v => Math.max(v / 127, -1)],
  5121: [1, (d, o) => d.getUint8(o), v => v / 255],
  5122: [2, (d, o) => d.getInt16(o, true), v => Math.max(v / 32767, -1)],
  5123: [2, (d, o) => d.getUint16(o, true), v => v / 65535],
  5125: [4, (d, o) => d.getUint32(o, true), null],
  5126: [4, (d, o) => d.getFloat32(o, true), null],
};
const OFFSET_SIZES: Readonly<Record<string, number>> = { UINT8: 1, UINT16: 2, UINT32: 4 };

function fail(message: string): never { throw new Error(message); }

function viewOf(bytes: Uint8Array): DataView { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }

/** Splits a GLB into its parsed JSON and its BIN chunk (a view into `bytes`, empty when absent). */
export function parseGlb(bytes: Uint8Array): Glb {
  const view = viewOf(bytes);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== MAGIC || view.getUint32(4, true) !== 2) fail('Not a glTF 2.0 binary');
  const total = Math.min(view.getUint32(8, true), bytes.byteLength);
  let json: GltfJson | null = null, bin: Uint8Array | null = null;
  for (let at = 12; at + 8 <= total;) {
    const length = view.getUint32(at, true), type = view.getUint32(at + 4, true), start = at + 8;
    if (length > total - start) fail('GLB chunk outside the file');
    const chunk = bytes.subarray(start, start + length);
    if (type === CHUNK_JSON && json === null) json = JSON.parse(new TextDecoder().decode(chunk)) as GltfJson;
    else if (type === CHUNK_BIN && bin === null) bin = chunk;
    at = start + length;
  }
  if (json === null) fail('GLB without a JSON chunk');
  return { json, bin: bin ?? new Uint8Array(0) };
}

/** A buffer view's bytes in the BIN chunk (the only buffer a GLB tile has). */
export function bufferViewBytes(glb: Glb, index: number): Uint8Array {
  const v = glb.json.bufferViews?.[index] ?? fail(`Buffer view ${index} is missing`);
  if ((v.buffer ?? 0) !== 0) fail(`Buffer view ${index}: external buffers are not supported`);
  const offset = v.byteOffset ?? 0;
  if (offset > glb.bin.byteLength || v.byteLength > glb.bin.byteLength - offset) fail(`Buffer view ${index} outside the BIN chunk`);
  return glb.bin.subarray(offset, offset + v.byteLength);
}

/**
 * An accessor's elements de-interleaved as doubles, `count × components` long. Every component type converts
 * exactly (float32 values keep their exact value); normalized integers are scaled as glTF specifies.
 */
export function readAccessor(glb: Glb, index: number): Float64Array {
  const a = glb.json.accessors?.[index] ?? fail(`Accessor ${index} is missing`);
  const n = COMPONENTS[a.type] ?? fail(`Accessor ${index}: unsupported type ${a.type}`);
  const [size, read, scale] = COMPONENT_TYPES[a.componentType] ?? fail(`Accessor ${index}: unsupported component type ${a.componentType}`);
  if (a.sparse !== undefined) fail(`Accessor ${index}: sparse accessors are not supported`);
  if (a.normalized && !scale) fail(`Accessor ${index}: component type ${a.componentType} cannot be normalized`);
  const out = new Float64Array(a.count * n);
  if (a.bufferView === undefined || a.count === 0) return out; // no view: all zeros by the spec
  const bytes = bufferViewBytes(glb, a.bufferView), view = viewOf(bytes);
  const stride = glb.json.bufferViews?.[a.bufferView]?.byteStride ?? size * n, base = a.byteOffset ?? 0;
  if (base + (a.count - 1) * stride + n * size > bytes.byteLength) fail(`Accessor ${index} outside its buffer view`);
  const norm = a.normalized ? scale : null;
  for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) {
    const v = read(view, base + k * stride + c * size);
    out[k * n + c] = norm ? norm(v) : v;
  }
  return out;
}

/**
 * A scalar STRING property of an EXT_structural_metadata property table, one value per row, null where it equals
 * the class's noData. Null when the table, the property or its offsets are missing, or it is not a scalar string.
 */
export function readStringProperty(glb: Glb, tableIndex: number, name: string): (string | null)[] | null {
  const meta = glb.json.extensions?.EXT_structural_metadata;
  const table = meta?.propertyTables?.[tableIndex];
  const prop = table?.properties?.[name];
  const def = table ? meta?.schema?.classes?.[table.class]?.properties?.[name] : undefined;
  if (!table || !prop || !def || def.type !== 'STRING' || def.array || prop.stringOffsets === undefined) return null;
  const values = bufferViewBytes(glb, prop.values), offsets = viewOf(bufferViewBytes(glb, prop.stringOffsets));
  const type = prop.stringOffsetType ?? 'UINT32';
  const size = OFFSET_SIZES[type] ?? fail(`Property ${name}: unsupported string offset type ${type}`);
  if ((table.count + 1) * size > offsets.byteLength) fail(`Property ${name}: string offsets outside their buffer view`);
  const offset = (k: number) => (size === 1 ? offsets.getUint8(k) : size === 2 ? offsets.getUint16(k * 2, true) : offsets.getUint32(k * 4, true));
  const decoder = new TextDecoder(), out: (string | null)[] = [];
  for (let k = 0; k < table.count; k++) {
    const start = offset(k), end = offset(k + 1);
    if (start > end || end > values.byteLength) fail(`Property ${name}: string ${k} outside its buffer view`);
    const v = decoder.decode(values.subarray(start, end));
    out.push(v === def.noData ? null : v);
  }
  return out;
}

/** Row count of an EXT_structural_metadata property table (0 when absent). */
export function propertyTableCount(glb: Glb, tableIndex: number): number {
  return glb.json.extensions?.EXT_structural_metadata?.propertyTables?.[tableIndex]?.count ?? 0;
}
