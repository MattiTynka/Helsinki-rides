// Network helpers of the live city cells (docs/live-kartta-cells-plan-2026-10-30.md §6): only LIVE_SOURCES URLs are
// fetched, at most four at a time with collision work ahead of visuals, with retries and backoff. Also the small LRU
// and shared-run helpers the worker and its main-thread client use.
import { LIVE_SOURCES } from './contract.ts';

export type LivePriority = 'collision' | 'visual';

export interface LiveNetStats {
  readonly requests: number;
  readonly downloadedBytes: number;
  readonly errors: readonly string[];
}

export interface LiveBody {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly contentType: string;
}

/** Concurrent requests to kartta.hel.fi. */
export const LIVE_REQUEST_LIMIT = 4;
/** Waits before the three retries of a network error, timeout, 429 or 5xx. */
const RETRY_MS = [500, 1000, 2000] as const;
/** One attempt (headers and body) is abandoned and retried after this long. */
const ATTEMPT_TIMEOUT_MS: Readonly<Record<LivePriority, number>> = { collision: 15_000, visual: 30_000 };

const ALLOWED_PREFIXES = [
  LIVE_SOURCES.lod2Tileset.slice(0, LIVE_SOURCES.lod2Tileset.lastIndexOf('/') + 1),
  LIVE_SOURCES.terrainLayer,
  `${LIVE_SOURCES.wfs}?`,
  `${LIVE_SOURCES.wms}?`,
];

/** Normalised URL when it lies under one of the LIVE_SOURCES endpoints, else null. */
export function allowedLiveUrl(url: string): string | null {
  let href: string;
  try { href = new URL(url).href; } catch { return null; }
  return ALLOWED_PREFIXES.some(prefix => href.startsWith(prefix)) ? href : null;
}

export function abortError(): DOMException { return new DOMException('The live request was aborted', 'AbortError'); }

export function isAbortError(error: unknown): boolean { return error instanceof DOMException && error.name === 'AbortError'; }

export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** Settles like `promise`, or rejects with an AbortError as soon as `signal` aborts. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); });
  });
}

export function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

interface Waiter {
  readonly grant: () => void;
  readonly onAbort: () => void;
}

/** Request slots: collision waiters always go before visual ones; a queued waiter leaves the queue when aborted. */
export class RequestLimiter {
  private readonly limit: number;
  private active = 0;
  private readonly queues: Record<LivePriority, Waiter[]> = { collision: [], visual: [] };

  constructor(limit: number) { this.limit = limit; }

  /** Resolves with the slot's release function. */
  acquire(priority: LivePriority, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise<() => void>((resolve, reject) => {
      const queue = this.queues[priority];
      const waiter: Waiter = {
        grant: () => { signal.removeEventListener('abort', waiter.onAbort); this.active++; resolve(this.releaser()); },
        onAbort: () => { const i = queue.indexOf(waiter); if (i >= 0) queue.splice(i, 1); reject(abortError()); },
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      queue.push(waiter);
      this.pump();
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.pump();
    };
  }

  private pump(): void {
    while (this.active < this.limit) {
      const next = this.queues.collision.shift() ?? this.queues.visual.shift();
      if (!next) return;
      next.grant();
    }
  }
}

class HttpStatusError extends Error {
  readonly retry: boolean;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.retry = status >= 500 || status === 429;
  }
}

/** GETs against the allow-listed sources through one limiter, with retries, timeouts and byte counts. */
export class LiveNet {
  private readonly limiter = new RequestLimiter(LIVE_REQUEST_LIMIT);
  requests = 0;
  downloadedBytes = 0;

  get(url: string, priority: LivePriority, signal: AbortSignal): Promise<LiveBody> {
    return this.request(url, priority, signal, false) as Promise<LiveBody>;
  }

  /** As get, but a 404 resolves null: the source has no data there (a terrain tile outside the layer). */
  getOrNull(url: string, priority: LivePriority, signal: AbortSignal): Promise<LiveBody | null> {
    return this.request(url, priority, signal, true);
  }

  private async request(url: string, priority: LivePriority, signal: AbortSignal, notFoundIsEmpty: boolean): Promise<LiveBody | null> {
    const href = allowedLiveUrl(url);
    if (!href) throw new Error(`not a live source: ${url}`);
    for (let attempt = 0; ; attempt++) {
      let failure: unknown;
      const release = await this.limiter.acquire(priority, signal);
      const controller = new AbortController();
      const forward = () => controller.abort(signal.reason);
      signal.addEventListener('abort', forward, { once: true });
      const timer = setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), ATTEMPT_TIMEOUT_MS[priority]);
      try {
        this.requests++;
        const response = await fetch(href, { signal: controller.signal, credentials: 'omit' });
        if (response.status === 404 && notFoundIsEmpty) {
          response.body?.cancel().catch(() => {});
          return null;
        }
        if (!response.ok) {
          response.body?.cancel().catch(() => {});
          throw new HttpStatusError(response.status);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        this.downloadedBytes += bytes.byteLength;
        return { bytes, contentType: response.headers.get('content-type') ?? '' };
      } catch (error) {
        if (signal.aborted) throw abortError();
        failure = error;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', forward);
        release();
      }
      // Network errors (TypeError) and timeouts are retried; of HTTP statuses only 429 and 5xx.
      const retry = failure instanceof HttpStatusError ? failure.retry : true;
      if (!retry || attempt >= RETRY_MS.length) throw new Error(`${shortUrl(href)}: ${errorMessage(failure)}`);
      await delay(RETRY_MS[attempt]!, signal);
    }
  }
}

function shortUrl(href: string): string {
  const s = href.replace('https://kartta.hel.fi', '');
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
}

/** Least-recently-used map bounded by total weight (entry count unless a weight function is given). */
export class Lru<V> {
  private readonly entries = new Map<string, { readonly value: V; readonly weight: number }>();
  private readonly limit: number;
  private readonly weigh: (value: V) => number;
  private total = 0;

  constructor(limit: number, weigh: (value: V) => number = () => 1) {
    this.limit = limit;
    this.weigh = weigh;
  }

  /** Reads and marks the entry as most recently used. */
  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /** Reads without changing the order. */
  peek(key: string): V | undefined { return this.entries.get(key)?.value; }

  set(key: string, value: V): void {
    this.delete(key);
    const weight = this.weigh(value);
    this.entries.set(key, { value, weight });
    this.total += weight;
    for (const [oldest, entry] of this.entries) {
      if (this.total <= this.limit) break;
      this.entries.delete(oldest);
      this.total -= entry.weight;
    }
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.total -= entry.weight;
  }
}

interface Run<T> {
  readonly promise: Promise<T>;
  readonly controller: AbortController;
  waiters: number;
}

/** Concurrent callers of one key share one run; the run is aborted only when every caller has aborted. */
export class SharedRuns<T> {
  private readonly runs = new Map<string, Run<T>>();

  run(key: string, signal: AbortSignal | undefined, start: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortError());
    let run = this.runs.get(key);
    if (!run) {
      const controller = new AbortController();
      const created: Run<T> = {
        controller, waiters: 0,
        promise: (async () => start(controller.signal))().finally(() => { if (this.runs.get(key) === created) this.runs.delete(key); }),
      };
      this.runs.set(key, created);
      run = created;
    }
    const shared = run;
    shared.waiters++;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        reject(abortError());
        if (--shared.waiters === 0) {
          shared.controller.abort();
          if (this.runs.get(key) === shared) this.runs.delete(key);
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      shared.promise.then(value => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      }, (error: unknown) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      });
    });
  }
}
