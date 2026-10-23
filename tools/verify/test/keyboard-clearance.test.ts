import assert from 'node:assert/strict';
import test from 'node:test';
import { keyboardClearanceCourse } from '../lib/keyboard-driving.ts';

test('forward and reverse escape travel away from a car on either side', () => {
  for (const heading of [-1.217211711575899, 0, 2.4]) {
    for (const direction of [-1, 1] as const) for (const side of [-2.5149, 2.5149]) {
      const course = keyboardClearanceCourse(heading, direction, side);
      const lateral = Math.sin(course) * Math.cos(heading) - Math.cos(course) * Math.sin(heading);
      const longitudinal = Math.sin(course) * Math.sin(heading) + Math.cos(course) * Math.cos(heading);
      assert.ok(lateral * side < 0, `heading ${heading}, direction ${direction}, side ${side}: away from obstacle`);
      assert.ok(longitudinal * direction > 0, 'course retains selected forward/reverse travel');
    }
  }
});

test('without an adjacent obstacle, escape follows the selected travel direction', () => {
  assert.equal(keyboardClearanceCourse(.3, 1, 0), .3);
  assert.equal(keyboardClearanceCourse(.3, -1, 0), .3 + Math.PI);
});
