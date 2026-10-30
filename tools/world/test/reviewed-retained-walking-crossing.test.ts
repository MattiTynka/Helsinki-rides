import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {decodeRoadGraph} from '../../../packages/world-schema/src/index.ts';
import {readDeliveryFile} from '../lib/delivery-city.ts';
import {decodeDeliverySimulation} from '../lib/delivery-city-payloads.ts';
import {loadGeoJsonPolygons} from '../lib/geometry.ts';
import {readReviewedRetainedWalkingCrossing, assertReviewedRetainedWalkingCrossing, RETAINED_WALKING_CROSSING_PROPOSAL_SHA256, RETAINED_WALKING_CROSSING_PROJECTED_EXPOSURE_SHA256, type ReviewedRetainedWalkingCrossing} from '../lib/reviewed-retained-walking-crossing.ts';
import {inspectRetainedPathExposure} from '../lib/expansion-road-merge.ts';
const proposal = {file: '../evidence/ruoholahti-routes/retained-west-public-crossing-proposal-v1.json', sha256: RETAINED_WALKING_CROSSING_PROPOSAL_SHA256}, available = fs.existsSync(proposal.file);
function fixture() {
  const oldRoot = '../accepted-world/world/senate-20261025-civilian-flee', currentRoot = '../work/cumulative-city-east-walking-seam-v1/world';
  const load = (root: string) => {const m = JSON.parse(fs.readFileSync(root + '/manifest.json', 'utf8')); const payload = (key: string) => decodeDeliverySimulation(readDeliveryFile(root, m[key]), m[key]); return {graph: decodeRoadGraph(payload('roads')), gameplay: JSON.parse(Buffer.from(payload('gameplay')).toString())};};
  const old = load(oldRoot), current = load(currentRoot), mask = JSON.parse(fs.readFileSync('../evidence/cumulative-southwest-supported-area-source-v2.json', 'utf8'));
  return {accepted: old.graph, current: current.graph, acceptedCoverage: old.gameplay, world: {directory: currentRoot, manifestSha256: 'd453fdd79db114c914322f0209121c34819206b294004bdcece2739f0f3b4701'}, coverage: {playArea: mask.qualification.expanded, supportedArea: mask.supportedArea}, sourcePins: {osmSha256: 'a6bf71bae890ab60b4249c8546e6b7185ce37c9ede4137e9c4aefbd9a755e65a', streetPartsSha256: '1ac1409cf70cd6c3ad1ab7139fd6f365898d5c654e499616a1892d1b669645b2'}, osm: JSON.parse(fs.readFileSync('../sources/raw-v2/osm/southwest-cumulative-20261029.json', 'utf8')), parts: loadGeoJsonPolygons('../sources/raw-v2/street-parts/southwest-cumulative-20261029.geojson', 25497350, 6672960, p => String(p.osan_id)), read: (p: {file: string}, cap = 64 * 1024 * 1024) => {const b = fs.readFileSync(p.file); assert.ok(b.length <= cap); return b;}};
}
let context: ReturnType<typeof fixture>, prepared: ReturnType<typeof readReviewedRetainedWalkingCrossing>;
const load = () => {if (!prepared) {context = fixture(); prepared = readReviewedRetainedWalkingCrossing(proposal, context);} return prepared;};
const projectedExposureReview = {file: '../evidence/retained-crossing-projected-exposure-v1/review.json', sha256: RETAINED_WALKING_CROSSING_PROJECTED_EXPOSURE_SHA256};
const projectedAvailable = available && fs.existsSync(projectedExposureReview.file);
function finalFixture() {
  const base = fixture(), mask = JSON.parse(fs.readFileSync('../evidence/w29282225-supported-area-source-qualified-v4.json', 'utf8'));
  return {...base, coverage: {playArea: mask.qualification.expanded, supportedArea: mask.supportedArea}, projectedExposureReview};
}
test('fabricated retained crossing tokens and arbitrary proposals cannot authorize source access', () => {
  assert.throws(() => readReviewedRetainedWalkingCrossing({...proposal, sha256: '0'.repeat(64)}, {} as never));
  assert.throws(() => assertReviewedRetainedWalkingCrossing({} as ReviewedRetainedWalkingCrossing, {id: 'w1533067599', points: []}, {} as never, []));
});
test('exact three-metre exposed crossing recomputes real source and d453 capsule floor', {skip: !available}, () => {
  const q = load(), way = context.osm.elements.find((w: any) => w.type === 'way' && w.id === 1533067599), ranges: [number, number][] = [[0, 3.5184507496267843]];
  assert.doesNotThrow(() => assertReviewedRetainedWalkingCrossing(q.authority, q.record, way, ranges)); q.verifyInputs();
  const copy = structuredClone(q.record); copy.points[0]![0] += 1; assert.throws(() => assertReviewedRetainedWalkingCrossing(q.authority, copy, way, ranges));
  assert.doesNotThrow(() => assertReviewedRetainedWalkingCrossing(q.authority, q.record, way, ranges));
});
test('inside, longer, other-record or changed source uses do not inherit the crossing role', {skip: !available}, () => {
  const q = load(), way = context.osm.elements.find((w: any) => w.type === 'way' && w.id === 1533067599);
  for (const ranges of [[[0, 3.52]], [[3.5184507496267843, 5]], [[0, 3]], []] as [number, number][][]) assert.throws(() => assertReviewedRetainedWalkingCrossing(q.authority, q.record, way, ranges));
  assert.throws(() => assertReviewedRetainedWalkingCrossing(q.authority, {...q.record, id: 'w27194652'}, way, [[0, 3.5184507496267843]]));
  assert.throws(() => assertReviewedRetainedWalkingCrossing(q.authority, q.record, {...way, tags: {...way.tags, foot: 'designated'}}, [[0, 3.5184507496267843]]));
  const parts = structuredClone(context.parts); parts.find(p => p.id === '492089')!.properties.alatyyppi = 'Erotettu pyörätie'; assert.throws(() => readReviewedRetainedWalkingCrossing(proposal, {...context, parts}));
  const current = structuredClone(context.current); current.footways.find(r => r.id === 'w1533067599')!.points.at(-1)![1] += .001; assert.throws(() => readReviewedRetainedWalkingCrossing(proposal, {...context, current}));
});
test('actual stale serialized HCOL fails at construction and final input verification', {skip: !available}, () => {
  const q = load(), manifest = JSON.parse(fs.readFileSync(context.world.directory + '/manifest.json', 'utf8')), needle = manifest.cells.find((c: any) => c.id === 'c_m15_p05').collision.path.split('/').at(-1), original = fs.readFileSync;
  let hits = 0; try {(fs as any).readFileSync = (file: any, ...args: any[]) => {const b = (original as any)(file, ...args); if (String(file).endsWith(needle) && Buffer.isBuffer(b)) {const changed = Buffer.from(b); changed[0] = changed[0]! ^ 1; hits++; return changed;} return b;}; assert.throws(() => readReviewedRetainedWalkingCrossing(proposal, context)); assert.ok(hits > 0); hits = 0; assert.throws(() => q.verifyInputs()); assert.ok(hits > 0);} finally {fs.readFileSync = original;}
});

test('exact projected station uses final1200 while preserving original station and identical boundary', {skip: !projectedAvailable}, () => {
  const final = finalFixture(), q = readReviewedRetainedWalkingCrossing(proposal, final), way = final.osm.elements.find((w: any) => w.type === 'way' && w.id === 1533067599);
  const exposure = inspectRetainedPathExposure([q.record], final.acceptedCoverage, final.coverage);
  assert.deepEqual(exposure[0]!.intervals, [[0, 3.5184507496267696]]);
  assert.deepEqual(inspectRetainedPathExposure([final.accepted.footways.find(r => r.id === q.record.id)!], final.acceptedCoverage, final.coverage)[0]!.intervals, [[0, 3.5184507496267843]]);
  assert.doesNotThrow(() => assertReviewedRetainedWalkingCrossing(q.authority, q.record, way, exposure[0]!.intervals));
  assert.deepEqual(q.receipt.projectedExposure!.identicalBoundaryPoint, [-1792, -5.0182402739465415, 745.5487786549986]);
  assert.equal(q.receipt.projectedExposure!.nativeCapsuleWitnesses, 990); q.verifyInputs();
});

test('final authority rejects even the historical longer station, changed XY and future masks', {skip: !projectedAvailable}, () => {
  const final = finalFixture(), q = readReviewedRetainedWalkingCrossing(proposal, final), way = final.osm.elements.find((w: any) => w.type === 'way' && w.id === 1533067599);
  for (const intervals of [[[0, 3.5184507496267843]], [[0, 3.51845074962677]], [[0, 3.51845074962676]], [[0, 3.52]], [[3.5184507496267696, 5]]] as [number, number][][]) assert.throws(() => assertReviewedRetainedWalkingCrossing(q.authority, q.record, way, intervals));
  const changed = structuredClone(q.record); changed.points[1]![0] += 1e-9;
  assert.throws(() => assertReviewedRetainedWalkingCrossing(q.authority, changed, way, [[0, 3.5184507496267696]]));
  assert.throws(() => readReviewedRetainedWalkingCrossing(proposal, {...final, projectedExposureReview: undefined}), /Historical crossing requires/);
  assert.throws(() => readReviewedRetainedWalkingCrossing(proposal, {...fixture(), projectedExposureReview}), /exact reviewed final mask/);
  const future = structuredClone(final.coverage); future.supportedArea.regions[0].outer[0][0] += .000001;
  assert.throws(() => readReviewedRetainedWalkingCrossing(proposal, {...final, coverage: future}), /exact reviewed final mask/);
  assert.throws(() => readReviewedRetainedWalkingCrossing(proposal, {...final, projectedExposureReview: {...projectedExposureReview, sha256: '0'.repeat(64)}}), /Unreviewed projected/);
});

test('final verification rechecks exact mask bytes and live coverage binding', {skip: !projectedAvailable}, () => {
  const final = finalFixture(), q = readReviewedRetainedWalkingCrossing(proposal, final);
  final.coverage.supportedArea.regions[0].id += '-future'; assert.throws(() => q.verifyInputs(), /mask changed/);
  const stable = finalFixture(); let tamper = false;
  const read = (pin: {file: string}, cap?: number) => {const bytes = stable.read(pin, cap); return tamper && pin.file.endsWith('w29282225-supported-area-source-qualified-v4.json') ? Buffer.concat([bytes, Buffer.from(' ')]) : bytes;};
  const bytesBound = readReviewedRetainedWalkingCrossing(proposal, {...stable, read}); tamper = true;
  assert.throws(() => bytesBound.verifyInputs());
});

test('projected compatibility retains actual serialized floor rejection', {skip: !projectedAvailable}, () => {
  const final = finalFixture(), q = readReviewedRetainedWalkingCrossing(proposal, final), manifest = JSON.parse(fs.readFileSync(final.world.directory + '/manifest.json', 'utf8')), needle = manifest.cells.find((c: any) => c.id === 'c_m15_p05').collision.path.split('/').at(-1), original = fs.readFileSync;
  let hits = 0; try {(fs as any).readFileSync = (file: any, ...args: any[]) => {const b = (original as any)(file, ...args); if (String(file).endsWith(needle) && Buffer.isBuffer(b)) {const changed = Buffer.from(b); changed[0] = changed[0]! ^ 1; hits++; return changed;} return b;}; assert.throws(() => readReviewedRetainedWalkingCrossing(proposal, final)); assert.ok(hits > 0); hits = 0; assert.throws(() => q.verifyInputs()); assert.ok(hits > 0);} finally {fs.readFileSync = original;}
});

test('final input verification preserves each original read cap with a smaller caller default', {skip: !projectedAvailable}, () => {
  const final = finalFixture(), seen = new Map<string, number>(); let verifying = false;
  const read = (pin: {file: string}, cap = 16 * 1024 * 1024) => {const bytes = fs.readFileSync(pin.file); assert.ok(bytes.length <= cap); if (verifying) assert.equal(cap, seen.get(pin.file)); else seen.set(pin.file, cap); return bytes;};
  const q = readReviewedRetainedWalkingCrossing(proposal, {...final, read}); verifying = true; q.verifyInputs();
  assert.equal(seen.get('../sources/raw-v2/street-parts/southwest-cumulative-20261029.geojson'), 64 * 1024 * 1024);
  assert.equal(seen.get('../evidence/w29282225-supported-area-source-qualified-v4.json'), 2_000_000);
  assert.equal(seen.get(projectedExposureReview.file), 65536);
});
