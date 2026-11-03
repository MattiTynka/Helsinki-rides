import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GameAudio } from '../../../apps/game/src/audio/audio.ts';

test('audio readiness stays pending until the device resumes, sharing an overlapping start', async () => {
  let complete!: () => void, calls = 0;
  const ctx = { state: 'suspended', resume: () => { calls++; return new Promise<void>(resolve => { complete = () => { ctx.state = 'running'; resolve(); }; }); } };
  const audio = new GameAudio(true); Object.assign(audio, { ctx });
  const pending = audio.start(); let settled = false;
  Promise.resolve(pending).then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  assert.equal(audio.start(), pending); assert.equal(calls, 1);
  complete(); assert.equal(await pending, 'running');
});

test('a blocked audio device has a bounded fallback and observes a later rejection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(console, 'warn', () => {});
  let reject!: (error: Error) => void;
  const audio = new GameAudio(true); Object.assign(audio, { ctx: { state: 'suspended', resume: () => new Promise<void>((_, no) => { reject = no; }) } });
  const pending = audio.start(); t.mock.timers.tick(1000);
  assert.equal(await pending, 'timeout');
  reject(new Error('device unavailable')); await Promise.resolve();
});

test('denied audio reports unavailable without rejecting the gameplay start', async t => {
  t.mock.method(console, 'warn', () => {});
  const audio = new GameAudio(true); Object.assign(audio, { ctx: { state: 'suspended', resume: () => Promise.reject(new Error('denied')) } });
  assert.equal(await audio.start(), 'unavailable');
});

test('pause queues suspension during a pending resume; the next gesture gets a fresh resume', async () => {
  const complete: (() => void)[] = []; let calls = 0, suspends = 0;
  const ctx = { state: 'suspended', resume: () => { calls++; return new Promise<void>(resolve => { complete.push(resolve); }); }, suspend: async () => { suspends++; } };
  const audio = new GameAudio(true); Object.assign(audio, { ctx });
  const first = audio.start(); audio.suspend(); const second = audio.start();
  assert.equal(suspends, 1); assert.equal(calls, 2); assert.notEqual(first, second);
  complete[0]!(); complete[1]!(); await Promise.all([first, second]);
});


test('pause after an audio-start timeout still queues suspension of the unfinished device request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); t.mock.method(console, 'warn', () => {});
  let suspends = 0;
  const audio = new GameAudio(true);
  Object.assign(audio, { ctx: { state: 'suspended', resume: () => new Promise<void>(() => {}), suspend: async () => { suspends++; } } });
  const pending = audio.start(); t.mock.timers.tick(1000); assert.equal(await pending, 'timeout');
  await Promise.resolve(); audio.suspend(); assert.equal(suspends, 1);
});
