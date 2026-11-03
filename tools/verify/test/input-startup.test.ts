import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Input } from '../../../apps/game/src/input/input.ts';
import { Button } from '../../../packages/sim/src/commands.ts';

function withInput(run: (input: Input, emit: (type: string, code?: string, repeat?: boolean) => void, ready: () => void) => void): void {
  const listeners = new Map<string, ((event: Record<string, unknown>) => void)[]>();
  const old = Object.fromEntries(['addEventListener', 'document', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const on = (type: string, callback: (event: Record<string, unknown>) => void) => listeners.set(type, [...listeners.get(type) ?? [], callback]);
  let loadingHidden = false;
  Object.defineProperty(globalThis, 'addEventListener', { configurable: true, value: on });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { addEventListener: on, pointerLockElement: null,
    getElementById: () => ({ classList: { contains: () => loadingHidden } }) } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { getGamepads: () => [] } });
  const emit = (type: string, code = '', repeat = false) => listeners.get(type)?.forEach(callback => callback({ code, repeat, button: 0, preventDefault() {} }));
  try {
    const input = new Input({ addEventListener: on } as unknown as HTMLCanvasElement, true);
    input.setActive(false);
    const ready = () => { input.setActive(true); loadingHidden = true; input.finishStartupMovementCapture(); };
    run(input, emit, ready);
  } finally {
    for (const [key, descriptor] of Object.entries(old)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('movement held after Play survives the initial readiness gate without requiring another keydown', () => {
  withInput((input, emit, ready) => {
    input.beginStartupMovementCapture();
    emit('keydown', 'KeyW'); emit('keydown', 'ShiftLeft'); emit('keydown', 'KeyW', true);
    assert.equal(input.command(0, 0, false).moveZ, 0, 'pending startup remains inactive');
    ready();
    assert.equal(input.command(0, 0, false).moveZ, 1);
    assert.equal(input.command(0, 0, false).buttons, Button.sprint);
    emit('keyup', 'KeyW'); emit('keyup', 'ShiftLeft');
    assert.equal(input.command(0, 0, false).moveZ, 0);
    assert.equal(input.command(0, 0, false).buttons, 0);
  });
});

test('keys released during startup do not stick and arrows retain their walking modifier', () => {
  withInput((input, emit, ready) => {
    input.beginStartupMovementCapture();
    emit('keydown', 'KeyW'); emit('keyup', 'KeyW');
    emit('keydown', 'ArrowRight'); emit('keydown', 'AltRight');
    ready();
    const command = input.command(0, 0, false);
    assert.equal(command.moveZ, 0); assert.equal(command.moveX, 0.4); assert.equal(command.buttons, 0);
    emit('keyup', 'ArrowRight'); emit('keyup', 'AltRight');
    assert.equal(input.command(0, 0, false).moveX, 0);
  });
});

test('startup capture never restores actions or mouse buttons', () => {
  withInput((input, emit, ready) => {
    input.beginStartupMovementCapture();
    for (const code of ['KeyF', 'Enter', 'Space', 'KeyG', 'KeyR', 'KeyH', 'KeyX', 'Backspace', 'ControlLeft']) emit('keydown', code);
    emit('mousedown'); ready();
    assert.equal(input.command(0, 0, false).buttons, 0);
    assert.equal(input.command(0, 0, true).buttons, 0);
    assert.equal(input.command(0, 0, true, true).buttons, 0);
  });
});

test('interruption clears startup intent and ordinary pause-resume still requires fresh input', () => {
  for (const interruption of ['pause', 'blur', 'reset'] as const) withInput((input, emit, ready) => {
    input.beginStartupMovementCapture(); emit('keydown', 'KeyW');
    if (interruption === 'pause') input.setActive(false);
    else if (interruption === 'blur') emit('blur');
    else input.reset();
    emit('keydown', 'KeyW', true); ready();
    assert.equal(input.command(0, 0, false).moveZ, 0, `${interruption} cancels pending movement`);
    emit('keyup', 'KeyW'); emit('keydown', 'KeyW');
    assert.equal(input.command(0, 0, false).moveZ, 1);
    input.setActive(false); emit('keydown', 'KeyW', true); input.setActive(true);
    assert.equal(input.command(0, 0, false).moveZ, 0, 'normal resume does not restore held movement');
  });
});
