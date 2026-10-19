// Convert a textured LoD2 snapshot (tools/world/fetch_city_model.ts) into per-building meshes in the Blender
// district frame (X east, Y north, Z up, metres from the world origin; decision 0001) for the district build.
// Every vertex is projected exactly: glTF Y-up to Z-up, tile transform to ECEF, geodetic on GRS80, EPSG:3879
// by Krüger's series; the stored heights are N2000 (see the ledger). KTX2 (Basis) textures are transcoded to
// PNG with the transcoder that ships with three.js, because Blender reads neither KTX2 nor Basis.
//   node tools/world/convert_city_model.ts --ledger data/raw/helsinki-lod2/ledger.json --snapshot senate-district \
//     --origin content/helsinki/world-origin.json --out data/work/m0/citymodel-v2
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { deflateSync } from 'node:zlib';
import { geodeticToGk25 } from '../../packages/world-schema/src/index.ts';

const { values } = parseArgs({ options: {
  ledger: { type: 'string' }, snapshot: { type: 'string' }, origin: { type: 'string' }, out: { type: 'string' },
} });
if (!values.ledger || !values.snapshot || !values.origin || !values.out) throw new Error('--ledger, --snapshot, --origin and --out are required');
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const ledger = JSON.parse(readFileSync(values.ledger, 'utf8'));
const snap = ledger.snapshots[values.snapshot];
if (!snap) throw new Error(`snapshot ${values.snapshot} is not in ${values.ledger}`);
const raw = path.dirname(values.ledger);
const indexBytes = readFileSync(path.join(raw, snap.path));
if (sha256(indexBytes) !== snap.sha256) throw new Error(`${snap.path} does not match its ledger hash`);
const index = JSON.parse(indexBytes.toString('utf8'));
const origin = JSON.parse(readFileSync(values.origin, 'utf8'));
const [E0, N0, H0] = origin.originProjected as [number, number, number];
if (existsSync(values.out)) throw new Error(`${values.out} exists; the build writes into a new directory`);
mkdirSync(path.join(values.out, 'textures'), { recursive: true });

// ---- glTF access ----
interface Gltf { json: any; bin: Buffer }
function parseGlb(buf: Buffer): Gltf {
  if (buf.toString('ascii', 0, 4) !== 'glTF' || buf.readUInt32LE(4) !== 2) throw new Error('not a glTF 2.0 binary');
  const jsonLength = buf.readUInt32LE(12);
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLength));
  const binHeader = 20 + jsonLength;
  return { json, bin: buf.subarray(binHeader + 8, binHeader + 8 + buf.readUInt32LE(binHeader)) };
}
const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const READ: Record<number, [number, (b: Buffer, o: number) => number]> = {
  5121: [1, (b, o) => b.readUInt8(o)], 5123: [2, (b, o) => b.readUInt16LE(o)], 5125: [4, (b, o) => b.readUInt32LE(o)],
  5126: [4, (b, o) => b.readFloatLE(o)],
};
function accessor(g: Gltf, i: number): Float64Array {
  const a = g.json.accessors[i], view = g.json.bufferViews[a.bufferView];
  const n = COMPONENTS[a.type]!, [size, read] = READ[a.componentType] ?? [];
  if (!read || a.normalized) throw new Error(`accessor ${i}: unsupported component type ${a.componentType}`);
  const stride = view.byteStride ?? size! * n, base = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const out = new Float64Array(a.count * n);
  for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) out[k * n + c] = read(g.bin, base + k * stride + c * size!);
  return out;
}
function view(g: Gltf, i: number): Buffer {
  const v = g.json.bufferViews[i];
  return g.bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
}
/** EXT_structural_metadata property table as one record per row (strings and scalars only). */
function propertyRows(g: Gltf): Record<string, string | number | null>[] {
  const meta = g.json.extensions?.EXT_structural_metadata;
  const table = meta?.propertyTables?.[0];
  if (!table) return [];
  const cls = meta.schema.classes[table.class];
  const rows: Record<string, string | number | null>[] = Array.from({ length: table.count }, () => ({}));
  for (const [name, p] of Object.entries<any>(table.properties)) {
    const def = cls.properties[name], values = view(g, p.values);
    for (let k = 0; k < table.count; k++) {
      let v: string | number | null;
      if (def.type === 'STRING') {
        const offsets = view(g, p.stringOffsets);
        v = values.toString('utf8', offsets.readUInt32LE(k * 4), offsets.readUInt32LE((k + 1) * 4));
      } else if (def.componentType === 'FLOAT64') v = values.readDoubleLE(k * 8);
      else if (def.componentType === 'INT32') v = values.readInt32LE(k * 4);
      else throw new Error(`property ${name}: unsupported ${def.componentType}`);
      if (v === def.noData || (typeof v === 'number' && typeof def.noData === 'number' && Math.abs(v - def.noData) < 1e-300)) v = null;
      rows[k]![name] = v;
    }
  }
  return rows;
}
/** Column-major 4x4 times point. */
const apply = (m: number[], x: number, y: number, z: number): [number, number, number] =>
  [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!];
function ecefToGeodetic(x: number, y: number, z: number): [number, number, number] {
  const a = 6378137, f = 1 / 298.257222101, e2 = f * (2 - f), p = Math.hypot(x, y); // GRS80
  let lat = Math.atan2(z, p * (1 - e2)), h = 0;
  for (let i = 0; i < 10; i++) {
    const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    h = p / Math.cos(lat) - n;
    lat = Math.atan2(z, p * (1 - e2 * n / (n + h)));
  }
  return [lat * 180 / Math.PI, Math.atan2(y, x) * 180 / Math.PI, h];
}

// ---- KTX2 (Basis) to PNG ----
const threeRoot = path.resolve(path.dirname(createRequire(new URL('../../apps/game/package.json', import.meta.url)).resolve('three')), '..');
const basisDir = path.join(threeRoot, 'examples/jsm/libs/basis');
// Three marks its package as ESM, but this installed vendor file already exports a CommonJS factory.
// Load its exact bytes as .cjs rather than evaluating a generated string of JavaScript.
const commonJsFile = path.join(tmpdir(), `helsinki-basis-${randomUUID()}.cjs`);
let factory;
try {
  copyFileSync(path.join(basisDir, 'basis_transcoder.js'), commonJsFile);
  factory = createRequire(import.meta.url)(commonJsFile);
} finally {
  if (existsSync(commonJsFile)) unlinkSync(commonJsFile);
}
const basis = await factory({ wasmBinary: readFileSync(path.join(basisDir, 'basis_transcoder.wasm')) });
basis.initializeBasis();
const RGBA32 = 13; // basis transcoder_texture_format cTFRGBA32

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(b: Buffer): number { let c = -1; for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ -1) >>> 0; }
function pngRgb(width: number, height: number, rgba: Uint8Array): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, tail]);
  };
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const s = (y * width + x) * 4, d = y * (width * 3 + 1) + 1 + x * 3;
    rows[d] = rgba[s]!; rows[d + 1] = rgba[s + 1]!; rows[d + 2] = rgba[s + 2]!;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}
interface TextureRecord { file: string; width: number; height: number; sourceSha256: string }
const textures: TextureRecord[] = [];
const textureByHash = new Map<string, number>();
function texture(g: Gltf, imageIndex: number): number {
  const image = g.json.images[imageIndex];
  if (image.mimeType !== 'image/ktx2') throw new Error(`image ${imageIndex}: unexpected ${image.mimeType}`);
  const bytes = view(g, image.bufferView), hash = sha256(bytes);
  const known = textureByHash.get(hash);
  if (known !== undefined) return known;
  const file = new basis.KTX2File(new Uint8Array(bytes));
  try {
    if (!file.isValid() || !file.startTranscoding()) throw new Error('KTX2 file did not open');
    const width = file.getWidth(), height = file.getHeight();
    const pixels = new Uint8Array(file.getImageTranscodedSizeInBytes(0, 0, 0, RGBA32));
    if (!file.transcodeImage(pixels, 0, 0, 0, RGBA32, 0, -1, -1)) throw new Error('KTX2 transcode failed');
    const name = `textures/${hash.slice(0, 16)}.png`;
    writeFileSync(path.join(values.out!, name), pngRgb(width, height, pixels));
    textures.push({ file: name, width, height, sourceSha256: hash });
  } finally {
    file.close();
    file.delete();
  }
  textureByHash.set(hash, textures.length - 1);
  return textures.length - 1;
}

// ---- buildings ----
interface Part { texture: number | null; colour: number[]; positions: number[]; uvs: number[]; indices: number[] }
interface Building {
  id: string; vtj: string | null; address: string | null; year: number | null; storeys: number | null; measuredHeight: number | null;
  function: string | null; tile: string; parts: Map<string, Part>; min: number[]; max: number[];
}
const buildings = new Map<string, Building>();
let sourceTriangles = 0, skippedTriangles = 0;
for (const tile of index.tiles as { file: string; sha256: string; transform: number[] }[]) {
  const body = readFileSync(path.join(raw, values.snapshot, tile.file));
  if (sha256(body) !== tile.sha256) throw new Error(`${tile.file} does not match the snapshot index`);
  const g = parseGlb(body);
  const required = g.json.extensionsRequired ?? [];
  for (const ext of required) if (ext !== 'KHR_texture_basisu') throw new Error(`${tile.file}: unsupported required extension ${ext}`);
  const rows = propertyRows(g);
  // Node world matrices in glTF space (scene roots only carry identity matrices here, but apply them anyway).
  const world = new Map<number, number[]>();
  const visit = (i: number, parent: number[]) => {
    const node = g.json.nodes[i];
    let m = parent;
    if (node.matrix) m = mul(parent, node.matrix);
    else if (node.translation || node.rotation || node.scale) throw new Error(`${tile.file}: TRS nodes are not handled`);
    world.set(i, m);
    for (const c of node.children ?? []) visit(c, m);
  };
  for (const r of g.json.scenes[g.json.scene ?? 0].nodes) visit(r, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  for (const [nodeIndex, m] of world) {
    const node = g.json.nodes[nodeIndex];
    if (node.mesh === undefined) continue;
    for (const prim of g.json.meshes[node.mesh].primitives) {
      if ((prim.mode ?? 4) !== 4) throw new Error(`${tile.file}: non-triangle primitive`);
      const pos = accessor(g, prim.attributes.POSITION);
      const uv = prim.attributes.TEXCOORD_0 !== undefined ? accessor(g, prim.attributes.TEXCOORD_0) : null;
      const featureSpec = prim.extensions?.EXT_mesh_features?.featureIds?.[0];
      if (featureSpec?.attribute === undefined) throw new Error(`${tile.file}: primitive without per-vertex feature ids`);
      const fid = accessor(g, prim.attributes[`_FEATURE_ID_${featureSpec.attribute}`]);
      const idx = prim.indices !== undefined ? accessor(g, prim.indices) : Float64Array.from({ length: pos.length / 3 }, (_, i) => i);
      const material = g.json.materials?.[prim.material] ?? {};
      const pbr = material.pbrMetallicRoughness ?? {};
      const textureIndex = pbr.baseColorTexture ? texture(g, sourceImage(g, pbr.baseColorTexture.index)) : null;
      if (pbr.baseColorTexture && (pbr.baseColorTexture.texCoord ?? 0) !== 0) throw new Error(`${tile.file}: texCoord ${pbr.baseColorTexture.texCoord}`);
      if (textureIndex !== null && !uv) throw new Error(`${tile.file}: textured primitive without UVs`);
      const colour = (pbr.baseColorFactor ?? [1, 1, 1, 1]).slice(0, 3);
      // Project every vertex once.
      const blender = new Float64Array(pos.length);
      for (let v = 0; v < pos.length / 3; v++) {
        const [gx, gy, gz] = apply(m, pos[v * 3]!, pos[v * 3 + 1]!, pos[v * 3 + 2]!);
        const [x, y, z] = apply(tile.transform, gx, -gz, gy);
        const [lat, lon, h] = ecefToGeodetic(x, y, z);
        const [e, n] = geodeticToGk25(lat, lon);
        blender[v * 3] = e - E0; blender[v * 3 + 1] = n - N0; blender[v * 3 + 2] = h - H0;
      }
      for (let t = 0; t < idx.length; t += 3) {
        sourceTriangles++;
        const a = idx[t]!, b = idx[t + 1]!, c = idx[t + 2]!;
        const row = fid[a]!;
        if (fid[b] !== row || fid[c] !== row || !rows[row]) { skippedTriangles++; continue; }
        const props = rows[row]!;
        const id = String(props.id ?? `${tile.file}:${row}`);
        let building = buildings.get(id);
        if (!building) {
          const vtj = typeof props.VTJ_PRT === 'string' && /^\d{9}[0-9A-Z]$/.test(props.VTJ_PRT) ? props.VTJ_PRT : null;
          building = { id, vtj, address: (props.address as string) ?? null, year: (props.yearOfConstruction as number) ?? null,
            storeys: (props.storeysAboveGround as number) ?? null, measuredHeight: (props.measuredHeight as number) ?? null,
            function: (props.function as string) ?? null, tile: tile.file, parts: new Map(), min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
          buildings.set(id, building);
        } else if (building.tile !== tile.file) {
          throw new Error(`building ${id} spans tiles ${building.tile} and ${tile.file}`);
        }
        const key = textureIndex === null ? `c:${colour.join(',')}` : `t:${textureIndex}`;
        let part = building.parts.get(key);
        if (!part) { part = { texture: textureIndex, colour, positions: [], uvs: [], indices: [] }; building.parts.set(key, part); }
        for (const v of [a, b, c]) {
          const x = blender[v * 3]!, y = blender[v * 3 + 1]!, z = blender[v * 3 + 2]!;
          part.indices.push(part.positions.length / 3);
          part.positions.push(x, y, z);
          // glTF UV origin is the top left; Blender's is the bottom left.
          if (uv) part.uvs.push(uv[v * 2]!, 1 - uv[v * 2 + 1]!); else part.uvs.push(0, 0);
          for (const [i, value] of [x, y, z].entries()) { building.min[i] = Math.min(building.min[i]!, value); building.max[i] = Math.max(building.max[i]!, value); }
        }
      }
    }
  }
}
function sourceImage(g: Gltf, textureIndex: number): number {
  const t = g.json.textures[textureIndex];
  const source = t.extensions?.KHR_texture_basisu?.source ?? t.source;
  if (source === undefined) throw new Error('texture without a source');
  return source;
}
function mul(a: number[], b: number[]): number[] {
  const r = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) for (let k = 0; k < 4; k++) r[c * 4 + row]! += a[k * 4 + row]! * b[c * 4 + k]!;
  return r;
}

// ---- output: one binary with float32 positions/UVs and uint32 indices, described by city-model.json ----
const chunks: Buffer[] = [];
let offset = 0;
const place = (data: Buffer) => { const at = offset; chunks.push(data); offset += data.length; return { offset: at, bytes: data.length }; };
const round3 = (v: number) => Math.round(v * 1000) / 1000;
const records = [...buildings.values()].sort((a, b) => a.id.localeCompare(b.id)).map(b => ({
  id: b.id, vtj: b.vtj, address: b.address, year: b.year, storeys: b.storeys, measuredHeight: b.measuredHeight, function: b.function,
  sourceTile: b.tile, boundsENU: { min: b.min.map(round3), max: b.max.map(round3) },
  textured: [...b.parts.values()].some(p => p.texture !== null),
  triangles: [...b.parts.values()].reduce((s, p) => s + p.indices.length / 3, 0),
  parts: [...b.parts.values()].map(p => ({
    texture: p.texture, colour: p.colour.map(round3), vertices: p.positions.length / 3,
    positions: place(Buffer.from(Float32Array.from(p.positions).buffer)),
    uvs: place(Buffer.from(Float32Array.from(p.uvs).buffer)),
    indices: place(Buffer.from(Uint32Array.from(p.indices).buffer)),
  })),
}));
const bin = Buffer.concat(chunks);
writeFileSync(path.join(values.out, 'city-model.bin'), bin);
const doc = {
  schemaVersion: 1, kind: 'city-model-buildings',
  frame: 'Blender district frame: X east, Y north, Z up (N2000), metres from originProjected',
  originProjected: origin.originProjected, originId: origin.id,
  source: { ...ledger.source, snapshot: values.snapshot, snapshotSha256: snap.sha256, tilesetVersion: snap.tilesetVersion, retrievedAt: snap.retrievedAt },
  binary: { file: 'city-model.bin', bytes: bin.length, sha256: sha256(bin) },
  textures, buildings: records,
  stats: { sourceTriangles, skippedTriangles, buildings: records.length, textured: records.filter(r => r.textured).length,
    texturePixels: textures.reduce((s, t) => s + t.width * t.height, 0) },
};
writeFileSync(path.join(values.out, 'city-model.json'), JSON.stringify(doc, null, 1) + '\n');
console.log(JSON.stringify(doc.stats));
