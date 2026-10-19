// Weapons (plan section 7): hitscan with spread and recoil, head shots, magazines and reloads. Rays run against
// the Rapier world; hits are resolved against characters (capsules) and vehicles (chassis) by collider handle.
import type { WeaponDefinition } from '@helsinki/world-schema';
import { normalize, type V3 } from './math.ts';
import { Rng } from './math.ts';
import { GROUP, groups, RAPIER, type StaticWorld } from './world.ts';

export interface WeaponSlot {
  readonly def: WeaponDefinition;
  magazine: number;
  reserve: number;
  cooldownTicks: number;
  reloadTicks: number;
}

export interface ShotResult {
  readonly origin: V3;
  readonly end: V3;
  readonly colliderHandle: number | null;
  readonly headshot: boolean;
  readonly distance: number;
}

export class Inventory {
  readonly slots: WeaponSlot[] = [];
  current = -1;

  add(def: WeaponDefinition, reserve: number): void {
    const existing = this.slots.find(s => s.def.id === def.id);
    if (existing) { existing.reserve += reserve; return; }
    this.slots.push({ def, magazine: def.magazine, reserve, cooldownTicks: 0, reloadTicks: 0 });
    if (this.current < 0) this.current = this.slots.length - 1;
  }

  get weapon(): WeaponSlot | null { return this.current >= 0 ? this.slots[this.current] ?? null : null; }

  /** `fists` means no weapon drawn. */
  select(index: number): void { this.current = index < this.slots.length ? index : -1; }

  step(): void {
    for (const s of this.slots) {
      if (s.cooldownTicks > 0) s.cooldownTicks--;
      if (s.reloadTicks > 0) { s.reloadTicks--; if (s.reloadTicks === 0) { const n = Math.min(s.def.magazine - s.magazine, s.reserve); s.magazine += n; s.reserve -= n; } }
    }
  }

  startReload(): boolean {
    const w = this.weapon;
    if (!w || w.reloadTicks > 0 || w.magazine >= w.def.magazine || w.reserve <= 0) return false;
    w.reloadTicks = Math.round(w.def.reloadSeconds * 60);
    return true;
  }

  stripAll(): void { this.slots.length = 0; this.current = -1; }
  stripAmmo(): void { for (const s of this.slots) { s.magazine = 0; s.reserve = 0; } }
}

/** Fire one hitscan round from `origin` toward `dir` with the weapon's spread; returns the hit or the end point. */
export function fireRay(world: StaticWorld, rng: Rng, origin: V3, dir: V3, def: WeaponDefinition, excludeBody: RAPIER.RigidBody | undefined, headCheck: (handle: number, point: V3) => boolean): ShotResult {
  const d = normalize(dir);
  // Spread: small random rotation in a cone.
  const spread = def.spreadDeg * Math.PI / 180;
  const a = rng.range(-spread, spread), b = rng.range(-spread, spread);
  const right: V3 = normalize([d[2], 0, -d[0]]);
  const up: V3 = [right[1] * d[2] - right[2] * d[1], right[2] * d[0] - right[0] * d[2], right[0] * d[1] - right[1] * d[0]];
  const aimed = normalize([d[0] + right[0] * a + up[0] * b, d[1] + right[1] * a + up[1] * b, d[2] + right[2] * a + up[2] * b]);
  const ray = new RAPIER.Ray({ x: origin[0], y: origin[1], z: origin[2] }, { x: aimed[0], y: aimed[1], z: aimed[2] });
  const hit = world.physics.castRay(ray, def.rangeMeters, true, undefined, groups(GROUP.bullet, GROUP.static | GROUP.vehicle | GROUP.character), undefined, excludeBody);
  if (!hit) {
    return { origin, end: [origin[0] + aimed[0] * def.rangeMeters, origin[1] + aimed[1] * def.rangeMeters, origin[2] + aimed[2] * def.rangeMeters], colliderHandle: null, headshot: false, distance: def.rangeMeters };
  }
  const toi = (hit as unknown as { timeOfImpact?: number; toi?: number }).timeOfImpact ?? (hit as unknown as { toi: number }).toi;
  const point: V3 = [origin[0] + aimed[0] * toi, origin[1] + aimed[1] * toi, origin[2] + aimed[2] * toi];
  return { origin, end: point, colliderHandle: hit.collider.handle, headshot: headCheck(hit.collider.handle, point), distance: toi };
}
