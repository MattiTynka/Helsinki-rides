// Live collision cell (docs/live-kartta-cells-plan-2026-10-30.md, section 3): one live square's HCOL v2 bundle and its
// ground mesh. Ground is the sampled 2 m terrain lattice without water and no-data quads, each quad tagged by the street
// and green parts register polygon under its centre. Buildings are register footprints owned by the square (footprint
// centroid), clipped to the square grown by the live margin and extruded into prisms from their storey counts. A static
// base map square (tools/world/build_base_map.ts) stores the derived quads and prisms plus its bridge decks, and is
// assembled here the same way. Pure, browser-safe and deterministic: the same input gives byte-identical output, so a
// session and its replay agree.
import { ShapeUtils, Vector2 } from 'three';
import { encodeCollisionBundle, type TriMeshCollider } from '@helsinki/world-schema';
import {
  LIVE_GROUND_COLLIDER_ID, LIVE_GROUND_N, LIVE_GROUND_QUADS, LIVE_GROUND_STEP, LIVE_SURFACE_ORDER, LIVE_SURFACE_TAGS, QUAD_HOLE, QUAD_WATER,
  type BaseSquare, type CollisionCellInput, type CollisionCellOutput, type GeoJsonFeature, type GeoJsonFeatureCollection, type LiveDeck, type LiveGroundVisual,
  type LivePrism, type LiveSurface, type Origin,
} from '../contract.ts';

const N = LIVE_GROUND_N, Q = LIVE_GROUND_QUADS, STEP = LIVE_GROUND_STEP, SQUARE = Q * STEP;
/** LIVE_MARGIN of packages/sim/src/live-grid.ts: owned footprints are clipped to the square grown by this. */
const MARGIN = 32;
/** Collider Y of lattice points without terrain data; no kept triangle uses them. */
const NO_DATA_Y = -50;
const FRAME = 'X-east,Y-up,Z-south' as const;
const SURFACES = LIVE_SURFACE_ORDER;
const YARD = 3, WALL = 4, ROOF = 5;
/** Id of a base map square's bridge deck collider. */
export const LIVE_DECK_COLLIDER_ID = 'live-deck';
/** Depth of the slab edge drawn below an open deck edge (visual only), and its ground class (walk). */
const SLAB = 1.2, SLAB_SURFACE = 1;
const SURFACE_TAGS: readonly string[] = [...SURFACES.map(s => LIVE_SURFACE_TAGS[s]), 'wall', 'roof'];
/** Prism height: storeys × 3.2 m + 2 m above the lowest ground, 9 m without a storey count; the base sinks 0.5 m. */
// The base sinks deep: margin parts take clamped edge heights, so on a downhill neighbour a shallow base would float.
const STOREY_HEIGHT = 3.2, ROOF_ALLOWANCE = 2, UNKNOWN_HEIGHT = 9, BASE_SINK = 5;

/** A ring in runtime XZ as [x0, z0, x1, z1, …], open (no closing duplicate, no repeated consecutive points). */
type Ring = number[];
/** Outer ring first, then holes. */
type Polygon = Ring[];
type Rect = readonly [number, number, number, number];

// Street and green parts register (avoindata:YLRE_Katu_ja_viherosat_kaikki_alue): `paatyyppi` is the main type and
// `alatyyppi` the subtype; bridge subtypes repeat the street names with " (Silta)".
const ROAD_PARTS = new Set(['Ajorata', 'Ajorata, muu', 'Pysäköintialue', 'Tonttiliittymä']);
const WALK_PARTS = new Set([
  'Koroke', 'Erotusalue', 'Juuristoritilä', 'Kevyt liikenne', 'Kevyt liikenne, muu', 'Jalankulkualue', 'Erotettu jalkakäytävä',
  'Erotettu pyörätie', 'Yhdistetty jk ja pp', 'Pyöräilyalue/kaista', 'Portaat', 'Lämmitettävät portaat', 'Puistokäytävät', 'Polku',
  'Luontopolku', 'Aukiot', 'Pelastusreitit', 'Ratsastusreitit',
]);
const GREEN_GROUPS = new Set(['Nurmikot ja niityt', 'Kukkakasvit', 'Puut, pensaat ja köynnökset']);
const GREEN_PARTS = new Set([
  'Katuvihreä', 'Metsä', 'Pelto', 'Niityt', 'Kosteikko', 'Suo', 'Arvokasluontokohde', 'Viljelyspalstat', 'Kitumaa', 'Joutomaa',
  'Jättömaa (vaihettumisvyöhyke)', 'Oja, ojanne', 'Istutusallas',
]);

/** Ground class of a street and green parts register feature: carriageways, parking and plot entrances are road;
 *  pedestrian and cycle areas, islands, separation strips and squares walk; lawns, planting and forest green. */
export function classifyStreetPart(properties: Readonly<Record<string, unknown>> | null): LiveSurface {
  if (!properties) return 'yard';
  const group = text(properties['paatyyppi']);
  const part = text(properties['alatyyppi']).replace(/ \(Silta\)$/, '');
  if (WALK_PARTS.has(part)) return 'walk';
  if (ROAD_PARTS.has(part) || group === 'Ajorata' || /bussi|joukkoliikenne/i.test(part)) return 'road';
  if (group === 'Kevyt liikenne') return 'walk';
  if (GREEN_GROUPS.has(group) || GREEN_PARTS.has(part)) return 'green';
  return 'yard';
}

/** One live square's HCOL bytes (ground first, then one prism collider per owned building) and its ground mesh. */
export function buildCollisionCell(input: CollisionCellInput): CollisionCellOutput {
  return assembleSquare(input.id, input.originId, input.origin, { cx: input.cx, cz: input.cz, ...deriveSquare(input), deck: null });
}

/** A square's ground quads (water, holes without terrain data, else the register class) and its building prisms. */
export function deriveSquare(input: CollisionCellInput): { heights: Float32Array; quads: Int8Array; prisms: LivePrism[] } {
  const { cx, cz, origin, heights, waterMask } = input;
  if (heights.length !== N * N) throw new Error(`${input.id}: ${heights.length} lattice heights, expected ${N * N}`);
  if (waterMask && waterMask.length !== Q * Q) throw new Error(`${input.id}: water mask holds ${waterMask.length} quads, expected ${Q * Q}`);
  const gx0 = cx * SQUARE, gz0 = cz * SQUARE;
  const streets = streetPolygons(input.streetParts, origin, [gx0, gz0, gx0 + SQUARE, gz0 + SQUARE]);
  const quads = new Int8Array(Q * Q);
  for (let iz = 0; iz < Q; iz++) for (let ix = 0; ix < Q; ix++) {
    const q = iz * Q + ix, i = iz * N + ix;
    if (waterMask && waterMask[q] !== 0) quads[q] = QUAD_WATER;
    else if (Number.isNaN(heights[i]!) || Number.isNaN(heights[i + 1]!) || Number.isNaN(heights[i + N]!) || Number.isNaN(heights[i + N + 1]!)) quads[q] = QUAD_HOLE;
    else quads[q] = surfaceAt(streets, gx0 + ix * STEP + STEP / 2, gz0 + iz * STEP + STEP / 2);
  }
  return { heights, quads, prisms: buildingPrisms(input, gx0, gz0) };
}

/** A base map square's collision and ground: land assembles as a live square; open sea is flat water without colliders. */
export function assembleBaseSquare(id: string, originId: string, origin: Origin, square: BaseSquare): CollisionCellOutput {
  if (square.kind === 'land' && square.heights && square.quads) {
    return assembleSquare(id, originId, origin, { cx: square.cx, cz: square.cz, heights: square.heights, quads: square.quads, prisms: square.prisms, deck: square.deck });
  }
  const hcol = emptyCollisionCell(id, originId);
  if (square.kind !== 'water') return { hcol, ground: null, buildings: 0 };
  const gx0 = square.cx * SQUARE, gz0 = square.cz * SQUARE, sea = 0 - origin[2];
  const positions = new Float32Array(N * N * 3), normals = new Float32Array(N * N * 3);
  for (let i = 0; i < N * N; i++) {
    positions[i * 3] = gx0 + (i % N) * STEP;
    positions[i * 3 + 1] = sea;
    positions[i * 3 + 2] = gz0 + Math.floor(i / N) * STEP;
    normals[i * 3 + 1] = 1;
  }
  const ground: LiveGroundVisual = { positions, normals, classes: [], water: waterMesh(new Int8Array(Q * Q).fill(QUAD_WATER), gx0, gz0, sea) };
  return { hcol, ground, buildings: 0 };
}

interface AssemblyInput {
  readonly cx: number;
  readonly cz: number;
  readonly heights: Float32Array;
  readonly quads: Int8Array;
  readonly prisms: readonly LivePrism[];
  readonly deck: LiveDeck | null;
}

/** HCOL bytes (ground, bridge decks, then one prism collider per building) and the ground mesh of one square. */
function assembleSquare(id: string, originId: string, origin: Origin, square: AssemblyInput): CollisionCellOutput {
  const { cx, cz, heights, quads } = square;
  if (heights.length !== N * N || quads.length !== Q * Q) throw new Error(`${id}: ${heights.length} heights and ${quads.length} quads`);
  const gx0 = cx * SQUARE, gz0 = cz * SQUARE;

  const lattice = new Float32Array(N * N * 3);
  for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) {
    const i = iz * N + ix, h = heights[i]!;
    lattice[i * 3] = gx0 + ix * STEP;
    lattice[i * 3 + 1] = Number.isNaN(h) ? NO_DATA_Y : h;
    lattice[i * 3 + 2] = gz0 + iz * STEP;
  }

  const counts = [0, 0, 0, 0];
  let kept = 0;
  for (let q = 0; q < Q * Q; q++) {
    const s = quads[q]!;
    if (s < 0) continue;
    counts[s] = counts[s]! + 1;
    kept++;
  }

  // Two upward triangles per quad on the fixed (ix, iz + 1)–(ix + 1, iz) diagonal.
  const indices = new Uint32Array(kept * 6), triangleTags = new Uint16Array(kept * 2);
  const classIndices = counts.map(c => new Uint32Array(c * 6)), classFill = [0, 0, 0, 0];
  let t = 0;
  for (let q = 0; q < Q * Q; q++) {
    const s = quads[q]!;
    if (s < 0) continue;
    const i = Math.floor(q / Q) * N + (q % Q);
    const tri = [i, i + N, i + 1, i + 1, i + N, i + N + 1] as const;
    indices.set(tri, t * 6);
    triangleTags[t * 2] = s;
    triangleTags[t * 2 + 1] = s;
    classIndices[s]!.set(tri, classFill[s]!);
    classFill[s] = classFill[s]! + 6;
    t++;
  }
  const colliders: TriMeshCollider[] = [{ id: LIVE_GROUND_COLLIDER_ID, group: 'ground', ref: null, positions: lattice, indices, triangleTags }];
  const deck = square.deck ? deckMesh(square.deck, gx0, gz0) : null;
  if (deck) colliders.push({ id: LIVE_DECK_COLLIDER_ID, group: 'ground', ref: null, positions: deck.positions, indices: deck.indices, triangleTags: deck.tags });
  let buildings = 0;
  for (const p of square.prisms) {
    const mesh = prism(p.polygons, p.base, p.top);
    if (mesh) colliders.push({ id: `lb${buildings++}`, group: 'buildings', ref: p.ref, ...mesh });
  }

  const hcol = encodeCollisionBundle({ originId, frame: FRAME, cell: id, surfaceTags: SURFACE_TAGS }, colliders);
  const water = waterMesh(quads, gx0, gz0, 0 - origin[2]);
  let ground: LiveGroundVisual = {
    positions: lattice.slice(),
    normals: latticeNormals(heights),
    classes: SURFACES.flatMap((surface, s) => (counts[s] ? [{ surface, indices: classIndices[s]! }] : [])),
    water,
  };
  if (deck) ground = withDeck(ground, classIndices, deck);
  return { hcol, ground, buildings };
}

/** A valid HCOL v2 bundle without colliders: a live square whose sources stayed unavailable, or open sea. */
export function emptyCollisionCell(id: string, originId: string): Uint8Array {
  return encodeCollisionBundle({ originId, frame: FRAME, cell: id, surfaceTags: SURFACE_TAGS }, []);
}

// ---- bridge decks

interface DeckMesh {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly tags: Uint16Array;
  /** Per vertex, +Y unit normal of its plane. */
  readonly normals: Float32Array;
  /** Per surface class, deck triangle indices into positions. */
  readonly classes: readonly number[][];
  /** Slab edge quads: top corners a, b (deck vertex indices) and the outward XZ normal. */
  readonly edges: readonly { readonly a: number; readonly b: number; readonly nx: number; readonly nz: number }[];
}

/** Deck quads as a welded grid per plane (same diagonal as the ground), and the slab edges where a deck ends inside the square. */
function deckMesh(deck: LiveDeck, gx0: number, gz0: number): DeckMesh | null {
  if (deck.quads.length !== Q * Q || deck.surfaces.length !== Q * Q) throw new Error(`deck holds ${deck.quads.length} quads`);
  const planes = deck.planes.length / 3;
  const vertexOf = new Map<number, number>();
  const pos: number[] = [], nor: number[] = [], idx: number[] = [], tags: number[] = [];
  const classes: number[][] = SURFACES.map(() => []);
  const vertex = (ix: number, iz: number, p: number): number => {
    const key = (iz * N + ix) * planes + p;
    let v = vertexOf.get(key);
    if (v === undefined) {
      const a = deck.planes[p * 3]!, bx = deck.planes[p * 3 + 1]!, bz = deck.planes[p * 3 + 2]!;
      const x = gx0 + ix * STEP, z = gz0 + iz * STEP;
      v = pos.length / 3;
      pos.push(x, a + bx * x + bz * z, z);
      const len = Math.sqrt(bx * bx + 1 + bz * bz);
      nor.push(-bx / len, 1 / len, -bz / len);
      vertexOf.set(key, v);
    }
    return v;
  };
  const edges: { a: number; b: number; nx: number; nz: number }[] = [];
  const plane = (ix: number, iz: number): number => (ix < 0 || iz < 0 || ix >= Q || iz >= Q ? -1 : deck.quads[iz * Q + ix]! - 1);
  for (let iz = 0; iz < Q; iz++) for (let ix = 0; ix < Q; ix++) {
    const p = plane(ix, iz);
    if (p < 0) continue;
    if (p >= planes) throw new Error(`deck quad names plane ${p + 1} of ${planes}`);
    const s = Math.min(deck.surfaces[iz * Q + ix]!, SURFACES.length - 1);
    const a = vertex(ix, iz, p), b = vertex(ix, iz + 1, p), c = vertex(ix + 1, iz, p), d = vertex(ix + 1, iz + 1, p);
    idx.push(a, b, c, c, b, d);
    tags.push(s, s);
    classes[s]!.push(a, b, c, c, b, d);
    // A deck ends where the neighbour quad has another plane or none; at the square border the neighbour is unknown.
    if (ix > 0 && plane(ix - 1, iz) !== p) edges.push({ a: b, b: a, nx: -1, nz: 0 });
    if (ix < Q - 1 && plane(ix + 1, iz) !== p) edges.push({ a: c, b: d, nx: 1, nz: 0 });
    if (iz > 0 && plane(ix, iz - 1) !== p) edges.push({ a, b: c, nx: 0, nz: -1 });
    if (iz < Q - 1 && plane(ix, iz + 1) !== p) edges.push({ a: d, b, nx: 0, nz: 1 });
  }
  if (!idx.length) return null;
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx), tags: Uint16Array.from(tags), normals: Float32Array.from(nor), classes, edges };
}

/** The ground visual with the deck triangles appended to their classes and a slab edge hung below each open deck edge. */
function withDeck(ground: LiveGroundVisual, classIndices: readonly Uint32Array[], deck: DeckMesh): LiveGroundVisual {
  const L = N * N, D = deck.positions.length / 3;
  const positions = new Float32Array((L + D + deck.edges.length * 4) * 3), normals = new Float32Array(positions.length);
  positions.set(ground.positions);
  normals.set(ground.normals);
  positions.set(deck.positions, L * 3);
  normals.set(deck.normals, L * 3);
  const extra = deck.classes.map(list => list.map(v => v + L));
  let v = L + D;
  for (const e of deck.edges) {
    const ax = deck.positions[e.a * 3]!, ay = deck.positions[e.a * 3 + 1]!, az = deck.positions[e.a * 3 + 2]!;
    const bx = deck.positions[e.b * 3]!, by = deck.positions[e.b * 3 + 1]!, bz = deck.positions[e.b * 3 + 2]!;
    positions.set([ax, ay, az, bx, by, bz, ax, ay - SLAB, az, bx, by - SLAB, bz], v * 3);
    for (let k = 0; k < 4; k++) normals.set([e.nx, 0, e.nz], (v + k) * 3);
    // (top a, bottom a, top b) faces along (−dz, dx) for d = b − a; flip it when that points into the deck.
    const out = (bx - ax) * e.nz - (bz - az) * e.nx > 0;
    const quad = out ? [v, v + 2, v + 1, v + 1, v + 2, v + 3] : [v, v + 1, v + 2, v + 1, v + 3, v + 2];
    extra[SLAB_SURFACE]!.push(...quad);
    v += 4;
  }
  const classes = SURFACES.flatMap((surface, s) => {
    const own = classIndices[s]!, more = extra[s]!;
    if (!own.length && !more.length) return [];
    const indices = new Uint32Array(own.length + more.length);
    indices.set(own);
    indices.set(more, own.length);
    return [{ surface, indices }];
  });
  return { positions, normals, classes, water: ground.water };
}

// ---- ground

interface StreetPolygon { readonly rank: number; readonly rings: Polygon; readonly box: Rect }

/** Non-yard register polygons meeting the square, best rank first (yard is the default anyway). */
function streetPolygons(parts: GeoJsonFeatureCollection, origin: Origin, square: Rect): StreetPolygon[] {
  const out: StreetPolygon[] = [];
  for (const f of parts.features) {
    const rank = SURFACES.indexOf(classifyStreetPart(f.properties));
    if (rank === YARD) continue;
    for (const rings of featurePolygons(f, origin)) {
      const box = bounds(rings[0]!);
      if (box[2] < square[0] || box[0] > square[2] || box[3] < square[1] || box[1] > square[3]) continue;
      out.push({ rank, rings, box });
    }
  }
  return out.sort((a, b) => a.rank - b.rank);
}

function surfaceAt(streets: readonly StreetPolygon[], x: number, z: number): number {
  for (const s of streets) {
    if (x < s.box[0] || x > s.box[2] || z < s.box[1] || z > s.box[3]) continue;
    if (contains(s.rings, x, z)) return s.rank;
  }
  return YARD;
}

/** Even-odd test over the outer ring and its holes. */
export function contains(rings: readonly (readonly number[])[], x: number, z: number): boolean {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const xi = r[i]!, zi = r[i + 1]!, xj = r[j]!, zj = r[j + 1]!;
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Per lattice point, central differences (one-sided beside no-data points); +Y up. */
function latticeNormals(heights: Float32Array): Float32Array {
  const out = new Float32Array(N * N * 3);
  const slope = (lo: number, c: number, hi: number): number => {
    const l = !Number.isNaN(lo), h = !Number.isNaN(hi);
    return l && h ? (hi - lo) / (2 * STEP) : h ? (hi - c) / STEP : l ? (c - lo) / STEP : 0;
  };
  for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) {
    const i = iz * N + ix, c = heights[i]!;
    if (Number.isNaN(c)) { out[i * 3 + 1] = 1; continue; }
    const dx = slope(ix > 0 ? heights[i - 1]! : NaN, c, ix < N - 1 ? heights[i + 1]! : NaN);
    const dz = slope(iz > 0 ? heights[i - N]! : NaN, c, iz < N - 1 ? heights[i + N]! : NaN);
    const len = Math.sqrt(dx * dx + 1 + dz * dz);
    out[i * 3] = -dx / len;
    out[i * 3 + 1] = 1 / len;
    out[i * 3 + 2] = -dz / len;
  }
  return out;
}

/** Flat upward quads at sea level for every water quad, sharing lattice corners. */
function waterMesh(quads: Int8Array, gx0: number, gz0: number, y: number): LiveGroundVisual['water'] {
  const remap = new Int32Array(N * N).fill(-1);
  const positions: number[] = [], indices: number[] = [];
  const vertex = (ix: number, iz: number): number => {
    const i = iz * N + ix;
    if (remap[i]! < 0) { remap[i] = positions.length / 3; positions.push(gx0 + ix * STEP, y, gz0 + iz * STEP); }
    return remap[i]!;
  };
  for (let iz = 0; iz < Q; iz++) for (let ix = 0; ix < Q; ix++) {
    if (quads[iz * Q + ix] !== QUAD_WATER) continue;
    const a = vertex(ix, iz), b = vertex(ix, iz + 1), c = vertex(ix + 1, iz), d = vertex(ix + 1, iz + 1);
    indices.push(a, b, c, c, b, d);
  }
  return indices.length ? { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) } : null;
}

// ---- buildings

interface Footprint {
  readonly properties: Readonly<Record<string, unknown>> | null;
  readonly vtj: string;
  readonly key: string;
  readonly ref: string | null;
  readonly polygons: Polygon[];
}

/** Prisms of the footprints this square owns, in a stable order (VTJ id, register id, coordinates). */
function buildingPrisms(input: CollisionCellInput, gx0: number, gz0: number): LivePrism[] {
  const footprints: Footprint[] = [];
  for (const f of input.footprints.features) {
    const polygons = featurePolygons(f, input.origin);
    if (!polygons.length) continue;
    const p: Readonly<Record<string, unknown>> = f.properties ?? {};
    const vtj = text(p['vtj_prt']) || text(p['c_vtj_prt']), registerId = text(p['id']), featureId = text(f.id);
    footprints.push({ properties: f.properties, vtj, key: registerId || featureId, ref: vtj || (registerId ? `register-${registerId}` : featureId) || null, polygons });
  }
  footprints.sort((a, b) => compareText(a.vtj, b.vtj) || compareText(a.key, b.key) || compareCoordinates(a.polygons, b.polygons));

  const clip: Rect = [gx0 - MARGIN, gz0 - MARGIN, gx0 + SQUARE + MARGIN, gz0 + SQUARE + MARGIN];
  const out: LivePrism[] = [];
  for (const fp of footprints) {
    let largest = fp.polygons[0]![0]!, largestArea = -1;
    for (const poly of fp.polygons) {
      const a = Math.abs(area2(poly[0]!));
      if (a > largestArea) { largest = poly[0]!; largestArea = a; }
    }
    const [mx, mz] = centroid(largest);
    const ox = Math.floor(mx / SQUARE), oz = Math.floor(mz / SQUARE);
    if (ox !== input.cx || oz !== input.cz || input.isStaticSquare(ox, oz)) continue;
    if ((fp.vtj && input.staticVtj.has(fp.vtj)) || (fp.ref !== null && input.staticVtj.has(fp.ref))) continue;

    const clipped: Polygon[] = [];
    for (const poly of fp.polygons) {
      const outer = clipRing(poly[0]!, clip);
      if (outer.length) clipped.push([outer, ...poly.slice(1).map(r => clipRing(r, clip)).filter(r => r.length > 0)]);
    }
    let floor = Infinity;
    for (const poly of clipped) for (const r of poly) for (let i = 0; i < r.length; i += 2) {
      const h = latticeHeight(input.heights, gx0, gz0, r[i]!, r[i + 1]!);
      if (h < floor) floor = h;
    }
    if (!Number.isFinite(floor)) continue;
    const storeys = storeyCount(fp.properties);
    const base = floor - BASE_SINK, top = base + BASE_SINK + (storeys > 0 ? storeys * STOREY_HEIGHT + ROOF_ALLOWANCE : UNKNOWN_HEIGHT);
    out.push({ ref: fp.ref, base, top, polygons: clipped });
  }
  return out;
}

function storeyCount(properties: Readonly<Record<string, unknown>> | null): number {
  const v = properties?.['i_kerrlkm'];
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : 0;
  return Number.isFinite(n) ? n : 0;
}

/** Walls facing away from the solid on every ring edge, and the roof at `top` triangulated with its holes, facing up. */
function prism(polygons: readonly (readonly (readonly number[])[])[], base: number, top: number): Pick<TriMeshCollider, 'positions' | 'indices' | 'triangleTags'> | null {
  const pos: number[] = [], idx: number[] = [], tags: number[] = [];
  for (const rings of polygons) {
    const first = pos.length / 3;
    for (const r of rings) for (let i = 0; i < r.length; i += 2) pos.push(r[i]!, top, r[i + 1]!);
    // Vector2, not plain {x, y}: triangulateShape calls .equals() on the ring ends.
    const points = (r: readonly number[]) => Array.from({ length: r.length / 2 }, (_, i) => new Vector2(r[i * 2]!, r[i * 2 + 1]!));
    for (const face of ShapeUtils.triangulateShape(points(rings[0]!), rings.slice(1).map(points))) {
      const a = first + face[0]!, b = first + face[1]!, c = first + face[2]!;
      const up = (pos[b * 3 + 2]! - pos[a * 3 + 2]!) * (pos[c * 3]! - pos[a * 3]!) - (pos[b * 3]! - pos[a * 3]!) * (pos[c * 3 + 2]! - pos[a * 3 + 2]!);
      if (up === 0) continue;
      if (up > 0) idx.push(a, b, c); else idx.push(a, c, b);
      tags.push(ROOF);
    }
    rings.forEach((r, ri) => {
      // Corners a-top, c-top, c-base, a-base. For an edge (dx, dz), faces (0, 2, 1)(0, 3, 2) have normal (−dz, dx): out of
      // an outer ring with negative area2 and into a hole with positive area2, i.e. away from the solid.
      const area = area2(r), outward = ri === 0 ? area < 0 : area > 0, n = r.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, v = pos.length / 3;
        pos.push(r[i * 2]!, top, r[i * 2 + 1]!, r[j * 2]!, top, r[j * 2 + 1]!, r[j * 2]!, base, r[j * 2 + 1]!, r[i * 2]!, base, r[i * 2 + 1]!);
        if (outward) idx.push(v, v + 2, v + 1, v, v + 3, v + 2);
        else idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
        tags.push(WALL, WALL);
      }
    });
  }
  if (!idx.length) return null;
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx), triangleTags: Uint16Array.from(tags) };
}

/** Bilinear lattice height at XZ (clamped to the square), weighting only corners with data; NaN when none has. */
function latticeHeight(heights: Float32Array, gx0: number, gz0: number, x: number, z: number): number {
  const fx = Math.min(Math.max((x - gx0) / STEP, 0), Q), fz = Math.min(Math.max((z - gz0) / STEP, 0), Q);
  const ix = Math.min(Math.floor(fx), Q - 1), iz = Math.min(Math.floor(fz), Q - 1), tx = fx - ix, tz = fz - iz;
  const i = iz * N + ix;
  const corners = [heights[i]!, heights[i + 1]!, heights[i + N]!, heights[i + N + 1]!];
  const weights = [(1 - tx) * (1 - tz), tx * (1 - tz), (1 - tx) * tz, tx * tz];
  let sum = 0, weight = 0;
  for (let k = 0; k < 4; k++) {
    const h = corners[k]!, w = weights[k]!;
    if (!Number.isNaN(h) && w > 0) { sum += h * w; weight += w; }
  }
  return weight > 0 ? sum / weight : NaN;
}

// ---- polygons

/** Polygon and MultiPolygon features (EPSG:3879 [E, N]) as runtime XZ polygons: x = E − E0, z = N0 − N. */
export function featurePolygons(f: GeoJsonFeature, origin: Origin): Polygon[] {
  const g = f.geometry;
  if (!g) return [];
  const polygons = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  const out: Polygon[] = [];
  for (const p of polygons) {
    const rings = p.map(r => toRing(r, origin)), outer = rings[0];
    if (outer && outer.length >= 6) out.push([outer, ...rings.slice(1).filter(r => r.length >= 6)]);
  }
  return out;
}

function toRing(coordinates: readonly (readonly number[])[], origin: Origin): Ring {
  const r: Ring = [];
  for (const c of coordinates) {
    const e = c[0], n = c[1];
    if (e === undefined || n === undefined || !Number.isFinite(e) || !Number.isFinite(n)) continue;
    push(r, e - origin[0], origin[1] - n);
  }
  return open(r);
}

function push(r: Ring, x: number, z: number): void {
  if (r.length && r[r.length - 2] === x && r[r.length - 1] === z) return;
  r.push(x, z);
}

/** Drop closing points equal to the first. */
function open(r: Ring): Ring {
  while (r.length >= 4 && r[0] === r[r.length - 2] && r[1] === r[r.length - 1]) r.length -= 2;
  return r;
}

/** Twice the signed area in runtime XZ (positive counter-clockwise with X right and Z up), fanned from the first point. */
function area2(r: readonly number[]): number {
  const x0 = r[0]!, z0 = r[1]!;
  let a = 0;
  for (let i = 2; i + 3 < r.length; i += 2) a += (r[i]! - x0) * (r[i + 3]! - z0) - (r[i + 2]! - x0) * (r[i + 1]! - z0);
  return a;
}

/** Area-weighted centroid; the vertex mean for a degenerate ring. */
function centroid(r: Ring): [number, number] {
  const x0 = r[0]!, z0 = r[1]!;
  let a = 0, sx = 0, sz = 0;
  for (let i = 2; i + 3 < r.length; i += 2) {
    const ax = r[i]! - x0, az = r[i + 1]! - z0, bx = r[i + 2]! - x0, bz = r[i + 3]! - z0, c = ax * bz - bx * az;
    a += c; sx += (ax + bx) * c; sz += (az + bz) * c;
  }
  if (a !== 0) return [x0 + sx / (3 * a), z0 + sz / (3 * a)];
  let mx = 0, mz = 0;
  for (let i = 0; i < r.length; i += 2) { mx += r[i]!; mz += r[i + 1]!; }
  return [mx / (r.length / 2), mz / (r.length / 2)];
}

function bounds(r: Ring): Rect {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < r.length; i += 2) {
    x0 = Math.min(x0, r[i]!); x1 = Math.max(x1, r[i]!);
    z0 = Math.min(z0, r[i + 1]!); z1 = Math.max(z1, r[i + 1]!);
  }
  return [x0, z0, x1, z1];
}

/** Sutherland–Hodgman against an axis-aligned rectangle; empty when fewer than three points remain. */
function clipRing(r: Ring, rect: Rect): Ring {
  const b = bounds(r);
  if (b[0] >= rect[0] && b[1] >= rect[1] && b[2] <= rect[2] && b[3] <= rect[3]) return r;
  let out = clipSide(r, 0, rect[0], 1);
  out = clipSide(out, 0, rect[2], -1);
  out = clipSide(out, 1, rect[1], 1);
  out = clipSide(out, 1, rect[3], -1);
  return out.length >= 6 ? out : [];
}

/** Keep the half-plane sign × (coordinate k − at) ≥ 0. */
function clipSide(r: Ring, k: 0 | 1, at: number, sign: 1 | -1): Ring {
  const n = r.length / 2, out: Ring = [];
  if (n < 3) return out;
  const inside = (i: number): boolean => sign * (r[i * 2 + k]! - at) >= 0;
  const cut = (p: number, c: number): void => {
    const px = r[p * 2]!, pz = r[p * 2 + 1]!, cx = r[c * 2]!, cz = r[c * 2 + 1]!;
    if (k === 0) push(out, at, pz + ((at - px) / (cx - px)) * (cz - pz));
    else push(out, px + ((at - pz) / (cz - pz)) * (cx - px), at);
  };
  for (let c = 0; c < n; c++) {
    const p = (c + n - 1) % n, pIn = inside(p), cIn = inside(c);
    if (cIn) {
      if (!pIn) cut(p, c);
      push(out, r[c * 2]!, r[c * 2 + 1]!);
    } else if (pIn) cut(p, c);
  }
  return open(out);
}

// ---- ordering

function text(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
}

/** Code-unit order, independent of locale. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareCoordinates(a: readonly Polygon[], b: readonly Polygon[]): number {
  const fa = a.flat(2), fb = b.flat(2);
  for (let i = 0; i < Math.min(fa.length, fb.length); i++) if (fa[i] !== fb[i]) return fa[i]! - fb[i]!;
  return fa.length - fb.length;
}
