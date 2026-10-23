import type { SimState, VehicleState } from '../../../packages/sim/src/index.ts';

/** Choose a driving target from observed state; never alter a unit or manufacture a ram event. */
export function selectRamPatrol(state: SimState, previousId: string | null): VehicleState | null {
  const patrolIds = new Set(state.police.filter(unit => unit.state !== 'disabled').map(unit => unit.vehicleId));
  const candidates = state.vehicles.filter(car => {
    const [x, , z] = car.rotation;
    return patrolIds.has(car.id) && car.id !== state.player.inVehicle && car.damage !== 'wrecked'
      // A patrol on its side can be trapped against a facade. Do not repeatedly ram its centre
      // while upright responding units are approaching on the road.
      && 1 - 2 * (x * x + z * z) >= .5;
  });
  const previous = candidates.find(car => car.id === previousId);
  if (previous) return previous;
  let nearest: VehicleState | null = null, nearestDistance = Infinity;
  for (const car of candidates) {
    const distance = Math.hypot(car.position[0] - state.player.position[0], car.position[2] - state.player.position[2]);
    if (distance < nearestDistance) { nearest = car; nearestDistance = distance; }
  }
  return nearest;
}
