import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';

// Exercise real session lifecycle methods; styles are a browser-only dependency.
const hook = registerHooks({ load(url, context, next) {
  return url.endsWith('/session.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context);
} });
const { SessionControls } = await import('../../../apps/game/src/ui/session-controls.ts');
hook.deregister();

function fixture() {
  const completions: (() => void)[] = [], order: string[] = [];
  const game = { paused: true, config: { review: false }, setPaused(value: boolean) { this.paused = value; order.push(value ? 'pause' : 'play'); },
    audio: { start: () => { order.push('audio'); return new Promise<void>(resolve => completions.push(resolve)); }, suspend: () => order.push('suspend') } };
  const controls = Object.assign(Object.create(SessionControls.prototype), {
    started: true, graphicsLost: false, resumeGeneration: 0, resuming: false, game,
    touch: { enabled: false, setActive: (active: boolean) => order.push(active ? 'touch-on' : 'touch-off') },
    canvas: { focus: () => {}, requestPointerLock: () => { order.push('lock'); return Promise.resolve(); } },
    panel: { classList: { add: () => order.push('hide-panel'), remove: () => order.push('show-panel') } },
    resumeButton: { disabled: false, focus: () => {} }, translate: () => {}, updateTouch: () => order.push('touch-update'),
  });
  return { controls, game, order, completions };
}

test('session requests pointer lock in the gesture but keeps simulation paused until audio settles', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { hidden: false, pointerLockElement: null } });
  try {
    const f = fixture(), pending = f.controls.resume();
    assert.ok(f.order.includes('lock')); assert.equal(f.game.paused, true); assert.equal(f.controls.resumeButton.disabled, true);
    f.completions[0]!(); await pending;
    assert.equal(f.game.paused, false); assert.equal(f.controls.resumeButton.disabled, false);
  } finally { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document'); }
});

test('pause invalidates a pending start and an old completion cannot overtake a later gesture', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { hidden: false, pointerLockElement: null } });
  try {
    const f = fixture(), first = f.controls.resume(); f.controls.pause(); const second = f.controls.resume();
    f.completions[0]!(); await first; assert.equal(f.game.paused, true);
    f.completions[1]!(); await second; assert.equal(f.game.paused, false);
  } finally { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document'); }
});

test('hidden or lost-graphics sessions cannot be unpaused by audio readiness', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const document = { hidden: false, pointerLockElement: null };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  try {
    for (const interrupted of ['hidden', 'graphics']) {
      document.hidden = false; const f = fixture(), pending = f.controls.resume();
      if (interrupted === 'hidden') document.hidden = true; else f.controls.graphicsLost = true;
      f.completions[0]!(); await pending; assert.equal(f.game.paused, true);
    }
  } finally { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document'); }
});
