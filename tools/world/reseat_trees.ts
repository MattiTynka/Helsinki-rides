// Offline derived tree registration. Writes a fresh unpublished candidate; never alters source placements.
// --authority PLAN --candidate FINAL_CELLS --candidate-index-sha256 SHA256 --out NEW_WORK_DIR
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { cellId, cellIndexFor, geodeticToGk25, parseCollisionBundle, type CellDescriptor, type CollisionBundle } from '../../packages/world-schema/src/index.ts';
import { loadGeoJsonPolygons, pointInPolygon, ringDistance, segmentDistance, type LocalPolygon, type Pt } from './lib/geometry.ts';
import { buildCoastalMask, sourceCoastalDecks, type CoastalOsm } from './lib/coastal-mask.ts';
import { applyTreeRegistrations, assertRegistrationHash, conditionalTreeOmission, createTreeSoilInspector, omitRegisteredTreeColliders, planTreeRegistration, planTreeSoilSink, qualifyTreeSoil, registrationSha256 as sha, sampleTreeRegistrationGround, translateRegisteredTreeColliders, treeRegistrationPoints,
  type GroundRegistrationSupport, type RegistrationScenery, type RegistrationTree, type TreeRegistrationCorrection } from './lib/tree-ground-registration.ts';
import { decodeTreeBarkModels, measureTreeBarkProfile, planTreeCaseSink, qualifyContinuousTreeCase, qualifyTreeBank, visibleTreeObstacles, type ContinuousTreeCase, type TreeBarkProfile } from './lib/tree-bark-registration.ts';

interface PinnedFile { path: string; sha256: string }
interface PinnedCells { path: string; indexSha256: string; scenerySha256: string }
interface Authority {
  schemaVersion: 1; kind: 'source-bound-tree-registration'; originId: string; assetSha256: string; thresholdMetres: number;
  baselineCells: PinnedCells; auditCells: PinnedCells; audit: PinnedFile; sourceTrees: PinnedFile; sourceReport: PinnedFile; acceptedTrees: PinnedFile;
  confirmedTreeIds: string[]; acceptedCount: number; protectedArea: { minX: number; maxX: number; minZ: number; maxZ: number };
  mode?: 'preserve-offset' | 'intended-soil-sink';
  soilSources?: { origin: PinnedFile; config: PinnedFile; streetParts: PinnedFile; footprints: PinnedFile; osm: PinnedFile };
  omissions?: { treeIds: string[]; supportAudit: PinnedFile; sourceProofs: PinnedFile[]; reason: string };
  soilCases?: { asset: PinnedFile; continuous: (ContinuousTreeCase & { proof: PinnedFile })[]; banks: { id: string; waterY: number; proof: PinnedFile; references: PinnedFile[] }[] };
  modelIncompatibleOmissions?: { id: string; kind: 'retaining-wall' | 'building'; sourceIds: string[]; proof: PinnedFile }[];
  authorityInputs?: Record<string, PinnedFile>;
}
interface CellsIndex { originId: string; cellSize: number; cells: CellDescriptor[]; [key: string]: unknown }
interface Scenery { originId: string; assets: { id: string; sha256: string }[]; instances: RegistrationScenery[]; [key: string]: unknown }
interface Trees { originId: string; asset: string; assetSha256: string; trees: RegistrationTree[]; [key: string]: unknown }
interface AuditRow {
  id: string; accepted: boolean; scenery: RegistrationScenery; trunkPolicy: { radius: number; colliderHeight: number };
  before: { samples: (GroundRegistrationSupport | null)[] }; after: { samples: (GroundRegistrationSupport | null)[] }; offsetDelta: number | null;
}
interface Audit { before: { indexSha256: string; scenerySha256: string }; after: { indexSha256: string; scenerySha256: string }; rows: AuditRow[]; files: PinnedFile[] }

/** Decode existing visible ground only; water, buildings and tree caps are excluded. */
export async function sampleRenderedTreeGround(dir: string, index: CellsIndex, points: readonly [number, number][], read: (p: string) => Uint8Array = p => readFileSync(p)) {
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const bundles: CollisionBundle[] = [];
  for (const cell of index.cells) {
    const bounds = cell.boundsXZ;
    if (!points.some(([x, z]) => x >= bounds[0] - .001 && x <= bounds[2] + .001 && z >= bounds[1] - .001 && z <= bounds[3] + .001)) continue;
    const payload = read(path.join(dir, cell.visual.lod0.path)); assertRegistrationHash(payload, cell.visual.lod0.sha256, 'omission visible-ground payload');
    const doc = await io.readBinary(payload), colliders = [];
    for (const node of doc.getRoot().listNodes().filter(n => n.getName().startsWith(`${cell.id}_ground_`) && n.getMesh())) {
      const matrix = node.getWorldMatrix();
      for (const prim of node.getMesh()!.listPrimitives()) {
        const P = prim.getAttribute('POSITION'), I = prim.getIndices(); assert.ok(P && I && prim.getMode() === 4, 'Ground omission proof requires indexed triangles');
        const positions = new Float32Array(P.getCount() * 3);
        for (let i = 0; i < P.getCount(); i++) { const v = P.getElement(i, []); for (let axis = 0; axis < 3; axis++) positions[i * 3 + axis] = matrix[axis]! * v[0]! + matrix[4 + axis]! * v[1]! + matrix[8 + axis]! * v[2]! + matrix[12 + axis]!; }
        colliders.push({ id: node.getName(), ref: null, group: 'ground' as const, positions, indices: Uint32Array.from(I.getArray()!), triangleTags: new Uint16Array(I.getCount() / 3) });
      }
    }
    bundles.push({ header: { version: 2, originId: index.originId, frame: 'X-east,Y-up,Z-south', cell: cell.id, surfaceTags: ['rendered-ground'], colliders: [] }, colliders });
  }
  return sampleTreeRegistrationGround(bundles, points);
}

export async function reseatTrees(options: { authority: string; candidate: string; candidateIndexSha256: string; out: string; checkOnly?: boolean }) {
  const inputs = new Map<string, string>();
  const bytes = (p: string) => { const b = readFileSync(p); inputs.set(p, sha(b)); return b; };
  const json = <T>(p: string): T => JSON.parse(bytes(p).toString('utf8')) as T;
  const pinned = <T>(p: PinnedFile): T => { const b = bytes(p.path); assertRegistrationHash(b, p.sha256, p.path); return JSON.parse(b.toString('utf8')) as T; };
  const toolSources = [new URL(import.meta.url), new URL('./lib/tree-ground-registration.ts', import.meta.url), new URL('./lib/tree-bark-registration.ts', import.meta.url)].map(url => { const modulePath = fileURLToPath(url); return { path: modulePath, sha256: sha(bytes(modulePath)) }; });
  const authority = json<Authority>(options.authority);
  for (const file of Object.values(authority.authorityInputs ?? {})) assertRegistrationHash(bytes(file.path), file.sha256, 'authority derivation input');
  assert.equal(authority.schemaVersion, 1); assert.equal(authority.kind, 'source-bound-tree-registration');
  assert.ok(Array.isArray(authority.confirmedTreeIds) && authority.confirmedTreeIds.length >= 1 && authority.confirmedTreeIds.length <= 500, 'Authority must contain1..500 explicitly confirmed tree IDs');
  assert.equal(new Set(authority.confirmedTreeIds).size, authority.confirmedTreeIds.length); assert.equal(authority.acceptedCount, 810);
  assert.equal(authority.thresholdMetres, .15);
  const trees = pinned<Trees>(authority.sourceTrees), sourceReport = pinned<Record<string, unknown>>(authority.sourceReport), accepted = pinned<Trees>(authority.acceptedTrees), audit = pinned<Audit>(authority.audit);
  assert.equal(trees.originId, authority.originId); assert.equal(trees.assetSha256, authority.assetSha256);
  assert.equal(accepted.originId, trees.originId); assert.equal(accepted.assetSha256, trees.assetSha256);
  assert.equal(accepted.trees.length, authority.acceptedCount); assert.deepEqual(trees.trees.slice(0, authority.acceptedCount), accepted.trees);
  const acceptedIds = new Set(accepted.trees.map(t => t.id)), ids = new Set(authority.confirmedTreeIds), treeById = new Map(trees.trees.map(t => [t.id, t]));
  assert.equal(audit.rows.length, trees.trees.length); assert.equal(new Set(audit.rows.map(r => r.id)).size, audit.rows.length);
  for (const row of audit.rows) assert.equal(row.accepted, acceptedIds.has(row.id), 'Audit accepted/source identity changed');
  const mode = authority.mode ?? 'preserve-offset'; assert.ok(mode === 'preserve-offset' || mode === 'intended-soil-sink');
  let inspectSoil: ReturnType<typeof createTreeSoilInspector> | null = null;
  let sourceParts: LocalPolygon[] = [], sourceFootprints: LocalPolygon[] = [], sourceOrigin: number[] = [], sourceOsm: CoastalOsm | null = null;
  let sourceWaterY: number | null = null;
  if (mode === 'intended-soil-sink') {
    assert.ok(authority.soilSources, 'Intended soil mode requires pinned source qualification'); const source = authority.soilSources;
    const origin = pinned<{ id: string; originProjected: number[] }>(source.origin), config = pinned<{ playArea: { minX: number; maxX: number; minZ: number; maxZ: number }; coastal?: { waterElevationN2000: number } }>(source.config), osm = pinned<CoastalOsm>(source.osm);
    assert.equal(origin.id, authority.originId); for (const file of [source.streetParts, source.footprints]) assertRegistrationHash(bytes(file.path), file.sha256, file.path);
    const parts = loadGeoJsonPolygons(source.streetParts.path, origin.originProjected[0]!, origin.originProjected[1]!, (p, i) => String(p['osan_id'] ?? i));
    const footprints = loadGeoJsonPolygons(source.footprints.path, origin.originProjected[0]!, origin.originProjected[1]!, (p, i) => String(p['vtj_prt'] ?? i));
    const mask = buildCoastalMask(osm, { area: config.playArea, originProjected: origin.originProjected }), decks = sourceCoastalDecks(osm, parts, origin.originProjected);
    inspectSoil = createTreeSoilInspector(parts, footprints, mask.water, decks.polygons);
    sourceParts = parts; sourceFootprints = footprints; sourceOrigin = origin.originProjected; sourceOsm = osm;
    if (config.coastal) sourceWaterY = config.coastal.waterElevationN2000 - origin.originProjected[2]!;
  }
  const intendedNeeds = (row: AuditRow) => {
    if (row.accepted) return { qualified: true, reasons: [], range: null, context: { retainingWallIds: [], buildingIds: [], waterPointIndices: [] }, needs: false };
    const tree = treeById.get(row.id); assert.ok(tree); const q = qualifyTreeSoil(row.after.samples, inspectSoil!(tree));
    return { ...q, needs: !row.accepted && q.qualified && Math.abs(q.range![0] - .3 - tree.position[1]) > authority.thresholdMetres };
  };
  const selectedRows = mode === 'preserve-offset' ? audit.rows.filter(r => r.offsetDelta !== null && Math.abs(r.offsetDelta) > authority.thresholdMetres) : audit.rows.filter(r => intendedNeeds(r).needs);
  if (!authority.soilCases) assert.deepEqual(selectedRows.map(r => r.id).sort(), [...ids].sort(), 'Authority is not the exact confirmed audit ID set');
  const readIndex = (p: PinnedCells) => { const file = path.join(p.path, 'cells.json'), b = bytes(file); assertRegistrationHash(b, p.indexSha256, file); const index = JSON.parse(b.toString('utf8')) as CellsIndex; assert.equal(index.originId, authority.originId); return index; };
  const baselineIndex = readIndex(authority.baselineCells), auditIndex = readIndex(authority.auditCells);
  assert.equal(audit.before.indexSha256, authority.baselineCells.indexSha256); assert.equal(audit.after.indexSha256, authority.auditCells.indexSha256);
  assert.equal(audit.before.scenerySha256, authority.baselineCells.scenerySha256); assert.equal(audit.after.scenerySha256, authority.auditCells.scenerySha256);
  for (const p of [authority.baselineCells, authority.auditCells]) assertRegistrationHash(bytes(path.join(p.path, 'scenery.json')), p.scenerySha256, `${p.path}/scenery.json`);
  const candidateIndexBytes = bytes(path.join(options.candidate, 'cells.json'));
  assertRegistrationHash(candidateIndexBytes, options.candidateIndexSha256, 'final candidate index');
  if (mode === 'intended-soil-sink') assert.equal(options.candidateIndexSha256, authority.auditCells.indexSha256, 'Intended soil mode needs a fresh audit of the exact final candidate');
  const candidateIndex = JSON.parse(candidateIndexBytes.toString('utf8')) as CellsIndex;
  assert.equal(candidateIndex.originId, authority.originId); assert.equal(candidateIndex.cellSize, baselineIndex.cellSize);
  for (const index of [baselineIndex, auditIndex, candidateIndex]) {
    assert.equal(new Set(index.cells.map(c => c.id)).size, index.cells.length);
    for (const cell of index.cells) { const p = cell.collision.path; assert.ok(!path.isAbsolute(p) && !p.split(/[\\/]/).includes('..'), 'Collision payload must be a relative cell path'); }
  }
  const scenery = json<Scenery>(path.join(options.candidate, 'scenery.json'));
  assert.equal(scenery.originId, authority.originId); assert.ok(scenery.assets.some(a => a.id === trees.asset && a.sha256 === authority.assetSha256));
  // This postprocessor is not a way to conceal another placement/asset revision.
  assert.equal(sha(readFileSync(path.join(options.candidate, 'scenery.json'))), authority.auditCells.scenerySha256, 'Final candidate tree/scenery placements changed since the authority');
  assert.ok(!existsSync(path.join(options.candidate, 'tree-registration')), 'Candidate already has a derived tree registration');
  const cache = new Map<string, CollisionBundle>();
  function bundles(dir: string, index: CellsIndex, points: readonly [number, number][]) {
    const needed = new Set<string>();
    for (const [x, z] of points) {
      const [cx, cz] = cellIndexFor(x, z, index.cellSize), xs = [cx], zs = [cz];
      if (Math.abs(x / index.cellSize - Math.round(x / index.cellSize)) < .001 / index.cellSize) xs.push(cx - 1);
      if (Math.abs(z / index.cellSize - Math.round(z / index.cellSize)) < .001 / index.cellSize) zs.push(cz - 1);
      for (const a of xs) for (const b of zs) needed.add(cellId(a, b));
    }
    return [...needed].flatMap(id => {
      const cell = index.cells.find(c => c.id === id); if (!cell) return [];
      const file = path.join(dir, cell.collision.path); let bundle = cache.get(file);
      if (!bundle) { const b = bytes(file); assertRegistrationHash(b, cell.collision.sha256, file); bundle = parseCollisionBundle(b); assert.equal(bundle.header.cell, id); cache.set(file, bundle); }
      return [bundle];
    });
  }
  const corrections: TreeRegistrationCorrection[] = [], caseProofs: Record<string, unknown>[] = [];
  const specialIds = new Set([...(authority.soilCases?.continuous ?? []), ...(authority.soilCases?.banks ?? [])].map(c => c.id));
  assert.equal(specialIds.size, (authority.soilCases?.continuous.length ?? 0) + (authority.soilCases?.banks.length ?? 0), 'Duplicate soil exception ID');
  const checkNew = (id: string) => { const tree = treeById.get(id); assert.ok(tree && !acceptedIds.has(id), 'Only an existing new source tree can have a case decision'); const [x, , z] = tree.position, keep = authority.protectedArea; assert.ok(!(x >= keep.minX && x <= keep.maxX && z >= keep.minZ && z <= keep.maxZ), 'Accepted rectangle is protected'); return tree; };
  const sourceProof = (file: PinnedFile, id: string) => { const record = pinned<{ rows?: { id: string }[] }>(file); assert.ok(record.rows?.some(r => r.id === id), `Case evidence does not contain ${id}`); };
  const profileFor = (tree: RegistrationTree, model: Awaited<ReturnType<typeof decodeTreeBarkModels>> extends Map<string, infer V> ? V : never) => measureTreeBarkProfile(model, tree, points => sampleTreeRegistrationGround(bundles(options.candidate, candidateIndex, points), points));
  const visibleCells = (tree: RegistrationTree) => { const [x, , z] = tree.position, r = tree.trunkRadius + 1; return candidateIndex.cells.filter(c => c.boundsXZ[0] <= x + r && c.boundsXZ[2] >= x - r && c.boundsXZ[1] <= z + r && c.boundsXZ[3] >= z - r || c.buildings.some(b => { const q = b.boundsRuntime; return q.min[0] <= x + r && q.max[0] >= x - r && q.min[2] <= z + r && q.max[2] >= z - r; })).map(c => { const payload = bytes(path.join(options.candidate, c.visual.lod0.path)); assertRegistrationHash(payload, c.visual.lod0.sha256, 'actual bark obstacle payload'); return { id: c.id, bytes: payload }; }); };
  let models: Awaited<ReturnType<typeof decodeTreeBarkModels>> | null = null;
  if (authority.soilCases || authority.modelIncompatibleOmissions?.length) {
    assert.equal(mode, 'intended-soil-sink'); assert.ok(authority.soilCases && inspectSoil);
    assert.ok(authority.soilCases.continuous.length <= 6 && authority.soilCases.banks.length <= 2, 'Unbounded explicit soil exceptions');
    assertRegistrationHash(bytes(authority.soilCases.asset.path), authority.assetSha256, 'actual source bark asset');
    assert.equal(authority.soilCases.asset.sha256, authority.assetSha256); models = await decodeTreeBarkModels(bytes(authority.soilCases.asset.path));
    for (const spec of authority.soilCases.continuous) {
      const tree = checkNew(spec.id); sourceProof(spec.proof, tree.id); const model = models.get(tree.model); assert.ok(model);
      const profile = profileFor(tree, model), final = sampleTreeRegistrationGround(bundles(options.candidate, candidateIndex, treeRegistrationPoints(tree)), treeRegistrationPoints(tree)); assert.ok(final.every(Boolean));
      const anchor = Math.min(...final.map(s => s!.height)), target = anchor - .3, obstacles = await visibleTreeObstacles(tree, model, target, profile.range!, visibleCells(tree));
      assert.ok(profile.range && target <= profile.range[0] - .01, 'Continuous-soil tree root must remain beneath the dense actual soil minimum');
      const qualification = qualifyContinuousTreeCase(profile, inspectSoil.points(profile.rootPoints), obstacles, spec);
      const row = audit.rows.find(r => r.id === tree.id); assert.ok(row); const correction = planTreeCaseSink(tree, row.before.samples, final, anchor, target, .15, 'continuous-soil-sink');
      if (correction.applied) corrections.push(correction); caseProofs.push({ id: tree.id, kind: 'continuous-soil', qualification, profile, obstacles, correction });
    }
    for (const spec of authority.soilCases.banks) {
      assert.equal(spec.waterY, sourceWaterY, 'Bank policy must use the pinned final source water plane');
      const tree = checkNew(spec.id); sourceProof(spec.proof, tree.id); assert.ok(spec.references.length >= 2, 'Bank requires source orthophoto and retrieval proof'); for (const file of spec.references) assertRegistrationHash(bytes(file.path), file.sha256, 'bank source reference'); const model = models.get(tree.model); assert.ok(model); const profile = profileFor(tree, model), visual = await sampleRenderedTreeGround(options.candidate, candidateIndex, profile.rootPoints, bytes);
      const heights = profile.rootSamples.flatMap(s => s ? [s.height] : []); assert.ok(heights.length); const range: [number, number] = [Math.min(...heights), Math.max(...heights)], target = Math.min(range[0] - .3, spec.waterY - .02), obstacles = await visibleTreeObstacles(tree, model, target, range, visibleCells(tree));
      const qualification = qualifyTreeBank(profile, inspectSoil.points(profile.rootPoints), visual, obstacles, spec.waterY, inspectSoil.points(profile.gridPoints)), row = audit.rows.find(r => r.id === tree.id); assert.ok(row);
      const correction = planTreeCaseSink(tree, row.before.samples, profile.rootSamples, qualification.anchor, qualification.target, .15, 'shore-bank-sink');
      if (correction.applied) corrections.push(correction); caseProofs.push({ id: tree.id, kind: 'shore-bank', qualification, profile, visual, obstacles, correction, trunkColliderTop: correction.afterY + tree.colliderHeight, trunkColliderHeightAboveHighestBank: correction.afterY + tree.colliderHeight - range[1] });
    }
    assert.deepEqual([...selectedRows.map(r => r.id), ...corrections.map(c => c.id)].sort(), [...ids].sort(), 'Authority is not the exact confirmed audit and qualified case ID set');
  }
  for (const id of authority.confirmedTreeIds) {
    if (specialIds.has(id)) continue;
    const tree = treeById.get(id), row = audit.rows.find(r => r.id === id); assert.ok(tree && row); assert.ok(!acceptedIds.has(id) && !row.accepted);
    const [x, , z] = tree.position, keep = authority.protectedArea;
    assert.ok(!(x >= keep.minX && x <= keep.maxX && z >= keep.minZ && z <= keep.maxZ), `${id}: accepted area is protected`);
    assert.deepEqual(row.scenery.position, tree.position); assert.deepEqual(row.scenery.scale, tree.scale); assert.equal(row.scenery.node, tree.model); assert.equal(row.scenery.yaw, tree.yaw);
    assert.equal(row.trunkPolicy.radius, tree.trunkRadius); assert.equal(row.trunkPolicy.colliderHeight, tree.colliderHeight);
    const points = treeRegistrationPoints(tree), baseline = sampleTreeRegistrationGround(bundles(authority.baselineCells.path, baselineIndex, points), points);
    const originalAudit = sampleTreeRegistrationGround(bundles(authority.auditCells.path, auditIndex, points), points);
    for (const [measured, recorded] of [[baseline, row.before.samples], [originalAudit, row.after.samples]] as const) {
      assert.equal(recorded.length, 9);
      measured.forEach((p, i) => { if (!p || !recorded[i]) { assert.equal(p, recorded[i], `${id}: stale missing support`); return; } assert.ok(Math.abs(p.height - recorded[i]!.height) < 1e-9, `${id}: stale recorded support`); assert.equal(p.collider, recorded[i]!.collider); assert.equal(p.cell, recorded[i]!.cell); });
    }
    const final = sampleTreeRegistrationGround(bundles(options.candidate, candidateIndex, points), points);
    const owner = cellId(...cellIndexFor(x, z, candidateIndex.cellSize));
    assert.ok(candidateIndex.cells.some(c => c.id === owner), `${id}: final cell missing`);
    corrections.push(mode === 'preserve-offset' ? planTreeRegistration(tree, baseline, final, authority.thresholdMetres) : planTreeSoilSink(tree, baseline, final, authority.thresholdMetres, inspectSoil!(tree)));
  }
  const omittedIds = new Set<string>(), omissionProofs: { id: string; sourcePlacement: RegistrationTree; collision: (GroundRegistrationSupport | null)[]; visual: (GroundRegistrationSupport | null)[]; omitted: boolean }[] = [];
  if (authority.omissions) {
    assert.equal(mode, 'intended-soil-sink'); const spec = authority.omissions;
    assert.equal(spec.treeIds.length, 5); assert.equal(new Set(spec.treeIds).size, 5); assert.ok(spec.reason.length > 0 && spec.sourceProofs.length >= 3);
    const original = pinned<{ rows: AuditRow[] }>(spec.supportAudit);
    assert.deepEqual(original.rows.filter(r => !r.accepted && r.before.samples[0] === null).map(r => r.id).sort(), [...spec.treeIds].sort(), 'Omission authority differs from the five confirmed unsupported source centres');
    for (const file of spec.sourceProofs) assertRegistrationHash(bytes(file.path), file.sha256, 'conditional omission source reference');
    for (const id of spec.treeIds) {
      assert.ok(!acceptedIds.has(id), 'Accepted tree cannot be omitted'); const tree = treeById.get(id); assert.ok(tree);
      const [x, , z] = tree.position, keep = authority.protectedArea; assert.ok(!(x >= keep.minX && x <= keep.maxX && z >= keep.minZ && z <= keep.maxZ));
      const points = treeRegistrationPoints(tree), collision = sampleTreeRegistrationGround(bundles(options.candidate, candidateIndex, points), points);
      const visual = await sampleRenderedTreeGround(options.candidate, candidateIndex, points, bytes), omitted = conditionalTreeOmission(collision, visual);
      if (omitted) { assert.ok(!ids.has(id), 'An omitted unsupported tree cannot also be aligned'); omittedIds.add(id); }
      omissionProofs.push({ id, sourcePlacement: tree, collision, visual, omitted });
    }
  }
  const incompatibleProofs: Record<string, unknown>[] = [];
  if (authority.modelIncompatibleOmissions?.length) {
    assert.ok(models && inspectSoil && sourceOsm); assert.ok(authority.modelIncompatibleOmissions.length <= 5, 'Unbounded model-incompatible omissions');
    assert.equal(new Set(authority.modelIncompatibleOmissions.map(s => s.id)).size, authority.modelIncompatibleOmissions.length);
    const osmNodes = new Map<number, Pt>(); for (const n of sourceOsm.elements) if (n.type === 'node' && n.lat !== undefined && n.lon !== undefined) { const [E, N] = geodeticToGk25(n.lat, n.lon); osmNodes.set(n.id, [E - sourceOrigin[0]!, N - sourceOrigin[1]!]); }
    for (const spec of authority.modelIncompatibleOmissions) {
      const tree = checkNew(spec.id); sourceProof(spec.proof, tree.id); assert.ok(!ids.has(tree.id) && !omittedIds.has(tree.id)); const model = models.get(tree.model); assert.ok(model);
      const polygons = (spec.kind === 'building' ? sourceFootprints : sourceParts.filter(p => p.properties['paatyyppi'] === 'Varusteet' && p.properties['alatyyppi'] === 'Tukimuuri')).filter(p => spec.sourceIds.includes(p.id));
      const lines: Pt[][] = spec.sourceIds.filter(id => id.startsWith('osm-way-')).map((id): Pt[] => { const way: CoastalOsm['elements'][number] | undefined = sourceOsm!.elements.find(e => e.type === 'way' && `osm-way-${e.id}` === id); assert.ok(way?.tags?.['barrier'] === 'retaining_wall'); const line: (Pt | undefined)[] = (way.nodes ?? []).map((n: number) => osmNodes.get(n)); assert.ok(line.length > 1 && line.every(Boolean)); return line as Pt[]; });
      assert.equal(polygons.length + lines.length, spec.sourceIds.length, 'Omission source obstacle not found');
      const profile = profileFor(tree, model), context = inspectSoil.points(profile.rootPoints), dry = profile.rootSamples.filter((s, i) => s && !context.waterPointIndices.includes(i) && !polygons.some(p => pointInPolygon([profile.rootPoints[i]![0], -profile.rootPoints[i]![1]], p.rings)));
      assert.ok(dry.length, 'No source-qualified soil beside obstacle'); const heights = dry.map(s => s!.height), range: [number, number] = [Math.min(...heights), Math.max(...heights)], target = range[0] - .3;
      const obstacles = await visibleTreeObstacles(tree, model, target, range, visibleCells(tree));
      const closeToSource = (p: [number, number, number]) => polygons.some(q => pointInPolygon([p[0], -p[2]], q.rings) || q.rings.some(r => ringDistance([p[0], -p[2]], r) <= .025)) || lines.some(line => line.slice(0, -1).some((a, i) => segmentDistance([p[0], -p[2]], a, line[i + 1]!).d <= .05));
      const matched = obstacles.filter(o => (spec.kind === 'building' ? o.node.includes('_facades_') || o.node.endsWith('_flat') : o.node.endsWith('_ground_slabs')) && o.intersections.some(closeToSource));
      const omitted = matched.length > 0; if (omitted) omittedIds.add(tree.id);
      incompatibleProofs.push({ id: tree.id, kind: spec.kind, sourceIds: spec.sourceIds, profile, intendedSoilY: target, obstacles, matched, omitted });
      assert.ok(omitted, `${tree.id}: model-incompatibility condition changed; review final tree disposition`);
    }
  }
  const translated = applyTreeRegistrations(trees.trees, scenery.instances, corrections, acceptedIds, trees.asset);
  const unresolvedSoilCases = mode === 'intended-soil-sink' ? audit.rows.filter(r => !r.accepted && !omittedIds.has(r.id) && !specialIds.has(r.id)).flatMap(row => { const q = intendedNeeds(row); const heights = row.after.samples.filter((s): s is GroundRegistrationSupport => s !== null).map(s => s.height); const needs = heights.length < 9 || heights.length && Math.abs(Math.min(...heights) - .3 - treeById.get(row.id)!.position[1]) > .15; return !q.qualified && needs ? [{ id: row.id, reasons: q.reasons, context: q.context, range: q.range }] : []; }) : [];
  if (options.checkOnly) {
    for (const [file, digest] of inputs) assertRegistrationHash(readFileSync(file), digest, `input changed during preflight ${file}`);
    return { status: 'READ_ONLY_TREE_REGISTRATION_PREFLIGHT', out: options.out, selected: ids.size, applied: corrections.filter(c => c.applied).length, omitted: omittedIds.size, runtimeTreeCount: trees.trees.length - omittedIds.size, unresolvedSoilCases: unresolvedSoilCases.length, changedCollisionCells: 0, indexSha256: options.candidateIndexSha256, scenerySha256: authority.auditCells.scenerySha256, proofSha256: null, plannedCorrections: corrections, plannedOmissions: [...omittedIds], caseProofs, incompatibleProofs, omissionProofs, toolSources, inputs: [...inputs].map(([path, sha256]) => ({ path, sha256 })), peakRssBytes: process.resourceUsage().maxRSS * 1024, limitation: 'Read-only preflight; no candidate or payload was written. Counts describe the conditional plan, not executed changes.' };
  }
  assert.equal(unresolvedSoilCases.length, 0, 'Unresolved source-soil cases require review before candidate creation');
  const out = path.resolve(options.out), work = path.resolve('data/work');
  assert.ok(out.startsWith(work + path.sep), 'Fresh candidate must stay within data/work'); assert.ok(!existsSync(out), 'Output already exists');
  for (const input of [options.candidate, authority.baselineCells.path, authority.auditCells.path]) assert.ok(!out.startsWith(path.resolve(input) + path.sep), 'Output cannot be inside an input candidate');
  // Snapshot/copy every payload, including unchanged GLBs and source metadata. No shared hardlinks.
  const inventory: PinnedFile[] = [];
  function copyTree(relative = '') {
    const dir = path.join(options.candidate, relative); mkdirSync(path.join(out, relative), { recursive: true });
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink(), 'Candidate symlinks are not supported'); const rel = path.join(relative, entry.name);
      if (entry.isDirectory()) copyTree(rel);
      else { assert.ok(entry.isFile()); const digest = sha(bytes(path.join(options.candidate, rel))); copyFileSync(path.join(options.candidate, rel), path.join(out, rel)); inventory.push({ path: rel, sha256: digest }); }
    }
  }
  copyTree();
  const changedPaths = new Set(['cells.json', 'report.json', 'scenery.json']), collisionProofs: { cell: string; beforeSha256: string; afterSha256: string; changedColliderIds: string[]; removedColliderIds: string[]; onlyTreeYBytesChanged: boolean; retainedColliderProof: ReturnType<typeof omitRegisteredTreeColliders>['retained'] }[] = [];
  const cells = candidateIndex.cells.map(cell => {
    const selected = corrections.filter(c => c.applied && cellId(...cellIndexFor(treeById.get(c.id)!.position[0], treeById.get(c.id)!.position[2], candidateIndex.cellSize)) === cell.id);
    const cellOmissions = new Set([...omittedIds].filter(id => { const t = treeById.get(id)!; return cellId(...cellIndexFor(t.position[0], t.position[2], candidateIndex.cellSize)) === cell.id; }));
    if (!selected.length && !cellOmissions.size) return cell;
    const file = path.join(options.candidate, cell.collision.path), original = bytes(file), moved = translateRegisteredTreeColliders(original, trees.trees, selected);
    const filtered = omitRegisteredTreeColliders(moved.bytes, trees.trees, cellOmissions);
    if (!moved.changedColliderIds.length && !filtered.removedColliderIds.length) return cell;
    writeFileSync(path.join(out, cell.collision.path), filtered.bytes); changedPaths.add(path.normalize(cell.collision.path));
    const digest = sha(filtered.bytes); collisionProofs.push({ cell: cell.id, beforeSha256: sha(original), afterSha256: digest, changedColliderIds: moved.changedColliderIds,
      removedColliderIds: filtered.removedColliderIds, onlyTreeYBytesChanged: !filtered.reencoded, retainedColliderProof: filtered.retained });
    return { ...cell, collision: { ...cell.collision, sha256: digest, bytes: filtered.bytes.byteLength, triangles: parseCollisionBundle(filtered.bytes).colliders.reduce((n, c) => n + c.indices.length / 3, 0) } };
  });
  const newTrees: Trees = { ...trees, trees: translated.trees.filter(t => !omittedIds.has(t.id)) }, placementPath = 'tree-registration/trees.json';
  mkdirSync(path.join(out, 'tree-registration')); const placementBytes = JSON.stringify(newTrees, null, 1) + '\n';
  writeFileSync(path.join(out, placementPath), placementBytes);
  copyFileSync(authority.sourceTrees.path, path.join(out, 'tree-registration/source-trees.json'));
  writeFileSync(path.join(out, 'scenery.json'), JSON.stringify({ ...scenery, instances: translated.scenery.filter(s => s.asset !== trees.asset || !omittedIds.has(s.id)) }, null, 1) + '\n');
  writeFileSync(path.join(out, 'cells.json'), JSON.stringify({ ...candidateIndex, cells }, null, 1) + '\n');
  const proof = { schemaVersion: 1, status: 'DERIVED_TREE_REGISTRATION_PRESERVATION_PASS', mode,
    method: mode === 'intended-soil-sink' ? 'Qualified final soil minimum minus0.30m; explicit continuous/bank cases recompute actual bark profiles. Conditional omissions require either both collision/rendered-ground absence or actual bark intersection with the exact source-bound visible obstacle. Retained tree Y and matching trunk Y change together.' : 'Physically reasonable baseline centre-to-base offset preserved on final decoded HCOL; nine-point trunk footprint recorded.',
    authority: { path: options.authority, sha256: inputs.get(options.authority) }, candidateIndexSha256: options.candidateIndexSha256, sourceAssetSha256: authority.assetSha256,
    selectedIds: authority.confirmedTreeIds, appliedIds: corrections.filter(c => c.applied).map(c => c.id), noLongerMeaningfulIds: corrections.filter(c => !c.applied).map(c => c.id),
    acceptedPlacementsAndPolicyExact: true, acceptedCount: authority.acceptedCount, allXZModelsDimensionsYawScalePolicyExact: true,
    sourceTreeCount: trees.trees.length, runtimeTreeCount: newTrees.trees.length, omittedRuntimeIds: [...omittedIds], omissionProofs, incompatibleProofs, caseProofs,
    unresolvedSoilCases,
    collisionProofs, corrections, placement: { path: placementPath, sha256: sha(placementBytes) }, copiedFiles: inventory.length,
    sourceProofs: [...inputs].map(([path, sha256]) => ({ path, sha256 })), toolSources,
    limitation: 'No ground, raw source tree or asset is modified. Conditional omissions rebuild HCOL layout; header fields and every retained ordered collider subarray remain exact. Unresolved soil cases are not claimed fixed.' };
  const proofBytes = JSON.stringify(proof, null, 2) + '\n'; writeFileSync(path.join(out, 'tree-registration/proof.json'), proofBytes);
  writeFileSync(path.join(out, 'tree-registration/trees-report.json'), JSON.stringify({ ...sourceReport, derivedPlacement: { path: placementPath, sha256: sha(placementBytes), proofSha256: sha(proofBytes), sourceTreeCount: trees.trees.length, runtimeTreeCount: newTrees.trees.length, omittedRuntimeIds: [...omittedIds] } }, null, 1) + '\n');
  const report = json<Record<string, unknown> & { inputs: Record<string, unknown> }>(path.join(options.candidate, 'report.json'));
  const removedColliders = collisionProofs.reduce((n, p) => n + p.removedColliderIds.length, 0), priorTreeStats = report['trees'] as { count: number; trunkColliders: number; outsideCells: string[] } | null;
  writeFileSync(path.join(out, 'report.json'), JSON.stringify({ ...report, builtAt: new Date().toISOString(), inputs: { ...report.inputs, trees: sha(placementBytes) },
    ...(priorTreeStats ? { trees: { ...priorTreeStats, count: newTrees.trees.length, trunkColliders: priorTreeStats.trunkColliders - removedColliders, outsideCells: priorTreeStats.outsideCells.filter(id => !omittedIds.has(id)) } } : {}),
    treeRegistration: { authority: proof.authority, baseCandidate: options.candidate, baseIndexSha256: options.candidateIndexSha256, derivedPlacements: proof.placement, proof: { path: 'tree-registration/proof.json', sha256: sha(proofBytes) }, applied: proof.appliedIds.length, omittedRuntimeIds: [...omittedIds], unresolvedSoilCases: proof.unresolvedSoilCases } }, null, 1) + '\n');
  // A successful result proves all nonselected payloads byte-exact, not merely decoded equivalent.
  for (const file of inventory) if (!changedPaths.has(file.path)) assertRegistrationHash(readFileSync(path.join(out, file.path)), file.sha256, `copied payload ${file.path}`);
  for (const [file, digest] of inputs) assertRegistrationHash(readFileSync(file), digest, `input changed during postprocess ${file}`);
  assert.deepEqual(newTrees.trees.slice(0, authority.acceptedCount), accepted.trees);
  return { out, selected: authority.confirmedTreeIds.length, applied: proof.appliedIds.length, omitted: omittedIds.size, runtimeTreeCount: newTrees.trees.length, unresolvedSoilCases: proof.unresolvedSoilCases.length, changedCollisionCells: collisionProofs.length, indexSha256: sha(readFileSync(path.join(out, 'cells.json'))), scenerySha256: sha(readFileSync(path.join(out, 'scenery.json'))), proofSha256: sha(proofBytes) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { authority: { type: 'string' }, candidate: { type: 'string' }, 'candidate-index-sha256': { type: 'string' }, out: { type: 'string' }, 'check-only': { type: 'boolean', default: false } } });
  for (const key of ['authority', 'candidate', 'candidate-index-sha256', 'out'] as const) assert.ok(values[key], `--${key} is required`);
  console.log(JSON.stringify(await reseatTrees({ authority: values.authority! as string, candidate: values.candidate! as string, candidateIndexSha256: values['candidate-index-sha256']! as string, out: values.out! as string, checkOnly: values['check-only'] as boolean }), null, 2));
}
