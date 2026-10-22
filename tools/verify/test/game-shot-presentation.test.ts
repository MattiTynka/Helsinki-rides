import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import fs from 'node:fs';
import { Game } from '../../../apps/game/src/game.ts';
import { Effects } from '../../../apps/game/src/render/effects.ts';
import { Button, initPhysics, NEUTRAL, PoliceUnit, Simulation, type SimState, type Shot } from '../../../packages/sim/src/index.ts';
import { encodeCollisionBundle, type GameplayBundle, type RoadGraph } from '../../../packages/world-schema/src/index.ts';

before(initPhysics);
const shot = (shooter: string, n: number): Shot => ({ shooter, origin: [n, 1.4, 0], end: [n, 1.4, 12], hit: null, hitId: null });

function fixture(shotsAt: (tick: number) => Shot[] = tick => tick === 1 ? [shot('player', tick)] : tick === 2 ? [shot('police-1', tick)] : []) {
  let tick = 0;
  const received: Shot[] = [], calls: string[] = [], animationSteps: number[] = [], effectSteps: number[] = [];
  const character = { position: [0, 0, 0], yaw: 0, alive: true, health: 100, clip: 'aim', speed: 0, aiming: true, inVehicle: null, grounded: true, verticalSpeed: 0, groundDistance: 0, jumpPhase: 'grounded', jumpPhaseTime: 0, jumpKind: null, climb: null, landingSpeed: 0 };
  const snapshot = (): SimState => ({ tick, time: tick / 60, shots: tick === 0 ? [] : shotsAt(tick), vehicles: [],
    player: { ...character, id: 'player', mode: 'onFoot', weapon: 'pistol', pitch: 0, vehicleInteraction: null },
    characters: [{ ...character, id: 'police-1' }],
  }) as unknown as SimState;
  const view = (name: string) => ({ root: { visible: true },
    isPresentingShot: () => false,
    update: (_: unknown, dt: number) => { calls.push(`${name}:update`); animationSteps.push(dt); },
    notifyShot: () => calls.push(`${name}:shot`), cancelShot: () => calls.push(`${name}:cancel`), aimAt: () => calls.push(`${name}:aim`),
    dispose: () => calls.push(`${name}:dispose`), muzzlePose: () => false,
  });
  const context = {
    state: snapshot(), previousState: snapshot(), presentationState: snapshot(),
    pendingShots: [] as Shot[], frameEvents: [], commandLog: [], traceLog: [], eventLog: [], captureReplay: false,
    config: { review: false, seed: 7, dynamicResolution: false },
    sim: { screen: null, inventory: { weapon: null }, player: { body: undefined, yaw: 0 },
      step: () => { tick++; return []; }, state: snapshot, collisionSources: () => [] },
    world: { physics: { castRay: () => null } },
    scene: { camera: { position: { x: 0, y: 1.6, z: -3 } } },
    playerView: view('player'), characterViews: new Map([['police-1', view('police')]]), vehicleViews: new Map(),
    effects: { addShots: (shots: readonly Shot[]) => { calls.push('effects:add'); received.push(...shots); },
      update: (dt: number) => { calls.push('effects:update'); effectSteps.push(dt); }, reset: () => calls.push('effects:reset'),
      cancelShooter: (shooter: string) => calls.push(`effects:cancel:${shooter}`) },
    resolveMuzzle: () => false,
    cameraRig: { inCar: false, update: () => calls.push('camera'), look: () => {}, reset: () => calls.push('camera:reset'),
      aimRay: () => ({ origin: [0, 1.6, -2], direction: [0, 0, 1] }) },
    hud: { update: () => calls.push('hud'), setWorldLoading: () => {} }, audio: { update: () => calls.push('audio') },
    modelsWaitingMessage: () => null, actorModelsReady: () => true, collisionReady: () => true,
    handleEvents: () => {}, input: { reset: () => {}, takeLook: () => [0, 0], gamepadLook: () => [0, 0] }, currentCommand: () => NEUTRAL,
    stepTicks: (n: number): number => Game.prototype.stepTicks.call(context as unknown as Game, n, NEUTRAL),
    syncViews: (dt: number, characterDt = dt, state?: SimState): void => Game.prototype.syncViews.call(context as unknown as Game, dt, characterDt, state ?? context.state),
    render: () => calls.push('render'), missingVisualCells: () => [],
    visualLoading: { blocked: false, blockedFrames: 0, blockedSeconds: 0, missingCells: [] },
    collisionLoading: { blocked: false, blockedFrames: 0, blockedSeconds: 0 },
    modelLoading: { blocked: false, blockedFrames: 0, blockedSeconds: 0 },
    lastNow: 0, paused: false, accumulator: 0, presentationAlpha: 0, presentationFrameTime: 0, timeScale: 1,
    fpsAcc: 0, fpsFrames: 0, stats: { fps: 0, frameMs: 0 },
  };
  return { context, received, calls, animationSteps, effectSteps,
    frame: (now: number) => Game.prototype.frame.call(context as unknown as Game, now) };
}

test('all shots from a multi-tick frame present once even when its last tick has no shot', () => {
  const f = fixture(); f.frame(55);
  assert.equal(f.context.state.tick, 3);
  assert.deepEqual(f.context.state.shots, [], 'latest simulation state does not retain earlier shots');
  assert.deepEqual(f.received.map(s => s.shooter), ['player', 'police-1']);
  assert.equal(f.calls.filter(call => call === 'player:shot').length, 1);
  assert.equal(f.calls.filter(call => call === 'police:shot').length, 1);
  assert.ok(f.calls.indexOf('player:shot') < f.calls.indexOf('player:update'));
  assert.ok(f.calls.indexOf('police:shot') < f.calls.indexOf('police:update'));
  assert.ok(f.calls.indexOf('player:aim') < f.calls.indexOf('effects:add'), 'effects resolve the final aimed/recoiling barrel');
  assert.ok(f.calls.indexOf('effects:update') < f.calls.indexOf('effects:add'), 'fresh flashes are not aged away before their first draw');
  assert.equal(f.context.pendingShots.length, 0);
});

test('render-only and paused frames neither replay the last shot nor advance recoil/flash time', () => {
  const f = fixture(); f.context.stepTicks(1); f.context.syncViews(1 / 60);
  assert.equal(f.context.state.shots.length, 1);
  for (let i = 0; i < 5; i++) f.context.syncViews(0, 0);
  assert.equal(f.received.length, 1, 'stale state.shots is not a presentation event source');
  f.context.paused = true; f.frame(1000); f.frame(2000);
  assert.equal(f.context.state.tick, 1); assert.equal(f.received.length, 1);
  assert.equal(f.effectSteps.at(-1), 0); assert.equal(f.animationSteps.at(-1), 0);
  f.context.paused = false; f.frame(2020);
  assert.equal(f.context.state.tick, 2); assert.equal(f.received.length, 2);
  assert.equal(f.calls.filter(call => call === 'player:shot').length, 1);
  assert.equal(f.calls.filter(call => call === 'police:shot').length, 1);
});

test('a partial model/collision wait retains already completed shots and never fabricates the blocked tick', () => {
  for (const cause of ['models', 'collision']) {
    const f = fixture();
    const ready = () => f.context.state.tick < 2;
    if (cause === 'models') f.context.actorModelsReady = ready;
    else Object.assign(f.context, { collision: { update: () => {} }, collisionReady: ready });
    assert.equal(f.context.stepTicks(5), 2);
    f.context.syncViews(.05, 0); f.context.syncViews(.05, 0);
    assert.deepEqual(f.received.map(s => s.shooter), ['player', 'police-1']);
    assert.equal(f.context.stepTicks(1), 0); f.context.syncViews(.05, 0);
    assert.equal(f.received.length, 2);
  }
});

test('long review stepping bounds queued presentation shots and clears the queue on consumption', () => {
  const f = fixture(tick => [shot('player', tick)]);
  f.context.stepTicks(200);
  assert.equal(f.context.pendingShots.length, 64);
  assert.equal(f.context.pendingShots[0]!.origin[0], 137);
  f.context.syncViews(0); f.context.syncViews(0);
  assert.equal(f.received.length, 64); assert.equal(f.context.pendingShots.length, 0);
});

function makeSimulation(): { sim: Simulation; world: ReturnType<typeof Game.buildWorld> } {
  const base = JSON.parse(fs.readFileSync(new URL('../../../content/helsinki/gameplay.json', import.meta.url), 'utf8')) as GameplayBundle;
  const gameplay: GameplayBundle = { ...base, originId: 'shot-test', vehicles: [],
    player: { ...base.player, spawn: { position: [0, 0], headingDeg: 0 } },
    playArea: { minX: -100, maxX: 100, minZ: -100, maxZ: 100 },
    police: { ...base.police, initialPatrols: 0, patrolSpawns: [] },
    wanted: { ...base.wanted, unitCaps: [0, 0, 0, 0, 0] }, anchors: [] };
  const roads: RoadGraph = { schemaVersion: 2, originId: 'shot-test', source: { id: 'test', sha256: 'x', attribution: 'test', license: 'CC0' }, nodes: [], lanes: [], connectors: [], parking: [], footways: [] };
  const nativeGround = encodeCollisionBundle({ originId: 'shot-test', frame: 'X-east,Y-up,Z-south', cell: 'flat', surfaceTags: ['road'] }, [{
    id: 'ground', group: 'ground', ref: null, positions: new Float32Array([-100, 0, -100, 100, 0, -100, 100, 0, 100, -100, 0, 100]),
    indices: new Uint32Array([0, 2, 1, 0, 3, 2]), triangleTags: new Uint16Array([0, 0]),
  }]);
  const data = { terrain: { x0: -100, z0: -100, nx: 21, nz: 21, resolution: 10, heights: new Float32Array(441) }, roads, gameplay, manifest: { cells: [{ id: 'flat' }] }, collision: new Map([['flat', nativeGround]]) };
  const world = Game.buildWorld(data as unknown as Parameters<typeof Game.buildWorld>[0], null);
  return { world, sim: new Simulation(world, { seed: 12 }) };
}

for (const previousFrame of [false, true]) test(`holster/redraw cancels ${previousFrame ? 'already displayed' : 'unrendered'} player fire while a later real shot presents exactly once`, () => {
  const f = fixture(), { world, sim } = makeSimulation(), effects = new Effects();
  const addShots = effects.addShots.bind(effects);
  effects.addShots = (shots, resolver) => { f.received.push(...shots); addShots(shots, resolver); };
  Object.assign(f.context, { sim, state: sim.state(), previousState: sim.state(), world, effects,
    resolveMuzzle: (_: string, position: { set(x: number, y: number, z: number): void }, direction: { set(x: number, y: number, z: number): void }) => {
      position.set(0, 1.4, 0); direction.set(0, 0, 1); return true;
    } });
  const step = (buttons: number, ticks = 1) => Game.prototype.stepTicks.call(f.context as unknown as Game, ticks, { ...NEUTRAL, buttons });
  try {
    step(Button.fire);
    assert.equal(sim.shots.length, 1); assert.equal(sim.inventory.weapon?.magazine, 11);
    if (previousFrame) {
      f.context.syncViews(1 / 60);
      assert.equal(effects.snapshot().flashes.filter(flash => flash.visible).length, 1, 'first shot is actually active before holstering');
    }
    step(Button.holster); step(Button.aim);
    assert.ok(sim.state().player.weapon, 'the final fixed tick has drawn the weapon again');
    assert.equal(sim.wanted.playerHasFired, false); assert.equal(sim.shots.length, 0);
    assert.equal(f.context.pendingShots.length, 0, 'the earlier shot cannot be reattached to the newly drawn weapon');
    assert.equal(f.calls.filter(call => call === 'player:cancel').length, 1);
    assert.equal(effects.snapshot().flashes.some(flash => flash.visible || flash.intensity > 0), false, 'holster cancels an active flash before rendering the redrawn weapon');
    if (previousFrame) assert.equal(effects.snapshot().activeTracers, 1, 'the already emitted ballistic trace is preserved');
    f.context.syncViews(2 / 60); f.context.syncViews(0);
    assert.equal(f.received.length, previousFrame ? 1 : 0, 'redraw alone presents no shot');
    assert.equal(f.calls.filter(call => call === 'player:shot').length, previousFrame ? 1 : 0);
    assert.equal(effects.snapshot().flashes.some(flash => flash.visible), false);
    step(0, 20); step(Button.fire);
    assert.equal(sim.inventory.weapon?.magazine, 10, 'ballistic ammo accounting retains both real shots');
    assert.equal(sim.shots.length, 1); assert.equal(sim.wanted.playerHasFired, true);
    f.context.syncViews(1 / 60); f.context.syncViews(0);
    assert.equal(f.received.length, previousFrame ? 2 : 1);
    assert.equal(f.calls.filter(call => call === 'player:shot').length, previousFrame ? 2 : 1);
    assert.equal(effects.snapshot().flashes.filter(flash => flash.visible).length, 1, 'new post-holster shot gets exactly one flash');
  } finally { effects.dispose(); world.physics.free(); }
});

test('an officer firing then moving in the actual simulation keeps its aimed presentation across a two-tick render frame', () => {
  const f = fixture(), { world, sim } = makeSimulation();
  try {
    const vehicle = sim.spawnVehicle('test-patrol', 'patrol', [70, 70], 0);
    const officer = sim.spawnCharacter('police-1', [20, 0, 0], -Math.PI / 2, 100);
    const unit = new PoliceUnit('test-unit', vehicle, officer, 0); unit.sees = true;
    sim.police.units.push(unit); sim.player.armour = 1000;
    for (let i = 0; i < 3; i++) sim.step(NEUTRAL);
    sim.police.playerSeen = true;
    Object.assign(f.context, { sim, state: sim.state(), previousState: sim.state(), world });
    Game.prototype.stepTicks.call(f.context as unknown as Game, 1, { ...NEUTRAL, buttons: Button.fire });
    assert.equal(unit.officer.clip, 'fire'); assert.ok(unit.officer.speed > 2);
    const emitted = f.context.pendingShots.filter(s => s.shooter === officer.id).length;
    assert.equal(emitted, 1);
    Game.prototype.stepTicks.call(f.context as unknown as Game, 1, NEUTRAL);
    assert.equal(unit.officer.clip, 'aim'); assert.ok(unit.officer.speed > 2);
    assert.equal(sim.shots.length, 0);
    // Vehicle rendering is outside this check; retain the real player/officer/shot state.
    const presentation = { ...f.context.state, vehicles: [] };
    f.context.syncViews(2 / 60, 2 / 60, presentation);
    f.context.syncViews(0, 0, presentation);
    assert.equal(f.received.filter(s => s.shooter === officer.id).length, 1);
    assert.equal(f.calls.filter(call => call === 'police:shot').length, 1);
    assert.equal(f.calls.filter(call => call === 'police:aim').length, 2, 'aim remains applied on the render-only frame between shots');
  } finally { world.physics.free(); }
});

test('resetSimulation clears unsent shots and active flashes before presenting the fresh simulation', () => {
  const f = fixture(); f.context.stepTicks(2);
  const base = JSON.parse(fs.readFileSync(new URL('../../../content/helsinki/gameplay.json', import.meta.url), 'utf8')) as GameplayBundle;
  const gameplay: GameplayBundle = { ...base, originId: 'shot-test', vehicles: [],
    player: { ...base.player, spawn: { position: [0, 0], headingDeg: 0 } },
    playArea: { minX: -100, maxX: 100, minZ: -100, maxZ: 100 },
    police: { ...base.police, initialPatrols: 0, patrolSpawns: [] }, anchors: [] };
  const roads: RoadGraph = { schemaVersion: 2, originId: 'shot-test', source: { id: 'test', sha256: 'x', attribution: 'test', license: 'CC0' }, nodes: [], lanes: [], connectors: [], parking: [], footways: [] };
  const data = { terrain: { x0: -100, z0: -100, nx: 21, nz: 21, resolution: 10, heights: new Float32Array(441) }, roads, gameplay, manifest: { cells: [] }, collision: new Map() };
  Object.assign(f.context, { data, collision: null });
  Game.prototype.resetSimulation.call(f.context as unknown as Game, 7);
  try {
    assert.equal(f.context.state.tick, 0); assert.equal(f.context.pendingShots.length, 0);
    assert.equal(f.received.length, 0); assert.equal(f.calls.filter(call => call.endsWith(':shot')).length, 0);
    assert.ok(f.calls.indexOf('effects:reset') < f.calls.indexOf('player:update'));
    assert.equal(f.context.characterViews.size, 0);
  } finally { (f.context.world as unknown as { physics: { free(): void } }).physics.free(); }
});
