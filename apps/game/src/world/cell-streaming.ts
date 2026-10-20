// Visual residency only. The complete collision world stays resident and keeps its deterministic insertion order.
import type { CellDescriptor } from '@helsinki/world-schema';

export interface StreamFocus { x: number; z: number; velocityX: number; velocityZ: number }
export interface CellResource { readonly textureBytes: number; readonly geometryBytes: number; readonly lod?: 'lod0' | 'lod1' | 'lod2' }
export interface CellStreamBackend<T extends CellResource> {
  load(cell: CellDescriptor, signal: AbortSignal): Promise<T>;
  /** Upload only after actual resource costs have reserved room inside both budgets. */
  prepare?(cell: CellDescriptor, resource: T, signal: AbortSignal): Promise<void>;
  show(cell: CellDescriptor, resource: T): void;
  dispose(cell: CellDescriptor, resource: T): void;
}
export interface CellStreamOptions {
  readonly textureBudgetBytes: number;
  readonly geometryBudgetBytes?: number;
  readonly radius: number;
  readonly lookaheadSeconds: number;
  readonly maxLookahead: number;
  readonly concurrency?: number;
  readonly level?: 'lod0' | 'lod1' | 'lod2';
  readonly maxCells?: number;
  readonly now?: () => number;
}
export interface CellStreamStats {
  totalCells: number;
  residentCells: number;
  residentLods: Record<string, number>;
  desiredCells: number;
  pendingCells: number;
  /** Includes reserved GPU costs of preparations that have not become visible yet. */
  residentTextureMiB: number;
  residentGeometryMiB: number;
  geometryBudgetMiB: number | null;
  textureBudgetMiB: number;
  peakTextureMiB: number;
  loaded: number;
  evicted: number;
  staleDisposed: number;
  cancelledLoads: number;
  failedLoads: number;
  fallbackCells: number;
  missingNearDetail: string[];
  errors: string[];
  errorHistory: string[];
}

interface PendingCell {
  readonly controller: AbortController;
  task: Promise<void>;
  phase: 'loading' | 'admitting' | 'waiting' | 'preparing';
}

/** Distance to the complete owned visual, including buildings crossing their centroid cell's border. */
export function visualBounds(cell: CellDescriptor): readonly [number, number, number, number] {
  const bounds: [number, number, number, number] = [...cell.boundsXZ];
  for (const building of cell.buildings) {
    bounds[0] = Math.min(bounds[0], building.boundsRuntime.min[0]);
    bounds[1] = Math.min(bounds[1], building.boundsRuntime.min[2]);
    bounds[2] = Math.max(bounds[2], building.boundsRuntime.max[0]);
    bounds[3] = Math.max(bounds[3], building.boundsRuntime.max[2]);
  }
  return bounds;
}

function distance(bounds: readonly number[], x: number, z: number): number {
  return Math.hypot(Math.max(bounds[0]! - x, 0, x - bounds[2]!), Math.max(bounds[1]! - z, 0, z - bounds[3]!));
}

/** Ground belongs to the declared cell rectangle, even when a building owned by another cell crosses it. */
export function missingVisualCoverage(cells: readonly CellDescriptor[], x: number, z: number, margin: number,
  detailed: ReadonlyMap<string, unknown>, coarse: ReadonlyMap<string, unknown>): string[] {
  return cells.filter(cell => distance(cell.boundsXZ, x, z) <= margin && !detailed.has(cell.id) && !coarse.has(cell.id)).map(cell => cell.id);
}

/** Select complete cells, never a texture downgrade. A retained cell gets a small hysteresis preference. */
export function selectVisualCells(cells: readonly CellDescriptor[], focus: StreamFocus, options: CellStreamOptions,
  costs: ReadonlyMap<string, number>, resident: ReadonlySet<string>, geometryCosts: ReadonlyMap<string, number> = new Map()): CellDescriptor[] {
  const speed = Math.hypot(focus.velocityX, focus.velocityZ);
  const lead = Math.min(options.maxLookahead, speed * options.lookaheadSeconds);
  const ux = speed > 0.01 ? focus.velocityX / speed : 0, uz = speed > 0.01 ? focus.velocityZ / speed : 0;
  const ranked = cells.map(cell => {
    const b = visualBounds(cell), here = distance(b, focus.x, focus.z);
    // Sample the movement corridor, not only its end: a fast car cannot skip the intervening visual cells.
    let corridor = here;
    for (let i = 1; i <= 4; i++) corridor = Math.min(corridor, distance(b, focus.x + ux * lead * i / 4, focus.z + uz * lead * i / 4));
    return { cell, here, corridor, rank: Math.min(here, corridor + 35) - (resident.has(cell.id) ? 18 : 0) };
  }).filter(p => p.corridor <= options.radius).sort((a, b) => a.rank - b.rank || a.here - b.here || a.cell.id.localeCompare(b.cell.id));
  let used = 0, geometryUsed = 0;
  const selected: CellDescriptor[] = [];
  for (const { cell } of ranked) {
    if (selected.length >= (options.maxCells ?? Infinity)) break;
    // The manifest is an RGBA+mips upper bound; BC7/ASTC use one byte per texel. This estimate only
    // schedules CPU decoding. Actual device mip sizes must pass the hard budget before GPU admission.
    const lod = cell.visual[options.level ?? 'lod0'] ?? cell.visual.lod0;
    const bytes = costs.get(cell.id) ?? lod.textureBytesEstimate / 4;
    const geometryBytes = geometryCosts.get(cell.id) ?? lod.triangles * 108;
    if (bytes > options.textureBudgetBytes || used + bytes > options.textureBudgetBytes || geometryUsed + geometryBytes > (options.geometryBudgetBytes ?? Infinity)) continue;
    used += bytes;
    geometryUsed += geometryBytes;
    selected.push(cell);
  }
  return selected;
}

export class CellVisualStream<T extends CellResource> {
  private readonly resident = new Map<string, { cell: CellDescriptor; resource: T }>();
  // Aborted decoding can still be running in a worker. Keep its slot until the promise settles.
  private readonly pending = new Map<string, PendingCell>();
  private readonly costs = new Map<string, number>();
  private readonly geometryCosts = new Map<string, number>();
  private readonly retryAt = new Map<string, number>();
  private readonly errorByCell = new Map<string, string>();
  private readonly failureHistory: string[] = [];
  private desired: CellDescriptor[] = [];
  private focus: StreamFocus = { x: 0, z: 0, velocityX: 0, velocityZ: 0 };
  private disposed = false;
  private generation = 0;
  private bytes = 0;
  private geometryBytes = 0;
  private peak = 0;
  private loaded = 0;
  private evicted = 0;
  private staleDisposed = 0;
  private cancelledLoads = 0;
  private failures = 0;
  private readonly now: () => number;
  private readonly cells: readonly CellDescriptor[];
  private readonly backend: CellStreamBackend<T>;
  private options: CellStreamOptions;

  constructor(cells: readonly CellDescriptor[], backend: CellStreamBackend<T>, options: CellStreamOptions) {
    if (!(options.textureBudgetBytes > 0)) throw new Error('No visual texture budget remains after persistent assets');
    this.cells = cells;
    this.backend = backend;
    this.options = options;
    this.now = options.now ?? (() => performance.now());
  }

  /** Persistent assets loaded after startup reduce the texture budget; resident cells above it are evicted. */
  setTextureBudget(bytes: number): void {
    if (!(bytes > 0)) throw new Error('No visual texture budget remains after persistent assets');
    this.options = { ...this.options, textureBudgetBytes: bytes };
    this.reselect();
    this.pump();
  }

  update(focus: StreamFocus): void {
    if (this.disposed) return;
    if (![focus.x, focus.z, focus.velocityX, focus.velocityZ].every(Number.isFinite)) return;
    this.focus = focus;
    this.reselect();
    this.pump();
  }

  /** Initial control waits for its selected detail cells; later movement always has resident fallback ground. */
  async settle(): Promise<void> {
    for (;;) {
      this.reselect();
      this.pump();
      const tasks = [...this.pending.values()].map(entry => entry.task);
      if (!tasks.length) return;
      await Promise.all(tasks);
    }
  }

  /** Startup needs nearby selected cells, not completion of unrelated outer-ring downloads. */
  async settleNear(radius: number): Promise<void> {
    if (!Number.isFinite(radius) || radius < 0) throw new Error('Invalid startup visual radius');
    for (;;) {
      this.reselect();
      this.pump();
      const required = this.desired.filter(cell => distance(visualBounds(cell), this.focus.x, this.focus.z) <= radius);
      if (required.every(cell => this.resident.has(cell.id) || this.errorByCell.has(cell.id))) return;
      const tasks = [...this.pending.values()].map(entry => entry.task);
      if (!tasks.length) return;
      await Promise.race(tasks);
    }
  }

  stats(): CellStreamStats {
    const residentIds = new Set(this.resident.keys());
    const desiredIds = new Set(this.desired.map(cell => cell.id));
    const residentLods: Record<string, number> = {};
    for (const { resource } of this.resident.values()) {
      const lod = resource.lod ?? this.options.level ?? 'lod0';
      residentLods[lod] = (residentLods[lod] ?? 0) + 1;
    }
    return { totalCells: this.cells.length, residentCells: this.resident.size, desiredCells: this.desired.length,
      residentLods,
      pendingCells: this.pending.size, residentTextureMiB: this.bytes / 2 ** 20, textureBudgetMiB: this.options.textureBudgetBytes / 2 ** 20,
      residentGeometryMiB: this.geometryBytes / 2 ** 20, geometryBudgetMiB: this.options.geometryBudgetBytes ? this.options.geometryBudgetBytes / 2 ** 20 : null,
      peakTextureMiB: this.peak / 2 ** 20, loaded: this.loaded, evicted: this.evicted, staleDisposed: this.staleDisposed, cancelledLoads: this.cancelledLoads,
      failedLoads: this.failures, fallbackCells: this.cells.length - this.resident.size,
      missingNearDetail: this.cells.filter(c => distance(visualBounds(c), this.focus.x, this.focus.z) < 40 && !residentIds.has(c.id)).map(c => c.id),
      errors: [...this.errorByCell].filter(([id]) => desiredIds.has(id)).map(([id, message]) => `${id}: ${message}`),
      errorHistory: [...this.failureHistory] };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    for (const entry of this.pending.values()) this.cancel(entry.controller);
    for (const entry of this.resident.values()) {
      try { this.backend.dispose(entry.cell, entry.resource); }
      finally {
        this.bytes -= entry.resource.textureBytes;
        this.geometryBytes -= entry.resource.geometryBytes;
      }
    }
    this.resident.clear();
    // Preparing resources still own their reservations until uploads/compilation have settled.
    this.desired = [];
  }

  private reselect(): void {
    if (this.disposed) return;
    this.desired = selectVisualCells(this.cells, this.focus, this.options, this.costs, new Set(this.resident.keys()), this.geometryCosts);
    const wanted = new Set(this.desired.map(c => c.id));
    for (const [id, entry] of this.pending) if (entry.phase !== 'admitting' && !wanted.has(id)) this.cancel(entry.controller);
    // Eviction precedes loading, so the old and new district never occupy GPU memory together.
    for (const [id, entry] of this.resident) if (!wanted.has(id)) {
      this.backend.dispose(entry.cell, entry.resource);
      this.resident.delete(id);
      this.bytes -= entry.resource.textureBytes;
      this.geometryBytes -= entry.resource.geometryBytes;
      this.evicted++;
    }
  }

  private cancel(controller: AbortController): void {
    if (controller.signal.aborted) return;
    this.cancelledLoads++;
    controller.abort();
  }

  private pump(): void {
    if (this.disposed) return;
    for (const cell of this.desired) {
      if (this.pending.size >= (this.options.concurrency ?? 2)) break;
      if (this.resident.has(cell.id) || this.pending.has(cell.id) || (this.retryAt.get(cell.id) ?? 0) > this.now()) continue;
      const generation = this.generation;
      const controller = new AbortController();
      let loading: Promise<T>;
      try { loading = this.backend.load(cell, controller.signal); }
      catch (error) { loading = Promise.reject(error); }
      const entry: PendingCell = { controller, task: Promise.resolve(), phase: 'loading' };
      entry.task = loading.then(async resource => {
        entry.phase = 'admitting';
        let owned = true, reserved = false;
        const stale = () => controller.signal.aborted || this.disposed || generation !== this.generation;
        try {
          // A cell can be wanted again before its cancelled decode finishes. That old result still
          // belongs to the cancelled request; release it and let a fresh request own the new view.
          if (stale()) { this.staleDisposed++; return; }
          if (![resource.textureBytes, resource.geometryBytes].every(value => Number.isFinite(value) && value >= 0)) throw new Error('Invalid decoded visual resource cost');
          this.costs.set(cell.id, resource.textureBytes);
          this.geometryCosts.set(cell.id, resource.geometryBytes);
          for (;;) {
            entry.phase = 'admitting';
            this.reselect();
            if (stale() || !this.desired.some(c => c.id === cell.id)) { this.staleDisposed++; return; }
            if (this.bytes + resource.textureBytes <= this.options.textureBudgetBytes &&
              this.geometryBytes + resource.geometryBytes <= (this.options.geometryBudgetBytes ?? Infinity)) break;
            // Cancelled GPU work can be uninterruptible. Keep the new CPU resource and its slot,
            // rather than repeatedly downloading it while the previous reservation is retiring.
            const retiring = [...this.pending.values()].filter(other => other.phase === 'preparing' && other.controller.signal.aborted);
            if (!retiring.length) { this.staleDisposed++; return; }
            entry.phase = 'waiting';
            await Promise.all(retiring.map(other => other.task));
            if (stale()) { this.staleDisposed++; return; }
          }
          this.bytes += resource.textureBytes;
          this.geometryBytes += resource.geometryBytes;
          this.peak = Math.max(this.peak, this.bytes);
          reserved = true;
          entry.phase = 'preparing';
          if (this.backend.prepare) await this.backend.prepare(cell, resource, controller.signal);
          if (stale() || !this.desired.some(c => c.id === cell.id)) { this.staleDisposed++; return; }
          this.backend.show(cell, resource);
          if (stale()) { this.staleDisposed++; return; }
          this.resident.set(cell.id, { cell, resource });
          owned = false; // The resident map now owns both the resource and its budget reservation.
          this.loaded++;
          this.errorByCell.delete(cell.id);
          this.retryAt.delete(cell.id);
        } finally {
          if (owned) {
            try { this.backend.dispose(cell, resource); }
            finally {
              if (reserved) {
                this.bytes -= resource.textureBytes;
                this.geometryBytes -= resource.geometryBytes;
              }
            }
          }
        }
      }).catch((error: unknown) => {
        if (controller.signal.aborted || this.disposed || generation !== this.generation) return;
        this.failures++;
        const message = error instanceof Error ? error.message : String(error);
        this.errorByCell.set(cell.id, message);
        this.failureHistory.push(`${cell.id}: ${message}`);
        if (this.failureHistory.length > 32) this.failureHistory.shift();
        this.retryAt.set(cell.id, this.now() + 3000);
      }).finally(() => {
        if (this.pending.get(cell.id) === entry) this.pending.delete(cell.id);
        this.pump();
      });
      this.pending.set(cell.id, entry);
    }
  }
}
