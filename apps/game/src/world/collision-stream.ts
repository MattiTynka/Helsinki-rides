// Decoded collision bundles for the simulation's streamed residency (packages/sim/src/collision-residency.ts). The
// simulation decides which cells are inserted; this only fetches bytes ahead of its rings and keeps them while near.
// When a step needs a cell that has not arrived, the game blocks ticks until it has. Live squares (grid squares the
// manifest lacks, world/live) are built by the live source instead of fetched; prefetches of them that fall out of
// range are aborted.
import type { CellDescriptor, TerrainGrid } from '@helsinki/world-schema';
import type { CollisionCellRef, LiveGrid, ResidencySource } from '@helsinki/sim';
import { fetchSimulationPayload } from './payload.ts';
import { edgeOverrides, type LiveCellSource } from './live/live-source.ts';

export interface CollisionStreamStats {
  readonly cached: number;
  readonly cachedMiB: number;
  readonly pending: number;
  readonly queued: number;
  readonly fetched: number;
  readonly fetchedMiB: number;
  readonly evicted: number;
  readonly errors: readonly string[];
}

export interface CollisionStreamOptions {
  /** Concurrent prefetch requests; cells a step is waiting for start at once. */
  readonly concurrency: number;
  /** Decoded bytes kept beyond the startup cells and the current prefetch set. */
  readonly cacheBytes: number;
  /** Extra prefetch distance beyond each source's ahead-of-need ring. */
  readonly playerMargin: number;
  readonly actorMargin: number;
  /** Seconds of player velocity added to the player's prefetch focus. */
  readonly lookaheadSeconds: number;
  readonly retrySeconds: number;
}

/** Live city cells: the grid, the worker-backed source and the release terrain their seams copy. */
export interface CollisionStreamLive {
  readonly grid: LiveGrid;
  readonly source: LiveCellSource;
  readonly terrain: TerrainGrid;
}

const DEFAULTS: CollisionStreamOptions = { concurrency: 4, cacheBytes: 64 * 2 ** 20, playerMargin: 160, actorMargin: 48, lookaheadSeconds: 4, retrySeconds: 2 };

export class CollisionStream {
  private readonly base: string;
  private readonly cells: ReadonlyMap<string, CellDescriptor>;
  /** The simulation's residency cells: distances are to each cell's collision extent, as in its rules. */
  private readonly extents: readonly CollisionCellRef[];
  private readonly bytes = new Map<string, Uint8Array>();
  private readonly pending = new Map<string, Promise<Uint8Array>>();
  private readonly failedAt = new Map<string, number>();
  /** The startup cells: a fresh simulation (reset) inserts them synchronously. */
  private readonly pinned: ReadonlySet<string>;
  private readonly options: CollisionStreamOptions;
  private queue: string[] = [];
  private prefetch = new Set<string>();
  private cachedBytes = 0;
  private fetched = 0;
  private fetchedBytes = 0;
  private evicted = 0;
  private readonly errors: string[] = [];
  private readonly live: CollisionStreamLive | null;
  /** Abort controllers of pending live builds. */
  private readonly liveJobs = new Map<string, AbortController>();
  /** Pending cells a step asked for (ensure, request): never aborted. */
  private readonly demanded = new Set<string>();

  constructor(base: string, cells: readonly CellDescriptor[], extents: readonly CollisionCellRef[], initial: ReadonlyMap<string, Uint8Array>, options: Partial<CollisionStreamOptions> = {}, live?: CollisionStreamLive | null) {
    this.base = base;
    this.cells = new Map(cells.map(c => [c.id, c]));
    this.extents = extents;
    this.options = { ...DEFAULTS, ...options };
    this.live = live ?? null;
    for (const [id, bytes] of initial) this.store(id, bytes);
    this.pinned = new Set(initial.keys());
  }

  get(id: string): Uint8Array | undefined { return this.bytes.get(id); }

  /** Resolves when every listed cell is available. Missing cells are requested at once, ahead of prefetching. */
  ensure(ids: readonly string[]): Promise<void> {
    const waits: Promise<Uint8Array>[] = [];
    for (const id of ids) {
      if (this.bytes.has(id)) continue;
      waits.push(this.start(id));
      if (this.pending.has(id)) this.demanded.add(id);
    }
    return waits.length ? Promise.all(waits).then(() => undefined) : Promise.resolve();
  }

  /** Request cells a step is waiting for without awaiting them; a blocked frame calls this every frame. */
  request(ids: readonly string[]): void {
    const now = performance.now();
    for (const id of ids) {
      if (this.bytes.has(id)) continue;
      if (!this.pending.has(id) && !this.coolingDown(id, now)) this.start(id).catch(() => {});
      if (this.pending.has(id)) this.demanded.add(id);
    }
  }

  /** Prefetch around the simulation's residency sources (the player first), nearest first, and trim the cache. */
  update(sources: readonly ResidencySource[], playerVelocity: readonly [number, number] = [0, 0]): void {
    const o = this.options;
    const focus = sources.map((s, i) => ({ x: s.x, z: s.z, radius: s.want + (i === 0 ? o.playerMargin : o.actorMargin) }));
    const player = sources[0];
    if (player) focus.push({ x: player.x + playerVelocity[0] * o.lookaheadSeconds, z: player.z + playerVelocity[1] * o.lookaheadSeconds, radius: player.want });
    const ranked: { id: string; d: number }[] = [];
    const rank = (cell: CollisionCellRef): void => {
      let d = Infinity;
      const b = cell.boundsXZ;
      for (const f of focus) {
        const dx = Math.max(b[0] - f.x, 0, f.x - b[2]);
        if (dx > f.radius) continue;
        const dz = Math.max(b[1] - f.z, 0, f.z - b[3]);
        if (dz > f.radius) continue;
        // Only nonpositive ranks enter the queue. A source outside either axis of its circle
        // cannot affect the minimum rank of a retained cell, even when source radii differ.
        d = Math.min(d, Math.hypot(dx, dz) - f.radius);
      }
      if (d <= 0) ranked.push({ id: cell.id, d });
    };
    for (const cell of this.extents) rank(cell);
    if (this.live) {
      const near = new Map<string, CollisionCellRef>();
      for (const f of focus) for (const ref of this.live.grid.near(f.x, f.z, f.radius)) near.set(ref.id, ref);
      for (const ref of near.values()) rank(ref);
    }
    ranked.sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : 1));
    this.prefetch = new Set(ranked.map(r => r.id));
    // Live builds nobody needs any more give their kartta.hel.fi requests back.
    for (const [id, controller] of this.liveJobs) {
      if (this.prefetch.has(id) || this.demanded.has(id)) continue;
      controller.abort();
      this.liveJobs.delete(id);
      this.pending.delete(id);
    }
    const now = performance.now();
    this.queue = ranked.map(r => r.id).filter(id => !this.bytes.has(id) && !this.pending.has(id) && !this.coolingDown(id, now));
    this.pump();
    this.trim();
  }

  stats(): CollisionStreamStats {
    return { cached: this.bytes.size, cachedMiB: this.cachedBytes / 2 ** 20, pending: this.pending.size, queued: this.queue.length,
      fetched: this.fetched, fetchedMiB: this.fetchedBytes / 2 ** 20, evicted: this.evicted, errors: this.errors.slice(-8) };
  }

  private coolingDown(id: string, now: number): boolean {
    const at = this.failedAt.get(id);
    return at !== undefined && now - at < this.options.retrySeconds * 1000;
  }

  private store(id: string, bytes: Uint8Array): void {
    if (this.bytes.has(id)) return;
    this.bytes.set(id, bytes);
    this.cachedBytes += bytes.byteLength;
  }

  private start(id: string): Promise<Uint8Array> {
    const existing = this.pending.get(id);
    if (existing) return existing;
    const load = this.load(id);
    if (!load) return Promise.reject(new Error(`unknown collision cell ${id}`));
    const job: Promise<Uint8Array> = load.then(bytes => {
      this.store(id, bytes);
      this.failedAt.delete(id);
      this.fetched++;
      this.fetchedBytes += bytes.byteLength;
      return this.bytes.get(id)!;
    }, (error: unknown) => {
      // An aborted live prefetch is not a failure: it starts afresh when wanted again.
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        this.failedAt.set(id, performance.now());
        this.errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }).finally(() => {
      if (this.pending.get(id) !== job) return; // aborted and since superseded
      this.pending.delete(id);
      this.liveJobs.delete(id);
      this.demanded.delete(id);
      this.pump();
    });
    this.pending.set(id, job);
    return job;
  }

  /** A manifest cell's bytes from the release host, or a live square's from the live source; null for neither. */
  private load(id: string): Promise<Uint8Array> | null {
    const cell = this.cells.get(id);
    if (cell) return fetchSimulationPayload(this.base + cell.collision.path, cell.collision);
    const live = this.live;
    const c = live?.grid.isLiveId(id) ? live.grid.parse(id) : null;
    if (!live || !c) return null;
    const controller = new AbortController();
    this.liveJobs.set(id, controller);
    return live.source.collision(c[0], c[1], edgeOverrides(live.grid, live.terrain, c[0], c[1]), controller.signal).then(result => {
      // A speculative build that found its sources unavailable is retried later; only a step's demand settles for empty.
      if (result.empty && !this.demanded.has(id) && !live.source.pinned(id)) throw new Error('live sources unavailable');
      return result.hcol;
    });
  }

  private pump(): void {
    while (this.pending.size < this.options.concurrency && this.queue.length) {
      const id = this.queue.shift()!;
      if (!this.bytes.has(id) && !this.pending.has(id)) this.start(id).catch(() => {});
    }
  }

  /** Drop the oldest cached cells outside the startup and prefetch sets while above the byte budget. */
  private trim(): void {
    if (this.cachedBytes <= this.options.cacheBytes) return;
    for (const [id, bytes] of this.bytes) {
      if (this.cachedBytes <= this.options.cacheBytes) break;
      if (this.pinned.has(id) || this.prefetch.has(id)) continue;
      this.cachedBytes -= bytes.byteLength;
      this.bytes.delete(id);
      this.evicted++;
    }
  }
}
