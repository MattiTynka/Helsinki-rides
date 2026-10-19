// A bridge deck may cross an OSM bank line at its land endpoint. Only that
// source-topology bank is an abutment: neither the deck outline nor its span is.
import polygonClipping from 'polygon-clipping';
import { geodeticToGk25 } from '../../../packages/world-schema/src/index.ts';
import { bbox, pointInPolygon, ringDistance, segmentDistance, type LocalPolygon, type Pt } from './geometry.ts';
import type { CoastalOsm } from './coastal-mask.ts';
import type { ShoreAuthoritySegment, ShoreBridgeEndBank, ShoreSealOptions } from './coastal-shore-seals.ts';

export interface SourceBridgeAxis { way: number; nodes: number[]; points: [number, number][] }
export interface BridgeBankRejection { way: number; endpointNode: number; deckPart?: string; reason: string }
type Geometry = [number, number][][][];
type Interval = { lo: number; hi: number };
const EPS = .001, ADJACENCY_EPS = .002;
const ordinary = (p: LocalPolygon) => ['Ajorata', 'Kevyt liikenne', 'Muu rakenneosa'].includes(String(p.properties['paatyyppi'])) && !['Portaat', 'Tukimuuri'].includes(String(p.properties['alatyyppi']));
const runtime = (p: Pt): Pt => [p[0], -p[1]];
const working = (p: Pt): Pt => [p[0], -p[1]];
const boundaryDistance = (p: Pt, polygon: LocalPolygon) => Math.min(...polygon.rings.map(r => ringDistance(p, r)));
const containsClosed = (p: Pt, polygon: LocalPolygon) => pointInPolygon(p, polygon.rings) || boundaryDistance(p, polygon) <= EPS;
const cross = (a: Pt, b: Pt) => a[0] * b[1] - a[1] * b[0];
const at = (s: ShoreAuthoritySegment, t: number): Pt => [s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t];
const geometry = (p: readonly LocalPolygon[]): Geometry => p.map(q => q.rings.map(r => r.map(v => [...v] as Pt)));

/** Complete explicit above-water highway axes only; original node order is kept. */
export function sourceBridgeAxes(osm: CoastalOsm, origin: readonly number[]) {
  const selected = osm.elements.filter(w => w.type === 'way' && w.tags?.['bridge'] && w.tags['bridge'] !== 'no' && w.tags['highway'] && !['proposed', 'construction', 'corridor'].includes(w.tags['highway']) && w.tags['indoor'] !== 'yes' && (!w.tags['tunnel'] || w.tags['tunnel'] === 'no'));
  const ids = new Set(selected.flatMap(w => w.nodes ?? [])), nodes = new Map<number, Pt>();
  for (const n of osm.elements) if (n.type === 'node' && ids.has(n.id) && n.lat !== undefined && n.lon !== undefined) { const p = geodeticToGk25(n.lat, n.lon); nodes.set(n.id, [p[0] - origin[0]!, -(p[1] - origin[1]!)]); }
  const axes: SourceBridgeAxis[] = [], rejected: { way: number; reason: string }[] = [];
  for (const w of selected) { if (!w.nodes || w.nodes.length < 2 || w.nodes.some(n => !nodes.has(n))) { rejected.push({ way: w.id, reason: 'incomplete-bridge-axis' }); continue; } axes.push({ way: w.id, nodes: [...w.nodes], points: w.nodes.map(n => nodes.get(n)!) }); }
  return { axes, rejected };
}

/** Exact positive segment/footprint intersection stations; holes remain holes. */
export function bridgeBankPolygonIntervals(s: ShoreAuthoritySegment, polygon: LocalPolygon): Interval[] {
  const d: Pt = [s.b[0] - s.a[0], s.b[1] - s.a[1]], cuts = [0, 1];
  for (const ring of polygon.rings) for (let i = 0; i < ring.length; i++) {
    const a = runtime(ring[i]!), b = runtime(ring[(i + 1) % ring.length]!), e: Pt = [b[0] - a[0], b[1] - a[1]], q: Pt = [a[0] - s.a[0], a[1] - s.a[1]], den = cross(d, e);
    if (Math.abs(den) < 1e-12) continue; const t = cross(q, e) / den, u = cross(q, d) / den; if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t);
  }
  cuts.sort((a, b) => a - b); return cuts.slice(0, -1).flatMap((lo, i) => { const hi = cuts[i + 1]!; return hi > lo && pointInPolygon(working(at(s, (lo + hi) / 2)), polygon.rings) ? [{ lo, hi }] : []; });
}

/** Positive shared source boundary, not a buffered corridor or nearest neighbour. */
function sharedBoundaries(a: LocalPolygon, b: LocalPolygon): [Pt, Pt][] {
  const result: [Pt, Pt][] = [];
  for (const ar of a.rings) for (let i = 0; i < ar.length; i++) {
    const A = ar[i]!, B = ar[(i + 1) % ar.length]!, dx = B[0] - A[0], dy = B[1] - A[1], length = Math.hypot(dx, dy); if (length < EPS) continue;
    const station = (p: Pt) => ((p[0] - A[0]) * dx + (p[1] - A[1]) * dy) / (length * length), off = (p: Pt) => Math.abs((p[0] - A[0]) * dy - (p[1] - A[1]) * dx) / length;
    for (const br of b.rings) for (let j = 0; j < br.length; j++) {
      const C = br[j]!, D = br[(j + 1) % br.length]!; if (off(C) > ADJACENCY_EPS || off(D) > ADJACENCY_EPS) continue;
      const lo = Math.max(0, Math.min(station(C), station(D))), hi = Math.min(1, Math.max(station(C), station(D))); if ((hi - lo) * length < EPS) continue;
      result.push([[A[0] + dx * lo, A[1] + dy * lo], [A[0] + dx * hi, A[1] + dy * hi]]);
    }
  }
  return result;
}

function protectedBank(s: ShoreAuthoritySegment, interval: Interval, options: ShoreSealOptions) {
  const area = options.protectedArea; if (!area) return false; const m = options.protectedMarginMetres ?? 0, A = at(s, interval.lo), B = at(s, interval.hi); let lo = 0, hi = 1;
  for (const [a, d, min, max] of [[A[0], B[0] - A[0], area.minX - m, area.maxX + m], [A[1], B[1] - A[1], area.minZ - m, area.maxZ + m]]) { if (Math.abs(d!) < 1e-12) { if (a! < min! || a! > max!) return false; } else { let x = (min! - a!) / d!, y = (max! - a!) / d!; if (x > y) [x, y] = [y, x]; lo = Math.max(lo, x); hi = Math.min(hi, y); } } return hi >= lo;
}

/** Qualify connected canonical bank fragments inside exact city bridge parts.
 * The endpoint enters source water; its opposite side is source land. A dry
 * component of the SAME source deck must share a positive source boundary with
 * ordinary dry street land. This excludes piers, midspan and deck side outlines.
 */
export function deriveBridgeEndBanks(axes: readonly SourceBridgeAxis[], parts: readonly LocalPolygon[], shores: readonly ShoreAuthoritySegment[], water: readonly LocalPolygon[], options: ShoreSealOptions = {}) {
  const decks = parts.filter(p => p.properties['paatyyppi'] === 'Silta'), ordinaryParts = parts.filter(ordinary), wet = (p: Pt) => water.some(w => pointInPolygon(working(p), w.rings)), rejected: BridgeBankRejection[] = [], candidates: ShoreBridgeEndBank[] = [];
  const cache = new Map<string, { intervals: { shore: ShoreAuthoritySegment; lo: number; hi: number }[]; dry: { polygon: LocalPolygon; neighbours: { id: string; shared: [Pt, Pt] }[] }[] }>();
  function deckData(deck: LocalPolygon) {
    let result = cache.get(deck.id); if (result) return result;
    const intervals = shores.flatMap(shore => bridgeBankPolygonIntervals(shore, deck).map(v => ({ shore, ...v }))), dryGeometry = polygonClipping.difference([deck.rings] as Geometry, geometry(water)) as Geometry;
    const dry = dryGeometry.map((rings, i) => ({ polygon: { id: `${deck.id}:source-dry:${i}`, rings, bbox: bbox(rings), properties: {} } as LocalPolygon, neighbours: [] as { id: string; shared: [Pt, Pt] }[] }));
    const name = String(deck.properties['alueen_nimi'] ?? '').trim().normalize('NFC');
    for (const p of ordinaryParts) {
      if (name && String(p.properties['alueen_nimi'] ?? '').trim().normalize('NFC') !== name) continue;
      if (p.bbox[0] > deck.bbox[2] + ADJACENCY_EPS || p.bbox[2] < deck.bbox[0] - ADJACENCY_EPS || p.bbox[1] > deck.bbox[3] + ADJACENCY_EPS || p.bbox[3] < deck.bbox[1] - ADJACENCY_EPS) continue;
      for (const shared of sharedBoundaries(deck, p)) { const midpoint: Pt = [(shared[0][0] + shared[1][0]) / 2, (shared[0][1] + shared[1][1]) / 2]; if (wet(runtime(midpoint))) continue;
        // A coincident polygon outline alone is insufficient: duplicated or
        // overlapping survey footprints are not an opposite-side land join.
        const dx = shared[1][0] - shared[0][0], dy = shared[1][1] - shared[0][1], length = Math.hypot(dx, dy), probe = .0001;
        const left: Pt = [midpoint[0] - dy / length * probe, midpoint[1] + dx / length * probe], right: Pt = [midpoint[0] + dy / length * probe, midpoint[1] - dx / length * probe];
        const joined = (a: Pt, b: Pt) => pointInPolygon(a, deck.rings) && !pointInPolygon(a, p.rings) && pointInPolygon(b, p.rings) && !pointInPolygon(b, deck.rings) && !wet(runtime(a)) && !wet(runtime(b));
        if (!joined(left, right) && !joined(right, left)) continue;
        for (const component of dry) if (boundaryDistance(midpoint, component.polygon) <= ADJACENCY_EPS) component.neighbours.push({ id: p.id, shared });
      }
    }
    result = { intervals, dry }; cache.set(deck.id, result); return result;
  }
  for (const axis of axes) for (const end of [0, axis.points.length - 1]) {
    const endpoint = axis.points[end]!, endpointNode = axis.nodes[end]!, inside = axis.points[end === 0 ? 1 : end - 1]!, dx = inside[0] - endpoint[0], dz = inside[1] - endpoint[1], length = Math.hypot(dx, dz);
    const reject = (reason: string, deckPart?: string) => rejected.push({ way: axis.way, endpointNode, deckPart, reason });
    if (length < EPS) { reject('degenerate-axis-end'); continue; }
    const touching = shores.filter(s => segmentDistance(endpoint, s.a, s.b).d <= EPS);
    if (!touching.length) { reject('endpoint-not-canonical-shore'); continue; }
    const step = Math.min(.01, length / 2), toward: Pt = [endpoint[0] + dx / length * step, endpoint[1] + dz / length * step], away: Pt = [endpoint[0] - dx / length * step, endpoint[1] - dz / length * step];
    if (!wet(toward) || wet(away)) { reject('endpoint-not-water-to-land'); continue; }
    const matched = decks.filter(d => containsClosed(working(endpoint), d) && bridgeBankPolygonIntervals({ id: 'axis-proof', a: endpoint, b: inside }, d).some(v => (v.hi - v.lo) * length > EPS));
    if (!matched.length) { reject('endpoint-no-exact-silta-axis-footprint'); continue; }
    for (const deck of matched) {
      const data = deckData(deck), component = new Set<number>(), queue = data.intervals.flatMap((v, i) => segmentDistance(endpoint, at(v.shore, v.lo), at(v.shore, v.hi)).d <= EPS ? [i] : []);
      while (queue.length) { const i = queue.pop()!; if (component.has(i)) continue; component.add(i); const v = data.intervals[i]!, A = at(v.shore, v.lo), B = at(v.shore, v.hi);
        for (let j = 0; j < data.intervals.length; j++) if (!component.has(j)) { const q = data.intervals[j]!, C = at(q.shore, q.lo), D = at(q.shore, q.hi); if ([A, B].some(a => [C, D].some(b => Math.hypot(a[0] - b[0], a[1] - b[1]) <= EPS))) queue.push(j); }
      }
      if (!component.size) { reject('endpoint-no-positive-bank-interval', deck.id); continue; }
      for (const i of component) {
        const v = data.intervals[i]!, L = Math.hypot(v.shore.b[0] - v.shore.a[0], v.shore.b[1] - v.shore.a[1]), midpoint = at(v.shore, (v.lo + v.hi) / 2), side = v.shore.drySide ?? 1, probe: Pt = [midpoint[0] - (v.shore.b[1] - v.shore.a[1]) / L * .0001 * side, midpoint[1] + (v.shore.b[0] - v.shore.a[0]) / L * .0001 * side];
        if ((v.hi - v.lo) * L < EPS) continue;
        if (protectedBank(v.shore, v, options)) { reject('accepted-protected-margin', deck.id); continue; }
        const dry = data.dry.filter(d => pointInPolygon(working(probe), d.polygon.rings) && d.neighbours.length);
        if (dry.length !== 1) { reject('bank-no-unambiguous-adjacent-dry-component', deck.id); continue; }
        const neighbours = dry[0]!.neighbours;
        candidates.push({ id: '', shoreSegment: v.shore.id, lo: v.lo, hi: v.hi, bridgeWays: [axis.way], endpointNodes: [endpointNode], deckPartIds: [deck.id], dryPartIds: [...new Set(neighbours.map(n => n.id))].sort(), proofs: [{ way: axis.way, endpointNode, endpoint, deckPart: deck.id, dryComponent: dry[0]!.polygon, dryAdjacency: neighbours, endpointShoreDistanceMetres: Math.min(...touching.map(s => segmentDistance(endpoint, s.a, s.b).d)), axisTowardWater: toward, axisAwayOnLand: away }] });
      }
    }
  }
  // Partition coincident source matches before qualification. Shared source
  // endpoints/footways never generate overlapping added bank veneers.
  const banks: ShoreBridgeEndBank[] = [];
  for (const shore of shores) { const list = candidates.filter(c => c.shoreSegment === shore.id), cuts = [...new Set(list.flatMap(v => [v.lo, v.hi]))].sort((a, b) => a - b), L = Math.hypot(shore.b[0] - shore.a[0], shore.b[1] - shore.a[1]);
    for (let i = 0; i + 1 < cuts.length; i++) { const lo = cuts[i]!, hi = cuts[i + 1]!, mid = (lo + hi) / 2, active = list.filter(v => mid > v.lo && mid < v.hi); if (!active.length || (hi - lo) * L < EPS) continue;
      const combine = <T extends string | number>(values: T[]) => [...new Set(values)].sort();
      banks.push({ id: `bridge-bank:${banks.length}`, shoreSegment: shore.id, lo, hi, bridgeWays: combine(active.flatMap(a => a.bridgeWays)), endpointNodes: combine(active.flatMap(a => a.endpointNodes)), deckPartIds: combine(active.flatMap(a => a.deckPartIds)), dryPartIds: combine(active.flatMap(a => a.dryPartIds)), proofs: active.flatMap(a => a.proofs) });
    }
  }
  return { banks, rejected, stats: { explicitBridgeAxes: axes.length, axisEndpoints: axes.length * 2, exactMatchedDecks: cache.size, bankIntervals: banks.length, bankLengthMetres: banks.reduce((n, b) => { const s = shores.find(s => s.id === b.shoreSegment)!; return n + (b.hi - b.lo) * Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]); }, 0), rejectedEndpointsOrIntervals: rejected.length }, tolerances: { endpointShoreMetres: EPS, exactSourceAdjacencyMetres: ADJACENCY_EPS, sourceTopologyProbeMetres: .01, sourceDrySideInteriorProbeMetres: .0001, ordinaryStreetOppositeInteriorRequired: true, emittedFootprintBufferMetres: 0 } };
}
