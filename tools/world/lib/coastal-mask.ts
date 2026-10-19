// Offline coastline masking. OSM coastlines keep land on their left; the directed
// chains are closed along the clipping rectangle, never across a missing inland
// endpoint. Geometry is in the project's double-precision ENU working frame.
import earcut from 'earcut';
import polygonClipping from 'polygon-clipping';
import { cellId, cellIndexFor, geodeticToGk25, type TerrainGrid } from '../../../packages/world-schema/src/index.ts';
import { bbox, cleanRing, ensureCcw, pointInPolygon, ringDistance, signedArea, type LocalPolygon, type Pt, type Ring } from './geometry.ts';
import { lowerTerrainUnderWaterRaster } from './coastal-raster.ts';
import type { GroundPiece } from './ground.ts';

type Geometry = [number, number][][][];
export interface CoastalArea { minX: number; maxX: number; minZ: number; maxZ: number }
export interface CoastalOsmElement {
  type: string; id: number; lat?: number; lon?: number; nodes?: number[];
  tags?: Record<string, string>; members?: { type: string; ref: number; role?: string }[];
}
export interface CoastalOsm { elements: CoastalOsmElement[] }
export interface CoastalMask {
  readonly water: LocalPolygon[];
  readonly area: CoastalArea;
  readonly sources: { coastlineWays: number[]; waterWays: number[]; waterRelations: number[] };
  readonly stats: { coastlineChains: number; openChains: number; landRings: number; waterArea: number };
}
export interface CoastalWaterPiece { cell: string; positions: number[]; indices: number[] }

const EPS = 1e-7;
const equal = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]) < EPS;
const geometry = (polys: readonly LocalPolygon[]): Geometry => polys.map(p => p.rings.map(r => r.map(p => [...p] as Pt)));
const geometryArea = (g: Geometry) => g.reduce((n, p) => n + Math.abs(signedArea(p[0]!)) - p.slice(1).reduce((n, r) => n + Math.abs(signedArea(r)), 0), 0);
const rectangle = (a: CoastalArea): Ring => [[a.minX, -a.maxZ], [a.maxX, -a.maxZ], [a.maxX, -a.minZ], [a.minX, -a.minZ]];
const polygons = (g: Geometry, prefix: string): LocalPolygon[] => g.filter(p => p.length && Math.abs(signedArea(p[0]!)) > EPS).map((p, i) => {
  const rings = p.map((r, k) => k ? cleanRing(r) : ensureCcw(cleanRing(r)));
  return { id: `${prefix}-${i}`, rings, bbox: bbox(rings), properties: { source: 'OpenStreetMap coastline/water' } };
});
const intersectsBoxes = (a: readonly number[], b: readonly number[]) => a[0]! < b[2]! && a[2]! > b[0]! && a[1]! < b[3]! && a[3]! > b[1]!;

function localNodes(osm: CoastalOsm, origin: readonly number[]): Map<number, Pt> {
  const nodes = new Map<number, Pt>();
  for (const e of osm.elements) if (e.type === 'node' && e.lat !== undefined && e.lon !== undefined) {
    const [x, y] = geodeticToGk25(e.lat, e.lon);
    nodes.set(e.id, [x - origin[0]!, y - origin[1]!]);
  }
  return nodes;
}

/** Only exported separately to test coastline topology without projection noise. */
export function coastlinesToWater(chains: readonly Ring[], area: CoastalArea): { water: LocalPolygon[]; openChains: number; landRings: number } {
  const rect = rectangle(area), box = bbox([rect]);
  const width = area.maxX - area.minX, height = area.maxZ - area.minZ, perimeter = 2 * (width + height);
  if (!(width > 0 && height > 0)) throw new Error('invalid coastal clipping area');
  const boundaryParameter = (p: Pt): number => {
    if (Math.abs(p[1] - box[1]) < EPS) return p[0] - box[0];
    if (Math.abs(p[0] - box[2]) < EPS) return width + p[1] - box[1];
    if (Math.abs(p[1] - box[3]) < EPS) return width + height + box[2] - p[0];
    if (Math.abs(p[0] - box[0]) < EPS) return (2 * width + height + box[3] - p[1]) % perimeter;
    throw new Error(`incomplete coastline ends inside playable area at ${p.join(',')}; acquire missing adjoining ways`);
  };
  const clipSegment = (a: Pt, b: Pt): [Pt, Pt] | null => {
    let t0 = 0, t1 = 1;
    const d: Pt = [b[0] - a[0], b[1] - a[1]];
    for (const [p, q] of [[-d[0], a[0] - box[0]], [d[0], box[2] - a[0]], [-d[1], a[1] - box[1]], [d[1], box[3] - a[1]]] as [number, number][]) {
      if (Math.abs(p) < 1e-12) { if (q < 0) return null; continue; }
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
      if (t0 > t1) return null;
    }
    if ((t1 - t0) * Math.hypot(...d) < EPS) return null;
    return [[a[0] + t0 * d[0], a[1] + t0 * d[1]], [a[0] + t1 * d[0], a[1] + t1 * d[1]]];
  };
  const open: Ring[] = [], closed: Ring[] = [];
  for (const chain of chains) {
    let current: Ring = [];
    const clipped: Ring[] = [];
    for (let i = 0; i + 1 < chain.length; i++) {
      const seg = clipSegment(chain[i]!, chain[i + 1]!);
      if (!seg) { if (current.length > 1) clipped.push(current); current = []; continue; }
      if (current.length && !equal(current.at(-1)!, seg[0])) { clipped.push(current); current = []; }
      if (!current.length) current.push(seg[0]);
      current.push(seg[1]);
    }
    if (current.length > 1) clipped.push(current);
    // A closed source ring can start inside the rectangle and leave/re-enter it.
    if (clipped.length > 1 && equal(clipped.at(-1)!.at(-1)!, clipped[0]![0]!)) {
      const last = clipped.pop()!;
      clipped[0] = [...last.slice(0, -1), ...clipped[0]!];
    }
    for (const part of clipped) {
      if (equal(part[0]!, part.at(-1)!)) closed.push(cleanRing(part));
      else { boundaryParameter(part[0]!); boundaryParameter(part.at(-1)!); open.push(part); }
    }
  }
  if (!open.length && !closed.length) throw new Error('no complete coastline intersects playable area; cannot infer land/water');
  const events = open.flatMap((p, i) => [{ t: boundaryParameter(p[0]!), kind: 'entry', i }, { t: boundaryParameter(p.at(-1)!), kind: 'exit', i }]).sort((a, b) => a.t - b.t);
  const next = new Map<number, { i: number; arc: Ring }>();
  for (let k = 0; k < events.length; k++) {
    const e = events[k]!;
    if (e.kind !== 'exit') continue;
    const target = events[(k + 1) % events.length]!;
    if (target.kind !== 'entry') throw new Error('coastline clipping boundary does not alternate exit/entry; missing or wrongly directed source topology');
    let end = target.t; if (end <= e.t + EPS) end += perimeter;
    const arc: Ring = [];
    for (const [t, p] of [[0, rect[0]], [width, rect[1]], [width + height, rect[2]], [2 * width + height, rect[3]], [perimeter, rect[0]], [perimeter + width, rect[1]], [perimeter + width + height, rect[2]], [perimeter + 2 * width + height, rect[3]]] as [number, Pt][]) if (t > e.t + EPS && t < end - EPS) arc.push(p);
    next.set(e.i, { i: target.i, arc });
  }
  const land: Ring[] = [], visited = new Set<number>();
  for (let start = 0; start < open.length; start++) {
    if (visited.has(start)) continue;
    const ring: Ring = []; let i = start;
    do {
      if (visited.has(i)) throw new Error('coastline boundary stitch reached another ring');
      visited.add(i); ring.push(...open[i]!);
      const link = next.get(i); if (!link) throw new Error('coastline has no closing boundary arc');
      ring.push(...link.arc); i = link.i;
    } while (i !== start);
    land.push(ensureCcw(cleanRing(ring)));
  }
  const positive = closed.filter(r => signedArea(r) > 0), negative = closed.filter(r => signedArea(r) < 0);
  const solids = [...land, ...positive];
  let dry: Geometry = solids.length ? polygonClipping.union([[solids[0]!]], ...solids.slice(1).map(r => [[r]])) as Geometry : [];
  if (negative.length && dry.length) dry = polygonClipping.difference(dry, ...negative.map(r => [[r]])) as Geometry;
  const water = polygons(polygonClipping.difference([[rect]], dry) as Geometry, 'coast-water');
  return { water, openChains: open.length, landRings: solids.length };
}

export function buildCoastalMask(osm: CoastalOsm, options: { area: CoastalArea; originProjected: readonly number[]; protectedDryArea?: CoastalArea }): CoastalMask {
  const nodes = localNodes(osm, options.originProjected), ways = osm.elements.filter(e => e.type === 'way'), byId = new Map(ways.map(e => [e.id, e]));
  const coasts = ways.filter(e => e.tags?.['natural'] === 'coastline');
  const starts = new Map<number, CoastalOsmElement>(), ends = new Map<number, CoastalOsmElement>();
  for (const way of coasts) {
    if (!way.nodes || way.nodes.length < 2 || way.nodes.some(n => !nodes.has(n))) throw new Error(`coastline way ${way.id} has missing nodes`);
    if (starts.has(way.nodes[0]!) || ends.has(way.nodes.at(-1)!)) throw new Error(`coastline has branching/wrongly directed endpoint at way ${way.id}`);
    starts.set(way.nodes[0]!, way); ends.set(way.nodes.at(-1)!, way);
  }
  const seen = new Set<number>(), chains: Ring[] = [];
  const consume = (first: CoastalOsmElement) => {
    const ids: number[] = []; let way: CoastalOsmElement | undefined = first;
    while (way && !seen.has(way.id)) {
      seen.add(way.id); ids.push(...(ids.length ? way.nodes!.slice(1) : way.nodes!));
      way = starts.get(way.nodes!.at(-1)!);
    }
    chains.push(ids.map(id => nodes.get(id)!));
  };
  for (const way of coasts) if (!ends.has(way.nodes![0]!)) consume(way);
  for (const way of coasts) if (!seen.has(way.id)) consume(way);
  const result = coastlinesToWater(chains, options.area);
  let water = geometry(result.water);
  const waterWays: number[] = [], waterRelations: number[] = [];
  const isWater = (tags?: Record<string, string>) => (tags?.['natural'] === 'water' || tags?.['waterway'] === 'riverbank') && tags?.['water'] !== 'basin' && tags?.['amenity'] !== 'fountain';
  const rect: Geometry = [[rectangle(options.area)]];
  for (const way of ways.filter(e => isWater(e.tags))) {
    if (!way.nodes || way.nodes[0] !== way.nodes.at(-1)) continue;
    if (way.nodes.some(id => !nodes.has(id))) throw new Error(`water way ${way.id} has missing nodes`);
    const ring = cleanRing(way.nodes.map(id => nodes.get(id)!));
    const clipped = polygonClipping.intersection([[ring]], rect) as Geometry;
    if (!clipped.length) continue;
    water = polygonClipping.union(water, clipped) as Geometry; waterWays.push(way.id);
  }
  for (const rel of osm.elements.filter(e => e.type === 'relation' && e.tags?.['type'] === 'multipolygon' && isWater(e.tags))) {
    const rings: { role: string; ids: number[] }[] = [];
    const members = (rel.members ?? []).filter(m => m.type === 'way');
    if (members.some(m => !byId.has(m.ref))) throw new Error(`water relation ${rel.id} has missing member ways; acquire relation/full`);
    const remaining = members.map(m => ({ role: m.role || 'outer', ids: [...byId.get(m.ref)!.nodes!] }));
    while (remaining.length) {
      const ring = remaining.shift()!;
      while (ring.ids[0] !== ring.ids.at(-1)) {
        const k = remaining.findIndex(m => m.role === ring.role && (m.ids[0] === ring.ids.at(-1) || m.ids.at(-1) === ring.ids.at(-1)));
        if (k < 0) throw new Error(`water relation ${rel.id} has an unclosed ${ring.role} ring`);
        const piece = remaining.splice(k, 1)[0]!;
        if (piece.ids[0] !== ring.ids.at(-1)) piece.ids.reverse();
        ring.ids.push(...piece.ids.slice(1));
      }
      rings.push(ring);
    }
    const outer: Ring[] = [], inner: Ring[] = [];
    for (const r of rings) {
      if (r.ids.some(id => !nodes.has(id))) throw new Error(`water relation ${rel.id} has missing member nodes`);
      (r.role === 'inner' ? inner : outer).push(cleanRing(r.ids.map(id => nodes.get(id)!)));
    }
    if (!outer.length) throw new Error(`water relation ${rel.id} has no outer ring`);
    let g = polygonClipping.union([[outer[0]!]], ...outer.slice(1).map(r => [[r]])) as Geometry;
    if (inner.length) g = polygonClipping.difference(g, ...inner.map(r => [[r]])) as Geometry;
    g = polygonClipping.intersection(g, rect) as Geometry;
    if (g.length) { water = polygonClipping.union(water, g) as Geometry; waterRelations.push(rel.id); }
  }
  if (options.protectedDryArea) {
    const overlap = polygonClipping.intersection(water, [[rectangle(options.protectedDryArea)]]) as Geometry;
    if (geometryArea(overlap) > 1e-5) throw new Error(`coastal mask overlaps ${geometryArea(overlap).toFixed(3)} m2 of protected accepted ground`);
  }
  return { water: polygons(water, 'water'), area: options.area, sources: { coastlineWays: coasts.map(w => w.id), waterWays, waterRelations }, stats: { coastlineChains: chains.length, openChains: result.openChains, landRings: result.landRings, waterArea: geometryArea(water) } };
}

/** Source-register polygons intersected by an explicit above-water highway bridge.
 * Their footprint is preserved exactly; no guessed corridor width becomes land. */
export function registeredBridgeDecks(osm: CoastalOsm, parts: readonly LocalPolygon[], originProjected: readonly number[]): { polygons: LocalPolygon[]; matches: { way: number; parts: string[] }[] } {
  const nodes = localNodes(osm, originProjected), selected = new Map<string, LocalPolygon>();
  const matches: { way: number; parts: string[] }[] = [];
  const surfaces = parts.filter(p => {
    const main = String(p.properties['paatyyppi'] ?? ''), sub = String(p.properties['alatyyppi'] ?? '');
    if (main === 'Silta') return ['Ajorata (Silta)', 'Ajorata, muu (Silta)', 'Kevyt liikenne (Silta)', 'Jalankulkualue (Silta)', 'Yhdistetty jk ja pp (Silta)', 'Erotettu jalkakäytävä (Silta)', 'Erotettu pyörätie (Silta)', 'Erotusalue (Silta)', 'Koroke (Silta)'].includes(sub);
    return ['Ajorata', 'Kevyt liikenne', 'Muu rakenneosa'].includes(main) && !['Portaat', 'Tukimuuri'].includes(sub);
  });
  for (const way of osm.elements) {
    const t = way.tags;
    if (way.type !== 'way' || !t?.['bridge'] || t['bridge'] === 'no' || !t['highway'] || ['proposed', 'construction', 'corridor'].includes(t['highway']) || t['indoor'] === 'yes' || (t['tunnel'] && t['tunnel'] !== 'no')) continue;
    const axis = (way.nodes ?? []).map(id => nodes.get(id)).filter((p): p is Pt => !!p);
    const hit = new Set<string>();
    for (let i = 0; i + 1 < axis.length; i++) {
      const a = axis[i]!, b = axis[i + 1]!, count = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])));
      for (const p of surfaces) {
        if (!intersectsBoxes(bbox([[a, b]]).map((v, k) => v + (k < 2 ? -EPS : EPS)), p.bbox)) continue;
        for (let j = 0; j <= count; j++) if (pointInPolygon([a[0] + (b[0] - a[0]) * j / count, a[1] + (b[1] - a[1]) * j / count], p.rings)) { hit.add(p.id); selected.set(p.id, p); break; }
      }
    }
    if (hit.size) matches.push({ way: way.id, parts: [...hit].sort() });
  }
  return { polygons: [...selected.values()], matches };
}

export interface SourceCoastalDecks {
  polygons: LocalPolygon[];
  /** Original axis-to-register matches, unchanged from registeredBridgeDecks. */
  matches: { way: number; parts: string[] }[];
  pierWays: number[];
  /** Additional ordinary source street parts proven to adjoin original bridge seeds. */
  bridgeEndPartIds: string[];
  /** Additional explicitly classified Silta deck parts, independent of OSM axis hits. */
  separateDeckPartIds: string[];
}

const surveyDeckClasses = new Set(['Ajorata (Silta)', 'Ajorata, muu (Silta)', 'Kevyt liikenne (Silta)', 'Jalankulkualue (Silta)', 'Yhdistetty jk ja pp (Silta)', 'Erotettu jalkakäytävä (Silta)', 'Erotettu pyörätie (Silta)', 'Erotusalue (Silta)', 'Koroke (Silta)']);
const bridgeEndClasses: Readonly<Record<string, readonly string[]>> = {
  Ajorata: ['Ajorata', 'Ajorata, muu', 'Koroke'],
  'Kevyt liikenne': ['Kevyt liikenne', 'Jalankulkualue', 'Yhdistetty jk ja pp', 'Erotettu jalkakäytävä', 'Erotettu pyörätie'],
  'Muu rakenneosa': ['Erotusalue', 'Koroke'],
};
const surveyBlockName = (p: LocalPolygon) => String(p.properties['alueen_nimi'] ?? '').trim().normalize('NFC');
const polygonArea = (p: LocalPolygon) => Math.abs(signedArea(p.rings[0]!)) - p.rings.slice(1).reduce((sum, r) => sum + Math.abs(signedArea(r)), 0);
const distanceToPolygon = (p: Pt, polygon: LocalPolygon) => pointInPolygon(p, polygon.rings) ? 0 : Math.min(...polygon.rings.map(r => ringDistance(p, r)));
function polygonBoundaryDistance(a: LocalPolygon, b: LocalPolygon): number {
  let distance = Infinity;
  for (const r of a.rings) for (const p of r) distance = Math.min(distance, distanceToPolygon(p, b));
  for (const r of b.rings) for (const p of r) distance = Math.min(distance, distanceToPolygon(p, a));
  return distance;
}
function nearOriginalDeckFootprints(polygon: LocalPolygon, seeds: readonly LocalPolygon[]): boolean {
  // This only bounds which complete source parts qualify. It never buffers the emitted land.
  for (const ring of polygon.rings) for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!, count = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])));
    for (let j = 0; j <= count; j++) {
      const point: Pt = [a[0] + (b[0] - a[0]) * j / count, a[1] + (b[1] - a[1]) * j / count];
      if (!seeds.some(seed => distanceToPolygon(point, seed) <= 3)) return false;
    }
  }
  return true;
}
function simplePierRing(ring: Ring): boolean {
  if (ring.length < 3 || ring.some(p => !p.every(Number.isFinite)) || Math.abs(signedArea(ring)) <= EPS) return false;
  const cross = (a: Pt, b: Pt, p: Pt) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  const between = (p: Pt, a: Pt, b: Pt) => Math.abs(cross(a, b, p)) <= EPS && p[0] >= Math.min(a[0], b[0]) - EPS && p[0] <= Math.max(a[0], b[0]) + EPS && p[1] >= Math.min(a[1], b[1]) - EPS && p[1] <= Math.max(a[1], b[1]) + EPS;
  for (let i = 0; i < ring.length; i++) for (let j = i + 1; j < ring.length; j++) {
    if (j === i + 1 || (i === 0 && j === ring.length - 1)) continue;
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!, c = ring[j]!, d = ring[(j + 1) % ring.length]!;
    if ((cross(a,b,c) * cross(a,b,d) < 0 && cross(c,d,a) * cross(c,d,b) < 0) || between(a,c,d) || between(b,c,d) || between(c,a,b) || between(d,a,b)) return false;
  }
  return true;
}

/** Exact source-backed above-water footprints. Pier rings and survey bridge decks
 * do not require an OSM highway axis. Ordinary approaches/medians require one-hop
 * source adjacency, a matching street block and a nearby actual bridge endpoint. */
export function sourceCoastalDecks(osm: CoastalOsm, parts: readonly LocalPolygon[], originProjected: readonly number[]): SourceCoastalDecks {
  const original = registeredBridgeDecks(osm, parts, originProjected), selected = new Map(original.polygons.map(p => [p.id, p]));
  const nodes = localNodes(osm, originProjected), separateDeckPartIds: string[] = [], bridgeEndPartIds: string[] = [], pierWays: number[] = [];
  for (const part of parts) if (part.properties['paatyyppi'] === 'Silta' && surveyDeckClasses.has(String(part.properties['alatyyppi'])) && polygonArea(part) > EPS) {
    if (!selected.has(part.id)) separateDeckPartIds.push(part.id);
    selected.set(part.id, part);
  }
  // Freeze seeds before adding companions. A newly selected part cannot grow the retained region.
  const seeds = [...selected.values()], seedWays = new Map<string, CoastalOsmElement[]>();
  const ways = new Map(osm.elements.filter(e => e.type === 'way').map(e => [e.id,e]));
  for (const match of original.matches) {
    const way = ways.get(match.way)!;
    if (!way.nodes || way.nodes.length < 2 || way.nodes.some(id => !nodes.has(id))) continue;
    for (const id of match.parts) seedWays.set(id, [...seedWays.get(id) ?? [], way]);
  }
  for (const part of parts) {
    if (selected.has(part.id) || part.properties['aluetieto'] !== 'Katu') continue;
    if (!bridgeEndClasses[String(part.properties['paatyyppi'])]?.includes(String(part.properties['alatyyppi']))) continue;
    const name = surveyBlockName(part), area = polygonArea(part);
    if (!name || area <= EPS || area > 200 || Math.hypot(part.bbox[2] - part.bbox[0], part.bbox[3] - part.bbox[1]) > 40) continue;
    const blockSeeds = seeds.filter(seed => surveyBlockName(seed) === name);
    if (!blockSeeds.length) continue;
    const adjacent = blockSeeds.filter(seed => !(
      part.bbox[0] > seed.bbox[2] + .002 || part.bbox[2] < seed.bbox[0] - .002 || part.bbox[1] > seed.bbox[3] + .002 || part.bbox[3] < seed.bbox[1] - .002
    ) && polygonBoundaryDistance(part, seed) <= .002);
    const atEndpoint = adjacent.some(seed => (seedWays.get(seed.id) ?? []).some(way => [way.nodes![0]!, way.nodes!.at(-1)!].some(id => distanceToPolygon(nodes.get(id)!, part) <= 8)));
    if (!atEndpoint || !nearOriginalDeckFootprints(part, blockSeeds)) continue;
    selected.set(part.id, part); bridgeEndPartIds.push(part.id);
  }
  for (const way of osm.elements) {
    if (way.type !== 'way' || way.tags?.['man_made'] !== 'pier' || way.tags['area'] === 'no') continue;
    const ids = way.nodes;
    if (!ids || ids.length < 4 || ids[0] !== ids.at(-1) || ids.some(id => !nodes.has(id))) continue;
    const ring = cleanRing(ids.map(id => nodes.get(id)!));
    if (!simplePierRing(ring)) continue;
    const rings = [ensureCcw(ring)], polygon: LocalPolygon = { id:`osm-pier-${way.id}`, rings, bbox:bbox(rings), properties:{ source:'OpenStreetMap explicit closed man_made=pier', osmWay:way.id, man_made:'pier' } };
    selected.set(polygon.id, polygon); pierWays.push(way.id);
  }
  return { polygons:[...selected.values()], matches:original.matches, pierWays:pierWays.sort((a,b)=>a-b), bridgeEndPartIds:bridgeEndPartIds.sort(), separateDeckPartIds:separateDeckPartIds.sort() };
}

/** Quantified footprint proof for an explicitly selected bridge strip. Offsets
 * are to the right of the OSM way in runtime XZ, so asymmetric lane groups can
 * be checked as actually constructed. This does not assert height continuity. */
export function measureRegisteredBridgeCoverage(osm: CoastalOsm, wayId: number, deckPolygons: readonly LocalPolygon[], originProjected: readonly number[], options: { minOffset: number; maxOffset: number; spacing?: number }) {
  const spacing = options.spacing ?? 0.25;
  if (!(spacing > 0) || options.minOffset > options.maxOffset) throw new Error('invalid bridge coverage sampling');
  const way = osm.elements.find(e => e.type === 'way' && e.id === wayId), nodes = localNodes(osm, originProjected);
  if (!way?.nodes || way.nodes.some(n => !nodes.has(n))) throw new Error(`bridge ${wayId} has missing axis nodes`);
  const axis = way.nodes.map(n => nodes.get(n)!);
  const unsupported: { x: number; z: number; offset: number }[] = [];
  let probes = 0, unsupportedProbes = 0, length = 0;
  for (let i = 0; i + 1 < axis.length; i++) {
    const a = axis[i]!, b = axis[i + 1]!, dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
    if (len < EPS) continue;
    length += len;
    const along = Math.max(1, Math.ceil(len / spacing)), across = Math.max(1, Math.ceil((options.maxOffset - options.minOffset) / spacing));
    for (let j = 0; j <= along; j++) for (let k = 0; k <= across; k++) {
      const offset = options.minOffset + (options.maxOffset - options.minOffset) * k / across;
      const x = a[0] + dx * j / along + dy / len * offset, y = a[1] + dy * j / along - dx / len * offset;
      probes++;
      if (!deckPolygons.some(p => pointInPolygon([x, y], p.rings))) { unsupportedProbes++; if (unsupported.length < 20) unsupported.push({ x, z: -y, offset }); }
    }
  }
  return { way: wayId, minOffset: options.minOffset, maxOffset: options.maxOffset, spacing, length, probes, unsupportedProbes, unsupported, pass: unsupportedProbes === 0 };
}

export type CoastalClipGeometry = [number, number][][][];
export interface CoastalClipRetryWitness {
  readonly stage: 'water-minus-decks' | 'triangle-water-intersection' | 'triangle-water-difference';
  readonly operation: 'intersection' | 'difference';
  readonly frame: 'working ENU metres: X east, Y north';
  readonly pieceIndex?: number;
  readonly cell?: string;
  readonly tag?: string;
  readonly triangleIndex?: number;
  readonly sourceIndices?: number[];
  readonly trianglePositions?: number[][];
  readonly triangleUvs?: number[][];
  readonly waterPolygonIds?: string[];
  readonly deckPolygonIds?: string[];
  readonly originalInputs: readonly [CoastalClipGeometry, CoastalClipGeometry];
  readonly retryInputs: readonly [CoastalClipGeometry, CoastalClipGeometry] | null;
  readonly latticeMetres: number;
  readonly maxAxisDisplacementMetres: number;
  readonly retryAttempted: boolean;
  readonly status: 'retrying' | 'recovered' | 'failed';
  readonly originalError: { name: string; message: string; stack?: string };
  readonly retryError?: { name: string; message: string; stack?: string };
}
export interface CoastalClipOptions {
  /** Called synchronously before the numeric retry, with detached JSON-safe inputs.
   * A caller can persist the original failure before any further geometry work. */
  readonly onRetry?: (witness: CoastalClipRetryWitness) => void;
}
export class CoastalClipError extends AggregateError {
  readonly details: CoastalClipRetryWitness;
  constructor(original: unknown, details: CoastalClipRetryWitness, retry?: unknown) {
    super(retry === undefined ? [original] : [original, retry], `Coastal ${details.operation} failed at ${details.stage}${details.cell ? ` in ${details.cell} triangle ${details.triangleIndex}` : ''}${details.retryAttempted ? ' at source and 0.1um precision' : ' without a numeric retry'}`);
    this.name = 'CoastalClipError'; this.details = details;
  }
}
type CoastalClipContext = Pick<CoastalClipRetryWitness, 'stage' | 'pieceIndex' | 'cell' | 'tag' | 'triangleIndex' | 'sourceIndices' | 'trianglePositions' | 'triangleUvs' | 'waterPolygonIds' | 'deckPolygonIds'>;
const clipErrorRecord = (error: unknown) => error instanceof Error ? { name:error.name, message:error.message, ...(error.stack ? {stack:error.stack} : {}) } : { name:typeof error, message:String(error) };
const isNumericClipFailure = (error: unknown) => error instanceof Error && (
  /^Infinite loop when (?:putting segment endpoints|passing sweep line)/.test(error.message) ||
  /^Unable to (?:find segment #|pop\(\) (?:left|right) SweepEvent|complete output ring)/.test(error.message) ||
  /^Tried to (?:link already linked events|create degenerate segment at )/.test(error.message)
);
function coastalBoolean(operation: 'intersection'|'difference', a: Geometry, b: Geometry, context: () => CoastalClipContext, options: CoastalClipOptions, witnesses: CoastalClipRetryWitness[]): Geometry {
  try { return polygonClipping[operation](a,b) as Geometry; }
  catch (original) {
    const numeric=isNumericClipFailure(original),originalInputs=structuredClone([a,b]) as [Geometry,Geometry];
    const snap=(g: Geometry): Geometry => g.map(p=>p.map(r=>r.map(([x,n])=>[Math.round(x*1e7)/1e7,Math.round(n*1e7)/1e7])));
    const retryInputs=numeric ? [snap(a),snap(b)] as [Geometry,Geometry] : null;
    let maxAxisDisplacementMetres=0;
    if(retryInputs) for(let k=0;k<originalInputs.length;k++)for(let p=0;p<originalInputs[k]!.length;p++)for(let r=0;r<originalInputs[k]![p]!.length;r++)for(let v=0;v<originalInputs[k]![p]![r]!.length;v++)for(let xy=0;xy<2;xy++) maxAxisDisplacementMetres=Math.max(maxAxisDisplacementMetres,Math.abs(originalInputs[k]![p]![r]![v]![xy]!-retryInputs[k]![p]![r]![v]![xy]!));
    const witness: CoastalClipRetryWitness={...context(),operation,frame:'working ENU metres: X east, Y north',originalInputs,retryInputs,latticeMetres:1e-7,maxAxisDisplacementMetres,retryAttempted:numeric,status:numeric?'retrying':'failed',originalError:clipErrorRecord(original)};
    if(!retryInputs) throw new CoastalClipError(original,witness);
    options.onRetry?.(structuredClone(witness));
    // Both operands use one common lattice only after a recognised sweep/topology
    // failure. No buffer, omitted triangle or broad pre-quantisation is permitted.
    let result: Geometry;
    try { result=polygonClipping[operation](retryInputs[0],retryInputs[1]) as Geometry; }
    catch(retry) { throw new CoastalClipError(original,{...witness,status:'failed',retryError:clipErrorRecord(retry)},retry); }
    witnesses.push({...witness,status:'recovered'});
    return result;
  }
}

/** Clip actual triangles, interpolating their existing heights and UVs. Unaffected
 * pieces retain object identity and byte ordering. Vertical quay faces are kept.
 * Successful exact operations are never snapped; failed numeric operations emit
 * reproducible witnesses and get one bounded common-lattice retry. */
export function clipCoastalGround(pieces: readonly GroundPiece[], mask: CoastalMask, deckPolygons: readonly LocalPolygon[] = [], options: CoastalClipOptions = {}): { pieces: GroundPiece[]; clipped: number; removedTriangles: number; precisionRetries: number; precisionRetryWitnesses: CoastalClipRetryWitness[] } {
  const precisionRetryWitnesses: CoastalClipRetryWitness[]=[];
  let cuts = geometry(mask.water);
  if (deckPolygons.length) cuts = coastalBoolean('difference',cuts,geometry(deckPolygons),()=>({stage:'water-minus-decks',waterPolygonIds:mask.water.map(p=>p.id),deckPolygonIds:deckPolygons.map(p=>p.id)}),options,precisionRetryWitnesses);
  const cutPolys = polygons(cuts, 'water-cut');
  const out: GroundPiece[] = []; let clipped = 0, removedTriangles = 0;
  for (const [pieceIndex,piece] of pieces.entries()) {
    const points: Pt[] = [];
    for (let i = 0; i < piece.positions.length; i += 3) points.push([piece.positions[i]!, -piece.positions[i + 2]!]);
    const bounds = bbox([points]), near = cutPolys.filter(p => intersectsBoxes(bounds, p.bbox));
    if (!near.length) { out.push(piece); continue; }
    const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
    let changed = false;
    for (let i = 0; i < piece.indices.length; i += 3) {
      const ids = piece.indices.slice(i, i + 3), tri = ids.map(id => points[id]!) as [Pt, Pt, Pt];
      const area = Math.abs(signedArea(tri));
      const context=(stage:CoastalClipContext['stage']):CoastalClipContext=>({stage,pieceIndex,cell:piece.cell,tag:piece.tag,triangleIndex:i/3,sourceIndices:ids.slice(),trianglePositions:ids.map(id=>piece.positions.slice(id*3,id*3+3)),triangleUvs:ids.map(id=>piece.uvs.slice(id*2,id*2+2)),waterPolygonIds:near.map(p=>p.id)});
      const nearGeometry=geometry(near);
      const intersect = area > EPS ? coastalBoolean('intersection',[[tri]],nearGeometry,()=>context('triangle-water-intersection'),options,precisionRetryWitnesses) : [];
      if (geometryArea(intersect) < EPS) {
        const base = positions.length / 3;
        for (const id of ids) { positions.push(...piece.positions.slice(id * 3, id * 3 + 3)); uvs.push(...piece.uvs.slice(id * 2, id * 2 + 2)); }
        indices.push(base, base + 1, base + 2); continue;
      }
      changed = true; removedTriangles++;
      const rest = coastalBoolean('difference',[[tri]],nearGeometry,()=>context('triangle-water-difference'),options,precisionRetryWitnesses);
      const [a, b, c] = tri, den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
      for (const poly of rest) {
        const flat: number[] = [], holes: number[] = [];
        for (const [k, r] of poly.entries()) { if (k) holes.push(flat.length / 2); for (const p of cleanRing(r)) flat.push(...p); }
        const idx = earcut(flat, holes.length ? holes : undefined, 2), base = positions.length / 3;
        for (let j = 0; j < flat.length; j += 2) {
          const x = flat[j]!, y = flat[j + 1]!;
          const u = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / den;
          const v = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / den, weights = [u, v, 1 - u - v];
          const at = (stride: number, offset: number, data: number[]) => ids.reduce((n, id, k) => n + weights[k]! * data[id * stride + offset]!, 0);
          positions.push(x, at(3, 1, piece.positions), -y); uvs.push(at(2, 0, piece.uvs), at(2, 1, piece.uvs));
        }
        for (let j = 0; j < idx.length; j += 3) {
          const aa = idx[j]!, bb = idx[j + 1]!, cc = idx[j + 2]!;
          const cross = (flat[bb * 2]! - flat[aa * 2]!) * (flat[cc * 2 + 1]! - flat[aa * 2 + 1]!) - (flat[bb * 2 + 1]! - flat[aa * 2 + 1]!) * (flat[cc * 2]! - flat[aa * 2]!);
          indices.push(base + aa, base + (cross >= 0 ? bb : cc), base + (cross >= 0 ? cc : bb));
        }
      }
    }
    if (!changed) out.push(piece);
    else { clipped++; if (indices.length) out.push({ ...piece, positions, uvs, indices }); }
  }
  return { pieces: out, clipped, removedTriangles, precisionRetries:precisionRetryWitnesses.length, precisionRetryWitnesses };
}

/** Flat, textureless water has no physical support; falls recover through the
 * existing kill plane. Each mesh belongs to its ordinary streamed 128 m cell. */
export function buildCoastalWaterPieces(mask: CoastalMask, cellSize: number, waterY: number): CoastalWaterPiece[] {
  if (!(cellSize > 0) || !Number.isFinite(waterY)) throw new Error('invalid coastal water mesh parameters');
  const all = geometry(mask.water), result: CoastalWaterPiece[] = [];
  const a = mask.area;
  for (let x = Math.floor(a.minX / cellSize) * cellSize; x < a.maxX; x += cellSize) for (let z = Math.floor(a.minZ / cellSize) * cellSize; z < a.maxZ; z += cellSize) {
    const square: Ring = [[x, -z], [x + cellSize, -z], [x + cellSize, -z - cellSize], [x, -z - cellSize]];
    if (!mask.water.some(p => intersectsBoxes(bbox([square]), p.bbox))) continue;
    const clipped = polygonClipping.intersection(all, [[square]]) as Geometry;
    const positions: number[] = [], indices: number[] = [];
    for (const poly of clipped) {
      const flat: number[] = [], holes: number[] = [];
      for (const [k, r] of poly.entries()) { if (k) holes.push(flat.length / 2); for (const p of cleanRing(r)) flat.push(...p); }
      const idx = earcut(flat, holes.length ? holes : undefined, 2), base = positions.length / 3;
      for (let i = 0; i < flat.length; i += 2) positions.push(flat[i]!, waterY, -flat[i + 1]!);
      for (let i = 0; i < idx.length; i += 3) {
        const aa = idx[i]!, bb = idx[i + 1]!, cc = idx[i + 2]!;
        const cross = (flat[bb * 2]! - flat[aa * 2]!) * (flat[cc * 2 + 1]! - flat[aa * 2 + 1]!) - (flat[bb * 2 + 1]! - flat[aa * 2 + 1]!) * (flat[cc * 2]! - flat[aa * 2]!);
        indices.push(base + aa, base + (cross >= 0 ? bb : cc), base + (cross >= 0 ? cc : bb));
      }
    }
    if (indices.length) result.push({ cell: cellId(...cellIndexFor(x + cellSize / 2, z + cellSize / 2, cellSize)), positions, indices });
  }
  return result;
}

/** Lower only safety-field cells intersected by real water, including all four
 * corners so heightfield interpolation cannot create invisible walkable water. */
export function lowerTerrainUnderWater(terrain: TerrainGrid, mask: CoastalMask, floorY: number): { terrain: TerrainGrid; loweredSamples: number } {
  if (!Number.isFinite(floorY)) throw new Error('invalid underwater safety floor');
  const result = lowerTerrainUnderWaterRaster(terrain, mask, floorY);
  return { terrain: result.terrain, loweredSamples: result.loweredSamples };
}
