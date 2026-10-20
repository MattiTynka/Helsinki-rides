import assert from 'node:assert/strict';
import test from 'node:test';
import { UploadQueue } from '../../../apps/game/src/render/upload-queue.ts';

function fixture(options: { budgetMs?: number; maxJobsPerFrame?: number } = {}) {
  let time = 0, nextFrame = 0;
  const callbacks = new Map<number, () => void>(), cancelled: number[] = [];
  const queue = new UploadQueue({ ...options, now: () => time,
    requestFrame: callback => { const id = ++nextFrame; callbacks.set(id, callback); return id; },
    cancelFrame: id => { cancelled.push(id); callbacks.delete(id); },
  });
  return { queue, callbacks, cancelled, advance: (ms: number) => { time += ms; }, frame: () => {
    const entry = callbacks.entries().next().value;
    assert.ok(entry, 'a frame is scheduled');
    callbacks.delete(entry[0]); entry[1]();
  } };
}

test('uploads share one scheduled frame, preserve FIFO order and stop at the measured budget', async () => {
  const f = fixture({ maxJobsPerFrame: 10 }), uploaded: number[] = [];
  assert.equal(f.callbacks.size, 0, 'idle queues do not request frames');
  const pending = [0, 1, 2].map(index => f.queue.enqueue(() => { uploaded.push(index); f.advance(1.1); }));
  assert.equal(f.callbacks.size, 1);
  assert.deepEqual(uploaded, [], 'uploads wait for a frame');
  f.frame(); assert.deepEqual(uploaded, [0, 1]); assert.equal(f.callbacks.size, 1);
  f.frame(); await Promise.all(pending);
  assert.deepEqual(uploaded, [0, 1, 2]); assert.equal(f.callbacks.size, 0);
});

test('the job count cap bounds work even when the clock reports near-zero upload cost', async () => {
  const f = fixture(), uploaded: number[] = [];
  const pending = [0, 1, 2, 3, 4].map(index => f.queue.enqueue(() => { uploaded.push(index); }));
  f.frame(); assert.deepEqual(uploaded, [0, 1]);
  f.frame(); assert.deepEqual(uploaded, [0, 1, 2, 3]);
  f.frame(); await Promise.all(pending);
  assert.equal(f.callbacks.size, 0);
});

test('one long upload consumes its frame without blocking later work permanently', async () => {
  const f = fixture(), uploaded: string[] = [];
  const first = f.queue.enqueue(() => { uploaded.push('long'); f.advance(50); });
  const second = f.queue.enqueue(() => { uploaded.push('next'); });
  f.frame(); assert.deepEqual(uploaded, ['long']);
  f.frame(); await Promise.all([first, second]); assert.deepEqual(uploaded, ['long', 'next']);
});

test('aborted work never uploads, rejects AbortError and cancels an empty scheduled frame', async () => {
  const f = fixture(), controller = new AbortController();
  let uploaded = 0;
  const pending = f.queue.enqueue(() => { uploaded++; }, controller.signal);
  const rejection = assert.rejects(pending, { name: 'AbortError' });
  controller.abort(); await rejection;
  assert.equal(uploaded, 0); assert.equal(f.callbacks.size, 0); assert.deepEqual(f.cancelled, [1]);
  await assert.rejects(f.queue.enqueue(() => { uploaded++; }, controller.signal), { name: 'AbortError' });
  assert.equal(f.callbacks.size, 0);
});

test('failed upload rejects its owner and the remaining queue continues', async () => {
  const f = fixture(); let uploaded = 0;
  const failed = f.queue.enqueue(() => { throw new Error('GPU failure'); });
  const rejection = assert.rejects(failed, /GPU failure/);
  const good = f.queue.enqueue(() => { uploaded++; });
  f.frame(); await rejection; await good;
  assert.equal(uploaded, 1); assert.equal(f.callbacks.size, 0);
});

test('dispose rejects queued jobs, detaches cancellation and prevents stale callbacks from uploading', async () => {
  const f = fixture(), controller = new AbortController(); let uploaded = 0;
  const pending = f.queue.enqueue(() => { uploaded++; }, controller.signal);
  const rejection = assert.rejects(pending, { name: 'AbortError' });
  const stale = [...f.callbacks.values()][0]!;
  f.queue.dispose(); f.queue.dispose(); controller.abort(); stale(); await rejection;
  assert.equal(uploaded, 0); assert.equal(f.callbacks.size, 0); assert.deepEqual(f.cancelled, [1]);
  await assert.rejects(f.queue.enqueue(() => { uploaded++; }), { name: 'AbortError' });
});

test('a cancelled frame cannot drain jobs queued by a later generation', async () => {
  const f = fixture(), controller = new AbortController(); let uploaded = 0;
  const first = f.queue.enqueue(() => { uploaded++; }, controller.signal);
  const rejection = assert.rejects(first, { name: 'AbortError' });
  const stale = [...f.callbacks.values()][0]!;
  controller.abort(); await rejection;
  const later = f.queue.enqueue(() => { uploaded++; });
  stale(); assert.equal(uploaded, 0); assert.equal(f.callbacks.size, 1);
  f.frame(); await later; assert.equal(uploaded, 1);
});

test('jobs enqueued during a drain use the same frame budget without scheduling duplicate frames', async () => {
  const f = fixture(); let later!: Promise<void>; const uploaded: number[] = [];
  const first = f.queue.enqueue(() => { uploaded.push(1); later = f.queue.enqueue(() => { uploaded.push(2); }); });
  f.frame(); await first; await later;
  assert.deepEqual(uploaded, [1, 2]); assert.equal(f.callbacks.size, 0);
});
