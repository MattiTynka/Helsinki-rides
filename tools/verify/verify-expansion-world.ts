// Independent decoded-visual and Rapier support probes for a bounded city expansion, before activation.
// node tools/verify/verify-expansion-world.ts --cells BUILD/cells --terrain BUILD/terrain-monument --roads BUILD/roads/roads.json --gameplay BUILD/gameplay/gameplay.json --assets BUILD/assets --baseline apps/game/public/world/ID --osm RAW/osm/central-expansion.json --out EVIDENCE/new
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { initPhysics, RAPIER, StaticWorld } from '../../packages/sim/src/index.ts';
import { geodeticToGk25, parseTerrain, pointAlong, sampleTerrain, type TriMeshCollider, type CellDescriptor, type GameplayBundle, type RoadGraph, type WorldManifest } from '../../packages/world-schema/src/index.ts';
import { loadGeoJsonPolygons, pointInPolygon, PolygonGrid, ringDistance } from '../world/lib/geometry.ts';
import { buildCoastalMask, sourceCoastalDecks } from '../world/lib/coastal-mask.ts';
import { loadCoastalRegistration, coastalMaskSha } from '../world/lib/coastal-registration.ts';
import { nativeGroundPoint, proveGroundRayEdge } from './lib/ground-query-precision.ts';
import { provePreservedTerrainVertexQuery } from './lib/terrain-query-preservation.ts';

type Pt = [number, number];
interface Check { id: string; pass: boolean; detail: unknown }
interface Probe { kind: string; id: string; x: number; z: number; visual: number | null; collision: number | null; surface: string | null; difference: number | null }
interface OsmElement { type: string; id: number; lat?: number; lon?: number; nodes?: number[]; tags?: Record<string, string> }
interface LandmarkSpec { label: string; type: 'way' | 'node'; id: number; roadRadius?: number }
interface WaterStructureSpec { buildingId: string; registerId: string; featureId: string; referenceUrl: string; kind: 'floating-sauna' | 'floating-restaurant' }
const { values } = parseArgs({ options: {
  cells: { type: 'string' }, terrain: { type: 'string' }, roads: { type: 'string' }, gameplay: { type: 'string' }, assets: { type: 'string' }, baseline: { type: 'string' }, osm: { type: 'string' }, out: { type: 'string' },
  'base-terrain': { type: 'string', default: 'data/work/m0/terrain-v2/terrain.bin' },
  'street-parts': { type: 'string', default: 'data/raw/central-expansion-20261017/street-parts/central-expansion.geojson' },
  'landmark-plan': { type: 'string' },
  'exact-terrain-overlap': { type: 'boolean', default: false },
  'coastal-water': { type: 'boolean', default: false },
  'coastal-registration': { type: 'string' },
  'supported-bridge-ways': { type: 'string', default: '' },
  'water-structures': { type: 'string' },
} });
for (const key of ['cells', 'terrain', 'roads', 'gameplay', 'assets', 'baseline', 'osm', 'out'] as const) if (!values[key]) throw new Error(`--${key} is required`);
if (existsSync(values.out!)) throw new Error('evidence output already exists');
mkdirSync(values.out!, { recursive: true });
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const files: Record<string, string> = {};
function bytes(file: string): Buffer { const b = readFileSync(file); files[file] = sha(b); return b; }
function json<T>(file: string): T { return JSON.parse(bytes(file).toString('utf8')) as T; }
bytes(fileURLToPath(import.meta.url));
bytes(fileURLToPath(new URL('./lib/ground-query-precision.ts', import.meta.url)));
bytes(fileURLToPath(new URL('./lib/terrain-query-preservation.ts', import.meta.url)));
const defaultLandmarks: LandmarkSpec[] = [{ label: 'Kluuvikatu', type: 'way', id: 19746151 }, { label: 'Rautatientori', type: 'way', id: 4247505 }, { label: 'Central station frontage / Kaivokatu', type: 'way', id: 29690379 }, { label: 'Teatteriesplanadi', type: 'way', id: 1530595566 }, { label: 'Kappeliesplanadi', type: 'way', id: 1530595568 }];
let landmarkSpecs = defaultLandmarks;
if (values['landmark-plan']) {
  const plan = json<{ schemaVersion: number; landmarks: LandmarkSpec[] }>(values['landmark-plan']);
  if (plan.schemaVersion !== 1 || !Array.isArray(plan.landmarks) || !plan.landmarks.length) throw new Error('landmark plan must have schemaVersion1 and nonempty landmarks');
  for (const spec of plan.landmarks) if (!spec || typeof spec.label !== 'string' || !spec.label.length || !['way', 'node'].includes(spec.type) || !Number.isSafeInteger(spec.id) || spec.id <= 0 || (spec.roadRadius !== undefined && !(Number.isFinite(spec.roadRadius) && spec.roadRadius > 0 && spec.roadRadius <= 200))) throw new Error('invalid source-bound landmark specification');
  landmarkSpecs = plan.landmarks;
}
const checks: Check[] = [], probes: Probe[] = [];
function check(id: string, pass: boolean, detail: unknown) { checks.push({ id, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${JSON.stringify(detail)}`); }
const cellIndex = json<{ cells: CellDescriptor[]; cellSize: number }>(path.join(values.cells!, 'cells.json'));
const cellReport = json<{ inputs: { cityModelSha256: string; terrainSha256: string; footprints: string; streetParts: string; osm: { sha256: string } }; supportTerrain: { path: string; sha256: string }; stairs: { flights: { id: string }[] }; retainingWalls: { walls: { id: string }[]; registerAlignment?: { id: string; registerId: string; source: Pt[]; authored: Pt[]; maxDeviation: number }[] } }>(path.join(values.cells!, 'report.json'));
const baseline = json<WorldManifest>(path.join(values.baseline!, 'manifest.json'));
const terrainMeta = json<{ file: string; sha256: string; authoredMonumentGround?: { placement: string; placementSha256: string; featherMetres: number; changedGridPoints: number } }>(path.join(values.terrain!, 'terrain.json'));
const authoredBytes = bytes(path.join(values.terrain!, terrainMeta.file));
if (sha(authoredBytes) !== terrainMeta.sha256 || cellReport.inputs.terrainSha256 !== terrainMeta.sha256) throw new Error('authored terrain differs from cell build');
const authored = parseTerrain(authoredBytes), priorAuthored = parseTerrain(bytes(values['base-terrain']!));
const supportBytes = bytes(path.join(values.cells!, cellReport.supportTerrain.path));
if (sha(supportBytes) !== cellReport.supportTerrain.sha256) throw new Error('support terrain differs from report');
const roads = json<RoadGraph>(values.roads!), gameplay = json<GameplayBundle>(values.gameplay!), area = gameplay.playArea;
const baselineGameplay = json<GameplayBundle>(path.join(values.baseline!, baseline.gameplay.path));
const inAcceptedArea = (x: number, z: number) => x >= baselineGameplay.playArea.minX && x <= baselineGameplay.playArea.maxX && z >= baselineGameplay.playArea.minZ && z <= baselineGameplay.playArea.maxZ;
const publicRoadKinds = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);
const publicLanes = new Set(roads.lanes.filter(lane => publicRoadKinds.has(lane.highway)).map(lane => lane.id));
const serviceLanes = new Set(roads.lanes.filter(lane => lane.highway === 'service').map(lane => lane.id));
// Derive the tested footprint from the actual cars, including tyre edges, rather than
// allowing a survey classification gap to hide a wall on a public driving route.
const vehicleHalfWidth = Math.max(...gameplay.vehicleDefinitions.flatMap(definition => [definition.collider.halfExtents[0], ...definition.wheels.map(wheel => Math.abs(wheel.position[0]) + definition.wheelWidth / 2)]));
if (!Number.isFinite(vehicleHalfWidth) || vehicleHalfWidth <= 0 || vehicleHalfWidth > 3) throw new Error('Invalid vehicle footprint for road continuity');
const vehicleAcrossOffsets = [...new Set([0, -vehicleHalfWidth, vehicleHalfWidth, ...gameplay.vehicleDefinitions.flatMap(definition => definition.wheels.flatMap(wheel => [wheel.position[0], wheel.position[0] - definition.wheelWidth / 2, wheel.position[0] + definition.wheelWidth / 2]))])].sort((a, b) => a - b);
const osm = json<{ elements: OsmElement[] }>(values.osm!);
if (files[values.osm!] !== roads.source.sha256 || files[values.osm!] !== cellReport.inputs.osm.sha256) throw new Error('OSM snapshot differs from cells or roads');
const osmWays = new Map(osm.elements.filter(e => e.type === 'way').map(e => [e.id, e]));
const osmNodes = new Map(osm.elements.filter(e => e.type === 'node').map(e => [e.id, e]));
const approvedWaterStructures: { spec: WaterStructureSpec; cell: string; building: CellDescriptor['buildings'][number]; footprint: ReturnType<typeof loadGeoJsonPolygons>[number] }[] = [];
const sourceWaterBuildingTriangles = new Map<string, number[][]>();
if (values['water-structures']) {
  if (!values['coastal-water']) throw new Error('water structures require the strict coastal-water checks');
  const plan = json<{ schemaVersion: number; buildingRegister: string; structures: WaterStructureSpec[]; sourceModel?: { directory: string; jsonSha256: string } }>(values['water-structures']);
  if (plan.schemaVersion !== 1 || typeof plan.buildingRegister !== 'string' || !Array.isArray(plan.structures) || !plan.structures.length || plan.structures.length > 16) throw new Error('invalid explicit water-structure declaration');
  const registry = json<{ features: { id: string; properties: Record<string, unknown> }[] }>(plan.buildingRegister);
  if (files[plan.buildingRegister] !== cellReport.inputs.footprints) throw new Error('water-structure register differs from the source of the cell build');
  const footprints = loadGeoJsonPolygons(plan.buildingRegister, baseline.origin.originProjected[0], baseline.origin.originProjected[1], (p, i) => String(p['vtj_prt'] ?? `register-${p['id'] ?? i}`));
  const seen = new Set<string>();
  for (const spec of plan.structures) {
    if (!spec || !['floating-sauna', 'floating-restaurant'].includes(spec.kind) || typeof spec.buildingId !== 'string' || typeof spec.registerId !== 'string' || typeof spec.featureId !== 'string' || typeof spec.referenceUrl !== 'string' || !spec.referenceUrl.startsWith('https://') || seen.has(spec.buildingId)) throw new Error('invalid or duplicate water-structure identity');
    seen.add(spec.buildingId);
    const expected = spec.kind === 'floating-sauna' ? { registerType: 'Sauna', collider: 'prism', host: 'www.allaspool.fi' } : { registerType: 'Muu rakennus', collider: 'citymodel', host: 'meripaviljonki.fi' };
    const reference = new URL(spec.referenceUrl);
    if (reference.protocol !== 'https:' || reference.hostname !== expected.host || reference.username || reference.password || reference.port) throw new Error(`water structure requires its reviewed primary reference host: ${spec.buildingId}`);
    const owner = cellIndex.cells.find(cell => cell.buildings.some(building => building.id === spec.buildingId)), building = owner?.buildings.find(building => building.id === spec.buildingId);
    const feature = registry.features.find(feature => feature.id === spec.featureId), footprint = footprints.find(footprint => footprint.id === spec.registerId);
    if (!owner || !building || building.match !== 'matched' || building.collider !== expected.collider || building.registerId !== spec.registerId || !feature || !footprint || feature.properties['tyyppi'] !== expected.registerType || feature.properties['tila'] !== 'voimassa' || String(feature.properties['vtj_prt'] ?? `register-${feature.properties['id']}`) !== spec.registerId) throw new Error(`water structure lacks its exact current matched register footprint and required collider: ${spec.buildingId}`);
    approvedWaterStructures.push({ spec, cell: owner.id, building, footprint });
  }
  if (!plan.sourceModel || !/^[a-f0-9]{64}$/.test(plan.sourceModel.jsonSha256)) throw new Error('water structures require their pinned original city-model source');
  type Slice = { offset: number; bytes: number };
  const modelFile = path.join(plan.sourceModel.directory, 'city-model.json');
  const model = json<{ originId: string; originProjected: number[]; binary: { file: string; bytes: number; sha256: string }; buildings: { id: string; triangles: number; parts: { positions: Slice; indices: Slice }[] }[] }>(modelFile);
  if (files[modelFile] !== plan.sourceModel.jsonSha256 || model.originId !== baseline.origin.id || JSON.stringify(model.originProjected) !== JSON.stringify(baseline.origin.originProjected) || model.binary.file !== 'city-model.bin' || model.binary.sha256 !== cellReport.inputs.cityModelSha256) throw new Error('water source model identity or origin differs from the original cell build');
  const binary = bytes(path.join(plan.sourceModel.directory, model.binary.file));
  if (binary.length !== model.binary.bytes || sha(binary) !== model.binary.sha256) throw new Error('water source model binary differs');
  for (const declaration of approvedWaterStructures) {
    const matches = model.buildings.filter(b => b.id === declaration.spec.buildingId);
    if (matches.length !== 1) throw new Error('water structure must have exactly one original source building');
    const source = matches[0]!, triangles: number[][] = [];
    for (const part of source.parts) {
      for (const slice of [part.positions, part.indices]) if (!Number.isSafeInteger(slice.offset) || !Number.isSafeInteger(slice.bytes) || slice.offset < 0 || slice.bytes <= 0 || slice.offset % 4 || slice.bytes % 4 || slice.offset + slice.bytes > binary.length) throw new Error('water source component slice invalid');
      const positions = new Float32Array(binary.buffer.slice(binary.byteOffset + part.positions.offset, binary.byteOffset + part.positions.offset + part.positions.bytes));
      const indices = new Uint32Array(binary.buffer.slice(binary.byteOffset + part.indices.offset, binary.byteOffset + part.indices.offset + part.indices.bytes));
      if (positions.length % 3 || indices.length % 3 || !positions.every(Number.isFinite) || !indices.every(i => i < positions.length / 3)) throw new Error('water source triangle arrays invalid');
      for (let i = 0; i < indices.length; i += 3) triangles.push([indices[i]!, indices[i + 1]!, indices[i + 2]!].flatMap(index => [positions[index * 3]!, positions[index * 3 + 2]!, Math.fround(-positions[index * 3 + 1]!)]));
    }
    if (!triangles.length || triangles.length !== source.triangles || source.triangles !== declaration.building.triangles) throw new Error('water source building triangle count differs from native owner');
    sourceWaterBuildingTriangles.set(source.id, triangles);
  }
}

// Measure the allowed terrain correction against the actual monument footprint, not a guessed bounding radius.
let footprint: Pt[] = [], feather = 0;
if (terrainMeta.authoredMonumentGround) {
  const spec = terrainMeta.authoredMonumentGround, placementBytes = bytes(spec.placement);
  if (sha(placementBytes) !== spec.placementSha256) throw new Error('monument placement changed');
  footprint = JSON.parse(placementBytes.toString('utf8')).placement.footprintRuntimeXZ as Pt[];
  feather = spec.featherMetres;
}
function distanceToFootprint(x: number, z: number): number {
  let inside = false, distance = Infinity;
  for (let i = 0, j = footprint.length - 1; i < footprint.length; j = i++) {
    const a = footprint[j]!, b = footprint[i]!;
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    const dx = b[0] - a[0], dz = b[1] - a[1], t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz)));
    distance = Math.min(distance, Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t));
  }
  return inside ? 0 : distance;
}
let oldTerrainSamples = 0, allowedTerrainChanges = 0;
const terrainChangesOutside: unknown[] = [];
for (let iz = 0; iz < priorAuthored.nz; iz++) for (let ix = 0; ix < priorAuthored.nx; ix++) {
  const x = priorAuthored.x0 + ix * priorAuthored.resolution, z = priorAuthored.z0 + iz * priorAuthored.resolution;
  const before = priorAuthored.heights[iz * priorAuthored.nx + ix]!, after = sampleTerrain(authored, x, z); oldTerrainSamples++;
  if (Math.abs(before - after) > 1e-7) {
    if (!values['exact-terrain-overlap'] && distanceToFootprint(x, z) <= feather + 1e-6) allowedTerrainChanges++;
    else terrainChangesOutside.push({ x, z, before, after });
  }
}
check('accepted-terrain-preservation', terrainChangesOutside.length === 0 && allowedTerrainChanges === (values['exact-terrain-overlap'] ? 0 : terrainMeta.authoredMonumentGround?.changedGridPoints ?? 0), { samples: oldTerrainSamples, allowedTerrainChanges, unexpected: terrainChangesOutside.length, mode: values['exact-terrain-overlap'] ? 'exact-accepted-authored-overlap' : 'original-with-monument-footprint-correction' });

// Index exported ground positions after decoder normalization and node transforms.
async function loadVisualGround(cells: readonly CellDescriptor[], root: string, structureDeclarations: typeof approvedWaterStructures = []) {
const primitives: { p: Float64Array; i: Uint32Array; node: string }[] = [], buckets = new Map<string, number[]>(), bucketSize = 4;
const structureTriangles = new Map<string, number[][]>(structureDeclarations.map(declaration => [declaration.spec.buildingId, []]));
let triangleCount = 0;
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
for (const cell of cells) {
  const data = bytes(path.join(root, cell.visual.lod0.path));
  if (sha(data) !== cell.visual.lod0.sha256) throw new Error(`cell visual hash mismatch: ${cell.id}`);
  const doc = await io.readBinary(data);
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh(); if (!mesh) continue;
    const isGround = node.getName().includes('_ground_') || mesh.getName().includes('_ground_');
    const localStructures = structureDeclarations.filter(declaration => declaration.cell === cell.id);
    if (!isGround && (!localStructures.length || node.getName().endsWith('_water') || mesh.getName().endsWith('_water'))) continue;
    const matrix = node.getWorldMatrix();
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION'), index = primitive.getIndices();
      if (!position || primitive.getMode() !== 4) throw new Error('ground primitive is not triangles');
      const p = new Float64Array(position.getCount() * 3), i = index ? Uint32Array.from(index.getArray()!) : Uint32Array.from({ length: position.getCount() }, (_, k) => k);
      for (let k = 0; k < position.getCount(); k++) { const v = position.getElement(k, []); for (let axis = 0; axis < 3; axis++) p[k * 3 + axis] = matrix[axis]! * v[0]! + matrix[4 + axis]! * v[1]! + matrix[8 + axis]! * v[2]! + matrix[12 + axis]!; }
      if (!isGround) {
        for (const declaration of localStructures) {
          const bounds = declaration.building.boundsRuntime, triangles = structureTriangles.get(declaration.spec.buildingId)!;
          for (let t = 0; t < i.length; t += 3) {
            const triangle = [i[t]!, i[t + 1]!, i[t + 2]!].flatMap(index => [p[index * 3]!, p[index * 3 + 1]!, p[index * 3 + 2]!]);
            if ([0, 3, 6].every(offset => [0, 1, 2].every(axis => triangle[offset + axis]! >= bounds.min[axis]! - .01 && triangle[offset + axis]! <= bounds.max[axis]! + .01))) triangles.push(triangle);
          }
        }
        continue;
      }
      const slot = primitives.length; primitives.push({ p, i, node: node.getName() });
      for (let t = 0; t < i.length; t += 3) {
        const a = i[t]! * 3, b = i[t + 1]! * 3, c = i[t + 2]! * 3;
        const determinant = (p[b + 2]! - p[c + 2]!) * (p[a]! - p[c]!) + (p[c]! - p[b]!) * (p[a + 2]! - p[c + 2]!);
        if (Math.abs(determinant) < 1e-10) continue;
        triangleCount++;
        for (let x = Math.floor(Math.min(p[a]!, p[b]!, p[c]!) / bucketSize); x <= Math.floor(Math.max(p[a]!, p[b]!, p[c]!) / bucketSize); x++) for (let z = Math.floor(Math.min(p[a + 2]!, p[b + 2]!, p[c + 2]!) / bucketSize); z <= Math.floor(Math.max(p[a + 2]!, p[b + 2]!, p[c + 2]!) / bucketSize); z++) {
          const key = `${x},${z}`, list = buckets.get(key) ?? []; list.push(slot * 4294967296 + t); buckets.set(key, list);
        }
      }
    }
  }
}
function visualHeight(x: number, z: number): number | null {
  // Rapier converts every query coordinate to Float32. Compare the visual surface at that same
  // physical point; a few micrometres of rounding can cross a perfectly valid 12 cm curb boundary.
  ({x,z}=nativeGroundPoint(x,z));
  let y = -Infinity;
  for (const code of buckets.get(`${Math.floor(x / bucketSize)},${Math.floor(z / bucketSize)}`) ?? []) {
    const slot = Math.floor(code / 4294967296), t = code % 4294967296, { p, i } = primitives[slot]!;
    const a = i[t]! * 3, b = i[t + 1]! * 3, c = i[t + 2]! * 3;
    const determinant = (p[b + 2]! - p[c + 2]!) * (p[a]! - p[c]!) + (p[c]! - p[b]!) * (p[a + 2]! - p[c + 2]!);
    const u = ((p[b + 2]! - p[c + 2]!) * (x - p[c]!) + (p[c]! - p[b]!) * (z - p[c + 2]!)) / determinant;
    const v = ((p[c + 2]! - p[a + 2]!) * (x - p[c]!) + (p[a]! - p[c]!) * (z - p[c + 2]!)) / determinant;
    if (u >= -1e-7 && v >= -1e-7 && u + v <= 1 + 1e-7) y = Math.max(y, u * p[a + 1]! + v * p[b + 1]! + (1 - u - v) * p[c + 1]!);
  }
  return Number.isFinite(y) ? y : null;
}
function structureHeight(id: string, x: number, z: number): number | null {
  return heightOnTriangles(structureTriangles.get(id) ?? [], x, z);
}
function trianglesNear(x: number, z: number, radius: number): number[][] {
  if (![x, z, radius].every(Number.isFinite) || radius <= 0 || radius > .2) throw new Error('bounded visual triangle neighborhood required');
  const codes = new Set<number>(), triangles: number[][] = [];
  for (let bx = Math.floor((x - radius) / bucketSize); bx <= Math.floor((x + radius) / bucketSize); bx++) for (let bz = Math.floor((z - radius) / bucketSize); bz <= Math.floor((z + radius) / bucketSize); bz++) for (const code of buckets.get(`${bx},${bz}`) ?? []) codes.add(code);
  for (const code of codes) {
    const slot = Math.floor(code / 4294967296), t = code % 4294967296, { p, i } = primitives[slot]!;
    const a = i[t]! * 3, b = i[t + 1]! * 3, c = i[t + 2]! * 3;
    if (Math.max(p[a]!, p[b]!, p[c]!) < x - radius || Math.min(p[a]!, p[b]!, p[c]!) > x + radius || Math.max(p[a + 2]!, p[b + 2]!, p[c + 2]!) < z - radius || Math.min(p[a + 2]!, p[b + 2]!, p[c + 2]!) > z + radius) continue;
    triangles.push([a, b, c].flatMap(index => [p[index]!, p[index + 1]!, p[index + 2]!]));
  }
  return triangles;
}
return { height: visualHeight, trianglesNear, triangleCount, structureHeight, structureTriangles };
}
function heightOnTriangles(triangles: readonly number[][], x: number, z: number): number | null {
  ({x,z}=nativeGroundPoint(x,z));
  let height = -Infinity;
  for (const p of triangles) {
    const denominator = (p[5]! - p[8]!) * (p[0]! - p[6]!) + (p[6]! - p[3]!) * (p[2]! - p[8]!);
    if (Math.abs(denominator) < 1e-10) continue;
    const u = ((p[5]! - p[8]!) * (x - p[6]!) + (p[6]! - p[3]!) * (z - p[8]!)) / denominator;
    const v = ((p[8]! - p[2]!) * (x - p[6]!) + (p[0]! - p[6]!) * (z - p[8]!)) / denominator;
    if (u >= -1e-7 && v >= -1e-7 && u + v <= 1 + 1e-7) height = Math.max(height, u * p[1]! + v * p[4]! + (1 - u - v) * p[7]!);
  }
  return Number.isFinite(height) ? height : null;
}
const currentVisual = await loadVisualGround(cellIndex.cells, values.cells!, approvedWaterStructures);
const visualHeight = currentVisual.height, triangleCount = currentVisual.triangleCount;
check('decoded-visual-ground', triangleCount > 0, { triangleCount, cells: cellIndex.cells.length });
await initPhysics();
const world = StaticWorld.fromBytes(supportBytes, roads, gameplay);
const groundColliders: TriMeshCollider[] = [], rayEdgeProofs: unknown[] = [];
for (const cell of cellIndex.cells) { const data = bytes(path.join(values.cells!, cell.collision.path)); if (sha(data) !== cell.collision.sha256) throw new Error(`collision hash mismatch ${cell.id}`); groundColliders.push(...world.addCell(cell.id, data).colliders.filter(c => c.group === 'ground')); }
world.physics.step();

function nativeGroundBelow(w:StaticWorld,x:number,y:number,z:number,distance:number){return w.groundBelow(Math.fround(x),Math.fround(y),Math.fround(z),distance);}
// Require strict HCOL containment at the actual Float32 query, opposing 1 mm rays, and a centered
// 1 cm shape cast. This distinguishes a shared-edge ray miss from a finite gap or displaced collider.
function proveRayEdge(w: StaticWorld, colliders: readonly TriMeshCollider[], height: (x: number, z: number) => number | null, x: number, z: number) {
  return proveGroundRayEdge({colliders,height,x,z,ray:(px,y,pz)=>nativeGroundBelow(w,px,y,pz,30),sphere:(px,y,pz,radius)=>{
    const hit=w.physics.castShape({x:px,y,z:pz},{x:0,y:0,z:0,w:1},{x:0,y:-1,z:0},new RAPIER.Ball(radius),0,30,true);
    return hit?{height:y-hit.time_of_impact-radius,contact:hit.witness1,surface:w.surfaceAt(hit.collider.handle,null)}:null;
  }});
}

const inArea = (x: number, z: number, inset = 0.2) => x >= area.minX + inset && x <= area.maxX - inset && z >= area.minZ + inset && z <= area.maxZ - inset;
function probe(kind: string, id: string, x: number, z: number): Probe {
  const visual = visualHeight(x, z), collision = nativeGroundBelow(world,x, (visual ?? sampleTerrain(authored, x, z)) + 0.5, z, 50);
  const result = { kind, id, x, z, visual, collision: collision?.y ?? null, surface: collision?.surface?.group ?? null, difference: visual === null || !collision ? null : collision.y - visual };
  probes.push(result); return result;
}
for (const lane of roads.lanes) for (let s = 0; s <= lane.length; s += 2) {
  const { point, tangent } = pointAlong(lane.points, s);
  for (const across of [-0.25, 0, 0.25]) { const x = point[0] - tangent[1] * lane.width * across, z = point[2] + tangent[0] * lane.width * across; if (inArea(x, z)) probe('lane', `${lane.id}:${s}:${across}`, x, z); }
}
const laneProbes = probes.filter(p => p.kind === 'lane');
const laneHoles = laneProbes.filter(p => p.visual === null || p.collision === null);
const laneMisalignment = laneProbes.filter(p => p.difference !== null && Math.abs(p.difference) > 0.035);
check('lane-ground-coverage', laneProbes.length > 1000 && laneHoles.length === 0, { samples: laneProbes.length, holes: laneHoles.length });
check('lane-visual-collision-alignment', laneMisalignment.length === 0, { mismatches: laneMisalignment.length, maxError: laneProbes.reduce((maximum, p) => Math.max(maximum, Math.abs(p.difference ?? 0)), 0) });

// A surface can agree perfectly with its collider yet contain a wall through a lane. Probe the full lane width
// (including both wheel tracks) at 25 cm across / 50 cm along; never start the physics ray below visible ground.
// The street register distinguishes a defective carriageway from OSM lanes overlapping a real driveway wall,
// staircase or sidewalk. Keep every such graph-registration conflict in the report for separate review.
bytes(values['street-parts']!);
if (files[values['street-parts']!] !== cellReport.inputs.streetParts) throw new Error('street survey differs from the ground build');
const survey = loadGeoJsonPolygons(values['street-parts']!, baseline.origin.originProjected[0], baseline.origin.originProjected[1], (p, i) => String(p['osan_id'] ?? i));
const surveyRoads = new PolygonGrid(survey.filter(p => (p.properties['paatyyppi'] === 'Ajorata' && p.properties['alatyyppi'] === 'Ajorata') || (p.properties['paatyyppi'] === 'Silta' && p.properties['alatyyppi'] === 'Ajorata (Silta)')), 16);
const carriagewaysAt = (x: number, z: number) => surveyRoads.candidates(x, -z).filter(p => pointInPolygon([x, -z], p.rings)).map(p => p.id);
let coastal = values['coastal-water'] ? buildCoastalMask(osm, { area, originProjected: baseline.origin.originProjected }) : null;
const coastalRegistration = values['coastal-registration'] ? (() => {
  if (!coastal) throw new Error('coastal registration requires the coastal-water checks');
  bytes(fileURLToPath(new URL('../world/lib/coastal-registration.ts', import.meta.url)));
  bytes(values['coastal-registration']!);
  const qualified = loadCoastalRegistration(values['coastal-registration']!, coastal, baseline.origin.originProjected, {streetPartsSha256: files[values['street-parts']!]!, osmSha256: files[values.osm!]!});
  for (const ref of Object.values(qualified.sources)) bytes(ref.file);
  coastal = qualified.mask;
  const reported = JSON.parse(readFileSync(path.join(values.cells!, 'report.json'), 'utf8')).coastal?.mask;
  if (coastalMaskSha(reported) !== coastalMaskSha(coastal)) throw new Error('candidate coastal report differs from independently qualified municipal registration');
  return qualified;
})() : null;
if (coastal) {
  bytes(fileURLToPath(new URL('../world/lib/coastal-mask.ts', import.meta.url)));
  bytes(fileURLToPath(new URL('../world/lib/geometry.ts', import.meta.url)));
}
const bridges = coastal ? sourceCoastalDecks(osm, survey, baseline.origin.originProjected) : { polygons: [], matches: [], pierWays: [], bridgeEndPartIds: [], separateDeckPartIds: [] };
const supportedBridgeIds = new Set(values['supported-bridge-ways'].split(',').filter(Boolean).map(Number));
if (supportedBridgeIds.size > 100 || [...supportedBridgeIds].some(id => !Number.isSafeInteger(id) || id <= 0 || !bridges.matches.some(match => match.way === id))) throw new Error('supported bridge ways must be explicit OSM IDs with source-register deck matches in coastal mode');
const waterGrid = new PolygonGrid(coastal?.water ?? [], 32), bridgeGrid = new PolygonGrid(bridges.polygons, 16);
const waterAt = (x: number, z: number) => waterGrid.containing(x, -z);
const isWaterOnly = (x: number, z: number) => waterAt(x, z).length > 0 && !bridgeGrid.containing(x, -z).length;
const coastalExclusions: { kind: string; id: string; x: number; z: number }[] = [];
const registeredBankProbes: Probe[] = [];
if (coastalRegistration) {
  for (const polygon of coastalRegistration.correction) for (let x = polygon.bbox[0] + .5; x < polygon.bbox[2]; x += 2) for (let z = -polygon.bbox[3] + .5; z < -polygon.bbox[1]; z += 2) {
    if (!pointInPolygon([x, -z], polygon.rings) || polygon.rings.some(ring => ringDistance([x, -z], ring) < .1)) continue;
    registeredBankProbes.push(probe('municipal-bank', polygon.id, x, z));
  }
  check('municipal-bank-has-native-soil', registeredBankProbes.length > 100 && registeredBankProbes.every(p => p.visual !== null && p.collision !== null && p.surface === 'ground' && Math.abs(p.difference ?? 1) <= .035), {samples: registeredBankProbes.length, failures: registeredBankProbes.filter(p => p.visual === null || p.collision === null || p.surface !== 'ground' || Math.abs(p.difference ?? 1) > .035), registration: coastalRegistration.receipt, authority: coastalRegistration.audit});
}
interface LaneSupport { x: number; z: number; s: number; across: number; visual: number | null; collision: number | null; surface: string | null }
const laneStepIssues: { lane: string; axis: string; delta: number; distance: number; carriageways: string[]; a: LaneSupport; b: LaneSupport }[] = [];
const laneWheelMisalignment: unknown[] = [];
const publicRoadWheelMisalignment: unknown[] = [];
const serviceRoadWheelMisalignment: unknown[] = [];
const approvedBridgeSamples = new Map<number, number>();
let wheelSamples = 0, maxCarriagewayStep = 0, wheelEdgeProofCount = 0, publicFootprintSamples = 0, maxPublicRoadStep = 0, serviceFootprintSamples = 0, maxServiceRoadStep = 0;
const isExpandedPublicFootprint = (lane: string, p: LaneSupport) => publicLanes.has(lane) && Math.abs(p.across) <= vehicleHalfWidth + 1e-8 && !inAcceptedArea(p.x, p.z);
const isExpandedPublicPair = (lane: string, a: LaneSupport, b: LaneSupport) => publicLanes.has(lane) && Math.max(Math.abs(a.across), Math.abs(b.across)) <= vehicleHalfWidth + 1e-8 && !(inAcceptedArea(a.x, a.z) && inAcceptedArea(b.x, b.z));
const isExpandedServiceFootprint = (lane: string, p: LaneSupport) => serviceLanes.has(lane) && Math.abs(p.across) <= vehicleHalfWidth + 1e-8 && !inAcceptedArea(p.x, p.z);
const isExpandedServicePair = (lane: string, a: LaneSupport, b: LaneSupport) => serviceLanes.has(lane) && Math.max(Math.abs(a.across), Math.abs(b.across)) <= vehicleHalfWidth + 1e-8 && !(inAcceptedArea(a.x, a.z) && inAcceptedArea(b.x, b.z));
function compareWheelSupport(lane: string, axis: string, a: LaneSupport | null, b: LaneSupport | null) {
  if (!a || !b || a.visual === null || b.visual === null) return;
  const distance = Math.hypot(a.x - b.x, a.z - b.z);
  if (distance > 0.8) return; // A sharp polyline corner is not a neighboring sample pair.
  const delta = Math.abs(a.visual - b.visual), aRoads = carriagewaysAt(a.x, a.z), bRoads = carriagewaysAt(b.x, b.z);
  const carriageways = aRoads.filter(id => bRoads.includes(id));
  if (carriageways.length) maxCarriagewayStep = Math.max(maxCarriagewayStep, delta);
  if (isExpandedPublicPair(lane, a, b)) maxPublicRoadStep = Math.max(maxPublicRoadStep, delta);
  if (isExpandedServicePair(lane, a, b)) maxServiceRoadStep = Math.max(maxServiceRoadStep, delta);
  if (delta > 0.35) laneStepIssues.push({ lane, axis, delta, distance, carriageways, a, b });
}
for (const lane of roads.lanes) {
  const alongCount = Math.ceil(lane.length / 0.5), acrossCount = Math.ceil(lane.width / 0.25);
  const acrossOffsets = [...new Set([...Array.from({ length: acrossCount + 1 }, (_, j) => -lane.width / 2 + lane.width * j / Math.max(1, acrossCount)), ...vehicleAcrossOffsets])].sort((a, b) => a - b);
  let previous: (LaneSupport | null)[] | null = null;
  for (let i = 0; i <= alongCount; i++) {
    const s = lane.length * i / Math.max(1, alongCount), { point, tangent } = pointAlong(lane.points, s), row: (LaneSupport | null)[] = [];
    for (let j = 0; j < acrossOffsets.length; j++) {
      const across = acrossOffsets[j]!, x = point[0] - tangent[1] * across, z = point[2] + tangent[0] * across;
      if (!inArea(x, z)) { row.push(null); continue; }
      const visual = visualHeight(x, z), hit = nativeGroundBelow(world,x, (visual ?? sampleTerrain(authored, x, z)) + 0.5, z, 50);
      const p: LaneSupport = { x, z, s, across, visual, collision: hit?.y ?? null, surface: hit?.surface?.group ?? null }; row.push(p); wheelSamples++;
      const onCarriageway = carriagewaysAt(x, z).length > 0;
      const approvedBridge = supportedBridgeIds.has(lane.wayId);
      const publicFootprint = isExpandedPublicFootprint(lane.id, p);
      const serviceFootprint = isExpandedServiceFootprint(lane.id, p);
      if (publicFootprint) publicFootprintSamples++;
      if (serviceFootprint) serviceFootprintSamples++;
      if (approvedBridge) approvedBridgeSamples.set(lane.wayId, (approvedBridgeSamples.get(lane.wayId) ?? 0) + 1);
      if ((onCarriageway || approvedBridge || publicFootprint || serviceFootprint) && (visual === null || p.collision === null || p.surface !== 'ground' || Math.abs(visual - p.collision) > 0.035)) {
        const proof = visual === null ? null : proveRayEdge(world, groundColliders, visualHeight, x, z);
        if (proof?.pass) wheelEdgeProofCount++;
        else {
          if (onCarriageway || approvedBridge) laneWheelMisalignment.push({ lane: lane.id, ...p, proof });
          if (publicFootprint) publicRoadWheelMisalignment.push({ lane: lane.id, ...p, proof });
          if (serviceFootprint) serviceRoadWheelMisalignment.push({ lane: lane.id, ...p, proof });
        }
      }
      if (j) compareWheelSupport(lane.id, 'across', row[j - 1]!, p);
      if (previous) compareWheelSupport(lane.id, 'along', previous[j]!, p);
    }
    previous = row;
  }
}
const laneWayIds = new Map(roads.lanes.map(lane => [lane.id, lane.wayId]));
const carriagewaySteps = laneStepIssues.filter(p => p.carriageways.length > 0 || supportedBridgeIds.has(laneWayIds.get(p.lane) ?? -1));
const publicRoadSteps = laneStepIssues.filter(p => isExpandedPublicPair(p.lane, p.a, p.b));
const serviceRoadSteps = laneStepIssues.filter(p => isExpandedServicePair(p.lane, p.a, p.b));
check('lane-wheel-footprint-support', laneWheelMisalignment.length === 0, { samples: wheelSamples, mismatches: laneWheelMisalignment.length, independentlyProvenRayEdges: wheelEdgeProofCount });
check('surveyed-carriageway-continuity', carriagewaySteps.length === 0, { samples: wheelSamples, abruptSteps: carriagewaySteps.length, maxCarriagewayStep, maxAlongMetres: 0.5, maxAcrossMetres: 0.25, thresholdMetres: 0.35, otherSurfaceRegistrationFlags: laneStepIssues.length - carriagewaySteps.length });
check('expanded-public-road-vehicle-footprint-support', publicRoadWheelMisalignment.length === 0, { samples: publicFootprintSamples, mismatches: publicRoadWheelMisalignment.length, halfWidthMetres: vehicleHalfWidth, exactVehicleAcrossOffsets: vehicleAcrossOffsets, acceptedArea: baselineGameplay.playArea });
check('expanded-public-road-vehicle-footprint-continuity', publicRoadSteps.length === 0, { abruptSteps: publicRoadSteps.length, maxStepMetres: maxPublicRoadStep, thresholdMetres: 0.35, halfWidthMetres: vehicleHalfWidth, exactVehicleAcrossOffsets: vehicleAcrossOffsets, publicHighways: [...publicRoadKinds], acceptedArea: baselineGameplay.playArea, note: 'New public road vehicle footprints participate even where adjoining samples have different or missing street-register carriageway IDs. Existing accepted-area conflicts remain in the complete issue list.' });
check('expanded-service-road-vehicle-footprint-support', serviceRoadWheelMisalignment.length === 0, { samples: serviceFootprintSamples, mismatches: serviceRoadWheelMisalignment.length, halfWidthMetres: vehicleHalfWidth, exactVehicleAcrossOffsets: vehicleAcrossOffsets });
check('expanded-service-road-vehicle-footprint-continuity', serviceRoadSteps.length === 0, { abruptSteps: serviceRoadSteps.length, maxStepMetres: maxServiceRoadStep, thresholdMetres: 0.35, halfWidthMetres: vehicleHalfWidth, note: 'Every service lane retained in the new-area driving graph must support the actual cars. A missing private-access tag is not an exemption, and unsupported paths require source-bound repair or a documented graph closure.' });
if (supportedBridgeIds.size) check('approved-surface-bridge-lanes-covered', [...supportedBridgeIds].every(id => (approvedBridgeSamples.get(id) ?? 0) > 0), { ways: [...supportedBridgeIds], fullWidthSamples: Object.fromEntries(approvedBridgeSamples), note: 'All approved bridge samples participate in the strict lane-wheel-footprint and continuity gates, including points beyond a registered deck edge.' });

for (const axis of ['x', 'z'] as const) {
  const lower = axis === 'x' ? area.minX : area.minZ, upper = axis === 'x' ? area.maxX : area.maxZ;
  const otherMin = axis === 'x' ? area.minZ : area.minX, otherMax = axis === 'x' ? area.maxZ : area.maxX;
  for (let edge = Math.ceil(lower / cellIndex.cellSize) * cellIndex.cellSize; edge < upper; edge += cellIndex.cellSize) for (let other = otherMin + 0.3; other < otherMax - 0.3; other += 4) for (const delta of [-0.02, 0, 0.02]) {
    const x = axis === 'x' ? edge + delta : other, z = axis === 'z' ? edge + delta : other;
    if (inArea(x, z)) {
      const id = `${axis}:${edge}:${other}:${delta}`;
      if (isWaterOnly(x, z)) coastalExclusions.push({ kind: 'cell-seam', id, x, z });
      else probe('cell-seam', id, x, z);
    }
  }
  for (const edge of [lower + 0.25, upper - 0.25]) for (let other = otherMin + 0.25; other <= otherMax - 0.25; other += 3) {
    const x = axis === 'x' ? edge : other, z = axis === 'z' ? edge : other, id = `${axis}:${edge}:${other}`;
    if (isWaterOnly(x, z)) coastalExclusions.push({ kind: 'boundary', id, x, z });
    else probe('boundary', id, x, z);
  }
}
for (const kind of ['cell-seam', 'boundary']) {
  const subset = probes.filter(p => p.kind === kind), rawMissing = subset.filter(p => p.visual === null || p.collision === null), rawMismatches = subset.filter(p => p.surface === 'ground' && p.difference !== null && Math.abs(p.difference) > 0.035);
  const unproven=(p:Probe)=>{const proof=p.visual===null?null:proveRayEdge(world,groundColliders,visualHeight,p.x,p.z);rayEdgeProofs.push({kind,raw:p,proof});return !proof?.pass;};
  const missing=rawMissing.filter(unproven),mismatched=rawMismatches.filter(unproven);
  check(`${kind}-coverage`, subset.length > 100 && !missing.length && !mismatched.length, { samples: subset.length, rawMissing:rawMissing.length, holes: missing.length, groundMismatches: mismatched.length, provenZeroWidthRayMisses: rawMissing.length-missing.length+rawMismatches.length-mismatched.length, buildingOrPropObstructions: subset.filter(p => p.surface !== 'ground' && p.surface !== 'terrain').length, sourceWaterSamples: coastalExclusions.filter(p => p.kind === kind).length });
}

const waterProbes: { x: number; z: number; visual: number | null; safetyHeight: number; hit: ReturnType<StaticWorld['groundBelow']>; groundHit: ReturnType<StaticWorld['groundBelow']>; structureProof: { buildingId: string; registerId: string; referenceUrl: string; visibleRoof: number; collisionRoof: number; sourceRoof: number; difference: number; sourceTriangles: number } | null; pass: boolean }[] = [];
const bridgeProbes: Probe[] = [];
if (coastal) {
  const safety = parseTerrain(supportBytes);
  for (let x = area.minX + 1; x < area.maxX; x += 8) for (let z = area.minZ + 1; z < area.maxZ; z += 8) {
    const waters = waterAt(x, z);
    if (!waters.length || bridgeGrid.containing(x, -z).length || waters.every(p => p.rings.some(ring => ringDistance([x, -z], ring) < .1))) continue;
    const visual = visualHeight(x, z), safetyHeight = sampleTerrain(safety, x, z);
    const originY = Math.max(sampleTerrain(authored, x, z), -baseline.origin.originProjected[2]) + 10;
    const distance = Math.max(50, originY - gameplay.killHeight + 10), hit = nativeGroundBelow(world,x, originY, z, distance);
    // An explicitly registered floating structure may have its visible roof collider. Ground
    // must still be absent underneath it; a first-hit roof cannot hide paving.
    const groundRay = world.physics.castRay(new RAPIER.Ray({ x:Math.fround(x), y:Math.fround(originY), z:Math.fround(z) }, { x: 0, y: -1, z: 0 }), distance, true, undefined, undefined, undefined, undefined, collider => world.surfaceAt(collider.handle, null)?.group === 'ground');
    const groundHit = groundRay ? { y: Math.fround(originY) - groundRay.timeOfImpact, surface: world.surfaceAt(groundRay.collider.handle, null) } : null;
    let structureProof: typeof waterProbes[number]['structureProof'] = null;
    if (hit?.surface?.group === 'buildings') {
      const declaration = approvedWaterStructures.find(declaration => declaration.spec.buildingId === hit.surface!.ref);
      if (declaration && pointInPolygon([x, -z], declaration.footprint.rings)) {
        const roof = currentVisual.structureHeight(declaration.spec.buildingId, x, z), sourceRoof = heightOnTriangles(sourceWaterBuildingTriangles.get(declaration.spec.buildingId) ?? [], x, z);
        if (roof !== null && sourceRoof !== null && sourceRoof > -baseline.origin.originProjected[2] && Math.abs(roof - hit.y) <= .035 && Math.abs(sourceRoof - hit.y) <= .035) structureProof = {
          buildingId: declaration.spec.buildingId, registerId: declaration.spec.registerId, referenceUrl: declaration.spec.referenceUrl,
          visibleRoof: roof, collisionRoof: hit.y, sourceRoof, difference: hit.y - roof,
          sourceTriangles: sourceWaterBuildingTriangles.get(declaration.spec.buildingId)?.length ?? 0,
        };
      }
    }
    const pass = visual === null && safetyHeight < gameplay.killHeight - 1 && (!groundHit || groundHit.y < gameplay.killHeight - 1) && (!hit || hit.y < gameplay.killHeight - 1 || structureProof !== null);
    waterProbes.push({ x, z, visual, safetyHeight, hit, groundHit, structureProof, pass });
  }
  for (const deck of bridges.polygons) {
    for (let x = deck.bbox[0] + .5; x < deck.bbox[2]; x += 1) for (let y = deck.bbox[1] + .5; y < deck.bbox[3]; y += 1) {
      if (!pointInPolygon([x, y], deck.rings) || deck.rings.some(ring => ringDistance([x, y], ring) < .1) || !waterAt(x, -y).length || !inArea(x, -y)) continue;
      bridgeProbes.push(probe('source-coastal-deck', deck.id, x, -y));
    }
  }
  check('source-water-has-no-walkable-ground', waterProbes.length > 0 && waterProbes.every(p => p.pass), { samples: waterProbes.length, failures: waterProbes.filter(p => !p.pass).length, independentlyProvenFloatingStructureSamples: waterProbes.filter(p => p.structureProof).length, groundCheckedBelowVisibleStructures: true, gridStepMetres: 8, coastBoundaryInsetMetres: .1, sources: coastal.sources });
  if (approvedWaterStructures.length) check('declared-floating-structures-proven', approvedWaterStructures.every(declaration => waterProbes.some(probe => probe.structureProof?.buildingId === declaration.spec.buildingId)), approvedWaterStructures.map(declaration => ({ buildingId: declaration.spec.buildingId, registerId: declaration.spec.registerId, referenceUrl: declaration.spec.referenceUrl, verifiedSamples: waterProbes.filter(probe => probe.structureProof?.buildingId === declaration.spec.buildingId).length })));
  check('registered-bridge-decks-supported', (!bridges.polygons.length || bridgeProbes.length > 0) && bridgeProbes.every(p => p.visual !== null && p.collision !== null && p.surface === 'ground' && Math.abs(p.difference ?? 1) <= .035), { sourceMatches: bridges.matches, sourcePierWays: bridges.pierWays, bridgeEndPartIds: bridges.bridgeEndPartIds, separateDeckPartIds: bridges.separateDeckPartIds, sourcePolygonIds: bridges.polygons.map(p => p.id), samples: bridgeProbes.length, failures: bridgeProbes.filter(p => p.visual === null || p.collision === null || p.surface !== 'ground' || Math.abs(p.difference ?? 1) > .035).length });
}

const unsupported = [...osmWays.values()].filter(e => { const t = e.tags ?? {}; return (t.tunnel && t.tunnel !== 'no') || (t.bridge && t.bridge !== 'no' && !supportedBridgeIds.has(e.id)) || (t.indoor && t.indoor !== 'no') || Number(t.layer ?? 0) < 0; });
const unsupportedIds = new Set(unsupported.map(e => e.id));
const unsupportedLanes = roads.lanes.filter(l => unsupportedIds.has(l.wayId));
const unsupportedFootways = roads.footways.filter(f => unsupportedIds.has(Number(f.id.replace(/^w/, ''))));
const unsupportedFlights = cellReport.stairs.flights.filter(f => unsupportedIds.has(Number(f.id.replace(/^osm-way-/, ''))));
check('unsupported-separate-level-ways-excluded', !unsupportedLanes.length && !unsupportedFootways.length && !unsupportedFlights.length, { sourceWays: unsupported.length, registeredSurfaceBridgeWays: [...supportedBridgeIds], lanes: unsupportedLanes.map(l => l.id), footways: unsupportedFootways.map(f => f.id), flights: unsupportedFlights });

// Use the complete accepted collision world to detect rebuild regressions inside its original support footprint.
const oldWorld = StaticWorld.fromBytes(bytes(path.join(values.baseline!, baseline.terrain.path)), json<RoadGraph>(path.join(values.baseline!, baseline.roads.path)), baselineGameplay);
const oldGroundColliders: TriMeshCollider[] = [];
for (const c of baseline.cells) oldGroundColliders.push(...oldWorld.addCell(c.id, bytes(path.join(values.baseline!, c.collision.path))).colliders.filter(c => c.group === 'ground'));
oldWorld.physics.step();
const oldVisual = await loadVisualGround(baseline.cells, values.baseline!);
const oldArea = oldWorld.gameplay.playArea, oldSupportChanges: unknown[] = [], oldVisualChanges: unknown[] = [], correctedOldSupport: unknown[] = []; let oldSupportSamples = 0;
const registeredPriorWater: unknown[] = [];
for (let x = oldArea.minX + 5; x <= oldArea.maxX - 5; x += 3) for (let z = oldArea.minZ + 5; z <= oldArea.maxZ - 5; z += 3) {
  if ((!values['exact-terrain-overlap'] && distanceToFootprint(x, z) <= feather + 4) || x <= oldArea.minX + 5 || x >= oldArea.maxX - 5 || z <= oldArea.minZ + 5 || z >= oldArea.maxZ - 5) continue;
  if (isWaterOnly(x, z)) { coastalExclusions.push({ kind: 'accepted-interior-source-water', id: `${x}:${z}`, x, z }); continue; }
  const beforeVisual = oldVisual.height(x, z), afterVisual = visualHeight(x, z);
  const y = Math.max(beforeVisual ?? -Infinity, afterVisual ?? -Infinity, sampleTerrain(priorAuthored, x, z)) + 2;
  const before = nativeGroundBelow(oldWorld,x, y, z, 30), after = nativeGroundBelow(world,x, y, z, 30); oldSupportSamples++;
  if (coastalRegistration?.correction.some(p => pointInPolygon([x, -z], p.rings)) && beforeVisual === null && (!before || before.y < gameplay.killHeight - 1) && afterVisual !== null && after?.surface?.group === 'ground' && Math.abs(after.y - afterVisual) <= .035) {
    registeredPriorWater.push({x, z, beforeVisual, before, afterVisual, after});
    continue;
  }
  if (((beforeVisual === null) !== (afterVisual === null)) || (beforeVisual !== null && afterVisual !== null && Math.abs(beforeVisual - afterVisual) > 0.035)) oldVisualChanges.push({ x, z, beforeVisual, afterVisual });
  if ((!before !== !after) || (before && after && Math.abs(before.y - after.y) > 0.035)) {
    const detail = { x, z, beforeVisual, afterVisual, before, after };
    if (after && afterVisual !== null && Math.abs(after.y - afterVisual) <= 0.035 && (!before || beforeVisual === null || Math.abs(before.y - beforeVisual) > 0.035)) correctedOldSupport.push(detail);
    else {
      const beforeProof = proveRayEdge(oldWorld, oldGroundColliders, oldVisual.height, x, z), afterProof = proveRayEdge(world, groundColliders, visualHeight, x, z);
      if (beforeProof.pass && afterProof.pass) rayEdgeProofs.push({ kind: 'accepted-interior', raw: detail, beforeProof, afterProof });
      else {
        const terrainProof = provePreservedTerrainVertexQuery({
          before: { source: priorAuthored, world: oldWorld, groundColliders: oldGroundColliders, visualHeight: oldVisual.height, visualTrianglesNear: oldVisual.trianglesNear },
          after: { source: authored, world, groundColliders, visualHeight, visualTrianglesNear: currentVisual.trianglesNear },
          x, z, originY: Math.fround(y), observedBefore: before, observedAfter: after,
        });
        if (terrainProof.pass) rayEdgeProofs.push({ kind: 'accepted-interior-preserved-terrain-vertex', raw: detail, proof: terrainProof });
        else oldSupportChanges.push({ ...detail, beforeProof, afterProof, terrainProof });
      }
    }
  }
}
check('accepted-interior-visual-preservation', !oldVisualChanges.length, { samples: oldSupportSamples, changed: oldVisualChanges.length, boundaryExcludedMetres: 5, monumentFootprintMargin: values['exact-terrain-overlap'] ? 0 : feather + 4, correctedSourceWaterSamples: coastalExclusions.filter(p => p.kind === 'accepted-interior-source-water').length, independentlyQualifiedMunicipalBankSamples: registeredPriorWater });
check('accepted-interior-collision-preservation', !oldSupportChanges.length, { samples: oldSupportSamples, unexpectedChanges: oldSupportChanges.length, correctedPriorMisalignments: correctedOldSupport.length, preservedTerrainVertexQueries: rayEdgeProofs.filter((p: any) => p.kind === 'accepted-interior-preserved-terrain-vertex').length, boundaryExcludedMetres: 5, correctedSourceWaterSamples: coastalExclusions.filter(p => p.kind === 'accepted-interior-source-water').length, independentlyQualifiedMunicipalBankSamples: registeredPriorWater.length });

const landmarks = landmarkSpecs.map(spec => {
  const element = (spec.type === 'way' ? osmWays : osmNodes).get(spec.id); if (!element) throw new Error(`landmark missing ${spec.id}`);
  const nodes = element.nodes ? element.nodes.map(id => osmNodes.get(id)!) : [element];
  if (!nodes.length || nodes.some(node => !node || !Number.isFinite(node.lat) || !Number.isFinite(node.lon))) throw new Error(`landmark has missing or invalid source coordinates: ${spec.id}`);
  const lat = nodes.reduce((n, p) => n + p.lat!, 0) / nodes.length, lon = nodes.reduce((n, p) => n + p.lon!, 0) / nodes.length;
  const [e, n] = geodeticToGk25(lat, lon), x = e - baseline.origin.originProjected[0], z = baseline.origin.originProjected[1] - n;
  const nearest = world.roads.nearestLane(x, z, undefined, spec.roadRadius ?? 200);
  return { ...spec, sourceUrl: `https://www.openstreetmap.org/${spec.type}/${spec.id}`, reference: probe('landmark', spec.label, x, z), nearestLane: nearest ? { id: nearest.laneId, distance: nearest.distance, point: nearest.point, support: probe('landmark-road', spec.label, nearest.point[0], nearest.point[2]) } : null };
});
check('expansion-landmark-support', landmarks.every(l => l.reference.visual !== null && l.nearestLane?.support.surface === 'ground' && Math.abs(l.nearestLane.support.difference ?? 1) <= 0.035), landmarks.map(l => ({ label: l.label, reference: [l.reference.x, l.reference.z], road: l.nearestLane?.point, surface: l.nearestLane?.support.surface })));
const assets = baseline.assets.map(asset => { const p = path.join(values.assets!, `${asset.id}.glb`), actual = bytes(p); return { id: asset.id, path: p, expected: asset.sha256, actual: sha(actual), bytes: actual.length, pass: actual.length === asset.bytes && sha(actual) === asset.sha256 }; });
check('accepted-assets-byte-exact', assets.every(a => a.pass), assets.map(a => ({ id: a.id, pass: a.pass })));

oldWorld.physics.free(); world.physics.free();
const report = { status: checks.every(c => c.pass) ? 'PASS' : 'FAIL', checks, files, assets, landmarks, sampling: { laneStepMetres: 2, laneAcrossFractions: [-0.25, 0, 0.25], wheelFootprintAlongMetres: 0.5, wheelFootprintAcrossMetres: 0.25, wheelFootprintFullLaneWidth: true, vehicleHalfWidthMetres: vehicleHalfWidth, exactVehicleAcrossOffsets: vehicleAcrossOffsets, abruptStepThresholdMetres: 0.35, cellSeamStepMetres: 4, cellSeamOffsets: [-0.02, 0, 0.02], boundaryStepMetres: 3, acceptedInteriorGridMetres: 3, supportToleranceMetres: 0.035, queryCoordinatePrecision: 'Every requested sample is retained; decoded visual/HCOL and physics comparisons use the same native Float32 X/Z coordinates. Raw requested coordinates remain in probes and proof records.' }, limitations: ['Static downward rays do not prove driving, steering, streamed residency, visual facade quality or horizontal wall closure.', 'Zero-width ray edge misses require strict decoded-collider containment at the actual Float32 query, two opposing 1 mm native queries, and a centered 1 cm sphere cast; all raw misses and exact supporting triangles are retained. Double-precision requested coordinates can round across an existing curb, so visual comparison uses the actual native query point.', 'Building and prop obstructions are recorded separately on general seam and boundary probes; a road sample obstruction still fails alignment.', 'All full-width discontinuities are recorded; continuity is mandatory within a shared surveyed carriageway polygon and throughout new public road vehicle footprints, including different/missing survey IDs. Retained new service-road vehicle footprints are also mandatory. Other full-lane-edge registration conflicts remain recorded for separate source review.'], issues: { terrainChangesOutside, laneHoles, laneMisalignment, laneWheelMisalignment, publicRoadWheelMisalignment, serviceRoadWheelMisalignment, laneStepIssues, carriagewaySteps, publicRoadSteps, serviceRoadSteps, oldSupportChanges, oldVisualChanges, correctedOldSupport, rayEdgeProofs, unsupportedLanes, unsupportedFootways, unsupportedFlights }, probes };
Object.assign(report, { coastal: coastal ? { sources: coastal.sources, stats: coastal.stats, exclusions: coastalExclusions, waterProbes, bridgeProbes, registeredBridges: bridges.matches, sourcePierWays: bridges.pierWays, bridgeEndPartIds: bridges.bridgeEndPartIds, separateDeckPartIds: bridges.separateDeckPartIds, sourceCoastalDecks: bridges.polygons.map(p => ({ id: p.id, bbox: p.bbox })), declaredFloatingStructures: approvedWaterStructures.map(declaration => ({ ...declaration.spec, cell: declaration.cell, bounds: declaration.building.boundsRuntime })) } : null });
writeFileSync(path.join(values.out!, 'world.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, checks: checks.length, probes: probes.length, output: path.join(values.out!, 'world.json') }));
if (report.status !== 'PASS') process.exitCode = 1;
