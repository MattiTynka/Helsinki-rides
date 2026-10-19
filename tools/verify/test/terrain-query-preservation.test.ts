import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { initPhysics, RAPIER, StaticWorld } from '../../../packages/sim/src/index.ts';
import type { GameplayBundle, RoadGraph, TerrainGrid, TriMeshCollider } from '../../../packages/world-schema/src/index.ts';
import { encodeCollisionBundle } from '../../../packages/world-schema/src/index.ts';
import { provePreservedTerrainVertexQuery, type TerrainQueryPreservationOptions } from '../lib/terrain-query-preservation.ts';
import { exactGroundTriangles } from '../lib/ground-query-precision.ts';

before(initPhysics);
const terrain = (z0 = -6, nz = 10): TerrainGrid => ({ x0: -4, z0, nx: 9, nz, resolution: 1, heights: new Float32Array(9 * nz).fill(2) });
function fixture() {
  const beforeSource = terrain(), afterSource = terrain(-7, 11);
  const beforeWorld = new StaticWorld(terrain(), { lanes: [], footways: [], connectors: [] } as unknown as RoadGraph, {} as GameplayBundle);
  const afterWorld = new StaticWorld(terrain(-7, 11), { lanes: [], footways: [], connectors: [] } as unknown as RoadGraph, {} as GameplayBundle);
  beforeWorld.physics.step(); afterWorld.physics.step();
  // This minimal real Rapier field reproduces the center miss/hit solely by adding one north row.
  assert.equal(beforeWorld.groundBelow(0, 4, 0, 30), null);
  const options: TerrainQueryPreservationOptions = {
    x: 0, z: 0, originY: 4, observedBefore: null, observedAfter: afterWorld.groundBelow(0, 4, 0, 30),
    before: { source: beforeSource, world: beforeWorld, groundColliders: [], visualHeight: () => null },
    after: { source: afterSource, world: afterWorld, groundColliders: [], visualHeight: () => null },
  };
  return { options, cleanup: () => { beforeWorld.physics.free(); afterWorld.physics.free(); } };
}
function run(change?: (options: TerrainQueryPreservationOptions) => void) {
  const f = fixture(); try { change?.(f.options); return provePreservedTerrainVertexQuery(f.options); } finally { f.cleanup(); }
}

function addGround(options: TerrainQueryPreservationOptions) {
  for (const side of [options.before, options.after]) {
    const pieces: TriMeshCollider[] = [[-.5, -.0001], [.0001, .5]].map(([lo, hi], index) => ({
      id: `floor-${index}`, group: 'ground', ref: null,
      positions: Float32Array.from([lo!, 2.2, -.5, hi!, 2.2, -.5, hi!, 2.2, .5, lo!, 2.2, .5]),
      indices: Uint32Array.from([0, 2, 1, 0, 3, 2]), triangleTags: new Uint16Array(2),
    }));
    side.groundColliders = pieces;
    side.world.addCell('same-floor-cell', encodeCollisionBundle({ originId: 'test', frame: 'X-east,Y-up,Z-south', cell: 'same-floor-cell', surfaceTags: ['ground'] }, pieces));
    side.world.physics.step();
    side.visualHeight = (x, z) => { const triangles = exactGroundTriangles(pieces, x, z); return triangles.length ? Math.max(...triangles.map(t => t.height)) : null; };
    side.visualTrianglesNear = () => pieces.flatMap(piece => Array.from({ length: piece.indices.length / 3 }, (_, triangle) =>
      Array.from(piece.indices.subarray(triangle * 3, triangle * 3 + 3)).flatMap(index => Array.from(piece.positions.subarray(index * 3, index * 3 + 3)))));
  }
}

test('strict terrain qualification retains raw miss, 25 bit pairs, eight off-grid rays and two real shape contacts', () => {
  const result = run(); assert.equal(result.pass, true, JSON.stringify(result)); assert.equal(result.raw.before, null);
  assert.equal(result.neighborhoods.length, 25); assert.equal(result.neighbors.length, 8); assert.equal(result.cardinals.length, 4);
  assert.equal(result.shapes.length, 2); assert.equal(result.grids.length, 2); assert.equal(result.numericalBoundMetres, .0002);
});

test('a single changed source or runtime Float32 bit cannot qualify', () => {
  for (const kind of ['source', 'runtime'] as const) {
    const result = run(options => {
      const grid = kind === 'source' ? options.after.source : options.after.world.terrain;
      const values = new Uint32Array(grid.heights.buffer); values[(0 - grid.z0) * grid.nx + 0 - grid.x0]!++;
    });
    assert.equal(result.pass, false); assert.ok(result.failures.includes('changed-5x5-height-bits'));
  }
});

test('spacing, origin, dimensions and a nonvertex coordinate are not hidden by nearby support', () => {
  for (const mutate of [
    (o: TerrainQueryPreservationOptions) => { o.after.source = { ...o.after.source, resolution: 2 }; },
    (o: TerrainQueryPreservationOptions) => { o.after.source = { ...o.after.source, x0: -3.5 }; },
    (o: TerrainQueryPreservationOptions) => { o.after.source = { ...o.after.source, nx: 8 }; },
    (o: TerrainQueryPreservationOptions) => { o.x = .125; },
  ]) assert.equal(run(mutate).pass, false);
});

test('authored visual ground or an exact local HCOL triangle prevents terrain qualification', () => {
  assert.ok(run(o => { o.after.visualHeight = () => 1.6; }).failures.includes('center-has-authored-ground'));
  const floor: TriMeshCollider = { id: 'local-floor', group: 'ground', ref: null, positions: Float32Array.from([-1, 1.6, -1, 1, 1.6, -1, 0, 1.6, 1]), indices: Uint32Array.from([0, 1, 2]), triangleTags: new Uint16Array(1) };
  assert.ok(run(o => { o.before.groundColliders = [floor]; }).failures.includes('center-has-authored-ground'));
});

test('raw center, nonterrain surface and any off-grid contact change fail', () => {
  assert.ok(run(o => { o.observedAfter = { y: 1.59, surface: { tag: 'terrain', group: 'terrain', ref: null } }; }).failures.includes('raw-query-not-reproduced'));
  assert.ok(run(o => { o.observedAfter = { y: 1.6, surface: { tag: 'ground', group: 'ground', ref: null } }; }).failures.includes('not-one-null-and-one-terrain'));
  for (const change of ['miss', 'height', 'surface']) {
    const result = run(o => {
      const native = o.after.world.groundBelow.bind(o.after.world);
      o.after.world.groundBelow = (x, y, z, distance) => {
        const hit = native(x, y, z, distance); if (x === 0 || z === 0) return hit;
        return change === 'miss' ? null : change === 'height' ? { ...hit!, y: hit!.y + .00021 } : { ...hit!, surface: { tag: 'ground', group: 'ground', ref: null } };
      };
    });
    assert.equal(result.pass, false); assert.ok(result.failures.includes('off-grid-terrain-contact-changed'));
  }
});

test('native heightfield transform and actual local native height changes fail', () => {
  const translated = run(o => { o.after.world.physics.forEachCollider(c => c.setTranslation({ x: 0, y: -.399, z: -1 })); });
  assert.ok(translated.failures.includes('native-heightfield-transform-or-layout-changed'));
  const changed = run(o => {
    o.after.world.physics.forEachCollider(c => {
      const h = c.heightfieldHeights(); h[4 * 11 + 7] = 2.1;
      c.setShape(new RAPIER.Heightfield(10, 8, h, { x: 8, y: 1, z: 10 }));
    });
  });
  assert.ok(changed.failures.includes('native-heightfield-bits-changed'));
});

test('a real nonterrain obstruction caught by the centered shape prevents qualification', () => {
  const result = run(o => {
    o.before.world.physics.createCollider(RAPIER.ColliderDesc.ball(.001).setTranslation(.005, 1.62, 0));
    o.before.world.physics.step();
  });
  assert.equal(result.pass, false); assert.ok(result.failures.includes('centered-shape-not-preserved-terrain'));
});

test('a missing shape or more than 200 micrometres of paired shape-contact change fails', () => {
  const missing = run(o => { o.before.world.physics.castShape = () => null; });
  assert.ok(missing.failures.includes('centered-shape-unsupported'));
  const changed = run(o => {
    const cast = o.after.world.physics.castShape.bind(o.after.world.physics);
    o.after.world.physics.castShape = (...args) => {
      const hit = cast(...args); if (hit) hit.witness1 = { ...hit.witness1, x: hit.witness1.x + .00021 }; return hit;
    };
  });
  assert.ok(changed.failures.includes('centered-shape-contact-changed'));
});

test('a bit-exact original floor above the terrain ray seam provides preserved real physical support', () => {
  const result = run(addGround);
  assert.equal(result.pass, true, JSON.stringify(result));
  assert.ok(result.neighbors.every(row => row.before?.surface?.group === 'ground' && row.after?.surface?.group === 'ground'));
  assert.equal(result.localGround[0]!.count, 4); assert.equal(result.localGround[0]!.sha256, result.localGround[1]!.sha256);
  assert.ok(result.shapes.every(shape => shape.surface?.group === 'ground' && shape.identity !== null && shape.groundContact!.triangles.length > 0));
});

test('a one-bit local floor vertex, owner, tag, duplication or moved floor cannot qualify', () => {
  for (const change of ['bit', 'owner', 'tag', 'duplicate', 'move']) {
    const result = run(o => {
      addGround(o); const original = o.after.groundColliders[0]!;
      if (change === 'bit') { const b = new Uint32Array(original.positions.buffer); b[1]!++; }
      if (change === 'owner') o.after.groundColliders = [{ ...original, id: 'different-owner' }, o.after.groundColliders[1]!];
      if (change === 'tag') original.triangleTags[0] = 1;
      if (change === 'duplicate') o.after.groundColliders = [...o.after.groundColliders, original];
      if (change === 'move') for (let i = 1; i < original.positions.length; i += 3) original.positions[i]! += .001;
    });
    assert.equal(result.pass, false); assert.ok(result.failures.includes('local-authored-ground-triangles-changed'));
  }
});

test('ground shape contacts need decoded visual triangles and supported witness projections', () => {
  const wrongVisual = run(o => { addGround(o); o.after.visualHeight = (x, z) => x === 0 && z === 0 ? null : 2.21; });
  assert.ok(wrongVisual.failures.includes('ground-witness-visual-and-collision-projections-disagree'));
  const displacedContact = run(o => {
    addGround(o); const cast = o.after.world.physics.castShape.bind(o.after.world.physics);
    o.after.world.physics.castShape = (...args) => { const hit = cast(...args); if (hit) hit.witness1 = { x: 0, y: 2.201, z: 0 }; return hit; };
  });
  assert.ok(displacedContact.failures.includes('ground-shape-witness-not-visually-supported'));
  const missing = run(o => { addGround(o); o.after.visualTrianglesNear = undefined; });
  assert.ok(missing.failures.includes('ground-shape-decoded-visual-triangles-required'));
  const wrongTriangles = run(o => {
    addGround(o); const triangles = o.after.visualTrianglesNear!;
    o.after.visualTrianglesNear = (...args) => triangles(...args).map(t => t.map((n, i) => i % 3 === 1 ? n + .001 : n));
  });
  assert.ok(wrongTriangles.failures.includes('ground-shape-witness-not-visually-supported'));
});

test('paired ground ray surface and actual cell/collider identities must remain equal', () => {
  const changedSurface = run(o => {
    addGround(o); const native = o.after.world.groundBelow.bind(o.after.world);
    o.after.world.groundBelow = (...args) => { const hit = native(...args); return hit?.surface?.group === 'ground' ? { ...hit, surface: { ...hit.surface, ref: 'other-floor' } } : hit; };
  });
  assert.ok(changedSurface.failures.includes('off-grid-terrain-contact-changed'));
  const changedIdentity = run(o => {
    addGround(o); const handles = o.after.world.cellColliders.get('same-floor-cell')!;
    o.after.world.cellColliders.delete('same-floor-cell'); o.after.world.cellColliders.set('different-floor-cell', handles);
  });
  assert.ok(changedIdentity.failures.includes('centered-shape-contact-changed'));
});
