import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright';
import { beginTravelFrames, finishTravelFrames, summarizeTravelIntervals } from '../lib/travel-frames.ts';

test('travel metrics count presentations rather than paced rAF ticks and retain the worst moving position', async () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldRaf = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  let presented = { frameTime: 0, tick: 0, player: { position: [0, 0, 0] } };
  const callbacks: Array<() => void> = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __HELSINKI_GAME__: { presentation: () => presented } } });
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (f: () => void) => callbacks.push(f) });
  const page = { evaluate: async (f: () => unknown) => f() } as unknown as Page;
  try {
    await beginTravelFrames(page);
    callbacks.shift()!();
    presented = { frameTime: 10, tick: 1, player: { position: [0, 0, 0] } }; callbacks.shift()!();
    callbacks.shift()!(); // rAF fired but the game did not present another frame.
    presented = { frameTime: 30, tick: 3, player: { position: [2, 0, 0] } }; callbacks.shift()!();
    presented = { frameTime: 50, tick: 5, player: { position: [2, 0, 0] } }; callbacks.shift()!();
    const result = await finishTravelFrames(page);
    assert.equal(result.status, 'CAPTURED');
    assert.deepEqual(result.rawPresentationIntervalsMs, [10, 20, 20]);
    assert.deepEqual(result.rawMovingPresentationIntervalsMs, [20]);
    assert.deepEqual(result.worstMoving, { milliseconds: 20, tick: 3, position: [2, 0, 0] });
    callbacks.shift()!();
    assert.equal(callbacks.length, 0, 'collector stops after final read');
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (oldRaf) Object.defineProperty(globalThis, 'requestAnimationFrame', oldRaf); else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
  }
});

test('travel percentiles use exact nearest rank and report no measurement for an empty trace', () => {
  assert.deepEqual(summarizeTravelIntervals(Array.from({ length: 100 }, (_, i) => 100 - i)),
    { samples: 100, p50Ms: 50, p95Ms: 95, p99Ms: 99, maximumMs: 100 });
  assert.deepEqual(summarizeTravelIntervals([]), { samples: 0, p50Ms: null, p95Ms: null, p99Ms: null, maximumMs: null });
});
