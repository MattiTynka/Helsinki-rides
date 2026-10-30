// Live city cells (kartta-live-2): the 128 m grid squares the release manifest does not cover, filled at runtime from
// the City of Helsinki's 3D map (apps/game/src/world/live). Which squares are live, their ids and their collision
// extents are fixed here from the manifest alone, so a browser session and its Node replay plan the same residency.
import { cellId } from '@helsinki/world-schema';
import type { CollisionCellRef } from './collision-residency.ts';

export const LIVE_VERSION = 'kartta-live-2';
export const LIVE_CELL_SIZE = 128;
/** Buildings owned by a square (footprint centroid) are clipped to the square grown by this margin. */
export const LIVE_MARGIN = 32;
/** Runtime XZ [x0, z0, x1, z1] of the whole squares inside both the city's textured LoD2 tileset and its terrain layer. */
export const LIVE_REGION_XZ: readonly [number, number, number, number] = [-6784, -13952, 16256, 4480];
/** The live ground collider (apps/game/src/world/live/contract.ts): an N × N lattice, row-major iz * N + ix, at
 *  x = cx * 128 + ix * STEP, z = cz * 128 + iz * STEP. Heights at or below LIVE_GROUND_NO_DATA have no terrain data. */
export const LIVE_GROUND_COLLIDER_ID = 'live-ground';
export const LIVE_GROUND_STEP = 2;
export const LIVE_GROUND_N = 65;
export const LIVE_GROUND_NO_DATA = -49;

const ID = /^c_([mp])(\d+)_([mp])(\d+)$/;

/** Grid square of a cell id (`cellId(cx, cz)`), or null for any other id. */
export function parseCellId(id: string): [number, number] | null {
  const m = ID.exec(id);
  if (!m) return null;
  return [(m[1] === 'm' ? -1 : 1) * Number(m[2]), (m[3] === 'm' ? -1 : 1) * Number(m[4])];
}

/** A numeric key per square for |cx|, |cz| < 32768, so hot lookups format no id strings. */
export const squareKey = (cx: number, cz: number): number => (cx + 32768) * 65536 + (cz + 32768);

export class LiveGrid {
  private readonly staticIds: ReadonlySet<string>;
  private readonly staticKeys = new Set<number>();
  private readonly c0: readonly [number, number];
  private readonly c1: readonly [number, number];

  constructor(staticCellIds: Iterable<string>, region: readonly [number, number, number, number] = LIVE_REGION_XZ) {
    this.staticIds = new Set(staticCellIds);
    for (const id of this.staticIds) {
      const c = parseCellId(id);
      if (c) this.staticKeys.add(squareKey(c[0], c[1]));
    }
    this.c0 = [Math.ceil(region[0] / LIVE_CELL_SIZE), Math.ceil(region[1] / LIVE_CELL_SIZE)];
    this.c1 = [Math.floor(region[2] / LIVE_CELL_SIZE) - 1, Math.floor(region[3] / LIVE_CELL_SIZE) - 1];
  }

  /** A square inside the region that the release does not cover. */
  isLive(cx: number, cz: number): boolean {
    return cx >= this.c0[0] && cx <= this.c1[0] && cz >= this.c0[1] && cz <= this.c1[1] && !this.staticKeys.has(squareKey(cx, cz));
  }

  isStatic(cx: number, cz: number): boolean { return this.staticIds.has(cellId(cx, cz)); }

  id(cx: number, cz: number): string { return cellId(cx, cz); }

  parse(id: string): [number, number] | null { return parseCellId(id); }

  isLiveId(id: string): boolean {
    const c = this.parse(id);
    return c !== null && this.isLive(c[0], c[1]);
  }

  /** The square grown by the margin: every collider the live cell can insert. */
  ref(cx: number, cz: number): CollisionCellRef {
    const x0 = cx * LIVE_CELL_SIZE, z0 = cz * LIVE_CELL_SIZE;
    return { id: cellId(cx, cz), boundsXZ: [x0 - LIVE_MARGIN, z0 - LIVE_MARGIN, x0 + LIVE_CELL_SIZE + LIVE_MARGIN, z0 + LIVE_CELL_SIZE + LIVE_MARGIN] };
  }

  /** Live squares whose extent lies within `radius` of (x, z), in id order. */
  near(x: number, z: number, radius: number): CollisionCellRef[] {
    if (![x, z, radius].every(Number.isFinite) || radius < 0) return [];
    // Square c's extent spans [c * 128 - margin, c * 128 + 128 + margin]; the ceil keeps squares touching exactly.
    const reach = radius + LIVE_MARGIN;
    const cx0 = Math.ceil((x - reach) / LIVE_CELL_SIZE) - 1, cx1 = Math.floor((x + reach) / LIVE_CELL_SIZE);
    const cz0 = Math.ceil((z - reach) / LIVE_CELL_SIZE) - 1, cz1 = Math.floor((z + reach) / LIVE_CELL_SIZE);
    const out: CollisionCellRef[] = [];
    for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
      if (!this.isLive(cx, cz)) continue;
      const ref = this.ref(cx, cz), b = ref.boundsXZ;
      if (Math.hypot(Math.max(b[0] - x, 0, x - b[2]), Math.max(b[1] - z, 0, z - b[3])) <= radius) out.push(ref);
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** Live squares whose extent contains or touches XZ. */
  at(x: number, z: number): CollisionCellRef[] { return this.near(x, z, 0); }
}
