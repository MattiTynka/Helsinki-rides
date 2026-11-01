// Static base map for the live squares (hybrid live cells): the ground, water, street classes, building collision and
// bridge decks of every 128 m square the release lacks, prepared once from the City of Helsinki's services so the game
// streams only the LoD2 building models at runtime. Squares are derived exactly as the live worker derives them
// (apps/game/src/world/live/convert), with heights in centimetre steps, and written as gzip blocks of 8 × 8 squares plus
// `index.json` (apps/game/src/world/live/convert/base-map.ts). Resumable: finished blocks are kept.
//
// Bridges: the terrain model is bare earth, so decks come from the street and green parts register: every part of main
// type 'Silta', and every part of a street area named "…silta"/"…sillat" (stairs never; over water only, when the area
// has 'Silta' parts itself). Touching parts form one bridge, and so do parallel bridges of one street side by side up to
// 12 m apart: the register may leave out a bridge's carriageway (Maaherrantie over Lahdenväylä has only its paths and
// medians), so the gap across such a bridge between its parts is deck too. A street crossing another street's carriageway at another
// level without 'Silta' parts gets a deck too (buildCrossings). A bridge's deck is a
// plane through the approach heights at its two ends (terrain just outside the bridge, inside a non-bridge street or
// path part, preferably of the bridge's own street so a road passing underneath does not count), along the bridge's
// principal axis; one end gives a level deck. Deck quads follow the ground grid; ground within 0.5 m of a deck is cut
// away. A kept block whose decks would come out differently (its deck digest changed) is rebuilt.
//   node tools/world/build_base_map.ts --world apps/game/public/world/helsinki-20261030-navigation-v1 \
//     --out ../work/basemap-v1/basemap [--region x0,z0,x1,z1] [--max-blocks n]
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import sharp from 'sharp';
import { gk25ToGeodetic, parseTerrain, validateWorldManifest, type TerrainGrid, type WorldManifest } from '../../packages/world-schema/src/index.ts';
import { LIVE_REGION_XZ, LiveGrid } from '../../packages/sim/src/live-grid.ts';
import {
  LIVE_GROUND_N, LIVE_GROUND_QUADS, LIVE_GROUND_STEP, LIVE_SOURCES, LIVE_SURFACE_ORDER, QUAD_HOLE,
  type BaseSquare, type GeoJsonFeature, type GeoJsonFeatureCollection, type LiveDeck, type Origin, type TerrainTileAddress,
} from '../../apps/game/src/world/live/contract.ts';
import { classifyStreetPart, contains, deriveSquare, featurePolygons } from '../../apps/game/src/world/live/convert/collision-cell.ts';
import {
  BASE_BLOCK, BASE_MAP_FORMAT, blockKey, encodeBaseBlock, quantizeHeight, staticCellsText, type BaseMapBlockRef, type BaseMapIndex,
} from '../../apps/game/src/world/live/convert/base-map.ts';
import {
  decodeQuantizedMesh, edgeOverrides, sampleLattice, terrainSampler, terrainTileAddresses, terrainTileAddressesInBox, type QuantizedTile,
} from '../../apps/game/src/world/live/convert/terrain.ts';

const { values } = parseArgs({ options: {
  world: { type: 'string' }, out: { type: 'string' }, region: { type: 'string' }, 'max-blocks': { type: 'string' },
  concurrency: { type: 'string', default: '8' }, 'block-concurrency': { type: 'string', default: '3' },
} });
if (!values.world || !values.out) throw new Error('--world and --out are required');
const worldDir = values.world, outDir = values.out;
const N = LIVE_GROUND_N, Q = LIVE_GROUND_QUADS, STEP = LIVE_GROUND_STEP, SQUARE = Q * STEP, BLOCK = BASE_BLOCK * SQUARE;
/** LIVE_MARGIN: owned footprints reach this far past their square. */
const MARGIN = 32;
/**
 * Ground this close to a deck, below or above, is under its surface and cut away. Lower ground stays as the ground
 * under the bridge (a cut would leave a void under a low span); higher ground stays because the deck runs inside an
 * embankment there (a cut would leave a pit).
 */
const DECK_GROUND = 0.5;
/**
 * A cresting deck stands where the terrain model kept the bridge as ground, as a ridge across whatever passes underneath
 * (Maaherrantie's half over Lahdenväylä). Lattice points of its quads drop to the lowest point within CREST_REACH
 * lattice steps: the ground under the bridge, not a cut (which leaves a hole and
 * spikes at the deck's edges). Not within CREST_END metres of the deck's ends, where the approach road meets it.
 */
const CREST_REACH = 6, CREST_END = 6;
/** Steepest deck through approaches on the bridge's own street; other approaches beyond 12 % are an anchor mistake. */
const OWN_STREET_SLOPE = 0.2, OTHER_SLOPE = 0.12;
/** A deck with this share of its quads over a metre under the terrain model crests (bridgePlane). */
const CREST_SHARE = 0.2, CREST_MAX = 4, CREST_SLOPE = 0.08;
/** Parts of one street this far apart are one bridge, with a deck across the gap between them. */
const BRIDGE_GAP = 12;
/** Approach samples this close (along the bridge) to the outermost one at an end are that end's outermost samples. */
const END_SPAN = 4;
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const memory = () => { const m = process.memoryUsage(); return `rss ${(m.rss / 2 ** 20).toFixed(0)} MiB (heap ${(m.heapUsed / 2 ** 20).toFixed(0)}, buffers ${(m.arrayBuffers / 2 ** 20).toFixed(0)})`; };

// ---- release ----
type PayloadRef = { path: string; bytes: number; sha256: string; compression?: 'gzip'; decodedBytes?: number; decodedSha256?: string };
const manifest = JSON.parse(fs.readFileSync(path.join(worldDir, 'manifest.json'), 'utf8')) as WorldManifest;
if (validateWorldManifest(manifest).length) throw new Error(`manifest is invalid: ${validateWorldManifest(manifest).join('; ')}`);
function readPayload(ref: PayloadRef): Buffer {
  const stored = fs.readFileSync(path.join(worldDir, ...ref.path.split('/')));
  if (stored.length !== ref.bytes || sha256(stored) !== ref.sha256) throw new Error(`${ref.path} differs from its manifest reference`);
  return ref.compression ? gunzipSync(stored, { maxOutputLength: 256 * 1024 * 1024 }) : stored;
}
const terrain: TerrainGrid = parseTerrain(new Uint8Array(readPayload(manifest.terrain as PayloadRef)));
const origin = manifest.origin.originProjected as unknown as Origin, originId = manifest.origin.id;
const ids = manifest.cells.map(c => c.id);
const region = values.region ? values.region.split(',').map(Number) as [number, number, number, number] : LIVE_REGION_XZ;
if (region.length !== 4 || !region.every(Number.isFinite)) throw new Error('--region is x0,z0,x1,z1');
const grid = new LiveGrid(ids, LIVE_REGION_XZ);
const staticVtj = new Set(manifest.cells.flatMap(c => c.buildings).flatMap(b => [b.vtj, b.registerId].filter((v): v is string => !!v)));
const isStaticSquare = (cx: number, cz: number) => grid.isStatic(cx, cz);
const [E0, N0, H0] = origin;

// ---- network ----
const limit = Math.max(1, Number(values.concurrency));
let active = 0, requests = 0, downloaded = 0;
const queue: (() => void)[] = [];
async function slot<T>(job: () => Promise<T>): Promise<T> {
  if (active >= limit) await new Promise<void>(resolve => queue.push(resolve));
  active++;
  try { return await job(); } finally { active--; queue.shift()?.(); }
}
// node:https rather than fetch: fetch decodes each gzip response through a streaming zlib context whose native memory
// Node 24 on Windows does not give back (about 17 MiB per 1000 requests, 1.4 GB over a full build); one gunzipSync per
// body does not grow.
const agent = new https.Agent({ keepAlive: true, maxSockets: limit });
/** `fresh`: on a new connection; the server drops idle kept-alive ones, and a retry on another stale socket fails alike. */
function request(url: string, fresh: boolean): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent: fresh ? false : agent, timeout: 60_000, headers: { 'accept-encoding': 'gzip' } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        try {
          const raw = Buffer.concat(chunks);
          resolve({ status: res.statusCode ?? 0, body: res.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw });
        } catch (error) { reject(error as Error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}
async function get(url: string, allow404 = false): Promise<Uint8Array | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await slot(async () => {
        const response = await request(url, attempt > 0);
        requests++;
        if (allow404 && response.status === 404) return null;
        if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
        const bytes = new Uint8Array(response.body.buffer, response.body.byteOffset, response.body.length);
        downloaded += bytes.length;
        return bytes;
      });
    } catch (error) {
      if (attempt >= 4) throw new Error(`${url.slice(0, 160)}: ${(error as Error).message}`);
      await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
}
const text = new TextDecoder();
async function wfs(layer: string, bbox: [number, number, number, number] | null, cql: string | null, properties: string | null): Promise<GeoJsonFeatureCollection> {
  let url = `${LIVE_SOURCES.wfs}?service=WFS&version=2.0.0&request=GetFeature&typeNames=${encodeURIComponent(layer)}&srsName=EPSG%3A3879`
    + '&outputFormat=application%2Fjson&count=100000';
  if (properties) url += `&propertyName=${encodeURIComponent(properties)}`;
  // A bbox and a CQL filter cannot be combined in one WFS request; the CQL form carries the box itself.
  if (cql && bbox) url += `&CQL_FILTER=${encodeURIComponent(`(${cql}) AND BBOX(geom,${bbox.join(',')},'EPSG:3879')`)}`;
  else if (cql) url += `&CQL_FILTER=${encodeURIComponent(cql)}`;
  else if (bbox) url += `&bbox=${bbox.join('%2C')}%2CEPSG%3A3879`;
  const body = await get(url);
  const value = JSON.parse(text.decode(body!)) as GeoJsonFeatureCollection & { numberMatched?: number };
  if (value.type !== 'FeatureCollection' || !Array.isArray(value.features)) throw new Error(`${layer}: not a feature collection`);
  if (typeof value.numberMatched === 'number' && value.numberMatched > value.features.length) throw new Error(`${layer}: ${value.numberMatched} matched, ${value.features.length} returned`);
  return value;
}
/** EPSG:3879 [e0, n0, e1, n1] of a runtime XZ box. */
const projected = (x0: number, z0: number, x1: number, z1: number): [number, number, number, number] => [E0 + x0, N0 - z1, E0 + x1, N0 - z0];

const layer = JSON.parse(text.decode((await get(`${LIVE_SOURCES.terrainLayer}layer.json`))!)) as { version: string | number };
const terrainVersion = String(layer.version);
const tileCache = new Map<string, Promise<QuantizedTile | null>>();
function terrainTile(a: TerrainTileAddress): Promise<QuantizedTile | null> {
  const key = `${a.z}/${a.x}/${a.y}`;
  let hit = tileCache.get(key);
  if (!hit) {
    hit = get(`${LIVE_SOURCES.terrainLayer}${key}.terrain?v=${encodeURIComponent(terrainVersion)}`, true)
      .then(bytes => (bytes ? decodeQuantizedMesh(bytes[0] === 0x1f && bytes[1] === 0x8b ? new Uint8Array(gunzipSync(bytes)) : bytes) : null));
    tileCache.set(key, hit);
    // Keep about two blocks of tiles.
    if (tileCache.size > 1600) tileCache.delete(tileCache.keys().next().value!);
  }
  return hit;
}
async function tilesFor(addresses: readonly TerrainTileAddress[]) {
  const tiles = await Promise.all(addresses.map(terrainTile));
  return addresses.flatMap((address, i) => (tiles[i] ? [{ address, tile: tiles[i]! }] : []));
}

// ---- output and resume ----
fs.mkdirSync(outDir, { recursive: true });
const indexPath = path.join(outDir, 'index.json');
const staticCellsSha256 = sha256(staticCellsText(ids));
const previous = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) as BaseMapIndex : null;
const blocks: Record<string, BaseMapBlockRef> = {};
if (previous && previous.staticCellsSha256 === staticCellsSha256 && previous.originId === originId && previous.format === BASE_MAP_FORMAT) {
  for (const [key, ref] of Object.entries(previous.blocks)) {
    const file = path.join(outDir, ref.file);
    if (fs.existsSync(file) && sha256(fs.readFileSync(file)) === ref.sha256) blocks[key] = ref;
  }
}
function writeIndex(): void {
  const sorted = Object.fromEntries(Object.entries(blocks).sort(([a], [b]) => (a < b ? -1 : 1)));
  const index: BaseMapIndex = {
    format: BASE_MAP_FORMAT, originId, staticCellsSha256, blockSquares: BASE_BLOCK, blocks: sorted,
    sources: { terrain: `${LIVE_SOURCES.terrainLayer} ${terrainVersion}`, footprints: LIVE_SOURCES.footprints, streetParts: LIVE_SOURCES.streetParts,
      water: LIVE_SOURCES.water.join(','), built: new Date().toISOString().slice(0, 10) },
  };
  fs.writeFileSync(`${indexPath}.tmp`, `${JSON.stringify(index, null, 1)}\n`);
  fs.renameSync(`${indexPath}.tmp`, indexPath);
}

// ---- bridges ----
interface BridgePart { readonly id: string; readonly rings: number[][]; readonly box: [number, number, number, number]; readonly surface: number; readonly name: string }
interface Bridge {
  readonly parts: BridgePart[]; readonly box: [number, number, number, number]; plane: [number, number, number] | null; note: string;
  /** Unit XZ direction of the deck, when the parts' own outline does not give it (a crossing patch is about square). */
  readonly axis?: [number, number];
  /** Parts joined across a gap (BRIDGE_GAP): the unit XZ direction across the deck, along which the gap is filled. */
  across?: [number, number];
  readonly gaps?: boolean;
  /** A cresting deck: `plane` up to `at` along (ax, az) (x·ax + z·az), this plane past it; the deck spans `ends`. */
  crest?: { ax: number; az: number; at: number; plane: [number, number, number]; ends: [number, number] };
}

const ringBox = (r: readonly number[]): [number, number, number, number] => {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < r.length; i += 2) { x0 = Math.min(x0, r[i]!); x1 = Math.max(x1, r[i]!); z0 = Math.min(z0, r[i + 1]!); z1 = Math.max(z1, r[i + 1]!); }
  return [x0, z0, x1, z1];
};
const overlaps = (a: readonly number[], b: readonly number[], pad: number) => a[0]! - pad <= b[2]! && b[0]! - pad <= a[2]! && a[1]! - pad <= b[3]! && b[1]! - pad <= a[3]!;
function segmentDistance(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az, l = dx * dx + dz * dz;
  const t = l > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (pz - az) * dz) / l)) : 0;
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}
function ringsTouch(a: readonly number[], b: readonly number[], pad: number): boolean {
  for (const [p, r] of [[a, b], [b, a]] as const) {
    for (let i = 0; i < p.length; i += 2) {
      const x = p[i]!, z = p[i + 1]!;
      if (contains([r], x, z)) return true;
      for (let j = 0, k = r.length - 2; j < r.length; k = j, j += 2) if (segmentDistance(x, z, r[k]!, r[k + 1]!, r[j]!, r[j + 1]!) <= pad) return true;
    }
  }
  return false;
}
const surfaceIndex = (f: GeoJsonFeature): number => {
  const part = String(f.properties?.['alatyyppi'] ?? '');
  // Edge beams and the like are walkable deck edges.
  const s = LIVE_SURFACE_ORDER.indexOf(classifyStreetPart(f.properties));
  return /Reunapalkki|Muu rakenneosa/.test(part) ? Math.min(s, 1) : s;
};
const median = (v: number[]) => { const s = [...v].sort((p, q) => p - q); return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2; };
/** Bare-earth runtime height sampler over a runtime XZ box; null where the model has no land. */
async function terrainIn(x0: number, z0: number, x1: number, z1: number): Promise<(x: number, z: number) => number | null> {
  const heightAt = terrainSampler(await tilesFor(terrainTileAddressesInBox(x0, z0, x1, z1, origin)));
  return (x, z) => { const [lat, lon] = gk25ToGeodetic(E0 + x, N0 - z); const h = heightAt(lat, lon); return h === null ? null : h - H0; };
}

/** At least half of the part, on a 2 m grid, lies where the terrain model has no land or sea-level land (as anchors skip). */
async function overWater(rings: number[][], box: [number, number, number, number]): Promise<boolean> {
  const heightAt = await terrainIn(box[0], box[1], box[2], box[3]);
  let wet = 0, all = 0;
  for (let z = box[1] + 1; z < box[3]; z += 2) for (let x = box[0] + 1; x < box[2]; x += 2) {
    if (!contains(rings, x, z)) continue;
    all++;
    const h = heightAt(x, z);
    if (h === null || h + H0 < 0.3) wet++;
  }
  return all > 0 && wet * 2 >= all;
}

/** Overlap of two streets' carriageways, m², below which it is a register sliver rather than a crossing. */
const CROSSING_AREA = 40;
/** The upper street stands this far above the bare earth inside the overlap, and 2 m above the lower street. */
const CROSSING_RISE = 3;
/**
 * Streets crossing another street at another level without 'Silta' parts (Sturenkatu over Teollisuuskatu). Carriageway
 * parts of two differently named streets overlap in plan only where one passes over the other (at a junction the parts
 * tile the street). The street whose surroundings stand CROSSING_RISE above the bare earth inside the overlap is on top;
 * its deck is every 2 m quad where its parts (any kind) cover the lower street's parts, laid along the upper street.
 */
async function buildCrossings(bridgeParts: readonly BridgePart[]): Promise<Bridge[]> {
  type Part = { name: string; rings: number[][]; box: [number, number, number, number] };
  const TILE = 4096, byId = new Map<string, Part>(), fetches: Promise<void>[] = [];
  for (let z = region[1]; z < region[3]; z += TILE) for (let x = region[0]; x < region[2]; x += TILE) {
    fetches.push(wfs(LIVE_SOURCES.streetParts, projected(x, z, Math.min(x + TILE, region[2]), Math.min(z + TILE, region[3])),
      "paatyyppi='Ajorata' AND alatyyppi IN ('Ajorata','Ajorata, muu')", 'tietopalvelu_id,alueen_nimi,geom').then(fc => {
      for (const f of fc.features) {
        const name = String(f.properties?.['alueen_nimi'] ?? '');
        if (!name) continue;
        featurePolygons(f, origin).forEach((rings, k) => byId.set(`${f.properties?.['tietopalvelu_id'] ?? f.id}:${k}`, { name, rings, box: ringBox(rings[0]!) }));
      }
    }));
  }
  await Promise.all(fetches);
  const list = [...byId.values()], HASH = 32, hash = new Map<string, number[]>();
  list.forEach((p, i) => {
    for (let hz = Math.floor(p.box[1] / HASH); hz <= Math.floor(p.box[3] / HASH); hz++) for (let hx = Math.floor(p.box[0] / HASH); hx <= Math.floor(p.box[2] / HASH); hx++) {
      const k = `${hx},${hz}`;
      (hash.get(k) ?? hash.set(k, []).get(k)!).push(i);
    }
  });
  // Quad centres (odd coordinates, as the deck raster samples them) covered by two street names, per name pair.
  const overlap = new Map<string, Set<string>>();
  for (let i = 0; i < list.length; i++) {
    const p = list[i]!;
    for (let z = Math.floor(p.box[1] / 2) * 2 + 1; z < p.box[3]; z += 2) for (let x = Math.floor(p.box[0] / 2) * 2 + 1; x < p.box[2]; x += 2) {
      if (!contains(p.rings, x, z)) continue;
      for (const j of hash.get(`${Math.floor(x / HASH)},${Math.floor(z / HASH)}`) ?? []) {
        const o = list[j]!;
        if (j <= i || o.name === p.name || x < o.box[0] || x > o.box[2] || z < o.box[1] || z > o.box[3] || !contains(o.rings, x, z)) continue;
        const key = p.name < o.name ? `${p.name}\0${o.name}` : `${o.name}\0${p.name}`;
        (overlap.get(key) ?? overlap.set(key, new Set()).get(key)!).add(`${x},${z}`);
      }
    }
  }
  const inBridgeParts = (x: number, z: number) => bridgeParts.some(p => x >= p.box[0] && x <= p.box[2] && z >= p.box[1] && z <= p.box[3] && contains(p.rings, x, z));
  const out: Bridge[] = [];
  for (const [key, cells] of overlap) {
    // Patches of the overlap: cells within 10 m join, so both carriageways and the ramps of one crossing share a deck plane.
    const left = new Set(cells);
    for (const seed of cells) {
      if (!left.delete(seed)) continue;
      const patch = [seed];
      for (let k = 0; k < patch.length; k++) {
        const [x, z] = patch[k]!.split(',').map(Number) as [number, number];
        for (let dz = -10; dz <= 10; dz += 2) for (let dx = -10; dx <= 10; dx += 2) { const n = `${x + dx},${z + dz}`; if (left.delete(n)) patch.push(n); }
      }
      if (patch.length * 4 < CROSSING_AREA) continue;
      const pts = patch.map(c => c.split(',').map(Number) as [number, number]);
      if (pts.filter(([x, z]) => inBridgeParts(x, z)).length * 2 > pts.length) continue;
      const box: [number, number, number, number] = [Math.min(...pts.map(p => p[0])) - 1, Math.min(...pts.map(p => p[1])) - 1, Math.max(...pts.map(p => p[0])) + 1, Math.max(...pts.map(p => p[1])) + 1];
      let live = false;
      for (let cz = Math.floor(box[1] / SQUARE); cz <= Math.floor(box[3] / SQUARE) && !live; cz++) for (let cx = Math.floor(box[0] / SQUARE); cx <= Math.floor(box[2] / SQUARE) && !live; cx++) live = grid.isLive(cx, cz);
      if (!live) continue;
      try {
        const b = await crossingDeck(key.split('\0') as [string, string], pts, box, inBridgeParts);
        if (b) out.push(b);
      } catch (error) { log(`crossing ${key.replace('\0', ' / ')} failed: ${(error as Error).message}`); }
    }
  }
  return out;
}

/** The deck of one overlap patch, or null when neither street stands clearly above the other there. */
async function crossingDeck(names: [string, string], pts: [number, number][], box: [number, number, number, number], inBridgeParts: (x: number, z: number) => boolean): Promise<Bridge | null> {
  const pad = 30, [x0, z0, x1, z1] = [box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad];
  const around = await wfs(LIVE_SOURCES.streetParts, projected(x0, z0, x1, z1), null, 'paatyyppi,alatyyppi,alueen_nimi,geom');
  const parts = around.features.flatMap(f => featurePolygons(f, origin).map(rings => ({ rings, box: ringBox(rings[0]!), name: String(f.properties?.['alueen_nimi'] ?? ''), surface: surfaceIndex(f) })));
  const at = (name: string, x: number, z: number) => parts.filter(p => p.name === name && x >= p.box[0] && x <= p.box[2] && z >= p.box[1] && z <= p.box[3] && contains(p.rings, x, z));
  const heightAt = await terrainIn(x0, z0, x1, z1);
  const heights = (v: [number, number][]) => v.map(([x, z]) => heightAt(x, z)).filter((h): h is number => h !== null);
  const h0 = heights(pts);
  // Each street's ground near the crossing, away from the other street.
  const near: [number, number][][] = [[], []];
  for (let z = Math.floor(z0 / 2) * 2 + 1; z < z1; z += 2) for (let x = Math.floor(x0 / 2) * 2 + 1; x < x1; x += 2) {
    const a = at(names[0], x, z).length > 0, b = at(names[1], x, z).length > 0;
    if (a && !b) near[0]!.push([x, z]);
    if (b && !a) near[1]!.push([x, z]);
  }
  const hA = heights(near[0]!), hB = heights(near[1]!);
  if (!h0.length || !hA.length || !hB.length) return null;
  const under = median(h0), levels = [median(hA), median(hB)];
  const top = levels[0]! >= levels[1]! ? 0 : 1, upper = names[top]!, lower = names[1 - top]!;
  if (levels[top]! - under < CROSSING_RISE || levels[top]! - levels[1 - top]! < 2) return null;
  // Along the upper street: principal axis of its ground at street level around the crossing (a lane of the same name
  // down at the lower level, such as a ramp, is not the street the deck carries).
  const level = levels[top]!, nearHeights = near[top]!.map(([x, z]) => heightAt(x, z));
  const street = near[top]!.filter((_, i) => nearHeights[i] !== null && Math.abs(nearHeights[i]! - level) <= 1.5);
  const own = [...street, ...pts];
  const mx = own.reduce((s, p) => s + p[0], 0) / own.length, mz = own.reduce((s, p) => s + p[1], 0) / own.length;
  let sxx = 0, sxz = 0, szz = 0;
  for (const [x, z] of own) { sxx += (x - mx) ** 2; sxz += (x - mx) * (z - mz); szz += (z - mz) ** 2; }
  const angle = 0.5 * Math.atan2(2 * sxz, sxx - szz), ax = Math.cos(angle), az = Math.sin(angle);
  const along = (x: number, z: number) => (x - mx) * ax + (z - mz) * az, across = (x: number, z: number) => -(x - mx) * az + (z - mz) * ax;
  // The deck stays in the overlap's band across the street, and reaches at most 25 m past it along the street (the cut
  // can be wider than the lower street).
  const t = pts.map(([x, z]) => along(x, z)), s = pts.map(([x, z]) => across(x, z));
  const tMin = Math.min(...t) - 25, tMax = Math.max(...t) + 25, sMin = Math.min(...s) - 2, sMax = Math.max(...s) + 2;
  const inBand = (x: number, z: number) => { const a = along(x, z), c = across(x, z); return a >= tMin && a <= tMax && c >= sMin && c <= sMax; };
  // Deck quads, outside real bridge parts: the upper street's parts over the lower street's parts, grown through the
  // upper street where its ground lies 2.5 m under the street (cut sides and abutments the bare-earth model smooths
  // away, which would leave a pit past the deck's end). Row runs per surface.
  const cells = new Map<string, number>(), queue: [number, number][] = [];
  const surfaceAt = (x: number, z: number) => { const on = at(upper, x, z); return on.length ? Math.min(...on.map(p => p.surface)) : -1; };
  for (let z = Math.floor(z0 / 2) * 2 + 1; z < z1; z += 2) for (let x = Math.floor(x0 / 2) * 2 + 1; x < x1; x += 2) {
    if (!inBand(x, z) || inBridgeParts(x, z) || !at(lower, x, z).length) continue;
    const sf = surfaceAt(x, z);
    if (sf >= 0) { cells.set(`${x},${z}`, sf); queue.push([x, z]); }
  }
  for (let k = 0; k < queue.length; k++) {
    const [x, z] = queue[k]!;
    for (let dz = -2; dz <= 2; dz += 2) for (let dx = -2; dx <= 2; dx += 2) {
      const nx = x + dx, nz = z + dz, key = `${nx},${nz}`;
      if (cells.has(key) || !inBand(nx, nz) || inBridgeParts(nx, nz)) continue;
      const h = heightAt(nx, nz), sf = h !== null && h < level - 2.5 ? surfaceAt(nx, nz) : -1;
      if (sf >= 0) { cells.set(key, sf); queue.push([nx, nz]); }
    }
  }
  const rows = new Map<string, number[]>();
  for (const [key, sf] of cells) {
    const [x, z] = key.split(',').map(Number) as [number, number];
    (rows.get(`${z},${sf}`) ?? rows.set(`${z},${sf}`, []).get(`${z},${sf}`)!).push(x);
  }
  const deck: BridgePart[] = [];
  for (const [key, xs] of rows) {
    xs.sort((a, b) => a - b);
    const [z, surface] = key.split(',').map(Number) as [number, number];
    for (let i = 0; i < xs.length;) {
      let e = i;
      while (e + 1 < xs.length && xs[e + 1] === xs[e]! + 2) e++;
      const ring = [xs[i]! - 1, z - 1, xs[e]! + 1, z - 1, xs[e]! + 1, z + 1, xs[i]! - 1, z + 1];
      deck.push({ id: `crossing:${upper}:${deck.length}`, rings: [ring], box: ringBox(ring), surface, name: upper });
      i = e + 1;
    }
  }
  if (!deck.length) return null;
  const dbox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of deck) { dbox[0] = Math.min(dbox[0], p.box[0]); dbox[1] = Math.min(dbox[1], p.box[1]); dbox[2] = Math.max(dbox[2], p.box[2]); dbox[3] = Math.max(dbox[3], p.box[3]); }
  // The deck plane: the street-level ground in the band, fitted along the street (least squares); level when steeper
  // than a street gets.
  const fit = street.filter(([x, z]) => { const c = across(x, z); return c >= sMin && c <= sMax; }).map(([x, z]) => ({ t: along(x, z), h: heightAt(x, z)! }));
  let slope = 0, h = level;
  if (fit.length >= 2) {
    const mt = fit.reduce((a, p) => a + p.t, 0) / fit.length, mh = fit.reduce((a, p) => a + p.h, 0) / fit.length;
    const stt = fit.reduce((a, p) => a + (p.t - mt) ** 2, 0), sth = fit.reduce((a, p) => a + (p.t - mt) * (p.h - mh), 0);
    slope = stt > 0 ? sth / stt : 0;
    h = mh - slope * mt;
    if (Math.abs(slope) > OWN_STREET_SLOPE) { slope = 0; h = level; }
  }
  // h(t) = h + slope · t, t = (x − mx) ax + (z − mz) az.
  const plane: [number, number, number] = [h - slope * (mx * ax + mz * az), slope * ax, slope * az];
  const note = `${upper} over ${lower}: street ${level.toFixed(1)} / ${levels[1 - top]!.toFixed(1)} over ${under.toFixed(1)}, ${fit.length} street samples, slope ${slope.toFixed(3)}, ${deck.length} runs`;
  log(`crossing: ${note} at ${dbox.map(v => v.toFixed(0)).join(',')}`);
  return { parts: deck, box: dbox, plane, note, axis: [ax, az] };
}

async function buildBridges(): Promise<Bridge[]> {
  const rb = projected(region[0], region[1], region[2], region[3]);
  const props = 'tietopalvelu_id,paatyyppi,alatyyppi,alueen_nimi,geom';
  const [silta, named] = await Promise.all([
    wfs(LIVE_SOURCES.streetParts, rb, "paatyyppi='Silta'", props),
    wfs(LIVE_SOURCES.streetParts, rb, "paatyyppi<>'Silta' AND (strToLowerCase(alueen_nimi) LIKE '%silta' OR strToLowerCase(alueen_nimi) LIKE '%sillat')", props),
  ]);
  const parts: BridgePart[] = [];
  // An area that has 'Silta' parts is named after its bridge but reaches past it (Kellosilta's walks and planting beds
  // run 300 m along the ground); there a name-only part counts only over water. Stairs lead off a deck, never onto it.
  const withSilta = new Set(silta.features.map(f => String(f.properties?.['alueen_nimi'] ?? '')).filter(Boolean));
  for (const f of [...silta.features, ...named.features]) {
    const surface = surfaceIndex(f), name = String(f.properties?.['alueen_nimi'] ?? ''), byName = f.properties?.['paatyyppi'] !== 'Silta';
    if (byName && /portaat/i.test(String(f.properties?.['alatyyppi'] ?? ''))) continue;
    for (const rings of featurePolygons(f, origin)) {
      const box = ringBox(rings[0]!);
      if (byName && withSilta.has(name) && !(await overWater(rings, box))) continue;
      parts.push({ id: String(f.properties?.['tietopalvelu_id'] ?? f.id), rings, box, surface, name });
    }
  }
  // Union-find over touching parts.
  const parent = parts.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!; return i; };
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
    if (find(i) === find(j) || !overlaps(parts[i]!.box, parts[j]!.box, 0.5)) continue;
    if (ringsTouch(parts[i]!.rings[0]!, parts[j]!.rings[0]!, 0.5)) parent[find(j)] = find(i);
  }
  // Then bridges of one street side by side across a gap: parallel, and alongside each other for most of their length
  // (ramps of an interchange diverge, and may stand at another level).
  const touching = parts.map((_, i) => find(i)), axes = new Map<number, { x: number; z: number; ax: number; az: number; points: number[] }>();
  const axisOf = (r: number) => {
    if (!axes.has(r)) {
      const points = parts.flatMap((p, i) => touching[i] === r ? p.rings[0]! : []);
      let mx = 0, mz = 0, sxx = 0, sxz = 0, szz = 0;
      for (let i = 0; i < points.length; i += 2) { mx += points[i]!; mz += points[i + 1]!; }
      mx /= points.length / 2; mz /= points.length / 2;
      for (let i = 0; i < points.length; i += 2) { const dx = points[i]! - mx, dz = points[i + 1]! - mz; sxx += dx * dx; sxz += dx * dz; szz += dz * dz; }
      const angle = 0.5 * Math.atan2(2 * sxz, sxx - szz);
      axes.set(r, { x: mx, z: mz, ax: Math.cos(angle), az: Math.sin(angle), points });
    }
    return axes.get(r)!;
  };
  const sideBySide = (r: number, s: number) => {
    const a = axisOf(r), c = axisOf(s);
    if (Math.abs(a.ax * c.ax + a.az * c.az) < Math.cos(Math.PI / 12)) return false;
    const span = (points: number[]) => {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < points.length; i += 2) { const t = (points[i]! - a.x) * a.ax + (points[i + 1]! - a.z) * a.az; lo = Math.min(lo, t); hi = Math.max(hi, t); }
      return [lo, hi] as const;
    };
    const [a0, a1] = span(a.points), [c0, c1] = span(c.points);
    return Math.min(a1, c1) - Math.max(a0, c0) >= 0.5 * Math.min(a1 - a0, c1 - c0);
  };
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
    const a = parts[i]!, c = parts[j]!;
    if (!a.name || a.name !== c.name || find(i) === find(j) || !overlaps(a.box, c.box, BRIDGE_GAP)) continue;
    if (ringsTouch(a.rings[0]!, c.rings[0]!, BRIDGE_GAP) && sideBySide(touching[i]!, touching[j]!)) parent[find(j)] = find(i);
  }
  const groups = new Map<number, BridgePart[]>(), joined = new Map<number, Set<number>>();
  parts.forEach((p, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), p]);
    joined.set(r, (joined.get(r) ?? new Set()).add(touching[i]!));
  });
  const bridges: Bridge[] = [];
  for (const [r, g] of groups) {
    const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of g) { box[0] = Math.min(box[0], p.box[0]); box[1] = Math.min(box[1], p.box[1]); box[2] = Math.max(box[2], p.box[2]); box[3] = Math.max(box[3], p.box[3]); }
    // Only bridges reaching a live square.
    let live = false;
    for (let cz = Math.floor(box[1] / SQUARE); cz <= Math.floor(box[3] / SQUARE) && !live; cz++) {
      for (let cx = Math.floor(box[0] / SQUARE); cx <= Math.floor(box[2] / SQUARE) && !live; cx++) live = grid.isLive(cx, cz);
    }
    if (live) bridges.push({ parts: g, box, plane: null, note: '', gaps: joined.get(r)!.size > 1 });
  }
  log(`bridges: ${parts.length} parts in ${groups.size} groups, ${bridges.length} reach live squares`);
  const crossings = await buildCrossings(parts);
  log(`crossings: ${crossings.length} streets over another street without bridge parts`);
  bridges.push(...crossings);
  let done = 0;
  await Promise.all(bridges.map(async b => {
    // A crossing's deck comes with its plane.
    try { if (!b.plane) await bridgePlane(b); } catch (error) { b.note = `failed: ${(error as Error).message}`; }
    if (++done % 50 === 0) log(`bridge planes ${done}/${bridges.length}`);
  }));
  return bridges;
}

/** The deck plane through the approach heights at the bridge's two ends. */
async function bridgePlane(b: Bridge): Promise<void> {
  const pad = 8, [x0, z0, x1, z1] = b.box;
  const own = new Set(b.parts.map(p => p.id));
  const around = await wfs(LIVE_SOURCES.streetParts, projected(x0 - pad, z0 - pad, x1 + pad, z1 + pad), null, 'tietopalvelu_id,paatyyppi,alatyyppi,alueen_nimi,geom');
  const approaches: { rings: number[][]; box: [number, number, number, number]; name: string }[] = [];
  for (const f of around.features) {
    if (own.has(String(f.properties?.['tietopalvelu_id'] ?? f.id)) || f.properties?.['paatyyppi'] === 'Silta') continue;
    // Stairs lead down off the deck: their ground is between the two levels.
    const s = surfaceIndex(f);
    if (s > 1 || /portaat/i.test(String(f.properties?.['alatyyppi'] ?? ''))) continue;
    for (const rings of featurePolygons(f, origin)) approaches.push({ rings, box: ringBox(rings[0]!), name: String(f.properties?.['alueen_nimi'] ?? '') });
  }
  const names = new Set(b.parts.map(p => p.name).filter(Boolean));
  const streetsAt = (x: number, z: number) => approaches.filter(a => x >= a.box[0] && x <= a.box[2] && z >= a.box[1] && z <= a.box[3] && contains(a.rings, x, z));
  const heightAt = terrainSampler(await tilesFor(terrainTileAddressesInBox(x0 - pad, z0 - pad, x1 + pad, z1 + pad, origin)));
  const inBridge = (x: number, z: number) => b.parts.some(p => x >= p.box[0] - 0.01 && x <= p.box[2] + 0.01 && z >= p.box[1] - 0.01 && z <= p.box[3] + 0.01 && contains(p.rings, x, z));
  // Principal axis of the outline points.
  let mx = 0, mz = 0, n = 0;
  for (const p of b.parts) for (let i = 0; i < p.rings[0]!.length; i += 2) { mx += p.rings[0]![i]!; mz += p.rings[0]![i + 1]!; n++; }
  mx /= n; mz /= n;
  let sxx = 0, sxz = 0, szz = 0;
  for (const p of b.parts) for (let i = 0; i < p.rings[0]!.length; i += 2) {
    const dx = p.rings[0]![i]! - mx, dz = p.rings[0]![i + 1]! - mz;
    sxx += dx * dx; sxz += dx * dz; szz += dz * dz;
  }
  const angle = 0.5 * Math.atan2(2 * sxz, sxx - szz), [ax, az] = b.axis ?? [Math.cos(angle), Math.sin(angle)];
  if (b.gaps) b.across = [-az, ax];
  const along = (x: number, z: number) => (x - mx) * ax + (z - mz) * az;
  let tMin = Infinity, tMax = -Infinity;
  for (const p of b.parts) for (let i = 0; i < p.rings[0]!.length; i += 2) {
    const t = along(p.rings[0]![i]!, p.rings[0]![i + 1]!);
    tMin = Math.min(tMin, t); tMax = Math.max(tMax, t);
  }
  const zone = Math.max(10, 0.15 * (tMax - tMin));
  type Anchor = { t: number; h: number; street: boolean; ownStreet: boolean };
  const anchors: Anchor[] = [];
  for (const p of b.parts) for (const r of p.rings) {
    for (let i = 0, k = r.length - 2; i < r.length; k = i, i += 2) {
      const ax0 = r[k]!, az0 = r[k + 1]!, ax1 = r[i]!, az1 = r[i + 1]!, len = Math.hypot(ax1 - ax0, az1 - az0);
      if (len === 0) continue;
      const nx = -(az1 - az0) / len, nz = (ax1 - ax0) / len;
      for (let s = 0.5; s < len; s += 1) {
        const px = ax0 + ((ax1 - ax0) * s) / len, pz = az0 + ((az1 - az0) * s) / len;
        for (const side of [1, -1]) {
          const ox = px + side * nx * 0.75, oz = pz + side * nz * 0.75;
          const t = along(ox, oz);
          if ((t > tMin + zone && t < tMax - zone) || inBridge(ox, oz)) continue;
          const [lat, lon] = gk25ToGeodetic(E0 + ox, N0 - oz);
          const h = heightAt(lat, lon);
          if (h === null || h < 0.3) continue;
          const streets = streetsAt(ox, oz);
          anchors.push({ t, h: h - H0, street: streets.length > 0, ownStreet: streets.some(a => names.has(a.name)) });
        }
      }
    }
  }
  const atLow = (v: Anchor[]) => v.filter(a => a.t <= tMin + zone), atHigh = (v: Anchor[]) => v.filter(a => a.t >= tMax - zone);
  // The bridge's own street at both ends beats other streets: those may pass underneath, or cross at another level.
  const streets = anchors.filter(a => a.street), ownStreets = streets.filter(a => a.ownStreet);
  const ownEnds = atLow(ownStreets).length > 0 && atHigh(ownStreets).length > 0;
  const use = ownEnds ? ownStreets : streets.length ? streets : anchors;
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  // The approach is past the deck's end, but along a long end zone the samples beside the deck sit on the embankment
  // down to whatever the bridge crosses (Maaherrantie over Lahdenväylä read 2 m low at one end). The end's height is
  // the higher of the whole zone's and its outermost samples': where the outermost ones are the lower, they are on a
  // shore or a slope past the end (Lauttasaarensilta), and a deck under the ground is the worse mistake.
  const end = (v: Anchor[], sign: number) => {
    const out = Math.max(...v.map(a => sign * a.t)), far = v.filter(a => sign * a.t >= out - END_SPAN);
    return far.length >= 3 && median(far.map(a => a.h)) > median(v.map(a => a.h)) ? far : v;
  };
  const low = end(atLow(use), -1), high = end(atHigh(use), 1);
  b.note = `${b.parts[0]!.name}: ${ownEnds ? 'own street' : streets.length ? 'street' : 'terrain'} anchors ${low.length}/${high.length}, length ${(tMax - tMin).toFixed(0)} m`;
  if (!low.length && !high.length) { b.note += ', no anchors'; return; }
  if (!low.length || !high.length || tMax - tMin < 1) {
    b.plane = [median((low.length ? low : high).map(a => a.h)), 0, 0];
    return;
  }
  const hA = median(low.map(a => a.h)), hB = median(high.map(a => a.h)), tA = mean(low.map(a => a.t)), tB = mean(high.map(a => a.t));
  // A steeper deck is an anchor mistake: keep it level at the higher end. Its own street at both ends may be steeper
  // (Hämeentie over the Vallilanlaakso path drops 5.6 m in 41 m); levelling that leaves a cliff at the lower end.
  const slope = tB - tA > 1 ? (hB - hA) / (tB - tA) : 0;
  if (Math.abs(slope) > (ownEnds ? OWN_STREET_SLOPE : OTHER_SLOPE)) { b.note += `, slope ${slope.toFixed(2)} levelled`; b.plane = [Math.max(hA, hB), 0, 0]; return; }
  if (Math.abs(slope) > OTHER_SLOPE) b.note += `, slope ${slope.toFixed(2)}`;
  // h = h0 + s · (t − t0), t = (x − mx) ax + (z − mz) az.
  const through = (t0: number, h0: number, s: number): [number, number, number] => [h0 - s * (t0 + mx * ax + mz * az), s * ax, s * az];
  b.plane = through(tA, hA, slope);
  // The terrain model keeps some decks (or the half of one whose carriageway the register leaves out) as ground: where
  // a fifth of the deck lies over a metre under it, the deck crests between its ends (as a bridge does, which a plane
  // through the ends misses) by those quads' median depth, at most CREST_MAX and CREST_SLOPE more steeply than before.
  const depths: number[] = [];
  let samples = 0;
  for (const p of b.parts) for (let z = Math.floor(p.box[1] / 2) * 2 + 1; z < p.box[3]; z += 2) for (let x = Math.floor(p.box[0] / 2) * 2 + 1; x < p.box[2]; x += 2) {
    if (!inPart(p, x, z)) continue;
    const [lat, lon] = gk25ToGeodetic(E0 + x, N0 - z);
    const h = heightAt(lat, lon);
    if (h === null || h < 0.3) continue;
    samples++;
    const depth = h - H0 - (b.plane[0] + b.plane[1] * x + b.plane[2] * z);
    if (depth > 1) depths.push(depth);
  }
  if (!samples || depths.length < CREST_SHARE * samples || tB - tA < 4) return;
  const tm = (tA + tB) / 2, rise = Math.min(median(depths), CREST_MAX, CREST_SLOPE * (tm - tA)), hm = hA + slope * (tm - tA) + rise;
  b.note += `, crest ${rise.toFixed(1)} m (${(100 * depths.length / samples).toFixed(0)} % under)`;
  b.plane = through(tA, hA, (hm - hA) / (tm - tA));
  const t0 = mx * ax + mz * az;
  b.crest = { ax, az, at: tm + t0, plane: through(tm, hm, (hB - hm) / (tB - tm)), ends: [tMin + t0, tMax + t0] };
}

const inPart = (p: BridgePart, x: number, z: number) => x >= p.box[0] && x <= p.box[2] && z >= p.box[1] && z <= p.box[3] && contains(p.rings, x, z);
/** Whether parts of the bridge lie on both sides of XZ across the deck, at most BRIDGE_GAP apart. */
function gapBetween(b: Bridge, x: number, z: number): boolean {
  const [cx, cz] = b.across!, hit = (d: number) => b.parts.some(p => inPart(p, x + cx * d, z + cz * d));
  let plus = Infinity, minus = Infinity;
  for (let d = 0.5; d <= BRIDGE_GAP && plus === Infinity; d += 0.5) if (hit(d)) plus = d;
  for (let d = 0.5; d <= BRIDGE_GAP - Math.min(plus, BRIDGE_GAP) + 0.5 && minus === Infinity; d += 0.5) if (hit(-d)) minus = d;
  return plus + minus <= BRIDGE_GAP + 1;
}

/** Deck quads of every live square a bridge covers. */
function rasterizeDecks(bridges: readonly Bridge[]): Map<string, { planes: number[]; quads: Uint8Array; surfaces: Uint8Array; crest: (Bridge['crest'] | null)[] }> {
  const decks = new Map<string, { planes: number[]; quads: Uint8Array; surfaces: Uint8Array; crest: (Bridge['crest'] | null)[] }>();
  for (const b of bridges) {
    if (!b.plane) continue;
    for (let cz = Math.floor(b.box[1] / SQUARE); cz <= Math.floor(b.box[3] / SQUARE); cz++) {
      for (let cx = Math.floor(b.box[0] / SQUARE); cx <= Math.floor(b.box[2] / SQUARE); cx++) {
        if (!grid.isLive(cx, cz)) continue;
        const key = `${cx},${cz}`;
        let deck = decks.get(key), planeIndex = -1, crestIndex = -1;
        for (let iz = 0; iz < Q; iz++) for (let ix = 0; ix < Q; ix++) {
          const x = cx * SQUARE + ix * STEP + STEP / 2, z = cz * SQUARE + iz * STEP + STEP / 2;
          if (x < b.box[0] || x > b.box[2] || z < b.box[1] || z > b.box[3]) continue;
          let surface = -1;
          for (const p of b.parts) {
            if (!inPart(p, x, z)) continue;
            if (surface < 0 || p.surface < surface) surface = p.surface;
          }
          // Between parts across the deck (a carriageway the register leaves out): road.
          if (surface < 0 && b.across && gapBetween(b, x, z)) surface = 0;
          if (surface < 0) continue;
          deck ??= { planes: [], quads: new Uint8Array(Q * Q), surfaces: new Uint8Array(Q * Q), crest: [] };
          decks.set(key, deck);
          const q = iz * Q + ix;
          if (deck.quads[q]) continue;
          if (b.crest && x * b.crest.ax + z * b.crest.az >= b.crest.at) {
            if (crestIndex < 0) { crestIndex = deck.planes.length / 3; deck.planes.push(...b.crest.plane); deck.crest.push(b.crest); }
            if (crestIndex >= 254) continue;
            deck.quads[q] = crestIndex + 1;
          } else {
            if (planeIndex < 0) { planeIndex = deck.planes.length / 3; deck.planes.push(...b.plane); deck.crest.push(b.crest ?? null); }
            if (planeIndex >= 254) continue;
            deck.quads[q] = planeIndex + 1;
          }
          deck.surfaces[q] = surface;
        }
      }
    }
  }
  return decks;
}

// ---- blocks ----
async function waterMasks(bx: number, bz: number): Promise<Uint8Array> {
  const R = BASE_BLOCK * Q;
  const [e0, n0, e1, n1] = projected(bx * BLOCK, bz * BLOCK, (bx + 1) * BLOCK, (bz + 1) * BLOCK);
  const url = `${LIVE_SOURCES.wms}?service=WMS&version=1.3.0&request=GetMap&layers=${encodeURIComponent(LIVE_SOURCES.water.join(','))}`
    + `&styles=&crs=EPSG%3A3879&bbox=${n0}%2C${e0}%2C${n1}%2C${e1}&width=${R}&height=${R}&format=image%2Fpng&transparent=true&format_options=antialiasing%3Aoff`;
  const png = await get(url);
  const { data, info } = await sharp(png!).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== R || info.height !== R || info.channels !== 4) throw new Error(`water mask ${info.width} × ${info.height} × ${info.channels}`);
  const mask = new Uint8Array(R * R);
  for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3]! >= 128 ? 1 : 0;
  return mask;
}

async function buildBlock(bx: number, bz: number, decks: ReturnType<typeof rasterizeDecks>): Promise<BaseSquare[]> {
  const squares: [number, number][] = [];
  for (let cz = bz * BASE_BLOCK; cz < (bz + 1) * BASE_BLOCK; cz++) for (let cx = bx * BASE_BLOCK; cx < (bx + 1) * BASE_BLOCK; cx++) if (grid.isLive(cx, cz)) squares.push([cx, cz]);
  const R = BASE_BLOCK * Q, blockMask = await waterMasks(bx, bz);
  const maskOf = (cx: number, cz: number) => {
    const m = new Uint8Array(Q * Q), ox = (cx - bx * BASE_BLOCK) * Q, oz = (cz - bz * BASE_BLOCK) * Q;
    for (let iz = 0; iz < Q; iz++) for (let ix = 0; ix < Q; ix++) m[iz * Q + ix] = blockMask[(oz + iz) * R + ox + ix]!;
    return m;
  };
  const land = squares.filter(([cx, cz]) => decks.has(`${cx},${cz}`) || maskOf(cx, cz).some(v => v === 0));
  const out: BaseSquare[] = squares.filter(s => !land.includes(s)).map(([cx, cz]) => ({ cx, cz, kind: 'water' as const, heights: null, quads: null, prisms: [], deck: null }));
  if (land.length) {
    const box = projected(bx * BLOCK, bz * BLOCK, (bx + 1) * BLOCK, (bz + 1) * BLOCK);
    const marginBox = projected(bx * BLOCK - MARGIN, bz * BLOCK - MARGIN, (bx + 1) * BLOCK + MARGIN, (bz + 1) * BLOCK + MARGIN);
    const [footprints, streetParts] = await Promise.all([
      wfs(LIVE_SOURCES.footprints, marginBox, null, 'id,vtj_prt,c_vtj_prt,i_kerrlkm,geom'),
      wfs(LIVE_SOURCES.streetParts, box, null, 'paatyyppi,alatyyppi,geom'),
    ]);
    for (const [cx, cz] of land) {
      const mask = maskOf(cx, cz), deck = decks.get(`${cx},${cz}`) ?? null;
      const dry = mask.some(v => v === 0);
      const raw = dry ? sampleLattice(cx, cz, origin, await tilesFor(terrainTileAddresses(cx, cz, origin)), edgeOverrides(grid, terrain, cx, cz)) : new Float32Array(N * N).fill(NaN);
      const heights = raw.map(quantizeHeight);
      const derived = deriveSquare({
        id: `${cx},${cz}`, cx, cz, originId, origin, heights, waterMask: mask, footprints, streetParts, staticVtj, isStaticSquare,
      });
      const quads = derived.quads;
      let liveDeck: LiveDeck | null = null;
      if (deck) {
        liveDeck = { planes: Float64Array.from(deck.planes), quads: deck.quads, surfaces: deck.surfaces };
        const bare = heights.slice();
        for (let iz = 0; iz < Q; iz++) for (let ix = 0; ix < Q; ix++) {
          const q = iz * Q + ix, p = deck.quads[q]! - 1;
          if (p < 0 || quads[q]! < 0) continue;
          const i = iz * N + ix, ground = Math.max(heights[i]!, heights[i + 1]!, heights[i + N]!, heights[i + N + 1]!);
          const x = cx * SQUARE + ix * STEP + STEP / 2, z = cz * SQUARE + iz * STEP + STEP / 2;
          const top = deck.planes[p * 3]! + deck.planes[p * 3 + 1]! * x + deck.planes[p * 3 + 2]! * z;
          const crest = deck.crest[p];
          if (crest) {
            for (const c of [i, i + 1, i + N, i + N + 1]) {
              const cxi = c % N, czi = Math.floor(c / N), t = (cx * SQUARE + cxi * STEP) * crest.ax + (cz * SQUARE + czi * STEP) * crest.az;
              const edgeX = cxi === 0 || cxi === N - 1, edgeZ = czi === 0 || czi === N - 1;
              // A corner is four squares' and stays; a point on an edge is the neighbour's too, so it looks along that
              // edge only, which the neighbour sees alike.
              if (edgeX && edgeZ) continue;
              if (t < crest.ends[0] + CREST_END || t > crest.ends[1] - CREST_END) continue;
              let low = bare[c]!;
              for (let dz = edgeZ ? 0 : -CREST_REACH; dz <= (edgeZ ? 0 : CREST_REACH); dz++) for (let dx = edgeX ? 0 : -CREST_REACH; dx <= (edgeX ? 0 : CREST_REACH); dx++) {
                const nx = cxi + dx, nz = czi + dz;
                if (nx >= 0 && nx < N && nz >= 0 && nz < N && Number.isFinite(bare[nz * N + nx]!)) low = Math.min(low, bare[nz * N + nx]!);
              }
              // On the deck's border, no lower than the ground just outside it: a road passing underneath pulls the point
              // down, level ground beside the deck keeps it (a trench otherwise).
              if (!edgeX && !edgeZ) {
                let outside = Infinity;
                for (const [qx, qz] of [[cxi - 1, czi - 1], [cxi, czi - 1], [cxi - 1, czi], [cxi, czi]] as const) {
                  if (deck.quads[qz * Q + qx]) continue;
                  for (const o of [qz * N + qx, qz * N + qx + 1, (qz + 1) * N + qx, (qz + 1) * N + qx + 1]) if (o !== c && Number.isFinite(bare[o]!)) outside = Math.min(outside, bare[o]!);
                }
                if (outside < Infinity) low = Math.max(low, Math.min(bare[c]!, outside));
              }
              heights[c] = Math.min(heights[c]!, low);
            }
          } else if (Math.abs(top - ground) <= DECK_GROUND) quads[q] = QUAD_HOLE;
        }
      }
      const hasGround = quads.some(v => v !== QUAD_HOLE);
      if (!hasGround && !liveDeck) {
        out.push({ cx, cz, kind: mask.some(v => v !== 0) ? 'water' : 'void', heights: null, quads: null, prisms: [], deck: null });
        continue;
      }
      out.push({ cx, cz, kind: 'land', heights, quads, prisms: derived.prisms, deck: liveDeck });
    }
  }
  return out.sort((a, b) => a.cz - b.cz || a.cx - b.cx);
}

// ---- main ----
const started = Date.now();
const bridges = await buildBridges();
fs.writeFileSync(path.join(outDir, 'bridges.json'), `${JSON.stringify(bridges.map(b => ({
  names: [...new Set(b.parts.map(p => p.name))], parts: b.parts.length, box: b.box.map(v => Math.round(v)), plane: b.plane, crest: b.crest, note: b.note,
})), null, 1)}\n`);
const decks = rasterizeDecks(bridges);
log(`decks: ${bridges.filter(b => b.plane).length}/${bridges.length} bridges with a plane over ${decks.size} squares`);

const pending: [number, number][] = [];
const bx0 = Math.floor(region[0] / BLOCK), bx1 = Math.floor((region[2] - 1) / BLOCK), bz0 = Math.floor(region[1] / BLOCK), bz1 = Math.floor((region[3] - 1) / BLOCK);
/** Digest of what a block's decks are made from (none without decks); a kept block whose digest differs is rebuilt. */
function deckDigest(bx: number, bz: number): string | undefined {
  const lines: string[] = [];
  for (let cz = bz * BASE_BLOCK; cz < (bz + 1) * BASE_BLOCK; cz++) for (let cx = bx * BASE_BLOCK; cx < (bx + 1) * BASE_BLOCK; cx++) {
    const d = decks.get(`${cx},${cz}`);
    if (d) lines.push(`${cx},${cz} ${d.planes.join(',')}${d.crest.some(Boolean) ? ` crest ${CREST_REACH},${CREST_END},border ${JSON.stringify(d.crest)}` : ''} ${Buffer.from(d.quads).toString('base64')} ${Buffer.from(d.surfaces).toString('base64')}`);
  }
  return lines.length ? sha256(`${DECK_GROUND}\n${lines.join('\n')}`) : undefined;
}
for (let bz = bz0; bz <= bz1; bz++) for (let bx = bx0; bx <= bx1; bx++) {
  if (blocks[blockKey(bx, bz)] && blocks[blockKey(bx, bz)]!.decks === deckDigest(bx, bz)) continue;
  let any = false;
  for (let cz = bz * BASE_BLOCK; cz < (bz + 1) * BASE_BLOCK && !any; cz++) for (let cx = bx * BASE_BLOCK; cx < (bx + 1) * BASE_BLOCK && !any; cx++) any = grid.isLive(cx, cz);
  if (any) pending.push([bx, bz]);
}
// Nearest the release first: distance from the block centre to the static cells' bounding box.
const cells = ids.map(id => grid.parse(id)!).filter(Boolean);
const sx0 = Math.min(...cells.map(c => c[0])) * SQUARE, sx1 = (Math.max(...cells.map(c => c[0])) + 1) * SQUARE;
const sz0 = Math.min(...cells.map(c => c[1])) * SQUARE, sz1 = (Math.max(...cells.map(c => c[1])) + 1) * SQUARE;
const distance = ([bx, bz]: [number, number]) => {
  const x = (bx + 0.5) * BLOCK, z = (bz + 0.5) * BLOCK;
  return Math.hypot(Math.max(sx0 - x, 0, x - sx1), Math.max(sz0 - z, 0, z - sz1));
};
pending.sort((a, b) => distance(a) - distance(b) || a[1] - b[1] || a[0] - b[0]);
const maxBlocks = values['max-blocks'] ? Number(values['max-blocks']) : pending.length;
let work = pending.slice(0, maxBlocks);
const retry: [number, number][] = [];
log(`${Object.keys(blocks).length} blocks kept, ${pending.length} to build, building ${work.length}`);
let next = 0, built = 0, failed = 0;
async function worker(): Promise<void> {
  while (next < work.length) {
    const [bx, bz] = work[next++]!;
    const key = blockKey(bx, bz);
    try {
      const squares = await buildBlock(bx, bz, decks);
      const bytes = gzipSync(encodeBaseBlock(squares), { level: 9 });
      fs.writeFileSync(path.join(outDir, `${key}.bin`), bytes);
      blocks[key] = { file: `${key}.bin`, bytes: bytes.length, sha256: sha256(bytes), squares: squares.length, decks: deckDigest(bx, bz) };
      writeIndex();
      built++;
      const land = squares.filter(s => s.kind === 'land').length;
      log(`${key}: ${squares.length} squares (${land} land), ${(bytes.length / 1024).toFixed(0)} KiB; ${built}/${work.length}, ${requests} requests, ${(downloaded / 2 ** 20).toFixed(0)} MiB downloaded, ${memory()}`);
    } catch (error) {
      failed++;
      retry.push([bx, bz]);
      log(`${key} failed: ${(error as Error).message}`);
    }
  }
}
writeIndex();
await Promise.all(Array.from({ length: Math.max(1, Number(values['block-concurrency'])) }, worker));
// One more pass over blocks a dropped connection failed.
if (retry.length) {
  log(`retrying ${retry.length} failed blocks`);
  work = retry.splice(0);
  next = 0;
  failed = 0;
  await Promise.all(Array.from({ length: Math.max(1, Number(values['block-concurrency'])) }, worker));
}
writeIndex();
log(`done in ${((Date.now() - started) / 60000).toFixed(1)} min: ${built} built, ${failed} failed, ${Object.keys(blocks).length} blocks in the index`);
agent.destroy();
