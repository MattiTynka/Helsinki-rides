// Road navigation for districts appended after an earlier world (Ruoholahti, Eira, Kaivopuisto, south Punavuori).
// OSM ways that reach the new cells and are not yet in the road graph become lanes, turn connectors, footways and
// parking slots the way build_roads.ts makes them, joined to the existing graph through shared OSM nodes (n<osmId>).
// Heights come from the world's own HCOL collision (the walkable surface at the right level), never the terrain grid;
// pieces with no surface (water, holes), running under buildings or jumping levels are dropped. The gameplay
// supportedArea grows over the new cells' public street, walk and green parts plus a margin around lanes and
// footways, minus water and building interiors. Only the roads and gameplay files change; every other file of the
// world is hard-linked (or copied) unchanged. Existing nodes, lanes, connectors, footways and parking stay as they are,
// except that a boundary/end node that new lanes now continue from becomes a junction.
//   node tools/world/extend_district_navigation.ts \
//     --world apps/game/public/world/helsinki-20261030-hietalahti-optimized-v1 \
//     --old-manifest apps/game/public/world/senate-20261025-civilian-flee/manifest.json \
//     --osm ../sources/raw-v2/osm/southwest-cumulative-20261029.json \
//     --street-parts ../sources/raw-v2/street-parts/southwest-cumulative-20261029.geojson \
//     --config content/helsinki/roads.json --out ../work/navigation-v1/world
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import polygonClipping from 'polygon-clipping';
import {
  cellId, decodeRoadGraph, encodePackedRoadGraph, geodeticToGk25, LaneSegmentIndex, parseCollisionBundle, parseTerrain,
  polylineLength, sampleTerrain, validateGameplayBundle, validateRoadGraph, validateSupportedArea, validateWorldManifest,
  type GameplayBundle, type RoadConnector, type RoadGraph, type RoadLane, type RoadNode, type SupportedArea, type TerrainGrid,
  type Vec3, type WorldManifest,
} from '../../packages/world-schema/src/index.ts';
import { centroid, pointInPolygon, ringDistance, signedArea, type Pt } from './lib/geometry.ts';
import { roadLaneLayout } from './lib/road-lane-layout.ts';

const { values } = parseArgs({ options: {
  world: { type: 'string' }, 'old-manifest': { type: 'string' }, osm: { type: 'string' }, 'street-parts': { type: 'string' },
  config: { type: 'string' }, out: { type: 'string' }, release: { type: 'string', default: 'helsinki-20261030-navigation-v1' },
  'manifest-sha256': { type: 'string' }, 'public-only': { type: 'boolean', default: false },
} });
for (const k of ['world', 'old-manifest', 'osm', 'street-parts', 'config', 'out'] as const) if (!values[k]) throw new Error(`--${k} is required`);
const worldDir = values.world!, outDir = values.out!;
if (fs.existsSync(outDir)) throw new Error(`${outDir} exists; the release is written into a new directory`);
if (!/^[a-z0-9][a-z0-9-]{0,95}$/.test(values.release!)) throw new Error('--release must be a lowercase release id');
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const started = Date.now();
const log = (message: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);

// ---- current world ----
const manifestBytes = fs.readFileSync(path.join(worldDir, 'manifest.json'));
if (values['manifest-sha256'] && sha256(manifestBytes) !== values['manifest-sha256']) throw new Error('Current manifest SHA-256 differs from --manifest-sha256');
const manifest = JSON.parse(manifestBytes.toString('utf8')) as WorldManifest;
if (validateWorldManifest(manifest).length) throw new Error(`Current manifest is invalid: ${validateWorldManifest(manifest).join('; ')}`);
type PayloadRef = { path: string; bytes: number; sha256: string; compression?: 'gzip'; decodedBytes?: number; decodedSha256?: string };
function readPayload(ref: PayloadRef): Buffer {
  const stored = fs.readFileSync(path.join(worldDir, ...ref.path.split('/')));
  if (stored.length !== ref.bytes || sha256(stored) !== ref.sha256) throw new Error(`${ref.path} differs from its manifest reference`);
  if (!ref.compression) return stored;
  const decoded = gunzipSync(stored, { maxOutputLength: 64 * 1024 * 1024 });
  if (decoded.length !== ref.decodedBytes || sha256(decoded) !== ref.decodedSha256) throw new Error(`${ref.path} decodes to different bytes`);
  return decoded;
}
const roads = decodeRoadGraph(new Uint8Array(readPayload(manifest.roads as PayloadRef)));
const gameplayText = readPayload(manifest.gameplay as PayloadRef).toString('utf8');
const gameplay = JSON.parse(gameplayText) as GameplayBundle;
if (validateGameplayBundle(gameplay).length || validateRoadGraph(roads).length) throw new Error('Current roads or gameplay are invalid');
const terrain: TerrainGrid = parseTerrain(new Uint8Array(readPayload(manifest.terrain as PayloadRef)));
const [E0, N0] = manifest.origin.originProjected;
const area = gameplay.playArea;
const config = JSON.parse(fs.readFileSync(values.config!, 'utf8'));
const oldCells = new Set((JSON.parse(fs.readFileSync(values['old-manifest']!, 'utf8')) as WorldManifest).cells.map(c => c.id));
const cellById = new Map(manifest.cells.map(c => [c.id, c]));
const newCells = new Set(manifest.cells.filter(c => !oldCells.has(c.id)).map(c => c.id));
const cellOf = (x: number, z: number) => cellId(Math.floor(x / manifest.cellSize), Math.floor(z / manifest.cellSize));
const isNew = (x: number, z: number) => newCells.has(cellOf(x, z));
const inPlay = (x: number, z: number) => x >= area.minX && x <= area.maxX && z >= area.minZ && z <= area.maxZ && cellById.has(cellOf(x, z));
log(`world ${manifest.worldReleaseId}: ${manifest.cells.length} cells, ${newCells.size} new; roads ${roads.lanes.length} lanes`);

// ---- collision probe: every static triangle at an XZ, from the published HCOL bundles ----
const WALK = 1, BLOCK = 2;
const BUCKET = 4;
interface Bundle { x0: number; z0: number; nx: number; nz: number; start: Int32Array; list: Int32Array; v: Float32Array; kind: Uint8Array }
interface Hit { y: number; kind: number }
class CollisionProbe {
  private readonly cache = new Map<string, Bundle>();
  private readonly squares = new Map<string, WorldManifest['cells'][number][]>();
  private readonly capacity: number;
  loads = 0;
  constructor(capacity: number) {
    this.capacity = capacity;
    for (const c of manifest.cells) {
      const b = c.collision.boundsXZ ?? c.boundsXZ;
      for (let sx = Math.floor(b[0] / 128); sx <= Math.floor(b[2] / 128); sx++) for (let sz = Math.floor(b[1] / 128); sz <= Math.floor(b[3] / 128); sz++) {
        const key = `${sx},${sz}`, list = this.squares.get(key) ?? [];
        list.push(c); this.squares.set(key, list);
      }
    }
  }
  private bundle(c: WorldManifest['cells'][number]): Bundle {
    let b = this.cache.get(c.id);
    if (b) { this.cache.delete(c.id); this.cache.set(c.id, b); return b; }
    const parsed = parseCollisionBundle(new Uint8Array(readPayload(c.collision as PayloadRef)));
    this.loads++;
    let count = 0;
    for (const col of parsed.colliders) if (col.group !== 'trees' && col.group !== 'props') count += col.indices.length / 3;
    const v = new Float32Array(count * 9), kind = new Uint8Array(count);
    let t = 0;
    for (const col of parsed.colliders) {
      if (col.group === 'trees' || col.group === 'props') continue;
      const walkable = col.group === 'ground' || col.group === 'kerbs';
      for (let i = 0; i < col.indices.length; i += 3, t++) {
        for (let k = 0; k < 3; k++) { const p = col.indices[i + k]! * 3; v[t * 9 + k * 3] = col.positions[p]!; v[t * 9 + k * 3 + 1] = col.positions[p + 1]!; v[t * 9 + k * 3 + 2] = col.positions[p + 2]!; }
        const ux = v[t * 9 + 3]! - v[t * 9]!, uy = v[t * 9 + 4]! - v[t * 9 + 1]!, uz = v[t * 9 + 5]! - v[t * 9 + 2]!;
        const wx = v[t * 9 + 6]! - v[t * 9]!, wy = v[t * 9 + 7]! - v[t * 9 + 1]!, wz = v[t * 9 + 8]! - v[t * 9 + 2]!;
        const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, len = Math.hypot(nx, ny, nz);
        // Walls, curb faces and seams are not a surface to stand on; roofs and building volumes block what is below.
        kind[t] = walkable ? (len > 0 && Math.abs(ny) / len >= 0.6 ? WALK : 0) : BLOCK;
      }
    }
    const bounds = c.collision.boundsXZ ?? c.boundsXZ;
    const x0 = Math.floor(bounds[0]) - 1, z0 = Math.floor(bounds[1]) - 1;
    const nx = Math.ceil((bounds[2] + 1 - x0) / BUCKET) + 1, nz = Math.ceil((bounds[3] + 1 - z0) / BUCKET) + 1;
    const counts = new Int32Array(nx * nz + 1);
    const range = (i: number) => {
      const a = i * 9;
      return [Math.floor((Math.min(v[a]!, v[a + 3]!, v[a + 6]!) - x0) / BUCKET), Math.floor((Math.max(v[a]!, v[a + 3]!, v[a + 6]!) - x0) / BUCKET),
        Math.floor((Math.min(v[a + 2]!, v[a + 5]!, v[a + 8]!) - z0) / BUCKET), Math.floor((Math.max(v[a + 2]!, v[a + 5]!, v[a + 8]!) - z0) / BUCKET)].map((n, k) => Math.max(0, Math.min(k < 2 ? nx - 1 : nz - 1, n)));
    };
    for (let i = 0; i < count; i++) { if (!kind[i]) continue; const [a, b2, c2, d] = range(i) as [number, number, number, number]; for (let z = c2; z <= d; z++) for (let x = a; x <= b2; x++) counts[z * nx + x + 1]!++; }
    for (let i = 1; i < counts.length; i++) counts[i]! += counts[i - 1]!;
    const list = new Int32Array(counts[counts.length - 1]!), fill = counts.slice(0, nx * nz);
    for (let i = 0; i < count; i++) { if (!kind[i]) continue; const [a, b2, c2, d] = range(i) as [number, number, number, number]; for (let z = c2; z <= d; z++) for (let x = a; x <= b2; x++) list[fill[z * nx + x]!++] = i; }
    b = { x0, z0, nx, nz, start: counts, list, v, kind };
    this.cache.set(c.id, b);
    if (this.cache.size > this.capacity) this.cache.delete(this.cache.keys().next().value!);
    return b;
  }
  /** Walkable and blocking surfaces at XZ, highest first. */
  hits(x: number, z: number): Hit[] {
    const out: Hit[] = [];
    for (const c of this.squares.get(`${Math.floor(x / 128)},${Math.floor(z / 128)}`) ?? []) {
      const bounds = c.collision.boundsXZ ?? c.boundsXZ;
      if (x < bounds[0] || x > bounds[2] || z < bounds[1] || z > bounds[3]) continue;
      const b = this.bundle(c), bx = Math.floor((x - b.x0) / BUCKET), bz = Math.floor((z - b.z0) / BUCKET);
      if (bx < 0 || bz < 0 || bx >= b.nx || bz >= b.nz) continue;
      const cell = bz * b.nx + bx, v = b.v;
      for (let k = b.start[cell]!; k < b.start[cell + 1]!; k++) {
        const t = b.list[k]!, a = t * 9;
        const ax = v[a]!, az = v[a + 2]!, bx2 = v[a + 3]!, bz2 = v[a + 5]!, cx = v[a + 6]!, cz = v[a + 8]!;
        const det = (bz2 - cz) * (ax - cx) + (cx - bx2) * (az - cz);
        if (Math.abs(det) < 1e-12) continue;
        const u = ((bz2 - cz) * (x - cx) + (cx - bx2) * (z - cz)) / det, w = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
        if (u < -1e-7 || w < -1e-7 || 1 - u - w < -1e-7) continue;
        out.push({ y: u * v[a + 1]! + w * v[a + 4]! + (1 - u - w) * v[a + 7]!, kind: b.kind[t]! });
      }
    }
    return out.sort((p, q) => q.y - p.y);
  }
}
const probe = new CollisionProbe(72);
const terrainAt = (x: number, z: number) => sampleTerrain(terrain, x, z);

/** The walkable surface at XZ: continuing from `near` when given, else the deck for bridges, else the one nearest the
 * terrain grid. `blocked` when a building or landmark volume lies over it. */
function surface(x: number, z: number, near: number | null, bridge: boolean): { y: number | null; blocked: boolean } {
  const hits = probe.hits(x, z), walk = hits.filter(h => h.kind === WALK);
  if (!walk.length) return { y: null, blocked: hits.some(h => h.kind === BLOCK) };
  let best = walk[0]!;
  const target = near ?? (bridge ? Infinity : terrainAt(x, z));
  if (Number.isFinite(target)) for (const h of walk) if (Math.abs(h.y - target) < Math.abs(best.y - target)) best = h;
  return { y: best.y, blocked: hits.some(h => h.kind === BLOCK && h.y > best.y + 0.3) };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
interface Draped { points: Vec3[]; samples: number; misses: number; missRun: number; blockedRun: number; jumps: number; good: boolean[]; bad: { gap: number; blocked: number; jump: number }; sampleXZ: Pt[]; sampleY: number[]; keep: boolean[] }
/** Heights along a polyline from 2 m collision samples; output keeps every source vertex plus the samples needed to
 * stay within 0.2 m of the sampled profile. A sample is good on a surface, not under a building and not after a
 * level jump; gaps of at most two samples (seams, drains) count as good and take the neighbouring heights. */
function drape(line: readonly Pt[], options: { anchor: number | null; bridge: boolean; maxStep: number }): Draped {
  const xz: Pt[] = [], isVertex: boolean[] = [];
  for (let i = 0; i < line.length; i++) {
    xz.push(line[i]!); isVertex.push(true);
    if (i + 1 === line.length) break;
    const a = line[i]!, b = line[i + 1]!, n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2));
    for (let k = 1; k < n; k++) { xz.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]); isVertex.push(false); }
  }
  const ys: (number | null)[] = [], blockedAt: boolean[] = [], jumpAt: boolean[] = [];
  let prev: number | null = null, misses = 0, missRun = 0, run = 0, blockedRun = 0, blocked = 0, jumps = 0;
  for (let k = 0; k < xz.length; k++) {
    const s = surface(xz[k]![0], xz[k]![1], prev ?? (k === 0 ? options.anchor : null), options.bridge);
    const jump = s.y !== null && prev !== null && Math.abs(s.y - prev) > options.maxStep;
    if (jump) jumps++;
    ys.push(s.y); blockedAt.push(s.blocked); jumpAt.push(jump);
    if (s.y === null) { misses++; missRun = Math.max(missRun, ++run); } else { run = 0; prev = s.y; }
    if (s.blocked) blockedRun = Math.max(blockedRun, ++blocked); else blocked = 0;
  }
  const good = ys.map((y, k) => {
    if (blockedAt[k] || jumpAt[k]) return false;
    if (y !== null) return true;
    let a = k, b = k;
    while (a > 0 && ys[a - 1] === null) a--;
    while (b + 1 < ys.length && ys[b + 1] === null) b++;
    return b - a + 1 <= 2 && a > 0 && b + 1 < ys.length;
  });
  const bad = { gap: 0, blocked: 0, jump: 0 };
  good.forEach((g, k) => { if (!g) bad[jumpAt[k] ? 'jump' : blockedAt[k] ? 'blocked' : 'gap']++; });
  // Short gaps (seams, drains) take the neighbouring heights.
  const known = ys.map((y, i) => y === null ? -1 : i).filter(i => i >= 0);
  const filled = ys.map((y, i) => {
    if (y !== null) return y;
    if (!known.length) return terrainAt(xz[i]![0], xz[i]![1]);
    let lo = -1, hi = -1;
    for (const k of known) { if (k < i) lo = k; else { hi = k; break; } }
    if (lo < 0) return ys[hi]!;
    if (hi < 0) return ys[lo]!;
    return ys[lo]! + (ys[hi]! - ys[lo]!) * (i - lo) / (hi - lo);
  });
  const s = [0];
  for (let k = 1; k < xz.length; k++) s.push(s[k - 1]! + Math.hypot(xz[k]![0] - xz[k - 1]![0], xz[k]![1] - xz[k - 1]![1]));
  const keep = isVertex.slice();
  const stack: [number, number][] = [];
  let last = 0;
  for (let k = 1; k < xz.length; k++) if (keep[k]) { stack.push([last, k]); last = k; }
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1, worstD = 0.2;
    for (let k = a + 1; k < b; k++) {
      const d = Math.abs(filled[k]! - (filled[a]! + (filled[b]! - filled[a]!) * (s[k]! - s[a]!) / Math.max(1e-9, s[b]! - s[a]!)));
      if (d > worstD) { worstD = d; worst = k; }
    }
    if (worst >= 0) { keep[worst] = true; stack.push([a, worst], [worst, b]); }
  }
  const points: Vec3[] = [];
  for (let k = 0; k < xz.length; k++) if (keep[k]) points.push([round3(xz[k]![0]), round3(filled[k]!), round3(xz[k]![1])]);
  return { points, samples: xz.length, misses, missRun, blockedRun, jumps, good, bad, sampleXZ: xz, sampleY: filled, keep };
}

// ---- OSM ----
interface OsmElement { type: 'node' | 'way' | 'relation'; id: number; lat?: number; lon?: number; nodes?: number[]; tags?: Record<string, string>; members?: { type: string; ref: number; role: string }[] }
const osm = JSON.parse(fs.readFileSync(values.osm!, 'utf8')) as { elements: OsmElement[] };
const existingNodes = new Map(roads.nodes.map(n => [n.id, n]));
const nodeXZ = new Map<number, Pt>();
for (const e of osm.elements) if (e.type === 'node' && e.lat !== undefined && e.lon !== undefined) {
  // Shared nodes keep the existing graph's (registered) position, so joins need no gap.
  const known = existingNodes.get(`n${e.id}`);
  if (known) { nodeXZ.set(e.id, [known.position[0], known.position[2]]); continue; }
  const [E, N] = geodeticToGk25(e.lat, e.lon);
  nodeXZ.set(e.id, [E - E0, -(N - N0)]);
}
const ways = osm.elements.filter((e): e is OsmElement & { nodes: number[]; tags: Record<string, string> } => e.type === 'way' && !!e.nodes && !!e.tags?.['highway']);
interface Restriction { from: number; via: number; to: number; only: boolean }
const restrictions: Restriction[] = [];
for (const e of osm.elements) {
  if (e.type !== 'relation' || e.tags?.['type'] !== 'restriction' || !e.members) continue;
  const r = e.tags['restriction'] ?? e.tags['restriction:motorcar'] ?? '';
  const from = e.members.find(m => m.role === 'from' && m.type === 'way'), to = e.members.find(m => m.role === 'to' && m.type === 'way');
  const via = e.members.find(m => m.role === 'via' && m.type === 'node');
  if (from && to && via) restrictions.push({ from: from.ref, via: via.ref, to: to.ref, only: r.startsWith('only_') });
}
log(`OSM: ${nodeXZ.size} nodes, ${ways.length} highway ways, ${restrictions.length} turn restrictions`);

const drivable = new Set<string>(config.drivable), footwayClasses = new Set<string>(config.footways);
const layered = (tags: Record<string, string>) => (tags['tunnel'] && tags['tunnel'] !== 'no') || (tags['indoor'] && tags['indoor'] !== 'no')
  || tags['covered'] === 'yes' || Number(tags['layer'] ?? 0) < 0;
const isBridge = (tags: Record<string, string>) => (!!tags['bridge'] && tags['bridge'] !== 'no') || Number(tags['layer'] ?? 0) > 0;
const reachesNew = (nodes: readonly number[]) => nodes.some(n => { const p = nodeXZ.get(n); return !!p && isNew(p[0], p[1]); });
/** Maximal runs of a way inside the playable, built world. */
function playRuns(nodes: readonly number[]): number[][] {
  const runs: number[][] = [];
  let current: number[] = [];
  for (const n of nodes) {
    const p = nodeXZ.get(n);
    if (p && inPlay(p[0], p[1])) current.push(n);
    else { if (current.length >= 2) runs.push(current); current = []; }
  }
  if (current.length >= 2) runs.push(current);
  return runs;
}

// ---- drivable selection and pieces ----
const report: Record<string, unknown> = {};
const dropped: Record<string, number> = {};
const drop = (reason: string) => { dropped[reason] = (dropped[reason] ?? 0) + 1; };
interface Way { id: number; nodes: number[]; tags: Record<string, string> }
const driveWays: Way[] = [];
for (const w of ways) {
  const t = w.tags, hw = t['highway']!;
  if (!drivable.has(hw) || t['area'] === 'yes' || !reachesNew(w.nodes)) continue;
  const access = t['motor_vehicle'] ?? t['vehicle'] ?? t['access'];
  if (access === 'no' || access === 'private') { drop('way:access'); continue; }
  if (layered(t)) { drop('way:tunnel-or-indoor'); continue; }
  // Private driveways lead into courtyards, mostly through building passages; they strand traffic.
  if (['driveway', 'drive-through', 'emergency_access'].includes(t['service'] ?? '')) { drop('way:driveway'); continue; }
  for (const run of playRuns(w.nodes)) driveWays.push({ id: w.id, nodes: run, tags: t });
}
const useCount = new Map<number, number>();
for (const w of driveWays) for (const n of w.nodes) useCount.set(n, (useCount.get(n) ?? 0) + 1);
const splitAt = (n: number) => (useCount.get(n) ?? 0) > 1 || existingNodes.has(`n${n}`);
const existingLaneKeys = new Set(roads.lanes.map(l => `${l.wayId}|${l.from}|${l.to}`));
const nextPiece = new Map<number, number>();
for (const l of roads.lanes) { const k = Number(l.id.split(':')[1]); if (Number.isInteger(k)) nextPiece.set(l.wayId, Math.max(nextPiece.get(l.wayId) ?? 0, k + 1)); }
const existingLaneIndex = new LaneSegmentIndex(roads.lanes);
const existingEnds = new Set(roads.lanes.map(l => `${l.from}|${l.to}`));
const existingLaneById = new Map(roads.lanes.map(l => [l.id, l]));
/** Unit XZ direction of a lane at arc length s. */
function laneDirection(lane: RoadLane, s: number): [number, number] {
  let acc = 0;
  for (let i = 1; i < lane.points.length; i++) {
    const a = lane.points[i - 1]!, b = lane.points[i]!, len = Math.hypot(b[0] - a[0], b[2] - a[2]);
    if (len > 1e-6 && (acc + len >= s || i === lane.points.length - 1)) return [(b[0] - a[0]) / len, (b[2] - a[2]) / len];
    acc += len;
  }
  return [0, 0];
}
interface Piece { id: string; way: Way; nodes: number[]; base: Pt[] }
const pieces: Piece[] = [];
let representedPieces = 0;
const representedNearby: { way: number; name: string | null; from: string; to: string; at: number[] }[] = [];
for (const w of driveWays) {
  let start = 0;
  for (let i = 1; i < w.nodes.length; i++) {
    if (!(splitAt(w.nodes[i]!) || i === w.nodes.length - 1)) continue;
    const nodes = w.nodes.slice(start, i + 1);
    start = i;
    const a = `n${nodes[0]}`, b = `n${nodes[nodes.length - 1]}`;
    if (existingLaneKeys.has(`${w.id}|${a}|${b}`) || existingLaneKeys.has(`${w.id}|${b}|${a}`)
      || existingEnds.has(`${a}|${b}`) || existingEnds.has(`${b}|${a}`)) { representedPieces++; continue; }
    const base = nodes.map(n => nodeXZ.get(n)!);
    // The same street under other way and node ids is already in the graph: most of a longer piece runs on top of,
    // and parallel to, existing lanes. Short junction stubs always lie near other lanes, so they are never matched.
    let near = 0, total = 0, length = 0;
    for (let k = 0; k + 1 < base.length; k++) {
      const p = base[k]!, q = base[k + 1]!, segment = Math.hypot(q[0] - p[0], q[1] - p[1]), n = Math.max(1, Math.ceil(segment / 4));
      length += segment;
      const dir: [number, number] = [(q[0] - p[0]) / (segment || 1), (q[1] - p[1]) / (segment || 1)];
      for (let j = 0; j < n; j++) {
        total++;
        const hit = existingLaneIndex.nearest(p[0] + (q[0] - p[0]) * j / n, p[1] + (q[1] - p[1]) * j / n, dir, 3.5);
        if (!hit) continue;
        const d = laneDirection(existingLaneById.get(hit.laneId)!, hit.s);
        if (Math.abs(d[0] * dir[0] + d[1] * dir[1]) >= 0.9) near++;
      }
    }
    if (length >= 20 && total && near / total >= 0.75) {
      representedPieces++;
      representedNearby.push({ way: w.id, name: w.tags['name'] ?? null, from: a, to: b, at: base[0]!.map(round3) });
      continue;
    }
    const k = nextPiece.get(w.id) ?? 0;
    nextPiece.set(w.id, k + 1);
    pieces.push({ id: `${w.id}:${k}`, way: w, nodes, base });
  }
}
log(`drivable: ${driveWays.length} way runs, ${pieces.length} new pieces, ${representedPieces} already in the graph`);

// ---- lanes (build_roads.ts layout and offsets), draped on collision ----
const speedFor = (hw: string, tags: Record<string, string>): number => {
  const m = tags['maxspeed']?.match(/^(\d+)/);
  return m ? Number(m[1]) / 3.6 : config.speedLimits[hw] ?? config.speedLimits.default;
};
const widthFor = (hw: string): number => config.laneWidth[hw] ?? config.laneWidth.default;
const surfaceFor = (tags: Record<string, string>): string => config.surfaces[tags['surface'] ?? ''] ?? config.surfaces.default;
function offsetPolyline(pts: readonly Pt[], offset: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)]!, b = pts[Math.min(pts.length - 1, i + 1)]!;
    let dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    let scale = 1;
    if (i > 0 && i < pts.length - 1) {
      const p = pts[i - 1]!, q = pts[i]!, r = pts[i + 1]!;
      const d1x = q[0] - p[0], d1z = q[1] - p[1], l1 = Math.hypot(d1x, d1z) || 1;
      const d2x = r[0] - q[0], d2z = r[1] - q[1], l2 = Math.hypot(d2x, d2z) || 1;
      const cos = (d1x * d2x + d1z * d2z) / (l1 * l2);
      scale = Math.min(2, 1 / Math.max(0.5, Math.cos(Math.acos(Math.max(-1, Math.min(1, cos))) / 2)));
    }
    out.push([pts[i]![0] - dz * offset * scale, pts[i]![1] + dx * offset * scale]);
  }
  return out;
}
interface NewLane extends RoadLane { piece: string }
let newLanes: NewLane[] = [];
const droppedPieces: { piece: string; name: string | null; highway: string; reason: string; at: number[] }[] = [];
const pieceById = new Map(pieces.map(p => [p.id, p]));
for (const p of pieces) {
  const t = p.way.tags, hw = t['highway']!;
  let layout: ReturnType<typeof roadLaneLayout>;
  try { layout = roadLaneLayout(t, widthFor(hw)); } catch { drop('piece:lane-layout'); continue; }
  const made: NewLane[] = [];
  let failure: string | null = null;
  for (const dir of ['f', 'b'] as const) {
    const count = dir === 'f' ? layout.forward : layout.backward;
    for (let idx = 0; idx < count && !failure; idx++) {
      const line = offsetPolyline(dir === 'f' ? p.base : [...p.base].reverse(), layout.offsets[dir === 'f' ? 'forward' : 'backward'][idx]!);
      const from = `n${dir === 'f' ? p.nodes[0] : p.nodes[p.nodes.length - 1]}`, to = `n${dir === 'f' ? p.nodes[p.nodes.length - 1] : p.nodes[0]}`;
      const d = drape(line, { anchor: existingNodes.get(from)?.position[1] ?? null, bridge: isBridge(t), maxStep: 0.9 });
      if (d.missRun > 2 || d.misses > d.samples * 0.25) failure = 'piece:no-surface';
      else if (d.blockedRun > 2) failure = 'piece:under-building';
      else if (d.jumps) failure = 'piece:height-jump';
      if (failure) break;
      made.push({ id: `${p.id}:${dir}${idx}`, wayId: p.way.id, name: t['name'] ?? null, highway: hw, surface: surfaceFor(t),
        speedLimit: speedFor(hw, t), width: layout.width, from, to, points: d.points, length: polylineLength(d.points), index: idx, count, piece: p.id });
    }
  }
  if (failure) { drop(failure); droppedPieces.push({ piece: p.id, name: t['name'] ?? null, highway: hw, reason: failure, at: p.base[0]!.map(round3) }); continue; }
  newLanes.push(...made);
}
log(`lanes: ${newLanes.length} draped lanes`);

// ---- connectors, pruning and junction kinds ----
const allowed = (inLane: RoadLane, outLane: RoadLane, node: string): boolean => {
  const via = Number(node.slice(1));
  for (const r of restrictions) {
    if (r.via !== via) continue;
    if (r.only) { if (r.from === inLane.wayId && r.to !== outLane.wayId) return false; }
    else if (r.from === inLane.wayId && r.to === outLane.wayId) return false;
  }
  return true;
};
const tangent = (l: RoadLane, end: boolean): [number, number] => {
  const a = end ? l.points[l.points.length - 2]! : l.points[0]!, b = end ? l.points[l.points.length - 1]! : l.points[1]!;
  const len = Math.hypot(b[0] - a[0], b[2] - a[2]) || 1;
  return [(b[0] - a[0]) / len, (b[2] - a[2]) / len];
};
function curve(p0: Vec3, t0: [number, number], p3: Vec3, t1: [number, number]): Vec3[] {
  const d = Math.hypot(p3[0] - p0[0], p3[2] - p0[2]), k = Math.max(0.5, d / 3);
  const p1 = [p0[0] + t0[0] * k, p0[2] + t0[1] * k], p2 = [p3[0] - t1[0] * k, p3[2] - t1[1] * k];
  const n = Math.max(2, Math.min(8, Math.ceil(d / 2.5)));
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const s = i / n, u = 1 - s;
    const x = u * u * u * p0[0] + 3 * u * u * s * p1[0]! + 3 * u * s * s * p2[0]! + s * s * s * p3[0];
    const z = u * u * u * p0[2] + 3 * u * u * s * p1[1]! + 3 * u * s * s * p2[1]! + s * s * s * p3[2];
    const linear = p0[1] + (p3[1] - p0[1]) * s;
    const level = i === 0 || i === n ? null : surface(x, z, linear, false).y;
    out.push([round3(x), round3(level !== null && Math.abs(level - linear) <= 0.5 ? level : linear), round3(z)]);
  }
  return out;
}
const existingIn = new Map<string, RoadLane[]>(), existingOut = new Map<string, RoadLane[]>();
for (const l of roads.lanes) {
  (existingIn.get(l.to) ?? existingIn.set(l.to, []).get(l.to)!).push(l);
  (existingOut.get(l.from) ?? existingOut.set(l.from, []).get(l.from)!).push(l);
}
const pieceOf = (id: string) => id.slice(0, id.lastIndexOf(':'));
let connectors: RoadConnector[] = [];
const prunedPieces = new Map<string, string>();
const kinds = new Map<string, RoadNode['kind']>();
for (let pass = 0; ; pass++) {
  // Node kinds from the surviving pieces: a new node is a junction where two pieces meet, else a dead end (u-turn).
  const pieceEnds = new Map<string, Set<string>>();
  for (const l of newLanes) for (const n of [l.from, l.to]) (pieceEnds.get(n) ?? pieceEnds.set(n, new Set()).get(n)!).add(l.piece);
  kinds.clear();
  for (const [n, set] of pieceEnds) {
    const existing = existingNodes.get(n);
    kinds.set(n, existing ? (existing.kind === 'boundary' || existing.kind === 'end' ? 'junction' : existing.kind) : set.size > 1 ? 'junction' : 'end');
  }
  const inByNode = new Map<string, RoadLane[]>(), outByNode = new Map<string, RoadLane[]>();
  for (const l of newLanes) {
    (inByNode.get(l.to) ?? inByNode.set(l.to, []).get(l.to)!).push(l);
    (outByNode.get(l.from) ?? outByNode.set(l.from, []).get(l.from)!).push(l);
  }
  const newIds = new Set(newLanes.map(l => l.id));
  connectors = [];
  for (const node of kinds.keys()) {
    const kind = kinds.get(node)!;
    const incoming = [...existingIn.get(node) ?? [], ...inByNode.get(node) ?? []], outgoing = [...existingOut.get(node) ?? [], ...outByNode.get(node) ?? []];
    for (const inLane of incoming) for (const outLane of outgoing) {
      if (!newIds.has(inLane.id) && !newIds.has(outLane.id)) continue;
      const reversal = pieceOf(inLane.id) === pieceOf(outLane.id);
      if (reversal && kind !== 'end') continue;
      if (!allowed(inLane, outLane, node)) continue;
      const t0 = tangent(inLane, true), t1 = tangent(outLane, false);
      const cross = t0[0] * (-t1[1]) - (-t0[1]) * t1[0], dot = t0[0] * t1[0] + t0[1] * t1[1];
      const angle = Math.atan2(cross, dot) * 180 / Math.PI;
      const turn = reversal ? 'u-turn' : Math.abs(angle) < 30 ? 'straight' : angle > 0 ? 'left' : 'right';
      if (turn === 'straight' && inLane.count > 1 && outLane.count > 1 && inLane.index !== outLane.index) continue;
      const points = curve(inLane.points[inLane.points.length - 1]!, t0, outLane.points[0]!, t1);
      connectors.push({ id: `${inLane.id}>${outLane.id}`, node, from: inLane.id, to: outLane.id, turn, points, length: polylineLength(points) });
    }
  }
  // A new lane without a way out strands traffic; tiny fragments that never meet the existing graph are noise.
  const exits = new Set(connectors.map(c => c.from));
  const stranded = newLanes.filter(l => !exits.has(l.id));
  const adjacency = new Map<string, string[]>();
  const link = (a: string, b: string) => { (adjacency.get(a) ?? adjacency.set(a, []).get(a)!).push(b); };
  for (const c of connectors) { link(c.from, c.to); link(c.to, c.from); }
  const seen = new Set<string>(), fragments: string[] = [], laneLength = new Map(newLanes.map(l => [l.id, l.length]));
  for (const l of newLanes) {
    if (seen.has(l.id)) continue;
    const component: string[] = [], stack = [l.id];
    let attached = false, length = 0;
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (!newIds.has(id)) { attached = true; continue; }
      component.push(id);
      length += laneLength.get(id)!;
      for (const next of adjacency.get(id) ?? []) stack.push(next);
    }
    if (!attached && length < 120) fragments.push(...component);
  }
  const strandedIds = new Set(stranded.map(l => l.id)), remove = new Set([...strandedIds, ...fragments]);
  if (!remove.size) break;
  dropped['lane:no-exit'] = (dropped['lane:no-exit'] ?? 0) + stranded.length;
  dropped['lane:fragment'] = (dropped['lane:fragment'] ?? 0) + fragments.filter(id => !strandedIds.has(id)).length;
  for (const l of newLanes) if (remove.has(l.id)) prunedPieces.set(l.piece, strandedIds.has(l.id) ? 'no-exit' : 'fragment');
  newLanes = newLanes.filter(l => !remove.has(l.id));
  if (pass > 200) throw new Error('Lane pruning did not converge');
}
for (const l of newLanes) prunedPieces.delete(l.piece);
log(`connectors: ${connectors.length} new; ${newLanes.length} lanes kept`);

// ---- nodes ----
const nodes: RoadNode[] = roads.nodes.map(n => kinds.has(n.id) && kinds.get(n.id) !== n.kind ? { ...n, kind: kinds.get(n.id)! } : n);
const changedKinds = nodes.filter((n, i) => n !== roads.nodes[i]).map(n => ({ id: n.id, from: existingNodes.get(n.id)!.kind, to: n.kind }));
for (const [id, kind] of kinds) {
  if (existingNodes.has(id)) continue;
  const ends = newLanes.flatMap(l => [...l.from === id ? [l.points[0]!] : [], ...l.to === id ? [l.points[l.points.length - 1]!] : []]);
  const xz = nodeXZ.get(Number(id.slice(1)))!;
  nodes.push({ id, position: [round3(xz[0]), round3(ends.reduce((s, p) => s + p[1], 0) / ends.length), round3(xz[1])], kind });
}
const lanesOut: RoadLane[] = newLanes.map(({ piece: _piece, ...lane }) => lane);

// ---- footways ----
const existingFootways = new Set(roads.footways.map(f => f.id));
const footwayIndex = new LaneSegmentIndex(roads.footways as unknown as RoadLane[]);
const footways: { id: string; points: Vec3[] }[] = [];
let footwayCandidates = 0;
for (const w of ways) {
  const t = w.tags, hw = t['highway']!;
  if (!footwayClasses.has(hw) || t['area'] === 'yes' || existingFootways.has(`w${w.id}`) || !reachesNew(w.nodes)) continue;
  const foot = t['foot'], access = t['access'];
  if (foot === 'no' || foot === 'private' || ((access === 'no' || access === 'private') && !['yes', 'designated', 'permissive'].includes(foot ?? ''))) { drop('footway:access'); continue; }
  if (layered(t)) { drop('footway:tunnel-or-indoor'); continue; }
  footwayCandidates++;
  const stretches: Vec3[][] = [];
  for (const run of playRuns(w.nodes)) {
    const line = run.map(n => nodeXZ.get(n)!);
    let near = 0, total = 0;
    for (let k = 0; k + 1 < line.length; k++) {
      const p = line[k]!, q = line[k + 1]!, n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / 4));
      for (let j = 0; j < n; j++) { total++; if (footwayIndex.nearest(p[0] + (q[0] - p[0]) * j / n, p[1] + (q[1] - p[1]) * j / n, undefined, 2)) near++; }
    }
    if (total && near / total >= 0.75) { drop('footway:already-mapped'); continue; }
    const d = drape(line, { anchor: null, bridge: isBridge(t), maxStep: hw === 'steps' ? 1.5 : 1.2 });
    // Keep the supported stretches; a footway may cross a quay gap or pass under a building.
    // A whole short way (a crossing, a link between sidewalks) stays for the minimap; cut scraps need some length.
    const good = d.good, whole = good.every(g => g), minimum = whole ? 2 : 8;
    for (let k = 0; k < good.length;) {
      if (!good[k]) { k++; continue; }
      let e = k;
      while (e + 1 < good.length && good[e + 1]) e++;
      const pts: Vec3[] = [];
      for (let j = k; j <= e; j++) if (j === k || j === e || d.keep[j]) pts.push([round3(d.sampleXZ[j]![0]), round3(d.sampleY[j]!), round3(d.sampleXZ[j]![1])]);
      if (pts.length >= 2 && polylineLength(pts) >= minimum) stretches.push(pts);
      else drop('footway:short-stretch');
      k = e + 1;
    }
    if (!whole) drop('footway:cut');
    for (const [reason, n] of Object.entries(d.bad)) if (n) dropped[`footway:samples-${reason}`] = (dropped[`footway:samples-${reason}`] ?? 0) + n;
  }
  stretches.forEach((points, k) => footways.push({ id: stretches.length === 1 ? `w${w.id}` : `w${w.id}.${k}`, points }));
}
log(`footways: ${footways.length} stretches from ${footwayCandidates} ways`);

// ---- street parts: parking slots and the supported-area classes ----
interface Part { id: string; main: string; sub: string; rings: Pt[][]; bbox: [number, number, number, number] }
const parts: Part[] = [];
{
  const gj = JSON.parse(fs.readFileSync(values['street-parts']!, 'utf8')) as { features: { geometry: { type: string; coordinates: unknown } | null; properties: Record<string, unknown> }[] };
  gj.features.forEach((f, i) => {
    const polys = f.geometry?.type === 'Polygon' ? [f.geometry.coordinates as number[][][]] : f.geometry?.type === 'MultiPolygon' ? f.geometry.coordinates as number[][][][] : [];
    polys.forEach((poly, k) => {
      // Working frame here is the runtime XZ (z south).
      const rings = poly.map(r => r.map(([e, n]) => [e! - E0, -(n! - N0)] as Pt)).filter(r => r.length >= 3);
      if (!rings.length) return;
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const [x, z] of rings[0]!) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
      parts.push({ id: String(f.properties['osan_id'] ?? f.properties['id'] ?? i) + (polys.length > 1 ? `#${k}` : ''), main: String(f.properties['paatyyppi'] ?? ''),
        sub: String(f.properties['alatyyppi'] ?? ''), rings, bbox: [x0, z0, x1, z1] });
    });
  });
}
const existingParking = new Set(roads.parking.map(p => p.id));
const parking: RoadGraph['parking'][number][] = [];
const spacing = Number(config.parkingSlotSpacing), inset = Number(config.parkingInset);
for (const part of parts) {
  if (part.sub !== 'Pysäköintialue' || existingParking.has(`p${part.id}`)) continue;
  // build_roads.ts slot layout, in its (X east, Y north) frame.
  const rings = part.rings.map(r => r.map(([x, z]) => [x, -z] as Pt)), ring = rings[0]!;
  const c0 = centroid(ring);
  if (!isNew(c0[0], -c0[1])) continue;
  let ax = 0, ay = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!, dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy), ang = Math.atan2(dy, dx) * 2;
    ax += Math.cos(ang) * l; ay += Math.sin(ang) * l;
  }
  const theta = Math.atan2(ay, ax) / 2, ux = Math.cos(theta), uy = Math.sin(theta);
  let smin = Infinity, smax = -Infinity, tmin = Infinity, tmax = -Infinity;
  for (const p of ring) {
    const s = (p[0] - c0[0]) * ux + (p[1] - c0[1]) * uy, t = -(p[0] - c0[0]) * uy + (p[1] - c0[1]) * ux;
    smin = Math.min(smin, s); smax = Math.max(smax, s); tmin = Math.min(tmin, t); tmax = Math.max(tmax, t);
  }
  const rows = Math.max(1, Math.floor((tmax - tmin) / 5.0)), points: Vec3[] = [];
  for (let r = 0; r < rows; r++) {
    const t = tmin + (tmax - tmin) * (r + 0.5) / rows;
    for (let s = smin + inset; s <= smax - inset; s += spacing) {
      const x = c0[0] + ux * s - uy * t, y = c0[1] + uy * s + ux * t;
      if (!pointInPolygon([x, y], rings) || ringDistance([x, y], ring) < inset * 0.8 || !inPlay(x, -y)) continue;
      const level = surface(x, -y, null, false);
      if (level.y === null || level.blocked) { drop('parking:unsupported-slot'); continue; }
      points.push([round3(x), round3(level.y), round3(-y)]);
    }
  }
  if (points.length) parking.push({ id: `p${part.id}`, kind: 'area', points, heading: ((Math.atan2(ux, uy) * 180 / Math.PI) + 360) % 360 });
}
log(`parking: ${parking.length} areas, ${parking.reduce((s, p) => s + p.points.length, 0)} slots`);

// ---- the extended graph ----
const graph: RoadGraph = {
  schemaVersion: 2, originId: roads.originId, source: roads.source,
  nodes, lanes: [...roads.lanes, ...lanesOut], connectors: [...roads.connectors, ...connectors],
  parking: [...roads.parking, ...parking], footways: [...roads.footways, ...footways],
};
const graphProblems = validateRoadGraph(graph);
if (graphProblems.length) throw new Error(graphProblems.slice(0, 20).join('\n'));
for (const key of ['lanes', 'connectors', 'parking', 'footways'] as const) {
  const ids = new Set<string>();
  for (const r of graph[key]) { if (ids.has(r.id)) throw new Error(`duplicate ${key} id ${r.id}`); ids.add(r.id); }
}

// ---- supported area: a 1 m raster of qualified ground, traced, simplified and united with the current mask ----
const MARGIN = 32;
let rx0 = Infinity, rz0 = Infinity, rx1 = -Infinity, rz1 = -Infinity;
for (const id of newCells) { const b = cellById.get(id)!.boundsXZ; rx0 = Math.min(rx0, b[0]); rz0 = Math.min(rz0, b[1]); rx1 = Math.max(rx1, b[2]); rz1 = Math.max(rz1, b[3]); }
// Pixel corners sit on half metres, so traced edges never coincide with the integer edges of the current mask.
const X0 = Math.max(area.minX, Math.floor(rx0 - MARGIN)) + 0.5, Z0 = Math.max(area.minZ, Math.floor(rz0 - MARGIN)) + 0.5;
const W = Math.floor(Math.min(area.maxX, rx1 + MARGIN) - X0), H = Math.floor(Math.min(area.maxZ, rz1 + MARGIN) - Z0);
const domain = new Uint8Array(W * H), want = new Uint8Array(W * H), water = new Uint8Array(W * H);
// The new cells, and the built cells within MARGIN of them, inside the play area.
const size = manifest.cellSize, gx0 = Math.floor(X0 / size) - 1, gz0 = Math.floor(Z0 / size) - 1;
const gw = Math.ceil((X0 + W) / size) - gx0 + 2, gh = Math.ceil((Z0 + H) / size) - gz0 + 2, cellState = new Uint8Array(gw * gh);
for (let gz = 0; gz < gh; gz++) for (let gx = 0; gx < gw; gx++) { const id = cellId(gx + gx0, gz + gz0); cellState[gz * gw + gx] = newCells.has(id) ? 2 : cellById.has(id) ? 1 : 0; }
for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
  const x = X0 + i + 0.5, z = Z0 + j + 0.5, cx = Math.floor(x / size) - gx0, cz = Math.floor(z / size) - gz0, state = cellState[cz * gw + cx]!;
  let inside = state === 2;
  if (state === 1) for (let dz = -1; dz <= 1 && !inside; dz++) for (let dx = -1; dx <= 1 && !inside; dx++) {
    if (cellState[(cz + dz) * gw + cx + dx] !== 2) continue;
    const bx = Math.max((cx + dx + gx0) * size, Math.min(x, (cx + dx + gx0 + 1) * size)), bz = Math.max((cz + dz + gz0) * size, Math.min(z, (cz + dz + gz0 + 1) * size));
    inside = Math.hypot(x - bx, z - bz) <= MARGIN;
  }
  domain[j * W + i] = state === 2 ? 2 : inside ? 1 : 0;
}
function fillPolygon(rings: readonly Pt[][], target: Uint8Array) {
  let z0 = Infinity, z1 = -Infinity;
  for (const [, z] of rings[0]!) { z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  for (let j = Math.max(0, Math.ceil(z0 - Z0 - 0.5)); j <= Math.min(H - 1, Math.floor(z1 - Z0 - 0.5)); j++) {
    const zc = Z0 + j + 0.5, xs: number[] = [];
    for (const ring of rings) for (let k = 0, m = ring.length - 1; k < ring.length; m = k++) {
      const a = ring[m]!, b = ring[k]!;
      if ((a[1] > zc) !== (b[1] > zc)) xs.push(a[0] + (zc - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let i = Math.max(0, Math.ceil(xs[k]! - X0 - 0.5)); i <= Math.min(W - 1, Math.floor(xs[k + 1]! - X0 - 0.5)); i++) if (domain[j * W + i]) target[j * W + i] = 1;
    }
  }
}
const WATER = new Set(['Merivesi-alue', 'Lammikko', 'Koristeallas', 'Kahluuallas', 'Oja, ojanne', 'Vesileikki']);
const NOT_GROUND = new Set(['Rakennukset', 'Muu rakenne', 'Tukimuuri', 'Rantamuurit', 'Koristemuuri']);
let selectedParts = 0;
for (const part of parts) {
  if (part.bbox[2] < X0 || part.bbox[0] > X0 + W || part.bbox[3] < Z0 || part.bbox[1] > Z0 + H) continue;
  if (WATER.has(part.sub)) fillPolygon(part.rings, water);
  else if (!NOT_GROUND.has(part.sub) && !(part.main === 'Erityiskohteet' && part.sub !== 'Pihapiiri')) { fillPolygon(part.rings, want); selectedParts++; }
}
function paintBuffer(points: readonly Vec3[], radius: number) {
  for (let k = 0; k < points.length; k++) {
    const a = points[k]!, b = points[Math.min(points.length - 1, k + 1)]!;
    const i0 = Math.max(0, Math.floor(Math.min(a[0], b[0]) - radius - X0)), i1 = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0]) + radius - X0));
    const j0 = Math.max(0, Math.floor(Math.min(a[2], b[2]) - radius - Z0)), j1 = Math.min(H - 1, Math.ceil(Math.max(a[2], b[2]) + radius - Z0));
    const dx = b[0] - a[0], dz = b[2] - a[2], len2 = dx * dx + dz * dz;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      if (!domain[j * W + i]) continue;
      const x = X0 + i + 0.5, z = Z0 + j + 0.5, t = len2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[2]) * dz) / len2)) : 0;
      if (Math.hypot(x - a[0] - dx * t, z - a[2] - dz * t) <= radius) want[j * W + i] = 1;
    }
  }
}
// Curb-parked cars sit up to lane.width / 2 + 2.7 m from a lane; street-edge walkers at lane.width / 2 + 3.5 m.
for (const lane of graph.lanes) if (lane.points.some(p => p[0] >= X0 && p[0] <= X0 + W && p[2] >= Z0 && p[2] <= Z0 + H)) paintBuffer(lane.points, lane.width / 2 + 4.5);
for (const f of graph.footways) if (f.points.some(p => p[0] >= X0 && p[0] <= X0 + W && p[2] >= Z0 && p[2] <= Z0 + H)) paintBuffer(f.points, 2.5);
for (const p of parking) for (const q of p.points) paintBuffer([q], 3.5);
// Like the current mask, the new districts' private yards are walkable ground too, unless --public-only.
if (!values['public-only']) for (let k = 0; k < W * H; k++) if (domain[k] === 2) want[k] = 1;
const covered = new Uint8Array(W * H);
let probed = 0;
for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
  const k = j * W + i;
  if (!want[k] || water[k]) continue;
  probed++;
  const hits = probe.hits(X0 + i + 0.5, Z0 + j + 0.5);
  // Ground that nothing built stands on; holes (sea, unbuilt) have no walkable triangle.
  const top = hits.find(h => h.kind === WALK || h.kind === BLOCK);
  if (top && top.kind === WALK) covered[k] = 1;
}
log(`supported area raster ${W}x${H}: ${probed} probed pixels, ${covered.reduce((s, v) => s + v, 0)} covered; ${probe.loads} collision loads`);

/** 4-connected components of `value` pixels; returns labels (-1 elsewhere) and sizes. */
function components(grid: Uint8Array, value: number): { label: Int32Array; sizes: number[]; border: boolean[] } {
  const label = new Int32Array(W * H).fill(-1), sizes: number[] = [], border: boolean[] = [], stack: number[] = [];
  for (let s = 0; s < W * H; s++) {
    if (grid[s] !== value || label[s] !== -1) continue;
    const id = sizes.length;
    let size = 0, edge = false;
    label[s] = id; stack.push(s);
    while (stack.length) {
      const k = stack.pop()!, i = k % W, j = (k - i) / W;
      size++;
      if (i === 0 || j === 0 || i === W - 1 || j === H - 1) edge = true;
      for (const n of [i > 0 ? k - 1 : -1, i < W - 1 ? k + 1 : -1, j > 0 ? k - W : -1, j < H - 1 ? k + W : -1]) {
        if (n >= 0 && grid[n] === value && label[n] === -1) { label[n] = id; stack.push(n); }
      }
    }
    sizes.push(size); border.push(edge);
  }
  return { label, sizes, border };
}
// Pinches (two pixels touching only at a corner) would make rings touch; close them.
for (let changed = true; changed;) {
  changed = false;
  for (let j = 0; j + 1 < H; j++) for (let i = 0; i + 1 < W; i++) {
    const a = covered[j * W + i]!, b = covered[j * W + i + 1]!, c = covered[(j + 1) * W + i]!, d = covered[(j + 1) * W + i + 1]!;
    if (a === d && b === c && a !== b) { if (a) covered[j * W + i + 1] = 1; else covered[j * W + i] = 1; changed = true; }
  }
}
{
  const holes = components(covered, 0);
  for (let k = 0; k < W * H; k++) if (!covered[k] && !holes.border[holes.label[k]!] && holes.sizes[holes.label[k]!]! < 6) covered[k] = 1;
  const blobs = components(covered, 1);
  for (let k = 0; k < W * H; k++) if (covered[k] && blobs.sizes[blobs.label[k]!]! < 30) covered[k] = 0;
}
const blobs = components(covered, 1);

// Trace pixel boundaries: each edge keeps its pixel on the left; a corner has at most one outgoing edge (no pinches).
const corners = (W + 1) * (H + 1);
const nextCorner = new Int32Array(corners).fill(-1);
for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
  if (!covered[j * W + i]) continue;
  const c = (x: number, z: number) => z * (W + 1) + x;
  if (i === 0 || !covered[j * W + i - 1]) nextCorner[c(i, j)] = c(i, j + 1);
  if (j === H - 1 || !covered[(j + 1) * W + i]) nextCorner[c(i, j + 1)] = c(i + 1, j + 1);
  if (i === W - 1 || !covered[j * W + i + 1]) nextCorner[c(i + 1, j + 1)] = c(i + 1, j);
  if (j === 0 || !covered[(j - 1) * W + i]) nextCorner[c(i + 1, j)] = c(i, j);
}
interface TracedRing { label: number; outer: boolean; corners: Pt[]; mid: Pt[] }
const traced: TracedRing[] = [];
for (let start = 0; start < corners; start++) {
  if (nextCorner[start] === -1) continue;
  const cornerRing: Pt[] = [], mid: Pt[] = [];
  let k = start, label = -1, area2 = 0;
  do {
    const n = nextCorner[k]!;
    nextCorner[k] = -1;
    const ax = k % (W + 1), az = (k - ax) / (W + 1), bx = n % (W + 1), bz = (n - bx) / (W + 1);
    if (label < 0) {
      // The pixel on the left of a->b.
      const pi = bz > az ? ax : bz < az ? ax - 1 : bx > ax ? ax : ax - 1, pj = bz > az ? az : bz < az ? bz : bx > ax ? az - 1 : az;
      label = blobs.label[pj * W + pi]!;
    }
    cornerRing.push([X0 + ax, Z0 + az]); mid.push([X0 + (ax + bx) / 2, Z0 + (az + bz) / 2]);
    area2 += ax * bz - bx * az;
    k = n;
  } while (k !== start);
  traced.push({ label, outer: area2 < 0, corners: cornerRing, mid });
}

/** Douglas-Peucker on a closed ring. */
function simplifyClosed(ring: readonly Pt[], tolerance: number): Pt[] {
  const n = ring.length;
  if (tolerance <= 0 || n <= 4) return ring.filter((p, i) => {
    const a = ring[(i + n - 1) % n]!, b = ring[(i + 1) % n]!;
    return Math.abs((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])) > 1e-9;
  });
  let far = 0, farD = -1;
  for (let i = 1; i < n; i++) { const d = Math.hypot(ring[i]![0] - ring[0]![0], ring[i]![1] - ring[0]![1]); if (d > farD) { farD = d; far = i; } }
  const keep = new Uint8Array(n);
  keep[0] = 1; keep[far] = 1;
  const stack: [number, number][] = [[0, far], [far, n]];
  while (stack.length) {
    const [s, e] = stack.pop()!, a = ring[s]!, b = ring[e % n]!;
    const dx = b[0] - a[0], dz = b[1] - a[1], len2 = dx * dx + dz * dz;
    let worst = -1, worstD = tolerance;
    for (let i = s + 1; i < e; i++) {
      const p = ring[i]!, t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / len2)) : 0;
      const d = Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dz * t);
      if (d > worstD) { worstD = d; worst = i; }
    }
    if (worst >= 0) { keep[worst] = 1; stack.push([s, worst], [worst, e]); }
  }
  return ring.filter((_, i) => keep[i]);
}
const ringArea = (r: readonly Pt[]) => Math.abs(signedArea(r as Pt[]));
// Simplify every ring, then re-simplify any ring that now crosses or touches another (or itself) more finely.
const LEVELS = [0.75, 0.4, 0.2, 0, -1];
const level = traced.map(() => 0);
const shapes = traced.map(r => simplifyClosed(r.mid, LEVELS[0]!));
for (let round = 0; ; round++) {
  const segments: { r: number; i: number; a: Pt; b: Pt }[] = [];
  const grid = new Map<string, number[]>();
  shapes.forEach((ring, r) => ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length]!, s = segments.length;
    segments.push({ r, i, a, b });
    for (let gx = Math.floor(Math.min(a[0], b[0]) / 8); gx <= Math.floor(Math.max(a[0], b[0]) / 8); gx++)
      for (let gz = Math.floor(Math.min(a[1], b[1]) / 8); gz <= Math.floor(Math.max(a[1], b[1]) / 8); gz++) {
        const key = `${gx},${gz}`; (grid.get(key) ?? grid.set(key, []).get(key)!).push(s);
      }
  }));
  const orient = (p: Pt, q: Pt, r: Pt) => { const v = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]); return Math.abs(v) < 1e-9 ? 0 : Math.sign(v); };
  const onSeg = (p: Pt, q: Pt, r: Pt) => r[0] >= Math.min(p[0], q[0]) - 1e-9 && r[0] <= Math.max(p[0], q[0]) + 1e-9 && r[1] >= Math.min(p[1], q[1]) - 1e-9 && r[1] <= Math.max(p[1], q[1]) + 1e-9;
  const meet = (a: Pt, b: Pt, c: Pt, d: Pt) => {
    const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
    if (o1 * o2 < 0 && o3 * o4 < 0) return true;
    return (o1 === 0 && onSeg(a, b, c)) || (o2 === 0 && onSeg(a, b, d)) || (o3 === 0 && onSeg(c, d, a)) || (o4 === 0 && onSeg(c, d, b));
  };
  const bad = new Set<number>();
  for (const list of grid.values()) for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
    const s = segments[list[x]!]!, t = segments[list[y]!]!;
    if (s.r === t.r) { const n = shapes[s.r]!.length, gap = Math.abs(s.i - t.i); if (gap <= 1 || gap === n - 1) continue; }
    if (bad.has(s.r) && bad.has(t.r)) continue;
    if (meet(s.a, s.b, t.a, t.b)) { bad.add(s.r); bad.add(t.r); }
  }
  shapes.forEach((ring, r) => { if (ring.length < 3 || ringArea(ring) < 1e-6) bad.add(r); });
  if (!bad.size) break;
  for (const r of bad) {
    if (level[r]! >= LEVELS.length - 1) throw new Error(`Traced ring ${r} stays invalid after full refinement`);
    level[r]!++;
    const t = LEVELS[level[r]!]!;
    shapes[r] = t < 0 ? simplifyClosed(traced[r]!.corners, 0) : simplifyClosed(traced[r]!.mid, t);
  }
  if (round > 10) throw new Error('Ring refinement did not converge');
}
const polygonsByLabel = new Map<number, { outer: Pt[] | null; holes: Pt[][] }>();
traced.forEach((ring, r) => {
  const entry = polygonsByLabel.get(ring.label) ?? { outer: null, holes: [] };
  if (ring.outer) entry.outer = shapes[r]!; else if (ringArea(shapes[r]!) >= 1) entry.holes.push(shapes[r]!);
  polygonsByLabel.set(ring.label, entry);
});
const added: polygonClipping.MultiPolygon = [];
for (const { outer, holes } of polygonsByLabel.values()) if (outer && ringArea(outer) >= 30) added.push([outer, ...holes].map(r => r.map(([x, z]) => [x, z] as [number, number])));
const current = gameplay.supportedArea!;
const currentPolygons: polygonClipping.MultiPolygon = current.regions.map(r => [r.outer, ...r.holes ?? []].map(ring => ring.map(([x, z]) => [x, z] as [number, number])));
const union = polygonClipping.union(currentPolygons, added);
const polygonArea = (p: polygonClipping.Polygon) => p.reduce((s, ring, i) => s + (i ? -1 : 1) * ringArea(ring.slice(0, -1) as Pt[]), 0);
const lost = polygonClipping.difference(currentPolygons, union);
if (lost.some(p => polygonArea(p) > 1e-6)) throw new Error('The extended mask no longer covers the current supported area');
// The union covers each current region whole, so the largest union polygon around a region's box carries it.
const boxOf = (ring: readonly (readonly number[])[]) => ring.reduce((b, p) => [Math.min(b[0]!, p[0]!), Math.min(b[1]!, p[1]!), Math.max(b[2]!, p[0]!), Math.max(b[3]!, p[1]!)], [Infinity, Infinity, -Infinity, -Infinity]);
const carriers = new Set(current.regions.map(r => {
  const rb = boxOf(r.outer);
  return union.map(p => ({ p, b: boxOf(p[0]!), a: polygonArea(p) })).filter(({ b }) => b[0]! <= rb[0]! && b[1]! <= rb[1]! && b[2]! >= rb[2]! && b[3]! >= rb[3]!).sort((x, y) => y.a - x.a)[0]?.p;
}));
const ordered = union.map(p => ({ p, area: polygonArea(p), keepsCurrent: carriers.has(p) }))
  .sort((a, b) => Number(b.keepsCurrent) - Number(a.keepsCurrent) || b.area - a.area);
const kept = ordered.slice(0, 128);
const droppedArea = ordered.slice(128).reduce((s, o) => s + o.area, 0);
let named = 0;
const supportedArea: SupportedArea = { schemaVersion: 1, regions: kept.map(({ p, keepsCurrent }) => {
  const rings = p.map(ring => ring.slice(0, -1).map(([x, z]) => [x, z] as [number, number]));
  const id = keepsCurrent && named < current.regions.length ? current.regions[named++]!.id : `district-navigation-${named++}`;
  return { id, outer: rings[0]!, ...(rings.length > 1 ? { holes: rings.slice(1) } : {}) };
}) };
const nextGameplay: GameplayBundle = { ...gameplay, supportedArea };
const saProblems = validateSupportedArea(supportedArea, nextGameplay.playArea), gameplayProblems = validateGameplayBundle(nextGameplay);
const vertices = supportedArea.regions.reduce((s, r) => s + r.outer.length + (r.holes ?? []).reduce((t, h) => t + h.length, 0), 0);
log(`supported area: ${supportedArea.regions.length} regions, ${vertices} vertices, ${supportedArea.regions.reduce((s, r) => s + (r.holes?.length ?? 0), 0)} holes; dropped ${droppedArea.toFixed(0)} m2 beyond 128 regions`);
if (saProblems.length || gameplayProblems.length) throw new Error(`Gameplay invalid: ${[...saProblems, ...gameplayProblems].join('; ')}`);

// ---- release: new roads and gameplay files, everything else linked ----
let roadsBytes: Uint8Array, roadsFormat = 'packed';
try { roadsBytes = encodePackedRoadGraph(graph); }
catch (error) {
  // The packed transport caps at 8 MB; the loader also reads the schema-2 JSON form.
  roadsFormat = `json (${(error as Error).message})`;
  roadsBytes = Buffer.from(JSON.stringify(graph, (_k, v) => typeof v === 'number' ? Math.round(v * 1000) / 1000 : v));
}
const roundTrip = decodeRoadGraph(roadsBytes);
if (roundTrip.lanes.length !== graph.lanes.length || roundTrip.connectors.length !== graph.connectors.length || validateRoadGraph(roundTrip).length) throw new Error('Road payload does not round-trip');
const roadsStored = gzipSync(roadsBytes, { level: 9 });
const roadsSha = sha256(roadsStored);
const roadsRef = { path: `roads.gzip9.${roadsSha}.bin.gz`, bytes: roadsStored.length, sha256: roadsSha, compression: 'gzip' as const, decodedBytes: roadsBytes.length, decodedSha256: sha256(roadsBytes) };
const gameplayBytes = Buffer.from(JSON.stringify(nextGameplay) + (gameplayText.endsWith('\n') ? '\n' : ''));
const gameplaySha = sha256(gameplayBytes);
const gameplayRef = { path: `gameplay.navigation.${gameplaySha.slice(0, 16)}.json`, bytes: gameplayBytes.length, sha256: gameplaySha };
const next = { ...manifest, worldReleaseId: values.release!, roads: roadsRef, gameplay: gameplayRef } as WorldManifest;
const manifestProblems = validateWorldManifest(next);
if (manifestProblems.length) throw new Error(manifestProblems.join('; '));
const replaced = new Set(['manifest.json', manifest.roads.path, manifest.gameplay.path]);
let linked = 0, copied = 0;
fs.mkdirSync(outDir, { recursive: true });
function mirror(relative: string) {
  for (const entry of fs.readdirSync(path.join(worldDir, relative), { withFileTypes: true })) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { fs.mkdirSync(path.join(outDir, rel)); mirror(rel); continue; }
    if (!entry.isFile() || replaced.has(rel)) continue;
    const source = path.join(worldDir, rel), target = path.join(outDir, rel);
    try { fs.linkSync(source, target); linked++; }
    catch { fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); copied++; }
    if (fs.statSync(target).size !== fs.statSync(source).size) throw new Error(`${rel} changed while linking`);
  }
}
mirror('');
fs.writeFileSync(path.join(outDir, roadsRef.path), roadsStored, { flag: 'wx' });
fs.writeFileSync(path.join(outDir, gameplayRef.path), gameplayBytes, { flag: 'wx' });
const nextManifestBytes = Buffer.from(JSON.stringify(next, null, 1) + (manifestBytes.toString('utf8').endsWith('\n') ? '\n' : ''));
fs.writeFileSync(path.join(outDir, 'manifest.json'), nextManifestBytes, { flag: 'wx' });

// ---- report ----
const inNewCells = (pts: readonly Vec3[]) => pts.some(p => isNew(p[0], p[2]));
Object.assign(report, {
  release: values.release, manifestSha256: sha256(nextManifestBytes), sourceManifestSha256: sha256(manifestBytes),
  roads: { ...roadsRef, format: roadsFormat }, gameplay: gameplayRef,
  added: { nodes: nodes.length - roads.nodes.length, lanes: lanesOut.length, connectors: connectors.length, footways: footways.length,
    parkingAreas: parking.length, parkingSlots: parking.reduce((s, p) => s + p.points.length, 0),
    laneMetres: Math.round(lanesOut.reduce((s, l) => s + l.length, 0)), footwayMetres: Math.round(footways.reduce((s, f) => s + polylineLength(f.points), 0)) },
  changedNodeKinds: changedKinds, representedPieces, representedNearby, dropped, droppedPieces,
  prunedPieces: [...prunedPieces].map(([id, reason]) => { const p = pieceById.get(id)!; return { piece: id, name: p.way.tags['name'] ?? null, highway: p.way.tags['highway'], reason, at: p.base[0]!.map(round3) }; }),
  totals: { nodes: graph.nodes.length, lanes: graph.lanes.length, connectors: graph.connectors.length, parking: graph.parking.length, footways: graph.footways.length,
    points: graph.nodes.length + (['lanes', 'connectors', 'parking', 'footways'] as const).reduce((s, k) => s + graph[k].reduce((t, r) => t + r.points.length, 0), 0) },
  newCells: { cells: newCells.size, withLanes: new Set(graph.lanes.flatMap(l => l.points.filter(p => isNew(p[0], p[2])).map(p => cellOf(p[0], p[2])))).size,
    lanesTouching: graph.lanes.filter(l => inNewCells(l.points)).length },
  supportedArea: { regions: supportedArea.regions.length, vertices, raster: { x0: X0, z0: Z0, width: W, height: H, probed, selectedParts }, droppedAreaBeyondRegionCap: droppedArea },
  files: { linked, copied }, collisionLoads: probe.loads, seconds: (Date.now() - started) / 1000,
});
fs.writeFileSync(`${outDir}.report.json`, JSON.stringify(report, null, 1) + '\n');
log(`wrote ${outDir}: manifest ${report.manifestSha256}; ${linked} linked, ${copied} copied`);
console.log(JSON.stringify({ added: report.added, dropped, roads: roadsFormat, supportedArea: report.supportedArea }));
