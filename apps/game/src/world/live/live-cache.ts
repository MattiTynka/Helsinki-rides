// Cache Storage for built live collision cells: a square's HCOL bytes and ground visual, keyed by the converter and the
// city's source versions, so a revisit skips the city's servers. Best effort throughout: private windows and full
// disks throw, and a miss only costs a rebuild.
import type { LiveCellSourceInit, LiveGroundVisual, LiveSurface } from './contract.ts';

export const LIVE_CACHE_NAME = 'helsinki-live:v1';
/** Older entries are ignored. */
export const LIVE_CACHE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

export interface LiveCacheVersions {
  /** LIVE_VERSION of the converter. */
  readonly live: string;
  /** Root tileset `asset.tilesetVersion` of the textured LoD2 layer. */
  readonly tileset: string;
  /** Terrain `layer.json` version. */
  readonly terrain: string;
}

export interface LiveCacheEntry {
  readonly storedAt: number;
  readonly fingerprint: number;
  readonly hcol: Uint8Array;
  readonly ground: LiveGroundVisual | null;
}

/** 'HLCC' read as a little-endian u32. */
const MAGIC = 0x4343_4c48;
const FORMAT = 1;
const HEADER = 24;
const SURFACES: readonly LiveSurface[] = ['road', 'walk', 'green', 'yard'];
const FNV_SEED = 0x811c_9dc5;

export function liveCachePrefix(v: LiveCacheVersions): string { return `https://live.invalid/${v.live}/${v.tileset}/${v.terrain}/`; }

export function liveCacheKey(v: LiveCacheVersions, id: string): string { return liveCachePrefix(v) + id; }

function fnv1a(hash: number, data: string | Uint8Array): number {
  let h = hash >>> 0;
  if (typeof data === 'string') for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data.charCodeAt(i), 0x0100_0193) >>> 0;
  else for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data[i]!, 0x0100_0193) >>> 0;
  return h;
}

/**
 * The release context a live collision cell depends on besides its sources: the origin, the static squares and the
 * static register ids. A cached cell from another release (same city versions) then misses instead of misfitting.
 */
export function contextFingerprint(init: LiveCellSourceInit): number {
  let h = fnv1a(FNV_SEED, `${init.originId}|${init.origin.join(',')}|`);
  for (const id of init.staticCellIds) h = fnv1a(h, `${id},`);
  h = fnv1a(h, '|');
  for (const vtj of init.staticVtj) h = fnv1a(h, `${vtj},`);
  return h;
}

/** Context plus the square's edge overrides (the release ground its seam copies). */
export function cellFingerprint(context: number, overrides: Float32Array | null): number {
  return overrides ? fnv1a(context, new Uint8Array(overrides.buffer, overrides.byteOffset, overrides.byteLength)) : fnv1a(context, 'none');
}

type Chunk = number | Uint8Array | Float32Array | Uint32Array;

/**
 * Container: u32 'HLCC', u32 format, f64 stored-at (ms since epoch), u32 fingerprint, u32 flags (1 ground, 2 water),
 * then length-prefixed arrays, each 4-byte aligned: hcol bytes; ground positions, normals, class count and per class a
 * surface index and indices; water positions and indices. Typed arrays are stored in platform (little-endian) order.
 */
export function encodeLiveCollision(hcol: Uint8Array, ground: LiveGroundVisual | null, fingerprint: number, storedAt: number): Uint8Array<ArrayBuffer> {
  const chunks: Chunk[] = [hcol];
  if (ground) {
    chunks.push(ground.positions, ground.normals, ground.classes.length);
    for (const c of ground.classes) chunks.push(SURFACES.indexOf(c.surface), c.indices);
    if (ground.water) chunks.push(ground.water.positions, ground.water.indices);
  }
  let size = HEADER;
  for (const c of chunks) size += typeof c === 'number' ? 4 : 4 + align4(c.byteLength);
  const out = new Uint8Array(size), dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, FORMAT, true);
  dv.setFloat64(8, storedAt, true);
  dv.setUint32(16, fingerprint >>> 0, true);
  dv.setUint32(20, (ground ? 1 : 0) | (ground?.water ? 2 : 0), true);
  let at = HEADER;
  for (const c of chunks) {
    if (typeof c === 'number') { dv.setUint32(at, c, true); at += 4; continue; }
    dv.setUint32(at, c instanceof Uint8Array ? c.byteLength : c.length, true);
    out.set(new Uint8Array(c.buffer, c.byteOffset, c.byteLength), at + 4);
    at += 4 + align4(c.byteLength);
  }
  return out;
}

/** Throws on a malformed container. The hcol is a copy; ground arrays are views of `buffer`. */
export function decodeLiveCollision(buffer: ArrayBuffer): LiveCacheEntry {
  const dv = new DataView(buffer);
  let at = HEADER;
  const u32 = (): number => {
    if (at + 4 > buffer.byteLength) throw new Error('truncated live cache entry');
    const v = dv.getUint32(at, true);
    at += 4;
    return v;
  };
  const span = (bytes: number): number => {
    const start = at;
    if (start + bytes > buffer.byteLength) throw new Error('truncated live cache entry');
    at += align4(bytes);
    return start;
  };
  const f32 = (): Float32Array => { const n = u32(); return new Float32Array(buffer, span(n * 4), n); };
  const indices = (): Uint32Array => { const n = u32(); return new Uint32Array(buffer, span(n * 4), n); };
  if (buffer.byteLength < HEADER || dv.getUint32(0, true) !== MAGIC || dv.getUint32(4, true) !== FORMAT) throw new Error('not a live cache entry');
  const storedAt = dv.getFloat64(8, true), fingerprint = dv.getUint32(16, true), flags = dv.getUint32(20, true);
  const hcolBytes = u32();
  const hcol = new Uint8Array(buffer, span(hcolBytes), hcolBytes).slice();
  let ground: LiveGroundVisual | null = null;
  if (flags & 1) {
    const positions = f32(), normals = f32(), classCount = u32();
    const classes: { surface: LiveSurface; indices: Uint32Array }[] = [];
    for (let i = 0; i < classCount; i++) {
      const surface = SURFACES[u32()];
      if (!surface) throw new Error('unknown surface in live cache entry');
      classes.push({ surface, indices: indices() });
    }
    const water = flags & 2 ? { positions: f32(), indices: indices() } : null;
    ground = { positions, normals, classes, water };
  }
  return { storedAt, fingerprint, hcol, ground };
}

function align4(n: number): number { return (n + 3) & ~3; }

async function openCache(): Promise<Cache | null> {
  if (typeof caches === 'undefined') return null;
  return caches.open(LIVE_CACHE_NAME);
}

/** A fresh entry built from the same release context, or null. Never throws. */
export async function readLiveCollision(key: string, fingerprint: number, now = Date.now()): Promise<LiveCacheEntry | null> {
  try {
    const cache = await openCache();
    const response = await cache?.match(key);
    if (!response) return null;
    const entry = decodeLiveCollision(await response.arrayBuffer());
    const age = now - entry.storedAt;
    if (!(age >= 0 && age <= LIVE_CACHE_MAX_AGE_MS) || entry.fingerprint !== fingerprint >>> 0) return null;
    return entry;
  } catch { return null; }
}

/** Stores an encoded container (encodeLiveCollision). Never throws. */
export async function writeLiveCollision(key: string, container: Uint8Array<ArrayBuffer>): Promise<void> {
  try {
    const cache = await openCache();
    await cache?.put(key, new Response(container, { headers: { 'content-type': 'application/octet-stream' } }));
  } catch { /* quota, private window: the cell is rebuilt next time */ }
}

/** Drops entries of other converter or source versions. Never throws. */
export async function pruneLiveCache(keepPrefix: string): Promise<void> {
  try {
    const cache = await openCache();
    if (!cache) return;
    for (const request of await cache.keys()) if (!request.url.startsWith(keepPrefix)) await cache.delete(request);
  } catch { /* best effort */ }
}
