import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CellDescriptor } from '../../../packages/world-schema/src/index.ts';
import type { CollisionCellRef, ResidencySource } from '../../../packages/sim/src/index.ts';
import { CollisionStream } from '../../../apps/game/src/world/collision-stream.ts';

const options = { concurrency: 0, playerMargin: 160, actorMargin: 48, lookaheadSeconds: 4 };

/** Original full-distance ranking; concurrency zero makes the actual queue observable without fetches. */
function reference(extents: readonly CollisionCellRef[], sources: readonly ResidencySource[], velocity: readonly [number, number]) {
  const focus = sources.map((s, i) => ({ x: s.x, z: s.z, radius: s.want + (i === 0 ? options.playerMargin : options.actorMargin) }));
  if (sources[0]) focus.push({ x: sources[0].x + velocity[0] * options.lookaheadSeconds, z: sources[0].z + velocity[1] * options.lookaheadSeconds, radius: sources[0].want });
  const ranked: { id: string; d: number }[] = [];
  for (const cell of extents) {
    let d = Infinity;
    for (const f of focus) {
      const b = cell.boundsXZ;
      d = Math.min(d, Math.hypot(Math.max(b[0] - f.x, 0, f.x - b[2]), Math.max(b[1] - f.z, 0, f.z - b[3])) - f.radius);
    }
    if (d <= 0) ranked.push({ id: cell.id, d });
  }
  ranked.sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : 1));
  return ranked.map(r => r.id);
}

function actual(extents: readonly CollisionCellRef[], sources: readonly ResidencySource[], velocity: readonly [number, number]) {
  const cells = extents.map(c => ({ id: c.id, collision: { path: `${c.id}.bin` } }) as CellDescriptor);
  const stream = new CollisionStream('https://example.invalid/', cells, extents, new Map(), options);
  stream.update(sources, velocity);
  const inspect = stream as unknown as { queue: string[]; prefetch: Set<string> };
  assert.deepEqual(inspect.queue, [...inspect.prefetch], 'queue and retention order match');
  assert.equal(stream.stats().pending, 0, 'ranking does not fetch in this fixture');
  return inspect.queue;
}

test('prefetch retains exact inclusive diagonal/axis boundaries and lexicographic rank ties', () => {
  const extents: CollisionCellRef[] = [
    { id: 'z-diagonal', boundsXZ: [120, 160, 120, 160] },
    { id: 'a-axis', boundsXZ: [200, 0, 200, 0] },
    { id: 'outside', boundsXZ: [120, 160 + 1e-10, 120, 160 + 1e-10] },
  ];
  const sources = [{ x: 0, z: 0, need: 10, want: 40, keep: 60 }];
  assert.deepEqual(actual(extents, sources, [0, 0]), ['a-axis', 'z-diagonal']);
});

test('prefetch preserves unequal-radius priorities and motion lookahead', () => {
  const extents = Array.from({ length: 30 }, (_, i): CollisionCellRef => ({ id: `cell-${i}`, boundsXZ: [i * 80 - 1000, -64, i * 80 - 920, 64] }));
  const sources = [{ x: 0, z: 0, need: 128, want: 152, keep: 216 }, { x: 400, z: 50, need: 1, want: 4, keep: 8 },
    { x: -600, z: 120, need: 250, want: 280, keep: 350 }];
  for (const velocity of [[0, 0], [70, 0], [-40, 13]] as const) {
    assert.deepEqual(actual(extents, sources, velocity), reference(extents, sources, velocity));
  }
  assert.deepEqual(actual(extents, [], [0, 0]), []);
});

test('prefetch broadphase keeps the full all-distance ranked list across varied city extents', () => {
  let seed = 0x92af136c;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let fixture = 0; fixture < 100; fixture++) {
    const cells = Array.from({ length: 200 }, (_, i): CollisionCellRef => {
      const x = random() * 6000 - 3000, z = random() * 6000 - 3000;
      return { id: `cell-${i}`, boundsXZ: [x - random() * 120, z - random() * 120, x + random() * 200, z + random() * 200] };
    });
    const sources = Array.from({ length: 30 }, (): ResidencySource => ({ x: random() * 6000 - 3000, z: random() * 6000 - 3000,
      need: random() * 320, want: random() * 320, keep: random() * 320 }));
    const velocity: [number, number] = [random() * 160 - 80, random() * 160 - 80];
    assert.deepEqual(actual(cells, sources, velocity), reference(cells, sources, velocity), `fixture ${fixture}`);
  }
});
