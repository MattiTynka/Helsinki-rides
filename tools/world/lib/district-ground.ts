import{decodeDeliveryRoadFile}from'./delivery-road-file.ts';
// Shared authored-ground assembly for full city builds and ground-only repairs.
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import polygonClipping from 'polygon-clipping';
import { geodeticToGk25, type TerrainGrid, type RoadGraph } from '../../../packages/world-schema/src/index.ts';
import { loadGeoJsonPolygons, type LocalPolygon, type Pt } from './geometry.ts';
import { isSupportedSurfaceWay } from './surface-way.ts';
import { buildCoastalMask, sourceCoastalDecks, clipCoastalGround, buildCoastalWaterPieces, lowerTerrainUnderWater, type CoastalOsm, type CoastalClipRetryWitness } from './coastal-mask.ts';
import { buildEntranceTerraces, buildGround, buildRetainingWalls, buildStairs, faceUp, lowerTerrainUnderGround, lowerTerrainUnderSurfaces, reconcileRegisterWalls, registerFlights, type GroundPiece, type GroundResult, type RegisterStairsOptions, type StairsSpec, type TerraceOptions, type WallOptions } from './ground.ts';
import { applyCarriagewayGrade, buildCarriagewayGrade, type CarriagewayGradeOptions } from './carriageway-grade.ts';
import { buildDrivableCorridorGrade, resolveDrivableCorridors, type DrivableCorridorPlan } from './drivable-corridors.ts';
import {loadCoastalRegistration} from './coastal-registration.ts';
import {readDeliveryGroundExclusions} from './delivery-city-ground.ts';

export interface DistrictGroundConfig {
  cellSize: number; playArea: { minX: number; maxX: number; minZ: number; maxZ: number };
  registerStairs: RegisterStairsOptions; entranceTerraces: TerraceOptions; retainingWalls: WallOptions; curbHeight: number;
  coastal?: { waterElevationN2000: number; safetyFloorY: number };
  carriagewayGrade?: Omit<CarriagewayGradeOptions, 'area'>;
  drivableCorridors?: { plan: string; roads: string };
}

export type GroundArea=DistrictGroundConfig['playArea'];
export const GROUND_WORK_MARGIN_METRES=32;

/** Bound generated meshes, never source context or the globally constrained height field.
 *  The 32m halo exceeds the 16m maximum road feather plus exterior sampling/grid support. */
export function groundAssemblyArea(full:GroundArea,target?:GroundArea):GroundArea {
  if(!target)return full;
  for(const area of[full,target])assert.ok(Object.values(area).every(Number.isFinite)&&area.minX<area.maxX&&area.minZ<area.maxZ,'invalid ground work area');
  assert.ok(target.minX>=full.minX&&target.maxX<=full.maxX&&target.minZ>=full.minZ&&target.maxZ<=full.maxZ,'ground work area must be inside full play area');
  return{minX:Math.max(full.minX,target.minX-GROUND_WORK_MARGIN_METRES),maxX:Math.min(full.maxX,target.maxX+GROUND_WORK_MARGIN_METRES),minZ:Math.max(full.minZ,target.minZ-GROUND_WORK_MARGIN_METRES),maxZ:Math.min(full.maxZ,target.maxZ+GROUND_WORK_MARGIN_METRES)};
}

/** Preserve nodes, sample closures, source masks and raw-deck interpolation by reference. */
export function boundCarriagewayMeshCells<T extends ReturnType<typeof buildCarriagewayGrade>>(field:T,area:GroundArea):T {
  const grid=field.stats.gridMetres;
  return{...field,cells:field.cells.filter(c=>c.ix*grid<area.maxX&&(c.ix+1)*grid>area.minX&&-c.iy*grid>area.minZ&&-(c.iy+1)*grid<area.maxZ)};
}

function pieceIntersectsArea(piece:GroundPiece,area:GroundArea){
  let minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity;
  for(let i=0;i<piece.positions.length;i+=3){minX=Math.min(minX,piece.positions[i]!);maxX=Math.max(maxX,piece.positions[i]!);minZ=Math.min(minZ,piece.positions[i+2]!);maxZ=Math.max(maxZ,piece.positions[i+2]!);}
  return minX<=area.maxX&&maxX>=area.minX&&minZ<=area.maxZ&&maxZ>=area.minZ;
}

interface CorridorAudit {
  plan: string; planSha256: string; roads: string; roadsSha256: string;
  sourceHashes: DrivableCorridorPlan['sourceHashes'];
  declarations: ReturnType<typeof resolveDrivableCorridors>['records'];
  stats: ReturnType<typeof resolveDrivableCorridors>['stats'];
}
export interface CachedGroundAssembly {
  ground: GroundResult;
  carriagewayGrade: (ReturnType<typeof applyCarriagewayGrade>['stats'] & { drivableCorridors?: CorridorAudit }) | null;
}

export interface GroundAssemblyCache {
  /** Return a fresh decoded copy; subsequent coastal clipping mutates the piece lists. */
  read(fingerprint: string): CachedGroundAssembly | null;
  write(fingerprint: string, value: CachedGroundAssembly): void;
}

export function buildDistrictGround(options: {
  terrain: TerrainGrid; footprints: LocalPolygon[]; originProjected: readonly number[];
  config: DistrictGroundConfig; osmLedger: string; osmSnapshot: string; streetParts: string;
  log?: (message: string) => void;
  groundCache?: GroundAssemblyCache;
  onCoastalRetry?: (witness: CoastalClipRetryWitness) => void;
  /** Final retained rectangle; meshes are assembled with a clamped 32m context margin. */
  groundWorkArea?: GroundArea;
  /** Explicit hash-bound offline municipal registration; omitted by every ordinary source build. */
  coastalRegistration?:string;
  /** Hash-bound new-area Silta source identities; ordinary producers omit this. */
  groundExclusions?:string;
}) {
  const { terrain, footprints, config } = options;
  const [E0, N0] = options.originProjected as [number, number, number];
  const CELL = config.cellSize, area = config.playArea;
  const assemblyArea=groundAssemblyArea(area,options.groundWorkArea);
  const groundWorkArea=options.groundWorkArea?{target:options.groundWorkArea,assemblyArea,marginMetres:GROUND_WORK_MARGIN_METRES,gradeFieldArea:area}:null;
  const log = options.log ?? (() => {});
  const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
  // ---- stairs: OSM `highway=steps` ways that carry a width and a step count (decision 0005) ----
  const osmLedger = JSON.parse(readFileSync(options.osmLedger, 'utf8'));
  const osmSnap = osmLedger.snapshots[options.osmSnapshot];
  if (!osmSnap) throw new Error(`snapshot ${options.osmSnapshot} is not in the OSM ledger`);
  const osmBytes = readFileSync(path.join(path.dirname(options.osmLedger), osmSnap.path));
  if (sha256(osmBytes) !== osmSnap.sha256) throw new Error('OSM snapshot does not match its ledger hash');
  const osm = JSON.parse(osmBytes.toString('utf8')) as { elements: { type: string; id: number; lat?: number; lon?: number; nodes?: number[]; tags?: Record<string, string> }[] };
  const osmNodes = new Map<number, Pt>();
  for (const e of osm.elements) if (e.type === 'node' && e.lat !== undefined && e.lon !== undefined) { const [E, N] = geodeticToGk25(e.lat, e.lon); osmNodes.set(e.id, [E - E0, N - N0]); }
  const stairCandidates: StairsSpec[] = [], stepWays: { id: string; axis: Pt[]; width: number | null; steps: number | null }[] = [], wallWays: { id: string; line: Pt[] }[] = [];
  for (const e of osm.elements) {
    if (e.type === 'way' && e.tags && !isSupportedSurfaceWay(e.tags)) continue;
    if (e.type === 'way' && e.tags?.['barrier'] === 'retaining_wall') {
      const line = (e.nodes ?? []).map(n => osmNodes.get(n)).filter((p): p is Pt => !!p);
      if (line.length >= 2 && line.some(p => p[0] >= area.minX && p[0] <= area.maxX && -p[1] >= area.minZ && -p[1] <= area.maxZ)) wallWays.push({ id: `osm-way-${e.id}`, line });
    }
    if (e.type !== 'way' || e.tags?.['highway'] !== 'steps') continue;
    const width = Number(e.tags['width'] ?? e.tags['est_width']), steps = Number(e.tags['step_count']);
    const wayAxis = (e.nodes ?? []).map(n => osmNodes.get(n)).filter((p): p is Pt => !!p);
    if (wayAxis.length >= 2) stepWays.push({ id: `osm-way-${e.id}`, axis: wayAxis, width: width > 0 ? width : null, steps: steps > 0 && Number.isInteger(steps) ? steps : null });
    if (!(width > 0) || !(steps > 0) || !Number.isInteger(steps)) continue;
    const axis = (e.nodes ?? []).map(n => osmNodes.get(n)).filter((p): p is Pt => !!p);
    if (axis.length < 2 || !axis.every(p => p[0] >= area.minX && p[0] <= area.maxX && -p[1] >= area.minZ && -p[1] <= area.maxZ)) continue;
    stairCandidates.push({ id: `osm-way-${e.id}`, axis, width, steps });
  }
  // Register flights from the city's street parts typed Portaat (decision 0006) take over the OSM ways that cross them.
  const parts = loadGeoJsonPolygons(options.streetParts, E0, N0, (p, i) => String(p['osan_id'] ?? p['id'] ?? i));
  const groundExclusions=options.groundExclusions?readDeliveryGroundExclusions(options.groundExclusions,options.streetParts,parts):null;
  const register = registerFlights(parts, stepWays, terrain, area, config.registerStairs as RegisterStairsOptions);
  const registerSpecs = register.flights.flatMap(f => f.spec ? [f.spec] : []);
  log(`register flights: ${register.flights.map(f => `${f.id} ${f.status}${f.spec ? ` ${f.spec.steps} steps, ${f.spec.width.toFixed(1)} m wide${f.osmWay ? ` (${f.osmWay})` : ''}` : ''}`).join('; ') || 'none'}`);
  // Flights whose widened footprints overlap disagree about the same ground: an OSM flight that overlaps a register
  // flight is dropped, and two overlapping OSM flights are both dropped.
  const footprintOf = (sp: StairsSpec): [number, number][] => {
    const a = sp.axis[0]!, b = sp.axis[sp.axis.length - 1]!, L = Math.hypot(b[0] - a[0], b[1] - a[1]), vx = -(b[1] - a[1]) / L * sp.width / 2, vy = (b[0] - a[0]) / L * sp.width / 2;
    return [[a[0] - vx, a[1] - vy], [b[0] - vx, b[1] - vy], [b[0] + vx, b[1] + vy], [a[0] + vx, a[1] + vy]];
  };
  const overlap = (p: StairsSpec, q: StairsSpec) => (polygonClipping.intersection([[footprintOf(p)]], [[footprintOf(q)]]) as unknown[]).length > 0;
  const osmCandidates = stairCandidates.filter(sp => !register.osmWays.has(sp.id));
  const conflicting = new Set<string>();
  for (let i = 0; i < osmCandidates.length; i++) {
    if (registerSpecs.some(r => overlap(r, osmCandidates[i]!))) conflicting.add(osmCandidates[i]!.id);
    for (let j = i + 1; j < osmCandidates.length; j++) if (overlap(osmCandidates[i]!, osmCandidates[j]!)) { conflicting.add(osmCandidates[i]!.id); conflicting.add(osmCandidates[j]!.id); }
  }
  const stairs = buildStairs([...registerSpecs, ...osmCandidates.filter(sp => !conflicting.has(sp.id))], terrain, CELL);
  log(`stairs: ${stairs.flights.map(f => `${f.id} ${f.steps} x ${f.riser.toFixed(3)} m over ${f.run.toFixed(1)} m, ${f.width.toFixed(1)} m wide`).join('; ') || 'none'}${conflicting.size ? `; overlapping, not drawn: ${[...conflicting].join(', ')}` : ''}`);
  // Entrance steps the terrain records as bumps at building doors, drawn as terraces (decision 0005).
  const terraces = buildEntranceTerraces(terrain, footprints, stepWays, stairs.zones, area, config.entranceTerraces as TerraceOptions, CELL);
  log(`entrance terraces: ${terraces.terraces.map(t => `${t.id} ${t.area.toFixed(0)} m2, ${t.levels} levels, peak ${t.peak.toFixed(2)} m (${t.steps.join(', ')})`).join('; ') || 'none'}`);

  // Retaining walls the terrain smooths into slopes, drawn as vertical faces between the two ground levels (decision 0005).
  const wallAlignment = reconcileRegisterWalls(wallWays, parts);
  log(`surveyed retaining wall alignment: ${JSON.stringify(wallAlignment.alignments)}`);
  const walls = buildRetainingWalls(wallAlignment.specs, terrain, [...stairs.zones, ...terraces.zones], config.retainingWalls as WallOptions, CELL,
    { boundaries: stairs.boundaries, maxDistance: config.registerStairs.joinDistance });
  log(`retaining walls: ${walls.walls.length} of ${wallWays.length} OSM ways, ${walls.walls.reduce((a, w) => a + w.length, 0).toFixed(0)} m, highest ${Math.max(0, ...walls.walls.map(w => w.maxHeight)).toFixed(1)} m`);

  // Resolve and validate external authored inputs before consulting the cache.
  // A stale plan/graph can never authorize a cached corridor result.
  let corridors: ReturnType<typeof resolveDrivableCorridors> | null = null, corridorAudit: CorridorAudit | null = null;
  if (config.drivableCorridors) {
    assert.ok(config.carriagewayGrade, 'Reviewed corridors require the shared carriageway grade');
    const planBytes = readFileSync(config.drivableCorridors.plan), roadBytes = readFileSync(config.drivableCorridors.roads);
    const plan = JSON.parse(planBytes.toString('utf8')) as DrivableCorridorPlan, roads = decodeDeliveryRoadFile(roadBytes);
    assert.ok(plan.reviewedGeometry, 'A production corridor plan requires reviewed literal lane geometry');
    const fixedSourceStairs = stairs.zones.map((ring, i) => ({ id: `fixed-source-stair-${i}`, rings: [ring], bbox: [Math.min(...ring.map(p => p[0])), Math.min(...ring.map(p => p[1])), Math.max(...ring.map(p => p[0])), Math.max(...ring.map(p => p[1]))] as [number, number, number, number], properties: {} }));
    const sourceHashes = { roads: sha256(roadBytes), osm: osmSnap.sha256, streetParts: sha256(readFileSync(options.streetParts)) };
    corridors = resolveDrivableCorridors(plan, { roads, parts, sourceHashes, protectedArea: config.carriagewayGrade.protectedArea,
      protectedMarginMetres: config.carriagewayGrade.protectedMarginMetres ?? config.carriagewayGrade.gridMetres * 2,
      foundations: footprints, fixedSupports: fixedSourceStairs, rawDeckPartIds: config.carriagewayGrade.rawSourceDeckPartIds });
    corridorAudit = { plan: config.drivableCorridors.plan, planSha256: sha256(planBytes), roads: config.drivableCorridors.roads, roadsSha256: sourceHashes.roads, sourceHashes,
      declarations: corridors.records, stats: corridors.stats };
  }

  // ---- ground ----
  // Cache the expensive exact authored mesh before coastline booleans. Coastal
  // precision repairs can then retry without rebuilding or approximating it.
  // Every dependency affecting this stage participates in the fingerprint.
  const schemaSources = (directory: URL): [string, string][] => readdirSync(directory, {withFileTypes:true}).sort((a,b) => a.name.localeCompare(b.name)).flatMap(entry =>
    entry.isDirectory() ? schemaSources(new URL(`${entry.name}/`, directory)) : entry.name.endsWith('.ts') ? [[new URL(entry.name, directory).pathname.split('/packages/').at(-1)!, sha256(readFileSync(new URL(entry.name, directory)))]] : []);
  const fingerprint = options.groundCache ? sha256(JSON.stringify({version:'authored-ground-before-coast-v1',runtime:{node:process.versions.node,v8:process.versions.v8},config,groundWorkArea,originProjected:options.originProjected,
    terrain:{x0:terrain.x0,z0:terrain.z0,nx:terrain.nx,nz:terrain.nz,resolution:terrain.resolution,sha256:sha256(new Uint8Array(terrain.heights.buffer,terrain.heights.byteOffset,terrain.heights.byteLength))},
    footprints:sha256(JSON.stringify(footprints)),streetParts:sha256(readFileSync(options.streetParts)),osm:osmSnap.sha256,groundExclusions:groundExclusions?.receipt??null,
    drivableCorridorSources:corridorAudit ? {planSha256:corridorAudit.planSha256,roadsSha256:corridorAudit.roadsSha256} : null,
    modules:['district-ground.ts','ground.ts','geometry.ts','carriageway-grade.ts','raw-deck-grade.ts','drivable-corridors.ts','surface-way.ts'].map(file => [file,sha256(readFileSync(new URL(file,import.meta.url)))]),
    worldSchema:schemaSources(new URL('../../../packages/world-schema/src/',import.meta.url)),lock:sha256(readFileSync(new URL('../../../pnpm-lock.yaml',import.meta.url)))})) : null;
  const cached = fingerprint ? options.groundCache!.read(fingerprint) : null;
  let ground: GroundResult, carriagewayGrade: CachedGroundAssembly['carriagewayGrade'];
  if (cached) {
    ground = cached.ground; carriagewayGrade = cached.carriagewayGrade;
    log(`ground cache hit: ${fingerprint}`);
  } else {
  if (fingerprint) log(`ground cache miss: ${fingerprint}`);
  log(`ground assembly area: ${JSON.stringify(groundWorkArea??{assemblyArea,mode:'full'})}`);
  ground = buildGround(parts, terrain, [...stairs.zones, ...terraces.zones], assemblyArea, Number(config.curbHeight), CELL, walls, stairs.boundaries,groundExclusions?.sources);
  for (const p of ground.pieces) faceUp(p.positions, p.indices);
  for(const pieces of[stairs.pieces,terraces.pieces,walls.pieces])for(const p of pieces)if(!groundWorkArea||pieceIntersectsArea(p,assemblyArea))ground.pieces.push(p);
  if(groundWorkArea)for(const list of[ground.pieces,ground.kerbs]){const kept=list.filter(p=>pieceIntersectsArea(p,assemblyArea));list.length=0;for(const p of kept)list.push(p);}
  carriagewayGrade = null;
  if (config.carriagewayGrade) {
    const field = corridors ? buildDrivableCorridorGrade(corridors, terrain, { ...config.carriagewayGrade, area }) : buildCarriagewayGrade(parts, terrain, { ...config.carriagewayGrade, area });
    const fixedSupports = [...footprints, ...[...stairs.zones, ...terraces.zones].map((ring, i) => ({ id: `fixed-authored-support-${i}`, rings: [ring], bbox: [Math.min(...ring.map(p => p[0])), Math.min(...ring.map(p => p[1])), Math.max(...ring.map(p => p[0])), Math.max(...ring.map(p => p[1]))] as [number, number, number, number], properties: {} }))];
    const meshField=groundWorkArea?boundCarriagewayMeshCells(field,assemblyArea):field;
    log(`carriageway mesh cells: ${meshField.cells.length} of ${field.cells.length}; full grade field retained`);
    const graded = applyCarriagewayGrade(ground.pieces, ground.kerbs, meshField, CELL, fixedSupports);
    ground.pieces.length = 0; for (const p of graded.pieces) ground.pieces.push(p);
    ground.kerbs.length = 0; for (const p of graded.kerbs) ground.kerbs.push(p);
    carriagewayGrade = { ...graded.stats, ...(corridorAudit ? { drivableCorridors: corridorAudit } : {}) };
    ground.stats.triangles = ground.pieces.reduce((n, p) => n + p.indices.length / 3, 0);
    ground.stats.kerbQuads = ground.kerbs.length;
    for (const key of Object.keys(ground.stats.byFinish)) delete ground.stats.byFinish[key];
    for (const p of ground.pieces) ground.stats.byFinish[p.finish] = (ground.stats.byFinish[p.finish] ?? 0) + p.indices.length / 3;
    log(`carriageway grade: ${JSON.stringify(carriagewayGrade)}`);
  }
  if (fingerprint) { options.groundCache!.write(fingerprint,{ground,carriagewayGrade}); log(`ground cache saved: ${fingerprint}`); }
  }
  log(`ground: ${ground.stats.polygons} polygons, ${ground.stats.triangles} triangles, ${ground.stats.kerbQuads} kerb quads, ${stairs.pieces.length} stair pieces, ${terraces.pieces.reduce((a, p) => a + p.indices.length / 3, 0)} terrace triangles`);

  const authoredFloors = lowerTerrainUnderSurfaces(terrain, [...ground.collisionFloors, ...stairs.collisionFloors, ...walls.collisionFloors]);
  let coastal = null;
  if (config.coastal) {
    const waterY = config.coastal.waterElevationN2000 - options.originProjected[2]!;
    if (!Number.isFinite(waterY) || !Number.isFinite(config.coastal.safetyFloorY) || config.coastal.safetyFloorY >= waterY - 2) throw new Error('invalid coastal water or safety plane');
    const originalMask = buildCoastalMask(osm as CoastalOsm, {area, originProjected:options.originProjected});
    const registration=options.coastalRegistration?loadCoastalRegistration(options.coastalRegistration,originalMask,options.originProjected,{streetPartsSha256:sha256(readFileSync(options.streetParts)),osmSha256:osmSnap.sha256}):null;
    const mask=registration?.mask??originalMask;
    const decks = sourceCoastalDecks(osm as CoastalOsm, parts, options.originProjected);
    const clipped = clipCoastalGround(ground.pieces,mask,decks.polygons,{onRetry:options.onCoastalRetry});
    const clippedKerbs = clipCoastalGround(ground.kerbs,mask,decks.polygons,{onRetry:options.onCoastalRetry});
    ground.pieces.length = 0; for (const piece of clipped.pieces) ground.pieces.push(piece);
    ground.kerbs.length = 0; for (const piece of clippedKerbs.pieces) ground.kerbs.push(piece);
    ground.stats.triangles = ground.pieces.reduce((n,p)=>n+p.indices.length/3,0);
    ground.stats.kerbQuads = ground.kerbs.length;
    for (const key of Object.keys(ground.stats.byFinish)) delete ground.stats.byFinish[key];
    for (const piece of ground.pieces) ground.stats.byFinish[piece.finish] = (ground.stats.byFinish[piece.finish] ?? 0) + piece.indices.length/3;
    coastal = {mask, decks, waterPieces:buildCoastalWaterPieces(mask,CELL,waterY), waterY,...(registration?{registration:{receipt:registration.receipt,sources:registration.sources,audit:registration.audit}}:{}),
      safetyFloorY:config.coastal.safetyFloorY, clipped:clipped.clipped, clippedKerbs:clippedKerbs.clipped,
      removedTriangles:clipped.removedTriangles+clippedKerbs.removedTriangles, loweredSamples:0,
      precisionRetries:clipped.precisionRetries+clippedKerbs.precisionRetries,
      precisionRetryWitnesses:[...clipped.precisionRetryWitnesses,...clippedKerbs.precisionRetryWitnesses]};
    log(`coast: ${mask.stats.waterArea.toFixed(0)} m2 water, ${decks.matches.length} registered bridge ways, ${coastal.waterPieces.length} water cells`);
  }
  let runtimeTerrain = lowerTerrainUnderGround(authoredFloors, [...ground.pieces, ...ground.kerbs]);
  if (coastal) {
    const lowered = lowerTerrainUnderWater(runtimeTerrain,coastal.mask,coastal.safetyFloorY);
    runtimeTerrain = lowered.terrain; coastal.loweredSamples = lowered.loweredSamples;
  }
  return { ground, stairs, terraces, walls, wallAlignment: wallAlignment.alignments, register, conflicting, osmLedger, osmSnap, osmBytes, runtimeTerrain, coastal, carriagewayGrade, groundWorkArea,...(groundExclusions?{groundExclusions:groundExclusions.receipt}:{}) };
}
