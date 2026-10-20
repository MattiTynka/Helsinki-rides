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
    hud: { update: () => calls.push('hud'), setWorldLoading: () => {} }, audio: { update: () => calls.push('audio') },
    modelsWaitingMessage: () => null,
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
    collisionLoading: { blocked: false, blockedFrames: 0, blockedSeconds: 0 }, modelLoading: { blocked: false, blockedFrames: 0, blockedSeconds: 0 }, config: { dynamicResolution: false },
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

test('deferred officer models follow a moving patrol car instead of the stale boarding position', () => {
  const officer = { id: 'police-1', inVehicle: 'patrol-1' as string | null, position: [0, 0, 0] };
  const vehicle = { id: 'patrol-1', definition: 'patrol', position: [300, 0, 0] };
  let rainLoaded = false;
  const context = {
    sim: { playerPosition: [0, 0, 0], definition: () => ({ assetId: 'vehicle-patrol' }) },
    state: { vehicles: [vehicle], characters: [officer] },
    assets: { hasVehicle: () => true, hasCharacter: () => rainLoaded },
  };
  const ready = () => Game.prototype.actorModelsReady.call(context as unknown as Game);
  assert.equal(ready(), true, 'an absent Rain model must not freeze play beside an abandoned boarding position');
  officer.position = [300, 0, 0]; vehicle.position = [128, 0, 0];
  assert.equal(ready(), false, 'a seated officer arriving within range must wait for Rain even when its boarding position is far away');
  vehicle.position = [129, 0, 0];
  assert.equal(ready(), true, 'the model readiness radius still applies to the moving vehicle');
  officer.inVehicle = null; officer.position = [0, 0, 0];
  assert.equal(ready(), false, 'officers on foot use their own current position');
  rainLoaded = true;
  assert.equal(ready(), true, 'loaded officer models never block readiness');
  rainLoaded = false; officer.inVehicle = 'removed-patrol';
  assert.equal(ready(), false, 'a stale vehicle reference safely falls back to the officer position');
});
