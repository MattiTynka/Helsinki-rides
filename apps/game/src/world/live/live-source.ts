// Main-thread client of the live cell worker (live-worker.ts). Collision results are fixed per square once the
// simulation consumed them (replays depend on it): memoized, shared by concurrent callers, and never a rejection except
// on abort, since a square whose sources stay unavailable gets an empty bundle. Visual payloads are built on request. edgeOverrides pins
// live ground to the release terrain where a live square meets a static one.
import { LIVE_VERSION } from '@helsinki/sim';
import { cellId } from '@helsinki/world-schema';
import {
  type LiveCellSourceInit, type LiveCollisionResult, type LiveGroundVisual, type LiveSourceStats, type LiveVisualKind, type LiveVisualResult,
} from './contract.ts';
import { emptyCollisionCell } from './convert/collision-cell.ts';
export { edgeOverrides } from './convert/terrain.ts';
import { abortError, errorMessage, Lru, SharedRuns, type LiveNetStats } from './live-net.ts';
import type { LiveWorkerRequest, LiveWorkerResponse } from './live-worker.ts';

/** A job request before its request id is assigned. */
type WithoutReq<R> = R extends { readonly req: number } ? Omit<R, 'req'> : never;
type Request = WithoutReq<LiveWorkerRequest>;

interface Waiter {
  readonly resolve: (message: LiveWorkerResponse) => void;
  readonly reject: (error: unknown) => void;
}

export class LiveCellSource {
  private readonly originId: string;
  private readonly worker: Worker | null;
  private readonly waiters = new Map<number, Waiter>();
  private readonly runs = new SharedRuns<LiveCollisionResult>();
  /** Recently built collision bytes by id; the first result for an id stands while it is kept. */
  private readonly built = new Lru<Uint8Array>(256);
  /** Bytes the simulation inserted: the square's only answer for the rest of the session (replays depend on it). */
  private readonly consumed = new Map<string, Uint8Array>();
  /** Empty bundles answered for unavailable sources; never kept unless the simulation consumed one. */
  private readonly emptyBundles = new WeakSet<Uint8Array>();
  private readonly grounds = new Lru<LiveGroundVisual>(128);
  private nextReq = 1;
  /** Set when the worker cannot run: collision answers empty bundles, visuals reject. */
  private failure: string | null = null;
  private ready = false;
  private disposed = false;
  private collisionBuilt = 0;
  private collisionEmpty = 0;
  private collisionCached = 0;
  private visualBuilt = 0;
  private net: LiveNetStats = { requests: 0, downloadedBytes: 0, errors: [] };
  private readonly errors: string[] = [];

  constructor(init: LiveCellSourceInit) {
    this.originId = init.originId;
    let worker: Worker | null = null;
    try {
      worker = new Worker(new URL('./live-worker.ts', import.meta.url), { type: 'module' });
      worker.addEventListener('message', (event: MessageEvent<LiveWorkerResponse>) => this.receive(event.data));
      worker.addEventListener('error', event => {
        event.preventDefault();
        const message = event.message || 'live worker error';
        // Before 'ready' the worker failed to load; afterwards an error is only reported.
        if (this.ready) this.note(message);
        else this.fail(message);
      });
      worker.addEventListener('messageerror', () => this.note('live worker message could not be decoded'));
      worker.postMessage({ type: 'init', init, liveVersion: LIVE_VERSION } satisfies LiveWorkerRequest);
    } catch (error) {
      worker?.terminate();
      worker = null;
      this.fail(`live worker unavailable: ${errorMessage(error)}`);
    }
    this.worker = worker;
  }

  /**
   * The square's collision result. Once the simulation has consumed an id (`pin`) it resolves to those bytes for the
   * whole session. Resolves with an empty bundle (empty: true, not kept) when the sources stay unavailable after
   * retries; rejects only when `signal` aborts. `needGround` rebuilds a result whose ground visual was evicted.
   */
  collision(cx: number, cz: number, overrides: Float32Array | null, signal?: AbortSignal, needGround = false): Promise<LiveCollisionResult> {
    const id = cellId(cx, cz);
    const known = this.known(id);
    if (known && (!needGround || known.ground || known.empty)) return Promise.resolve(known);
    if (this.disposed) return Promise.reject(abortError());
    return this.runs.run(id, signal, async inner => {
      try {
        const copy = overrides ? overrides.slice() : null;
        const message = await this.ask({ type: 'collision', cx, cz, overrides: copy }, inner, copy ? [copy.buffer] : []);
        if (message.type === 'collision') return this.remember(message.result, message.cached);
        throw new Error(message.type === 'failed' ? message.message : `unexpected ${message.type} reply`);
      } catch (error) {
        if (inner.aborted || this.disposed) throw abortError();
        this.note(`${id} collision: ${errorMessage(error)}`);
        return this.remember({ id, hcol: emptyCollisionCell(id, this.originId), ground: null, empty: true }, false);
      }
    });
  }

  /** The square's LoD2 buildings at `maxGeometricError`; rejects on failure or abort (the visual stream retries). */
  async visual(cx: number, cz: number, maxGeometricError: number, kind: LiveVisualKind, signal?: AbortSignal): Promise<LiveVisualResult> {
    const message = await this.ask({ type: 'visual', cx, cz, maxGeometricError, kind }, signal, []);
    if (message.type === 'visual') {
      this.visualBuilt++;
      return message.result;
    }
    throw new Error(message.type === 'failed' ? message.message : `unexpected ${message.type} reply`);
  }

  /** Ground visual of a recent collision result (LRU of about 128 squares). */
  ground(id: string): LiveGroundVisual | undefined { return this.grounds.get(id); }

  /** Records the bytes the simulation inserted for a square; the first pin stands for the session. */
  pin(id: string, hcol: Uint8Array): void { if (!this.consumed.has(id)) this.consumed.set(id, hcol); }

  pinned(id: string): boolean { return this.consumed.has(id); }

  stats(): LiveSourceStats {
    return {
      collisionBuilt: this.collisionBuilt, collisionEmpty: this.collisionEmpty, collisionCached: this.collisionCached, visualBuilt: this.visualBuilt,
      pending: this.waiters.size, requests: this.net.requests, downloadedMiB: this.net.downloadedBytes / 2 ** 20,
      errors: [...this.net.errors, ...this.errors].slice(-8),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker?.terminate();
    for (const waiter of this.waiters.values()) waiter.reject(abortError());
    this.waiters.clear();
  }

  private known(id: string): LiveCollisionResult | null {
    const hcol = this.consumed.get(id) ?? this.built.get(id);
    if (!hcol) return null;
    const empty = this.emptyBundles.has(hcol);
    return { id, hcol, ground: empty ? null : this.grounds.peek(id) ?? null, empty };
  }

  /** Keeps the first result per id; a later one only restores an evicted ground visual. Empty results are not kept. */
  private remember(result: LiveCollisionResult, cached: boolean): LiveCollisionResult {
    const known = this.known(result.id);
    if (known) {
      if (!known.empty && !known.ground && result.ground && !result.empty) {
        this.grounds.set(result.id, result.ground);
        return { ...known, ground: result.ground };
      }
      return known;
    }
    if (result.empty) {
      this.emptyBundles.add(result.hcol);
      this.collisionEmpty++;
    } else {
      this.built.set(result.id, result.hcol);
      if (cached) this.collisionCached++;
      else this.collisionBuilt++;
      if (result.ground) this.grounds.set(result.id, result.ground);
    }
    return result;
  }

  private ask(request: Request, signal: AbortSignal | undefined, transfer: ArrayBuffer[]): Promise<LiveWorkerResponse> {
    if (this.disposed || signal?.aborted) return Promise.reject(abortError());
    const worker = this.worker;
    if (this.failure !== null || !worker) return Promise.reject(new Error(this.failure ?? 'live worker unavailable'));
    const req = this.nextReq++;
    return new Promise<LiveWorkerResponse>((resolve, reject) => {
      const onAbort = () => {
        if (!this.waiters.delete(req)) return;
        worker.postMessage({ type: 'abort', req } satisfies LiveWorkerRequest);
        reject(abortError());
      };
      this.waiters.set(req, {
        resolve: message => { signal?.removeEventListener('abort', onAbort); resolve(message); },
        reject: error => { signal?.removeEventListener('abort', onAbort); reject(error); },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      try { worker.postMessage({ ...request, req } as LiveWorkerRequest, { transfer }); }
      catch (error) {
        this.waiters.delete(req);
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      }
    });
  }

  private receive(message: LiveWorkerResponse): void {
    this.ready = true;
    this.net = message.net;
    if (message.type === 'ready') return;
    const waiter = this.waiters.get(message.req);
    if (waiter) {
      this.waiters.delete(message.req);
      waiter.resolve(message);
    } else if (message.type === 'collision') {
      // Finished after its callers aborted: still the square's result for this session.
      this.remember(message.result, message.cached);
    }
  }

  private fail(reason: string): void {
    if (this.failure !== null) return;
    this.failure = reason;
    this.note(reason);
    const error = new Error(reason);
    for (const waiter of this.waiters.values()) waiter.reject(error);
    this.waiters.clear();
  }

  private note(message: string): void {
    this.errors.push(message);
    if (this.errors.length > 8) this.errors.splice(0, this.errors.length - 8);
  }
}
