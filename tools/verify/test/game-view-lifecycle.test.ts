import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { Game } from '../../../apps/game/src/game.ts';
import type { SimState } from '../../../packages/sim/src/index.ts';
import { QualityGovernor, type GovernorFrame } from '../../../apps/game/src/render/quality-governor.ts';
import { AdaptiveResolution } from '../../../apps/game/src/render/frame-pacing.ts';
import { AUTO_TIER_STORAGE_KEY } from '../../../apps/game/src/config.ts';
import { QUALITY_TIERS, tierParameters } from '../../../apps/game/src/render/quality-tiers.ts';

test('a stale vehicle reference cannot interrupt syncViews before the camera, HUD and audio update', () => {
  const calls: string[] = [];
  const state = { player: { inVehicle: 'removed-car', mode: 'driving', weapon: null }, vehicles: [], characters: [], shots: [], time: 1 } as unknown as SimState;
  const context = {
    vehicleViews: new Map(), characterViews: new Map(),
    pendingShots: [],
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
    if (cause === 'models') assert.match(f.observed().message!, /Could not load nearby characters/);
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

function timingFixture(dynamicResolution: boolean) {
  const adapted: number[] = [], fed: GovernorFrame[] = [], applied: string[] = [];
  let steps = 0;
  const state = { tick: 0, player: { mode: 'onFoot' }, time: 1 } as unknown as SimState;
  const context = {
    missingVisualCells: () => [], visualLoading: { blocked: false, blockedFrames: 0, blockedSeconds: 0, missingCells: [] as string[] },
    collisionLoading: { blocked: false, blockedFrames: 0, blockedSeconds: 0 }, modelLoading: { blocked: false, blockedFrames: 0, blockedSeconds: 0 },
    config: { dynamicResolution }, targetFrameRate: 60, lastNow: 0, paused: false, accumulator: 0,
    presentationAlpha: 0, presentationFrameTime: 0, state, previousState: state, timeScale: 1,
    fpsAcc: 0, fpsFrames: 0, lastIntervalMs: 0, lastCpuMs: 0, stats: { fps: 0, frameMs: 0, frameIntervalMs: 0 }, sim: { screen: null },
    input: { takeLook: () => [0, 0], gamepadLook: () => [0, 0] }, cameraRig: { inCar: false, look: () => {} }, stepBlock: null,
    collisionReady: () => true, actorModelsReady: () => true,
    stepTicks: () => { steps++; return 1; },
    scene: { resolutionScale: 1, resolutionAtFloor: true, resolutionAtCeiling: false, adaptResolution: (intervalSeconds: number) => { adapted.push(intervalSeconds); } },
    syncViews: () => {}, render: () => {},
    qualityGovernor: { tier: 'low', decision: null as string | null, feed(frame: GovernorFrame) { fed.push(frame); return this.decision; } },
    applyTier: (tier: string) => { applied.push(tier); },
  };
  return { context, frame: (now: number) => Game.prototype.frame.call(context as unknown as Game, now), adapted, fed, applied, steps: () => steps };
}

test('frame timing reports the real interval below 10 fps and feeds it to the resolution governor', () => {
  const f = timingFixture(true);
  for (let now = 300; now <= 3000; now += 300) f.frame(now);
  assert.ok(Math.abs(f.context.stats.fps - 1000 / 300) < .01, `fps ${f.context.stats.fps}`);
  assert.ok(Math.abs(f.context.stats.frameIntervalMs - 300) < 1e-9);
  assert.deepEqual(f.adapted, Array(10).fill(.3), 'the governor sees 300 ms, not the 100 ms simulation clamp');
  assert.equal(f.steps(), 50, 'the simulation still advances at most 0.1 s and five ticks per frame');
});

test('a slow CPU-bound previous frame limits catch-up to three ticks', () => {
  const cpuBound = timingFixture(false);
  cpuBound.context.lastIntervalMs = 100; cpuBound.context.lastCpuMs = 90;
  cpuBound.frame(100);
  assert.equal(cpuBound.steps(), 3); assert.equal(cpuBound.context.accumulator, 0, 'time beyond the clamp is dropped, not replayed');
  const gpuBound = timingFixture(false);
  gpuBound.context.lastIntervalMs = 100; gpuBound.context.lastCpuMs = 10;
  gpuBound.frame(100);
  assert.equal(gpuBound.steps(), 5);
  assert.ok(cpuBound.context.lastIntervalMs === 100 && cpuBound.context.lastCpuMs >= 0, 'the frame records its own timing for the next decision');
});

function withDocument<T>(value: unknown, run: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value, configurable: true, writable: true });
  try { return run(); } finally { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document'); }
}

test('the quality governor is fed only rendered frames that are not paused, stalled, loading or hidden', () => {
  const live = timingFixture(true);
  live.frame(20); live.frame(70);
  assert.equal(live.fed.length, 2);
  assert.deepEqual(live.fed[1], { intervalMs: 50, cpuMs: live.fed[1]!.cpuMs, renderScale: 1, atFloor: true, atCeiling: false });
  assert.deepEqual(live.applied, [], 'no decision, no tier change');
  live.context.qualityGovernor.decision = 'demote';
  live.frame(120);
  assert.deepEqual(live.applied, ['low'], 'a decision applies the governor tier');

  const off = timingFixture(false); off.frame(50);
  assert.equal(off.fed.length, 0, '?dynres=0 (and review without ?dynres=1) disables both governors');
  const paused = timingFixture(true); paused.context.paused = true; paused.frame(50);
  assert.equal(paused.fed.length, 0, 'paused');
  const loading = timingFixture(true); loading.context.missingVisualCells = () => ['c_p00_p00'] as never[]; loading.frame(50);
  assert.equal(loading.fed.length, 0, 'world loading: missing visual cells');
  for (const block of ['collision', 'models'] as const) {
    const stalled = timingFixture(true);
    (stalled.context as { stepTicks: () => number }).stepTicks = () => { stalled.context.stepBlock = block as never; return 0; };
    stalled.frame(50);
    assert.equal(stalled.fed.length, 0, `stalled on ${block}`);
  }
  const hidden = timingFixture(true);
  withDocument({ hidden: true }, () => hidden.frame(50));
  assert.equal(hidden.fed.length, 0, 'hidden page');
  withDocument({ hidden: false }, () => hidden.frame(100));
  assert.equal(hidden.fed.length, 1);
  assert.equal(hidden.adapted.length, 1, 'the resolution governor is gated the same way');
});

test('the tier governor is fed the scale each frame rendered with: 3 s at the floor precede a demotion (real Game.frame)', () => {
  // WG-GOVERNOR-FLOOR-TIMING-01: with 1000 ms GPU-bound frames the scale reaches its floor at 6 s.
  const f = timingFixture(true);
  let clock = 0;
  const resolution = new AdaptiveResolution({ minRenderScale: .5 });
  const governor = new QualityGovernor({ presetTier: 'standard', targetMs: 1000 / 60, now: () => clock });
  const samples: { at: number; scale: number; tier: string }[] = [];
  Object.assign(f.context, {
    scene: {
      adaptResolution: (intervalSeconds: number, cpuMs: number) => { resolution.update(intervalSeconds, cpuMs); },
      get resolutionScale() { return resolution.scale; }, get resolutionAtFloor() { return resolution.atFloor; }, get resolutionAtCeiling() { return resolution.atCeiling; },
    },
    qualityGovernor: governor,
    applyTier: (tier: string) => { f.applied.push(tier); },
  });
  for (clock = 1000; clock <= 12_000; clock += 1000) { f.frame(clock); samples.push({ at: clock, scale: resolution.scale, tier: governor.tier }); }
  const floorAt = samples.find(s => s.scale === .5)!.at, demotedAt = samples.find(s => s.tier === 'low')!.at;
  assert.equal(floorAt, 6000, JSON.stringify(samples));
  assert.deepEqual(f.applied, ['low']);
  assert.ok(demotedAt - floorAt >= 3000, `demoted ${demotedAt - floorAt} ms after the floor was reached`);
});

function tierFixture(config: Record<string, unknown>) {
  const calls: unknown[][] = [], notices: unknown[][] = [], mipDrops: number[] = [];
  const views = [1, 2].map(id => ({ setDetailRange: (range: number) => calls.push([`view${id}`, range]) }));
  const game = Object.assign(Object.create(Game.prototype), {
    config: { mobile: false, presetSource: 'url', review: false, preset: 'standard', ...config }, stats: { tier: 'standard' },
    scene: { applyTier: (params: unknown) => calls.push(['scene', params]) },
    streaming: { detail: { setOptions: (o: unknown) => calls.push(['detail', o]) }, fallback: { setOptions: (o: unknown) => calls.push(['fallback', o]) } },
    vehicleViews: new Map(views.map((v, k) => [`car${k}`, v])), vehicleDetailRange: 60, tierMemoryTimer: null,
    loader: { setMipDrop: (n: number) => mipDrops.push(n) },
    hud: { showNotice: (key: string, time: number, seconds: number) => notices.push([key, time, seconds]) }, state: { time: 12 },
  }) as Game & { vehicleDetailRange: number };
  return { game, calls, notices, mipDrops };
}

test('applyTier applies the tier to the scene, both streams and every existing vehicle, and notes demotions only', () => {
  const { game, calls, notices } = tierFixture({});
  const MiB = 2 ** 20;
  game.applyTier('low');
  assert.deepEqual(calls, [
    ['scene', QUALITY_TIERS.low],
    ['detail', { radius: 170, maxCells: 16, geometryBudgetBytes: 96 * MiB }],
    ['fallback', { radius: 300, maxCells: 28, geometryBudgetBytes: 64 * MiB }],
    ['view1', 30], ['view2', 30],
  ]);
  assert.equal(game.vehicleDetailRange, 30, 'new vehicle views use the new range');
  assert.equal(game.stats.tier, 'low');
  assert.deepEqual(notices, [['quality.lowered', 12, 4]]);
  game.applyTier('minimal');
  assert.equal(notices.length, 2);
  game.applyTier('standard');
  assert.equal(notices.length, 2, 'no note on promotion');
  assert.equal(game.stats.tier, 'standard'); assert.equal(game.vehicleDetailRange, 60);
  const mobile = tierFixture({ mobile: true, preset: 'low' });
  mobile.game.stats.tier = 'low';
  mobile.game.applyTier('minimal');
  assert.deepEqual(mobile.calls[0], ['scene', tierParameters('minimal', true)]);
  assert.deepEqual(mobile.calls[1], ['detail', { radius: 110, maxCells: 10, geometryBudgetBytes: 64 * MiB }], 'mobile never widens beyond its own numbers');
});

test('applyTier sets the tier mip drop for later texture loads unless ?mipdrop overrides it', () => {
  const { game, mipDrops } = tierFixture({ mipDrop: null });
  game.applyTier('low'); game.applyTier('minimal'); game.applyTier('low'); game.applyTier('standard');
  assert.deepEqual(mipDrops, [0, 1, 0, 0]);
  for (const mipDrop of [0, 1] as const) {
    const pinned = tierFixture({ mipDrop });
    pinned.game.applyTier('minimal'); pinned.game.applyTier('standard');
    assert.deepEqual(pinned.mipDrops, [mipDrop, mipDrop], `?mipdrop=${mipDrop}`);
  }
});

function memoryStorage() {
  const values = new Map<string, string>();
  return { values, storage: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); }, removeItem: (k: string) => { values.delete(k); } } };
}
function withStorage<T>(storage: unknown, run: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  try { return run(); } finally { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage'); }
}

test('an automatic demotion is remembered 60 s after it while still in force, on pagehide, and cleared on promotion', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const { values, storage } = memoryStorage();
  try {
    withStorage(storage, () => {
      const { game } = tierFixture({ presetSource: 'auto' });
      game.applyTier('low');
      mock.timers.tick(59_000);
      assert.equal(values.get(AUTO_TIER_STORAGE_KEY), undefined, 'not before 60 s');
      mock.timers.tick(1_000);
      assert.equal(values.get(AUTO_TIER_STORAGE_KEY), 'low');
      game.applyTier('minimal'); mock.timers.tick(60_000);
      assert.equal(values.get(AUTO_TIER_STORAGE_KEY), 'minimal');
      game.applyTier('low');
      game.applyTier('standard');
      assert.equal(values.has(AUTO_TIER_STORAGE_KEY), false, 'promotion back to the preset tier clears it');
      mock.timers.tick(120_000);
      assert.equal(values.has(AUTO_TIER_STORAGE_KEY), false, 'the cancelled write never lands');
      game.applyTier('low');
      game.rememberTier();
      assert.equal(values.get(AUTO_TIER_STORAGE_KEY), 'low', 'pagehide writes a demotion in force at once');
      values.clear();
      game.applyTier('standard'); game.rememberTier();
      assert.equal(values.has(AUTO_TIER_STORAGE_KEY), false, 'nothing to remember without a demotion');

      for (const config of [{ presetSource: 'saved' }, { presetSource: 'url' }, { presetSource: 'auto', review: true }]) {
        const other = tierFixture(config).game;
        other.applyTier('low'); mock.timers.tick(60_000); other.rememberTier();
        assert.equal(values.has(AUTO_TIER_STORAGE_KEY), false, JSON.stringify(config));
      }
    });
    const failing = tierFixture({ presetSource: 'auto' }).game;
    withStorage({ getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } }, () => {
      assert.doesNotThrow(() => { failing.applyTier('low'); mock.timers.tick(60_000); failing.rememberTier(); failing.applyTier('standard'); });
    });
  } finally { mock.timers.reset(); }
});

test('a session started from a remembered tier writes low on promotion to the preset tier; estimate sessions clear it', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const { values, storage } = memoryStorage();
  try {
    withStorage(storage, () => {
      values.set(AUTO_TIER_STORAGE_KEY, 'minimal');
      const remembered = tierFixture({ presetSource: 'auto', preset: 'low', rememberedTier: 'minimal' }).game;
      remembered.stats.tier = 'minimal';
      remembered.applyTier('low');
      assert.equal(values.get(AUTO_TIER_STORAGE_KEY), 'low', 'recovered to low: the next visit starts at low, not at a fresh estimate');
      mock.timers.tick(120_000); remembered.rememberTier();
      assert.equal(values.get(AUTO_TIER_STORAGE_KEY), 'low', 'nothing later clears or overwrites it');

      values.set(AUTO_TIER_STORAGE_KEY, 'minimal');
      const estimated = tierFixture({ presetSource: 'auto', preset: 'low', rememberedTier: null }).game;
      estimated.applyTier('minimal'); estimated.applyTier('low');
      assert.equal(values.has(AUTO_TIER_STORAGE_KEY), false, 'an estimate-sourced session clears on promotion to its preset tier');

      for (const presetSource of ['url', 'saved']) {
        values.clear();
        const chosen = tierFixture({ presetSource, preset: 'low', rememberedTier: null }).game;
        chosen.stats.tier = 'low';
        chosen.applyTier('minimal'); mock.timers.tick(60_000); chosen.rememberTier(); chosen.applyTier('low'); chosen.rememberTier();
        assert.equal(values.has(AUTO_TIER_STORAGE_KEY), false, `${presetSource} preset never writes`);
        values.set(AUTO_TIER_STORAGE_KEY, 'minimal');
        chosen.applyTier('minimal'); chosen.applyTier('low');
        assert.equal(values.get(AUTO_TIER_STORAGE_KEY), 'minimal', `${presetSource} preset never clears either`);
      }
    });
  } finally { mock.timers.reset(); }
});
