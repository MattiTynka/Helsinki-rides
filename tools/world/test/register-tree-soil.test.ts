import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessTreeSoil, derivedTreeSoilReport, inspectTreeBarkDomain, qualifyReviewedTreeOmission, qualifyReviewedTreeProfile, qualifyReviewedWaterModelOmission, registerTreeSoil, treeSoilPolicy, updateNewTreeScenery, type ReviewedTreeCase } from '../register_tree_soil.ts';
import { bbox, loadGeoJsonPolygons, type LocalPolygon } from '../lib/geometry.ts';
import { Document, NodeIO } from '@gltf-transform/core';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { registrationSha256 as sha } from '../lib/tree-ground-registration.ts';
import { encodeCollisionBundle, parseCollisionBundle } from '../../../packages/world-schema/src/index.ts';
import { translateRegisteredTreeColliders, type RegistrationTree, type GroundRegistrationSupport } from '../lib/tree-ground-registration.ts';
import type { TreeBarkProfile } from '../lib/tree-bark-registration.ts';
import {decodeDeliverySimulation,encodeDeliverySimulation,embedDeliveryImages} from '../lib/delivery-city-payloads.ts';

const tree = (id = 'new', y = -.3): RegistrationTree => ({ id, model: 'tree-birch', position: [2, y, 2], yaw: 0, scale: [1, 1, 1], trunkRadius: .2, colliderHeight: 3.3 });
const support = (height: number): GroundRegistrationSupport => ({ height, group: 'ground', tag: 'raised:grass', collider: 'g:cell', cell: 'cell' });
const samples = (height: number) => Array.from({ length: 9 }, () => support(height));
const clear = () => ({ retainingWallIds: [], buildingIds: [], waterPointIndices: [] });
const scenery = (t: RegistrationTree) => ({ id: t.id, asset: 'trees', node: t.model, position: [...t.position] as [number, number, number], yaw: t.yaw, scale: [...t.scale] as [number, number, number] });
const profile = (): TreeBarkProfile => ({ rootPoints: [[2, 2]], rootSamples: [support(0)], gridPoints: [[2, 2], [2.02, 2]], gridSamples: [support(0), support(.02)],
  range: [0, .5], missing: 0, maximumAdjacentStep: .02, plane: { slope: 1, maximumResidual: 0 }, sha256: 'a'.repeat(64) });
const reviewed = (t: RegistrationTree, kind: ReviewedTreeCase['kind']): ReviewedTreeCase => ({ id: t.id, sourcePosition: t.position, kind, reason: 'Explicit reviewed actual source/model geometry case.', proof: { path: 'review.json', sha256: 'a'.repeat(64), rowSha256: 'b'.repeat(64) } });

test('normal authored .3m sink stays exact rather than treating >.25 burial as a defect', () => {
  const t = tree(), q = assessTreeSoil(t, samples(0), samples(0), clear());
  assert.equal(q.status, 'KEEP_ALREADY_PLANTED'); assert.equal(q.correction?.applied, false); assert.equal(q.rootCondition, 'planted-lowest-rim');
  assert.equal(q.correction?.afterY, -.3);
});

test('flat correction uses lowest actual root support, with .15m change threshold', () => {
  const t = tree('new', 2), s = [...samples(1), support(.9)], q = assessTreeSoil(t, s, s, clear());
  assert.equal(q.status, 'QUALIFIED_Y_CORRECTION'); assert.ok(Math.abs(q.correction!.afterY - .6) < 1e-12);
  const near = assessTreeSoil(tree('near', .72), samples(1), samples(1), clear());
  assert.equal(near.status, 'KEEP_ALREADY_PLANTED'); assert.equal(near.correction!.afterY, .72);
});

test('missing outer rim, visible mismatch, actual source walls, buildings and water are unresolved', () => {
  const s = samples(0), missing = [...s.slice(0, 8), null];
  assert.equal(assessTreeSoil(tree(), missing, missing, clear()).status, 'UNRESOLVED');
  assert.equal(assessTreeSoil(tree(), s, samples(.021), clear()).status, 'UNRESOLVED');
  for (const context of [{ ...clear(), retainingWallIds: ['wall'] }, { ...clear(), buildingIds: ['building'] }, { ...clear(), waterPointIndices: [8] }])
    assert.equal(assessTreeSoil(tree(), s, s, context).status, 'UNRESOLVED');
});

test('whole actual bark domain catches a thin wall and enclosed building between all sample vertices', () => {
  const root: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const polygon = (id: string, x0: number, x1: number): LocalPolygon => { const rings: [number, number][][] = [[[x0, -.7], [x1, -.7], [x1, .7], [x0, .7], [x0, -.7]]]; return { id, rings, bbox: bbox(rings), properties: { paatyyppi: 'Varusteet', alatyyppi: 'Tukimuuri' } }; };
  const q = inspectTreeBarkDomain(root, [polygon('thin-wall', .01, .02)], [polygon('small-building', -.2, -.1)], [], [], clear());
  assert.deepEqual(q.retainingWallIds, ['thin-wall']); assert.deepEqual(q.buildingIds, ['small-building']);
  const a = polygon('water-a', -.9, -.6), b = polygon('water-b', .6, .9);
  assert.deepEqual(inspectTreeBarkDomain(root, [], [], [a, b], [], clear()).waterPointIndices, [-1]);
  assert.deepEqual(inspectTreeBarkDomain(root, [], [], [a, b], [a, b], clear()).waterPointIndices, []);
});

test('hill range alone does not force a planted continuous tree to move', () => {
  const p = profile(), s = samples(0).map((_, i) => support(.5 * i / 8)), q = assessTreeSoil(tree(), s, s, clear(), p);
  assert.equal(q.status, 'KEEP_ALREADY_PLANTED'); assert.equal(q.correction!.policy, 'continuous-soil-sink');
  assert.equal(q.correction!.delta, 0);
});

test('continuous profile rejects a discontinuity, an excessive plane residual and an actual visible barrier', () => {
  const s = samples(0).map((_, i) => support(.5 * i / 8));
  for (const p of [{ ...profile(), maximumAdjacentStep: .041 }, { ...profile(), plane: { slope: 1, maximumResidual: .041 } }, { ...profile(), missing: 1 }])
    assert.equal(assessTreeSoil(tree(), s, s, clear(), p).status, 'UNRESOLVED');
  assert.equal(assessTreeSoil(tree(), s, s, clear(), profile(), [{ cell: 'cell', node: 'real_wall', triangle: 0, vertices: [[0, 0, 0], [0, 1, 0], [1, 1, 0]], intersections: [[0, .5, 0]] }]).status, 'UNRESOLVED');
  assert.equal(treeSoilPolicy.maximumRangeMetres, .8);
});

test('reviewed nonplanar profile is per source ID and bounded without changing conservative defaults', () => {
  const t = tree(), p = { ...profile(), maximumAdjacentStep: .059, plane: { slope: .83, maximumResidual: .1669 } }, s = samples(0).map((_, i) => support(.5 * i / 8));
  assert.equal(assessTreeSoil(t, s, s, clear(), p).status, 'UNRESOLVED');
  const spec = { ...reviewed(t, 'continuous'), limits: { maximumRangeMetres: .5, maximumAdjacentStepMetres: .06, maximumPlaneResidualMetres: .17, maximumSlope: .85 } };
  assert.equal(qualifyReviewedTreeProfile(t, p, clear(), [], spec).limits.maximumPlaneResidualMetres, .17);
  assert.equal(treeSoilPolicy.maximumPlaneResidualMetres, .04);
  assert.throws(() => qualifyReviewedTreeProfile(tree('different'), p, clear(), [], spec));
  assert.throws(() => qualifyReviewedTreeProfile(t, { ...p, maximumAdjacentStep: .061 }, clear(), [], spec), /profile failed/);
  assert.throws(() => qualifyReviewedTreeProfile(t, p, { ...clear(), buildingIds: ['real'] }, [], spec), /source or actual visible obstacle/);
  assert.throws(() => qualifyReviewedTreeProfile(t, p, clear(), [], { ...spec, limits: { ...spec.limits, maximumPlaneResidualMetres: 2 } }), /Unbounded/);
});

test('reviewed omission requires exact new position and physical obstruction or only outside-domain missing support', () => {
  const t = tree(), obstacle = { cell: 'cell', node: 'actual_wall', triangle: 4, vertices: [[0, 0, 0], [0, 1, 0], [1, 1, 0]] as [[number, number, number], [number, number, number], [number, number, number]], intersections: [[0, .5, 0]] as [number, number, number][] };
  const area = { minX: 0, maxX: 10, minZ: 0, maxZ: 10 }, spec = reviewed(t, 'omit-source-intersection'), p: [number, number][] = [[2, 2]];
  assert.throws(() => qualifyReviewedTreeOmission(t, spec, { ...clear(), retainingWallIds: ['wall'] }, [obstacle], [], profile(), 0, p, [support(0)], [support(0)], area), /both source and intended-soil Y/);
  qualifyReviewedTreeOmission(t, spec, { ...clear(), retainingWallIds: ['wall'] }, [obstacle], [obstacle], profile(), 0, p, [support(0)], [support(0)], area);
  const outer = reviewed(t, 'omit-outside-ground');
  assert.throws(() => qualifyReviewedTreeOmission(t, outer, clear(), [], [], profile(), .01, [[2, 2], [3, 2]], [support(0), null], [support(0), null], area), /interior support defect/);
  qualifyReviewedTreeOmission(t, outer, clear(), [], [], profile(), .01, [[2, 2], [-.01, 2]], [support(0), null], [support(0), null], area);
  assert.throws(() => qualifyReviewedTreeOmission(t, outer, clear(), [], [], profile(), .01, [[2, 2], [-.01, 2]], [support(0), null], [support(0), support(0)], area), /support disagreement/);
});

test('water/model omission independently requires both full source domains and actual active visible water, never just missing soil', async () => {
  const t = tree(), root: [number, number][] = [[1.8, 1.8], [2.2, 1.8], [2.2, 2.2], [1.8, 2.2]];
  const rings: [number, number][][] = [[[0, -4], [4, -4], [4, 0], [0, 0], [0, -4]]];
  const part: LocalPolygon = { id: 'municipal-water', rings, bbox: bbox(rings), properties: { paatyyppi: 'Muut alueet', alatyyppi: 'Merivesi-alue' } };
  const water: LocalPolygon = { ...part, id: 'source-water', properties: { source: 'OpenStreetMap coastline/water' } };
  const spec = { ...reviewed(t, 'omit-model-water-incompatibility'), waterModel: { model: t.model,
    municipalPart: { id: part.id, sha256: sha(JSON.stringify(part)) }, sourceWater: { id: water.id, sha256: sha(JSON.stringify(water)) }, regularSampleCount: 13,
    reference: { metadata: { path: 'official.json', sha256: 'c'.repeat(64) }, image: { path: 'official.png', sha256: 'd'.repeat(64) } } } };
  const visible = async (gap = false, active = true, height = 0, opaque = true) => {
    const doc = new Document(), buffer = doc.createBuffer(), scene = doc.createScene();
    const mesh = doc.createMesh();
    // A 5mm gap falls between all supplied grid points; only whole-domain triangle coverage catches it.
    for (const [lo, hi] of gap ? [[0, 2.005], [2.01, 4]] : [[0, 4]]) {
      const primitive = doc.createPrimitive().setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(Float32Array.from([lo!, height, 0, hi!, height, 0, hi!, height, 4, lo!, height, 4])).setBuffer(buffer))
        .setIndices(doc.createAccessor().setType('SCALAR').setArray(Uint32Array.from([0, 2, 1, 0, 3, 2])).setBuffer(buffer))
        .setMaterial(doc.createMaterial('coastal_water').setAlphaMode(opaque ? 'OPAQUE' : 'BLEND'));
      mesh.addPrimitive(primitive);
    }
    const node = doc.createNode('cell_water').setMesh(mesh); if (active) scene.addChild(node);
    return [{ id: 'cell', bytes: await new NodeIO().writeBinary(doc) }];
  };
  const p: TreeBarkProfile = { ...profile(), rootPoints: [[2, 2], ...root], rootSamples: Array(5).fill(null), gridPoints: [[2, 2], [2.02, 2]], gridSamples: [null, null], missing: 7, range: null, plane: null };
  const evidence = { root, context: { ...clear(), waterPointIndices: [-1] }, profile: p, collision: Array(13).fill(null), visual: Array(13).fill(null), denseVisual: [null, null],
    parts: [part], water: [water], decks: [], waterY: 0, area: { minX: 0, maxX: 4, minZ: 0, maxZ: 4 }, cells: await visible() };
  const q = await qualifyReviewedWaterModelOmission(t, spec, evidence); assert.ok(Math.abs(q.actualRootArea - .16) < 1e-9); assert.equal(q.unsupportedRegularSamples, 13);
  for (const cells of [await visible(true), await visible(false, false), await visible(false, true, .01), await visible(false, true, 0, false)])
    await assert.rejects(qualifyReviewedWaterModelOmission(t, spec, { ...evidence, cells }), /water-plane triangles are absent|does not cover/);
  await assert.rejects(qualifyReviewedWaterModelOmission(t, spec, { ...evidence, collision: [support(0), ...evidence.collision.slice(1)] }), /every actual regular and dense soil query/);
  await assert.rejects(qualifyReviewedWaterModelOmission(t, spec, { ...evidence, denseVisual: [support(0), null] }), /every actual regular and dense soil query/);
  await assert.rejects(qualifyReviewedWaterModelOmission(t, spec, { ...evidence, decks: [part] }), /supported deck tree/);
  await assert.rejects(qualifyReviewedWaterModelOmission(t, spec, { ...evidence, parts: [{ ...part, properties: { ...part.properties, alatyyppi: 'dry land' } }] }), /Municipal water feature changed/);
  const partial = { ...part, rings: [[[0, -4], [2.1, -4], [2.1, 0], [0, 0], [0, -4]]] as [number, number][][] };
  await assert.rejects(qualifyReviewedWaterModelOmission(t, { ...spec, waterModel: { ...spec.waterModel, municipalPart: { id: partial.id, sha256: sha(JSON.stringify(partial)) } } }, { ...evidence, parts: [partial] }), /Entire actual bark domain/);
  const partialWater = { ...water, rings: partial.rings };
  await assert.rejects(qualifyReviewedWaterModelOmission(t, { ...spec, waterModel: { ...spec.waterModel, sourceWater: { id: water.id, sha256: sha(JSON.stringify(partialWater)) } } }, { ...evidence, water: [partialWater] }), /Entire actual bark domain/);
  await assert.rejects(qualifyReviewedWaterModelOmission(t, spec, { ...evidence, profile: { ...p, rootPoints: [[2, 2], ...root.slice(1)] } }), /same actual model root/);
  await assert.rejects(qualifyReviewedWaterModelOmission(tree('other'), spec, evidence));
  assert.throws(() => qualifyReviewedTreeOmission(t, spec, clear(), [], [], p, 0, [[2, 2]], [null], [null], evidence.area), /separate complete-domain qualifier/);
  assert.equal(treeSoilPolicy.maximumAdjacentStepMetres, .04); assert.equal(treeSoilPolicy.maximumRangeMetres, .8);
});

test('derived source report count, IDs and positions follow omissions while raw source fields stay unchanged', () => {
  const raw = { count: 2, trees: [{ id: 'keep', genus: 'Betula', sourceBase: 2, ground: 1 }, { id: 'omit', genus: 'Pinus', sourceBase: 3, ground: 1 }], notes: [{ id: 'omit', note: 'raw' }] };
  const original = JSON.stringify(raw), kept = tree('keep', .7), result = derivedTreeSoilReport(raw, { originId: 'origin', asset: 'trees', assetSha256: 'a'.repeat(64), trees: [kept] }, { path: 'raw.json', sha256: 'b'.repeat(64) }, { path: 'trees.json', sha256: 'c'.repeat(64) });
  assert.equal(result.count, 1); assert.deepEqual(result.trees.map(t => t.id), ['keep']); assert.deepEqual(result.trees[0]!.derivedPosition, kept.position); assert.equal(result.trees[0]!['sourceBase'], 2);
  assert.deepEqual(result.byGenus, { Betula: 1 }); assert.deepEqual(result.byModel, { 'tree-birch': 1 }); assert.deepEqual(result.notes, []); assert.equal(JSON.stringify(raw), original);
});

test('accepted instances retain exact order/value and cannot occur in the new source subset', () => {
  const old = scenery(tree('old')), t = tree('new', 2), next = scenery(t), extra = { ...scenery(tree('other')), asset: 'monument' };
  const accepted = { originId: 'origin', assets: [], instances: [old] }, candidate = { ...accepted, instances: [old, extra, next] };
  const source = { originId: 'origin', asset: 'trees', assetSha256: 'a'.repeat(64), trees: [t] };
  const correction = assessTreeSoil(t, samples(1), samples(1), clear()).correction!;
  const result = updateNewTreeScenery(source, candidate, accepted, [correction]);
  assert.equal(result.scenery.instances[0], old); assert.equal(result.scenery.instances[1], extra); assert.equal(result.scenery.instances[2]!.position[1], .7);
  assert.deepEqual({ ...result.trees.trees[0], position: t.position }, t);
  assert.throws(() => updateNewTreeScenery({ ...source, trees: [tree('old')] }, candidate, accepted, []), /accepted ID/);
  assert.throws(() => updateNewTreeScenery(source, { ...candidate, instances: [{ ...old, yaw: 1 }, extra, next] }, accepted, []), /Accepted scenery changed/);
});

test('planned correction changes only the new HCOL tree Y words, preserving ground and accepted collider bytes', () => {
  const t = tree('new', 2), old = tree('old'), collider = (x: RegistrationTree) => ({ id: `t:${x.id}`, ref: x.id, group: 'trees' as const,
    positions: Float32Array.from([2, x.position[1], 2, 2.2, x.position[1] + x.colliderHeight, 2, 1.8, x.position[1] + x.colliderHeight, 2]), indices: Uint32Array.from([0, 1, 2]), triangleTags: Uint16Array.from([0]) });
  const ground = { id: 'g:cell', ref: null, group: 'ground' as const, positions: Float32Array.from([0, 1, 0, 10, 1, 0, 10, 1, 10]), indices: Uint32Array.from([0, 2, 1]), triangleTags: Uint16Array.from([0]) };
  const bytes = encodeCollisionBundle({ originId: 'origin', frame: 'X-east,Y-up,Z-south', cell: 'cell', surfaceTags: ['ground'] }, [ground, collider(old), collider(t)]);
  const copy = bytes.slice(), correction = assessTreeSoil(t, samples(1), samples(1), clear()).correction!;
  const changed = translateRegisteredTreeColliders(bytes, [t], [correction]), before = parseCollisionBundle(bytes), after = parseCollisionBundle(changed.bytes);
  assert.deepEqual(bytes, copy); assert.deepEqual(before.header, after.header);
  assert.deepEqual(before.colliders[0], after.colliders[0]); assert.deepEqual(before.colliders[1], after.colliders[1]);
  assert.deepEqual(changed.changedColliderIds, ['t:new']); assert.deepEqual(before.colliders[2]!.indices, after.colliders[2]!.indices);
});

test('fresh-output CLI API binds reviewed inputs, hardlinks untouched payloads and changes only new placement/trunk Y', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'helsinki-tree-soil-'));
  try {
    const base = path.join(dir, 'cells'); mkdirSync(base);
    const write = (name: string, value: unknown) => { const file = path.join(dir, name); writeFileSync(file, JSON.stringify(value)); return file; };
    const io = new NodeIO(), assetDoc = new Document(), buffer = assetDoc.createBuffer(), bark = assetDoc.createMaterial('tree_bark');
    const positions: number[] = [], indices: number[] = [];
    for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; positions.push(.2 * Math.cos(a), 0, .2 * Math.sin(a), .2 * Math.cos(a), 4, .2 * Math.sin(a)); }
    for (let k = 0; k < 8; k++) indices.push(k * 2, ((k + 1) % 8) * 2, k * 2 + 1, k * 2 + 1, ((k + 1) % 8) * 2, ((k + 1) % 8) * 2 + 1);
    const primitive = assetDoc.createPrimitive().setAttribute('POSITION', assetDoc.createAccessor().setType('VEC3').setArray(Float32Array.from(positions)).setBuffer(buffer))
      .setIndices(assetDoc.createAccessor().setType('SCALAR').setArray(Uint32Array.from(indices)).setBuffer(buffer)).setMaterial(bark);
    const model = assetDoc.createNode('tree-birch').setMesh(assetDoc.createMesh().addPrimitive(primitive)); assetDoc.createScene().addChild(model);
    const assetBytes = await io.writeBinary(assetDoc), asset = path.join(dir, 'trees.glb'); writeFileSync(asset, assetBytes);
    const groundDoc = new Document(), groundBuffer = groundDoc.createBuffer();
    const groundPositions = Float32Array.from([0, 1, 0, 10, 1, 0, 10, 1, 10, 0, 1, 10]), groundIndices = Uint32Array.from([0, 2, 1, 0, 3, 2]);
    const gp = groundDoc.createPrimitive().setAttribute('POSITION', groundDoc.createAccessor().setType('VEC3').setArray(groundPositions).setBuffer(groundBuffer))
      .setIndices(groundDoc.createAccessor().setType('SCALAR').setArray(groundIndices).setBuffer(groundBuffer));
    groundDoc.createScene().addChild(groundDoc.createNode('cell_ground_grass').setMesh(groundDoc.createMesh().addPrimitive(gp)));
    const visual = await io.writeBinary(groundDoc); writeFileSync(path.join(base, 'cell.glb'), visual);
    const t = tree('new', 2), old = { ...tree('old'), position: [8, -.3, 8] as [number, number, number] };
    const makeTrunk = (t: RegistrationTree) => ({ id: `t:${t.id}`, ref: t.id, group: 'trees' as const, positions: Float32Array.from([t.position[0], t.position[1], t.position[2], t.position[0] + .2, t.position[1] + 3.3, t.position[2], t.position[0] - .2, t.position[1] + 3.3, t.position[2]]), indices: Uint32Array.from([0, 1, 2]), triangleTags: Uint16Array.from([0]) });
    const collision = encodeCollisionBundle({ originId: 'origin', frame: 'X-east,Y-up,Z-south', cell: 'cell', surfaceTags: ['ground'] },
      [{ id: 'g:cell', ref: null, group: 'ground', positions: groundPositions, indices: groundIndices, triangleTags: new Uint16Array(2) }, makeTrunk(old), makeTrunk(t)]);
    writeFileSync(path.join(base, 'cell.bin'), collision); writeFileSync(path.join(base, 'sentinel.bin'), new Uint8Array([1, 7, 9]));
    const index = { originId: 'origin', cellSize: 128, cells: [{ id: 'cell', boundsXZ: [0, 0, 128, 128], visual: { lod0: { path: 'cell.glb', sha256: sha(visual) } }, collision: { path: 'cell.bin', sha256: sha(collision), bytes: collision.length }, buildings: [] }] };
    writeFileSync(path.join(base, 'cells.json'), JSON.stringify(index)); writeFileSync(path.join(base, 'report.json'), '{}');
    const source = { originId: 'origin', asset: 'trees', assetSha256: sha(assetBytes), trees: [t] }, scene = { originId: 'origin', assets: [{ id: 'trees', sha256: sha(assetBytes) }], instances: [scenery(old), scenery(t)] };
    writeFileSync(path.join(base, 'scenery.json'), JSON.stringify(scene));
    const options = { cells: base, sourceTrees: write('source.json', source), sourceReport: write('source-report.json', { count: 1, trees: [{ id: t.id }] }),
      acceptedScenery: write('accepted.json', { ...scene, instances: [scene.instances[0]] }), origin: write('origin.json', { id: 'origin', originProjected: [0, 0, 0] }),
      streetParts: write('parts.json', { type: 'FeatureCollection', features: [] }), footprints: write('footprints.json', { type: 'FeatureCollection', features: [] }), asset, plan: path.join(dir, 'plan.json') };
    const beforeIndex = readFileSync(path.join(base, 'cells.json')), beforeScenery = readFileSync(path.join(base, 'scenery.json'));
    const encoded = encodeDeliverySimulation(collision); writeFileSync(path.join(base, 'encoded.gz'), encoded.bytes);
    writeFileSync(path.join(base, 'cells.json'), JSON.stringify({ ...index, cells: [{ ...index.cells[0], collision: { ...index.cells[0]!.collision,
      path: 'encoded.gz', bytes: encoded.bytes.length, sha256: sha(encoded.bytes), compression: encoded.compression, decodedBytes: encoded.decodedBytes, decodedSha256: encoded.decodedSha256 } }] }));
    let inspectedStoredPayload = false;
    const deliveryReader = { sourceFiles: [], collision: (cell: any, stored: Uint8Array) => { assert.deepEqual(stored, encoded.bytes); inspectedStoredPayload = true; return decodeDeliverySimulation(stored, cell.collision); }, visual: (_cell: any, stored: Uint8Array) => embedDeliveryImages(stored, new Map()) };
    const deliveryPlan = path.join(dir, 'delivery-plan.json'), delivery = await registerTreeSoil({ ...options, plan: deliveryPlan, payloadReader: deliveryReader });
    assert.equal(delivery.unresolved, 0); assert.equal(delivery.corrections, 1); assert.equal(inspectedStoredPayload, true);
    assert.ok(JSON.parse(readFileSync(deliveryPlan, 'utf8')).authority.inputs.some((p: any) => p.path.endsWith('encoded.gz') && p.sha256 === sha(encoded.bytes)));
    await assert.rejects(registerTreeSoil({ ...options, plan: path.join(dir, 'invalid-delivery-apply.json'), out: path.join(dir, 'invalid-delivery-out'), payloadReader: deliveryReader }), /planning only/);
    writeFileSync(path.join(base, 'cells.json'), beforeIndex);
    const planned = await registerTreeSoil(options); assert.equal(planned.corrections, 1); assert.equal(planned.unresolved, 0);
    const out = path.join(dir, 'out'); await registerTreeSoil({ ...options, authority: options.plan, plan: path.join(dir, 'apply-plan.json'), out });
    assert.deepEqual(readFileSync(path.join(base, 'cells.json')), beforeIndex); assert.deepEqual(readFileSync(path.join(base, 'scenery.json')), beforeScenery);
    assert.deepEqual(readFileSync(path.join(base, 'cell.bin')), Buffer.from(collision)); assert.deepEqual(readFileSync(path.join(out, 'cell.glb')), Buffer.from(visual));
    assert.deepEqual(readFileSync(path.join(out, 'sentinel.bin')), Buffer.from([1, 7, 9]));
    const result = JSON.parse(readFileSync(path.join(out, 'scenery.json'), 'utf8')); assert.deepEqual(result.instances[0], scene.instances[0]); assert.equal(result.instances[1].position[1], .7);
    assert.deepEqual(parseCollisionBundle(readFileSync(path.join(out, 'cell.bin'))).colliders[1], parseCollisionBundle(collision).colliders[1]);
    const outReport = JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8'));
    assert.equal(outReport.newTreeSoilRegistration.proof.sha256, sha(readFileSync(path.join(out, 'tree-soil-registration/proof.json'))));
    assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'tree-soil-registration/trees-report.json'), 'utf8')).trees[0].derivedPosition, [2, .7, 2]);
    const clippedTree = { ...t, position: [.05, 2, 2] as [number, number, number] }, clippedSource = { ...source, trees: [clippedTree] }, clippedScene = { ...scene, instances: [scenery(old), scenery(clippedTree)] };
    const clippedCollision = encodeCollisionBundle({ originId: 'origin', frame: 'X-east,Y-up,Z-south', cell: 'cell', surfaceTags: ['ground'] },
      [{ id: 'g:cell', ref: null, group: 'ground', positions: groundPositions, indices: groundIndices, triangleTags: new Uint16Array(2) }, makeTrunk(old), makeTrunk(clippedTree)]);
    writeFileSync(path.join(base, 'cell.bin'), clippedCollision); index.cells[0]!.collision = { ...index.cells[0]!.collision, sha256: sha(clippedCollision), bytes: clippedCollision.length };
    writeFileSync(path.join(base, 'cells.json'), JSON.stringify(index)); writeFileSync(path.join(base, 'scenery.json'), JSON.stringify(clippedScene)); writeFileSync(options.sourceTrees, JSON.stringify(clippedSource));
    const caseRow = { id: t.id, sourcePosition: clippedTree.position }, caseProof = write('case-proof.json', { rows: [caseRow] }), config = write('config.json', { playArea: { minX: 0, maxX: 10, minZ: 0, maxZ: 10 } });
    const cases = write('cases.json', { schemaVersion: 1, kind: 'reviewed-new-tree-soil-cases', baseIndexSha256: sha(readFileSync(path.join(base, 'cells.json'))), sourceTreesSha256: sha(readFileSync(options.sourceTrees)), assetSha256: source.assetSha256,
      configuration: { path: config, sha256: sha(readFileSync(config)) }, playArea: { minX: 0, maxX: 10, minZ: 0, maxZ: 10 }, cases: [{ ...reviewed(clippedTree, 'omit-outside-ground'), proof: { path: caseProof, sha256: sha(readFileSync(caseProof)), rowSha256: sha(JSON.stringify(caseRow)) } }] });
    const omittedPlan = path.join(dir, 'omitted-plan.json'), omitOut = path.join(dir, 'omitted-out');
    const omitPreview = await registerTreeSoil({ ...options, cases, plan: omittedPlan }); assert.equal(omitPreview.omitted, 1); assert.equal(omitPreview.unresolved, 0);
    await registerTreeSoil({ ...options, cases, authority: omittedPlan, plan: path.join(dir, 'omit-apply-plan.json'), out: omitOut });
    const keptCollision = parseCollisionBundle(readFileSync(path.join(omitOut, 'cell.bin'))), beforeOmission = parseCollisionBundle(clippedCollision);
    assert.equal(keptCollision.colliders.length, 2); assert.deepEqual(keptCollision.colliders[0], beforeOmission.colliders[0]); assert.deepEqual(keptCollision.colliders[1], beforeOmission.colliders[1]);
    assert.deepEqual(JSON.parse(readFileSync(path.join(omitOut, 'scenery.json'), 'utf8')).instances, [scenery(old)]);
    assert.equal(JSON.parse(readFileSync(path.join(omitOut, 'tree-soil-registration/trees-report.json'), 'utf8')).count, 0);
    assert.deepEqual(readFileSync(path.join(omitOut, 'tree-soil-registration/source-trees-report.json')), readFileSync(options.sourceReport));
    assert.deepEqual(readFileSync(path.join(base, 'cell.bin')), Buffer.from(clippedCollision));
    // A separate candidate really has no soil under the new tree and does have decoded visible water.
    const wetDoc = new Document(), wetBuffer = wetDoc.createBuffer(), wetPrimitive = wetDoc.createPrimitive()
      .setAttribute('POSITION', wetDoc.createAccessor().setType('VEC3').setArray(Float32Array.from([0, 0, 0, 10, 0, 0, 10, 0, 10, 0, 0, 10])).setBuffer(wetBuffer))
      .setIndices(wetDoc.createAccessor().setType('SCALAR').setArray(groundIndices).setBuffer(wetBuffer)).setMaterial(wetDoc.createMaterial('coastal_water'));
    wetDoc.createScene().addChild(wetDoc.createNode('cell_water').setMesh(wetDoc.createMesh().addPrimitive(wetPrimitive)));
    const wetVisual = await io.writeBinary(wetDoc), wetCollision = encodeCollisionBundle({ originId: 'origin', frame: 'X-east,Y-up,Z-south', cell: 'cell', surfaceTags: ['ground'] }, [makeTrunk(old), makeTrunk(t)]);
    writeFileSync(path.join(base, 'cell.glb'), wetVisual); writeFileSync(path.join(base, 'cell.bin'), wetCollision);
    index.cells[0]!.visual.lod0.sha256 = sha(wetVisual); index.cells[0]!.collision = { ...index.cells[0]!.collision, sha256: sha(wetCollision), bytes: wetCollision.length };
    writeFileSync(path.join(base, 'cells.json'), JSON.stringify(index)); writeFileSync(path.join(base, 'scenery.json'), JSON.stringify(scene)); writeFileSync(options.sourceTrees, JSON.stringify(source));
    const wetRings: [number, number][][] = [[[0, -10], [10, -10], [10, 0], [0, 0], [0, -10]]];
    const municipal: LocalPolygon = { id: 'wet-part', rings: wetRings, bbox: bbox(wetRings), properties: { osan_id: 'wet-part', paatyyppi: 'Muut alueet', alatyyppi: 'Merivesi-alue' } };
    const sourceWater: LocalPolygon = { ...municipal, id: 'water-0', properties: { source: 'OpenStreetMap coastline/water' } };
    writeFileSync(path.join(base, 'report.json'), JSON.stringify({ coastal: { waterY: 0, mask: { water: [sourceWater] }, decks: { polygons: [] } } }));
    writeFileSync(options.streetParts, JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: municipal.properties,
      geometry: { type: 'Polygon', coordinates: wetRings } }] }));
    const image = path.join(dir, 'reference.png'); writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=', 'base64'));
    const metadata = write('reference.json', { url: 'https://kartta.hel.fi/ws/geoserver/avoindata/wms', file: image, sha256: sha(readFileSync(image)), contentType: 'image/png', parameters: { SRS: 'EPSG:3879', BBOX: '0,-10,10,0' } });
    const wetRow = { id: t.id, sourcePosition: t.position }, wetProof = write('wet-proof.json', { rows: [wetRow] });
    const wetSpec: ReviewedTreeCase = { ...reviewed(t, 'omit-model-water-incompatibility'), proof: { path: wetProof, sha256: sha(readFileSync(wetProof)), rowSha256: sha(JSON.stringify(wetRow)) },
      waterModel: { model: t.model, municipalPart: { id: municipal.id, sha256: sha(JSON.stringify(loadGeoJsonPolygons(options.streetParts, 0, 0, p => String(p['osan_id']))[0])) }, sourceWater: { id: sourceWater.id, sha256: sha(JSON.stringify(sourceWater)) }, regularSampleCount: 17,
        reference: { metadata: { path: metadata, sha256: sha(readFileSync(metadata)) }, image: { path: image, sha256: sha(readFileSync(image)) } } } };
    const wetCases = write('wet-cases.json', { schemaVersion: 1, kind: 'reviewed-new-tree-soil-cases', baseIndexSha256: sha(readFileSync(path.join(base, 'cells.json'))), sourceTreesSha256: sha(readFileSync(options.sourceTrees)), assetSha256: source.assetSha256,
      configuration: { path: config, sha256: sha(readFileSync(config)) }, playArea: { minX: 0, maxX: 10, minZ: 0, maxZ: 10 }, cases: [wetSpec] });
    const wetPlan = path.join(dir, 'wet-plan.json'), wetOut = path.join(dir, 'wet-out');
    assert.equal((await registerTreeSoil({ ...options, cases: wetCases, plan: wetPlan })).omitted, 1);
    await registerTreeSoil({ ...options, cases: wetCases, authority: wetPlan, plan: path.join(dir, 'wet-apply.json'), out: wetOut });
    assert.deepEqual(JSON.parse(readFileSync(path.join(wetOut, 'scenery.json'), 'utf8')).instances, [scenery(old)]);
    assert.deepEqual(parseCollisionBundle(readFileSync(path.join(wetOut, 'cell.bin'))).colliders, [parseCollisionBundle(wetCollision).colliders[0]]);
    assert.deepEqual(readFileSync(path.join(wetOut, 'cell.glb')), Buffer.from(wetVisual)); assert.deepEqual(readFileSync(options.sourceTrees), Buffer.from(JSON.stringify(source)));
    writeFileSync(image, Buffer.from('changed reference')); const badWaterOut = path.join(dir, 'bad-water-out');
    await assert.rejects(registerTreeSoil({ ...options, cases: wetCases, plan: path.join(dir, 'bad-water-plan.json'), out: badWaterOut }), /water reference image/); assert.equal(existsSync(badWaterOut), false);
    writeFileSync(options.sourceTrees, JSON.stringify({ ...source, trees: [{ ...t, yaw: .1 }] }));
    const blocked = path.join(dir, 'blocked'); await assert.rejects(registerTreeSoil({ ...options, authority: options.plan, plan: path.join(dir, 'blocked-plan.json'), out: blocked }));
    assert.equal(existsSync(blocked), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
