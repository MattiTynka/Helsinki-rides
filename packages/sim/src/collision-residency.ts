// Collision residency (opt-in streaming): which baked HCOL cells are inserted into the Rapier world, decided only from
// simulation state so a browser session and its Node replay insert and remove the same cells on the same ticks.
// Rapier registers a new collider for queries during the next physics step, so cells are inserted a ring ahead of
// need, and recovery and spawn destinations stay resident.
import type { CellDescriptor, GameplayBundle, RoadIndex } from '@helsinki/world-schema';
import { patrolSpawnPlacement } from './police.ts';
import type { LiveGrid } from './live-grid.ts';

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

export interface ResidencyPlanOptions {
  /**
   * False plans as if there were no live squares: none is inserted, while resident ones still follow the keep rule
   * (removal needs no bytes). Simulation construction and drop-ins use it, so they never wait for the city's servers.
   */
  readonly live?: boolean;
}

type Ranked = { id: string; urgency: number };

const byUrgency = (a: Ranked, b: Ranked): number =>
  a.urgency - b.urgency || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Whether a resident extent stays: within `keep` of some source. */
function kept(b: CollisionCellRef['boundsXZ'], all: readonly ResidencySource[]): boolean {
  // Existing cells need only a keep decision, not an insertion priority. Most are close to
  // one of the first sources; distant sources cannot change that decision once it is true.
  for (const s of all) {
    const dx = Math.max(b[0] - s.x, 0, s.x - b[2]);
    if (dx > s.keep) continue;
    const dz = Math.max(b[1] - s.z, 0, s.z - b[3]);
    if (dz > s.keep) continue;
    if (Math.hypot(dx, dz) <= s.keep) return true;
  }
  return false;
}

/** Queue a missing extent as needed or wanted, with its urgency (distance beyond the nearest need ring). */
function rank(id: string, b: CollisionCellRef['boundsXZ'], all: readonly ResidencySource[], needed: Ranked[], wanted: Ranked[]): void {
  let need = false, want = false, urgency = Infinity;
  for (const s of all) {
    // An axis distance is a conservative lower bound on the Euclidean distance. Avoid the
    // square root for the many city cells outside both insertion rings.
    const radius = Math.max(s.need, s.want);
    const dx = Math.max(b[0] - s.x, 0, s.x - b[2]);
    if (dx > radius) continue;
    const dz = Math.max(b[1] - s.z, 0, s.z - b[3]);
    if (dz > radius) continue;
    const d = Math.hypot(dx, dz);
    if (d <= s.need) need = true;
    if (d <= s.want) want = true;
    urgency = Math.min(urgency, d - s.need);
  }
  if (need) needed.push({ id, urgency });
  else if (want) {
    // Needed cells already have urgency <= 0, which no skipped source can improve. Wanted
    // cells can have positive urgency: a source outside its own rings may still rank them
    // earlier when rings differ. Preserve that exact priority using the same axis bound.
    for (const s of all) {
      const dx = Math.max(b[0] - s.x, 0, s.x - b[2]);
      if (dx - s.need >= urgency) continue;
      const dz = Math.max(b[1] - s.z, 0, s.z - b[3]);
      if (dz - s.need >= urgency) continue;
      urgency = Math.min(urgency, Math.hypot(dx, dz) - s.need);
    }
    wanted.push({ id, urgency });
  }
}

export class CollisionResidency {
  readonly cells: readonly CollisionCellRef[];
  readonly pins: readonly ResidencySource[];
  /** Live squares (live-grid.ts) planned alongside the manifest cells; null for a release-only world. */
  readonly live: LiveGrid | null;

  constructor(cells: readonly CollisionCellRef[], pins: readonly ResidencySource[], live: LiveGrid | null = null) {
    this.cells = cells;
    this.pins = pins;
    this.live = live;
  }

  /** Cells to insert (needed first, nearest first) and to remove (by id), given the currently resident cells. */
  plan(sources: readonly ResidencySource[], resident: ReadonlySet<string>, ahead: number = RESIDENCY.aheadPerTick, options: ResidencyPlanOptions = {}): ResidencyPlan {
    const all = sources.concat(this.pins);
    const needed: Ranked[] = [], wanted: Ranked[] = [], remove: string[] = [];
    for (const cell of this.cells) {
      if (!resident.has(cell.id)) rank(cell.id, cell.boundsXZ, all, needed, wanted);
      else if (!kept(cell.boundsXZ, all)) remove.push(cell.id);
    }
    const live = this.live;
    if (live) {
      // Live squares by the same rules, measured by their extent (square plus margin). Candidates are the squares
      // within some source's insertion rings; each is ranked once against every source.
      if (options.live !== false) {
        const candidates = new Map<string, CollisionCellRef>();
        for (const s of all) for (const ref of live.near(s.x, s.z, Math.max(s.need, s.want))) {
          if (!resident.has(ref.id)) candidates.set(ref.id, ref);
        }
        for (const ref of candidates.values()) rank(ref.id, ref.boundsXZ, all, needed, wanted);
      }
      for (const id of resident) {
        const c = live.parse(id);
        if (c && live.isLive(c[0], c[1]) && !kept(live.ref(c[0], c[1]).boundsXZ, all)) remove.push(id);
      }
    }
    needed.sort(byUrgency);
    wanted.sort(byUrgency);
    remove.sort();
    return { insert: needed.concat(wanted.slice(0, ahead)).map(c => c.id), remove };
  }

  /** Every cell whose collision extent contains the point, or touches it on an edge: manifest cells, then live squares. */
  cellsAt(x: number, z: number): CollisionCellRef[] {
    const cells = this.cells.filter(c => x >= c.boundsXZ[0] && x <= c.boundsXZ[2] && z >= c.boundsXZ[1] && z <= c.boundsXZ[3]);
    return this.live ? cells.concat(this.live.at(x, z)) : cells;
  }
}

/** Cells the simulation constructor inserts before its first step, so a loader can fetch exactly these first. */
export function initialCollisionCells(cells: readonly CollisionCellRef[], roads: RoadIndex, gameplay: GameplayBundle): string[] {
  return [...new CollisionResidency(cells, residencyPins(roads, gameplay)).plan(initialResidencySources(gameplay), new Set(), Infinity).insert];
}
