import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RoadIndex, containsSupportedArea, type GameplayBundle, type RoadGraph, type RoadLane } from '@helsinki/world-schema';
import { resolveDropInTarget } from '../src/world/drop-in.ts';

const gameplay = {
  playArea: { minX: -100, minZ: -100, maxX: 100, maxZ: 100 },
  supportedArea: { schema: 1, regions: [{ id: 'street', outer: [[-20, -3], [20, -3], [20, 3], [-20, 3]] }] },
} as unknown as GameplayBundle;
const roads = (...heights: number[]) => new RoadIndex({ lanes: heights.map((z, i) => ({
  id: `lane-${i}`, points: [[-15, 0, z], [15, 0, z]], length: 30,
} as RoadLane)), connectors: [], nodes: [], parking: [], footways: [] } as unknown as RoadGraph);

test('a building centre outside public coverage resolves to its supported road, shared by menu and placement', () => {
  assert.equal(containsSupportedArea(gameplay, 4, 12, .42), false);
  assert.deepEqual(resolveDropInTarget(gameplay, roads(0), 4, 12), [4, 0]);
});

test('unsupported nearest tail does not hide an address with another qualified road projection', () => {
  assert.deepEqual(resolveDropInTarget(gameplay, roads(6, 0), 4, 8), [4, 0]);
  assert.equal(resolveDropInTarget(gameplay, roads(6, 10), 4, 8), null);
});

test('drop-in qualification includes capsule clearance, holes and actual Float32 positions', () => {
  assert.equal(resolveDropInTarget(gameplay, roads(2.7), 4, 8), null);
  assert.deepEqual(resolveDropInTarget(gameplay, roads(2.62), 4, 8), [4, Math.fround(2.62)]);
  const hole = { ...gameplay, supportedArea: { schema: 1, regions: [{ id: 'street',
    outer: [[-20, -3], [20, -3], [20, 3], [-20, 3]], holes: [[[3, -.1], [5, -.1], [5, .1], [3, .1]]],
  }] } } as GameplayBundle;
  assert.equal(resolveDropInTarget(hole, roads(0), 4, 8), null);
  assert.deepEqual(resolveDropInTarget(gameplay, roads(0), 4.123456789, 8), [Math.fround(4.123456789), 0]);
});

test('no-mask worlds preserve legacy nearest-road placement and bounded raw fallback', () => {
  const legacy = { ...gameplay, supportedArea: undefined };
  const index = roads(6), hit = index.nearestLane(4.123456789, 8, undefined, 80)!;
  assert.deepEqual(resolveDropInTarget(legacy, index, 4.123456789, 8), [hit.point[0], hit.point[2]]);
  assert.deepEqual(resolveDropInTarget(legacy, roads(90), 4, 0), [4, 0]);
  assert.equal(resolveDropInTarget(gameplay, roads(90), 4, 8), null);
  assert.deepEqual(resolveDropInTarget(gameplay, roads(90), 4, 0), [4, 0]);
  assert.equal(resolveDropInTarget(gameplay, roads(0), NaN, 0), null);
});
