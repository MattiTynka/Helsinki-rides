import type { VehicleDefinition } from '@helsinki/world-schema';
import { CHARACTER, FEET_TO_CENTRE } from './character.ts';
import { clamp, type V3 } from './math.ts';
import { GROUP, groups, RAPIER, type StaticWorld } from './world.ts';

interface Placement { readonly position: V3; readonly yaw: number }
interface Candidate { readonly x: number; readonly z: number; readonly yaw: number }
interface Footprint {
  readonly radius: number;
  readonly points: readonly (readonly [number, number])[];
  readonly clearance: (position: V3, yaw: number) => boolean;
}

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const CHARACTER_MARGIN = CHARACTER.radius + 0.15;

/** Recovery destinations must have collision support, not merely a clamped terrain sample. */
export class SafeSpawns {
  readonly bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  private fallback: Candidate;
  private readonly world: StaticWorld;

  constructor(world: StaticWorld) {
    this.world = world;
    const t = world.terrain, p = world.gameplay.playArea, spawn = world.gameplay.player.spawn;
    this.bounds = {
      minX: Math.max(p.minX, t.x0), maxX: Math.min(p.maxX, t.x0 + (t.nx - 1) * t.resolution),
      minZ: Math.max(p.minZ, t.z0), maxZ: Math.min(p.maxZ, t.z0 + (t.nz - 1) * t.resolution),
    };
    if (this.bounds.minX >= this.bounds.maxX || this.bounds.minZ >= this.bounds.maxZ) throw new Error('The playable area has no terrain coverage');
    this.fallback = { x: spawn.position[0], z: spawn.position[1], yaw: Math.PI - spawn.headingDeg * Math.PI / 180 };
  }

  contains(x: number, z: number, margin = 0): boolean {
    const b = this.bounds;
    return Number.isFinite(x) && Number.isFinite(z) && x >= b.minX + margin && x <= b.maxX - margin && z >= b.minZ + margin && z <= b.maxZ - margin;
  }

  character(x: number, z: number, yaw: number, excludeBody?: RAPIER.RigidBody, preferRoad = false): Placement {
    const shape = new RAPIER.Capsule(CHARACTER.halfHeight, CHARACTER.radius);
    return this.find({ x, z, yaw }, {
      radius: CHARACTER_MARGIN,
      points: [[0, 0], [CHARACTER_MARGIN, 0], [-CHARACTER_MARGIN, 0], [0, CHARACTER_MARGIN], [0, -CHARACTER_MARGIN]],
      clearance: p => !this.world.physics.intersectionWithShape(
        { x: p[0], y: p[1] + FEET_TO_CENTRE + 0.06, z: p[2] }, IDENTITY, shape,
        undefined, groups(GROUP.character, GROUP.static | GROUP.vehicle | GROUP.character), undefined, excludeBody),
    }, preferRoad);
  }

  vehicle(x: number, z: number, yaw: number, def: VehicleDefinition, excludeBody?: RAPIER.RigidBody, preferRoad = false): Placement {
    const he = def.collider.halfExtents, c = def.collider.centre;
    const halfX = Math.max(Math.abs(c[0]) + he[0], ...def.wheels.map(w => Math.abs(w.position[0]) + def.wheelWidth / 2)) + 0.2;
    const halfZ = Math.max(Math.abs(c[2]) + he[2], ...def.wheels.map(w => Math.abs(w.position[2]) + def.wheelRadius)) + 0.2;
    const boxes = [def.collider, ...(def.collider.skid ? [def.collider.skid] : [])];
    return this.find({ x, z, yaw }, {
      radius: Math.hypot(halfX, halfZ),
      points: [[0, 0], [-halfX, -halfZ], [halfX, -halfZ], [-halfX, halfZ], [halfX, halfZ], ...def.wheels.map(w => [w.position[0], w.position[2]] as const)],
      clearance: (p, angle) => boxes.every(box => {
        const [dx, dz] = rotateXZ(box.centre[0], box.centre[2], angle);
        return !this.world.physics.intersectionWithShape(
          { x: p[0] + dx, y: p[1] + 0.3 + box.centre[1], z: p[2] + dz },
          { x: 0, y: Math.sin(angle / 2), z: 0, w: Math.cos(angle / 2) }, new RAPIER.Cuboid(...box.halfExtents),
          undefined, groups(GROUP.vehicle, GROUP.static | GROUP.vehicle | GROUP.character), undefined, excludeBody);
      }),
    }, preferRoad);
  }

  rememberInitial(position: V3, yaw: number): void {
    this.fallback = { x: position[0], z: position[2], yaw };
  }

  private find(preferred: Candidate, footprint: Footprint, preferRoad: boolean): Placement {
    const b = this.bounds, r = footprint.radius;
    if (b.maxX - b.minX <= 2 * r || b.maxZ - b.minZ <= 2 * r) throw new Error('The playable area is smaller than the recovery footprint');
    const candidates: Candidate[] = [];
    if (!preferRoad) candidates.push(preferred);
    candidates.push(...this.roadCandidates(preferred, r));
    candidates.push(this.fallback);
    if (!this.contains(this.fallback.x, this.fallback.z, r)) candidates.push({ x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2, yaw: 0 });
    // Search around the known safe start before a fixed, bounded whole-map grid. This also
    // allows recovery when a car now occupies the exact start or a configured anchor is bad.
    for (const distance of [3, 6, 12]) for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      candidates.push({ x: this.fallback.x + Math.cos(a) * distance, z: this.fallback.z + Math.sin(a) * distance, yaw: this.fallback.yaw });
    }
    for (let iz = 0; iz <= 16; iz++) for (let ix = 0; ix <= 16; ix++) candidates.push({
      x: b.minX + r + (b.maxX - b.minX - 2 * r) * ix / 16,
      z: b.minZ + r + (b.maxZ - b.minZ - 2 * r) * iz / 16,
      yaw: this.fallback.yaw,
    });
    for (const candidate of candidates) {
      const placed = this.validate(candidate, footprint);
      if (placed) return placed;
    }
    throw new Error('No supported, clear recovery point exists inside the playable terrain');
  }

  private validate(c: Candidate, footprint: Footprint): Placement | null {
    if (!Number.isFinite(c.yaw) || !this.contains(c.x, c.z)) return null;
    const heights: number[] = [];
    for (const [px, pz] of footprint.points) {
      const [dx, dz] = rotateXZ(px, pz, c.yaw), x = c.x + dx, z = c.z + dz;
      if (!this.contains(x, z, 0.05)) return null;
      const terrain = this.world.groundHeight(x, z);
      const ray = new RAPIER.Ray({ x, y: terrain + 8, z }, { x: 0, y: -1, z: 0 });
      const hit = this.world.physics.castRayAndGetNormal(ray, 40, false, undefined, groups(GROUP.bullet, GROUP.static));
      if (!hit || hit.normal.y < 0.75) return null;
      const surface = this.world.surfaceAt(hit.collider.handle, null);
      if (surface && surface.group !== 'ground' && surface.group !== 'terrain') return null;
      const y = terrain + 8 - hit.timeOfImpact;
      if (!Number.isFinite(y) || y < this.world.gameplay.killHeight + 2) return null;
      heights.push(y);
    }
    const max = Math.max(...heights), min = Math.min(...heights);
    if (max - min > 0.45) return null;
    const position: V3 = [c.x, max, c.z];
    return footprint.clearance(position, c.yaw) ? { position, yaw: c.yaw } : null;
  }

  /** Project onto clipped lane segments, so an outside road can never win nearest-road recovery. */
  private roadCandidates(preferred: Candidate, margin: number): Candidate[] {
    const b = this.bounds, candidates: Candidate[] = [];
    for (const lane of this.world.roads.graph.lanes) for (let i = 1; i < lane.points.length; i++) {
      const a = lane.points[i - 1]!, end = lane.points[i]!, dx = end[0] - a[0], dz = end[2] - a[2];
      if (!a.every(Number.isFinite) || !end.every(Number.isFinite) || Math.hypot(dx, dz) < 0.01) continue;
      let lo = 0, hi = 1;
      for (const [origin, delta, min, max] of [[a[0], dx, b.minX + margin, b.maxX - margin], [a[2], dz, b.minZ + margin, b.maxZ - margin]]) {
        if (Math.abs(delta!) < 1e-8) { if (origin! < min! || origin! > max!) { lo = 1; hi = 0; } }
        else { const t1 = (min! - origin!) / delta!, t2 = (max! - origin!) / delta!; lo = Math.max(lo, Math.min(t1, t2)); hi = Math.min(hi, Math.max(t1, t2)); }
      }
      if (lo > hi) continue;
      const projection = ((preferred.x - a[0]) * dx + (preferred.z - a[2]) * dz) / (dx * dx + dz * dz);
      const yaw = Math.atan2(dx, dz);
      for (const t of [clamp(Number.isFinite(projection) ? projection : 0.5, lo, hi), (lo + hi) / 2, lo, hi]) candidates.push({ x: a[0] + dx * t, z: a[2] + dz * t, yaw });
    }
    const x = Number.isFinite(preferred.x) ? preferred.x : this.fallback.x, z = Number.isFinite(preferred.z) ? preferred.z : this.fallback.z;
    candidates.sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z));
    return candidates.slice(0, 128);
  }
}

function rotateXZ(x: number, z: number, yaw: number): [number, number] {
  return [x * Math.cos(yaw) + z * Math.sin(yaw), z * Math.cos(yaw) - x * Math.sin(yaw)];
}
