import assert from 'node:assert/strict';
import {test} from 'node:test';
import {gk25ToGeodetic, type RoadGraph, type Vec3} from '../../../packages/world-schema/src/index.ts';
import {mergeQualifiedFootways} from '../lib/expansion-footway-merge.ts';
import {RoadCollisionSupport, inspectRetainedPathExposure, isPublicWalkingGroundTag, type RoadSourceElement, type RoadCoverage} from '../lib/expansion-road-merge.ts';
import {assertOutsideOnlyRoadGraphRepair, repairOutsidePolyline} from '../lib/road-outside-repair.ts';
import type {LocalPolygon} from '../lib/geometry.ts';
import {sourceSha256} from '../lib/source-files.ts';

function fixture() {
  const origin: Vec3 = [25497350, 6672960, 7.5], first = {id: 'w1', points: [[-5, 0, 0], [2, 0, 0]] as Vec3[]}, next = {id: 'w2', points: [[2, 0, 0], [10, 0, 0]] as Vec3[]};
  const accepted: RoadGraph = {schemaVersion: 2, originId: 'fixture', source: {id: 's', sha256: 'a'.repeat(64), license: 'fixture', attribution: 'fixture'}, lanes: [], nodes: [], connectors: [], parking: [], footways: [first]}, candidate = {...accepted, footways: [first, next]};
  const acceptedCoverage: RoadCoverage = {playArea: {minX: -10, maxX: 1, minZ: -10, maxZ: 10}}, coverage: RoadCoverage = {playArea: {...acceptedCoverage.playArea, maxX: 20}};
  const elements: RoadSourceElement[] = [-5, 2, 10].map((x, i) => {const [lat, lon] = gk25ToGeodetic(origin[0] + x, origin[1]); return {type: 'node', id: i + 1, lat, lon};});
  elements.push({type: 'way', id: 1, nodes: [1, 2], tags: {highway: 'cycleway', foot: 'designated'}}, {type: 'way', id: 2, nodes: [2, 3], tags: {highway: 'footway', footway: 'crossing'}});
  const parts: LocalPolygon[] = [{id: 'public', bbox: [-10, -10, 20, 10], rings: [[[-10, -10], [20, -10], [20, 10], [-10, 10]]], properties: {paatyyppi: 'Kevyt liikenne'}}];
  const support = new RoadCollisionSupport([{id: 'a', tag: 'raised:asphalt', points: [[-10, 0, -10], [-10, 0, 10], [20, 0, 10]]}, {id: 'b', tag: 'raised:asphalt', points: [[-10, 0, -10], [20, 0, 10], [20, 0, -10]]}], isPublicWalkingGroundTag);
  return {accepted, candidate, acceptedCoverage, coverage, origin, osm: {elements}, parts, support, newFootways: [{id: 'w2', partIds: ['public']}], retainedFootways: [{id: 'w1', partIds: ['public']}], exposure: inspectRetainedPathExposure(accepted.footways, acceptedCoverage, coverage), routes: [{id: 'out-back', steps: [{wayId: 1, fromNode: 1, toNode: 2}, {wayId: 2, fromNode: 2, toNode: 3}, {wayId: 2, fromNode: 3, toNode: 2}, {wayId: 1, fromNode: 2, toNode: 1}]}]};
}

test('public walking crossing route preserves accepted prefix and proves native accepted-to-new return', () => {
  const f = fixture(), original = structuredClone(f.accepted), result = mergeQualifiedFootways(f);
  assert.deepEqual(f.accepted, original); assert.deepEqual(result.footways[0], original.footways[0]); assert.equal(result.footways.length, 2);
  assert.equal(result.receipt.routes[0]!.connectedAcceptedOutAndBack, true); assert.ok(result.receipt.newAudits[0]!.physical.samples > 0); assert.equal(result.receipt.actualWalkingRequired, true);
});

test('walking requires foot access, native pavement, and exact source-node connectivity', () => {
  const privatePath = fixture(); privatePath.osm.elements.find(e => e.type === 'way' && e.id === 2)!.tags!.foot = 'no'; assert.throws(() => mergeQualifiedFootways(privatePath), /Non-public walking/);
  const noGround = fixture(); noGround.support = new RoadCollisionSupport([]); assert.throws(() => mergeQualifiedFootways(noGround), /native road\/pavement support/);
  const wrongNode = fixture(); wrongNode.routes[0]!.steps[1]!.fromNode = 4; assert.throws(() => mergeQualifiedFootways(wrongNode), /shared OSM node/);
});

test('reviewed walking structure is limited to its exact source record and final selected floor', () => {
  const f = fixture(), way = f.osm.elements.find(e => e.type === 'way' && e.id === 2)!; way.tags!.bridge = 'yes'; way.tags!.layer = '1';
  assert.throws(() => mergeQualifiedFootways(f), /Unqualified walking structure/);
  const authority = {sourceWaySha256: sourceSha256(JSON.stringify(way)), bridge: {wayId: 2, layer: 1}, support: f.support, receipt: {fixture: 'literal upper faces'}};
  assert.equal(mergeQualifiedFootways({...f, reviewedFootways: new Map([['w2', authority]])}).receipt.routes.length, 1);
  assert.throws(() => mergeQualifiedFootways({...f, reviewedFootways: new Map([['w2', {...authority, bridge: {wayId: 3, layer: 1}}]])}), /Unqualified walking structure/);
  assert.throws(() => mergeQualifiedFootways({...f, reviewedFootways: new Map([['w2', {...authority, sourceWaySha256: 'f'.repeat(64)}]])}), /source identity/);
  assert.throws(() => mergeQualifiedFootways({...f, reviewedFootways: new Map([['w2', {...authority, support: new RoadCollisionSupport([])}]])}), /native road\/pavement support/);
  assert.throws(() => mergeQualifiedFootways({...f, reviewedFootways: new Map([['w1', authority]])}), /selected new record/);
});

test('a sub-sample unsupported gap cannot certify a walking circuit even when endpoints have ground', () => {
  const f = fixture(); f.coverage = {...f.coverage, supportedArea: {schemaVersion: 1, regions: [{id: 'gap', outer: [[-10, -10], [20, -10], [20, 10], [-10, 10]], holes: [[[5.0001, -.01], [5.0002, -.01], [5.0002, .01], [5.0001, .01]]]}]}};
  assert.throws(() => mergeQualifiedFootways(f), /closed capsule interval/);
});

test('retained footway repairs preserve old interior interpolation and every identity', () => {
  const f = fixture(), before = {...f.accepted, footways: [{id: 'w1', points: [[-5, 3, 0], [2, 3, 0]] as Vec3[]}]};
  const repaired = repairOutsidePolyline(before.footways[0]!.points, f.acceptedCoverage, f.coverage, (x) => ({height: x <= 1 ? 3 : 3 - (x - 1), triangles: ['floor']}));
  const after = {...before, footways: [{id: 'w1', points: repaired.points}]};
  assert.equal(assertOutsideOnlyRoadGraphRepair(before, after, f.acceptedCoverage)[0]!.kind, 'footways');
  const unsafe = structuredClone(after); unsafe.footways[0]!.points[0]![1] += .01; assert.throws(() => assertOutsideOnlyRoadGraphRepair(before, unsafe, f.acceptedCoverage), /accepted inside vertex/);
  const renamed = {...after, footways: [{...after.footways[0]!, id: 'w3'}]}; assert.throws(() => assertOutsideOnlyRoadGraphRepair(before, renamed, f.acceptedCoverage), /source identity/);
});
