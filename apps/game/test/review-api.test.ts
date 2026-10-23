import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Game } from '../src/game.ts';
import { installTestApi } from '../src/testapi.ts';

test('residentCells() reports the sorted resident ids of both visual streams through the review API', () => {
  const stream = (ids: string[]) => ({ residentIds: () => ids.slice() });
  const game = { data: { release: 'fixture' }, streaming: { detail: stream(['c_p01_p00', 'c_m01_p00', 'c_p00_p00']), fallback: stream(['c_p02_p00', 'c_m02_m01']) } };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: {}, configurable: true, writable: true });
  try {
    const api = installTestApi(game as unknown as Game, () => {});
    assert.deepEqual(api.residentCells(), { detail: ['c_m01_p00', 'c_p00_p00', 'c_p01_p00'], fallback: ['c_m02_m01', 'c_p02_p00'] });
    const unstreamed = installTestApi({ ...game, streaming: null } as unknown as Game, () => {});
    assert.equal(unstreamed.residentCells(), null, 'pilot worlds without streaming have no stream residency');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('config() reports the configured resolution floor, not an observed scale', () => {
  const game = {
    data: { release: 'fixture' }, streaming: null, stats: { tier: 'low' }, loader: { mipDrop: 0 },
    config: { preset: 'low', presetSource: 'url', startTier: 'low', rememberedTier: null, dynamicResolution: true, mobile: false, mipDrop: null },
    scene: { resolutionFloor: .5, resolutionScale: 1 },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: {}, configurable: true, writable: true });
  try {
    const api = installTestApi(game as unknown as Game, () => {});
    assert.equal(api.config().resolutionFloor, .5, 'the floor is configured even while the scale is still 1');
    const phone = installTestApi({ ...game, scene: { resolutionFloor: .6, resolutionScale: .8 } } as unknown as Game, () => {});
    assert.equal(phone.config().resolutionFloor, .6);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window');
  }
});
