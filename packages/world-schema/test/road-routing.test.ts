import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { RoadIndex } from '../src/roads.ts';
import type { RoadGraph } from '../src/types.ts';

/** Frozen pre-optimization algorithm: route identity, including equal-cost choices, is the contract. */
function linearRoute(roads: RoadIndex, fromLane: string, fromS: number, toLane: string, toS: number): string[] | null {
  if (fromLane === toLane && toS >= fromS) return [fromLane];
  const dist = new Map<string, number>(), prev = new Map<string, string>();
  const start = roads.laneById.get(fromLane);
  if (!start || !roads.laneById.has(toLane)) return null;
  dist.set(fromLane, start.length - fromS);
  const open = [{ id: fromLane, d: start.length - fromS }], closed = new Set<string>();
  while (open.length) {
    let best = 0;
    for (let i = 1; i < open.length; i++) if (open[i]!.d < open[best]!.d) best = i;
    const { id, d } = open.splice(best, 1)[0]!;
    if (closed.has(id)) continue;
    closed.add(id);
    for (const c of roads.outgoing.get(id) ?? []) {
      const next = roads.laneById.get(c.to);
      if (!next) continue;
      if (c.to === toLane) {
        const total = d + c.length + toS;
        if (total < (dist.get('$goal') ?? Infinity)) { dist.set('$goal', total); prev.set('$goal', c.id); prev.set(c.id, id); }
        continue;
      }
      const nd = d + c.length + next.length;
      if (nd < (dist.get(c.to) ?? Infinity)) {
        dist.set(c.to, nd); prev.set(c.to, c.id); prev.set(c.id, id); open.push({ id: c.to, d: nd });
      }
    }
  }
  if (!dist.has('$goal')) return null;
  const result = [toLane];
  let cursor = prev.get('$goal')!;
  while (cursor) {
    result.push(cursor);
    if (cursor === fromLane) break;
    cursor = prev.get(cursor)!;
  }
  return result.reverse();
}

function graph(lengths: readonly number[], edges: readonly (readonly [number, number, number])[]): RoadGraph {
  return {
    schemaVersion: 2, originId: 'routing-test', source: { id: 'fixture', sha256: 'x', attribution: 'fixture', license: 'fixture' },
    nodes: [], parking: [], footways: [],
    lanes: lengths.map((length, i) => ({ id: `l${i}`, wayId: i, name: `Lane ${i}`, highway: 'residential', surface: 'asphalt',
      speedLimit: 10, width: 3, from: `n${i}`, to: `n${i + 1}`, points: [[i, 0, 0], [i + length, 0, 0]], length, index: 0, count: 1 })),
    connectors: edges.map(([from, to, length], i) => ({ id: `c${i}`, node: `n${from + 1}`, from: `l${from}`, to: `l${to}`,
      turn: 'straight', points: [[from, 0, 0], [to, 0, 0]], length })),
  };
}

test('routing preserves same-lane forward and behind, zero-cost cycles, ties and multiple frontier entries', () => {
  const roads = new RoadIndex(graph([10, 0, 0, 5, 0, 2, 0], [
    [0, 1, 0], [0, 2, 0], [1, 2, 0], [2, 1, 0], [1, 3, 0], [2, 3, 0],
    [3, 0, 0], [0, 4, 20], [2, 4, 1], [4, 5, 0], [5, 0, 0],
  ]));
  assert.deepEqual(roads.route('l0', 4, 'l0', 5), ['l0']);
  assert.deepEqual(roads.route('l0', 8, 'l0', 2), ['l0', 'c1', 'l2', 'c8', 'l4', 'c9', 'l5', 'c10', 'l0']);
  assert.deepEqual(roads.route('l0', 0, 'l3', 0), ['l0', 'c0', 'l1', 'c4', 'l3']);
  assert.deepEqual(roads.route('l0', 0, 'l5', 1), ['l0', 'c1', 'l2', 'c8', 'l4', 'c9', 'l5']);
  assert.equal(roads.route('l0', 0, 'l6', 0), null);
  assert.equal(roads.route('missing', 0, 'l0', 0), null);
  assert.equal(roads.route('l0', 0, 'missing', 0), null);
  for (const from of roads.graph.lanes) for (const to of roads.graph.lanes) {
    for (const fraction of [0, 0.5, 1]) {
      const args = [from.id, from.length * fraction, to.id, to.length * (1 - fraction)] as const;
      assert.deepEqual(roads.route(...args), linearRoute(roads, ...args), args.join(','));
    }
  }
});

test('stable heap and goal pruning reproduce the old router across varied directed graphs', () => {
  let seed = 20261022;
  const random = (): number => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  for (let sample = 0; sample < 30; sample++) {
    const count = 5 + Math.floor(random() * 55);
    const lengths = Array.from({ length: count }, () => Math.floor(random() * 6));
    const edges: [number, number, number][] = [];
    for (let i = 0; i < count * 5; i++) edges.push([Math.floor(random() * count), Math.floor(random() * count), Math.floor(random() * 4)]);
    const roads = new RoadIndex(graph(lengths, edges));
    for (let q = 0; q < 160; q++) {
      const from = Math.floor(random() * count), to = q % 5 ? Math.floor(random() * count) : from;
      const args = [`l${from}`, lengths[from]! * random(), `l${to}`, lengths[to]! * random()] as const;
      assert.deepEqual(roads.route(...args), linearRoute(roads, ...args), `graph ${sample}, query ${q}: ${args.join(',')}`);
    }
  }
});

test('a nearby goal does not expand the city beyond its settled shortest path', () => {
  const count = 2000, edges: [number, number, number][] = [[0, 1, 0]];
  for (let i = 2; i < count; i++) edges.push([0, i, i]);
  const roads = new RoadIndex(graph(Array(count).fill(1), edges));
  const get = roads.outgoing.get.bind(roads.outgoing);
  let expanded = 0;
  roads.outgoing.get = id => { expanded++; return get(id); };
  assert.deepEqual(roads.route('l0', 0, 'l1', 0.5), ['l0', 'c0', 'l1']);
  assert.equal(expanded, 1, 'only the start lane needs expansion');
});

const worldRoot = process.env.HELSINKI_ROUTE_WORLD;
test('optional deployed road graph preserves native routes and reports planning timings', { skip: !worldRoot }, () => {
  const root = path.resolve(worldRoot!), manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const stored = readFileSync(path.join(root, manifest.roads.path));
  const roads = new RoadIndex(JSON.parse((manifest.roads.compression === 'gzip' ? gunzipSync(stored) : stored).toString()));
  const queries: (readonly [string, number, string, number])[] = [];
  // Nearby response routes in separated districts, plus long routes and same-lane backward trips.
  for (const [x, z] of [[0, 0], [-350, 260], [-850, -500], [-280, -1250], [-1050, 670], [630, -2150]]) {
    const target = roads.nearestLane(x!, z!, undefined, 150);
    if (!target) continue;
    for (let i = 0; i < 16; i++) {
      const angle = i * Math.PI / 8;
      const from = roads.nearestLane(x! + Math.sin(angle) * 120, z! + Math.cos(angle) * 120, undefined, 70);
      if (from) queries.push([from.laneId, from.s, target.laneId, target.s]);
    }
  }
  for (let i = 0; i < 32; i++) {
    const from = roads.graph.lanes[Math.floor(i * roads.graph.lanes.length / 32)]!;
    const to = roads.graph.lanes[(Math.floor(i * roads.graph.lanes.length / 32) + 1234) % roads.graph.lanes.length]!;
    queries.push([from.id, from.length * 0.75, to.id, to.length * 0.25], [from.id, from.length * 0.75, from.id, from.length * 0.25]);
  }
  const oldMs: number[] = [], newMs: number[] = [];
  for (const args of queries) {
    let start = performance.now();
    const previous = linearRoute(roads, ...args); oldMs.push(performance.now() - start);
    start = performance.now();
    const current = roads.route(...args); newMs.push(performance.now() - start);
    assert.deepEqual(current, previous, args.join(','));
  }
  const summary = (times: number[]) => {
    const sorted = [...times].sort((a, b) => a - b);
    return { total: times.reduce((a, b) => a + b, 0), median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor(sorted.length * 0.95)], max: sorted.at(-1) };
  };
  console.log(JSON.stringify({ lanes: roads.graph.lanes.length, connectors: roads.graph.connectors.length, equivalentRoutes: queries.length, beforeMs: summary(oldMs), afterMs: summary(newMs) }));
});
