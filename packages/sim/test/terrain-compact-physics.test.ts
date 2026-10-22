import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeCompactTerrain, encodeTerrain, type GameplayBundle, type RoadGraph } from '@helsinki/world-schema';
import { initPhysics, RAPIER, StaticWorld } from '../src/index.ts';

test('compact transport keeps native Rapier heightfields, support rays and falling-body contacts identical', async () => {
  await initPhysics();
  const nx = 19, nz = 23;
  const terrain = {
    x0: -9, z0: -11, resolution: 1, nx, nz,
    heights: Float32Array.from({ length: nx * nz }, (_, index) => 3 + Math.sin(index % nx / 3) * .4 + Math.cos(Math.floor(index / nx) / 4) * .3),
  };
  terrain.heights[0] = -0;
  const roads: RoadGraph = { schemaVersion: 2, originId: 'fixture', source: { id: 'fixture', sha256: '0'.repeat(64), attribution: 'fixture', license: 'fixture' }, nodes: [], lanes: [], connectors: [], parking: [], footways: [] };
  const worlds = [encodeTerrain(terrain), encodeCompactTerrain(terrain)].map(bytes => StaticWorld.fromBytes(bytes, roads, {} as GameplayBundle));
  try {
    const fields = worlds.map(world => {
      const result: RAPIER.Collider[] = [];
      world.physics.forEachCollider(collider => result.push(collider));
      assert.equal(result.length, 1);
      return result[0]!;
    });
    assert.deepEqual(fields[0]!.heightfieldHeights(), fields[1]!.heightfieldHeights());
    assert.deepEqual(fields[0]!.translation(), fields[1]!.translation());
    for (let z = -10.75; z < 10; z += .71) for (let x = -8.75; x < 8; x += .83) {
      assert.equal(worlds[0]!.groundHeight(x, z), worlds[1]!.groundHeight(x, z));
      assert.deepEqual(worlds[0]!.groundBelow(x, 15, z, 30), worlds[1]!.groundBelow(x, 15, z, 30));
    }
    const bodies = worlds.map(world => {
      const body = world.physics.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(.3, 10, .7));
      world.physics.createCollider(RAPIER.ColliderDesc.ball(.3), body);
      return body;
    });
    for (let tick = 0; tick < 300; tick++) {
      worlds.forEach(world => world.physics.step());
      assert.deepEqual(bodies[0]!.translation(), bodies[1]!.translation());
      assert.deepEqual(bodies[0]!.linvel(), bodies[1]!.linvel());
    }
  } finally { worlds.forEach(world => world.physics.free()); }
});
