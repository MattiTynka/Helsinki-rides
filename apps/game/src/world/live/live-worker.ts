// Live city cell worker (docs/live-kartta-cells-plan-2026-10-30.md): fetches the City of Helsinki's terrain, building
// footprints, street parts, water mask and textured LoD2 tiles from kartta.hel.fi and converts them into a square's
// collision and visual payloads off the main thread. A collision job never fails: when a source stays unavailable
// after retries it answers an empty bundle. Created by live-source.ts as a module worker.
import { cellId } from '@helsinki/world-schema';
import {
  LIVE_GROUND_QUADS, LIVE_GROUND_STEP, LIVE_SOURCES,
  type GeoJsonFeatureCollection, type LiveCellSourceInit, type LiveCollisionResult, type LiveVisualResult, type TerrainTileAddress,
} from './contract.ts';
import { buildCollisionCell, emptyCollisionCell } from './convert/collision-cell.ts';
import { cellParts, convertTile, type ConvertedTile } from './convert/buildings.ts';
import { squareGeodeticBox } from './convert/projection.ts';
import { decodeQuantizedMesh, sampleLattice, terrainTileAddresses, type QuantizedTile } from './convert/terrain.ts';
import { selectTiles, type SelectedTile } from './convert/tileset.ts';
import {
  cellFingerprint, contextFingerprint, encodeLiveCollision, liveCacheKey, liveCachePrefix, pruneLiveCache, readLiveCollision, writeLiveCollision,
  type LiveCacheVersions,
} from './live-cache.ts';
import { abortable, errorMessage, LiveNet, Lru, SharedRuns, type LiveNetStats, type LivePriority } from './live-net.ts';

export type LiveWorkerRequest =
  | { readonly type: 'init'; readonly init: LiveCellSourceInit; readonly liveVersion: string }
  | { readonly type: 'collision'; readonly req: number; readonly cx: number; readonly cz: number; readonly overrides: Float32Array | null }
  | { readonly type: 'visual'; readonly req: number; readonly cx: number; readonly cz: number; readonly maxGeometricError: number }
  | { readonly type: 'abort'; readonly req: number };

export type LiveWorkerResponse =
  | { readonly type: 'ready'; readonly net: LiveNetStats }
  | { readonly type: 'collision'; readonly req: number; readonly result: LiveCollisionResult; readonly cached: boolean; readonly net: LiveNetStats }
  | { readonly type: 'visual'; readonly req: number; readonly result: LiveVisualResult; readonly net: LiveNetStats }
  | { readonly type: 'failed'; readonly req: number; readonly message: string; readonly aborted: boolean; readonly net: LiveNetStats };

/** Square side and the footprint margin (LIVE_CELL_SIZE and LIVE_MARGIN in @helsinki/sim live-grid.ts). */
const SQUARE = LIVE_GROUND_STEP * LIVE_GROUND_QUADS;
const MARGIN = 32;
/** Metres around the square for choosing LoD2 tiles. */
const VISUAL_PAD = 8;

interface Session {
  readonly init: LiveCellSourceInit;
  readonly liveVersion: string;
  readonly staticCells: ReadonlySet<string>;
  readonly staticBuildings: ReadonlySet<string>;
  readonly staticVtj: ReadonlySet<string>;
  readonly context: number;
}

let session: Session | null = null;
const net = new LiveNet();
const errors: string[] = [];
const jobs = new Map<number, AbortController>();
const decoder = new TextDecoder();

const tilesetJson = new Lru<unknown>(4096);
const terrainTiles = new Lru<QuantizedTile | null>(512);
const lod2Tiles = new Lru<ConvertedTile>(96 * 2 ** 20, tile => tile.bytes);
const tilesetRuns = new SharedRuns<unknown>();
const terrainRuns = new SharedRuns<QuantizedTile | null>();
const lod2Runs = new SharedRuns<ConvertedTile>();
/** Never aborted: the version lookup is shared by every job of the session. */
const sessionSignal = new AbortController().signal;
let versions: Promise<LiveCacheVersions> | null = null;
let versionsFailure: { readonly at: number; readonly error: unknown } | null = null;
const VERSION_RETRY_MS = 30_000;

function note(message: string): void {
  errors.push(message);
  if (errors.length > 8) errors.splice(0, errors.length - 8);
}

function netStats(): LiveNetStats {
  return { requests: net.requests, downloadedBytes: net.downloadedBytes, errors: errors.slice() };
}

/** Posts with every distinct ArrayBuffer behind `arrays` transferred; never throws. */
function post(message: LiveWorkerResponse, arrays: readonly (ArrayBufferView | ArrayBuffer | null | undefined)[] = []): void {
  const transfer = new Set<ArrayBuffer>();
  for (const a of arrays) {
    const buffer = a instanceof ArrayBuffer ? a : a?.buffer;
    if (buffer instanceof ArrayBuffer) transfer.add(buffer);
  }
  try { self.postMessage(message, { transfer: [...transfer] }); }
  catch (error) {
    note(`post: ${errorMessage(error)}`);
    if (message.type === 'ready') return;
    try { self.postMessage({ type: 'failed', req: message.req, message: errorMessage(error), aborted: false, net: netStats() } satisfies LiveWorkerResponse); }
    catch { /* nothing left to tell */ }
  }
}

function fail(req: number, message: string, aborted: boolean): void {
  post({ type: 'failed', req, message, aborted, net: netStats() });
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

async function fetchJson(url: string, priority: LivePriority, signal: AbortSignal): Promise<unknown> {
  const body = await net.get(url, priority, signal);
  return JSON.parse(decoder.decode(body.bytes)) as unknown;
}

/** Tileset JSON by URL: neighbouring squares share every hop from the root to their leaves. */
function tileset(url: string, priority: LivePriority, signal: AbortSignal): Promise<unknown> {
  const hit = tilesetJson.get(url);
  if (hit !== undefined) return Promise.resolve(hit);
  return tilesetRuns.run(url, signal, async s => {
    const json = await fetchJson(url, priority, s);
    tilesetJson.set(url, json);
    return json;
  });
}

/** The root tileset's `asset.tilesetVersion` and the terrain layer version; looked up again after a failure. */
function sourceVersions(): Promise<LiveCacheVersions> {
  if (versions) return versions;
  // After a failed lookup, fail fast for a while: each lookup can take a minute of timeouts on a silent network.
  if (versionsFailure && performance.now() - versionsFailure.at < VERSION_RETRY_MS) return Promise.reject(versionsFailure.error);
  const s = session!;
  const lookup = (async (): Promise<LiveCacheVersions> => {
    const [root, layer] = await Promise.all([
      tileset(LIVE_SOURCES.lod2Tileset, 'collision', sessionSignal),
      fetchJson(`${LIVE_SOURCES.terrainLayer}layer.json`, 'collision', sessionSignal),
    ]);
    const tilesetVersion = record(record(root).asset).tilesetVersion, terrainVersion = record(layer).version;
    if ((typeof tilesetVersion !== 'string' && typeof tilesetVersion !== 'number') || (typeof terrainVersion !== 'string' && typeof terrainVersion !== 'number')) {
      throw new Error('source versions: tileset asset.tilesetVersion or terrain layer version missing');
    }
    const v: LiveCacheVersions = { live: s.liveVersion, tileset: String(tilesetVersion), terrain: String(terrainVersion) };
    void pruneLiveCache(liveCachePrefix(v));
    return v;
  })();
  versions = lookup;
  lookup.then(() => { versionsFailure = null; }, (error: unknown) => {
    if (versions === lookup) versions = null;
    versionsFailure = { at: performance.now(), error };
    note(`source versions: ${errorMessage(error)}`);
  });
  return lookup;
}

/** Bodies normally arrive brotli-decoded by fetch; a still gzipped one is inflated here. */
async function gunzipIfNeeded(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A decoded terrain tile, or null where the layer has none (404). */
function terrainTile(address: TerrainTileAddress, version: string, signal: AbortSignal): Promise<QuantizedTile | null> {
  const path = `${address.z}/${address.x}/${address.y}`, key = `${version}/${path}`;
  const hit = terrainTiles.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  return terrainRuns.run(key, signal, async s => {
    const body = await net.getOrNull(`${LIVE_SOURCES.terrainLayer}${path}.terrain?v=${encodeURIComponent(version)}`, 'collision', s);
    const tile = body ? decodeQuantizedMesh(await gunzipIfNeeded(body.bytes)) : null;
    terrainTiles.set(key, tile);
    return tile;
  });
}

async function terrainFor(cx: number, cz: number, version: string, signal: AbortSignal): Promise<{ address: TerrainTileAddress; tile: QuantizedTile }[]> {
  const addresses = terrainTileAddresses(cx, cz, session!.init.origin);
  const tiles = await Promise.all(addresses.map(a => terrainTile(a, version, signal)));
  return addresses.flatMap((address, i) => {
    const tile = tiles[i];
    return tile ? [{ address, tile }] : [];
  });
}

/** EPSG:3879 extent of the square grown by `margin`: easting from origin E0 + x, northing from N0 − z. */
function extent(cx: number, cz: number, margin: number): { e0: number; n0: number; e1: number; n1: number } {
  const [E0, N0] = session!.init.origin, x0 = cx * SQUARE, z0 = cz * SQUARE;
  return { e0: E0 + x0 - margin, e1: E0 + x0 + SQUARE + margin, n0: N0 - z0 - SQUARE - margin, n1: N0 - z0 + margin };
}

function isFeatureCollection(value: unknown): value is GeoJsonFeatureCollection {
  const r = record(value);
  return r.type === 'FeatureCollection' && Array.isArray(r.features);
}

/** WFS 2.0.0 GetFeature over the square ± `margin`; the bbox is easting, northing here. */
async function features(layer: string, cx: number, cz: number, margin: number, signal: AbortSignal): Promise<GeoJsonFeatureCollection> {
  const { e0, n0, e1, n1 } = extent(cx, cz, margin);
  const url = `${LIVE_SOURCES.wfs}?service=WFS&version=2.0.0&request=GetFeature&typeNames=${encodeURIComponent(layer)}&srsName=EPSG%3A3879`
    + `&bbox=${e0}%2C${n0}%2C${e1}%2C${n1}%2CEPSG%3A3879&outputFormat=application%2Fjson&count=2000`;
  const body = await net.get(url, 'collision', signal);
  let value: unknown;
  try { value = JSON.parse(decoder.decode(body.bytes)); } catch { value = null; }
  if (!isFeatureCollection(value)) throw new Error(`${layer}: not a GeoJSON feature collection (${decoder.decode(body.bytes.subarray(0, 120))})`);
  return value;
}

/**
 * QUADS × QUADS water mask (1 = water) from a WMS 1.3.0 GetMap over exactly the square. EPSG:3879 in WMS 1.3.0 takes
 * its bbox northing first (verified 30 Oct 2026: easting-first returns an empty image for an all-sea square). Image
 * row 0 is north, which is iz 0 since runtime z grows southward.
 */
async function waterMask(cx: number, cz: number, signal: AbortSignal): Promise<Uint8Array> {
  const Q = LIVE_GROUND_QUADS, { e0, n0, e1, n1 } = extent(cx, cz, 0);
  const url = `${LIVE_SOURCES.wms}?service=WMS&version=1.3.0&request=GetMap&layers=${encodeURIComponent(LIVE_SOURCES.water.join(','))}`
    + `&styles=&crs=EPSG%3A3879&bbox=${n0}%2C${e0}%2C${n1}%2C${e1}&width=${Q}&height=${Q}&format=image%2Fpng&transparent=true`
    // Anti-aliased edge pixels would mark every quad that merely touches the shore as water.
    + '&format_options=antialiasing%3Aoff';
  const body = await net.get(url, 'collision', signal);
  if (!body.contentType.startsWith('image/png')) throw new Error(`water mask: ${body.contentType || 'no content type'} (${decoder.decode(body.bytes.subarray(0, 120))})`);
  const bitmap = await createImageBitmap(new Blob([body.bytes], { type: 'image/png' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  try {
    if (bitmap.width !== Q || bitmap.height !== Q) throw new Error(`water mask: ${bitmap.width} × ${bitmap.height} image`);
    const context = new OffscreenCanvas(Q, Q).getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('water mask: no 2D context');
    context.drawImage(bitmap, 0, 0);
    const rgba = context.getImageData(0, 0, Q, Q).data;
    const mask = new Uint8Array(Q * Q);
    for (let i = 0; i < mask.length; i++) mask[i] = rgba[i * 4 + 3]! >= 128 ? 1 : 0;
    return mask;
  } finally { bitmap.close(); }
}

function isStaticSquare(cx: number, cz: number): boolean { return session!.staticCells.has(cellId(cx, cz)); }

/** Cached collision cell, else a fresh build from the sources; an empty bundle when any source stays unavailable. */
async function collisionJob(req: number, cx: number, cz: number, overrides: Float32Array | null, signal: AbortSignal): Promise<void> {
  const s = session!, id = cellId(cx, cz), fingerprint = cellFingerprint(s.context, overrides);
  try {
    const v = await abortable(sourceVersions(), signal);
    const key = liveCacheKey(v, id);
    const hit = await readLiveCollision(key, fingerprint);
    signal.throwIfAborted();
    if (hit) {
      const result: LiveCollisionResult = { id, hcol: hit.hcol, ground: hit.ground, empty: false };
      post({ type: 'collision', req, result, cached: true, net: netStats() }, collisionArrays(result));
      return;
    }
    // One failing source cancels the others' remaining requests.
    const inputs = new AbortController();
    const forward = () => inputs.abort();
    signal.addEventListener('abort', forward, { once: true });
    const [tiles, footprints, streetParts, mask] = await Promise.all([
      terrainFor(cx, cz, v.terrain, inputs.signal),
      // Footprints owned by the square reach MARGIN past it; street parts only paint the square's own ground.
      features(LIVE_SOURCES.footprints, cx, cz, MARGIN, inputs.signal),
      features(LIVE_SOURCES.streetParts, cx, cz, 0, inputs.signal),
      waterMask(cx, cz, inputs.signal),
    ]).catch((error: unknown) => {
      inputs.abort();
      throw error;
    }).finally(() => signal.removeEventListener('abort', forward));
    signal.throwIfAborted();
    const heights = sampleLattice(cx, cz, s.init.origin, tiles, overrides);
    const out = buildCollisionCell({
      id, cx, cz, originId: s.init.originId, origin: s.init.origin, heights, waterMask: mask, footprints, streetParts, staticVtj: s.staticVtj, isStaticSquare,
    });
    // Encoded (a copy) before the arrays are transferred away.
    void writeLiveCollision(key, encodeLiveCollision(out.hcol, out.ground, fingerprint, Date.now()));
    const result: LiveCollisionResult = { id, hcol: out.hcol, ground: out.ground, empty: false };
    post({ type: 'collision', req, result, cached: false, net: netStats() }, collisionArrays(result));
  } catch (error) {
    if (signal.aborted) { fail(req, 'aborted', true); return; }
    note(`${id} collision: ${errorMessage(error)}`);
    try {
      const result: LiveCollisionResult = { id, hcol: emptyCollisionCell(id, s.init.originId).slice(), ground: null, empty: true };
      post({ type: 'collision', req, result, cached: false, net: netStats() }, [result.hcol]);
    } catch (inner) { fail(req, errorMessage(inner), false); }
  }
}

function collisionArrays(result: LiveCollisionResult): ArrayBufferView[] {
  const g = result.ground;
  if (!g) return [result.hcol];
  return [result.hcol, g.positions, g.normals, ...g.classes.map(c => c.indices), ...(g.water ? [g.water.positions, g.water.indices] : [])];
}

/** One LoD2 tile converted to the runtime frame, shared by every square it spans. */
function lod2Tile(tile: SelectedTile, signal: AbortSignal): Promise<ConvertedTile> {
  const hit = lod2Tiles.get(tile.url);
  if (hit) return Promise.resolve(hit);
  return lod2Runs.run(tile.url, signal, async s => {
    const body = await net.get(tile.url, 'visual', s);
    const converted = convertTile(tile.url, body.bytes, tile.transform, session!.init.origin);
    lod2Tiles.set(tile.url, converted);
    return converted;
  });
}

async function visualJob(req: number, cx: number, cz: number, maxGeometricError: number, signal: AbortSignal): Promise<void> {
  const s = session!, id = cellId(cx, cz);
  try {
    const box = squareGeodeticBox(cx, cz, s.init.origin, VISUAL_PAD);
    const selected = await selectTiles(LIVE_SOURCES.lod2Tileset, box, maxGeometricError, url => tileset(url, 'visual', signal));
    const tiles = await Promise.all(selected.map(t => lod2Tile(t, signal)));
    signal.throwIfAborted();
    const exclude = (building: string | null, vtj: string | null): boolean =>
      (building !== null && s.staticBuildings.has(building)) || (vtj !== null && s.staticVtj.has(vtj));
    const { parts, textures, triangles } = cellParts(tiles, cx, cz, exclude, isStaticSquare);
    // Texture bytes belong to the cached tile: send copies. Part arrays are fresh.
    const copies = textures.map(t => ({ ...t, bytes: t.bytes.slice(0) }));
    const result: LiveVisualResult = { id, maxGeometricError, parts, textures: copies, triangles };
    post({ type: 'visual', req, result, net: netStats() }, [
      ...parts.flatMap(p => (p.uvs ? [p.positions, p.normals, p.uvs] : [p.positions, p.normals])),
      ...copies.map(t => t.bytes),
    ]);
  } catch (error) {
    if (signal.aborted) { fail(req, 'aborted', true); return; }
    const message = `${id} visual: ${errorMessage(error)}`;
    note(message);
    fail(req, message, false);
  }
}

function start(req: number, job: (signal: AbortSignal) => Promise<void>): void {
  if (!session) { fail(req, 'live worker not initialised', false); return; }
  const controller = new AbortController();
  jobs.set(req, controller);
  job(controller.signal).catch((error: unknown) => {
    note(`job ${req}: ${errorMessage(error)}`);
    fail(req, errorMessage(error), controller.signal.aborted);
  }).finally(() => jobs.delete(req));
}

function handle(message: LiveWorkerRequest): void {
  switch (message.type) {
    case 'init': {
      const init = message.init;
      session = {
        init, liveVersion: message.liveVersion,
        staticCells: new Set(init.staticCellIds), staticBuildings: new Set(init.staticBuildingIds), staticVtj: new Set(init.staticVtj),
        context: contextFingerprint(init),
      };
      post({ type: 'ready', net: netStats() });
      return;
    }
    case 'collision': start(message.req, signal => collisionJob(message.req, message.cx, message.cz, message.overrides, signal)); return;
    case 'visual': start(message.req, signal => visualJob(message.req, message.cx, message.cz, message.maxGeometricError, signal)); return;
    case 'abort': jobs.get(message.req)?.abort(); return;
  }
}

self.addEventListener('message', (event: MessageEvent<LiveWorkerRequest>) => {
  try { handle(event.data); } catch (error) { note(`message: ${errorMessage(error)}`); }
});
self.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  event.preventDefault();
  note(`unhandled: ${errorMessage(event.reason)}`);
});
