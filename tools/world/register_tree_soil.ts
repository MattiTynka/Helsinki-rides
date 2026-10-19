/** Register only new source trees against final decoded ground. No ground or accepted tree changes. */
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import polygonClipping from 'polygon-clipping';
import { parseCollisionBundle, type CellDescriptor, type CollisionBundle, type TriMeshCollider } from '../../packages/world-schema/src/index.ts';
import { loadGeoJsonPolygons, type LocalPolygon, type Ring } from './lib/geometry.ts';
import { applyTreeRegistrations, assertRegistrationHash, createTreeSoilInspector, planTreeSoilSink, qualifyTreeSoil, registrationSha256 as sha,
  sampleTreeRegistrationGround, translateRegisteredTreeColliders, omitRegisteredTreeColliders, treeRegistrationPoints, type GroundRegistrationSupport, type RegistrationScenery,
  type RegistrationTree, type TreeRegistrationCorrection, type TreeSoilContext } from './lib/tree-ground-registration.ts';
import { decodeTreeBarkModels, measureTreeBarkProfile, planTreeCaseSink, qualifyContinuousTreeCase, visibleTreeObstacles,
  type TreeBarkModel, type TreeBarkProfile, type VisibleTreeObstacle } from './lib/tree-bark-registration.ts';

interface Index { originId: string; cellSize: number; cells: CellDescriptor[]; [key: string]: unknown }
interface Scenery { originId: string; assets: { id: string; sha256: string }[]; instances: RegistrationScenery[]; [key: string]: unknown }
interface Trees { originId: string; asset: string; assetSha256: string; trees: RegistrationTree[]; [key: string]: unknown }
interface TreeReport { count: number; trees: { id: string; [key: string]: unknown }[]; [key: string]: unknown }
type Support = GroundRegistrationSupport | null;
export const treeSoilPolicy = Object.freeze({ sinkMetres: .3, changeThresholdMetres: .15, flatRangeMetres: .3,
  maximumRangeMetres: .8, maximumAdjacentStepMetres: .04, maximumPlaneResidualMetres: .04, maximumSlope: 1.5, alignmentMetres: .02 });
interface PinnedFile { path: string; sha256: string }
export interface ReviewedTreeCase {
  id: string; sourcePosition: [number, number, number];
  kind: 'continuous' | 'omit-source-intersection' | 'omit-ground-barrier' | 'omit-outside-ground' | 'omit-model-water-incompatibility';
  reason: string; proof: PinnedFile & { rowSha256: string };
  limits?: { maximumRangeMetres: number; maximumAdjacentStepMetres: number; maximumPlaneResidualMetres: number; maximumSlope: number };
  waterModel?: { model: string; municipalPart: { id: string; sha256: string }; sourceWater: { id: string; sha256: string };
    regularSampleCount: number; reference: { metadata: PinnedFile; image: PinnedFile } };
}
interface ReviewedTreeCases {
  schemaVersion: 1; kind: 'reviewed-new-tree-soil-cases'; baseIndexSha256: string; sourceTreesSha256: string; assetSha256: string;
  configuration: PinnedFile; playArea: { minX: number; maxX: number; minZ: number; maxZ: number }; cases: ReviewedTreeCase[];
}

/** Per-ID reviewed bounds, not a relaxation of the ordinary policy. The full actual root/grid remains mandatory. */
export function qualifyReviewedTreeProfile(tree: RegistrationTree, profile: TreeBarkProfile, context: TreeSoilContext, obstacles: readonly VisibleTreeObstacle[], spec: ReviewedTreeCase) {
  assert.equal(spec.kind, 'continuous'); assert.equal(spec.id, tree.id); assert.deepEqual(spec.sourcePosition, tree.position); const limits = spec.limits; assert.ok(limits);
  assert.ok(limits.maximumRangeMetres > 0 && limits.maximumRangeMetres <= 2 && limits.maximumAdjacentStepMetres > 0 && limits.maximumAdjacentStepMetres <= .08 && limits.maximumPlaneResidualMetres > 0 && limits.maximumPlaneResidualMetres <= .2 && limits.maximumSlope > 0 && limits.maximumSlope <= 4, 'Unbounded reviewed tree profile');
  assert.ok(profile.range && profile.plane && profile.missing === 0 && profile.range[1] - profile.range[0] <= limits.maximumRangeMetres && profile.maximumAdjacentStep <= limits.maximumAdjacentStepMetres && profile.plane.maximumResidual <= limits.maximumPlaneResidualMetres && profile.plane.slope <= limits.maximumSlope, `${tree.id}: reviewed continuous profile failed`);
  assert.ok(!context.retainingWallIds.length && !context.buildingIds.length && !context.waterPointIndices.length && !obstacles.length, `${tree.id}: reviewed profile intersects a source or actual visible obstacle`);
  const afterY = Math.abs(profile.range[0] - .3 - tree.position[1]) > .15 ? profile.range[0] - .3 : tree.position[1];
  assert.ok(afterY <= profile.range[0] - .01 && afterY + tree.colliderHeight - profile.range[1] >= 1, `${tree.id}: model does not retain a planted root and visible clear trunk`);
  return { profileSha256: profile.sha256, limits, clearTrunkAboveHighestSoil: afterY + tree.colliderHeight - profile.range[1] };
}

export function qualifyReviewedTreeOmission(tree: RegistrationTree, spec: ReviewedTreeCase, context: TreeSoilContext, currentObstacles: readonly VisibleTreeObstacle[], targetObstacles: readonly VisibleTreeObstacle[],
  profile: TreeBarkProfile | undefined, outsideArea: number, points: readonly [number, number][], samples: readonly Support[], visual: readonly Support[], area: ReviewedTreeCases['playArea']) {
  assert.equal(spec.id, tree.id); assert.deepEqual(spec.sourcePosition, tree.position); assert.notEqual(spec.kind, 'continuous');
  assert.notEqual(spec.kind, 'omit-model-water-incompatibility', 'Water/model omissions require the separate complete-domain qualifier');
  assert.equal(points.length, samples.length); assert.equal(points.length, visual.length);
  samples.forEach((p, i) => { assert.equal(!!p, !!visual[i], 'Omission cannot hide visible/collision support disagreement'); if (p) assert.ok(Math.abs(p.height - visual[i]!.height) <= .02); });
  if (spec.kind === 'omit-outside-ground') {
    assert.ok(outsideArea > 0 && samples[0] && visual[0], 'Outer omission requires actual clipped bark domain and a supported centre');
    const missing = points.flatMap((p, i) => !samples[i] || !visual[i] ? [i] : []); assert.ok(missing.length > 0);
    for (const i of missing) { const p = points[i]!; assert.ok(p[0] < area.minX || p[0] > area.maxX || p[1] < area.minZ || p[1] > area.maxZ, 'An interior support defect cannot authorize an outer omission'); }
  } else {
    assert.ok(currentObstacles.length > 0 && targetObstacles.length > 0, 'Omission requires actual bark/face intersections at both source and intended-soil Y');
    if (spec.kind === 'omit-source-intersection') assert.ok(context.retainingWallIds.length || context.buildingIds.length, 'No actual source structure intersects this root domain');
    else assert.ok(profile && profile.missing === 0 && profile.maximumAdjacentStep > .15, 'Ground-barrier omission requires a physically discontinuous dense root footprint');
  }
  return { kind: spec.kind, actualOutsideRootArea: outsideArea, sourceContext: context, currentVisibleIntersections: currentObstacles.length, targetVisibleIntersections: targetObstacles.length, reason: spec.reason };
}

const polygonArea = (polygons: ReturnType<typeof polygonClipping.intersection>) => polygons.reduce((sum, polygon) => sum + polygon.reduce((sub, ring, i) => sub + (i ? -1 : 1) * Math.abs(ring.reduce((v, p, j) => v + p[0] * ring[(j + 1) % ring.length]![1] - ring[(j + 1) % ring.length]![0] * p[1], 0) / 2), 0), 0);

/** Explicit incompatibility of a new model placement with two source water domains, never evidence that the real tree is absent. */
export async function qualifyReviewedWaterModelOmission(tree: RegistrationTree, spec: ReviewedTreeCase, evidence: {
  root: readonly [number, number][]; context: TreeSoilContext; profile: TreeBarkProfile;
  collision: readonly Support[]; visual: readonly Support[]; denseVisual: readonly Support[];
  parts: readonly LocalPolygon[]; water: readonly LocalPolygon[]; decks: readonly LocalPolygon[];
  waterY: number | undefined; area: ReviewedTreeCases['playArea']; cells: readonly { id: string; bytes: Uint8Array }[];
}) {
  assert.equal(spec.kind, 'omit-model-water-incompatibility'); assert.equal(spec.id, tree.id); assert.deepEqual(spec.sourcePosition, tree.position);
  const binding = spec.waterModel; assert.ok(binding, 'Water/model omission needs explicit source, model and reference bindings'); assert.equal(binding.model, tree.model);
  const { root, context, profile, collision, visual, denseVisual, parts, water, decks, area } = evidence;
  assert.ok(root.length >= 3 && Number.isInteger(binding.regularSampleCount) && binding.regularSampleCount >= 12);
  assert.equal(collision.length, 9 + root.length); assert.equal(collision.length, binding.regularSampleCount); assert.equal(visual.length, collision.length);
  assert.deepEqual(profile.rootPoints, [[tree.position[0], tree.position[2]], ...root], 'Dense profile must bind the same actual model root');
  assert.equal(profile.rootSamples.length, profile.rootPoints.length); assert.equal(profile.gridSamples.length, profile.gridPoints.length);
  assert.equal(denseVisual.length, profile.gridPoints.length); assert.ok(profile.gridPoints.length > 0);
  assert.ok([...collision, ...visual, ...profile.rootSamples, ...profile.gridSamples, ...denseVisual].every(p => p === null), 'Water/model omission requires every actual regular and dense soil query to be unsupported in both representations');
  assert.equal(profile.range, null); assert.equal(profile.missing, profile.rootSamples.length + profile.gridSamples.length);
  assert.ok(!context.buildingIds.length && !context.retainingWallIds.length && context.waterPointIndices.length, 'Water/model omission cannot mask a source structure or a dry root');
  const ring: Ring = root.map(([x, z]) => [x, -z]); ring.push([...ring[0]!] as [number, number]);
  const rootArea = polygonArea([[ring]]); assert.ok(rootArea > 1e-6);
  const rectangle: Ring = [[area.minX, -area.maxZ], [area.maxX, -area.maxZ], [area.maxX, -area.minZ], [area.minX, -area.minZ], [area.minX, -area.maxZ]];
  assert.ok(polygonArea(polygonClipping.difference([ring], [rectangle])) <= 1e-8, 'Water/model omission cannot hide an outer-domain defect');
  const part = parts.find(p => p.id === binding.municipalPart.id), sourceWater = water.find(p => p.id === binding.sourceWater.id);
  assert.ok(part && sourceWater, 'Pinned municipal and candidate water polygons must exist');
  assert.equal(sha(JSON.stringify(part)), binding.municipalPart.sha256, 'Municipal water feature changed'); assert.equal(sha(JSON.stringify(sourceWater)), binding.sourceWater.sha256, 'Candidate source-water polygon changed');
  assert.equal(part.properties['paatyyppi'], 'Muut alueet'); assert.equal(part.properties['alatyyppi'], 'Merivesi-alue');
  assert.equal(sourceWater.properties['source'], 'OpenStreetMap coastline/water');
  for (const polygon of [part, sourceWater]) assert.ok(polygonArea(polygonClipping.difference([ring], polygon.rings)) <= 1e-8, 'Entire actual bark domain must lie inside each independently bound water polygon');
  assert.ok(decks.every(p => polygonArea(polygonClipping.intersection([ring], p.rings)) <= 1e-8), 'Water/model omission cannot remove a supported deck tree');
  assert.ok(Number.isFinite(evidence.waterY), 'Actual candidate water elevation is required');
  await MeshoptDecoder.ready; const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const covered: ReturnType<typeof polygonClipping.intersection>[] = [], witnesses: { cell: string; node: string; triangles: number }[] = [];
  for (const cell of evidence.cells) {
    const doc = await io.readBinary(cell.bytes), scenes = doc.getRoot().listScenes(), scene = doc.getRoot().getDefaultScene() ?? (scenes.length === 1 ? scenes[0] : undefined); assert.ok(scene, 'Water proof requires an unambiguous active scene');
    const nodes = new Set<ReturnType<typeof scene.listChildren>[number]>(); const visit = (node: ReturnType<typeof scene.listChildren>[number]) => { if (nodes.has(node)) return; nodes.add(node); node.listChildren().forEach(visit); }; scene.listChildren().forEach(visit);
    for (const node of nodes) {
      const mesh = node.getMesh(); if (!mesh || !node.getName().endsWith('_water')) continue; const M = node.getWorldMatrix(); let count = 0;
      for (const primitive of mesh.listPrimitives()) {
        const material = primitive.getMaterial(); if (material?.getName() !== 'coastal_water' || material.getAlphaMode() !== 'OPAQUE' || material.getBaseColorFactor()[3] <= .98) continue;
        const P = primitive.getAttribute('POSITION'), I = primitive.getIndices(); assert.ok(P && I && primitive.getMode() === 4);
        for (let i = 0; i < I.getCount(); i += 3) {
          const triangle = [0, 1, 2].map(j => { const v = P.getElement(I.getScalar(i + j), []); return [0, 1, 2].map(a => M[a]! * v[0]! + M[4 + a]! * v[1]! + M[8 + a]! * v[2]! + M[12 + a]!); });
          if (triangle.some(v => Math.abs(v[1]! - evidence.waterY!) > .0002)) continue;
          const projected: Ring = triangle.map(v => [v[0]!, -v[2]!]); projected.push([...projected[0]!] as [number, number]);
          const overlap = polygonClipping.intersection([ring], [projected]); if (polygonArea(overlap) <= 1e-12) continue; covered.push(overlap); count++;
        }
      }
      if (count) witnesses.push({ cell: cell.id, node: node.getName(), triangles: count });
    }
  }
  assert.ok(covered.length > 0, 'Actual visible water-plane triangles are absent');
  const uncoveredArea = polygonArea(polygonClipping.difference([ring], polygonClipping.union(covered[0]!, ...covered.slice(1))));
  assert.ok(uncoveredArea <= 1e-8, 'Actual visible water plane does not cover the complete bark domain');
  return { kind: spec.kind, model: tree.model, actualRootArea: rootArea, unsupportedRegularSamples: collision.length,
    unsupportedDenseSamples: profile.gridSamples.length, municipalPart: binding.municipalPart, sourceWater: binding.sourceWater,
    actualWaterY: evidence.waterY, actualWaterWitnesses: witnesses, uncoveredVisibleWaterArea: uncoveredArea, profileSha256: profile.sha256,
    interpretation: 'New model placement cannot bear on this candidate water domain. The reference crown occludes the real root; no claim that the real tree is absent.', reason: spec.reason };
}
/** Test the whole actual root polygon, including a narrow wall crossing between sampled vertices. */
export function inspectTreeBarkDomain(rootRuntime: readonly [number, number][], parts: readonly LocalPolygon[], footprints: readonly LocalPolygon[], water: readonly LocalPolygon[], decks: readonly LocalPolygon[], context: TreeSoilContext): TreeSoilContext {
  const root: Ring = rootRuntime.map(([x, z]) => [x, -z]); root.push([...root[0]!] as [number, number]);
  const minX = Math.min(...root.map(p => p[0])), maxX = Math.max(...root.map(p => p[0])), minY = Math.min(...root.map(p => p[1])), maxY = Math.max(...root.map(p => p[1]));
  const touching = (p: LocalPolygon) => p.bbox[0] <= maxX && p.bbox[2] >= minX && p.bbox[1] <= maxY && p.bbox[3] >= minY && polygonClipping.intersection([root], p.rings).length > 0;
  const wet = water.filter(touching).map(p => p.rings);
  const waterWithoutDeck = wet.length ? polygonClipping.difference(polygonClipping.intersection([root], polygonClipping.union(wet[0]!, ...wet.slice(1))), ...decks.filter(touching).map(p => p.rings)) : [];
  return { retainingWallIds: [...new Set([...context.retainingWallIds, ...parts.filter(p => p.properties['paatyyppi'] === 'Varusteet' && p.properties['alatyyppi'] === 'Tukimuuri' && touching(p)).map(p => p.id)])].sort(),
    buildingIds: [...new Set([...context.buildingIds, ...footprints.filter(touching).map(p => p.id)])].sort(),
    waterPointIndices: waterWithoutDeck.length ? [...new Set([...context.waterPointIndices, -1])] : context.waterPointIndices };
}

/** A continuous hillside already planted at its lowest actual bark rim does not need reseating. */
export function assessTreeSoil(tree: RegistrationTree, collision: readonly Support[], visual: readonly Support[], context: TreeSoilContext,
  profile?: TreeBarkProfile, obstacles: readonly VisibleTreeObstacle[] = []) {
  const reasons: string[] = [];
  assert.equal(collision.length, visual.length);
  collision.forEach((p, i) => { if (!p || !visual[i]) reasons.push('incomplete-visible-and-colliding-support');
    else if (Math.abs(p.height - visual[i]!.height) > treeSoilPolicy.alignmentMetres) reasons.push('visible-collision-mismatch'); });
  const combinedContext = context;
  if (context.retainingWallIds.length) reasons.push('source-retaining-wall');
  if (context.buildingIds.length) reasons.push('source-building');
  if (context.waterPointIndices.length) reasons.push('source-water');
  const heights = collision.flatMap(p => p ? [p.height] : []), range = heights.length ? [Math.min(...heights), Math.max(...heights)] as [number, number] : null;
  const nine = collision.slice(0, 9), baseline = Array<Support>(9).fill(null);
  let correction: TreeRegistrationCorrection | null = null;
  if (!reasons.length && range && range[1] - range[0] <= treeSoilPolicy.flatRangeMetres) {
    assert.ok(qualifyTreeSoil(nine, combinedContext, treeSoilPolicy.flatRangeMetres).qualified);
    correction = planTreeSoilSink(tree, baseline, nine, treeSoilPolicy.changeThresholdMetres, combinedContext);
    // The model's actual bark root may extend beyond the collider's octagonal sample directions.
    const target = range[0] - treeSoilPolicy.sinkMetres, delta = target - tree.position[1];
    correction = { ...correction, anchorHeight: range[0], finalSupportRange: range,
      applied: Math.abs(delta) > treeSoilPolicy.changeThresholdMetres, afterY: Math.abs(delta) > treeSoilPolicy.changeThresholdMetres ? target : tree.position[1],
      delta: Math.abs(delta) > treeSoilPolicy.changeThresholdMetres ? delta : 0 };
  } else if (!reasons.length && profile) {
    try { qualifyContinuousTreeCase(profile, combinedContext, obstacles, { id: tree.id, ...treeSoilPolicy }); }
    catch { reasons.push('continuous-bark-profile-not-qualified'); }
    if (!reasons.length && profile.range) correction = planTreeCaseSink(tree, baseline, nine, profile.range[0], profile.range[0] - .3, .15, 'continuous-soil-sink');
  } else if (!reasons.length) reasons.push('dense-bark-profile-required');
  const lowest = profile?.range?.[0] ?? range?.[0] ?? null;
  const rootOffset = lowest === null ? null : tree.position[1] - lowest;
  return { status: reasons.length ? 'UNRESOLVED' : correction?.applied ? 'QUALIFIED_Y_CORRECTION' : 'KEEP_ALREADY_PLANTED', reasons: [...new Set(reasons)],
    rootOffset, rootCondition: rootOffset === null ? 'unknown' : rootOffset > .01 ? 'floating-lowest-rim' : rootOffset < -.45 ? 'excess-lowest-rim-burial' : 'planted-lowest-rim', range, correction };
}

/** New placement subset only; preserve every accepted and unrelated instance in its original order. */
export function updateNewTreeScenery(source: Trees, scenery: Scenery, accepted: Scenery, corrections: readonly TreeRegistrationCorrection[], omittedIds: ReadonlySet<string> = new Set()) {
  const protectedIds = new Set(accepted.instances.map(p => p.id)), ids = new Set(source.trees.map(t => t.id));
  for (const id of ids) assert.ok(!protectedIds.has(id), `New source contains accepted ID: ${id}`);
  for (const id of omittedIds) assert.ok(ids.has(id) && !protectedIds.has(id), `Omission is not an existing new tree: ${id}`);
  const candidateById = new Map(scenery.instances.map(p => [p.id, p]));
  assert.equal(candidateById.size, scenery.instances.length, 'Duplicate candidate scenery IDs');
  for (const old of accepted.instances) { const next = candidateById.get(old.id); if (next) assert.deepEqual(next, old, `Accepted scenery changed: ${old.id}`); }
  const updated = applyTreeRegistrations(source.trees, scenery.instances.filter(p => ids.has(p.id)), corrections, protectedIds, source.asset);
  const byId = new Map(updated.scenery.map(p => [p.id, p]));
  return { trees: { ...source, trees: updated.trees.filter(t => !omittedIds.has(t.id)) }, scenery: { ...scenery, instances: scenery.instances.filter(p => !omittedIds.has(p.id)).map(p => byId.get(p.id) ?? p) } };
}

export function derivedTreeSoilReport(source: TreeReport, trees: Trees, sourceReport: PinnedFile, sourceTrees: PinnedFile) {
  const byId = new Map(trees.trees.map(t => [t.id, t]));
  const rows: (TreeReport['trees'][number] & { derivedPosition: [number, number, number] })[] = source.trees.filter(t => byId.has(t.id)).map(row => ({ ...row, derivedPosition: byId.get(row.id)!.position }));
  assert.equal(rows.length, trees.trees.length); assert.equal(new Set(rows.map(r => r.id)).size, rows.length);
  const counts = (keys: readonly string[]) => Object.fromEntries([...new Set(keys)].map(k => [k, keys.filter(v => v === k).length]));
  const differences = rows.flatMap(r => typeof r['sourceBase'] === 'number' && typeof r['ground'] === 'number' ? [r['sourceBase'] - r['ground']] : []).sort((a, b) => a - b);
  return { ...source, count: rows.length, trees: rows, byModel: counts(trees.trees.map(t => t.model)), byGenus: counts(rows.map(r => String(r['genus'] ?? 'unknown'))),
    notes: Array.isArray(source['notes']) ? (source['notes'] as { id?: string }[]).filter(n => !n.id || byId.has(n.id)) : source['notes'],
    sourceBaseMinusTerrain: differences.length ? { min: differences[0], median: differences[Math.floor(differences.length / 2)], max: differences.at(-1) } : null,
    derivation: { sourceReport, sourceTrees, method: 'Retained source rows with exact source fields, derived runtime position, retained-ID counts; original report stored separately.' } };
}

export interface RegisterTreeSoilOptions {
  cells: string; sourceTrees: string; sourceReport: string; acceptedScenery: string; origin: string; streetParts: string; footprints: string; asset: string;
  plan: string; out?: string; authority?: string; cases?: string;
}
export async function registerTreeSoil(options: RegisterTreeSoilOptions) {
  assert.ok(!existsSync(options.plan), 'Plan receipt exists; choose a fresh immutable path');
  assert.ok(!existsSync(path.join(options.cells, 'tree-soil-registration')), 'Candidate already contains a soil registration');
  if (options.out) { assert.ok(!existsSync(options.out), 'Output exists'); const from = path.resolve(options.cells), to = path.resolve(options.out);
    assert.ok(!to.startsWith(from + path.sep) && !from.startsWith(to + path.sep) && to !== from, 'Output must be separate from source cells'); }
  const inputs = new Map<string, string>();
  const read = (file: string) => { const bytes = readFileSync(file), hash = sha(bytes), previous = inputs.get(file); assert.ok(!previous || previous === hash, `Input changed while planning: ${file}`); inputs.set(file, hash); return bytes; };
  const json = <T>(file: string): T => JSON.parse(read(file).toString('utf8')) as T;
  const index = json<Index>(path.join(options.cells, 'cells.json')), scenery = json<Scenery>(path.join(options.cells, 'scenery.json'));
  const source = json<Trees>(options.sourceTrees), sourceReport = json<TreeReport>(options.sourceReport), accepted = json<Scenery>(options.acceptedScenery);
  const origin = json<{ id: string; originProjected: [number, number, number] }>(options.origin);
  const report = json<{ coastal?: { mask?: { water?: Parameters<typeof createTreeSoilInspector>[2] }; decks?: { polygons?: Parameters<typeof createTreeSoilInspector>[3] }; waterY?: number } }>(path.join(options.cells, 'report.json'));
  for (const x of [source, scenery, accepted]) assert.equal(x.originId, index.originId); assert.equal(origin.id, index.originId);
  assert.equal(sourceReport.count, source.trees.length); assert.deepEqual(sourceReport.trees.map(t => t.id).sort(), source.trees.map(t => t.id).sort());
  assertRegistrationHash(read(options.asset), source.assetSha256, 'source bark asset');
  assert.ok(scenery.assets.some(a => a.id === source.asset && a.sha256 === source.assetSha256));
  updateNewTreeScenery(source, scenery, accepted, []);
  let reviewed: ReviewedTreeCases | undefined;
  if (options.cases) {
    reviewed = json<ReviewedTreeCases>(options.cases); assert.equal(reviewed.schemaVersion, 1); assert.equal(reviewed.kind, 'reviewed-new-tree-soil-cases');
    assertRegistrationHash(read(path.join(options.cells, 'cells.json')), reviewed.baseIndexSha256, 'reviewed case base index');
    assertRegistrationHash(read(options.sourceTrees), reviewed.sourceTreesSha256, 'reviewed case source trees'); assert.equal(reviewed.assetSha256, source.assetSha256);
    const configBytes = read(reviewed.configuration.path); assertRegistrationHash(configBytes, reviewed.configuration.sha256, 'reviewed case configuration');
    assert.deepEqual(JSON.parse(configBytes.toString('utf8')).playArea, reviewed.playArea);
    assert.equal(new Set(reviewed.cases.map(c => c.id)).size, reviewed.cases.length, 'Duplicate reviewed tree case');
    for (const spec of reviewed.cases) {
      const tree = source.trees.find(t => t.id === spec.id); assert.ok(tree, 'Reviewed case is not in new source trees'); assert.deepEqual(spec.sourcePosition, tree.position);
      assert.ok(spec.reason.length >= 20, 'Reviewed case needs its concrete physical reason');
      const proofBytes = read(spec.proof.path); assertRegistrationHash(proofBytes, spec.proof.sha256, 'reviewed case proof');
      const proof = JSON.parse(proofBytes.toString('utf8')) as { rows: { id: string; sourcePosition: number[] }[] }, row = proof.rows.find(r => r.id === tree.id); assert.ok(row);
      assert.equal(sha(JSON.stringify(row)), spec.proof.rowSha256, 'Reviewed source case row changed'); assert.deepEqual(row.sourcePosition, tree.position);
      if (spec.kind === 'omit-model-water-incompatibility') {
        const binding = spec.waterModel; assert.ok(binding, 'Missing reviewed water/model bindings');
        assert.ok(accepted.instances.every(old => scenery.instances.some(next => next.id === old.id)), 'Water/model omission requires every protected accepted scenery instance');
        const metadataBytes = read(binding.reference.metadata.path), imageBytes = read(binding.reference.image.path);
        assertRegistrationHash(metadataBytes, binding.reference.metadata.sha256, 'water reference metadata'); assertRegistrationHash(imageBytes, binding.reference.image.sha256, 'water reference image');
        const reference = JSON.parse(metadataBytes.toString('utf8')) as { url: string; file: string; sha256: string; contentType: string; parameters: { SRS: string; BBOX: string } };
        const referenceUrl = new URL(reference.url); assert.ok(referenceUrl.protocol === 'https:' && referenceUrl.hostname === 'kartta.hel.fi', 'Water/model review requires the corresponding official municipal reference');
        assert.equal(reference.sha256, binding.reference.image.sha256); assert.equal(path.resolve(reference.file), path.resolve(binding.reference.image.path));
        assert.equal(reference.contentType, 'image/png'); assert.equal(reference.parameters.SRS, 'EPSG:3879');
        const box = reference.parameters.BBOX.split(',').map(Number), x = origin.originProjected[0] + tree.position[0], y = origin.originProjected[1] - tree.position[2];
        assert.ok(box.length === 4 && box.every(Number.isFinite) && x >= box[0]! && x <= box[2]! && y >= box[1]! && y <= box[3]!, 'Official reference must cover this exact source tree');
      }
    }
  }
  const reviewedById = new Map(reviewed?.cases.map(c => [c.id, c]) ?? []), omittedIds = new Set<string>();
  read(options.streetParts); read(options.footprints);
  const parts = loadGeoJsonPolygons(options.streetParts, origin.originProjected[0], origin.originProjected[1], (p, i) => String(p['osan_id'] ?? i));
  const footprints = loadGeoJsonPolygons(options.footprints, origin.originProjected[0], origin.originProjected[1], (p, i) => String(p['vtj_prt'] ?? i));
  const inspect = createTreeSoilInspector(parts, footprints, report.coastal?.mask?.water ?? [], report.coastal?.decks?.polygons ?? []);
  await MeshoptDecoder.ready; const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const models = await decodeTreeBarkModels(read(options.asset));
  const hcolCache = new Map<string, CollisionBundle>(), visualCache = new Map<string, CollisionBundle>();
  const near = (points: readonly (readonly [number, number])[]) => index.cells.filter(c => points.some(([x, z]) => x >= c.boundsXZ[0] - 1e-4 && x <= c.boundsXZ[2] + 1e-4 && z >= c.boundsXZ[1] - 1e-4 && z <= c.boundsXZ[3] + 1e-4));
  const payload = (cell: CellDescriptor, kind: 'collision' | 'visual') => { const p = kind === 'collision' ? cell.collision : cell.visual.lod0, b = read(path.join(options.cells, p.path)); assertRegistrationHash(b, p.sha256, `${cell.id}/${kind}`); return b; };
  const collision = (points: readonly [number, number][]) => sampleTreeRegistrationGround(near(points).map(c => {
    let b = hcolCache.get(c.id); if (!b) { b = parseCollisionBundle(payload(c, 'collision')); hcolCache.set(c.id, b); if (hcolCache.size > 6) hcolCache.delete(hcolCache.keys().next().value!); } return b;
  }), points);
  const rendered = async (points: readonly [number, number][]) => {
    const bundles: CollisionBundle[] = [];
    for (const cell of near(points)) {
      let bundle = visualCache.get(cell.id);
      if (!bundle) {
        const doc = await io.readBinary(payload(cell, 'visual')), colliders: TriMeshCollider[] = [];
        for (const node of doc.getRoot().listNodes()) {
          const mesh = node.getMesh(); if (!mesh || (!node.getName().includes('_ground_') && !mesh.getName().includes('_ground_'))) continue;
          const M = node.getWorldMatrix();
          for (const primitive of mesh.listPrimitives()) {
            const P = primitive.getAttribute('POSITION'), I = primitive.getIndices(); assert.ok(P && I && primitive.getMode() === 4);
            const positions = new Float32Array(P.getCount() * 3);
            for (let k = 0; k < P.getCount(); k++) { const v = P.getElement(k, []); for (let axis = 0; axis < 3; axis++) positions[k * 3 + axis] = M[axis]! * v[0]! + M[4 + axis]! * v[1]! + M[8 + axis]! * v[2]! + M[12 + axis]!; }
            colliders.push({ id: node.getName(), ref: null, group: 'ground', positions, indices: Uint32Array.from(I.getArray()!), triangleTags: new Uint16Array(I.getCount() / 3) });
          }
        }
        bundle = { header: { version: 2, originId: index.originId, frame: 'X-east,Y-up,Z-south', cell: cell.id, surfaceTags: ['rendered-ground'], colliders: [] }, colliders };
        visualCache.set(cell.id, bundle); if (visualCache.size > 3) visualCache.delete(visualCache.keys().next().value!);
      }
      bundles.push(bundle);
    }
    return sampleTreeRegistrationGround(bundles, points);
  };
  const ordered = [...source.trees].sort((a, b) => Math.floor(a.position[0] / index.cellSize) - Math.floor(b.position[0] / index.cellSize) || Math.floor(a.position[2] / index.cellSize) - Math.floor(b.position[2] / index.cellSize));
  const rows = [], corrections: TreeRegistrationCorrection[] = []; let peakRssBytes = 0;
  for (const tree of ordered) {
    const model = models.get(tree.model); assert.ok(model, `Missing actual bark model ${tree.model}`);
    const c = Math.cos(tree.yaw), s = Math.sin(tree.yaw), root: [number, number][] = model.root.map(([x, , z]) => [tree.position[0] + c * x * tree.scale[0] + s * z * tree.scale[2], tree.position[2] - s * x * tree.scale[0] + c * z * tree.scale[2]]);
    const points = [...treeRegistrationPoints(tree), ...root], samples = collision(points), visual = await rendered(points), context = inspectTreeBarkDomain(root, parts, footprints,
      report.coastal?.mask?.water ?? [], report.coastal?.decks?.polygons ?? [], inspect.points(points));
    let decision = assessTreeSoil(tree, samples, visual, context), profile: TreeBarkProfile | undefined, obstacles: VisibleTreeObstacle[] = [], currentObstacles: VisibleTreeObstacle[] = [], caseProof: unknown;
    const spec = reviewedById.get(tree.id); let denseVisual: Support[] = [], denseContext = context;
    if (decision.reasons.includes('dense-bark-profile-required') || spec) {
      profile = measureTreeBarkProfile(model, tree, collision);
      const sampledContext = inspect.points([...profile.rootPoints, ...profile.gridPoints]);
      denseContext = { retainingWallIds: [...new Set([...context.retainingWallIds, ...sampledContext.retainingWallIds])], buildingIds: [...new Set([...context.buildingIds, ...sampledContext.buildingIds])], waterPointIndices: [...context.waterPointIndices, ...sampledContext.waterPointIndices] };
      if (profile.range) {
        const target = Math.abs(profile.range[0] - .3 - tree.position[1]) > .15 ? profile.range[0] - .3 : tree.position[1];
        const radius = tree.trunkRadius + 1, [x, , z] = tree.position;
        const nearbyPayloads = index.cells.filter(cell => cell.boundsXZ[0] <= x + radius && cell.boundsXZ[2] >= x - radius && cell.boundsXZ[1] <= z + radius && cell.boundsXZ[3] >= z - radius || cell.buildings.some(building => {
          const bounds = building.boundsRuntime; return bounds.min[0] <= x + radius && bounds.max[0] >= x - radius && bounds.min[2] <= z + radius && bounds.max[2] >= z - radius;
        })).map(cell => ({ id: cell.id, bytes: payload(cell, 'visual') }));
        obstacles = await visibleTreeObstacles(tree, model, target, profile.range, nearbyPayloads);
        if (spec) currentObstacles = await visibleTreeObstacles(tree, model, tree.position[1], profile.range, nearbyPayloads);
      }
      denseVisual = await rendered(profile.gridPoints);
      decision = assessTreeSoil(tree, [...samples, ...profile.gridSamples], [...visual, ...denseVisual], denseContext, profile, obstacles);
    }
    if (spec) {
      assert.ok(profile && reviewed);
      if (spec.kind === 'continuous') {
        assert.ok(!decision.reasons.includes('visible-collision-mismatch') && !decision.reasons.includes('incomplete-visible-and-colliding-support'), 'Reviewed profile cannot hide support mismatch');
        caseProof = qualifyReviewedTreeProfile(tree, profile, denseContext, [...obstacles, ...currentObstacles], spec);
        const correction = planTreeCaseSink(tree, Array<Support>(9).fill(null), samples.slice(0, 9), profile.range![0], profile.range![0] - .3, .15, 'continuous-soil-sink');
        decision = { ...decision, status: correction.applied ? 'QUALIFIED_Y_CORRECTION' : 'KEEP_ALREADY_PLANTED', reasons: [], correction };
      } else if (spec.kind === 'omit-model-water-incompatibility') {
        caseProof = await qualifyReviewedWaterModelOmission(tree, spec, { root, context: denseContext, profile, collision: samples, visual, denseVisual,
          parts, water: report.coastal?.mask?.water ?? [], decks: report.coastal?.decks?.polygons ?? [], waterY: report.coastal?.waterY,
          area: reviewed.playArea, cells: near(root).map(cell => ({ id: cell.id, bytes: payload(cell, 'visual') })) });
        omittedIds.add(tree.id); decision = { ...decision, status: 'REVIEWED_OMISSION', reasons: [], correction: null };
      } else {
        const rootEn: Ring = root.map(([x, z]) => [x, -z]); rootEn.push([...rootEn[0]!] as [number, number]); const a = reviewed.playArea;
        const outside = polygonClipping.difference([rootEn], [[[a.minX, -a.maxZ], [a.maxX, -a.maxZ], [a.maxX, -a.minZ], [a.minX, -a.minZ], [a.minX, -a.maxZ]]]);
        const outsideArea = outside.reduce((sum, polygon) => sum + polygon.reduce((sub, ring, i) => sub + (i ? -1 : 1) * Math.abs(ring.reduce((v, p, j) => v + p[0] * ring[(j + 1) % ring.length]![1] - ring[(j + 1) % ring.length]![0] * p[1], 0) / 2), 0), 0);
        caseProof = qualifyReviewedTreeOmission(tree, spec, denseContext, currentObstacles, obstacles, profile, outsideArea, [...points, ...profile.gridPoints], [...samples, ...profile.gridSamples], [...visual, ...denseVisual], reviewed.playArea);
        omittedIds.add(tree.id); decision = { ...decision, status: 'REVIEWED_OMISSION', reasons: [], correction: null };
      }
    }
    if (decision.correction) corrections.push(decision.correction);
    rows.push({ id: tree.id, sourcePosition: tree.position, model: tree.model, points, collision: samples, visual, context, ...decision,
      ...(profile ? { profile, obstacles } : {}), ...(spec ? { reviewedCase: spec, caseProof, currentObstacles } : {}) });
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    assert.ok(peakRssBytes < 500 * 2 ** 20, `500MiB tree registration guard exceeded: ${peakRssBytes}`);
    if (rows.length % 40 === 0) { global.gc?.(); process.stdout.write(JSON.stringify({ planned: rows.length, total: ordered.length, rssMiB: peakRssBytes / 2 ** 20 }) + '\n'); }
  }
  const producerSources = [import.meta.url, new URL('./lib/tree-ground-registration.ts', import.meta.url).href, new URL('./lib/tree-bark-registration.ts', import.meta.url).href,
    new URL('./lib/geometry.ts', import.meta.url).href].map(url => { const file = fileURLToPath(url); return { path: file, sha256: sha(read(file)) }; });
  const counts = { total: rows.length, corrections: corrections.filter(c => c.applied).length, keep: rows.filter(r => r.status === 'KEEP_ALREADY_PLANTED').length,
    unresolved: rows.filter(r => r.status === 'UNRESOLVED').length, continuous: corrections.filter(c => c.policy === 'continuous-soil-sink').length, omitted: omittedIds.size,
    acceptedSceneryProtected: accepted.instances.length, acceptedSceneryPresent: accepted.instances.filter(p => scenery.instances.some(q => q.id === p.id)).length };
  const authorityData = { schemaVersion: 1, kind: 'new-tree-final-soil-registration', originId: index.originId, sourceIndexSha256: inputs.get(path.join(options.cells, 'cells.json')),
    sourceScenerySha256: inputs.get(path.join(options.cells, 'scenery.json')), policy: treeSoilPolicy, producerSources, inputs: [...inputs].map(([path, sha256]) => ({ path, sha256 })), counts, rows };
  if (options.authority) assert.deepEqual(JSON.parse(readFileSync(options.authority, 'utf8')).authority, JSON.parse(JSON.stringify(authorityData)), 'Authority or source inputs changed');
  const result = { status: options.out ? 'TREE_SOIL_APPLICATION_PREFLIGHT' : 'READ_ONLY_TREE_SOIL_PLAN', authority: authorityData, peakRssBytes,
    limitations: ['Unresolved cases are not omission authority. They block application.', 'Raw source records remain immutable; only qualified new Y changes and explicitly reviewed new-instance omissions are permitted.', 'Collision and visible soil are independently decoded. Actual dense bark proof is required for steep cases.'] };
  mkdirSync(path.dirname(options.plan), { recursive: true }); writeFileSync(options.plan, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  if (!options.out) return { ...counts, plan: options.plan, planSha256: sha(readFileSync(options.plan)), peakRssBytes };
  assert.equal(counts.unresolved, 0, 'Unresolved source/model cases block tree application');
  assert.equal(counts.acceptedSceneryPresent, counts.acceptedSceneryProtected, 'Application requires all accepted scenery to remain present');
  assert.ok(options.authority, 'Application requires a reviewed exact plan via --authority');
  const changed = updateNewTreeScenery(source, scenery, accepted, corrections, omittedIds), cells = structuredClone(index.cells).map(cell => ({ ...cell })), modifications = new Map<string, Uint8Array>(), proofs = [];
  const sourceById = new Map(source.trees.map(t => [t.id, t]));
  const found = new Map<string, number>(), foundOmissions = new Map<string, number>(); let finalTrunkColliders = 0;
  for (const cell of cells) {
    const bytes = payload(cell, 'collision'), bundle = parseCollisionBundle(bytes), refs = new Set(bundle.colliders.filter(c => c.group === 'trees').map(c => c.ref));
    const selected = corrections.filter(c => c.applied && refs.has(c.id));
    const selectedOmissions = new Set([...omittedIds].filter(id => refs.has(id)));
    for (const c of selected) found.set(c.id, (found.get(c.id) ?? 0) + 1);
    for (const id of selectedOmissions) foundOmissions.set(id, (foundOmissions.get(id) ?? 0) + 1);
    finalTrunkColliders += bundle.colliders.filter(c => c.group === 'trees' && !selectedOmissions.has(c.ref!)).length;
    if (!selected.length && !selectedOmissions.size) continue;
    const translated = translateRegisteredTreeColliders(bytes, selected.map(c => sourceById.get(c.id)!), selected);
    const filtered = omitRegisteredTreeColliders(translated.bytes, [...selectedOmissions].map(id => sourceById.get(id)!), selectedOmissions);
    modifications.set(path.normalize(cell.collision.path), filtered.bytes);
    proofs.push({ cell: cell.id, beforeSha256: cell.collision.sha256, afterSha256: sha(filtered.bytes), changedColliderIds: translated.changedColliderIds,
      removedColliderIds: filtered.removedColliderIds, onlyTreeYBytesChanged: !filtered.reencoded, retainedColliderArraysExact: filtered.retained, originalRelativeColliderOrderExact: true });
    cell.collision = { ...cell.collision, sha256: sha(filtered.bytes), bytes: filtered.bytes.length, triangles: parseCollisionBundle(filtered.bytes).colliders.reduce((sum, c) => sum + c.indices.length / 3, 0) };
  }
  for (const c of corrections.filter(c => c.applied)) assert.equal(found.get(c.id) ?? 0, sourceById.get(c.id)!.colliderHeight > 0 ? 1 : 0, `Changed tree collider count ${c.id}`);
  for (const id of omittedIds) assert.equal(foundOmissions.get(id) ?? 0, sourceById.get(id)!.colliderHeight > 0 ? 1 : 0, `Omitted tree collider count ${id}`);
  modifications.set('cells.json', Buffer.from(JSON.stringify({ ...index, cells }, null, 1) + '\n'));
  modifications.set('scenery.json', Buffer.from(JSON.stringify(changed.scenery, null, 1) + '\n'));
  const sourcePlan = { path: options.authority!, sha256: sha(readFileSync(options.authority!)) }, sourceReportPin = { path: options.sourceReport, sha256: inputs.get(options.sourceReport)! }, sourceTreesPin = { path: options.sourceTrees, sha256: inputs.get(options.sourceTrees)! };
  const derivedTreesBytes = Buffer.from(JSON.stringify(changed.trees, null, 1) + '\n');
  const proofBytes = Buffer.from(JSON.stringify({ ...result, status: 'QUALIFIED_NEW_TREE_Y_AND_REVIEWED_OMISSIONS_APPLIED', sourcePlan, collisionProofs: proofs,
    acceptedSceneryIdsExact: accepted.instances.map(p => p.id), finalIndexSha256: sha(modifications.get('cells.json')!), finalScenerySha256: sha(modifications.get('scenery.json')!), derivedTreesSha256: sha(derivedTreesBytes) }, null, 2) + '\n');
  const oldReport = JSON.parse(readFileSync(path.join(options.cells, 'report.json'), 'utf8')) as Record<string, unknown>;
  modifications.set('report.json', Buffer.from(JSON.stringify({ ...oldReport, trees: { ...(oldReport['trees'] as Record<string, unknown>), count: changed.scenery.instances.filter(p => p.asset === source.asset).length, trunkColliders: finalTrunkColliders }, newTreeSoilRegistration: { sourceTrees: sourceTreesPin, sourceReport: sourceReportPin, sourcePlan,
    derivedTrees: { path: 'tree-soil-registration/trees.json', sha256: sha(derivedTreesBytes) }, proof: { path: 'tree-soil-registration/proof.json', sha256: sha(proofBytes) }, reviewedCases: options.cases ? { path: options.cases, sha256: inputs.get(options.cases) } : null, corrections: counts.corrections, omittedNewSourceIds: [...omittedIds] } }, null, 1) + '\n'));
  const out = options.out;
  function linkDirectory(from: string, to: string, relative = '') { mkdirSync(to, { recursive: true }); for (const entry of readdirSync(from, { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), 'Input cells must not contain symbolic links'); const rel = path.join(relative, entry.name), sourcePath = path.join(from, entry.name), target = path.join(to, entry.name);
    if (entry.isDirectory()) linkDirectory(sourcePath, target, rel); else { const replacement = modifications.get(path.normalize(rel)); if (replacement) writeFileSync(target, replacement, { flag: 'wx' }); else linkSync(sourcePath, target); }
  } }
  // All qualification and changed-payload generation finishes before any output directory is created.
  linkDirectory(options.cells, out); const derived = path.join(out, 'tree-soil-registration'); assert.ok(!existsSync(derived)); mkdirSync(derived);
  writeFileSync(path.join(derived, 'trees.json'), derivedTreesBytes);
  writeFileSync(path.join(derived, 'proof.json'), proofBytes);
  writeFileSync(path.join(derived, 'source-trees-report.json'), readFileSync(options.sourceReport));
  writeFileSync(path.join(derived, 'trees-report.json'), JSON.stringify(derivedTreeSoilReport(sourceReport, changed.trees, sourceReportPin, sourceTreesPin), null, 1) + '\n');
  return { ...counts, out, plan: options.plan, indexSha256: sha(readFileSync(path.join(out, 'cells.json'))), changedCollisionCells: proofs.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: Object.fromEntries(['cells', 'source-trees', 'source-report', 'accepted-scenery', 'origin', 'street-parts', 'footprints', 'asset', 'plan', 'out', 'authority', 'cases'].map(k => [k, { type: 'string' as const }])) });
  for (const key of ['cells', 'source-trees', 'source-report', 'accepted-scenery', 'origin', 'street-parts', 'footprints', 'asset', 'plan']) assert.ok(values[key], `--${key} required`);
  const result = await registerTreeSoil({ cells: values['cells']!, sourceTrees: values['source-trees']!, sourceReport: values['source-report']!, acceptedScenery: values['accepted-scenery']!,
    origin: values['origin']!, streetParts: values['street-parts']!, footprints: values['footprints']!, asset: values['asset']!, plan: values['plan']!, out: values['out'], authority: values['authority'], cases: values['cases'] });
  process.stdout.write(JSON.stringify(result) + '\n');
}
