import assert from 'node:assert/strict';
import test from 'node:test';
import type { SimState, VehicleState } from '../../../packages/sim/src/index.ts';
import { selectRamPatrol } from '../lib/journey-patrol.ts';

const car = (id: string, z: number, overrides: Partial<VehicleState> = {}): VehicleState => ({
  id, position: [0, 0, z], rotation: [0, 0, 0, 1], damage: 'intact', ...overrides,
} as VehicleState);
const state = (vehicles: VehicleState[]): SimState => ({
  player: { position: [0, 0, 0], inVehicle: 'player-car' }, vehicles,
  police: vehicles.filter(v => v.id.startsWith('police')).map(v => ({ vehicleId: v.id, state: 'pursue' })),
} as unknown as SimState);

test('ram approach skips an overturned patrol and civilian cars', () => {
  // Measured rotation of the patrol trapped against a facade in the failed native journey.
  const overturned = car('police-1', 4, { rotation: [.4936122, -.5273923, .4711784, -.5061575] });
  const upright = car('police-2', 12);
  assert.equal(selectRamPatrol(state([car('civilian', 1), overturned, upright]), null), upright);
  assert.equal(selectRamPatrol(state([overturned]), null), null);
});

test('ram approach keeps the chosen patrol when another unit becomes slightly nearer', () => {
  const chosen = car('police-2', 12), closer = car('police-3', 11);
  assert.equal(selectRamPatrol(state([closer, chosen]), chosen.id), chosen);
  assert.equal(selectRamPatrol(state([closer]), chosen.id), closer, 'retired target is replaced');
});

test('ram approach replaces disabled, wrecked, overturned or player-controlled targets', () => {
  const replacement = car('police-2', 12);
  for (const invalid of [car('police-1', 4, { damage: 'wrecked' }), car('police-1', 4, { rotation: [1, 0, 0, 0] })]) {
    assert.equal(selectRamPatrol(state([invalid, replacement]), invalid.id), replacement);
  }
  const observed = state([car('police-1', 4), replacement]);
  assert.equal(selectRamPatrol({ ...observed, police: observed.police.map((unit, i) => i === 0 ? { ...unit, state: 'disabled' } : unit) }, 'police-1'), replacement);
  assert.equal(selectRamPatrol({ ...observed, player: { ...observed.player, inVehicle: 'police-1' } }, 'police-1'), replacement);
});
