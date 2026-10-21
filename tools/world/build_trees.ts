import{readDeliveryRoadFile}from'./lib/delivery-road-file.ts';
// Trees for the play area from the city's two tree layers (tools/world/fetch_trees.ts; plan section 4.3: positions
// and heights from the city, own models): every instanced SolitaryVegetationObject is placed exactly (instance
// translation, node matrix, glTF Y-up to Z-up, tile transform to ECEF, geodetic on GRS80, EPSG:3879, then the
// runtime frame), and keeps its register height, crown diameter, trunk size and genus. The city's own tree meshes
// in the tiles are not used: each tree becomes an instance of one of the three models in scenery-trees.glb
// (tools/blender/build_tree_models.py), scaled to its height and crown. The cell builder adds trunk colliders and
// publishes the instances (tools/world/build_cells.ts --trees).
//   node tools/world/build_trees.ts --ledgers data/raw/helsinki-trees/street/ledger.json,data/raw/helsinki-trees/plot/ledger.json \
//     --snapshot senate-district --terrain data/work/m0/terrain-v2 --roads data/work/m0/roads-v2/roads.json \
//     --footprints data/raw/helsinki-building-register/senate-district.geojson --models data/work/m0/blender-scenery/blender-report.json \
//     --config content/helsinki/cells.json --origin content/helsinki/world-origin.json --out data/work/m0/trees-v1
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { geodeticToGk25, parseTerrain, sampleTerrain } from '../../packages/world-schema/src/index.ts';
import { loadGeoJsonPolygons, pointInPolygon, PolygonGrid, segmentDistance, type Pt } from './lib/geometry.ts';
import { preserveTreePlacements } from './lib/tree-preservation.ts';

const { values } = parseArgs({ options: {
  ledgers: { type: 'string' }, snapshot: { type: 'string' }, terrain: { type: 'string' }, roads: { type: 'string' }, footprints: { type: 'string' },
  models: { type: 'string' }, config: { type: 'string' }, origin: { type: 'string' }, out: { type: 'string' },
  'preserve-trees': { type: 'string' },
} });
for (const k of ['ledgers', 'snapshot', 'terrain', 'roads', 'footprints', 'models', 'config', 'origin', 'out'] as const) if (!values[k]) throw new Error(`--${k} is required`);
if (existsSync(values.out!)) throw new Error(`${values.out} exists; the build writes into a new directory`);
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const config = JSON.parse(readFileSync(values.config!, 'utf8'));
const area = config.playArea as { minX: number; maxX: number; minZ: number; maxZ: number };
const origin = JSON.parse(readFileSync(values.origin!, 'utf8'));
const [E0, N0, H0] = origin.originProjected as [number, number, number];
const terrainDoc = JSON.parse(readFileSync(path.join(values.terrain!, 'terrain.json'), 'utf8'));
const terrain = parseTerrain(new Uint8Array(readFileSync(path.join(values.terrain!, terrainDoc.file))));
const roads = readDeliveryRoadFile(values.roads!);
const footprints = loadGeoJsonPolygons(values.footprints!, E0, N0, (p, i) => String(p['vtj_prt'] ?? `register-${p['id'] ?? i}`));
const fpGrid = new PolygonGrid(footprints, 32);
const modelReport = JSON.parse(readFileSync(values.models!, 'utf8')).assets['scenery-trees'] as {
  glb: { sha256: string }; models: Record<string, { refHeight: number; refCrownDiameter: number; trunkRadiusBase: number; clearTrunk: number }> };

/** Model per genus (the street register names the genus; the plot layer's genus is the city's own uncertain guess). */
const MODEL_BY_GENUS: Record<string, string> = { Betula: 'tree-birch', Pinus: 'tree-pine', Picea: 'tree-pine' };
const DEFAULT_MODEL = 'tree-broadleaf';
/** Crown width per unit height is held to this range of the model's own shape, so a scale never makes a disc or a pole. */
const CROWN_RATIO = [0.3, 1.8] as const;
/** The trunk sinks this far below the terrain so it never floats on a slope or above a raised sidewalk. */
const SINK = 0.3;
/** Trunk colliders reach this high above the base: well above a car roof, below every crown. */
const TRUNK_COLLIDER_HEIGHT = 3;

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
  5121: [1, (b, o) => b.readUInt8(o)], 5123: [2, (b, o) => b.readUInt16LE(o)], 5125: [4, (b, o) => b.readUInt32LE(o)], 5126: [4, (b, o) => b.readFloatLE(o)],
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
const view = (g: Gltf, i: number) => { const v = g.json.bufferViews[i]; return g.bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength); };
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
      if (def.type === 'STRING') { const offsets = view(g, p.stringOffsets); v = values.toString('utf8', offsets.readUInt32LE(k * 4), offsets.readUInt32LE((k + 1) * 4)); }
      else if (def.componentType === 'FLOAT64') v = values.readDoubleLE(k * 8);
      else if (def.componentType === 'INT32') v = values.readInt32LE(k * 4);
      else throw new Error(`property ${name}: unsupported ${def.componentType}`);
      if (v === def.noData || (typeof v === 'number' && typeof def.noData === 'number' && Math.abs(v - def.noData) < 1e-300)) v = null;
      rows[k]![name] = v;
    }
  }
  return rows;
}
function mul(a: number[], b: number[]): number[] {
  const r = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) for (let k = 0; k < 4; k++) r[c * 4 + row]! += a[k * 4 + row]! * b[c * 4 + k]!;
  return r;
}
const apply = (m: number[], x: number, y: number, z: number): [number, number, number] =>
  [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!];
function ecefToGeodetic(x: number, y: number, z: number): [number, number, number] {
  const a = 6378137, f = 1 / 298.257222101, e2 = f * (2 - f), p = Math.hypot(x, y); // GRS80
  let lat = Math.atan2(z, p * (1 - e2)), h = 0;
  for (let i = 0; i < 10; i++) { const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2); h = p / Math.cos(lat) - n; lat = Math.atan2(z, p * (1 - e2 * n / (n + h))); }
  return [lat * 180 / Math.PI, Math.atan2(y, x) * 180 / Math.PI, h];
}

// ---- decode ----
interface Tree {
  id: string; layer: string; register: string | null; genus: string | null; species: string | null; nameFi: string | null; site: string | null;
  height: number; crown: number; trunkCm: number | null; planted: number | null;
  /** Runtime frame: x east, y up, z south. `sourceBase` is the tile's base height, `ground` the terrain at the trunk. */
  x: number; z: number; sourceBase: number; ground: number;
}
const trees: Tree[] = [];
const inputs: { layer: string; ledger: string; snapshot: string; sha256: string; tiles: number }[] = [];
for (const ledgerPath of values.ledgers!.split(',')) {
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  const snap = ledger.snapshots[values.snapshot!];
  if (!snap) throw new Error(`snapshot ${values.snapshot} is not in ${ledgerPath}`);
  const raw = path.dirname(ledgerPath);
  const indexBytes = readFileSync(path.join(raw, snap.path));
  if (sha256(indexBytes) !== snap.sha256) throw new Error(`${snap.path} does not match its ledger hash`);
  const index = JSON.parse(indexBytes.toString('utf8'));
  inputs.push({ layer: index.layer, ledger: ledger.source.id, snapshot: values.snapshot!, sha256: snap.sha256, tiles: index.tiles.length });
  const seen = new Set<string>();
  for (const tile of index.tiles as { file: string; sha256: string; transform: number[] }[]) {
    const body = readFileSync(path.join(raw, values.snapshot!, tile.file));
    if (sha256(body) !== tile.sha256) throw new Error(`${tile.file} does not match the snapshot index`);
    const g = parseGlb(body);
    for (const ext of g.json.extensionsRequired ?? []) if (ext !== 'KHR_texture_basisu' && ext !== 'EXT_mesh_gpu_instancing') throw new Error(`${tile.file}: unsupported required extension ${ext}`);
    const rows = propertyRows(g);
    const world = new Map<number, number[]>();
    const visit = (i: number, parent: number[]) => {
      const node = g.json.nodes[i];
      if (node.translation || node.rotation || node.scale) throw new Error(`${tile.file}: TRS nodes are not handled`);
      const m = node.matrix ? mul(parent, node.matrix) : parent;
      world.set(i, m);
      for (const c of node.children ?? []) visit(c, m);
    };
    for (const r of g.json.scenes[g.json.scene ?? 0].nodes) visit(r, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    for (const [nodeIndex, m] of world) {
      const inst = g.json.nodes[nodeIndex].extensions?.EXT_mesh_gpu_instancing;
      if (!inst) continue;
      const t = accessor(g, inst.attributes.TRANSLATION), fid = accessor(g, inst.attributes._FEATURE_ID_0);
      for (let k = 0; k < fid.length; k++) {
        const [gx, gy, gz] = apply(m, t[k * 3]!, t[k * 3 + 1]!, t[k * 3 + 2]!);
        const [x, y, z] = apply(tile.transform, gx, -gz, gy);
        const [lat, lon, h] = ecefToGeodetic(x, y, z);
        const [e, n] = geodeticToGk25(lat, lon);
        const rx = e - E0, rz = -(n - N0);
        if (rx < area.minX || rx > area.maxX || rz < area.minZ || rz > area.maxZ) continue;
        const p = rows[fid[k]!] ?? {};
        const id = String(p['id'] ?? `${tile.file}-${k}`);
        if (seen.has(id)) continue; // a tree on a tile border can sit in two neighbouring tiles
        seen.add(id);
        const height = Number(p['HEIGHT'] ?? p['height']), crown = Number(p['DIAMETER']);
        if (!(height > 0) || !(crown > 0)) throw new Error(`${id}: no height or crown diameter`);
        trees.push({ id, layer: index.layer, register: (p['puurekisteri'] as string) || null, genus: (p['suku'] as string) || null, species: (p['laji'] as string) || null,
          nameFi: (p['nimi'] as string) || null, site: (p['puisto'] as string) || (p['katu'] as string) || null, height, crown,
          trunkCm: typeof p['lapimitta'] === 'number' && p['lapimitta'] > 0 ? p['lapimitta'] : null, planted: typeof p['istvuosi'] === 'number' && p['istvuosi'] > 0 ? p['istvuosi'] : null,
          x: rx, z: rz, sourceBase: h - H0, ground: sampleTerrain(terrain, rx, rz) });
        // The plot layer names no genus; its mesh name is the city's guess (e.g. ID_Betula_pendula_50y_...).
        if (!trees[trees.length - 1]!.genus) trees[trees.length - 1]!.genus = (/^ID_([A-Z][a-z]+)_/.exec(g.json.meshes[g.json.nodes[nodeIndex].mesh].name)?.[1]) ?? null;
      }
    }
  }
}

// ---- placement ----
const lanePts = roads.lanes.map(l => ({ id: l.id, name: l.name, half: l.width / 2, pts: l.points.map(p => [p[0], -p[2]] as Pt) }));
const placed: { id: string; model: string; position: [number, number, number]; yaw: number; scale: [number, number, number]; height: number; crownRadius: number; trunkRadius: number; colliderHeight: number }[] = [];
const notes: { id: string; note: string }[] = [];
const hashUnit = (s: string) => parseInt(sha256(new TextEncoder().encode(s)).slice(0, 8), 16) / 0xffffffff;
for (const t of trees) {
  const model = MODEL_BY_GENUS[t.genus ?? ''] ?? DEFAULT_MODEL;
  const m = modelReport.models[model];
  if (!m) throw new Error(`model ${model} is not in scenery-trees`);
  const sy = t.height / m.refHeight;
  let sxz = t.crown / m.refCrownDiameter;
  const ratio = sxz / sy;
  if (ratio < CROWN_RATIO[0] || ratio > CROWN_RATIO[1]) { sxz = sy * Math.min(CROWN_RATIO[1], Math.max(CROWN_RATIO[0], ratio)); notes.push({ id: t.id, note: `crown ${t.crown} m on ${t.height} m held to ${(sxz * m.refCrownDiameter).toFixed(1)} m` }); }
  const inBuilding = fpGrid.containing(t.x, -t.z).some(f => pointInPolygon([t.x, -t.z], f.rings));
  let lane: { id: string; name: string | null; d: number } | null = null;
  for (const l of lanePts) for (let k = 0; k + 1 < l.pts.length; k++) {
    const d = segmentDistance([t.x, -t.z], l.pts[k]!, l.pts[k + 1]!).d - l.half;
    if (d < 0.5 && (!lane || d < lane.d)) lane = { id: l.id, name: l.name, d };
  }
  if (inBuilding) notes.push({ id: t.id, note: 'trunk inside a building footprint' });
  if (lane) notes.push({ id: t.id, note: `trunk ${lane.d < 0 ? 'on' : 'within 0.5 m of'} lane ${lane.id} (${lane.name ?? 'unnamed'}), no collider` });
  const trunkRadius = m.trunkRadiusBase * sxz;
  placed.push({ id: t.id, model, position: [round(t.x), round(t.ground - SINK), round(t.z)], yaw: round(hashUnit(t.id) * 2 * Math.PI, 4),
    scale: [round(sxz, 4), round(sy, 4), round(sxz, 4)], height: t.height, crownRadius: round(sxz * m.refCrownDiameter / 2), trunkRadius: round(trunkRadius), colliderHeight: lane || inBuilding ? 0 : TRUNK_COLLIDER_HEIGHT + SINK });
}
function round(v: number, d = 3) { const f = 10 ** d; return Math.round(v * f) / f; }

let preservation: { file: string; sha256: string; count: number; colliderOverrides: string[] } | null = null;
let finalPlaced = placed;
if (values['preserve-trees']) {
  const previousBytes = readFileSync(values['preserve-trees']);
  const previous = JSON.parse(previousBytes.toString('utf8'));
  if (previous.originId !== origin.id || previous.assetSha256 !== modelReport.glb.sha256) throw new Error('preserved trees use different origin or asset');
  const result = preserveTreePlacements(previous.trees as typeof placed, placed);
  finalPlaced = result.trees;
  preservation = {file:values['preserve-trees'], sha256:sha256(previousBytes), count:previous.trees.length, colliderOverrides:result.colliderOverrides};
}
mkdirSync(values.out!, { recursive: true });
const doc = { schemaVersion: 1, originId: origin.id, asset: 'scenery-trees', assetSha256: modelReport.glb.sha256,
  frame: 'runtime X-east, Y-up, Z-south; position is the trunk base; yaw about +Y in radians; scale applies to the model in its glTF frame; height and crownRadius are the drawn tree; colliderHeight 0 means no trunk collider',
  trees: finalPlaced };
writeFileSync(path.join(values.out!, 'trees.json'), JSON.stringify(doc, null, 1) + '\n');
const baseDiff = trees.map(t => t.sourceBase - t.ground).sort((a, b) => a - b);
const byModel: Record<string, number> = {}, byGenus: Record<string, number> = {};
for (const p of placed) byModel[p.model] = (byModel[p.model] ?? 0) + 1;
for (const t of trees) byGenus[t.genus ?? '?'] = (byGenus[t.genus ?? '?'] ?? 0) + 1;
const report = { schemaVersion: 1, builtAt: new Date().toISOString(), inputs, terrainSha256: terrainDoc.sha256, models: values.models, preservation, count: trees.length, byModel, byGenus,
  sourceBaseMinusTerrain: { min: round(baseDiff[0] ?? 0), median: round(baseDiff[baseDiff.length >> 1] ?? 0), max: round(baseDiff[baseDiff.length - 1] ?? 0) },
  notes, trees };
writeFileSync(path.join(values.out!, 'trees-report.json'), JSON.stringify(report, null, 1) + '\n');
console.log(JSON.stringify({ trees: trees.length, byModel, byGenus, sourceBaseMinusTerrain: report.sourceBaseMinusTerrain, notes: notes.length }));
for (const n of notes) console.log(`  ${n.id}: ${n.note}`);
