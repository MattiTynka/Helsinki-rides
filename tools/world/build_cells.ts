// The cell builder (plan section 4.1 and appendix B): buildings solely from the textured LoD2 city model (decision
// 0004) except where landmarks.json names an authored landmark model (decision 0005), authored ground from the city's
// street parts, flights of steps, entrance terraces and retaining walls from the OSM snapshot and the terrain, register matching, skirts, per-cell atlases, KTX2 textures,
// meshopt geometry, collision bundles and cell descriptors. One GLB per 128 m cell. With --trees (tools/world/build_trees.ts)
// it also erases the trees painted on the walls behind them, adds trunk colliders and writes the instances to
// scenery.json (decision 0006).
//   node tools/world/build_cells.ts --city-model data/work/m0/citymodel --terrain data/work/m0/terrain \
//     --footprints data/raw/helsinki-building-register/senate-district.geojson \
//     --street-parts data/raw/helsinki-street-parts/senate-district.geojson --landmarks content/helsinki/landmarks.json \
//     --landmark-models data/work/m0/cathedral/model-v3 --osm-ledger data/raw/osm/ledger.json --osm-snapshot senate-district \
//     --trees data/work/m0/trees-v1 --config content/helsinki/cells.json --origin content/helsinki/world-origin.json --out data/work/m0/cells
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { NodeIO } from '@gltf-transform/core';
import earcut from 'earcut';
import sharp from 'sharp';
import {
  cellId, cellIndexFor, encodeCollisionBundle, encodeTerrain, parseTerrain, sampleTerrain,
  type BuildingRecord, type CellDescriptor, type TriMeshCollider, type Vec3,
} from '../../packages/world-schema/src/index.ts';
import { buildAtlases, remapUv, type AtlasInput, type Placement } from './lib/atlas.ts';
import { bbox, centroid, loadGeoJsonPolygons, pointInPolygon, PolygonGrid, ringDistance, type LocalPolygon, type Pt } from './lib/geometry.ts';
import { flatNormals, GlbBuilder, type RgbaImage } from './lib/gltf.ts';
import { gradeFacade, type FacadeGrade } from './lib/grade.ts';
import { type Finish, type GroundPiece } from './lib/ground.ts';
import { groundTexture } from './lib/textures.ts';
import { buildDistrictGround } from './lib/district-ground.ts';
import { solidTile, splitBySlope } from './lib/untextured.ts';
import { eraseVegetation, trianglesNearTrees, type PageTriangle, type TreeVolume, type VegetationOptions } from './lib/vegetation.ts';
import { createFacadeRestorer, facadeRestorationSourceFiles } from './lib/facade-restoration-registry.ts';
import { clipGroundToRectangle, parseAppendRectangle, readAcceptedGroundCoverage } from './lib/append-city-cells.ts';
import {bindDeliveryGroundCache,writeDeliveryGroundCache} from './lib/delivery-city-cache.ts';
import {authorizeNewStripFacades} from './lib/delivery-city-source.ts';
import {literalWallFaces,qualifyDuplicateUpwardSkirt} from './lib/delivery-duplicate-skirts.ts';

const { values } = parseArgs({ options: {
  'city-model': { type: 'string' }, terrain: { type: 'string' }, footprints: { type: 'string' },
  'street-parts': { type: 'string' }, landmarks: { type: 'string' }, config: { type: 'string' }, origin: { type: 'string' }, out: { type: 'string' },
  'landmark-models': { type: 'string', default: '' }, 'osm-ledger': { type: 'string' }, 'osm-snapshot': { type: 'string' }, trees: { type: 'string', default: '' },
  'ground-region': { type: 'string' },
  'exclude-ground-cells': { type: 'string' },
  'ground-exclusions': {type:'string'},
  'ground-cache-out': {type:'string'},
  'accepted-building-manifest': {type:'string'},
} });
for (const k of ['city-model', 'terrain', 'footprints', 'street-parts', 'landmarks', 'osm-ledger', 'osm-snapshot', 'config', 'origin', 'out'] as const) if (!values[k]) throw new Error(`--${k} is required`);
if (existsSync(values.out!)) throw new Error(`${values.out} exists; the build writes into a new directory`);
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const t0 = Date.now();
const log = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

const config = JSON.parse(readFileSync(values.config!, 'utf8'));
const origin = JSON.parse(readFileSync(values.origin!, 'utf8'));
const [E0, N0] = origin.originProjected as [number, number, number];
const CELL = Number(config.cellSize);
const area = config.playArea as { minX: number; maxX: number; minZ: number; maxZ: number };
const terrainDoc = JSON.parse(readFileSync(path.join(values.terrain!, 'terrain.json'), 'utf8'));
const terrain = parseTerrain(new Uint8Array(readFileSync(path.join(values.terrain!, terrainDoc.file))));
const groundAt = (x: number, z: number) => sampleTerrain(terrain, x, z);
const landmarks = JSON.parse(readFileSync(values.landmarks!, 'utf8'));
const hiRes = new Set<string>(landmarks.hiResFacadesVtj ?? []);

// ---- authored landmark models (decision 0005): one baked GLB per model, in the runtime frame, replacing the
// visual of the LoD2 building it names; the building keeps its record and its register-prism collider. ----
interface LandmarkModel { id: string; vtj: string; positions: Float32Array; normals: Float32Array; uvs: Float32Array; indices: Uint32Array; texture: RgbaImage; report: Record<string, unknown> }
const landmarkModels = new Map<string, LandmarkModel>();
for (const dir of values['landmark-models']!.split(',').filter(Boolean)) {
  const rep = JSON.parse(readFileSync(path.join(dir, 'landmark-model.json'), 'utf8'));
  const declared = (landmarks.models ?? []).find((m: { id: string }) => m.id === rep.id) as { id: string; vtj: string; source: string } | undefined;
  if (!declared) throw new Error(`${dir}: model ${rep.id} is not declared in ${values.landmarks}`);
  if (declared.source !== rep.source.file || sha256(readFileSync(declared.source)) !== rep.source.sha256) throw new Error(`${dir}: built from ${rep.source.file}, not the declared ${declared.source} as it is now`);
  if (declared.vtj !== rep.placement.vtj) throw new Error(`${dir}: placed on ${rep.placement.vtj}, declared for ${declared.vtj}`);
  const glbBytes = readFileSync(path.join(dir, rep.glb.file));
  if (sha256(glbBytes) !== rep.glb.sha256) throw new Error(`${dir}: ${rep.glb.file} does not match its hash`);
  const doc = await new NodeIO().readBinary(new Uint8Array(glbBytes));
  const meshes = doc.getRoot().listMeshes(), nodes = doc.getRoot().listNodes();
  if (meshes.length !== 1 || meshes[0]!.listPrimitives().length !== 1) throw new Error(`${dir}: expected one mesh with one primitive`);
  for (const n of nodes) if (n.getMesh() && n.getWorldMatrix().some((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) > 1e-6)) throw new Error(`${dir}: the model node is not at identity`);
  const prim = meshes[0]!.listPrimitives()[0]!;
  const image = prim.getMaterial()?.getBaseColorTexture()?.getImage();
  if (!image) throw new Error(`${dir}: the model has no base colour texture`);
  const { data, info } = await sharp(Buffer.from(image)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const attr = (n: string) => Float32Array.from(prim.getAttribute(n)!.getArray()!);
  landmarkModels.set(declared.vtj, { id: rep.id, vtj: declared.vtj, positions: attr('POSITION'), normals: attr('NORMAL'), uvs: attr('TEXCOORD_0'),
    indices: Uint32Array.from(prim.getIndices()!.getArray()!), texture: { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) }, report: rep });
}

// ---- city model ----
const cityDir = values['city-model']!;
const city = JSON.parse(readFileSync(path.join(cityDir, 'city-model.json'), 'utf8'));
const cityBin = readFileSync(path.join(cityDir, city.binary.file));
if (sha256(cityBin) !== city.binary.sha256) throw new Error('city-model.bin does not match its hash');
if (city.originId !== origin.id) throw new Error(`city model origin ${city.originId} is not ${origin.id}`);
const f32 = (o: { offset: number; bytes: number }) => new Float32Array(cityBin.buffer.slice(cityBin.byteOffset + o.offset, cityBin.byteOffset + o.offset + o.bytes));
const u32 = (o: { offset: number; bytes: number }) => new Uint32Array(cityBin.buffer.slice(cityBin.byteOffset + o.offset, cityBin.byteOffset + o.offset + o.bytes));

/** `texture` is a city-model texture index, a solid-tile key for untextured walls and roofs, or null for a flat colour. */
interface Part { texture: number | string | null; colour: [number, number, number]; positions: Float32Array; uvs: Float32Array; indices: Uint32Array }
interface Building {
  id: string; vtj: string | null; address: string | null; storeys: number | null; parts: Part[]; triangles: number;
  /** The city-model parts as loaded; `citymodel` colliders come from these. */
  sourceParts: Part[];
  min: Vec3; max: Vec3; centroidXZ: [number, number]; cell: string;
  match: BuildingRecord['match']; registerId: string | null; offset: number | null; footprint: LocalPolygon | null; collider: BuildingRecord['collider'];
  bottomEdges: [number, number, number, number, number, number][];
  landmark: string | null;
}
const buildings: Building[] = [];
for (const b of city.buildings) {
  const parts: Part[] = b.parts.map((p: any) => ({ texture: p.texture, colour: p.colour, positions: f32(p.positions), uvs: f32(p.uvs), indices: u32(p.indices) }));
  // ENU -> runtime: (x, y, z) -> (x, z, -y); UVs back to the glTF top-left convention.
  for (const p of parts) {
    for (let i = 0; i < p.positions.length; i += 3) { const y = p.positions[i + 1]!; p.positions[i + 1] = p.positions[i + 2]!; p.positions[i + 2] = -y; }
    for (let i = 1; i < p.uvs.length; i += 2) p.uvs[i] = 1 - p.uvs[i]!;
  }
  const min: Vec3 = [b.boundsENU.min[0], b.boundsENU.min[2], -b.boundsENU.max[1]], max: Vec3 = [b.boundsENU.max[0], b.boundsENU.max[2], -b.boundsENU.min[1]];
  const cx = (min[0] + max[0]) / 2, cz = (min[2] + max[2]) / 2;
  buildings.push({ id: b.id, vtj: b.vtj, address: b.address, storeys: b.storeys, parts, sourceParts: parts, triangles: b.triangles, min, max, centroidXZ: [cx, cz],
    cell: cellId(...cellIndexFor(cx, cz, CELL)), match: 'unmatched', registerId: null, offset: null, footprint: null, collider: 'citymodel', bottomEdges: [], landmark: null });
}
log(`city model: ${buildings.length} buildings`);

// Texture pages that keep source resolution (landmarks.json hiResFacadesVtj, decision 0005): pages of the named
// buildings that mostly carry walls, mostly walls that face the square (outward normal within 60 degrees of the
// direction to the origin, the square's centre), and would fall below the texel density floor at the ordinary cap.
// Density is estimated as cap / sqrt(mapped surface area), i.e. as if the page's charts filled it.
const texelCap = config.texelCap as { facade: number; facadeHiRes: number; hiResMinWallShare: number; hiResMinFacingShare: number; hiResBelowTexelsPerMetre: number };
const pageArea = new Map<number, { wall: number; other: number; facing: number }>();
for (const b of buildings) for (const p of b.parts) {
  if (typeof p.texture !== 'number') continue;
  const P = p.positions, I = p.indices, acc = pageArea.get(p.texture) ?? { wall: 0, other: 0, facing: 0 };
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t]! * 3, c = I[t + 1]! * 3, d = I[t + 2]! * 3;
    const ux = P[c]! - P[a]!, uy = P[c + 1]! - P[a + 1]!, uz = P[c + 2]! - P[a + 2]!, vx = P[d]! - P[a]!, vy = P[d + 1]! - P[a + 1]!, vz = P[d + 2]! - P[a + 2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, len = Math.hypot(nx, ny, nz);
    if (len === 0) continue;
    if (Math.abs(ny / len) >= 0.3) { acc.other += len / 2; continue; }
    acc.wall += len / 2;
    const cx = (P[a]! + P[c]! + P[d]!) / 3, cz = (P[a + 2]! + P[c + 2]! + P[d + 2]!) / 3;
    if (-(nx * cx + nz * cz) > 0.5 * Math.hypot(nx, nz) * Math.hypot(cx, cz)) acc.facing += len / 2;
  }
  pageArea.set(p.texture, acc);
}
const hiResPages = new Set<number>();
for (const b of buildings) {
  if (!b.vtj || !hiRes.has(b.vtj)) continue;
  for (const p of b.parts) {
    const a = typeof p.texture === 'number' ? pageArea.get(p.texture) : undefined;
    if (!a || a.wall / (a.wall + a.other) < texelCap.hiResMinWallShare || a.facing / a.wall < texelCap.hiResMinFacingShare) continue;
    if (texelCap.facade / Math.sqrt(a.wall + a.other) < texelCap.hiResBelowTexelsPerMetre) hiResPages.add(p.texture as number);
  }
}
log(`facade pages at source resolution: ${hiResPages.size} (${[...hiResPages].sort((x, y) => x - y).join(', ')})`);

// ---- register matching (plan section 4.1 step 4) ----
const footprints = loadGeoJsonPolygons(values.footprints!, E0, N0, (p, i) => String(p['vtj_prt'] ?? `register-${p['id'] ?? i}`));
const fpGrid = new PolygonGrid(footprints, 32);
const M = config.matching;
const matchReport: { id: string; vtj: string | null; address: string | null; status: string; registerId: string | null; medianOffset: number | null; coverage: number | null; candidates: number }[] = [];
for (const b of buildings) {
  // Wall-bottom sample points in the working frame.
  const samples: Pt[] = [];
  const zmin = b.min[1];
  for (const p of b.parts) {
    const P = p.positions, I = p.indices;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t]! * 3, c = I[t + 1]! * 3, d = I[t + 2]! * 3;
      const ux = P[c]! - P[a]!, uy = P[c + 1]! - P[a + 1]!, uz = P[c + 2]! - P[a + 2]!, vx = P[d]! - P[a]!, vy = P[d + 1]! - P[a + 1]!, vz = P[d + 2]! - P[a + 2]!;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      if (Math.abs(ny / len) > 0.3) continue; // not a wall
      for (const [i, j] of [[a, c], [c, d], [d, a]] as [number, number][]) {
        if (P[i + 1]! > zmin + 0.4 || P[j + 1]! > zmin + 0.4) continue;
        b.bottomEdges.push([P[i]!, P[i + 1]!, P[i + 2]!, P[j]!, P[j + 1]!, P[j + 2]!]);
        const n = Math.max(1, Math.ceil(Math.hypot(P[j]! - P[i]!, P[j + 2]! - P[i + 2]!)));
        for (let k = 0; k <= n; k++) { const s = k / n; samples.push([P[i]! + (P[j]! - P[i]!) * s, -(P[i + 2]! + (P[j + 2]! - P[i + 2]!) * s)]); }
      }
    }
  }
  // Deduplicate bottom edges (each wall-bottom edge appears once per wall triangle; floor triangles are not walls).
  const seenEdges = new Set<string>();
  b.bottomEdges = b.bottomEdges.filter(e => { const k1 = e.slice(0, 3).map(v => v.toFixed(3)).join(','), k2 = e.slice(3).map(v => v.toFixed(3)).join(','); const key = k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1; if (seenEdges.has(key)) return false; seenEdges.add(key); return true; });
  const bx0 = b.min[0] - 1, bx1 = b.max[0] + 1, by0 = -b.max[2] - 1, by1 = -b.min[2] + 1;
  const candidates = footprints.filter(f => f.bbox[0] <= bx1 && f.bbox[2] >= bx0 && f.bbox[1] <= by1 && f.bbox[3] >= by0);
  const scored = candidates.map(f => {
    const ds = samples.map(s => ringDistance(s, f.rings[0]!)).sort((x, y) => x - y);
    const median = ds.length ? ds[Math.floor(ds.length / 2)]! : Infinity;
    const coverage = ds.length ? ds.filter(d => d <= M.coverageDistance).length / ds.length : 0;
    const inside = samples.length ? samples.filter(s => pointInPolygon(s, f.rings) || ringDistance(s, f.rings[0]!) <= 0.5).length / samples.length : 0;
    return { f, median, coverage, inside };
  }).sort((x, y) => x.median - y.median);
  const byVtj = b.vtj ? scored.find(s => s.f.id === b.vtj) : undefined;
  const geometric = scored.filter(s => s.median <= M.maxMedianOffset && s.coverage >= M.minCoverage && s.inside >= M.minInsideShare);
  let chosen = byVtj && byVtj.median <= 2 ? byVtj : geometric[0];
  let status: BuildingRecord['match'] = 'unmatched';
  if (byVtj && byVtj.median <= 2) status = 'matched';
  else if (geometric.length === 1) status = 'matched';
  else if (geometric.length > 1) status = 'ambiguous';
  if (status !== 'matched') chosen = status === 'ambiguous' ? geometric[0] : undefined;
  b.match = status;
  b.registerId = chosen?.f.id ?? null;
  b.offset = chosen ? Math.round(chosen.median * 1000) / 1000 : null;
  b.footprint = status === 'matched' ? chosen!.f : null;
  b.collider = status === 'matched' ? 'prism' : 'citymodel';
  matchReport.push({ id: b.id, vtj: b.vtj, address: b.address, status, registerId: b.registerId, medianOffset: b.offset, coverage: chosen ? Math.round(chosen.coverage * 1000) / 1000 : null, candidates: candidates.length });
}
const landmarkReport: { id: string; vtj: string; building: string; collider: string; triangles: number; texture: [number, number]; centreOffsetMeters: number }[] = [];
for (const b of buildings) {
  const m = b.vtj ? landmarkModels.get(b.vtj) : undefined;
  if (!m) continue;
  // The placement put the model on this building's footprint; a large offset means the wrong model or origin.
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < m.positions.length; i += 3) { x0 = Math.min(x0, m.positions[i]!); x1 = Math.max(x1, m.positions[i]!); z0 = Math.min(z0, m.positions[i + 2]!); z1 = Math.max(z1, m.positions[i + 2]!); }
  const offset = Math.hypot((x0 + x1) / 2 - b.centroidXZ[0], (z0 + z1) / 2 - b.centroidXZ[1]);
  if (offset > 3) throw new Error(`landmark ${m.id} is ${offset.toFixed(1)} m from building ${b.id}`);
  b.parts = [];
  b.bottomEdges = [];
  b.triangles = m.indices.length / 3;
  b.landmark = m.id;
  landmarkReport.push({ id: m.id, vtj: m.vtj, building: b.id, collider: b.collider, triangles: b.triangles, texture: [m.texture.width, m.texture.height], centreOffsetMeters: Math.round(offset * 100) / 100 });
}
if (landmarkReport.length !== landmarkModels.size) throw new Error(`landmark models without a building: ${[...landmarkModels.keys()].filter(v => !landmarkReport.some(r => r.vtj === v)).join(', ')}`);
log(`landmark models: ${landmarkReport.map(r => `${r.id} on ${r.vtj} (${r.triangles} triangles, collider ${r.collider})`).join('; ') || 'none'}`);

const matched = buildings.filter(b => b.match === 'matched');
log(`matching: ${matched.length} matched, ${buildings.filter(b => b.match === 'ambiguous').length} ambiguous, ${buildings.filter(b => b.match === 'unmatched').length} unmatched; median offset ${matched.length ? (matched.map(b => b.offset!).sort((a, b) => a - b)[Math.floor(matched.length / 2)]! * 100).toFixed(1) : '-'} cm`);

// ---- untextured walls and roofs: flat colours split by face slope (plan section 4.3, decision 0004) ----
// They take the district's median textured-LoD2 wall or roof colour as a solid tile in the facade atlas, so the
// grade and the baked-light material treat them like their neighbours; undersides keep the city model's colour.
const untextured = config.untextured as { wall: [number, number, number]; roof: [number, number, number]; wallMaxNormalY: number; tileSize: number };
const solidImages = new Map<string, RgbaImage>([['wall', solidTile(untextured.wall, untextured.tileSize)], ['roof', solidTile(untextured.roof, untextured.tileSize)]]);
const untexturedReport: { id: string; address: string | null; wallTriangles: number; roofTriangles: number; textured: boolean }[] = [];
for (const b of buildings) {
  let wall = 0, roof = 0;
  b.parts = b.parts.flatMap(p => {
    if (p.texture !== null) return [p];
    const s = splitBySlope(p.positions, p.indices, untextured.wallMaxNormalY);
    wall += s.wall.length / 3; roof += s.roof.length / 3;
    const centre = new Float32Array(p.positions.length / 3 * 2).fill(0.5);
    return [
      ...(s.wall.length ? [{ ...p, texture: 'wall', uvs: centre, indices: s.wall }] : []),
      ...(s.roof.length ? [{ ...p, texture: 'roof', uvs: centre, indices: s.roof }] : []),
      ...(s.under.length ? [{ ...p, indices: s.under }] : []),
    ];
  });
  if (wall + roof) untexturedReport.push({ id: b.id, address: b.address, wallTriangles: wall, roofTriangles: roof, textured: b.parts.some(p => typeof p.texture === 'number') });
}
log(`untextured: ${untexturedReport.length} buildings with flat walls or roofs (${untexturedReport.filter(r => !r.textured).length} without any facade texture)`);
const facadeGrade = config.facadeGrade as FacadeGrade | undefined;

// ---- trees (decision 0006): register trees drawn as instances, so the pictures of them that the oblique photos
// left on the walls behind are erased from those pages before the grade. ----
interface TreeInstance { id: string; model: string; position: Vec3; yaw: number; scale: Vec3; height: number; crownRadius: number; trunkRadius: number; colliderHeight: number }
const treesDoc = values.trees ? JSON.parse(readFileSync(path.join(values.trees, 'trees.json'), 'utf8')) as { originId: string; asset: string; assetSha256: string; trees: TreeInstance[] } : null;
if (treesDoc && treesDoc.originId !== origin.id) throw new Error(`trees origin ${treesDoc.originId} is not ${origin.id}`);
const trees = treesDoc?.trees ?? [];
const vegetation = config.vegetation as VegetationOptions | undefined;
let newStripOnly=false;
if(config.curatedFacades!==undefined){
  if(config.curatedFacades!=='none-new-strips'||config.continuation?.kind!=='current-vintage-new-strips-only'||!values['exclude-ground-cells']||!values['accepted-building-manifest'])throw new Error('Unregistered facade pages require explicit isolated new-strip model, accepted cell coverage and actual accepted building manifest');
  newStripOnly=authorizeNewStripFacades(config,readFileSync(path.join(cityDir,'city-model.json')),readFileSync(path.join(values['exclude-ground-cells'],'cells.json')),readFileSync(values['accepted-building-manifest']));
}
const treeVolumes: TreeVolume[] = trees.map(t => ({ x: t.position[0], z: t.position[2], radius: t.crownRadius, base: t.position[1], top: t.position[1] + t.height }));
const pageTrees = new Map<number, { tri: PageTriangle; trees: TreeVolume[] }[]>();
if (vegetation && treeVolumes.length && !newStripOnly) for (const b of buildings) for (const p of b.parts) {
  if (typeof p.texture !== 'number') continue;
  const near = trianglesNearTrees(p.positions, p.uvs, p.indices, treeVolumes, vegetation);
  if (near.length) pageTrees.set(p.texture, [...(pageTrees.get(p.texture) ?? []), ...near]);
}
log(`trees: ${trees.length}; wall triangles behind them on ${pageTrees.size} facade pages`);
const vegetationReport = new Map<number, { texture: number; file: string; triangles: number; trees: number; size: [number, number]; texels: number }>();
const facadeRestorer = await createFacadeRestorer(cityDir, city.textures,newStripOnly?{newStripOnly:true}:undefined);
const curatedFacadeReport = new Map<string, unknown>();
if (pageTrees.size) mkdirSync(path.join(values.out!, 'vegetation'), { recursive: true });
const prepare = async (d: Uint8Array, w: number, h: number, id: string): Promise<Uint8Array> => {
  if (vegetation?.mode && vegetation.mode !== 'restore-original') throw new Error('production cell builds require restore-original vegetation mode; use calibrate_facades.ts --experimental for experiments');
  const page = /^t(\d+)$/.exec(id), ti = page ? Number(page[1]) : -1, tris = pageTrees.get(ti);
  if (vegetation && tris && !vegetationReport.has(ti)) {
    // A page appears in every cell that uses it, resampled to the same cap, so it is erased the same way each time;
    // the evidence (before | after) is written once.
    const before = Uint8Array.from(d);
    const texels = eraseVegetation(d, w, h, tris, vegetation);
    vegetationReport.set(ti, { texture: ti, file: city.textures[ti].file, triangles: tris.length, trees: new Set(tris.flatMap(t => t.trees)).size, size: [w, h], texels });
    if (texels) {
      const pair = new Uint8Array(w * 2 * h * 4);
      for (let y = 0; y < h; y++) { pair.set(before.subarray(y * w * 4, (y + 1) * w * 4), y * w * 8); pair.set(d.subarray(y * w * 4, (y + 1) * w * 4), y * w * 8 + w * 4); }
      await sharp(Buffer.from(pair.buffer), { raw: { width: w * 2, height: h, channels: 4 } }).png().toFile(path.join(values.out!, 'vegetation', `${id}.png`));
    }
  } else if (vegetation && tris) eraseVegetation(d, w, h, tris, vegetation);
  const curated = facadeRestorer.apply(ti, d, w, h);
  if (curated.length) curatedFacadeReport.set(`${ti}:${w}x${h}`, curated);
  return facadeGrade ? gradeFacade(d, w, h, facadeGrade) : d;
};

// Ground-only repairs call the same assembly as a full cell build.
const groundRegion=values['ground-region']?parseAppendRectangle(values['ground-region']):null;
const cacheInputPaths={config:values.config!,origin:values.origin!,terrain:path.join(values.terrain!,terrainDoc.file),footprints:values.footprints!,streetParts:values['street-parts']!,osmLedger:values['osm-ledger']!,...(values['ground-exclusions']?{exclusions:values['ground-exclusions']}: {})};
const cacheBinding=values['ground-cache-out']?bindDeliveryGroundCache(cacheInputPaths):null;
const assembledGround = buildDistrictGround({
  terrain, footprints, originProjected: origin.originProjected, config,
  osmLedger: values['osm-ledger']!, osmSnapshot: values['osm-snapshot']!, streetParts: values['street-parts']!, log,
  groundWorkArea:groundRegion?{minX:groundRegion[0],minZ:groundRegion[1],maxX:groundRegion[2],maxZ:groundRegion[3]}:undefined,
  groundExclusions:values['ground-exclusions'],
});
const { ground, stairs, terraces, walls, wallAlignment, register, conflicting, osmLedger, osmSnap, runtimeTerrain, coastal, groundWorkArea } = assembledGround;
if(values['ground-cache-out']){
  assertCacheSnapshot();writeDeliveryGroundCache(values['ground-cache-out'],{ground,runtimeTerrain,coastal},cacheBinding!,groundRegion);log('Native post-coast ground cache written before clipping');
}
function assertCacheSnapshot(){if(sha256(readFileSync(path.resolve(path.dirname(values['osm-ledger']!),osmSnap.path)))!==osmSnap.sha256)throw new Error('Ground OSM changed during native assembly');}
if(values['exclude-ground-cells']&&!groundRegion)throw new Error('--exclude-ground-cells requires --ground-region');
const excludedGround=values['exclude-ground-cells']?readAcceptedGroundCoverage(values['exclude-ground-cells'],groundRegion!):null;
if(groundRegion){
  const pieces=clipGroundToRectangle(ground.pieces,groundRegion,excludedGround?.coverage),kerbs=clipGroundToRectangle(ground.kerbs,groundRegion,excludedGround?.coverage);
  ground.pieces.length=0;for(const piece of pieces)ground.pieces.push(piece);
  ground.kerbs.length=0;for(const kerb of kerbs)ground.kerbs.push(kerb);
  if(coastal){
    const water=clipGroundToRectangle(coastal.waterPieces.map(p=>({...p,uvs:new Array(p.positions.length/3*2).fill(0),finish:'yard' as const,level:'road' as const,tag:'water',use:'visual' as const})),groundRegion);
    coastal.waterPieces.length=0;for(const p of water)coastal.waterPieces.push({cell:p.cell,positions:p.positions,indices:p.indices});
  }
  // The safety field was lowered under the superset of these triangles. Removing outside triangles cannot
  // raise that field above any retained support; the accepted old field is separately preserved at merge.
  log(`ground clipped to exact append rectangle ${groundRegion.join(',')}`);
}

// ---- cells ----
const cellsSet = new Set<string>();
for (const b of buildings) cellsSet.add(b.cell);
for (const p of ground.pieces) cellsSet.add(p.cell);
for (const k of ground.kerbs) cellsSet.add(k.cell);
for (const water of coastal?.waterPieces ?? []) cellsSet.add(water.cell);
const cellIds = [...cellsSet].sort();
log(`cells: ${cellIds.join(', ')}`);
const treeCell = new Map(trees.map(t => [t.id, cellId(...cellIndexFor(t.position[0], t.position[2], CELL))]));
const treesOutsideCells = trees.filter(t => !cellsSet.has(treeCell.get(t.id)!)).map(t => t.id);
if (treesOutsideCells.length) log(`trees outside the built cells, drawn without a trunk collider: ${treesOutsideCells.join(', ')}`);

mkdirSync(path.join(values.out!, 'visual'), { recursive: true });
mkdirSync(path.join(values.out!, 'collision'), { recursive: true });
const descriptors: CellDescriptor[] = [];
const cellStats: Record<string, unknown>[] = [];
const groundTextures = new Map<Finish, RgbaImage>();
const texFor = (f: Finish) => { let t = groundTextures.get(f); if (!t) { t = groundTexture(f, Number(config.groundTextureSize)); groundTextures.set(f, t); } return t; };
const paletteSize = 16;
type Merged = { positions: number[]; uvs: number[]; indices: number[]; colours?: number[] };
const pushTri = (m: Merged, P: ArrayLike<number>, U: ArrayLike<number> | null, i0: number, i1: number, i2: number, uvMap?: (u: number, v: number) => [number, number]) => {
  for (const i of [i0, i1, i2]) {
    m.indices.push(m.positions.length / 3);
    m.positions.push(P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!);
    if (U) { const [u, v] = uvMap ? uvMap(U[i * 2]!, U[i * 2 + 1]!) : [U[i * 2]!, U[i * 2 + 1]!]; m.uvs.push(u, v); } else m.uvs.push(0, 0);
  }
};
const lit = config.lighting !== 'unlit-facades';
const colliders: Record<string, TriMeshCollider[]> = {};
const buildingRecords: Record<string, BuildingRecord[]> = {};
let totalDrawCalls = 0, totalTextureBytes = 0, totalTextureTexels = 0;
const atlasUsage: Record<string, number[]> = {};
/** Unique textures across the scene (the runtime dedupes identical KTX2 payloads, so shared ground tiles count once). */
const uniqueTextures = new Map<string, number>();

for (const cid of cellIds) {
  const cb = buildings.filter(b => b.cell === cid);
  const [cxIdx, czIdx] = (() => { const m = cid.match(/^c_([mp])(\d+)_([mp])(\d+)$/)!; return [(m[1] === 'm' ? -1 : 1) * Number(m[2]), (m[3] === 'm' ? -1 : 1) * Number(m[4])]; })();
  const bounds: [number, number, number, number] = [cxIdx * CELL, czIdx * CELL, (cxIdx + 1) * CELL, (czIdx + 1) * CELL];
  const glb = new GlbBuilder(cid);
  let drawCalls = 0;

  // -- facade atlases (one texture entry per source texture used in this cell)
  const facadeInputs: AtlasInput[] = [];
  const usedTextures = new Set<number | string>();
  for (const b of cb) for (const p of b.parts) if (p.texture !== null) usedTextures.add(p.texture);
  for (const ti of usedTextures) {
    if (typeof ti === 'string') {
      const image = solidImages.get(ti)!;
      facadeInputs.push({ id: `t${ti}`, image, width: image.width, height: image.height, cap: image.width });
      continue;
    }
    const t = city.textures[ti];
    const cap = hiResPages.has(ti) ? texelCap.facadeHiRes : texelCap.facade;
    facadeInputs.push({ id: `t${ti}`, file: path.join(cityDir, t.file), width: t.width, height: t.height, cap });
  }
  const facadeAtlas = facadeInputs.length ? await buildAtlases(facadeInputs, Number(config.atlasSize), prepare) : null;

  // -- buildings: merged per facade atlas, plus a palette mesh for flat colours and skirts
  const perAtlas = new Map<number, Merged>();
  const palette: Merged = { positions: [], uvs: [], indices: [] };
  const paletteColours: [number, number, number][] = [];
  const paletteUv = (rgb: [number, number, number]): [number, number] => {
    let i = paletteColours.findIndex(c => c[0] === rgb[0] && c[1] === rgb[1] && c[2] === rgb[2]);
    if (i < 0) { i = paletteColours.length; paletteColours.push(rgb); }
    if (i >= paletteSize * paletteSize) throw new Error(`${cid}: more than ${paletteSize * paletteSize} flat colours`);
    return [((i % paletteSize) + 0.5) / paletteSize, (Math.floor(i / paletteSize) + 0.5) / paletteSize];
  };
  const plinth: [number, number, number] = [0.32, 0.30, 0.28];
  const cellColliders: TriMeshCollider[] = [];
  const records: BuildingRecord[] = [];
  for (const b of cb) {
    for (const p of b.parts) {
      if (p.texture !== null && facadeAtlas) {
        const pl = facadeAtlas.placements.get(`t${p.texture}`)!;
        const atlas = facadeAtlas.atlases[pl.atlas]!;
        let m = perAtlas.get(pl.atlas);
        if (!m) perAtlas.set(pl.atlas, m = { positions: [], uvs: [], indices: [] });
        for (let t = 0; t < p.indices.length; t += 3) pushTri(m, p.positions, p.uvs, p.indices[t]!, p.indices[t + 1]!, p.indices[t + 2]!, (u, v) => remapUv(pl, atlas.width, atlas.height, u, v));
      } else {
        const uv = paletteUv([Math.round(p.colour[0] * 255) / 255, Math.round(p.colour[1] * 255) / 255, Math.round(p.colour[2] * 255) / 255]);
        for (let t = 0; t < p.indices.length; t += 3) pushTri(palette, p.positions, null, p.indices[t]!, p.indices[t + 1]!, p.indices[t + 2]!, () => uv);
      }
    }
    // Skirts: from each wall-bottom edge down to 0.3 m below the lowest ground within 1.5 m.
    const uv = paletteUv(plinth);
    let skirtBottom = Infinity;
    const originalWallFaces = b.landmark ? [] : literalWallFaces(b.sourceParts);
    for (const e of b.bottomEdges) {
      const mx = (e[0] + e[3]) / 2, mz = (e[2] + e[5]) / 2;
      let low = Infinity;
      for (let dx = -1.5; dx <= 1.5; dx += 0.5) for (let dz = -1.5; dz <= 1.5; dz += 0.5) low = Math.min(low, groundAt(mx + dx, mz + dz));
      const bottom = low - Number(config.skirtBelowGround);
      skirtBottom = Math.min(skirtBottom, bottom);
      // The collision-prism datum above is deliberately unchanged. A native
      // basement can already extend below terrain: an upward palette quad then
      // duplicates the wall and z-fights. Skip only exact, fully covered quads.
      if (qualifyDuplicateUpwardSkirt(e, bottom, originalWallFaces)) continue;
      const base = palette.positions.length / 3;
      palette.positions.push(e[0], e[1], e[2], e[3], e[4], e[5], e[3], bottom, e[5], e[0], bottom, e[2]);
      palette.uvs.push(uv[0], uv[1], uv[0], uv[1], uv[0], uv[1], uv[0], uv[1]);
      // Two-sided by duplicating winding: the wall normal direction is unknown here, so emit both.
      palette.indices.push(base, base + 1, base + 2, base, base + 2, base + 3, base, base + 2, base + 1, base, base + 3, base + 2);
    }
    if (!Number.isFinite(skirtBottom)) skirtBottom = b.min[1] - 0.3;
    // Collider
    if (b.collider === 'prism' && b.footprint) {
      const rings = b.footprint.rings;
      const flat: number[] = [], holes: number[] = [];
      rings.forEach((r, ri) => { if (ri > 0) holes.push(flat.length / 2); for (const p of r) flat.push(p[0], p[1]); });
      const top = b.max[1], bottom = skirtBottom;
      const pos: number[] = [], idx: number[] = [], tags: number[] = [];
      for (let i = 0; i < flat.length; i += 2) { pos.push(flat[i]!, top, -flat[i + 1]!); }
      const cap = earcut(flat, holes.length ? holes : undefined, 2);
      for (let t = 0; t < cap.length; t += 3) { idx.push(cap[t]!, cap[t + 1]!, cap[t + 2]!); tags.push(1); }
      for (const r of rings) for (let i = 0; i < r.length; i++) {
        const a = r[i]!, c = r[(i + 1) % r.length]!;
        const base = pos.length / 3;
        pos.push(a[0], top, -a[1], c[0], top, -c[1], c[0], bottom, -c[1], a[0], bottom, -a[1]);
        idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
        tags.push(0, 0);
      }
      cellColliders.push({ id: `b:${b.id}`, group: 'buildings', ref: b.id, positions: Float32Array.from(pos), indices: Uint32Array.from(idx), triangleTags: Uint16Array.from(tags) });
    } else {
      const pos: number[] = [], idx: number[] = [];
      for (const p of b.sourceParts) { const base = pos.length / 3; for (const v of p.positions) pos.push(v); for (const i of p.indices) idx.push(base + i); }
      cellColliders.push({ id: `cm:${b.id}`, group: 'citymodel', ref: b.id, positions: Float32Array.from(pos), indices: Uint32Array.from(idx), triangleTags: new Uint16Array(idx.length / 3).fill(2) });
    }
    records.push({ id: b.id, registerId: b.registerId, vtj: b.vtj, address: b.address, storeys: b.storeys, match: b.match, matchOffsetMeters: b.offset,
      collider: b.collider, texture: b.landmark || b.parts.some(p => typeof p.texture === 'number') ? 'textured' : 'flat-colour', triangles: b.triangles,
      boundsRuntime: { min: b.min, max: b.max }, cell: cid, landmark: b.landmark });
  }
  const unlitMat = !lit;
  for (const [ai, m] of perAtlas) {
    const atlas = facadeAtlas!.atlases[ai]!;
    const pos = Float32Array.from(m.positions), idx = Uint32Array.from(m.indices);
    await glb.addMesh({ name: `${cid}_facades_${ai}`, positions: pos, normals: flatNormals(pos, idx), uvs: Float32Array.from(m.uvs), indices: idx, materialName: `facades_${ai}` },
      { name: `${cid}_facades_${ai}`, texture: atlas, textureKind: 'facade', unlit: unlitMat, roughness: 0.95, extras: { bakedLighting: true } });
    drawCalls++;
  }
  for (const b of cb) {
    const m = b.vtj ? landmarkModels.get(b.vtj) : undefined;
    if (!m || b.landmark !== m.id) continue;
    await glb.addMesh({ name: `${cid}_landmark_${m.id}`, positions: m.positions, normals: m.normals, uvs: m.uvs, indices: m.indices, materialName: `landmark_${m.id}` },
      { name: `${cid}_landmark_${m.id}`, texture: m.texture, textureKind: 'facade', unlit: unlitMat, roughness: 0.95, extras: { bakedLighting: true } });
    drawCalls++;
  }
  if (palette.indices.length) {
    const img: RgbaImage = { width: paletteSize, height: paletteSize, data: new Uint8Array(paletteSize * paletteSize * 4).fill(255) };
    paletteColours.forEach((c, i) => { img.data[i * 4] = Math.round(c[0] * 255); img.data[i * 4 + 1] = Math.round(c[1] * 255); img.data[i * 4 + 2] = Math.round(c[2] * 255); });
    const pos = Float32Array.from(palette.positions), idx = Uint32Array.from(palette.indices);
    await glb.addMesh({ name: `${cid}_flat`, positions: pos, normals: flatNormals(pos, idx), uvs: Float32Array.from(palette.uvs), indices: idx, materialName: 'palette' },
      { name: `${cid}_palette`, texture: img, textureKind: 'roof', unlit: unlitMat, roughness: 0.95 });
    drawCalls++;
  }
  // -- ground per finish, kerbs, collision with surface tags
  const surfaceTags = ['wall', 'roof', 'citymodel', 'landmark', 'curb'];
  const tagIndex = (t: string) => { let i = surfaceTags.indexOf(t); if (i < 0) { i = surfaceTags.length; surfaceTags.push(t); } return i; };
  const perFinish = new Map<Finish, Merged>();
  const groundCollider = { pos: [] as number[], idx: [] as number[], tags: [] as number[] };
  const addPiece = (p: GroundPiece) => {
    if (p.use !== 'collision') {
      let m = perFinish.get(p.finish);
      if (!m) perFinish.set(p.finish, m = { positions: [], uvs: [], indices: [] });
      for (let t = 0; t < p.indices.length; t += 3) pushTri(m, p.positions, p.uvs, p.indices[t]!, p.indices[t + 1]!, p.indices[t + 2]!);
    }
    if (p.use === 'visual') return;
    const base = groundCollider.pos.length / 3;
    for (const v of p.positions) groundCollider.pos.push(v);
    for (const i of p.indices) groundCollider.idx.push(base + i);
    for (let t = 0; t < p.indices.length; t += 3) groundCollider.tags.push(tagIndex(p.tag));
  };
  for (const p of ground.pieces) if (p.cell === cid) addPiece(p);
  for (const k of ground.kerbs) if (k.cell === cid) addPiece(k);
  for (const [finish, m] of perFinish) {
    const pos = Float32Array.from(m.positions), idx = Uint32Array.from(m.indices);
    await glb.addMesh({ name: `${cid}_ground_${finish}`, positions: pos, normals: flatNormals(pos, idx), uvs: Float32Array.from(m.uvs), indices: idx, materialName: `ground_${finish}` },
      { name: `${cid}_ground_${finish}`, texture: texFor(finish), textureKind: 'roof', unlit: false, roughness: 1 });
    drawCalls++;
  }
  if (groundCollider.idx.length) cellColliders.push({ id: `g:${cid}`, group: 'ground', ref: null, positions: Float32Array.from(groundCollider.pos), indices: Uint32Array.from(groundCollider.idx), triangleTags: Uint16Array.from(groundCollider.tags) });
  for (const water of coastal?.waterPieces ?? []) if (water.cell === cid) {
    const positions = Float32Array.from(water.positions), indices = Uint32Array.from(water.indices);
    await glb.addMesh({name:`${cid}_water`,positions,normals:flatNormals(positions,indices),indices,materialName:'coastal_water'},
      {name:'coastal_water',baseColor:[0.07,0.18,0.23,1],unlit:false,roughness:0.25,metallic:0.15});
    drawCalls++;
  }
  // -- tree trunks: octagonal prisms from the trunk base up colliderHeight (0 on lanes and inside footprints)
  for (const t of trees) {
    if (!(t.colliderHeight > 0) || treeCell.get(t.id) !== cid) continue;
    const [x, y, z] = t.position, top = y + t.colliderHeight, pos: number[] = [x, top, z], idx: number[] = [];
    for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; pos.push(x + t.trunkRadius * Math.cos(a), top, z + t.trunkRadius * Math.sin(a), x + t.trunkRadius * Math.cos(a), y, z + t.trunkRadius * Math.sin(a)); }
    for (let k = 0; k < 8; k++) {
      const at = 1 + k * 2, ab = at + 1, bt = 1 + ((k + 1) % 8) * 2, bb = bt + 1;
      idx.push(at, bt, bb, at, bb, ab, 0, bt, at); // outward sides, upward cap
    }
    const tag = tagIndex('trunk');
    cellColliders.push({ id: `t:${t.id}`, group: 'trees', ref: t.id, positions: Float32Array.from(pos), indices: Uint32Array.from(idx), triangleTags: new Uint16Array(idx.length / 3).fill(tag) });
  }

  // -- write
  const glbBytes = await glb.toGlb(config.copyright, { cell: cid, originId: origin.id, lighting: lit ? 'lit-facades' : 'unlit-facades' }, 'exact');
  const visualPath = `visual/${cid}.lod0.glb`;
  writeFileSync(path.join(values.out!, visualPath), glbBytes);
  const col = encodeCollisionBundle({ originId: origin.id, frame: 'X-east,Y-up,Z-south', cell: cid, surfaceTags }, cellColliders);
  const collisionPath = `collision/${cid}.bin`;
  writeFileSync(path.join(values.out!, collisionPath), col);
  const collisionTriangles = cellColliders.reduce((s, c) => s + c.indices.length / 3, 0);
  const crossing = buildings.filter(b => b.cell !== cid && b.max[0] > bounds[0] && b.min[0] < bounds[2] && b.max[2] > bounds[1] && b.min[2] < bounds[3]).map(b => b.id);
  const desc: CellDescriptor = {
    id: cid, cx: cxIdx, cz: czIdx, boundsXZ: bounds,
    visual: { lod0: { path: visualPath, bytes: glbBytes.byteLength, sha256: sha256(glbBytes), triangles: glb.stats.triangles, drawCalls, atlases: facadeAtlas?.atlases.length ?? 0, textureBytesEstimate: glb.stats.textureTexels * 4 * 1.333 } },
    collision: { path: collisionPath, bytes: col.byteLength, sha256: sha256(col), triangles: collisionTriangles },
    buildingIds: [...cb.map(b => b.id), ...crossing], buildings: records, sourceTiles: [...new Set(cb.map(b => city.buildings.find((x: any) => x.id === b.id)?.sourceTile as string))],
  };
  descriptors.push(desc);
  colliders[cid] = cellColliders;
  buildingRecords[cid] = records;
  totalDrawCalls += drawCalls;
  totalTextureBytes += glb.stats.textureBytes;
  totalTextureTexels += glb.stats.textureTexels;
  for (const [h, bytes] of glb.textureHashes) uniqueTextures.set(h, bytes);
  atlasUsage[cid] = (facadeAtlas?.fillRatio ?? []).map(v => Math.round(v * 100) / 100);
  cellStats.push({ cell: cid, buildings: cb.length, drawCalls, triangles: glb.stats.triangles, glbBytes: glbBytes.byteLength, ktx2Bytes: glb.stats.textureBytes, textureTexels: glb.stats.textureTexels, collisionTriangles, atlases: atlasUsage[cid] });
  log(`${cid}: ${cb.length} buildings, ${drawCalls} draw calls, ${glb.stats.triangles} triangles, ${(glbBytes.byteLength / 1e6).toFixed(2)} MB`);
}

// Texture residency estimate: unique KTX2 payloads only, UASTC at 1 byte per texel (BC7/ASTC) and ETC1S at 0.5
// (BC1/ETC1), each with a full mip chain (x1.333). A lower bound: the runtime loads every cell's copy and three.js
// transcodes ETC1S to BC7 where BPTC exists; verify-browser measures the uploaded bytes (backlog-m2 item 23).
let residentBytes = 0;
for (const b of uniqueTextures.values()) residentBytes += b;
const residentMiB = residentBytes / (1024 * 1024);
const supportTerrainBytes = encodeTerrain(runtimeTerrain);
writeFileSync(path.join(values.out!, 'runtime-terrain.bin'), supportTerrainBytes);
const report = {
  supportTerrain: { path: 'runtime-terrain.bin', bytes: supportTerrainBytes.byteLength, sha256: sha256(supportTerrainBytes) },
  schemaVersion: 1, builtAt: new Date().toISOString(), originId: origin.id, cellSize: CELL, lighting: lit ? 'lit-facades' : 'unlit-facades',
  inputs: { cityModelSha256: city.binary.sha256, terrainSha256: terrainDoc.sha256, footprints: sha256(readFileSync(values.footprints!)), streetParts: sha256(readFileSync(values['street-parts']!)),
    osm: { ledger: osmLedger.source?.id ?? null, snapshot: values['osm-snapshot'], sha256: osmSnap.sha256 },
    landmarkModels: [...landmarkModels.values()].map(m => ({ id: m.id, vtj: m.vtj, source: (m.report['source'] as { file: string; sha256: string }), glbSha256: (m.report['glb'] as { sha256: string }).sha256 })),
    trees: values.trees ? sha256(readFileSync(path.join(values.trees, 'trees.json'))) : null },
  landmarkModels: landmarkReport,
  hiResFacadePages: [...hiResPages].sort((x, y) => x - y).map(t => ({ texture: t, file: city.textures[t].file, wallM2: Math.round(pageArea.get(t)!.wall), facingM2: Math.round(pageArea.get(t)!.facing), otherM2: Math.round(pageArea.get(t)!.other) })),
  trees: treesDoc ? { count: trees.length, trunkColliders: trees.filter(t => t.colliderHeight > 0 && !treesOutsideCells.includes(t.id)).length, outsideCells: treesOutsideCells } : null,
  vegetation: vegetation && treesDoc ? { options: vegetation, pages: [...vegetationReport.values()].sort((a, b) => b.texels - a.texels) } : null,
  curatedFacadeRestoration: { modules: facadeRestorer.modules, inputs: facadeRestorer.inputs, externalInputs: facadeRestorer.externalInputs, supportInputs: facadeRestorer.supportInputs, evidence: [...curatedFacadeReport.values()], sourceSha256: Object.fromEntries(facadeRestorationSourceFiles.map(file => [file, sha256(readFileSync(file))])) },
  stairs: { registerOptions: config.registerStairs, register: register.flights, flights: stairs.flights, overlappingNotDrawn: [...conflicting] },
  entranceTerraces: { options: config.entranceTerraces, terraces: terraces.terraces },
  retainingWalls: { options: config.retainingWalls, walls: walls.walls, registerAlignment: wallAlignment },
  matching: { matched: matched.length, ambiguous: buildings.filter(b => b.match === 'ambiguous').length, unmatched: buildings.filter(b => b.match === 'unmatched').length,
    medianOffsetMeters: matched.length ? matched.map(b => b.offset!).sort((a, b) => a - b)[Math.floor(matched.length / 2)] : null, buildings: matchReport },
  untextured: { options: untextured, buildings: untexturedReport },
  facadeGrade: facadeGrade ?? null,
  ground: ground.stats,
  ...(assembledGround.groundExclusions?{groundExclusions:assembledGround.groundExclusions}:{}),
  coastal: coastal ? {...coastal,waterPieces:undefined,waterCellCount:coastal.waterPieces.length,
    note:'Source-backed OSM coastline/water; surveyed bridge decks retained; conventional N2000 zero water plane, not a tide measurement. Water has no support collider; derived safety terrain lies below the kill plane.'} : null,
  cells: cellStats,
  totals: { cells: cellIds.length, drawCalls: totalDrawCalls, ktx2Bytes: totalTextureBytes, textureTexels: totalTextureTexels, uniqueTextures: uniqueTextures.size, residentTextureMiBEstimate: Math.round(residentMiB * 10) / 10 },
  budgets: { drawCallsPerCellMax: Math.max(...cellStats.map(c => c['drawCalls'] as number)), drawCallsPerCellLimit: config.budgets.drawCallsPerCell, residentTextureLimitMiB: config.budgets.lowPresetTextureMiB,
    residencyMode: config.streaming?.enabled === true ? 'bounded-runtime-window' : 'entire-release',
    runtimeResidencyVerification: config.streaming?.enabled === true ? 'REQUIRED: both presets, travel and return' : null,
    pass: cellStats.every(c => (c['drawCalls'] as number) <= config.budgets.drawCallsPerCell) && (config.streaming?.enabled === true || residentMiB <= config.budgets.lowPresetTextureMiB) },
};
writeFileSync(path.join(values.out!, 'cells.json'), JSON.stringify({ schemaVersion: 1, originId: origin.id, cellSize: CELL, cells: descriptors }, null, 1) + '\n');
writeFileSync(path.join(values.out!, 'report.json'), JSON.stringify({...report,groundRegion,groundWorkArea,excludedGround:excludedGround?{cells:values['exclude-ground-cells'],indexSha256:excludedGround.indexSha256,triangles:excludedGround.triangles,verticalTriangles:excludedGround.verticalTriangles}:null}, null, 1) + '\n');
// Instanced scenery (decision 0006): one entry per instance of a node of a scenery asset GLB that publish_release
// stages alongside; the asset hash ties the instances to the models they were sized for.
if (treesDoc) writeFileSync(path.join(values.out!, 'scenery.json'), JSON.stringify({
  schemaVersion: 1, originId: origin.id, frame: 'X-east,Y-up,Z-south; position is the model origin (a trunk base); yaw about +Y in radians; scale in the model frame',
  assets: [{ id: treesDoc.asset, sha256: treesDoc.assetSha256 }],
  instances: trees.map(t => ({ id: t.id, asset: treesDoc.asset, node: t.model, position: t.position, yaw: t.yaw, scale: t.scale })),
}, null, 1) + '\n');
log(`done: ${cellIds.length} cells, ${totalDrawCalls} draw calls, ${(totalTextureBytes / 1e6).toFixed(1)} MB KTX2, ~${residentMiB.toFixed(0)} MiB resident, budgets ${report.budgets.pass ? 'PASS' : 'FAIL'}`);
