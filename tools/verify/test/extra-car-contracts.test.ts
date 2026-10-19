import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { vehiclePoses } from '../../../apps/game/src/render/native-vehicle-animation.ts';
import { validateGameplayBundle, type VehicleDefinition } from '../../../packages/world-schema/src/index.ts';

// Portable source regression: binary asset/renderer acceptance belongs to verify-extra-cars.mjs.
const read = (relative: string) => JSON.parse(readFileSync(new URL(`../../../${relative}`, import.meta.url), 'utf8'));
const cars = [
  { id: 'revontuli', spawn: 'car-3', position: [-35.5, 10], sha256: '7e35d6a031433dbd4054a587da8195737dddddb3c87efc950e9ffd403c0262e7' },
  { id: 'kaamos', spawn: 'car-4', position: [-41, 10], sha256: '01d9f51ee1e19637ed479246991891c9a0f0fb54f9f4e87da43ab18583b766f3' },
] as const;
const sourceFiles = ['content/helsinki/city-north-20261019/gameplay-base.json', 'content/helsinki/city-north-20261019/gameplay-v1.json'];
const reference = read('content/helsinki/central-expansion/gameplay.json');

for (const car of cars) {
  test(`${car.id}: accepted car contract and native Finn pose set stay bound together`, () => {
    const contract = read(`content/assets/vehicle-${car.id}.contract.json`);
    const poses = read(`content/assets/finn-vehicle-poses-${car.id}.json`);
    const definition = reference.vehicleDefinitions.find((d: VehicleDefinition) => d.id === car.id) as VehicleDefinition;
    assert.ok(definition);
    assert.equal(definition.assetId, `vehicle-${car.id}`);
    assert.equal(contract.assetId, `vehicle-${car.id}-v1`);
    assert.deepEqual(contract.axes, { up: '+Y', forward: '+Z', left: '+X', units: 'metres', scale: 1 });
    assert.equal(contract.rootAtGroundBetweenAxles, true);
    assert.equal(poses.carSha256, car.sha256);
    assert.equal(poses.sourcePackagedSha256, 'c54802ad951926a1574576e6797ff73a9744c86707614a1e81e3f307f212fe86');
    assert.deepEqual(vehiclePoses(definition), poses, 'runtime selects this car\'s authored cabin motion');
    const { poses: selected, ...geometry } = definition.interaction!;
    assert.equal(selected, car.id);
    assert.deepEqual(geometry, poses.interaction, 'simulation clearance and animation use the same car-local path');
    assert.deepEqual(definition.wheels.map(w => w.socket).sort(), [...contract.nodes.wheels].sort());
    const wheels = definition.wheels.map(w => w.position);
    const wheelbase = Math.max(...wheels.map(w => w[2])) - Math.min(...wheels.map(w => w[2]));
    const [min, max] = contract.expectedDimensions.wheelbaseM;
    assert.ok(wheelbase >= min && wheelbase <= max);
    assert.ok(definition.wheelRadius >= contract.expectedDimensions.wheelRadiusM[0] && definition.wheelRadius <= contract.expectedDimensions.wheelRadiusM[1]);
    const clips = ['enter', 'exit', 'exitPassenger', 'exitWindshield', 'exitFlipped', 'exitFlippedPassenger'];
    assert.deepEqual(Object.keys(poses.clips).sort(), clips.sort());
    for (const clip of Object.values(poses.clips) as { frames: { time: number; hips: number[]; rotations: Record<string, number[]> }[] }[]) {
      assert.ok(clip.frames.length > 20);
      assert.equal(clip.frames[0]!.time, 0);
      assert.equal(clip.frames.at(-1)!.time, 1);
      for (const frame of clip.frames) {
        assert.equal(Object.keys(frame.rotations).length, 71);
        assert.ok([...frame.hips, ...Object.values(frame.rotations).flat()].every(Number.isFinite));
      }
    }
  });
}

for (const file of sourceFiles) {
  test(`${file}: the current expanded city retains both extra-car definitions and Senate Square spawns`, () => {
    const gameplay = read(file);
    const errors = validateGameplayBundle({ ...gameplay, addresses: gameplay.addresses ?? [] });
    assert.deepEqual(errors, []);
    assert.ok(gameplay.playArea.minX <= -1792 && gameplay.playArea.maxX >= 800 && gameplay.playArea.minZ <= -1152 && gameplay.playArea.maxZ >= 450,
      'adding cars must preserve the current expanded play area');
    assert.equal(new Set(gameplay.vehicleDefinitions.map((d: VehicleDefinition) => d.id)).size, gameplay.vehicleDefinitions.length);
    assert.equal(new Set(gameplay.vehicles.map((v: { id: string }) => v.id)).size, gameplay.vehicles.length);
    for (const car of cars) {
      const definition = gameplay.vehicleDefinitions.find((d: VehicleDefinition) => d.id === car.id);
      assert.deepEqual(definition, reference.vehicleDefinitions.find((d: VehicleDefinition) => d.id === car.id), 'retain the measured collider, suspension and cabin fit');
      assert.deepEqual(gameplay.vehicles.find((v: { id: string }) => v.id === car.spawn), {
        id: car.spawn, definition: car.id, position: [...car.position], headingDeg: 358, occupied: false,
      });
    }
    for (const retained of ['car-1', 'car-2', 'parked-1', 'parked-2', 'parked-3', 'parked-4', 'parked-5', 'parked-6']) {
      assert.ok(gameplay.vehicles.some((v: { id: string }) => v.id === retained), `existing ${retained} remains`);
    }
  });
}
