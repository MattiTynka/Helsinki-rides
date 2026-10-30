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

test('a building centre resolves to its nearest road, shared by menu and placement', () => {
  assert.equal(containsSupportedArea(gameplay, 4, 12, .42), false);
  assert.deepEqual(resolveDropInTarget(gameplay, roads(0), 4, 12), [4, 0]);
});

test('nearest-road placement ignores the old coverage mask instead of selecting a farther qualified road', () => {
  assert.deepEqual(resolveDropInTarget(gameplay, roads(6, 0), 4, 8), [4, 6]);
  assert.deepEqual(resolveDropInTarget(gameplay, roads(6, 10), 4, 8), [4, 6]);
});

test('drop-in placement is not rejected by capsule clearance, coverage holes or the old rectangular playArea', () => {
  assert.deepEqual(resolveDropInTarget(gameplay, roads(2.7), 4, 8), [4, 2.7]);
  assert.deepEqual(resolveDropInTarget(gameplay, roads(2.62), 4, 8), [4, 2.62]);
  const hole = { ...gameplay, supportedArea: { schema: 1, regions: [{ id: 'street',
    outer: [[-20, -3], [20, -3], [20, 3], [-20, 3]], holes: [[[3, -.1], [5, -.1], [5, .1], [3, .1]]],
  }] } } as GameplayBundle;
  assert.deepEqual(resolveDropInTarget(hole, roads(0), 4, 8), [4, 0]);
  const precise = resolveDropInTarget(gameplay, roads(0), 4.123456789, 8)!;
  assert.ok(Math.abs(precise[0] - 4.123456789) < 1e-12);
  assert.equal(precise[1], 0);
  assert.deepEqual(resolveDropInTarget(gameplay, roads(150), 4, 150), [4, 150]);
});

test('all worlds share bounded nearest-road lookup and finite-coordinate fallback', () => {
  const legacy = { ...gameplay, supportedArea: undefined };
  const index = roads(6), hit = index.nearestLane(4.123456789, 8, undefined, 80)!;
  assert.deepEqual(resolveDropInTarget(legacy, index, 4.123456789, 8), [hit.point[0], hit.point[2]]);
  assert.deepEqual(resolveDropInTarget(legacy, roads(90), 4, 0), [4, 0]);
  assert.deepEqual(resolveDropInTarget(gameplay, roads(90), 4, 8), [4, 8]);
  assert.deepEqual(resolveDropInTarget(gameplay, roads(90), 4, 0), [4, 0]);
  for (const [x, z] of [[NaN, 0], [Infinity, 0], [0, -Infinity]]) {
    assert.equal(resolveDropInTarget(gameplay, roads(0), x!, z!), null);
  }
});
