// Collision residency (opt-in streaming): which baked HCOL cells are inserted into the Rapier world, decided only from
// simulation state so a browser session and its Node replay insert and remove the same cells on the same ticks.
// Rapier registers a new collider for queries during the next physics step, so cells are inserted a ring ahead of
// need, and recovery and spawn destinations stay resident.
import type { CellDescriptor, GameplayBundle, RoadIndex } from '@helsinki/world-schema';
import { patrolSpawnPlacement } from './police.ts';

/**
 * Recorded with replays: the residency rules a recording was made under. residency-2 measures each cell by its
 * collision extent; residency-1 used the cell's grid square and missed buildings that reach into neighbouring squares.
 */
export const COLLISION_RESIDENCY = 'residency-2';

export interface CollisionCellRef {
  readonly id: string;
  /** XZ extent [x0, z0, x1, z1] of every collider the cell inserts. */
  readonly boundsXZ: readonly [number, number, number, number];
}

/**
 * The cells residency plans with, measured by their collision extent (manifest `collision.boundsXZ`). Null when any
 * cell lacks one; such a world loads every cell instead of streaming.
 */
export function collisionCellRefs(cells: readonly CellDescriptor[]): CollisionCellRef[] | null {
  const refs: CollisionCellRef[] = [];
  for (const cell of cells) {
    if (!cell.collision.boundsXZ) return null;
    refs.push({ id: cell.id, boundsXZ: cell.collision.boundsXZ });
  }
  return refs;
}

export interface ResidencyRing {
  /** Cells within this distance are inserted on this tick. */
  readonly need: number;
  /** Cells within this distance are inserted ahead of need, a few per tick. */
  readonly want: number;
  /** Resident cells beyond this distance of every source are removed. */
  readonly keep: number;
}

export interface ResidencySource extends ResidencyRing {
  readonly x: number;
  readonly z: number;
}

export const RESIDENCY = {
  /** The player: pistol range (120 m) and police sight (90 m) stay inside resident collision. */
  player: { need: 128, want: 152, keep: 216 },
  /** Every other dynamic body: cars and officers on foot. */
  actor: { need: 24, want: 48, keep: 96 },
  /** Respawn anchors, the start and the patrol spawns remain resident. */
  pinned: { need: 32, want: 32, keep: 32 },
  /** Cells inserted ahead of need per tick; needed cells are always inserted at once. */
  aheadPerTick: 1,
} as const satisfies Record<string, ResidencyRing | number>;

export interface ResidencyPlan {
  readonly insert: readonly string[];
  readonly remove: readonly string[];
}

export const source = (x: number, z: number, ring: ResidencyRing): ResidencySource => ({ x, z, need: ring.need, want: ring.want, keep: ring.keep });

/** Fixed destinations: the configured start, the respawn anchors and where each patrol spawn places its car. */
export function residencyPins(roads: RoadIndex, gameplay: GameplayBundle): ResidencySource[] {
  const pins = [source(gameplay.player.spawn.position[0], gameplay.player.spawn.position[1], RESIDENCY.pinned)];
  for (const anchor of gameplay.anchors) pins.push(source(anchor.position[0], anchor.position[1], RESIDENCY.pinned));
  for (const spawn of gameplay.police.patrolSpawns) {
    const { xz } = patrolSpawnPlacement(roads, spawn);
    pins.push(source(xz[0], xz[1], RESIDENCY.pinned));
  }
  return pins;
}

/** Sources before the simulation exists: the configured player start and parked cars. */
export function initialResidencySources(gameplay: GameplayBundle): ResidencySource[] {
  const sources = [source(gameplay.player.spawn.position[0], gameplay.player.spawn.position[1], RESIDENCY.player)];
  for (const v of gameplay.vehicles) sources.push(source(v.position[0], v.position[1], RESIDENCY.actor));
  return sources;
}

const distanceToBounds = (x: number, z: number, b: readonly [number, number, number, number]): number =>
  Math.hypot(Math.max(b[0] - x, 0, x - b[2]), Math.max(b[1] - z, 0, z - b[3]));

const byUrgency = (a: { id: string; urgency: number }, b: { id: string; urgency: number }): number =>
  a.urgency - b.urgency || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export class CollisionResidency {
  readonly cells: readonly CollisionCellRef[];
  readonly pins: readonly ResidencySource[];

  constructor(cells: readonly CollisionCellRef[], pins: readonly ResidencySource[]) {
    this.cells = cells;
    this.pins = pins;
  }

  /** Cells to insert (needed first, nearest first) and to remove (by id), given the currently resident cells. */
  plan(sources: readonly ResidencySource[], resident: ReadonlySet<string>, ahead: number = RESIDENCY.aheadPerTick): ResidencyPlan {
    const all = sources.concat(this.pins);
    const needed: { id: string; urgency: number }[] = [], wanted: { id: string; urgency: number }[] = [], remove: string[] = [];
    for (const cell of this.cells) {
      let need = false, want = false, keep = false, urgency = Infinity;
      for (const s of all) {
        const d = distanceToBounds(s.x, s.z, cell.boundsXZ);
        if (d <= s.need) need = true;
        if (d <= s.want) want = true;
        if (d <= s.keep) keep = true;
        urgency = Math.min(urgency, d - s.need);
      }
      if (resident.has(cell.id)) { if (!keep) remove.push(cell.id); }
      else if (need) needed.push({ id: cell.id, urgency });
      else if (want) wanted.push({ id: cell.id, urgency });
    }
    needed.sort(byUrgency);
    wanted.sort(byUrgency);
    remove.sort();
    return { insert: needed.concat(wanted.slice(0, ahead)).map(c => c.id), remove };
  }

  /** Every cell whose collision extent contains the point, or touches it on an edge. */
  cellsAt(x: number, z: number): CollisionCellRef[] {
    return this.cells.filter(c => x >= c.boundsXZ[0] && x <= c.boundsXZ[2] && z >= c.boundsXZ[1] && z <= c.boundsXZ[3]);
  }
}

/** Cells the simulation constructor inserts before its first step, so a loader can fetch exactly these first. */
export function initialCollisionCells(cells: readonly CollisionCellRef[], roads: RoadIndex, gameplay: GameplayBundle): string[] {
  return [...new CollisionResidency(cells, residencyPins(roads, gameplay)).plan(initialResidencySources(gameplay), new Set(), Infinity).insert];
}
