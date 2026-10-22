import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CollisionResidency, type CollisionCellRef, type ResidencySource } from '../src/collision-residency.ts';

/** Original full-distance algorithm: retained as the deterministic plan/order oracle. */
function reference(cells: readonly CollisionCellRef[], sources: readonly ResidencySource[], resident: ReadonlySet<string>, ahead: number) {
  const needed: { id: string; urgency: number }[] = [], wanted: { id: string; urgency: number }[] = [], remove: string[] = [];
  for (const cell of cells) {
    let need = false, want = false, keep = false, urgency = Infinity;
    for (const s of sources) {
      const b = cell.boundsXZ;
      const d = Math.hypot(Math.max(b[0] - s.x, 0, s.x - b[2]), Math.max(b[1] - s.z, 0, s.z - b[3]));
      if (d <= s.need) need = true;
      if (d <= s.want) want = true;
      if (d <= s.keep) keep = true;
      urgency = Math.min(urgency, d - s.need);
    }
    if (resident.has(cell.id)) { if (!keep) remove.push(cell.id); }
    else if (need) needed.push({ id: cell.id, urgency });
    else if (want) wanted.push({ id: cell.id, urgency });
  }
  const byUrgency = (a: { id: string; urgency: number }, b: { id: string; urgency: number }) =>
    a.urgency - b.urgency || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  needed.sort(byUrgency); wanted.sort(byUrgency); remove.sort();
  return { insert: needed.concat(wanted.slice(0, ahead)).map(c => c.id), remove };
}

const point = (id: string, x: number, z: number): CollisionCellRef => ({ id, boundsXZ: [x, z, x, z] });

test('wanted priority includes sources outside their own unequal rings', () => {
  const cells = [point('a', 8, 0), point('b', 12, 0)];
  const sources = [{ x: 0, z: 0, need: 0, want: 20, keep: 20 }, { x: 14, z: 0, need: 1, want: 1, keep: 1 }];
  // b is outside the second source's insertion radius, but that source gives it urgency 1.
  assert.deepEqual(new CollisionResidency(cells, []).plan(sources, new Set(), 1), { insert: ['b'], remove: [] });
});

test('inclusive axis/diagonal boundaries, urgency ties and independent keep rings retain original order', () => {
  const cells = [point('z-axis', 5, 0), point('a-diagonal', 3, 4), point('b-axis', 0, -5),
    point('outside', 3, 4 + 1e-10), point('keep-edge', 0, 9), point('remove-z', 20, 20), point('remove-a', -20, -20)];
  const sources = [{ x: 0, z: 0, need: 5, want: 3, keep: 9 }];
  const resident = new Set(['keep-edge', 'remove-z', 'remove-a']);
  const result = new CollisionResidency(cells, []).plan(sources, resident, Infinity);
  assert.deepEqual(result, reference(cells, sources, resident, Infinity));
  assert.deepEqual(result, { insert: ['a-diagonal', 'b-axis', 'z-axis'], remove: ['remove-a', 'remove-z'] });
});

test('empty sources, pins, crossing extents and zero rings preserve exact plans', () => {
  const cells: CollisionCellRef[] = [{ id: 'crossing', boundsXZ: [-128, -1, 256, 1] }, point('touch', 0, 0), point('away', 1, 1)];
  const pin = { x: 0, z: 0, need: 0, want: 0, keep: 0 };
  for (const pins of [[], [pin]]) for (const resident of [new Set<string>(), new Set(cells.map(c => c.id))]) {
    assert.deepEqual(new CollisionResidency(cells, pins).plan([], resident, 1), reference(cells, pins, resident, 1));
  }
});

test('conservative broadphase matches all-distance plans through varied city cells and unequal rings', () => {
  let seed = 0x42cf97a1;
  const random = () => { seed = Math.imul(seed ^ seed >>> 15, 1 | seed); seed ^= seed + Math.imul(seed ^ seed >>> 7, 61 | seed); return ((seed ^ seed >>> 14) >>> 0) / 2 ** 32; };
  for (let fixture = 0; fixture < 100; fixture++) {
    const cells = Array.from({ length: 160 }, (_, i): CollisionCellRef => {
      const x = Math.floor(random() * 40 - 20) * 128, z = Math.floor(random() * 40 - 20) * 128;
      return { id: `cell-${String(159 - i).padStart(3, '0')}`, boundsXZ: [x - random() * 80, z - random() * 80, x + random() * 200, z + random() * 200] };
    });
    const sources = Array.from({ length: 24 }, (): ResidencySource => ({ x: random() * 5000 - 2500, z: random() * 5000 - 2500,
      need: random() * 280, want: random() * 320, keep: random() * 400 }));
    const pins = sources.splice(0, 4);
    const resident = new Set(cells.filter(() => random() < .6).map(c => c.id));
    const planner = new CollisionResidency(cells, pins);
    for (const ahead of [0, 1, 4, Infinity]) {
      assert.deepEqual(planner.plan(sources, resident, ahead), reference(cells, sources.concat(pins), resident, ahead), `fixture ${fixture}, ahead ${ahead}`);
    }
  }
});
