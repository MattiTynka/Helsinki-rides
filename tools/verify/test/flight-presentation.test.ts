import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Input } from '../../../apps/game/src/input/input.ts';
import { TouchState } from '../../../apps/game/src/input/touch-state.ts';
import { Button, type AircraftState, type SimState, type StaticWorld } from '../../../packages/sim/src/index.ts';
import { ChaseCamera } from '../../../apps/game/src/render/camera.ts';
import { interpolateState } from '../../../apps/game/src/render/interpolation.ts';
import { NativeVehicleAnimation, VEHICLE_POSES } from '../../../apps/game/src/render/native-vehicle-animation.ts';

const entry = createRequire(new URL('../../../apps/game/package.json', import.meta.url)).resolve('three');
const THREE = await import(new URL('./three.module.js', pathToFileURL(entry)).href);

const aircraft = (x = 10): AircraftState => ({ id: 'malmi-plane', kind: 'plane', position: [x, 40, 20], rotation: [0, 0, 0, 1],
  yaw: 0, speed: 30, verticalSpeed: 0, grounded: false, throttle: .5, occupied: true, blocked: false,
  crashed:false,health:1,damage:'intact',velocity:[0,0,30],angularVelocity:[0,0,0] });
function snapshot(tick: number, a = aircraft()): SimState {
  return { tick, time: tick / 60, player: { position: a.position, mode: 'flying', aircraftId: a.id, inVehicle: null, yaw: a.yaw },
    aircraft: [a], vehicles: [], characters: [] } as unknown as SimState;
}

test('keyboard flight holds climb/descend continuously, clears weapon/jump and resets on blur', () => {
  const listeners = new Map<string, ((event: Record<string, unknown>) => void)[]>();
  const old = Object.fromEntries(['addEventListener', 'document', 'navigator'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  const on = (type: string, cb: (event: Record<string, unknown>) => void) => listeners.set(type, [...listeners.get(type) ?? [], cb]);
  Object.defineProperty(globalThis, 'addEventListener', { configurable: true, value: on });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { addEventListener: on, pointerLockElement: null } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { getGamepads: () => [] } });
  const emit = (type: string, code = '') => listeners.get(type)?.forEach(cb => cb({ code, repeat: false, preventDefault() {} }));
  try {
    const input = new Input({ addEventListener: on } as unknown as HTMLCanvasElement);
    for (const key of ['Space', 'KeyW', 'KeyD', 'ShiftLeft', 'KeyR']) emit('keydown', key);
    for (let i = 0; i < 20; i++) {
      const c = input.command(0, 0, true, true);
      assert.equal(c.moveX, 1); assert.equal(c.moveZ, 1);
      assert.equal(c.buttons, Button.ascend | Button.sprint);
    }
    emit('keyup', 'Space'); emit('keydown', 'ControlLeft');
    assert.ok(input.command(0, 0, true, true).buttons & Button.descend);
    emit('blur'); assert.equal(input.command(0, 0, true, true).buttons, 0);
    assert.equal(input.command(0, 0, false).buttons, 0, 'flight presses never become an exit jump');
  } finally {
    for (const [key, descriptor] of Object.entries(old)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('flight touch has independent speed and altitude controls and forgets them when leaving', () => {
  const t = new TouchState(); t.setDriving(true); t.setFlying(true);
  t.begin(1, 'accelerate'); t.begin(2, 'ascend');
  assert.equal(t.consume().moveZ, 1); assert.equal(t.consume().buttons, Button.ascend);
  t.end(2); t.begin(3, 'descend'); assert.equal(t.consume().buttons, Button.descend);
  t.setFlying(false); t.setDriving(false);
  assert.deepEqual(t.consume(), { moveX: 0, moveZ: 0, buttons: 0, jumpPresses: 0 });
});

test('aircraft presentation interpolates the same instant as Snow and never crosses boarding changes', () => {
  const a = snapshot(1, aircraft(10)), b = snapshot(2, aircraft(11));
  const shown = interpolateState(a, b, .25);
  assert.equal(shown.aircraft[0]!.position[0], 10.25); assert.equal(shown.player.position[0], 10.25);
  assert.equal(interpolateState(a, { ...b, player: { ...b.player, aircraftId: 'other' } }, .25).player.aircraftId, 'other');
});

test('aircraft camera follows a bounded chase offset and respects static camera collision', () => {
  const camera = new THREE.PerspectiveCamera(); const rig = new ChaseCamera(camera);
  let obstruction = false;
  const world = { physics: { castRay: () => obstruction ? { timeOfImpact: 3 } : null } } as unknown as StaticWorld;
  rig.update(snapshot(1), world, null, 1 / 60);
  assert.ok(camera.position.z < 20); assert.ok(camera.position.y > 40);
  assert.ok(camera.position.distanceTo(new THREE.Vector3(10, 41.5, 20)) < 30);
  obstruction = true; rig.reset(0); rig.update(snapshot(2), world, null, 1 / 60);
  assert.ok(camera.position.distanceTo(new THREE.Vector3(10, 41.5, 20)) <= 2.61, 'camera stops in front of static geometry');
});

test('seated Snow hips align to aircraft socket under arbitrary rotation and restore original rig', () => {
  const root = new THREE.Group(), model = new THREE.Group(); root.add(model);
  for (const name of Object.keys(VEHICLE_POSES.clips.enter.frames[0]!.rotations)) {
    const bone = new THREE.Bone(); bone.name = THREE.PropertyBinding.sanitizeNodeName(name); model.add(bone);
  }
  const layer = new NativeVehicleAnimation(model), hips = model.getObjectByName('DEF-Hips')!;
  const original = hips.position.clone(), q = new THREE.Quaternion().setFromEuler(new THREE.Euler(.2, 1.2, -.3));
  const a = { position: [10, 40, 20] as [number, number, number], rotation: q.toArray() as [number, number, number, number] };
  const seat = [.2, .8, .5] as const;
  layer.apply(root, { vehicleId: 'malmi-plane', stage: 'seated', clip: 'enter', side: 'driver', progress: 1, startOffset: [0, 0, 0] }, a, 1 / 60, VEHICLE_POSES, seat);
  const expected = new THREE.Vector3(...seat).applyQuaternion(q).add(new THREE.Vector3(...a.position));
  assert.ok(hips.getWorldPosition(new THREE.Vector3()).distanceTo(expected) < 1e-8);
  layer.restore(); assert.ok(hips.position.distanceTo(original) < 1e-12);
});
