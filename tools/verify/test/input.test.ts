import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Input } from '../../../apps/game/src/input/input.ts';
import { Button } from '../../../packages/sim/src/commands.ts';

test('Space emits separate jump presses, preserves quick double taps and remains a held car handbrake', () => {
  const listeners = new Map<string, ((event: Record<string, unknown>) => void)[]>();
  const old = Object.fromEntries(['addEventListener', 'document', 'navigator'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  const on = (type: string, callback: (event: Record<string, unknown>) => void) => listeners.set(type, [...listeners.get(type) ?? [], callback]);
  let pad: { axes: number[]; buttons: { pressed: boolean; value: number }[] } | null = null;
  Object.defineProperty(globalThis, 'addEventListener', { configurable: true, value: on });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { addEventListener: on, pointerLockElement: null } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { getGamepads: () => [pad] } });
  const emit = (type: string, code = '', repeat = false) => listeners.get(type)?.forEach(cb => cb({ code, repeat, preventDefault() {} }));
  try {
    const input = new Input({ addEventListener: on } as unknown as HTMLCanvasElement);
    const command = (driving = false) => input.command(0, 0, driving);
    emit('keydown', 'Space');
    assert.equal(command().buttons, Button.jump);
    emit('keydown', 'Space', true);
    for (let i = 0; i < 120; i++) assert.equal(command().buttons, 0, 'held/repeating Space does not repeat jump');
    emit('keyup', 'Space');
    emit('keydown', 'Space'); emit('keyup', 'Space'); emit('keydown', 'Space'); emit('keyup', 'Space');
    assert.deepEqual([command().buttons, command().buttons, command().buttons, command().buttons], [Button.jump, 0, Button.jump, 0]);
    emit('keydown', 'Space');
    for (let i = 0; i < 10; i++) assert.equal(command(true).buttons, Button.handbrake);
    assert.equal(command().buttons, 0, 'car presses are not buffered into an exit jump');
    emit('keyup', 'Space'); emit('keydown', 'Space'); emit('keydown', 'KeyW'); emit('blur');
    assert.equal(command().buttons, 0); assert.equal(command().moveZ, 0);
    pad = { axes: [0, 0, 0, 0], buttons: [{ pressed: false, value: 0 }, { pressed: true, value: 1 }] };
    assert.equal(command().buttons, Button.jump);
    for (let i = 0; i < 10; i++) assert.equal(command().buttons, 0);
    assert.equal(command(true).buttons, Button.handbrake);
  } finally {
    for (const [key, descriptor] of Object.entries(old)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
