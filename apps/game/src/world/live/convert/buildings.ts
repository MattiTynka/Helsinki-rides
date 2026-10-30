// Textured LoD2 tile content (3D Tiles GLB) to per-building meshes in the runtime frame, and those meshes cut into
// live grid squares by building centroid. The vertex path is tools/world/convert_city_model.ts's: node matrices,
// glTF Y-up to the tile's Z-up frame, the accumulated tile transform to ECEF, then the exact projection. Every frame
// on the way is right-handed, so glTF's counter-clockwise front faces stay front faces in the runtime frame.
import { readKtx2Layout } from '@helsinki/world-schema';
import type { LiveBuildingPart, LiveTextureBytes, Origin } from '../contract.ts';
import { bufferViewBytes, parseGlb, propertyTableCount, readAccessor, readStringProperty, type Glb } from './glb.ts';
import { IDENTITY, SQUARE, apply4, ecefToRuntime, multiply4 } from './projection.ts';

export interface ConvertedFeature {
  readonly id: string | null;
  readonly vtj: string | null;
  readonly centroidX: number;
  readonly centroidZ: number;
  readonly parts: readonly { texture: string | null; color: readonly [number, number, number]; positions: Float32Array; normals: Float32Array; uvs: Float32Array | null }[];
}

export interface ConvertedTile {
  readonly url: string;
  readonly features: readonly ConvertedFeature[];
  readonly textures: ReadonlyMap<string, { readonly bytes: ArrayBuffer; readonly width: number; readonly height: number; readonly triangles: number }>;
  /** Approximate bytes held: geometry arrays plus texture copies. */
  readonly bytes: number;
}

/** Building register id (VTJ_PRT): nine digits and a check character. */
const VTJ = /^\d{9}[0-9A-Z]$/;
/** Feature key of triangles whose vertices name different features (none in the measured tiles). */
const MIXED = '\u0000mixed';

interface PartBuilder { texture: string | null; color: [number, number, number]; positions: number[]; normals: number[]; uvs: number[] | null }
interface FeatureBuilder { id: string | null; vtj: string | null; parts: Map<string, PartBuilder>; x0: number; z0: number; x1: number; z1: number }
interface TextureRecord { bytes: ArrayBuffer; width: number; height: number; triangles: number }

/** Node index to world matrix in glTF space, scene roots first (the city's tiles carry identity matrices). */
function nodeMatrices(glb: Glb): Map<number, number[]> {
  const world = new Map<number, number[]>(), nodes = glb.json.nodes ?? [];
  const visit = (i: number, parent: readonly number[]) => {
    const node = nodes[i];
    if (!node) throw new Error(`Node ${i} is missing`);
    if (!node.matrix && (node.translation || node.rotation || node.scale)) throw new Error('TRS nodes are not handled');
    const m = node.matrix ? multiply4(parent, node.matrix) : [...parent];
    world.set(i, m);
    for (const c of node.children ?? []) visit(c, m);
  };
  for (const r of glb.json.scenes?.[glb.json.scene ?? 0]?.nodes ?? []) visit(r, IDENTITY);
  return world;
}

/**
 * One tile's buildings in the runtime frame of `origin`: triangles grouped per feature (EXT_mesh_features id, its
 * property-table `id`), then per material (texture or colour). Output is non-indexed with flat face normals from the
 * projected positions; UVs are glTF's, unflipped. Each KTX2 image used is copied into its own ArrayBuffer.
 */
export function convertTile(url: string, glb: Uint8Array, transform: readonly number[], origin: Origin): ConvertedTile {
  const g = parseGlb(glb);
  for (const ext of g.json.extensionsRequired ?? []) if (ext !== 'KHR_texture_basisu') throw new Error(`${url}: unsupported required extension ${ext}`);
  const features = new Map<string, FeatureBuilder>();
  const textures = new Map<string, TextureRecord>();
  const tables = new Map<number, { count: number; ids: (string | null)[] | null; vtj: (string | null)[] | null }>();
  const table = (t: number) => {
    let rows = tables.get(t);
    if (!rows) tables.set(t, rows = { count: propertyTableCount(g, t), ids: readStringProperty(g, t, 'id'), vtj: readStringProperty(g, t, 'VTJ_PRT') });
    return rows;
  };
  /** glTF texture index to its usable KTX2 texture key, or null: the material then falls back to its colour. */
  const textureKeys = new Map<number, string | null>();
  const textureKey = (index: number): string | null => {
    const known = textureKeys.get(index);
    if (known !== undefined) return known;
    const t = g.json.textures?.[index];
    const source = t?.extensions?.KHR_texture_basisu?.source ?? t?.source;
    const image = source === undefined ? undefined : g.json.images?.[source];
    let key: string | null = null;
    if (source !== undefined && image?.mimeType === 'image/ktx2' && image.bufferView !== undefined) {
      key = `${url}#${source}`;
      if (!textures.has(key)) {
        const src = bufferViewBytes(g, image.bufferView);
        try {
          const { width, height } = readKtx2Layout(src);
          const bytes = new ArrayBuffer(src.byteLength);
          new Uint8Array(bytes).set(src);
          textures.set(key, { bytes, width, height, triangles: 0 });
        } catch {
          key = null;
        }
      }
    }
    textureKeys.set(index, key);
    return key;
  };
  const feature = (key: string, id: string | null, vtj: string | null): FeatureBuilder => {
    let f = features.get(key);
    if (!f) features.set(key, f = { id, vtj, parts: new Map(), x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity });
    return f;
  };

  for (const [nodeIndex, m] of nodeMatrices(g)) {
    const meshIndex = g.json.nodes?.[nodeIndex]?.mesh;
    if (meshIndex === undefined) continue;
    for (const prim of g.json.meshes?.[meshIndex]?.primitives ?? []) {
      const posIndex = prim.attributes.POSITION;
      if ((prim.mode ?? 4) !== 4 || posIndex === undefined) continue; // only triangle lists carry surfaces
      const pos = readAccessor(g, posIndex);
      const spec = prim.extensions?.EXT_mesh_features?.featureIds?.[0];
      const fidIndex = spec?.attribute === undefined ? undefined : prim.attributes[`_FEATURE_ID_${spec.attribute}`];
      const fid = fidIndex === undefined ? null : readAccessor(g, fidIndex);
      const rows = table(spec?.propertyTable ?? 0);
      const idx = prim.indices === undefined ? null : readAccessor(g, prim.indices);
      const pbr = prim.material === undefined ? undefined : g.json.materials?.[prim.material]?.pbrMetallicRoughness;
      const factor = pbr?.baseColorFactor;
      const color: [number, number, number] = [factor?.[0] ?? 1, factor?.[1] ?? 1, factor?.[2] ?? 1];
      const ref = pbr?.baseColorTexture;
      const uvIndex = ref ? prim.attributes[`TEXCOORD_${ref.texCoord ?? 0}`] : undefined;
      const texture = ref && uvIndex !== undefined ? textureKey(ref.index) : null;
      const uv = texture === null || uvIndex === undefined ? null : readAccessor(g, uvIndex);
      const record = texture === null ? undefined : textures.get(texture);
      const partKey = `${texture ?? ''}|${color.join(',')}`;

      // Project every vertex once: glTF Y-up to Z-up, tile transform to ECEF, then to the runtime frame.
      const vertices = pos.length / 3, rt = new Float64Array(pos.length);
      for (let v = 0; v < vertices; v++) {
        const [gx, gy, gz] = apply4(m, pos[v * 3]!, pos[v * 3 + 1]!, pos[v * 3 + 2]!);
        const [x, y, z] = apply4(transform, gx, -gz, gy);
        const r = ecefToRuntime(origin, x, y, z);
        rt[v * 3] = r[0]; rt[v * 3 + 1] = r[1]; rt[v * 3 + 2] = r[2];
      }

      const corners = idx ? idx.length - (idx.length % 3) : vertices - (vertices % 3);
      for (let t = 0; t < corners; t += 3) {
        const a = idx ? idx[t]! : t, b = idx ? idx[t + 1]! : t + 1, c = idx ? idx[t + 2]! : t + 2;
        if (Math.max(a, b, c) >= vertices) throw new Error(`${url}: index outside the vertex range`);
        const row = fid ? fid[a]! : -1;
        let f: FeatureBuilder;
        if (!fid || fid[b] !== row || fid[c] !== row || !Number.isInteger(row) || row < 0 || row >= rows.count) f = feature(MIXED, null, null);
        else {
          const id = rows.ids?.[row] ?? null, vtj = rows.vtj?.[row] ?? null;
          f = feature(id ?? `\u0000row:${spec?.propertyTable ?? 0}:${row}`, id, vtj !== null && VTJ.test(vtj) ? vtj : null);
        }
        let part = f.parts.get(partKey);
        if (!part) f.parts.set(partKey, part = { texture, color, positions: [], normals: [], uvs: uv ? [] : null });
        const ax = rt[a * 3]!, ay = rt[a * 3 + 1]!, az = rt[a * 3 + 2]!;
        const bx = rt[b * 3]!, by = rt[b * 3 + 1]!, bz = rt[b * 3 + 2]!;
        const cx = rt[c * 3]!, cy = rt[c * 3 + 1]!, cz = rt[c * 3 + 2]!;
        const ux = bx - ax, uy = by - ay, uz = bz - az, wx = cx - ax, wy = cy - ay, wz = cz - az;
        let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
        const len = Math.hypot(nx, ny, nz);
        if (len > 0) { nx /= len; ny /= len; nz /= len; } else { nx = 0; ny = 1; nz = 0; }
        part.positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
        part.normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
        if (part.uvs && uv) part.uvs.push(uv[a * 2]!, uv[a * 2 + 1]!, uv[b * 2]!, uv[b * 2 + 1]!, uv[c * 2]!, uv[c * 2 + 1]!);
        f.x0 = Math.min(f.x0, ax, bx, cx); f.x1 = Math.max(f.x1, ax, bx, cx);
        f.z0 = Math.min(f.z0, az, bz, cz); f.z1 = Math.max(f.z1, az, bz, cz);
        if (record) record.triangles++;
      }
    }
  }

  let bytes = 0;
  const out: ConvertedFeature[] = [];
  for (const f of features.values()) {
    const parts = [...f.parts.values()].map(p => ({
      texture: p.texture, color: p.color, positions: new Float32Array(p.positions), normals: new Float32Array(p.normals),
      uvs: p.uvs ? new Float32Array(p.uvs) : null,
    }));
    for (const p of parts) bytes += p.positions.byteLength + p.normals.byteLength + (p.uvs?.byteLength ?? 0);
    out.push({ id: f.id, vtj: f.vtj, centroidX: (f.x0 + f.x1) / 2, centroidZ: (f.z0 + f.z1) / 2, parts });
  }
  const used = new Map<string, TextureRecord>();
  for (const [key, t] of textures) if (t.triangles > 0) { used.set(key, t); bytes += t.bytes.byteLength; }
  return { url, features: out, textures: used, bytes };
}

/**
 * The building parts square (cx, cz) owns: features whose XZ centroid lies in it, unless the square is static or
 * `exclude` names the building, and only the first copy of an id across `tiles`. Geometry is merged per (texture,
 * colour) into fresh arrays; each texture's share is this square's triangles on it over the tile's.
 */
export function cellParts(
  tiles: readonly ConvertedTile[], cx: number, cz: number,
  exclude: (id: string | null, vtj: string | null) => boolean, isStaticSquare: (cx: number, cz: number) => boolean,
): { parts: LiveBuildingPart[]; textures: LiveTextureBytes[]; triangles: number } {
  type Chunk = ConvertedFeature['parts'][number];
  const groups = new Map<string, { texture: string | null; color: readonly [number, number, number]; chunks: Chunk[]; floats: number }>();
  const used = new Map<string, { tile: ConvertedTile; triangles: number }>();
  const taken = new Set<string>();
  for (const tile of tiles) for (const f of tile.features) {
    if (f.id !== null && taken.has(f.id)) continue;
    const fx = Math.floor(f.centroidX / SQUARE), fz = Math.floor(f.centroidZ / SQUARE);
    if (fx !== cx || fz !== cz || isStaticSquare(fx, fz) || exclude(f.id, f.vtj)) continue;
    if (f.id !== null) taken.add(f.id);
    for (const p of f.parts) {
      const key = `${p.texture ?? ''}|${p.color.join(',')}`;
      let group = groups.get(key);
      if (!group) groups.set(key, group = { texture: p.texture, color: p.color, chunks: [], floats: 0 });
      group.chunks.push(p);
      group.floats += p.positions.length;
      if (p.texture !== null) {
        const u = used.get(p.texture) ?? { tile, triangles: 0 };
        u.triangles += p.positions.length / 9;
        used.set(p.texture, u);
      }
    }
  }
  let triangles = 0;
  const parts: LiveBuildingPart[] = [];
  for (const g of groups.values()) {
    const positions = new Float32Array(g.floats), normals = new Float32Array(g.floats);
    const uvs = g.texture === null ? null : new Float32Array((g.floats / 3) * 2);
    let at = 0;
    for (const c of g.chunks) {
      positions.set(c.positions, at);
      normals.set(c.normals, at);
      if (uvs && c.uvs) uvs.set(c.uvs, (at / 3) * 2);
      at += c.positions.length;
    }
    triangles += g.floats / 9;
    parts.push({ texture: g.texture, color: [g.color[0], g.color[1], g.color[2]], positions, normals, uvs });
  }
  const textures: LiveTextureBytes[] = [];
  for (const [key, u] of used) {
    const t = u.tile.textures.get(key);
    if (!t) continue;
    textures.push({ key, bytes: t.bytes, width: t.width, height: t.height, share: Math.min(1, u.triangles / t.triangles) });
  }
  return { parts, textures, triangles };
}
