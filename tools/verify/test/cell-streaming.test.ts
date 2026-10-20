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

test('startup waits for nearby coverage while a selected outer cell is still decoding', async () => {
  const distant = deferred<CellResource>(), near = cell('near', 0), outer = cell('outer', 256);
  const shown: string[] = [];
  const stream = new CellVisualStream([near, outer], {
    load: c => c.id === 'near' ? Promise.resolve(resource()) : distant.promise,
    show: c => { shown.push(c.id); }, dispose: () => {},
  }, { ...options, radius: 500, concurrency: 2 });
  stream.update(focus(64));
  await stream.settleNear(100);
  assert.deepEqual(shown, ['near']); assert.equal(stream.stats().pendingCells, 1);
  distant.resolve(resource()); await stream.settle();
  assert.deepEqual(shown, ['near', 'outer']);
  await assert.rejects(stream.settleNear(-1), /radius/);
  stream.dispose();
});

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
  assert.equal(stream.stats().cancelledLoads, 1);
  assert.equal(stream.stats().failedLoads, 0);
});

test('leaving a district aborts its download and immediately reuses the settled slot without a failure cooldown', async () => {
  const requests: string[] = [], signals: AbortSignal[] = [], shown: string[] = [];
  const stream = new CellVisualStream([cell('a', 0), cell('b', 1000)], {
    load: (cell, signal) => {
      requests.push(cell.id); signals.push(signal);
      if (cell.id === 'a' && requests.length === 1) return new Promise<CellResource>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return Promise.resolve(resource());
    },
    show: cell => { shown.push(cell.id); }, dispose: () => {},
  }, options);
  stream.update(focus(64)); stream.update(focus(1064));
  assert.equal(signals[0]!.aborted, true);
  await stream.settle();
  assert.deepEqual(requests, ['a', 'b']); assert.deepEqual(shown, ['b']);
  assert.equal(stream.stats().cancelledLoads, 1); assert.equal(stream.stats().failedLoads, 0);
  assert.deepEqual(stream.stats().errors, []); assert.deepEqual(stream.stats().errorHistory, []);
  stream.update(focus(64)); await stream.settle();
  assert.deepEqual(requests, ['a', 'b', 'a'], 'the cancelled cell must be reloadable immediately when revisited');
  assert.deepEqual(shown, ['b', 'a']);
});

test('cancelled uninterruptible decoding retains its concurrency slot and never mounts after returning to the same cell', async () => {
  const old = deferred<CellResource>(), requests: string[] = [], shown: CellResource[] = [], disposed: CellResource[] = [];
  const stale = resource(9), current = resource(10);
  const stream = new CellVisualStream([cell('a', 0), cell('b', 1000)], {
    load: cell => { requests.push(cell.id); return requests.length === 1 ? old.promise : Promise.resolve(current); },
    show: (_cell, value) => { shown.push(value); }, dispose: (_cell, value) => { disposed.push(value); },
  }, options);
  stream.update(focus(64)); stream.update(focus(1064)); stream.update(focus(64));
  assert.deepEqual(requests, ['a'], 'a worker which cannot abort still holds the only physical slot');
  assert.equal(stream.stats().pendingCells, 1); assert.equal(stream.stats().cancelledLoads, 1);
  old.resolve(stale); await stream.settle();
  assert.deepEqual(requests, ['a', 'a']); assert.deepEqual(disposed, [stale]); assert.deepEqual(shown, [current]);
  assert.equal(stream.stats().residentCells, 1); assert.equal(stream.stats().pendingCells, 0);
  assert.equal(stream.stats().staleDisposed, 1); assert.equal(stream.stats().failedLoads, 0);
});

test('rapid travel keeps all aborted decode work inside the physical concurrency bound', async () => {
  const cells = [cell('a', 0), cell('b', 128), cell('c', 1000), cell('d', 1128)];
  const pending = new Map(cells.map(cell => [cell.id, deferred<CellResource>()]));
  let active = 0, peak = 0;
  const requests: string[] = [], shown: string[] = [], disposed: string[] = [];
  const stream = new CellVisualStream(cells, {
    load: cell => {
      requests.push(cell.id); active++; peak = Math.max(peak, active);
      return pending.get(cell.id)!.promise.finally(() => { active--; });
    }, show: cell => { shown.push(cell.id); }, dispose: cell => { disposed.push(cell.id); },
  }, { ...options, concurrency: 2 });
  stream.update(focus(120)); stream.update(focus(1120));
  assert.deepEqual(requests, ['a', 'b']); assert.equal(stream.stats().cancelledLoads, 2);
  pending.get('a')!.resolve(resource()); pending.get('b')!.resolve(resource());
  pending.get('c')!.resolve(resource()); pending.get('d')!.resolve(resource());
  await stream.settle();
  assert.equal(peak, 2); assert.equal(active, 0);
  assert.deepEqual(requests, ['a', 'b', 'c', 'd']);
  assert.deepEqual(shown.sort(), ['c', 'd']); assert.deepEqual(disposed.sort(), ['a', 'b']);
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
  assert.equal(stream.stats().cancelledLoads, 0, 'a completed decode rejected by its measured cost is not a cancelled load');
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
  assert.equal(stream.stats().cancelledLoads, 1); assert.equal(stream.stats().failedLoads, 0);
});

test('disposing during an abortable retry stops downloads with no extra failures or subsequent work', async () => {
  let attempts = 0, now = 0, signal: AbortSignal | undefined;
  const stream = new CellVisualStream([cell('a', 0)], {
    load: (_cell, incoming) => {
      if (++attempts === 1) return Promise.reject(new Error('first attempt failed'));
      signal = incoming;
      return new Promise<CellResource>((_resolve, reject) => incoming.addEventListener('abort', () => reject(incoming.reason), { once: true }));
    }, show: () => assert.fail('no request completed'), dispose: () => assert.fail('no resources were allocated'),
  }, { ...options, now: () => now });
  stream.update(focus(64)); await stream.settle();
  now = 3001; stream.update(focus(64));
  stream.dispose(); stream.dispose(); await stream.settle();
  now = 9000; stream.update(focus(64)); await stream.settle();
  assert.equal(signal!.aborted, true); assert.equal(attempts, 2);
  assert.equal(stream.stats().pendingCells, 0); assert.equal(stream.stats().failedLoads, 1);
  assert.equal(stream.stats().cancelledLoads, 1); assert.deepEqual(stream.stats().errors, []);
  assert.deepEqual(stream.stats().errorHistory, ['a: first attempt failed']);
});

const flushTasks = () => new Promise<void>(resolve => setImmediate(resolve));

test('GPU preparation reserves actual costs before uploads and simultaneous decodes cannot over-admit', async () => {
  const warm = deferred<void>(), prepared: string[] = [], shown: string[] = [], disposed: string[] = [];
  const stream: CellVisualStream<CellResource> = new CellVisualStream([cell('a', 0), cell('b', 128)], {
    load: async () => resource(24),
    prepare: async c => {
      prepared.push(c.id);
      assert.equal(stream.stats().residentTextureMiB, 24, 'the upload already owns its complete reservation');
      assert.equal(stream.stats().residentCells, 0, 'a reservation is not visible ground coverage');
      await warm.promise;
    },
    show: c => { shown.push(c.id); }, dispose: c => { disposed.push(c.id); },
  }, { ...options, concurrency: 2 });
  stream.update(focus(120)); await flushTasks();
  assert.deepEqual(prepared, ['a']); assert.deepEqual(shown, []); assert.deepEqual(disposed, ['b']);
  assert.equal(stream.stats().residentTextureMiB, 24); assert.ok(stream.stats().peakTextureMiB <= 30);
  warm.resolve(); await stream.settle();
  assert.deepEqual(shown, ['a']); assert.equal(stream.stats().residentCells, 1);
  stream.dispose(); assert.deepEqual(disposed, ['b', 'a']); assert.equal(stream.stats().residentTextureMiB, 0);
});

test('GPU preparation also reserves geometry and startup coverage waits until preparation completes', async () => {
  const warm = deferred<void>(), prepared: string[] = [], shown: string[] = [];
  const stream = new CellVisualStream([cell('a', 0), cell('b', 128)], {
    load: async () => ({ textureBytes: 0, geometryBytes: 0.6 * MiB }),
    prepare: async c => { prepared.push(c.id); await warm.promise; },
    show: c => { shown.push(c.id); }, dispose: () => {},
  }, { ...options, concurrency: 2 });
  stream.update(focus(120));
  let ready = false;
  const startup = stream.settleNear(100).then(() => { ready = true; });
  await flushTasks();
  assert.deepEqual(prepared, ['a']); assert.deepEqual(shown, []); assert.equal(ready, false);
  assert.equal(stream.stats().residentCells, 0); assert.equal(stream.stats().residentGeometryMiB, 0.6);
  warm.resolve(); await startup; await stream.settle();
  assert.equal(ready, true); assert.deepEqual(shown, ['a']);
  stream.dispose(); assert.equal(stream.stats().residentGeometryMiB, 0);
});

test('travel cancels preparation and holds its reservation until late GPU work settles before admitting the next district', async () => {
  const warm = deferred<void>(), prepared: string[] = [], shown: string[] = [], disposed: string[] = [], loaded: string[] = [];
  const signals = new Map<string, AbortSignal>();
  const stream: CellVisualStream<CellResource> = new CellVisualStream([cell('a', 0), cell('b', 1000)], {
    load: async c => { loaded.push(c.id); return resource(24); },
    prepare: async (c, _resource, signal) => {
      prepared.push(c.id); signals.set(c.id, signal);
      assert.ok(stream.stats().residentTextureMiB <= 30);
      if (c.id === 'a') await warm.promise;
    },
    show: c => { shown.push(c.id); }, dispose: c => { disposed.push(c.id); },
  }, { ...options, concurrency: 2 });
  stream.update(focus(64)); await flushTasks();
  stream.update(focus(1064)); await flushTasks();
  assert.equal(signals.get('a')!.aborted, true);
  assert.deepEqual(loaded, ['a', 'b']); assert.deepEqual(prepared, ['a']);
  assert.deepEqual(disposed, []); assert.deepEqual(shown, []);
  assert.equal(stream.stats().residentTextureMiB, 24, 'cancelled preparation still owns its allocated GPU resources');
  warm.resolve(); await stream.settle();
  assert.deepEqual(loaded, ['a', 'b'], 'waiting for retiring reservations must not cause a reload loop');
  assert.deepEqual(prepared, ['a', 'b']); assert.deepEqual(disposed, ['a']); assert.deepEqual(shown, ['b']);
  assert.equal(stream.stats().cancelledLoads, 1); assert.equal(stream.stats().failedLoads, 0);
  stream.dispose(); assert.deepEqual(disposed, ['a', 'b']); assert.equal(stream.stats().residentTextureMiB, 0);
});

test('dispose releases ready cells immediately and retains cancelled preparation costs until settlement exactly once', async () => {
  const warm = deferred<void>(), disposed: string[] = [], shown: string[] = [];
  const stream = new CellVisualStream([cell('a', 0), cell('b', 128)], {
    load: async () => resource(10),
    prepare: async c => { if (c.id === 'b') await warm.promise; },
    show: c => { shown.push(c.id); }, dispose: c => { disposed.push(c.id); },
  }, { ...options, concurrency: 2 });
  stream.update(focus(120)); await flushTasks();
  assert.deepEqual(shown, ['a']); assert.equal(stream.stats().residentTextureMiB, 20);
  stream.dispose(); stream.dispose();
  assert.deepEqual(disposed, ['a']); assert.equal(stream.stats().residentCells, 0);
  assert.equal(stream.stats().residentTextureMiB, 10);
  warm.reject(new Error('cancelled upload')); await stream.settle();
  assert.deepEqual(disposed, ['a', 'b']); assert.equal(stream.stats().residentTextureMiB, 0);
  assert.equal(stream.stats().residentGeometryMiB, 0); assert.equal(stream.stats().failedLoads, 0);
  stream.dispose(); assert.deepEqual(disposed, ['a', 'b']);
});

test('preparation rejection releases its reservation once, preserves fallback and records a retryable failure', async () => {
  const warm = deferred<void>(); let disposed = 0;
  const stream = new CellVisualStream([cell('a', 0)], {
    load: async () => resource(10), prepare: () => warm.promise,
    show: () => assert.fail('failed upload cannot become visible'), dispose: () => { disposed++; },
  }, options);
  stream.update(focus(64)); await flushTasks();
  assert.equal(stream.stats().residentTextureMiB, 10);
  warm.reject(new Error('texture upload failed')); await stream.settle();
  assert.equal(disposed, 1); assert.equal(stream.stats().residentTextureMiB, 0);
  assert.equal(stream.stats().residentGeometryMiB, 0); assert.equal(stream.stats().fallbackCells, 1);
  assert.deepEqual(stream.stats().errors, ['a: texture upload failed']);
  stream.dispose(); assert.equal(disposed, 1);
});

test('a show failure disposes the prepared resource and releases both budgets exactly once', async () => {
  let prepared = 0, disposed = 0;
  const stream = new CellVisualStream([cell('a', 0)], {
    load: async () => resource(10), prepare: async () => { prepared++; },
    show: () => { throw new Error('cannot mount cell'); }, dispose: () => { disposed++; },
  }, options);
  stream.update(focus(64)); await stream.settle();
  assert.equal(prepared, 1); assert.equal(disposed, 1); assert.equal(stream.stats().residentCells, 0);
  assert.equal(stream.stats().residentTextureMiB, 0); assert.equal(stream.stats().residentGeometryMiB, 0);
  assert.deepEqual(stream.stats().errors, ['a: cannot mount cell']);
  stream.dispose(); assert.equal(disposed, 1);
});
