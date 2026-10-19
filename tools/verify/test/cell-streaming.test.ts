import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CellVisualStream, missingVisualCoverage, selectVisualCells, visualBounds, type CellResource, type CellStreamOptions } from '../../../apps/game/src/world/cell-streaming.ts';
import type { CellDescriptor } from '../../../packages/world-schema/src/index.ts';

const MiB = 2 ** 20;
function cell(id: string, x: number, z = 0, textureMiB = 10): CellDescriptor {
  return { id, cx: x / 128, cz: z / 128, boundsXZ: [x, z, x + 128, z + 128], buildings: [], buildingIds: [], sourceTiles: [],
    visual: { lod0: { path: `${id}.glb`, bytes: 1, sha256: 'hash', triangles: 100, drawCalls: 1, atlases: 1, textureBytesEstimate: textureMiB * MiB },
      lod2: { path: `${id}-coarse.glb`, bytes: 1, sha256: 'hash', triangles: 100, drawCalls: 1, atlases: 0, textureBytesEstimate: 0 } },
    collision: { path: `${id}.hcol`, bytes: 1, sha256: 'hash', triangles: 1 } };
}
const focus = (x: number, velocityX = 0) => ({ x, z: 64, velocityX, velocityZ: 0 });
const options: CellStreamOptions = { textureBudgetBytes: 30 * MiB, geometryBudgetBytes: MiB, radius: 100, lookaheadSeconds: 3, maxLookahead: 180, concurrency: 1 };
const resource = (textureMiB = 10): CellResource => ({ textureBytes: textureMiB * MiB, geometryBytes: 1200 });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('the safety disk checks ground ownership across seams and accepts either loaded visual tier', () => {
  const cells = [cell('west', 0), cell('east', 128)];
  assert.deepEqual(missingVisualCoverage(cells, 120, 64, 12, new Map([['west', {}]]), new Map()), ['east']);
  assert.deepEqual(missingVisualCoverage(cells, 120, 64, 12, new Map([['west', {}]]), new Map([['east', {}]])), []);
  assert.deepEqual(missingVisualCoverage(cells, 100, 64, 12, new Map([['west', {}]]), new Map()), []);
  assert.deepEqual(missingVisualCoverage(cells, 2000, 64, 12, new Map(), new Map()), [], 'out-of-map recovery must be able to step');
});

test('selection follows the entire forward corridor, respects memory and retains crossing-building owners', () => {
  const cells = [-256, -128, 0, 128, 256, 384].map(x => cell(String(x), x));
  const selected = selectVisualCells(cells, focus(64, 60), options, new Map(cells.map(c => [c.id, 10 * MiB])), new Set());
  assert.deepEqual(selected.map(c => c.id), ['0', '128', '256']);
  assert.ok(!selected.some(c => c.id === '-256'));
  const crossing = cell('owner', 256);
  (crossing as unknown as { buildings: unknown[] }).buildings = [{ boundsRuntime: { min: [40, 0, 0], max: [300, 40, 100] } }];
  assert.deepEqual(visualBounds(crossing), [40, 0, 384, 128]);
  assert.equal(selectVisualCells([crossing], focus(64), options, new Map(), new Set()).length, 1);
  const coarse = selectVisualCells(cells, focus(64), { ...options, level: 'lod2', radius: 1000, maxCells: 2 }, new Map(), new Set());
  assert.equal(coarse.length, 2, 'zero texture cost does not mean unlimited geometry/cell residency');
  assert.equal(selectVisualCells([cells[0]!], focus(-200), { ...options, geometryBudgetBytes: 100 }, new Map(), new Set()).length, 0);
});

test('low detail selection uses optional lod1 budgets and falls back to lod0 per cell', () => {
  const optional = cell('reduced-monument', 0, 0, 200), ordinary = cell('ordinary', 128);
  (optional.visual as { lod1?: unknown }).lod1 = { ...optional.visual.lod0, path: 'reduced.glb', triangles: 50, textureBytesEstimate: 40 * MiB };
  assert.deepEqual(selectVisualCells([optional, ordinary], focus(64), { ...options, level: 'lod1' }, new Map(), new Set()).map(c => c.id), ['reduced-monument', 'ordinary']);
  assert.deepEqual(selectVisualCells([optional], focus(64), options, new Map(), new Set()), []);
});

test('late completion after a district change is disposed without showing or evicting the new generation', async () => {
  const a = cell('a', 0), b = cell('b', 1000), requests: string[] = [], shown: string[] = [], disposed: string[] = [];
  const old = deferred<CellResource>();
  const stream = new CellVisualStream([a, b], {
    load: c => { requests.push(c.id); return c.id === 'a' ? old.promise : Promise.resolve(resource()); },
    show: c => { shown.push(c.id); }, dispose: c => { disposed.push(c.id); },
  }, options);
  stream.update(focus(64));
  stream.update(focus(1064));
  old.resolve(resource());
  await stream.settle();
  assert.deepEqual(requests, ['a', 'b']);
  assert.deepEqual(shown, ['b']);
  assert.deepEqual(disposed, ['a']);
  assert.equal(stream.stats().staleDisposed, 1);
  assert.equal(stream.stats().residentCells, 1);
});

test('decoded texture costs control admission, and returning to an evicted district reloads resources', async () => {
  const cells = [cell('a', 0, 0, 20), cell('b', 128, 0, 20), cell('c', 1000, 0, 20)];
  const events: string[] = [], counts = new Map<string, number>();
  const stream = new CellVisualStream(cells, {
    load: c => { counts.set(c.id, (counts.get(c.id) ?? 0) + 1); return Promise.resolve(resource(12)); },
    show: c => { events.push(`show:${c.id}`); }, dispose: c => { events.push(`dispose:${c.id}`); },
  }, options);
  stream.update(focus(120)); await stream.settle();
  assert.equal(stream.stats().residentCells, 2, 'actual device mip size admits the second cell after decode');
  assert.equal(stream.stats().residentTextureMiB, 24);
  stream.update(focus(1064)); await stream.settle();
  assert.ok(events.indexOf('dispose:a') < events.indexOf('show:c'));
  assert.ok(events.indexOf('dispose:b') < events.indexOf('show:c'));
  assert.equal(stream.stats().residentTextureMiB, 12);
  stream.update(focus(120)); await stream.settle();
  assert.equal(counts.get('a'), 2);
  assert.equal(counts.get('b'), 2);
  assert.ok(stream.stats().peakTextureMiB <= 30);
});

test('over-budget decoded resources are disposed and not repeatedly retried', async () => {
  const one = cell('too-big', 0, 0, 1);
  let loads = 0, disposed = 0;
  const stream = new CellVisualStream([one], {
    load: async () => { loads++; return resource(40); }, show: () => assert.fail('must not upload an over-budget cell'), dispose: () => { disposed++; },
  }, options);
  stream.update(focus(64)); await stream.settle();
  stream.update(focus(64)); await stream.settle();
  assert.equal(loads, 1); assert.equal(disposed, 1);
  assert.equal(stream.stats().residentCells, 0);
  assert.deepEqual(stream.stats().missingNearDetail, ['too-big']);
});

test('simultaneous decodes cannot over-admit textures or enter a reload loop after actual costs are known', async () => {
  const pending = new Map([['a', deferred<CellResource>()], ['b', deferred<CellResource>()]]);
  let loads = 0, disposed = 0, mountedBytes = 0, maximumBytes = 0;
  const stream = new CellVisualStream([cell('a', 0), cell('b', 128)], {
    load: cell => { loads++; return pending.get(cell.id)!.promise; },
    show: (_cell, resource) => { mountedBytes += resource.textureBytes; maximumBytes = Math.max(maximumBytes, mountedBytes); },
    dispose: () => { disposed++; },
  }, { ...options, concurrency: 2 });
  stream.update(focus(120));
  assert.equal(loads, 2);
  pending.get('a')!.resolve(resource(24)); pending.get('b')!.resolve(resource(24));
  await stream.settle(); stream.update(focus(120)); await stream.settle();
  assert.equal(loads, 2); assert.equal(disposed, 1); assert.equal(stream.stats().residentCells, 1);
  assert.ok(maximumBytes <= options.textureBudgetBytes);
});

test('failed request keeps fallback available and retries after a bounded delay', async () => {
  let now = 0, attempts = 0;
  const stream = new CellVisualStream([cell('a', 0)], {
    load: async () => { if (++attempts === 1) throw new Error('fixture network failure'); return resource(); }, show: () => {}, dispose: () => {},
  }, { ...options, now: () => now });
  stream.update(focus(64)); await stream.settle();
  assert.equal(stream.stats().failedLoads, 1);
  assert.equal(stream.stats().fallbackCells, 1);
  stream.update(focus(64)); await stream.settle(); assert.equal(attempts, 1);
  now = 3001;
  stream.update(focus(64)); await stream.settle();
  assert.equal(attempts, 2); assert.equal(stream.stats().residentCells, 1); assert.deepEqual(stream.stats().errors, []);
});

test('leaving a failed district clears active HUD errors while retaining diagnostic history', async () => {
  const stream = new CellVisualStream([cell('failed', 0), cell('healthy', 1000)], {
    load: async cell => { if (cell.id === 'failed') throw new Error('404 fixture'); return resource(); }, show: () => {}, dispose: () => {},
  }, options);
  stream.update(focus(64)); await stream.settle();
  assert.deepEqual(stream.stats().errors, ['failed: 404 fixture']);
  stream.update(focus(1064)); await stream.settle();
  assert.deepEqual(stream.stats().errors, []);
  assert.deepEqual(stream.stats().errorHistory, ['failed: 404 fixture']);
  assert.equal(stream.stats().failedLoads, 1);
});

test('disposing a stream invalidates in-flight work and releases resident cells exactly once', async () => {
  const pending = deferred<CellResource>();
  let shown = 0, disposed = 0;
  const stream = new CellVisualStream([cell('a', 0)], { load: () => pending.promise, show: () => { shown++; }, dispose: () => { disposed++; } }, options);
  stream.update(focus(64));
  stream.dispose(); pending.resolve(resource()); await stream.settle();
  stream.dispose();
  assert.equal(shown, 0); assert.equal(disposed, 1); assert.equal(stream.stats().residentTextureMiB, 0);
});
