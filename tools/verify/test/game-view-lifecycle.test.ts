import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game } from '../../../apps/game/src/game.ts';
import type { SimState } from '../../../packages/sim/src/index.ts';

test('a stale vehicle reference cannot interrupt syncViews before the camera, HUD and audio update', () => {
  const calls: string[] = [];
  const state = { player: { inVehicle: 'removed-car', mode: 'driving', weapon: null }, vehicles: [], characters: [], shots: [], time: 1 } as unknown as SimState;
  const context = {
    vehicleViews: new Map(), characterViews: new Map(),
    playerView: { update: () => {}, root: { visible: false } },
    effects: { addShots: () => {}, update: () => {} },
    sim: { definition: () => { throw new Error('must not dereference an absent vehicle'); } },
    cameraRig: { update: (_state: SimState, _world: unknown, chase: unknown) => { assert.equal(chase, null); calls.push('camera'); } },
    hud: { update: () => calls.push('hud') }, audio: { update: () => calls.push('audio') },
  };
  Game.prototype.syncViews.call(context as unknown as Game, 1 / 60, 1 / 60, state);
  assert.deepEqual(calls, ['camera', 'hud', 'audio']);
  assert.equal(context.playerView.root.visible, true, 'show Finn when no vehicle view exists');
});

test('visual loading waits clear accumulated time and do not advance hidden simulation or animation', () => {
  let steps = 0, characterDt = -1;
  const state = { player: { mode: 'onFoot' }, time: 1 } as unknown as SimState;
  const context = {
    missingVisualCells: () => ['missing-coarse'], visualLoading: { blocked: false, blockedFrames: 0, blockedSeconds: 0, missingCells: [] },
    lastNow: 0, paused: false, accumulator: 5, presentationAlpha: 0, presentationFrameTime: 0, state, previousState: state, timeScale: 1,
    fpsAcc: 0, fpsFrames: 0, stats: { fps: 0, frameMs: 0 },
    stepTicks: () => { steps++; }, syncViews: (_dt: number, animationDt: number) => { characterDt = animationDt; }, render: () => {},
  };
  Game.prototype.frame.call(context as unknown as Game, 1000);
  assert.equal(steps, 0); assert.equal(context.accumulator, 0); assert.equal(characterDt, 0);
  assert.equal(context.presentationAlpha, 1);
  assert.equal(context.visualLoading.blockedFrames, 1);
});

test('missing visuals cannot stop death or outside-map recovery ticks', () => {
  const player = { alive: true, mode: 'onFoot', inVehicle: null, position: [60, 0, 60] };
  const context = { streaming: {}, state: { player, vehicles: [] }, scene: { cells: new Map(), fallbackCells: new Map() },
    data: { gameplay: { killHeight: -25, playArea: { minX: 0, maxX: 128, minZ: 0, maxZ: 128 } }, manifest: { cells: [{ id: 'missing', boundsXZ: [0, 0, 128, 128] }] } } };
  const missing = () => Game.prototype.missingVisualCells.call(context as unknown as Game);
  assert.deepEqual(missing(), ['missing']);
  player.alive = false; assert.deepEqual(missing(), []);
  player.alive = true; player.position = [-1, 0, 60]; assert.deepEqual(missing(), []);
  player.position = [60, -30, 60]; assert.deepEqual(missing(), []);
  player.position = [60, 0, 60]; player.mode = 'busted'; assert.deepEqual(missing(), []);
});
