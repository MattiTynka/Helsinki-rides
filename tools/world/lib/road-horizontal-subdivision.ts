import assert from 'node:assert/strict';
import type {Vec3} from '../../../packages/world-schema/src/index.ts';

/** Height projection may subdivide a reviewed line, never change its bends,
 * endpoints, direction, or horizontal corridor. This tolerance is arithmetic
 * roundoff, not a source-registration or physical-clearance allowance. */
export function assertHorizontalSubdivision(before: readonly Vec3[], after: readonly Vec3[]) {
  assert.ok(before.length >= 2 && after.length >= before.length && after.length <= 100000);
  assert.ok([...before, ...after].every(p => p.length === 3 && p.every(Number.isFinite)));
  const same = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2]) <= 1e-8;
  assert.ok(same(before[0]!, after[0]!) && same(before.at(-1)!, after.at(-1)!), 'Reviewed horizontal endpoint changed');
  let cursor = 0;
  for (const p of before) {while (cursor < after.length && !same(p, after[cursor]!)) cursor++; assert.ok(cursor < after.length, 'Reviewed horizontal bend removed'); cursor++;}
  let segment = 0, previous = -1;
  for (const p of after) {
    let found = false;
    while (segment < before.length - 1) {
      const a = before[segment]!, b = before[segment + 1]!, dx = b[0] - a[0], dz = b[2] - a[2], squared = dx * dx + dz * dz;
      assert.ok(squared > 0, 'Reviewed horizontal segment is degenerate');
      const t = ((p[0] - a[0]) * dx + (p[2] - a[2]) * dz) / squared;
      if (t >= previous - 1e-9 && t >= -1e-9 && t <= 1 + 1e-9 && Math.hypot(a[0] + dx * t - p[0], a[2] + dz * t - p[2]) <= 1e-8) {previous = t; found = true; break;}
      segment++; previous = -1;
    }
    assert.ok(found, 'Projected line leaves or reverses reviewed horizontal geometry');
  }
}
