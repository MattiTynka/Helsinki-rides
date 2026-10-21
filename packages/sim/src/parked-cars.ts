import { pointAlong, type RoadGraph, type Vec3, type VehicleDefinition } from '@helsinki/world-schema';
import { TICK_HZ } from './commands.ts';
import { distanceXZ, fnv1a } from './math.ts';
import type { Simulation } from './simulation.ts';

export const PARKED_CARS = {
  target: 12, spawnMin: 28, spawnMax: 120, keepNear: 180, retireDistance: 260,
  retireAfterTicks: 2 * TICK_HZ, refreshTicks: TICK_HZ, attemptsPerRefresh: 48,
  birthsPerRefresh: 2, spacing: 11, retryTicks: 4 * TICK_HZ, slotCooldownTicks: 30 * TICK_HZ,
} as const;

export interface ParkingSlot {
  readonly id: string;
  readonly position: Vec3;
  readonly yaw: number;
  readonly source: 'parking' | 'curb';
}

/** Municipal parking slots first; outer edges of ordinary streets fill districts without marked lots.
 * Every proposed slot still needs native collision support and clearance at runtime. */
export function cityParkingSlots(roads: RoadGraph): ParkingSlot[] {
  const slots: ParkingSlot[] = [];
  for (const parking of roads.parking) for (const [i, position] of parking.points.entries()) {
    if (parking.heading === null || !position.every(Number.isFinite)) continue;
    slots.push({ id: `parking:${parking.id}:${i}`, position, yaw: Math.PI - parking.heading * Math.PI / 180, source: 'parking' });
  }
  for (const lane of roads.lanes) {
    if (!['residential', 'unclassified', 'service', 'tertiary', 'secondary'].includes(lane.highway)
      || lane.index !== lane.count - 1 || lane.length < 32 || !(lane.width > 0)) continue;
    for (let s = 16; s <= lane.length - 16; s += 24) {
      const { point, tangent: [dx, dz] } = pointAlong(lane.points, s);
      // Right of travel is (-dz, dx). Leave the complete traffic lane and put the driver's door on its side.
      const offset = lane.width / 2 + 1.45;
      const position: Vec3 = [point[0] - dz * offset, point[1], point[2] + dx * offset];
      slots.push({ id: `curb:${lane.id}:${s}`, position, yaw: Math.atan2(dx, dz), source: 'curb' });
    }
  }
  return slots;
}

interface ActiveCar { readonly id: string; readonly slot: string; lastNearTick: number }
const GRID = 64;
const key = (x: number, z: number): string => `${Math.floor(x / GRID)},${Math.floor(z / GRID)}`;

/** Only nearby cars become physics bodies. Retiring distant cars releases both collision residency and GPU views. */
export class ParkedCars {
  private readonly slots = new Map<string, ParkingSlot[]>();
  private readonly active = new Map<string, ActiveCar>();
  private readonly unavailableUntil = new Map<string, number>();
  private readonly junctions = new Map<string, Vec3[]>();
  private readonly definitions: readonly VehicleDefinition[];
  private readonly sim: Simulation;
  private serial = 0;
  private cursor = 0;

  constructor(sim: Simulation) {
    this.sim = sim;
    this.definitions = sim.gameplay.vehicleDefinitions.filter(d => d.role === 'civilian');
    for (const slot of cityParkingSlots(sim.world.roads.graph)) {
      const k = key(slot.position[0], slot.position[2]);
      const bucket = this.slots.get(k) ?? [];
      bucket.push(slot); this.slots.set(k, bucket);
    }
    for (const node of sim.world.roads.graph.nodes) {
      if (node.kind !== 'junction') continue;
      const k = key(node.position[0], node.position[2]), bucket = this.junctions.get(k) ?? [];
      bucket.push(node.position); this.junctions.set(k, bucket);
    }
  }

  step(): void {
    const sim = this.sim;
    if (sim.tick % PARKED_CARS.refreshTicks !== 1 || !this.definitions.length) return;
    const player = sim.playerPosition;
    for (const [slot, record] of this.active) {
      const vehicle = sim.vehicles.get(record.id);
      if (!vehicle) { this.active.delete(slot); continue; }
      const distance = distanceXZ(vehicle.position, player);
      if (distance <= PARKED_CARS.keepNear || vehicle.driver || vehicle.occupants.size) record.lastNearTick = sim.tick;
      if (distance > PARKED_CARS.retireDistance && sim.tick - record.lastNearTick >= PARKED_CARS.retireAfterTicks
        && sim.removeVehicle(vehicle)) {
        this.active.delete(slot);
        this.unavailableUntil.set(slot, sim.tick + PARKED_CARS.slotCooldownTicks);
        sim.emit('parkedCarDespawn', vehicle.id);
      }
    }
    // Expire cooldowns as well as bodies: visiting more districts must not grow session bookkeeping forever.
    for (const [id, until] of this.unavailableUntil) if (until <= sim.tick) this.unavailableUntil.delete(id);
    if (sim.mode === 'wasted' || sim.mode === 'busted' || this.active.size >= PARKED_CARS.target) return;
    const candidates: ParkingSlot[] = [];
    this.nearby(this.slots, player[0], player[2], PARKED_CARS.spawnMax, slot => {
      const distance = distanceXZ(slot.position, player);
      if (distance >= PARKED_CARS.spawnMin && distance <= PARKED_CARS.spawnMax
        && !this.active.has(slot.id) && !this.unavailableUntil.has(slot.id)) candidates.push(slot);
    });
    candidates.sort((a, b) => Number(a.source === 'curb') - Number(b.source === 'curb')
      || distanceXZ(a.position, player) - distanceXZ(b.position, player) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let born = 0;
    for (let tries = 0; tries < Math.min(candidates.length, PARKED_CARS.attemptsPerRefresh)
      && born < PARKED_CARS.birthsPerRefresh && this.active.size < PARKED_CARS.target; tries++) {
      const slot = candidates[(this.cursor + tries) % candidates.length]!;
      if ([...sim.vehicles.values()].some(v => distanceXZ(v.position, slot.position) < PARKED_CARS.spacing)) continue;
      const definition = this.definitions[Number.parseInt(fnv1a(slot.id), 16) % this.definitions.length]!;
      if (!this.clearRoad(slot, definition)) { this.unavailableUntil.set(slot.id, sim.tick + PARKED_CARS.retryTicks); continue; }
      const vehicle = sim.trySpawnVehicle(`city-car-${++this.serial}`, definition.id,
        [slot.position[0], slot.position[2]], slot.yaw, slot.position[1]);
      if (!vehicle) { this.unavailableUntil.set(slot.id, sim.tick + PARKED_CARS.retryTicks); continue; }
      this.active.set(slot.id, { id: vehicle.id, slot: slot.id, lastNearTick: sim.tick });
      sim.emit('parkedCarSpawn', vehicle.id); born++;
    }
    this.cursor += PARKED_CARS.attemptsPerRefresh;
  }

  private clearRoad(slot: ParkingSlot, def: VehicleDefinition): boolean {
    const [x, , z] = slot.position;
    let nearJunction = false;
    if (slot.source === 'curb') this.nearby(this.junctions, x, z, 16, p => {
      if (distanceXZ(p, slot.position) < 16) nearJunction = true;
    });
    if (nearJunction) return false;
    const he = def.collider.halfExtents, c = def.collider.centre, sin = Math.sin(slot.yaw), cos = Math.cos(slot.yaw);
    for (const px of [-he[0] - 0.2, 0, he[0] + 0.2]) for (const pz of [-he[2] - 0.3, 0, he[2] + 0.3]) {
      const hit = this.sim.world.roads.nearestLane(x + (c[0] + px) * cos + (c[2] + pz) * sin,
        z + (c[2] + pz) * cos - (c[0] + px) * sin, undefined, 8);
      if (hit && hit.distance < this.sim.world.roads.laneById.get(hit.laneId)!.width / 2 + 0.15) return false;
    }
    return true;
  }

  private nearby<T>(grid: ReadonlyMap<string, readonly T[]>, x: number, z: number, radius: number, visit: (value: T) => void): void {
    for (let iz = Math.floor((z - radius) / GRID); iz <= Math.floor((z + radius) / GRID); iz++)
      for (let ix = Math.floor((x - radius) / GRID); ix <= Math.floor((x + radius) / GRID); ix++)
        for (const value of grid.get(`${ix},${iz}`) ?? []) visit(value);
  }
}
