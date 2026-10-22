import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TouchState } from '../../../apps/game/src/input/touch-state.ts';
import { Input } from '../../../apps/game/src/input/input.ts';
import { touchPreferences } from '../../../apps/game/src/ui/touch-controls.ts';
import { Button } from '../../../packages/sim/src/commands.ts';

test('two thumbs move and drag Fire to aim without releasing either held action', () => {
  const touch = new TouchState();
  assert.ok(touch.begin(12, 'move')); touch.stick(12, 0, -0.8);
  assert.ok(touch.begin(91, 'fire', 400, 100)); touch.move(91, 430, 88);
  const command = touch.consume();
  assert.ok(command.moveZ > 0.4); assert.equal(command.moveX, 0);
  assert.ok(command.buttons & Button.fire);
  assert.deepEqual(touch.takeLook(), [0.12, -0.048]); assert.deepEqual(touch.takeLook(), [0, 0]);
  touch.end(91); assert.equal(touch.consume().buttons & Button.fire, 0);
  assert.ok(touch.consume().moveZ > 0, 'releasing the fire thumb leaves movement held');
  touch.end(12); assert.equal(touch.consume().moveZ, 0);
});

test('pointers own one control each, and look and Fire cannot double-count camera movement', () => {
  const touch = new TouchState();
  assert.ok(touch.begin(3, 'move')); assert.equal(touch.begin(3, 'jump'), false);
  assert.equal(touch.begin(4, 'move'), false);
  assert.ok(touch.begin(8, 'look')); assert.equal(touch.begin(9, 'fire'), false);
  touch.end(8); assert.ok(touch.begin(9, 'fire'));
  touch.move(8, 500, 500); assert.deepEqual(touch.takeLook(), [0, 0], 'an old pointer cannot keep turning the camera');
});

test('stick offers a bounded walking zone, running, and a deliberate outer sprint ring', () => {
  const touch = new TouchState(); touch.begin(1, 'move');
  touch.stick(1, 0, -0.1); assert.equal(touch.consume().moveZ, 0);
  touch.stick(1, 0.3, -0.3);
  let command = touch.consume(); assert.ok(Math.hypot(command.moveX, command.moveZ) <= 0.4); assert.equal(command.buttons & Button.sprint, 0);
  touch.stick(1, 0, -0.8); command = touch.consume(); assert.ok(command.moveZ > 0.4); assert.equal(command.buttons & Button.sprint, 0);
  touch.stick(1, 5, -5); command = touch.consume(); assert.ok(Math.hypot(command.moveX, command.moveZ) <= 1.00000001); assert.ok(command.buttons & Button.sprint);
  touch.stick(1, NaN, Infinity); assert.deepEqual(touch.consume(), command, 'invalid coordinates do not corrupt active commands');
});

test('driving uses separate steering and pedals, brake wins, and no foot actions survive the transition', () => {
  const touch = new TouchState(); touch.begin(1, 'aim'); touch.end(1); touch.begin(2, 'jump');
  touch.setDriving(true); assert.equal(touch.activePointers, 0); assert.equal(touch.aiming, false);
  touch.begin(3, 'move'); touch.stick(3, -0.8, -0.5);
  assert.equal(touch.consume().moveZ, 0, 'vertical stick movement never presses the accelerator');
  touch.begin(4, 'accelerate'); assert.equal(touch.consume().moveZ, 1);
  touch.begin(5, 'brake'); assert.equal(touch.consume().moveZ, -1);
  touch.end(5); assert.equal(touch.consume().moveZ, 1);
  touch.begin(6, 'handbrake'); touch.begin(7, 'horn');
  const command = touch.consume(); assert.ok(command.moveX < 0); assert.ok(command.buttons & Button.handbrake); assert.ok(command.buttons & Button.horn);
  touch.setDriving(false); assert.deepEqual(touch.consume(), { moveX: 0, moveZ: 0, buttons: 0, jumpPresses: 0 });
});

test('aim is latched, holster clears aim, and fast actions persist through ordinary pointer-up exactly once', () => {
  const touch = new TouchState(); touch.begin(10, 'aim'); touch.end(10);
  assert.ok(touch.consume().buttons & Button.aim); assert.ok(touch.consume().buttons & Button.aim);
  touch.begin(20, 'interact'); touch.end(20); assert.ok(touch.consume().buttons & Button.interact);
  assert.equal(touch.consume().buttons & Button.interact, 0);
  touch.begin(30, 'holster'); touch.end(30); assert.equal(touch.aiming, false);
  assert.ok(touch.consume().buttons & Button.holster); assert.equal(touch.consume().buttons, 0);
});

test('pointer cancellation clears its own held action and pending pulse without cancelling another thumb', () => {
  const touch = new TouchState(); touch.begin(1, 'move'); touch.stick(1, 0, -0.5);
  touch.begin(2, 'jump'); touch.end(2, true); assert.equal(touch.consume().jumpPresses, 0);
  touch.begin(3, 'fire', 4, 5); touch.move(3, 8, 10); touch.end(3, true);
  assert.deepEqual(touch.takeLook(), [0, 0]);
  const command = touch.consume(); assert.equal(command.buttons & Button.fire, 0); assert.ok(command.moveZ > 0);
  touch.begin(4, 'aim'); touch.end(4, true); assert.equal(touch.aiming, false);
});

test('pause, disable, death/mode reset and blur-style reset discard held inputs and queued impulses', () => {
  const touch = new TouchState(); touch.begin(1, 'fire'); touch.begin(2, 'aim'); touch.end(2); touch.begin(3, 'jump');
  touch.setActive(false); assert.equal(touch.begin(4, 'interact'), false);
  assert.deepEqual(touch.consume(), { moveX: 0, moveZ: 0, buttons: 0, jumpPresses: 0 });
  touch.setActive(true); touch.move(1, 100, 200); assert.deepEqual(touch.takeLook(), [0, 0]);
  assert.equal(touch.consume().buttons, 0, 'resume requires fresh fingers');
  touch.begin(5, 'recover'); assert.ok(touch.consume().buttons & Button.recover);
  touch.reset(); assert.equal(touch.consume().buttons, 0);
});

test('fast Fire and Reload taps between 30Hz frames survive for one command; held controls retain their cadence', () => {
  const touch = new TouchState();
  const frame = () => [touch.consume().buttons, touch.consume().buttons]; // two fixed 60Hz ticks per presentation
  for (const [role, flag] of [['fire', Button.fire], ['reload', Button.reload]] as const) {
    touch.begin(1, role); touch.end(1);
    assert.deepEqual(frame(), [flag, 0], `${role} is retained across touch-up until the next command`);
    assert.deepEqual(frame(), [0, 0], 'a tap does not repeat in a later frame');
    touch.begin(2, role); assert.deepEqual(frame(), [flag, flag], 'holding continues through both fixed ticks');
    assert.deepEqual(frame(), [flag, flag], 'holding continues in the next presentation frame');
    touch.end(2); assert.deepEqual(frame(), [0, 0]);
    touch.begin(3, role); touch.end(3, true); assert.deepEqual(frame(), [0, 0], 'cancellation removes both hold and pending press');
    touch.begin(4, role); touch.end(4); touch.setActive(false); touch.setActive(true);
    assert.deepEqual(frame(), [0, 0], 'pause and resume discard an unconsumed tap');
    touch.begin(5, role); touch.end(5); touch.reset();
    assert.deepEqual(frame(), [0, 0], 'death, mode or recovery reset discards an unconsumed tap');
  }
});

test('touch preference payloads have bounded numeric values and a conservative explicit mode', () => {
  assert.deepEqual(touchPreferences({ mode: 'on', scale: 99, sensitivity: -5, mirror: true }), { mode: 'on', scale: 1.25, sensitivity: 0.5, mirror: true });
  assert.deepEqual(touchPreferences({ mode: 'invalid', scale: NaN, sensitivity: '2', mirror: 'true' }), { mode: 'auto', scale: 1, sensitivity: 1, mirror: false });
  assert.deepEqual(touchPreferences(null), { mode: 'auto', scale: 1, sensitivity: 1, mirror: false });
});

test('touch quick double Jump uses the existing edge-triggered neutral tick queue, and disabled Input is neutral', () => {
  const descriptors = Object.fromEntries(['addEventListener', 'document', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const on = (type: string, callback: (event: unknown) => void): void => { listeners.set(type, [...listeners.get(type) ?? [], callback]); };
  Object.defineProperty(globalThis, 'addEventListener', { configurable: true, value: on });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { addEventListener: on, pointerLockElement: null } });
  let pad: { axes: number[]; buttons: { pressed: boolean; value: number }[] } | null = null;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { getGamepads: () => [pad] } });
  try {
    const input = new Input({ addEventListener: on } as unknown as HTMLCanvasElement); input.setTouchEnabled(true);
    input.touch.begin(1, 'jump'); input.touch.end(1); input.touch.begin(2, 'jump'); input.touch.end(2);
    assert.deepEqual(Array.from({ length: 4 }, () => input.command(0, 0, false).buttons), [Button.jump, 0, Button.jump, 0]);
    input.touch.begin(3, 'fire'); input.touch.begin(4, 'jump'); input.setActive(false);
    assert.deepEqual(input.command(2, 1, false), { moveX: 0, moveZ: 0, yaw: 2, pitch: 1, buttons: 0 });
    assert.deepEqual(input.takeLook(), [0, 0]); assert.deepEqual(input.gamepadLook(), [0, 0]);
    input.setActive(true); assert.equal(input.command(0, 0, false).buttons, 0);
    input.setActive(false);
    pad = { axes: [0.8, 0, 0.9, 0.3], buttons: Array.from({ length: 8 }, (_, i) => ({ pressed: i === 7, value: i === 7 ? 1 : 0 })) };
    input.setActive(true);
    assert.deepEqual(input.gamepadLook(), [0, 0], 'a held controller cannot turn the camera on resume');
    assert.equal(input.command(0, 0, false).buttons, 0, 'held fire must first be released');
    assert.equal(input.command(0, 0, false).moveX, 0);
    pad.axes = [0, 0, 0, 0]; pad.buttons[7] = { pressed: false, value: 0 };
    assert.equal(input.command(0, 0, false).buttons, 0);
    pad.buttons[7] = { pressed: true, value: 1 };
    assert.ok(input.command(0, 0, false).buttons & Button.fire, 'a fresh controller press works after release');
    input.reset(); assert.equal(input.command(0, 0, false).buttons, 0, 'mode or respawn reset also requires release of a previously held controller');
    pad.buttons[7] = { pressed: false, value: 0 }; input.command(0, 0, false);
    pad.axes = [0, 0, 0.7, -0.5];
    const defaultLook = input.gamepadLook();
    assert.deepEqual(defaultLook, [0.7 * 0.05, -0.5 * 0.04], 'default parameter preserves existing 60Hz input semantics');
    const sumLook = (hz: number): number[] => Array.from({ length: hz }, () => input.gamepadLook(1 / hz))
      .reduce((sum, look) => [sum[0]! + look[0]!, sum[1]! + look[1]!], [0, 0]);
    const at30 = sumLook(30), at60 = sumLook(60);
    assert.ok(Math.abs(at30[0]! - at60[0]!) < 1e-12 && Math.abs(at30[1]! - at60[1]!) < 1e-12, '30Hz and 60Hz presentation rotate by the same amount per second');
    assert.deepEqual(input.gamepadLook(0), [0, -0]);
    assert.deepEqual(input.gamepadLook(Number.NaN), [0, -0]);
  } finally {
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
