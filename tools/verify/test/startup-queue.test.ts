import assert from 'node:assert/strict';
import test from 'node:test';
import { runStartupJobs } from '../../../apps/game/src/world/startup-queue.ts';

test('startup overlaps terrain and collision delivery within six slots and retains indexed results', async () => {
  let active = 0, peak = 0;
  const started: number[] = [], completed: number[] = [], results: number[] = [];
  const releases = new Map<number, () => void>();
  const tasks = Array.from({ length: 12 }, (_, index) => async () => {
    started.push(index); active++; peak = Math.max(peak, active);
    await new Promise<void>(resolve => releases.set(index, resolve));
    results[index] = index; completed.push(index); active--;
  });
  const pending = runStartupJobs(tasks);
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
  // Leave terrain (index0) pending while a completed JSON job frees capacity for more collision data.
  releases.get(1)!();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(completed[0], 1);
  for (let index = 2; index < tasks.length; index++) {
    releases.get(index)!();
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  releases.get(0)!(); await pending;
  assert.equal(peak, 6);
  assert.deepEqual(results, tasks.map((_, index) => index));
});

test('startup fails without scheduling further jobs after a failed request', async () => {
  const started: number[] = [];
  const releases: (() => void)[] = [];
  const tasks = Array.from({ length: 20 }, (_, index) => async () => {
    started.push(index);
    if (index === 0) throw new Error('delivery failed');
    await new Promise<void>(resolve => releases.push(resolve));
  });
  await assert.rejects(runStartupJobs(tasks), /delivery failed/);
  for (const release of releases) release();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
});
