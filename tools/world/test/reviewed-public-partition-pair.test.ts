import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {readReviewedPublicPartitionPair, qualifyReviewedPublicPartitionPair, REVIEWED_EHRENSTROM_PAIR} from '../lib/reviewed-public-partition-pair.ts';
import {loadGeoJsonPolygons} from '../lib/geometry.ts';
import {qualifyPublicPartitionGround, type PublicPartitionPatch} from '../lib/public-partition-ground.ts';
import type {RoadSourceElement, RoadSupportTriangle} from '../lib/expansion-road-merge.ts';

test('review artifacts reject malformed, oversized and caller-invented approvals before geometry work', () => {
  const input = {proposalBytes: Buffer.from('{}'), qualificationBytes: Buffer.from('{}'), scopeBytes: Buffer.from('{}')};
  assert.throws(() => readReviewedPublicPartitionPair(input), /approved literal artifact/);
  assert.throws(() => readReviewedPublicPartitionPair({...input, proposalBytes: Buffer.alloc(512 * 1024 + 1)}), /byte limit/);
  assert.throws(() => readReviewedPublicPartitionPair({...input, proposalBytes: Buffer.alloc(500 * 1024), qualificationBytes: Buffer.alloc(300 * 1024)}), /aggregate byte limit/);
  assert.throws(() => readReviewedPublicPartitionPair({...input, approval: 'yes'} as typeof input));
  assert.throws(() => qualifyReviewedPublicPartitionPair({} as PublicPartitionPatch, [], new Map(), [], [0, 0, 1, 1], {id: REVIEWED_EHRENSTROM_PAIR.id} as any, {streetPartsSha256: '', osmSha256: ''}), /not loaded/);
});

// Licensed source geometry and the full private review artifacts are intentionally
// not copied into the public source distribution. This local integration binds the
// exact approved artifacts when the asset workspace is present.
const root = new URL('../../../../', import.meta.url);
const location = (name: string) => fileURLToPath(new URL(name, root));
const files = {
  proposal: 'evidence/ehrenstrom-paired-native-proposal-v5.json',
  qualification: 'evidence/ehrenstrom-paired-source-qualification-v5.json',
  scope: 'evidence/ehrenstrom-source-constrained-domain-v3.json',
  closure: 'evidence/ehrenstrom-approved-native-closure-v1.json',
  parts: 'sources/raw-v2/street-parts/southwest-cumulative-20261029.geojson',
  osm: 'sources/raw-v2/osm/southwest-cumulative-20261029.json',
};
const available = Object.values(files).every(p => fs.existsSync(location(p)));
const local = {skip: available ? false : 'Pinned private asset review fixture is not present in this source checkout'};
function fixture() {
  const bytes = {proposalBytes: fs.readFileSync(location(files.proposal)), qualificationBytes: fs.readFileSync(location(files.qualification)), scopeBytes: fs.readFileSync(location(files.scope))};
  const proposal = JSON.parse(bytes.proposalBytes.toString()), closure = JSON.parse(fs.readFileSync(location(files.closure), 'utf8'));
  const patch: PublicPartitionPatch = {lane: '80326984:0:f0', sourcePartIds: ['41211', '41212'], sourceDelta: proposal.sourceDelta, physicalDomain: proposal.physicalDomain, triangles: proposal.triangles};
  const parts = loadGeoJsonPolygons(location(files.parts), 25497350, 6672960, (p, i) => String(p.osan_id ?? p.id ?? i)).filter(p => patch.sourcePartIds.includes(p.id));
  const way = JSON.parse(fs.readFileSync(location(files.osm), 'utf8')).elements.find((e: RoadSourceElement) => e.type === 'way' && e.id === 80326984) as RoadSourceElement;
  const ways = new Map([[way.id, way]]), floor = closure.triangles as RoadSupportTriangle[], accepted = [-1792, -2304, 800, 768] as const;
  const review = readReviewedPublicPartitionPair(bytes);
  const digest = (p: string) => createHash('sha256').update(fs.readFileSync(location(p))).digest('hex');
  const sourcePins = {streetPartsSha256: digest(files.parts), osmSha256: digest(files.osm)};
  return {bytes, patch, parts, ways, floor, accepted, review, sourcePins};
}

test('approved literal pair qualifies source eligibility for both lanes while ordinary source caps still reject', local, () => {
  const f = fixture();
  const result = qualifyReviewedPublicPartitionPair(f.patch, f.parts, f.ways, f.floor, f.accepted, f.review, f.sourcePins);
  assert.equal(result.sourceEligibilityOnly, true);
  assert.equal(result.nativeClosureTriangles, 24);
  assert.equal(result.proposalSha256, REVIEWED_EHRENSTROM_PAIR.proposalSha256);
  assert.ok(result.sourceGapArea > .01);
  f.patch.lane = '80326984:0:b0';
  assert.equal(qualifyReviewedPublicPartitionPair(f.patch, f.parts, f.ways, f.floor, f.accepted, f.review, f.sourcePins).lane, f.patch.lane);
  assert.throws(() => qualifyPublicPartitionGround(f.patch, f.parts, f.ways, f.floor, f.accepted));
  const unrelated: RoadSupportTriangle = {id: 'unrelated', tag: 'road:asphalt', points: [[0, 0, 0], [0, 0, 1], [1, 0, 0]]};
  assert.equal(qualifyReviewedPublicPartitionPair(f.patch, f.parts, f.ways, [...f.floor, unrelated], f.accepted, f.review, f.sourcePins).nativeClosureTriangles, 24);
});

test('changed scope, pair, source identity, authority and proposed faces cannot reuse this approval', local, () => {
  const f = fixture(), invoke = (patch = f.patch, parts = f.parts, ways = f.ways, accepted: readonly [number, number, number, number] = f.accepted) =>
    qualifyReviewedPublicPartitionPair(patch, parts, ways, f.floor, accepted, f.review, f.sourcePins);
  const wrongLane = structuredClone(f.patch); wrongLane.lane = '825173902:0:b0'; assert.throws(() => invoke(wrongLane), /Unreviewed lane/);
  const wrongPair = structuredClone(f.patch); wrongPair.sourcePartIds[1] = '41233'; assert.throws(() => invoke(wrongPair), /Unreviewed source pair/);
  const widened = structuredClone(f.patch); widened.physicalDomain[0]![0] -= .01; assert.throws(() => invoke(widened), /Physical domain differs/);
  const changedGap = structuredClone(f.patch); changedGap.sourceDelta[0]![0]![0]![0] += .001; assert.throws(() => invoke(changedGap), /Source gap differs/);
  const changedFace = structuredClone(f.patch); changedFace.triangles[0]!.points[0]![1] += .001; assert.throws(() => invoke(changedFace), /native faces differ/);
  const changedSource = structuredClone(f.parts); changedSource[0]!.rings[0]![0]![0] += .001; assert.throws(() => invoke(f.patch, changedSource), /municipal source/);
  const changedWay = structuredClone(f.ways); changedWay.get(80326984)!.tags!.access = 'private'; assert.throws(() => invoke(f.patch, f.parts, changedWay), /public OSM way/);
  assert.throws(() => invoke(f.patch, [...f.parts, f.parts[0]!]), /owner must be unique/);
  assert.throws(() => invoke(f.patch, f.parts, f.ways, [-1792, -2304, 800, 1792]), /Accepted authority differs/);
  const stale = Buffer.from(f.bytes.scopeBytes); stale[stale.length - 1] = 32;
  assert.throws(() => readReviewedPublicPartitionPair({...f.bytes, scopeBytes: stale}), /approved literal artifact/);
});

test('actual local native closure rejects removed, altered, duplicated and added levels', local, () => {
  const f = fixture(), run = (floor: RoadSupportTriangle[]) => qualifyReviewedPublicPartitionPair(f.patch, f.parts, f.ways, floor, f.accepted, f.review, f.sourcePins);
  assert.throws(() => run(f.floor.slice(1)), /closure changed/);
  const changed = structuredClone(f.floor); (changed[0]!.points[0] as [number, number, number])[1] += .0005;
  assert.throws(() => run(changed), /native face bytes changed/);
  assert.throws(() => run([...f.floor.slice(1), f.floor[1]!]), /Duplicate native triangle/);
  const upper = structuredClone(f.floor[0]!); (upper as {id: string}).id += ':upper';
  for (const p of upper.points) (p as [number, number, number])[1] += 1;
  assert.throws(() => run([...f.floor, upper]), /closure changed/);
});

test('unchanged selected pair and way cannot hide refreshed third-party source or access restrictions', local, () => {
  const f = fixture();
  for (const key of ['streetPartsSha256', 'osmSha256'] as const) {
    const sourcePins = {...f.sourcePins, [key]: '0'.repeat(64)};
    assert.throws(() => qualifyReviewedPublicPartitionPair(f.patch, f.parts, f.ways, f.floor, f.accepted, f.review, sourcePins), /Whole (municipal|OSM) source changed/);
  }
});


test('approved contained v5 geometry passes every unchanged generic physical gate', local, () => {
  const f = fixture();
  const result = qualifyPublicPartitionGround(f.patch, f.parts, f.ways, f.floor, f.accepted,
    {review: f.review, sourcePins: f.sourcePins});
  assert.equal(result.pieces.length, 558);
  assert.equal(result.proof.continuousFlankProofs.length, 558);
  assert.ok(result.proof.minimumNormal > .9969);
  assert.ok(result.proof.maximumExtrapolation <= .005);
  assert.ok(result.proof.maximumHeightError < .002);
  // The previous row quantization overshot the exact domain; its changed faces
  // cannot inherit this source eligibility even though the source scope matches.
  const oldPath = location('evidence/ehrenstrom-paired-native-proposal-v3.json');
  if (fs.existsSync(oldPath)) {
    const old = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
    assert.throws(() => qualifyPublicPartitionGround({...f.patch, triangles: old.triangles},
      f.parts, f.ways, f.floor, f.accepted, {review: f.review, sourcePins: f.sourcePins}), /native faces differ/);
  }
});
