import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNativeTouch } from '../lib/native-touch.mjs';

test('releasing the horn sends its ending pointer while the handbrake thumb remains down', async () => {
  const events = [], touch = createNativeTouch({ send: async (method, event) => { assert.equal(method, 'Input.dispatchTouchEvent'); events.push(event); } });
  await touch('touchStart', 4, 100, 200); await touch('touchStart', 5, 300, 200);
  await touch('touchEnd', 5);
  assert.deepEqual(events.at(-1), { type: 'touchEnd', touchPoints: [{ id: 5, x: 300, y: 200, radiusX: 5, radiusY: 5, force: 1 }] });
  await touch('touchMove', 4, 105, 200);
  assert.deepEqual(events.at(-1).touchPoints.map(point => point.id), [4]);
  await touch('touchEnd', 4); assert.deepEqual(events.at(-1), { type: 'touchEnd', touchPoints: [] });
  await assert.rejects(touch('touchEnd', 5), /inactive/);
});

test('cancel discards all pointers before the next independent gesture', async () => {
  const events = [], touch = createNativeTouch({ send: async (_method, event) => events.push(event) });
  await touch('touchStart', 1, 1, 2); await touch('touchStart', 2, 3, 4); await touch('touchCancel', 1);
  assert.deepEqual(events.at(-1), { type: 'touchCancel', touchPoints: [] });
  await touch('touchStart', 3, 5, 6); assert.deepEqual(events.at(-1).touchPoints.map(point => point.id), [3]);
});
