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

function waitingFrameFixture(cause: 'models' | 'collision') {
  let modelsReady = cause !== 'models', collisionReady = cause !== 'collision', characterDt = -1;
  let attempts = 0, steps = 0, message: string | null = null, visualMissing = false;
  const state = { tick: 60, player: { mode: 'onFoot' }, time: 1 } as unknown as SimState;
  const modelMessage = (Game.prototype as unknown as { modelsWaitingMessage(): string | null }).modelsWaitingMessage;
  const context = {
    missingVisualCells: () => visualMissing ? ['missing-coarse'] : [],
    visualLoading: { blocked: false, blockedFrames: 0, blockedSeconds: 0, missingCells: [] as string[] },
    collisionLoading: { blocked: false, blockedFrames: 0, blockedSeconds: 0 },
    modelLoading: { blocked: false, blockedFrames: 0, blockedSeconds: 0, failed: true },
    config: { dynamicResolution: false }, lastNow: 0, paused: false, accumulator: 0,
    presentationAlpha: 0, presentationFrameTime: 0, state, previousState: state, timeScale: 1,
    fpsAcc: 0, fpsFrames: 0, stats: { fps: 0, frameMs: 0 }, sim: { screen: null },
    input: { takeLook: () => [0, 0], gamepadLook: () => [0, 0] },
    cameraRig: { inCar: false, look: () => {} }, stepBlock: null as 'models' | 'collision' | null,
    collisionReady: () => collisionReady, actorModelsReady: () => modelsReady,
    stepTicks: () => {
      attempts++;
      context.stepBlock = !collisionReady ? 'collision' : !modelsReady ? 'models' : null;
      if (context.stepBlock) return 0;
      steps++; return 1;
    },
    syncViews: (_dt: number, animationDt: number) => { characterDt = animationDt; message = modelMessage.call(context as unknown as Game); },
    render: () => {},
  };
  return { context, frame: (now: number) => Game.prototype.frame.call(context as unknown as Game, now),
    ready: (value: boolean) => { if (cause === 'models') modelsReady = value; else collisionReady = value; },
    missingVisuals: (value: boolean) => { visualMissing = value; },
    observed: () => ({ attempts, steps, characterDt, message }),
  };
}

for (const cause of ['models', 'collision'] as const) {
  test(`${cause} waits persist across render frames without a due tick and clear as soon as readiness resolves`, () => {
    const f = waitingFrameFixture(cause), status = cause === 'models' ? f.context.modelLoading : f.context.collisionLoading;
    f.frame(20);
    assert.equal(status.blocked, true); assert.equal(f.observed().attempts, 1); assert.equal(f.observed().steps, 0);
    f.frame(25); f.frame(30);
    assert.equal(f.observed().attempts, 1, 'short render frames do not need another simulation step');
    assert.equal(status.blocked, true, 'waiting must remain visible between fixed-tick attempts');
    assert.equal(status.blockedFrames, 3); assert.equal(f.context.accumulator, 0);
    assert.equal(f.context.presentationAlpha, 1); assert.equal(f.observed().characterDt, 0);
    if (cause === 'models') assert.match(f.observed().message!, /Could not load the police/);
    f.ready(true); f.frame(35);
    assert.equal(status.blocked, false, 'completion clears the wait even before another tick is due');
    assert.equal(f.observed().steps, 0); assert.ok(f.observed().characterDt > 0);
    if (cause === 'models') assert.equal(f.observed().message, null);
    f.frame(55); assert.equal(f.observed().steps, 1, 'simulation resumes without replaying elapsed loading time');
  });
}

test('paused or visually blocked frames do not retain a previous model wait as their active cause', () => {
  const f = waitingFrameFixture('models');
  f.frame(20); assert.equal(f.context.modelLoading.blocked, true);
  f.context.paused = true; f.frame(25);
  assert.equal(f.context.modelLoading.blocked, false); assert.equal(f.observed().characterDt, 0);
  f.context.paused = false; f.frame(45);
  assert.equal(f.context.modelLoading.blocked, true);
  f.missingVisuals(true); f.frame(50);
  assert.equal(f.context.visualLoading.blocked, true); assert.equal(f.context.modelLoading.blocked, false);
  assert.equal(f.observed().attempts, 2); assert.equal(f.observed().steps, 0);
  assert.equal(f.observed().characterDt, 0); assert.equal(f.context.accumulator, 0);
});
