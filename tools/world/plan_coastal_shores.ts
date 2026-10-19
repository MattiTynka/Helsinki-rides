// Read-only coastal closure planning. The geometry selector is shared with the
// source-bound shore preflight; application belongs to the append-only writer.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { parseCollisionBundle, type CellDescriptor, type FileRef } from '../../packages/world-schema/src/index.ts';
import { buildCoastalMask, sourceCoastalDecks, type CoastalOsm } from './lib/coastal-mask.ts';
import { loadCoastalRegistration } from './lib/coastal-registration.ts';
import { loadGeoJsonPolygons } from './lib/geometry.ts';
import { qualifyCoastalShoreSeals, sourceShoreSegments, type ShoreMesh, type ShorePoint, type ShoreSeal, type ShoreSealOptions, type ShoreRejection } from './lib/coastal-shore-seals.ts';

export interface CoastalShorePlannerOptions {
  cells: string; config: string; origin: string; osm: string; streetParts: string; out: string; coastalRegistration?: string | undefined;
}
interface Area { minX: number; maxX: number; minZ: number; maxZ: number }
interface PlannerConfig {
  playArea?: Area; area?: Area;
  coastal?: { waterElevationN2000: number };
  carriagewayGrade?: ShoreSealOptions;
}
interface Origin { id: string; crs: string; heightDatum: string; originProjected: [number, number, number] }
interface CellsIndex { originId: string; cells: CellDescriptor[] }
interface PinnedFile { file: string; sha256: string }
interface BoundSeal extends Omit<ShoreSeal, 'source'> {
  source: ShoreSeal['source'] & { collisionTriangles: number[] };
  side: 'both'; materialRule: 'reuse-existing-slabs';
  inputs: { visual: CellDescriptor['visual']['lod0']; collision: CellDescriptor['collision']; coarse: CellDescriptor['visual']['lod2'] | null };
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const shaFile = (file: string) => sha(readFileSync(file));
const pointKey = (p: readonly number[]) => p.join(',');
const edgeKey = (a: readonly number[], b: readonly number[]) => [pointKey(a), pointKey(b)].sort().join('|');
const triangleKey = (p: readonly (readonly number[])[]) => p.map(pointKey).sort().join('|');

function assertArea(area: Area | undefined, label: string): asserts area is Area {
  assert.ok(area && [area.minX, area.maxX, area.minZ, area.maxZ].every(Number.isFinite), `${label} requires finite bounds`);
  assert.ok(area.maxX > area.minX && area.maxZ > area.minZ, `${label} has invalid bounds`);
}
function payloadPath(directory: string, relative: string) {
  const file = path.resolve(directory, relative), local = path.relative(directory, file);
  assert.ok(local && !path.isAbsolute(local) && local !== '..' && !local.startsWith(`..${path.sep}`), 'Cell payload escapes its input directory');
  return file;
}
function readGroundMeshes(doc: Awaited<ReturnType<NodeIO['readBinary']>>, cell: CellDescriptor): ShoreMesh[] {
  const meshes: ShoreMesh[] = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || !/_ground_(slabs|cobble|asphalt|grass|setts|yard)$/.test(node.getName())) continue;
    assert.deepEqual(node.getWorldMatrix(), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 'Ground transform requires explicit binding');
    for (const [primitiveIndex, primitive] of mesh.listPrimitives().entries()) {
      const position = primitive.getAttribute('POSITION'), indices = primitive.getIndices();
      assert.ok(position && indices && primitive.getMode() === 4, 'Ground must use indexed triangles');
      assert.equal(position.getComponentType(), 5126); assert.equal(position.getNormalized(), false);
      assert.ok(position.getArray() && indices.getArray(), 'Ground accessor data absent');
      meshes.push({ cell: cell.id, primitiveName: node.getName(), primitiveIndex, positions: Float32Array.from(position.getArray()!), indices: Uint32Array.from(indices.getArray()!) });
    }
  }
  return meshes;
}

export async function planCoastalShores(options: CoastalShorePlannerOptions) {
  const cellsArgument = path.resolve(options.cells), indexFile = statSync(cellsArgument).isDirectory() ? path.join(cellsArgument, 'cells.json') : cellsArgument;
  const directory = path.dirname(indexFile), out = path.resolve(options.out);
  assert.ok(!existsSync(out), 'Output already exists; use a fresh plan path');
  const sourceModules = [new URL(import.meta.url), new URL('./lib/coastal-shore-seals.ts', import.meta.url), new URL('./lib/coastal-mask.ts', import.meta.url), new URL('./lib/geometry.ts', import.meta.url), new URL('../../packages/world-schema/src/index.ts', import.meta.url), new URL('../../packages/world-schema/src/collision.ts', import.meta.url)].map(url => { const file = fileURLToPath(url); return { file, sha256: shaFile(file) }; });
  const inputHashes = new Map<string, string>();
  const read = (file: string) => { const bytes = readFileSync(file); inputHashes.set(file, sha(bytes)); return bytes; };
  const json = <T>(file: string): T => JSON.parse(read(file).toString('utf8')) as T;
  const configFile = path.resolve(options.config), originFile = path.resolve(options.origin), osmFile = path.resolve(options.osm), streetPartsFile = path.resolve(options.streetParts);
  const index = json<CellsIndex>(indexFile), config = json<PlannerConfig>(configFile), origin = json<Origin>(originFile), start = performance.now();
  assert.ok(Array.isArray(index.cells) && index.cells.length, 'Cells index is empty or invalid');
  assert.equal(new Set(index.cells.map(cell => cell.id)).size, index.cells.length, 'Duplicate cell ID');
  assert.equal(index.originId, origin.id, 'Cells and supplied origin differ');
  assert.equal(origin.crs, 'EPSG:3879'); assert.equal(origin.heightDatum, 'N2000');
  assert.ok(Array.isArray(origin.originProjected) && origin.originProjected.length === 3 && origin.originProjected.every(Number.isFinite), 'Invalid projected origin');
  const area = config.playArea ?? config.area; assertArea(area, 'Configured play area');
  assert.ok(config.coastal && Number.isFinite(config.coastal.waterElevationN2000), 'Configured coastal water elevation is required');
  if (config.carriagewayGrade?.protectedArea) assertArea(config.carriagewayGrade.protectedArea, 'Protected area');
  if (config.carriagewayGrade?.protectedMarginMetres !== undefined) assert.ok(Number.isFinite(config.carriagewayGrade.protectedMarginMetres) && config.carriagewayGrade.protectedMarginMetres >= 0, 'Invalid protected margin');
  const waterY = config.coastal.waterElevationN2000 - origin.originProjected[2];

  function buildAuthority() {
    const osm = json<CoastalOsm>(osmFile); assert.ok(Array.isArray(osm.elements), 'Invalid OSM snapshot');
    inputHashes.set(streetPartsFile, shaFile(streetPartsFile));
    const parts = loadGeoJsonPolygons(streetPartsFile, origin.originProjected[0], origin.originProjected[1], p => String(p['osan_id']));
    let mask = buildCoastalMask(osm, { area: area!, originProjected: origin.originProjected });
    if (options.coastalRegistration) {
      const registration = loadCoastalRegistration(options.coastalRegistration, mask, origin.originProjected, {streetPartsSha256: inputHashes.get(streetPartsFile)!, osmSha256: inputHashes.get(osmFile)!});
      for (const file of [options.coastalRegistration, ...Object.values(registration.sources).map(ref => ref.file)]) sourceModules.push({file, sha256: sha(read(file))});
      const helper = fileURLToPath(new URL('./lib/coastal-registration.ts', import.meta.url)); sourceModules.push({file: helper, sha256: shaFile(helper)});
      mask = registration.mask;
    }
    const decks = sourceCoastalDecks(osm, parts, origin.originProjected);
    return { mask, decks, segments: sourceShoreSegments(mask.water, area!) };
  }
  const source = buildAuthority(); global.gc?.();
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const cells: { id: string; visual: PinnedFile; collision: PinnedFile; coarse: PinnedFile | null; stats: ReturnType<typeof qualifyCoastalShoreSeals>['stats']; collisionBoundSeals: number }[] = [];
  const seals: BoundSeal[] = [], rejected: (ShoreRejection | (ShoreSeal & { reason: string }))[] = [];
  function payload(ref: FileRef) {
    const file = payloadPath(directory, ref.path), bytes = read(file);
    assert.equal(sha(bytes), ref.sha256, `Cell payload hash mismatch: ${file}`);
    assert.equal(bytes.byteLength, ref.bytes, `Cell payload size mismatch: ${file}`);
    return { file, bytes, sha256: ref.sha256 };
  }

  for (const cell of index.cells) {
    const bounds = cell.boundsXZ;
    assert.ok(Array.isArray(bounds) && bounds.length === 4 && bounds.every(Number.isFinite), `Invalid bounds for ${cell.id}`);
    const segments = source.segments.filter(s => Math.max(s.a[0], s.b[0]) >= bounds[0] - .002 && Math.min(s.a[0], s.b[0]) <= bounds[2] + .002 && Math.max(s.a[1], s.b[1]) >= bounds[1] - .002 && Math.min(s.a[1], s.b[1]) <= bounds[3] + .002);
    if (!segments.length) continue;
    const visual = payload(cell.visual.lod0), doc = await io.readBinary(visual.bytes), meshes = readGroundMeshes(doc, cell);
    const qualified = qualifyCoastalShoreSeals(meshes, segments, source.decks.polygons, waterY, config.carriagewayGrade), collision = payload(cell.collision), bundle = parseCollisionBundle(collision.bytes);
    assert.equal(bundle.header.originId, index.originId); assert.equal(bundle.header.cell, cell.id); assert.equal(bundle.header.frame, 'X-east,Y-up,Z-south');
    const ground = bundle.colliders.find(c => c.id === `g:${cell.id}`), edgeMap = new Map<string, number[]>(), triangleMap = new Map<string, number[]>();
    if (ground) {
      assert.equal(ground.group, 'ground');
      for (let i = 0; i < ground.indices.length; i += 3) {
        const points = [ground.indices[i]!, ground.indices[i + 1]!, ground.indices[i + 2]!].map(id => Array.from(ground.positions.subarray(id * 3, id * 3 + 3)));
        const key = triangleKey(points), matches = triangleMap.get(key) ?? []; matches.push(i / 3); triangleMap.set(key, matches);
        for (let j = 0; j < 3; j++) { const edge = edgeKey(points[j]!, points[(j + 1) % 3]!), adjacent = edgeMap.get(edge) ?? []; adjacent.push(i / 3); edgeMap.set(edge, adjacent); }
      }
    }
    let bound = 0;
    for (const seal of qualified.seals) {
      const mesh = meshes.find(m => m.primitiveName === seal.primitiveName && m.primitiveIndex === seal.primitiveIndex); assert.ok(mesh);
      const original = seal.source.visualVertices.map(id => Array.from(mesh.positions.subarray(id * 3, id * 3 + 3)) as ShorePoint);
      const match = seal.source.topBinding === 'triangle-plane-intersection' ? triangleMap.get(triangleKey(original)) : edgeMap.get(edgeKey(original[0]!, original[1]!));
      if (!match) { rejected.push({ ...seal, reason: 'visual-collision-edge-unbound' }); continue; }
      bound++;
      seals.push({ ...seal, source: { ...seal.source, collisionTriangles: match }, side: 'both', materialRule: 'reuse-existing-slabs', inputs: { visual: cell.visual.lod0, collision: cell.collision, coarse: cell.visual.lod2 ?? null } });
    }
    rejected.push(...qualified.rejected);
    const coarse = cell.visual.lod2 ? payload(cell.visual.lod2) : null;
    cells.push({ id: cell.id, visual: { file: visual.file, sha256: visual.sha256 }, collision: { file: collision.file, sha256: collision.sha256 }, coarse: coarse && { file: coarse.file, sha256: coarse.sha256 }, stats: qualified.stats, collisionBoundSeals: bound });
    global.gc?.(); assert.ok(process.memoryUsage().rss < 690 * 1048576, '700 MiB planner memory limit');
  }

  const pinned = (file: string): PinnedFile => ({ file, sha256: inputHashes.get(file)! });
  const reasons: Record<string, number> = {}; for (const rejection of rejected) reasons[rejection.reason] = (reasons[rejection.reason] ?? 0) + 1;
  const landIds = new Set(seals.flatMap(s => s.source.sourceLandPartIds));
  const report = {
    schemaVersion: 1, status: 'QUALIFIED_SOURCE_BOUND_COASTAL_SHORE_PLAN',
    scope: 'Read-only source shore qualification over every actual canonical water/land boundary. Artificial rectangle boundaries and configured accepted area/margin excluded; actual dry top envelope and existing vertical coverage respected; true open bridge/pier spans retained.',
    candidate: pinned(indexFile),
    inputs: { cells: pinned(indexFile), config: pinned(configFile), origin: pinned(originFile), osm: pinned(osmFile), streetParts: pinned(streetPartsFile) },
    sources: [...sourceModules, pinned(configFile), pinned(originFile), pinned(osmFile), pinned(streetPartsFile)], waterY,
    authority: { segments: source.segments, osm: source.mask.sources, area, protectedArea: config.carriagewayGrade?.protectedArea ?? null, protectedMarginMetres: config.carriagewayGrade?.protectedMarginMetres ?? 0,
      sourceDecks: { matches: source.decks.matches, pierWays: source.decks.pierWays, bridgeEndPartIds: source.decks.bridgeEndPartIds, separateDeckPartIds: source.decks.separateDeckPartIds }, ordinaryLandParts: source.decks.polygons.filter(p => landIds.has(p.id)) },
    stats: { cells: cells.length, sourceShoreSegments: source.segments.length, qualifiedSeals: seals.length, qualifiedLength: seals.reduce((n, s) => n + Math.hypot(s.top[0][0] - s.top[1][0], s.top[0][2] - s.top[1][2]), 0), rejections: reasons, wallSeconds: (performance.now() - start) / 1000, peakRssMiB: process.resourceUsage().maxRSS / 1024 },
    cells, seals, rejected,
    appendContract: 'Append only to an existing ground primitive and existing ground HCOL item, retaining all original array prefixes/item order/count; same append-only LOD2 policy. No textures, new handles, existing triangles, XZ growth, source files, terrain, tree/car placements or runtime edits.',
    pending: ['Review qualified/withheld intervals and overlaps with independently proposed additions', 'Append-only fresh candidate with exact original-prefix preservation proof', 'Unchanged full world gates and actual final runtime views'],
  };
  for (const [file, digest] of inputHashes) assert.equal(shaFile(file), digest, `Input changed during planning: ${file}`);
  for (const module of sourceModules) assert.equal(shaFile(module.file), module.sha256, `Producer source changed during planning: ${module.file}`);
  mkdirSync(path.dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  return { out, sha256: shaFile(out), stats: report.stats };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { cells: { type: 'string' }, config: { type: 'string' }, origin: { type: 'string' }, osm: { type: 'string' }, 'street-parts': { type: 'string' }, out: { type: 'string' }, 'coastal-registration': {type: 'string'} } });
  for (const key of ['cells', 'config', 'origin', 'osm', 'street-parts', 'out'] as const) assert.ok(values[key], `--${key} is required`);
  console.log(JSON.stringify(await planCoastalShores({ cells: values.cells!, config: values.config!, origin: values.origin!, osm: values.osm!, streetParts: values['street-parts']!, out: values.out!, coastalRegistration: values['coastal-registration'] }), null, 2));
}
