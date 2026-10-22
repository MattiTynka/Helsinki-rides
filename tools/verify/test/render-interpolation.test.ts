import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { SimState, StaticWorld, VehicleState } from '../../../packages/sim/src/index.ts';
import { interpolateState } from '../../../apps/game/src/render/interpolation.ts';
import { ChaseCamera } from '../../../apps/game/src/render/camera.ts';

const entry = createRequire(new URL('../../../apps/game/package.json', import.meta.url)).resolve('three');
const THREE = await import(new URL('./three.module.js', pathToFileURL(entry)).href);

function snapshot(tick: number): SimState {
  const position: [number, number, number] = [tick * .1, 0, 0];
  const actor = { id: 'player', position, yaw: 0, clip: 'run', speed: 6, alive: true, inVehicle: null, health: 100, aiming: false, grounded: true, jumpPhase: 'grounded', jumpKind: null, verticalSpeed: 0, jumpPhaseTime: 0, groundDistance: 0, landingSpeed: 0, climb: null };
  return { tick, time: tick / 60, player: { ...actor, mode: 'onFoot', pitch: 0 }, characters: [{ ...actor, id: 'officer' }], vehicles: [{ id: 'car', definition: 'car', position: [tick * .4, 0, 0], rotation: [0, 0, 0, 1], speed: 24, forwardSpeed: 24, steerAngle: 0, wheels: [{ position: [0, .3, 0], rotation: 0, steer: 0 }] }], shots: [], events: [], police: [] } as unknown as SimState;
}

test('player, NPC, car and wheels share one interpolated instant without mutating simulation state', () => {
  const before = snapshot(1), after = snapshot(2), frozen = JSON.stringify([before, after]);
  const frame = interpolateState(before, after, .25);
  assert.ok(Math.abs(frame.player.position[0] - .125) < 1e-12);
  assert.equal(frame.characters[0]!.position[0], frame.player.position[0]);
  assert.equal(frame.vehicles[0]!.position[0], .5);
  assert.equal(frame.time, 1.25 / 60);
  assert.equal(frame.tick, after.tick, 'discrete events and tick remain current');
  assert.equal(frame.shots, after.shots);
  assert.equal(JSON.stringify([before, after]), frozen);
});

test('terminal collapse age shares the displayed instant without interpolating across lethal damage', () => {
  const previous = snapshot(1), current = snapshot(2);
  const before: SimState = { ...previous, characters: [{ ...previous.characters[0]!, alive: false, clip: 'death', deathElapsed: .7 }] };
  const after: SimState = { ...current, characters: [{ ...current.characters[0]!, alive: false, clip: 'death', deathElapsed: .7 + 1 / 60 }] };
  assert.ok(Math.abs(interpolateState(before, after, .5).characters[0]!.deathElapsed! - (.7 + 1 / 120)) < 1e-12);
  const living: SimState = { ...before, characters: [{ ...before.characters[0]!, alive: true, clip: 'walk', deathElapsed: 0 }] };
  assert.equal(interpolateState(living, after, .5).characters[0], after.characters[0], 'new lethal state is displayed immediately');
});

test('60 Hz simulation produces continuous translation at 120 and 144 Hz display rates', () => {
  for (const rate of [120, 144]) {
    let previous = 0, rawPrevious = 0, plateaus = 0;
    for (let frame = rate; frame < rate * 2; frame++) {
      const wallTicks = frame / rate * 60, tick = Math.floor(wallTicks);
      const state = interpolateState(snapshot(tick - 1), snapshot(tick), wallTicks - tick);
      if (frame > rate) {
        assert.ok(Math.abs(state.player.position[0] - previous - 6 / rate) < 1e-12);
        if (snapshot(tick).player.position[0] === rawPrevious) plateaus++;
      }
      previous = state.player.position[0]; rawPrevious = snapshot(tick).player.position[0];
    }
    assert.ok(plateaus > rate / 3, 'old zero-order presentation repeats transforms on high refresh displays');
  }
});

test('actual walking and driving camera translation loses the 60 Hz velocity ripple at 144 Hz', () => {
  const world = { physics: { castRay: () => null } } as unknown as StaticWorld;
  for (const driving of [false, true]) {
    const raw = new ChaseCamera(new THREE.PerspectiveCamera()), smooth = new ChaseCamera(new THREE.PerspectiveCamera());
    const velocity = { raw: [] as number[], smooth: [] as number[] };
    let rawX = 0, smoothX = 0;
    const state = (tick: number): SimState => {
      const value = snapshot(tick);
      return driving ? { ...value, player: { ...value.player, mode: 'driving', inVehicle: 'car', position: value.vehicles[0]!.position } } : value;
    };
    for (let frame = 1; frame <= 144 * 6; frame++) {
      const wallTicks = frame / 144 * 60, tick = Math.floor(wallTicks), current = state(tick);
      const chase = driving ? [0, 2.3, -7.5] as const : null;
      raw.update(current, world, chase, 1 / 144);
      smooth.update(interpolateState(state(tick - 1), current, wallTicks - tick), world, chase, 1 / 144);
      if (frame > 144 * 5) {
        velocity.raw.push((raw.camera.position.x - rawX) * 144);
        velocity.smooth.push((smooth.camera.position.x - smoothX) * 144);
      }
      rawX = raw.camera.position.x; smoothX = smooth.camera.position.x;
    }
    const ripple = (samples: number[]) => Math.max(...samples) - Math.min(...samples);
    assert.ok(ripple(velocity.raw) > 1, 'original state staircase modulates the real chase camera velocity');
    assert.ok(ripple(velocity.smooth) < 1e-8, `${driving ? 'driving' : 'walking'} interpolated camera stays uniform`);
  }
});

test('yaw, chassis quaternion and wheel rotation cross wrap boundaries by the shortest arc', () => {
  const before = snapshot(1), after = snapshot(2), radians = Math.PI / 180;
  const vehicle = (state: SimState, yaw: number): VehicleState => ({ ...state.vehicles[0]!, rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)], wheels: [{ position: [0, .3, 0], rotation: yaw, steer: 0, contact: true }] });
  const a = { ...before, player: { ...before.player, yaw: 179 * radians }, vehicles: [vehicle(before, 179 * radians)] };
  const b = { ...after, player: { ...after.player, yaw: -179 * radians }, vehicles: [vehicle(after, -179 * radians)] };
  const frame = interpolateState(a, b, .5);
  assert.ok(Math.abs(frame.player.yaw - Math.PI) < 1e-12);
  assert.ok(Math.abs(frame.vehicles[0]!.wheels[0]!.rotation - Math.PI) < 1e-12);
  assert.ok(Math.abs(frame.vehicles[0]!.rotation[1] - 1) < 1e-12);
  assert.ok(Math.abs(Math.hypot(...frame.vehicles[0]!.rotation) - 1) < 1e-12);
});

test('resets, teleports, vehicle transitions and new entities never interpolate from stale transforms', () => {
  const before = snapshot(1), after = snapshot(2);
  for (const changed of [snapshot(0), snapshot(4), { ...after, player: { ...after.player, position: [100, 0, 0] as [number, number, number] } }, { ...after, player: { ...after.player, mode: 'driving' as const, inVehicle: 'car' } }]) assert.equal(interpolateState(before, changed, .1), changed);
  const newVehicle = { ...after.vehicles[0]!, id: 'new' };
  assert.equal(interpolateState(before, { ...after, vehicles: [newVehicle] }, .1).vehicles[0], newVehicle);
  const recovered = { ...after.vehicles[0]!, position: [20, 0, 0] as [number, number, number] };
  assert.equal(interpolateState(before, { ...after, vehicles: [recovered] }, .1).vehicles[0], recovered);
});

test('airborne pose measurements share the presentation clock, without blending across jump phase changes', () => {
  const before = snapshot(1), after = snapshot(2);
  const a = { ...before, player: { ...before.player, jumpPhase: 'rise' as const, jumpKind: 'normal' as const, verticalSpeed: 6, groundDistance: 1, jumpPhaseTime: .1 } };
  const b = { ...after, player: { ...after.player, jumpPhase: 'rise' as const, jumpKind: 'normal' as const, verticalSpeed: 5, groundDistance: 1.2, jumpPhaseTime: .2 } };
  const p = interpolateState(a, b, .25).player;
  assert.equal(p.verticalSpeed, 5.75); assert.equal(p.groundDistance, 1.05); assert.equal(p.jumpPhaseTime, .125);
  const changed = { ...b, player: { ...b.player, jumpPhase: 'fall' as const, jumpPhaseTime: 0, groundDistance: null } };
  const next = interpolateState(a, changed, .25).player;
  assert.equal(next.jumpPhaseTime, 0); assert.equal(next.groundDistance, null);
});

test('vehicle body and door sample one interpolated interaction clock without crossing phase boundaries', () => {
  const before = snapshot(1), after = snapshot(2);
  const interaction = { vehicleId: 'car', stage: 'enter' as const, progress: .4, clip: 'enter' as const, side: 'driver' as const, startOffset: [0, 0, 0] as const };
  const a = { ...before, player: { ...before.player, mode: 'entering' as const, vehicleInteraction: interaction } };
  const b = { ...after, player: { ...after.player, mode: 'entering' as const, vehicleInteraction: { ...interaction, progress: .5 } } };
  assert.equal(interpolateState(a, b, .5).player.vehicleInteraction?.progress, .45);
  const nextPhase = { ...b, player: { ...b.player, vehicleInteraction: { ...interaction, stage: 'exit' as const, progress: 0 } } };
  assert.equal(interpolateState(a, nextPhase, .5).player.vehicleInteraction?.progress, 0);
});
