import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { encodeCollisionBundle, geodeticToGk25, parseCollisionBundle, type TriMeshCollider } from '../../../packages/world-schema/src/index.ts';
import { Document, NodeIO } from '@gltf-transform/core';
import { reseatTrees, sampleRenderedTreeGround } from '../reseat_trees.ts';
import { applyTreeRegistrations, assertRegistrationHash, conditionalTreeOmission, omitRegisteredTreeColliders, planTreeRegistration, planTreeSoilSink, qualifyTreeSoil, registrationSha256 as sha, sampleTreeRegistrationGround, translateRegisteredTreeColliders, treeRegistrationPoints,
  type RegistrationScenery, type RegistrationTree, type GroundRegistrationSupport } from '../lib/tree-ground-registration.ts';

const tree = (id = 'new', x = 2): RegistrationTree => ({ id, model: 'tree-birch', position: [x, -.3, 2], scale: [1, 2, 1], yaw: .5, height: 20, crownRadius: 3, trunkRadius: .2, colliderHeight: 3.3 });
const scene = (t: RegistrationTree): RegistrationScenery => ({ id: t.id, asset: 'scenery-trees', node: t.model, position: [...t.position], scale: [...t.scale], yaw: t.yaw });
const support = (height: number): GroundRegistrationSupport => ({ height, group: 'ground', tag: 'raised:grass', collider: 'g:cell', cell: 'cell' });
function flatGround(y: number, x0 = 0, x1 = 10, id = 'g:cell'): TriMeshCollider {
  return { id, ref: null, group: 'ground', positions: Float32Array.from([x0, y, 0, x1, y, 0, x1, y, 10, x0, y, 10]), indices: Uint32Array.from([0, 2, 1, 0, 3, 2]), triangleTags: Uint16Array.from([0, 0]) };
}
function trunk(t: RegistrationTree): TriMeshCollider {
  const [x, y, z] = t.position;
  return { id: `t:${t.id}`, ref: t.id, group: 'trees', positions: Float32Array.from([x, y, z, x + .2, y + t.colliderHeight, z, x - .2, y + t.colliderHeight, z]), indices: Uint32Array.from([0, 1, 2]), triangleTags: Uint16Array.from([1]) };
}
const encode = (colliders: TriMeshCollider[], cell = 'cell') => encodeCollisionBundle({ originId: 'origin', frame: 'X-east,Y-up,Z-south', cell, surfaceTags: ['raised:grass', 'trunk'] }, colliders);

test('ground evidence excludes tree caps and roofs and requires all nine trunk-footprint points', () => {
  const t = tree(), ground = flatGround(.8), roof = { ...flatGround(20), id: 'roof', group: 'buildings' as const }, cap = { ...flatGround(30), id: 'cap', group: 'trees' as const };
  const samples = sampleTreeRegistrationGround([parseCollisionBundle(encode([ground, roof, cap]))], treeRegistrationPoints(t));
  assert.equal(samples.length, 9); assert.ok(samples.every(p => p && Math.abs(p.height - Math.fround(.8)) < 1e-9));
  const plan = planTreeRegistration(t, samples.map(() => support(0)), samples, .15);
  assert.ok(Math.abs(plan.afterY - .5) < 1e-7); assert.equal(plan.baselineOffset, -.3);
  assert.throws(() => planTreeRegistration(t, samples, [...samples.slice(0, 8), null], .15), /incomplete trunk-footprint/);
});

test('registration preserves accepted/source identity and records nonuniform slope changes', () => {
  const t = tree(), accepted = tree('accepted', -4), original = JSON.stringify([t, accepted]);
  const before = Array.from({ length: 9 }, () => support(0)), after = Array.from({ length: 9 }, (_, k) => support(k === 8 ? 1.5 : .5));
  const correction = planTreeRegistration(t, before, after, .15), result = applyTreeRegistrations([accepted, t], [scene(accepted), scene(t)], [correction], new Set(['accepted']), 'scenery-trees');
  assert.equal(result.trees[0], accepted); assert.equal(result.trees[1]!.position[1], .2); assert.equal(correction.maximumRimOffsetChange, 1);
  assert.deepEqual({ ...result.trees[1], position: t.position }, t); assert.equal(JSON.stringify([t, accepted]), original);
  assert.throws(() => applyTreeRegistrations([accepted, t], [scene(accepted), scene(t)], [{ ...correction, id: 'accepted' }], new Set(['accepted']), 'scenery-trees'), /Accepted tree/);
  assert.throws(() => applyTreeRegistrations([t], [{ ...scene(t), node: 'other-variant' }], [correction], new Set(), 'scenery-trees'));
  assert.throws(() => assertRegistrationHash(new Uint8Array([1]), sha(new Uint8Array([2])), 'audit'), /Stale tree registration/);
});

test('trunk translation changes only its Y words and leaves every ground/other collider byte exact', () => {
  const t = tree(), accepted = tree('accepted', 5), ground = flatGround(0), building = { ...flatGround(6), id: 'wall', ref: 'building', group: 'citymodel' as const };
  const original = encode([ground, trunk(t), trunk(accepted), building]), before = new Uint8Array(original);
  const correction = planTreeRegistration(t, Array.from({ length: 9 }, () => support(0)), Array.from({ length: 9 }, () => support(.75)), .15);
  const moved = translateRegisteredTreeColliders(original, [t, accepted], [correction]), a = parseCollisionBundle(before), b = parseCollisionBundle(moved.bytes);
  assert.deepEqual(original, before); assert.deepEqual(a.header, b.header);
  for (let k = 0; k < a.colliders.length; k++) {
    const old = a.colliders[k]!, next = b.colliders[k]!;
    assert.deepEqual(old.indices, next.indices); assert.deepEqual(old.triangleTags, next.triangleTags);
    if (old.id !== 't:new') assert.deepEqual(old.positions, next.positions);
    else for (let i = 0; i < old.positions.length; i++) assert.equal(next.positions[i], i % 3 === 1 ? Math.fround(old.positions[i]! + .75) : old.positions[i]);
  }
  assert.deepEqual(moved.changedColliderIds, ['t:new']);
  assert.throws(() => translateRegisteredTreeColliders(encode([ground]), [t], [correction]), /collider policy mismatch/);
});

test('intended soil mode repairs a bad initial offset using lowest qualified soil minus0.3m', () => {
  const t = { ...tree(), position: [2, 2, 2] as [number, number, number] }, baseline = Array.from({ length: 9 }, () => support(0));
  const final = Array.from({ length: 9 }, (_, k) => support(k === 4 ? .8 : 1));
  const clear = { retainingWallIds: [], buildingIds: [], waterPointIndices: [] }, c = planTreeSoilSink(t, baseline, final, .15, clear);
  assert.equal(c.policy, 'intended-soil-sink'); assert.equal(c.anchorHeight, .8); assert.equal(c.afterY, .5); assert.equal(c.delta, -1.5);
  assert.throws(() => planTreeRegistration(t, baseline, final, .15), /not physically reasonable/);
  assert.throws(() => planTreeSoilSink(t, baseline, final, .15, { ...clear, retainingWallIds: ['survey-wall'] }), /source-retaining-wall/);
  assert.throws(() => planTreeSoilSink(t, baseline, final, .15, { ...clear, waterPointIndices: [3] }), /source-water/);
  assert.equal(qualifyTreeSoil([...final.slice(0, 8), support(2)], clear).qualified, false);
});

test('conditional omission refuses rendered/collision disagreement and preserves ordered retained collider subarrays', () => {
  const t = tree(), keep = tree('retained', 5), original = encode([flatGround(0), trunk(t), trunk(keep)]), before = parseCollisionBundle(original);
  const missing = Array.from({ length: 9 }, () => null), visible = missing.map(() => support(0));
  assert.equal(conditionalTreeOmission(missing, missing), true); assert.equal(conditionalTreeOmission(visible, visible), false);
  assert.throws(() => conditionalTreeOmission(missing, visible), /Rendered soil\/collision disagree/);
  const omitted = omitRegisteredTreeColliders(original, [t, keep], new Set([t.id])), after = parseCollisionBundle(omitted.bytes);
  assert.equal(omitted.reencoded, true); assert.deepEqual(omitted.removedColliderIds, ['t:new']);
  assert.notDeepEqual(omitted.bytes, original, 'a shorter HCOL needs a new header/layout');
  assert.deepEqual(after.header.surfaceTags, before.header.surfaceTags); assert.equal(after.header.originId, before.header.originId);
  assert.deepEqual(after.colliders, [before.colliders[0], before.colliders[2]], 'all retained collider values/order stay exact');
});

test('mixed reseating and omission preserve ground, buildings and accepted collider words together', () => {
  const moved = tree('aligned'), removed = tree('omitted', 5), accepted = tree('accepted', 7), original = encode([flatGround(1), trunk(moved), trunk(removed), trunk(accepted), { ...flatGround(8), id: 'building', group: 'buildings' as const }]);
  const correction = planTreeSoilSink(moved, Array.from({ length: 9 }, () => support(0)), Array.from({ length: 9 }, () => support(1)), .15, { retainingWallIds: [], buildingIds: [], waterPointIndices: [] });
  const translated = translateRegisteredTreeColliders(original, [moved, removed, accepted], [correction]), result = omitRegisteredTreeColliders(translated.bytes, [moved, removed, accepted], new Set([removed.id]));
  const before = parseCollisionBundle(original), after = parseCollisionBundle(result.bytes);
  assert.deepEqual(after.colliders.map(c => c.id), ['g:cell', 't:aligned', 't:accepted', 'building']);
  for (const id of ['g:cell', 't:accepted', 'building']) assert.deepEqual(after.colliders.find(c => c.id === id), before.colliders.find(c => c.id === id));
  const old = before.colliders.find(c => c.id === 't:aligned')!, next = after.colliders.find(c => c.id === 't:aligned')!;
  old.positions.forEach((v, i) => assert.equal(next.positions[i], i % 3 === 1 ? Math.fround(v + correction.delta) : v));
  assert.deepEqual(old.indices, next.indices); assert.deepEqual(old.triangleTags, next.triangleTags); assert.equal(result.retained.length, 4);
});

test('omission reads actual rendered soil and excludes water/building meshes', async () => {
  const work = path.resolve('data/work/district-expansion-20261018'); mkdirSync(work, { recursive: true }); const dir = mkdtempSync(path.join(work, 'tree-visible-soil-test-'));
  assert.ok(dir.startsWith(work + path.sep));
  try {
    const doc = new Document(), buffer = doc.createBuffer(), scene = doc.createScene(), io = new NodeIO();
    for (const [name, h] of [['cell_ground_grass', 1], ['cell_water', 0], ['building', 10]] as const) {
      const mesh = doc.createMesh(name).addPrimitive(doc.createPrimitive().setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(Float32Array.from([0, h, 0, 5, h, 0, 0, h, 5])).setBuffer(buffer)).setIndices(doc.createAccessor().setType('SCALAR').setArray(Uint32Array.from([0, 1, 2])).setBuffer(buffer)));
      scene.addChild(doc.createNode(name).setMesh(mesh));
    }
    const data = await io.writeBinary(doc); writeFileSync(path.join(dir, 'ground.glb'), data);
    const index = { originId: 'origin', cellSize: 128, cells: [{ id: 'cell', boundsXZ: [0, 0, 128, 128], visual: { lod0: { path: 'ground.glb', sha256: sha(data) } } }] };
    const points: [number, number][] = [[1, 1], [20, 20]];
    const samples = await sampleRenderedTreeGround(dir, index as never, points);
    assert.equal(samples[0]!.height, 1); assert.equal(samples[1], null);
  } finally { assert.ok(path.resolve(dir).startsWith(work + path.sep)); rmSync(dir, { recursive: true }); }
});

test('fresh offline candidate preserves GLBs/ground/accepted prefix and binds a final index independently of the audit', async () => {
  const work = path.resolve('data/work/district-expansion-20261018'); mkdirSync(work, { recursive: true });
  const dir = mkdtempSync(path.join(work, 'tree-registration-test-'));
  assert.ok(dir.startsWith(work + path.sep));
  try {
    const asset = 'a'.repeat(64), accepted = Array.from({ length: 810 }, (_, i) => ({ ...tree(`accepted-${i}`, -500), colliderHeight: i ? 0 : 3.3 }));
    const selected = Array.from({ length: 3 }, (_, i) => tree(`new-${i}`, 900 + i)), all = [...accepted, ...selected];
    const trees = { originId: 'origin', asset: 'scenery-trees', assetSha256: asset, trees: all }, scenery = { schemaVersion: 1, originId: 'origin', assets: [{ id: trees.asset, sha256: asset }], instances: all.map(scene) };
    const put = (file: string, value: unknown) => { const data = JSON.stringify(value); writeFileSync(file, data); return sha(data); };
    const sourcePath = path.join(dir, 'source.json'), acceptedPath = path.join(dir, 'accepted.json'), sourceReportPath = path.join(dir, 'source-report.json');
    const sourceSha = put(sourcePath, trees), acceptedSha = put(acceptedPath, { ...trees, trees: accepted }), sourceReportSha = put(sourceReportPath, { originalSource: true });
    const cid = 'c_p07_p00', acceptedCid = 'c_m04_p00';
    function candidate(name: string, grade: number) {
      const folder = path.join(dir, name); mkdirSync(path.join(folder, 'collision'), { recursive: true }); mkdirSync(path.join(folder, 'visual'));
      const cells = [];
      for (const id of [cid, acceptedCid]) {
        const bytes = encode(id === cid ? [flatGround(grade, 896, 1024, `g:${cid}`), ...selected.map(trunk)] : [flatGround(0, -512, -384, `g:${acceptedCid}`), trunk(accepted[0]!)], id);
        const rel = `collision/${id}.bin`; writeFileSync(path.join(folder, rel), bytes);
        const visual = `visual/${id}.glb`, glb = new Uint8Array([103, 108, 84, 70, 1, 2, 3]); writeFileSync(path.join(folder, visual), glb);
        cells.push({ id, boundsXZ: id === cid ? [896, 0, 1024, 128] : [-512, 0, -384, 128], collision: { path: rel, sha256: sha(bytes), bytes: bytes.length, triangles: 1 }, visual: { lod0: { path: visual, sha256: sha(glb) } } });
      }
      writeFileSync(path.join(folder, 'runtime-terrain.bin'), new Uint8Array([9, 8, 7]));
      put(path.join(folder, 'report.json'), { inputs: { trees: sourceSha }, ground: { original: true } });
      const scenerySha256 = put(path.join(folder, 'scenery.json'), scenery), indexSha256 = put(path.join(folder, 'cells.json'), { originId: 'origin', cellSize: 128, cells });
      return { path: folder, indexSha256, scenerySha256 };
    }
    const baseline = candidate('baseline', 0), current = candidate('audit-candidate', 1), final = candidate('final', .8);
    const row = (t: RegistrationTree) => { const p = treeRegistrationPoints(t), old = sampleTreeRegistrationGround([parseCollisionBundle(readFileSync(path.join(baseline.path, `collision/${cid}.bin`)))], p), next = sampleTreeRegistrationGround([parseCollisionBundle(readFileSync(path.join(current.path, `collision/${cid}.bin`)))], p); return { id: t.id, accepted: false, scenery: scene(t), trunkPolicy: { radius: t.trunkRadius, colliderHeight: t.colliderHeight }, before: { samples: old }, after: { samples: next }, offsetDelta: -1 }; };
    const auditPath = path.join(dir, 'audit.json'), auditSha = put(auditPath, { before: baseline, after: current, rows: [...accepted.map(t => ({ id: t.id, accepted: true, offsetDelta: null })), ...selected.map(row)] });
    const authorityPath = path.join(dir, 'authority.json');
    put(authorityPath, { schemaVersion: 1, kind: 'source-bound-tree-registration', originId: 'origin', assetSha256: asset, thresholdMetres: .15, acceptedCount: 810,
      baselineCells: baseline, auditCells: current, audit: { path: auditPath, sha256: auditSha }, sourceTrees: { path: sourcePath, sha256: sourceSha }, sourceReport: { path: sourceReportPath, sha256: sourceReportSha }, acceptedTrees: { path: acceptedPath, sha256: acceptedSha },
      confirmedTreeIds: selected.map(t => t.id), protectedArea: { minX: -800, maxX: 150, minZ: -450, maxZ: 350 } });
    const out = path.join(dir, 'result');
    const authority = JSON.parse(readFileSync(authorityPath, 'utf8'));
    put(authorityPath, { ...authority, confirmedTreeIds: Array.from({ length: 501 }, (_, i) => `new-${i}`) });
    await assert.rejects(reseatTrees({ authority: authorityPath, candidate: final.path, candidateIndexSha256: final.indexSha256, out }), /1\.\.500/);
    put(authorityPath, { ...authority, confirmedTreeIds: [selected[0]!.id] });
    await assert.rejects(reseatTrees({ authority: authorityPath, candidate: final.path, candidateIndexSha256: final.indexSha256, out }), /exact confirmed audit ID set/);
    put(authorityPath, authority);
    await assert.rejects(reseatTrees({ authority: authorityPath, candidate: final.path, candidateIndexSha256: '0'.repeat(64), out }), /Stale tree registration/); assert.equal(existsSync(out), false);
    const preflight = await reseatTrees({ authority: authorityPath, candidate: final.path, candidateIndexSha256: final.indexSha256, out, checkOnly: true });
    assert.equal(preflight.applied, 3); assert.equal(preflight.proofSha256, null); assert.equal(existsSync(out), false, 'read-only preflight never creates an output candidate');
    const result = await reseatTrees({ authority: authorityPath, candidate: final.path, candidateIndexSha256: final.indexSha256, out });
    assert.equal(result.applied, 3); assert.equal(result.changedCollisionCells, 1);
    const placed = JSON.parse(readFileSync(path.join(out, 'tree-registration/trees.json'), 'utf8'));
    assert.deepEqual(placed.trees.slice(0, 810), accepted); assert.ok(Math.abs(placed.trees[810].position[1] - .5) < 1e-6);
    for (const rel of [`visual/${cid}.glb`, `visual/${acceptedCid}.glb`, `collision/${acceptedCid}.bin`, 'runtime-terrain.bin']) assert.deepEqual(readFileSync(path.join(out, rel)), readFileSync(path.join(final.path, rel)));
    const original = parseCollisionBundle(readFileSync(path.join(final.path, `collision/${cid}.bin`))), changed = parseCollisionBundle(readFileSync(path.join(out, `collision/${cid}.bin`)));
    assert.deepEqual(changed.colliders[0], original.colliders[0], 'ground descriptor and typed arrays remain exact');
    assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8')).ground, { original: true });

    // The intended-soil route binds a fresh final audit and source qualification,
    // rather than preserving arbitrary offsets from the older unreleased build.
    const [E, N] = geodeticToGk25(60.18, 24.95), pinnedFile = (name: string, value: unknown) => { const file = path.join(dir, name); return { path: file, sha256: put(file, value) }; };
    const soilSources = {
      origin: pinnedFile('origin.json', { id: 'origin', originProjected: [E - 1000, N, 0] }),
      config: pinnedFile('config.json', { playArea: { minX: 896, maxX: 1152, minZ: 0, maxZ: 128 } }),
      streetParts: pinnedFile('street.geojson', { type: 'FeatureCollection', features: [] }),
      footprints: pinnedFile('footprints.geojson', { type: 'FeatureCollection', features: [] }),
      osm: pinnedFile('osm.json', { elements: [{ type: 'node', id: 1, lat: 60.17, lon: 24.95 }, { type: 'node', id: 2, lat: 60.19, lon: 24.95 }, { type: 'way', id: 3, nodes: [1, 2], tags: { natural: 'coastline' } }] }),
    };
    const soilRows = selected.map(t => { const old = row(t), points = treeRegistrationPoints(t); return { ...old, after: { samples: sampleTreeRegistrationGround([parseCollisionBundle(readFileSync(path.join(final.path, `collision/${cid}.bin`)))], points) } }; });
    const soilAudit = pinnedFile('soil-audit.json', { before: baseline, after: final, rows: [...accepted.map(t => ({ id: t.id, accepted: true, offsetDelta: null })), ...soilRows] });
    const soilAuthority = pinnedFile('soil-authority.json', { ...authority, mode: 'intended-soil-sink', soilSources, auditCells: final, audit: soilAudit });
    const soilOut = path.join(dir, 'soil-result'), soilResult = await reseatTrees({ authority: soilAuthority.path, candidate: final.path, candidateIndexSha256: final.indexSha256, out: soilOut });
    assert.equal(soilResult.applied, 3);
    assert.ok(Math.abs(JSON.parse(readFileSync(path.join(soilOut, 'tree-registration/trees.json'), 'utf8')).trees[810].position[1] - .5) < 1e-6);
  } finally {
    assert.ok(path.resolve(dir).startsWith(work + path.sep)); rmSync(dir, { recursive: true });
  }
});
