import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GameAudio } from '../../../apps/game/src/audio/audio.ts';

test('fresh-visitor audio is constructed and suspended before loading completes; Play only resumes it', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  Object.defineProperty(globalThis, 'AudioContext', { value: class {}, configurable: true });
  try {
    let builds = 0, resumes = 0, suspended = false, complete!: () => void;
    const context = { state: 'suspended', suspend: () => new Promise<void>(resolve => { complete = () => { suspended = true; resolve(); }; }), resume: async () => { resumes++; } };
    const audio = new GameAudio(true);
    Object.assign(audio, { build: () => { builds++; Object.assign(audio, { ctx: context }); return context; } });
    let prepared = false; const pending = Promise.resolve(audio.prepare()).then(() => { prepared = true; });
    assert.equal(builds, 1, 'a fresh visitor must not defer construction to the first input');
    await Promise.resolve(); assert.equal(prepared, false);
    complete(); await pending; assert.equal(suspended, true);
    await audio.prepare(); audio.start();
    assert.equal(builds, 1); assert.equal(resumes, 1);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'AudioContext', previous); else Reflect.deleteProperty(globalThis, 'AudioContext');
  }
});

test('blocked audio construction does not prevent loading and retries on Play', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  Object.defineProperty(globalThis, 'AudioContext', { value: class {}, configurable: true });
  try {
    let builds = 0, resumes = 0;
    const audio = new GameAudio(true);
    Object.assign(audio, { build: () => { if (++builds === 1) throw new Error('gesture required'); return { state: 'suspended', resume: () => { resumes++; return Promise.resolve(); } }; } });
    await audio.prepare(); assert.equal(builds, 1); audio.start(); assert.equal(builds, 2); assert.equal(resumes, 1);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'AudioContext', previous); else Reflect.deleteProperty(globalThis, 'AudioContext');
  }
});
