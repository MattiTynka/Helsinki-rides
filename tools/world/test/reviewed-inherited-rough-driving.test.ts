import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type {RoadGraph} from '../../../packages/world-schema/src/index.ts';
import {sourceSha256} from '../lib/source-files.ts';
import {readReviewedInheritedRoughDriving as readAuthority, inheritedRoughDrivingBaselines as baselines, assertReviewedInheritedRoughDrivingAfter as assertAfter, inspectReviewedInheritedRoughDriving as inspect, INHERITED_ROUGH_DRIVING_APPROVAL, type ReviewedInheritedRoughDriving as Authority} from '../lib/reviewed-inherited-rough-driving.ts';
import {bundleFixture, withCorruptedRead} from './inherited-height-bundle-fixture.ts';

const file = '../evidence/inherited-rough-driving-root-approval-v1.json', available = fs.existsSync(file), hash = (v: unknown) => sourceSha256(JSON.stringify(v));
function fixture() {
  const base = bundleFixture('driving-eight'), approval = JSON.parse(fs.readFileSync(file, 'utf8')), packet = JSON.parse(fs.readFileSync(approval.packet.file, 'utf8'));
  return {pin: {file, sha256: INHERITED_ROUGH_DRIVING_APPROVAL}, context: {...base.context, currentWorld: approval.currentWorld, provenanceArchive: approval.provenanceArchive}, approval, packet};
}
let input: ReturnType<typeof fixture>, prepared: ReturnType<typeof readAuthority>;
function loaded() {if (!prepared) {input = fixture(); prepared = readAuthority(input.pin, input.context);} return prepared;}

test('rough authority rejects fabricated tokens, arbitrary approvals and another world', () => {
  assert.throws(() => readAuthority({file: 'unused', sha256: '0'.repeat(64)}, {} as never), /Unapproved/);
  assert.throws(() => baselines({} as Authority, {} as RoadGraph, {} as RoadGraph, []), /Unrecognized/);
  assert.throws(() => assertAfter({} as Authority, {} as never, []), /Unrecognized/);
  assert.throws(() => inspect({} as Authority, {} as never), /Unrecognized/);
});

test('rough three exact corrections preserve detached graphs and all43currentA records', {skip: !available}, () => {
  const p = loaded(), ids = new Set(p.witnesses.map(w => w.id)); assert.equal(ids.size, 3);
  assert.equal(p.receipt.ordinaryFailuresStillFailed.body, 66417); assert.equal(p.receipt.ordinaryFailuresStillFailed.nominal, 1248); assert.equal(p.receipt.ordinaryFailuresStillFailed.toleranceMetres, .2);
  assert.ok(!JSON.stringify(p.receipt).includes('../') && !JSON.stringify(p.receipt).includes('Users'));
  for (const [before, after] of [[input.context.original, p.originalBaseline], [input.context.current, p.currentBaseline]] as const) for (const kind of ['nodes', 'lanes', 'connectors', 'footways', 'parking'] as const) for (const r of before[kind]) {
    const changed = after[kind].find(q => q.id === r.id);
    if (kind === 'lanes' && ids.has(r.id)) assert.equal(hash(changed), p.witnesses.find(w => w.id === r.id)!.afterSha256); else assert.deepEqual(changed, r);
  }
  const lane = p.originalBaseline.lanes.find(r => ids.has(r.id))!; (lane.points[0] as number[])[1] = lane.points[0]![1] + 1;
  const fresh = baselines(p.authority, input.context.original, input.context.current, []);
  assert.deepEqual(fresh.originalBaseline.lanes.find(r => r.id === lane.id), p.currentBaseline.lanes.find(r => r.id === lane.id));
  assert.throws(() => baselines(JSON.parse(JSON.stringify(p.authority)), input.context.original, input.context.current, []), /Unrecognized/);
});

test('rough actual graph, source, archive and overlap substitutions fail closed', {skip: !available}, () => {
  const p = loaded(), c = input.context, id = p.witnesses[0]!.id;
  for (const kind of ['original', 'current'] as const) {
    const graph = structuredClone(c[kind]); (graph.lanes[0]!.points[0] as number[])[1] = graph.lanes[0]!.points[0]![1] + .001;
    assert.throws(() => baselines(p.authority, kind === 'original' ? graph : c.original, kind === 'current' ? graph : c.current, []), /requires its/);
    assert.throws(() => readAuthority(input.pin, {...c, [kind]: graph}), /Actual ORIGINAL|Actual CURRENT/);
  }
  assert.throws(() => readAuthority(input.pin, {...c, otherRegistrationIds: [id]}), /overlaps/);
  assert.throws(() => baselines(p.authority, c.original, c.current, ['same', 'same']), /Duplicate/);
  assert.throws(() => readAuthority(input.pin, {...c, sourcePins: {...c.sourcePins, osmSha256: '0'.repeat(64)}}));
  assert.throws(() => readAuthority(input.pin, {...c, provenanceArchive: {...c.provenanceArchive, sha256: '0'.repeat(64)}}), /archive/);
  assert.throws(() => readAuthority(input.pin, {...c, currentWorld: {...c.currentWorld, manifestSha256: 'fe78e6a00102dc33f80c9685b1b204465c2d21e5d470ef20586ca1dddd3817c2'}}));
});

test('rough exact AFTER rejects extra knots, metadata, XZ, Y and unselected identities', {skip: !available}, () => {
  const p = loaded(), lane = baselines(p.authority, input.context.original, input.context.current, []).currentBaseline.lanes.find(r => r.id === p.witnesses[0]!.id)!;
  assert.deepEqual(assertAfter(p.authority, lane, []), p.witnesses[0]);
  for (const mutate of [(r: any) => r.points[1][1] += 1e-6, (r: any) => r.points[1][0] += 1e-6, (r: any) => r.points.splice(2, 0, [...r.points[1]]), (r: any) => r.id = '86533504:0:f0', (r: any) => r.width += .001]) {
    const copy = structuredClone(lane); mutate(copy); assert.throws(() => assertAfter(p.authority, copy, []), /Exact reviewed|Unlisted/);
  }
});

test('rough dispositions rerun unchanged ordinary source/native sampler and every failed point', {skip: !available}, () => {
  const p = loaded(), mask = JSON.parse(fs.readFileSync(input.packet.mask.file, 'utf8')), coverage = {playArea: mask.qualification.expanded, supportedArea: mask.supportedArea}, fresh = baselines(p.authority, input.context.original, input.context.current, []);
  let body = 0, nominal = 0;
  for (const w of p.witnesses) {
    const lane = fresh.currentBaseline.lanes.find(r => r.id === w.id)!, result = inspect(p.authority, {lane, currentWorld: input.context.currentWorld, otherRegistrationIds: [], coverage});
    assert.equal(result.disposition.ordinaryResultStillFailed, true); assert.equal(result.disposition.noGenericFloorOrSourcePermission, true); body += result.physical.failureCount; nominal += result.physical.nominalFailureCount;
  }
  assert.equal(body, 66417); assert.equal(nominal, 1248);
  const lane = fresh.currentBaseline.lanes.find(r => r.id === p.witnesses[0]!.id)!;
  assert.throws(() => inspect(p.authority, {lane, currentWorld: {...input.context.currentWorld, directory: input.context.originalWorld.directory}, otherRegistrationIds: [], coverage}), /another floor/);
  assert.throws(() => inspect(p.authority, {lane, currentWorld: input.context.currentWorld, otherRegistrationIds: [], coverage: {playArea: {minX: 0, maxX: 1, minZ: 0, maxZ: 1}}}), /diagnostics changed/);
});

test('rough actual collision, terrain, raw trace and historical bytes are rechecked', {skip: !available}, () => {
  const p = loaded(), m = JSON.parse(fs.readFileSync(input.context.currentWorld.directory + '/manifest.json', 'utf8')), cellId = input.packet.cases[0].physical.currentFloor.cells[0].cell, cell = m.cells.find((c: any) => c.id === cellId), mapping = JSON.parse(fs.readFileSync(input.approval.provenanceArchive.file, 'utf8'));
  const files = [input.context.currentWorld.directory + '/' + cell.collision.path, input.context.currentWorld.directory + '/' + m.terrain.path, input.packet.cases[0].nativeRuns[0].rawPair[0].file, path.join(path.dirname(input.approval.provenanceArchive.file), mapping.files[0].path)];
  for (const f of files) withCorruptedRead(f, () => assert.throws(() => p.verifyInputs(), /input changed/));
});
