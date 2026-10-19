// Authored ground (plan section 4.2): the city's street-part polygons (YLRE) become carriageway, sidewalk, square,
// island and planting surfaces that follow the terrain, with vertical kerb faces where a raised surface meets the
// carriageway, plus a coarse fallback grid so nothing can fall through a gap. Pieces are clipped to a 4 m grid so
// long polygons follow the terrain and every piece lies in exactly one 128 m cell (128 is a multiple of 4).
// Flights of steps and entrance terraces supply their own colliding treads and risers. Street parts and the
// fallback grid leave both representations out of these zones.
// Retaining walls (buildRetainingWalls) cut the ground along
// their line and lift or drop it to the level on each side, with a vertical face between.
import earcut from 'earcut';
import polygonClipping from 'polygon-clipping';
import { sampleTerrain, type TerrainGrid } from '../../../packages/world-schema/src/index.ts';
import { bbox, ensureCcw, pointInPolygon, pointInRing, PolygonGrid, ringDistance, segmentDistance, signedArea, type LocalPolygon, type Pt, type Ring } from './geometry.ts';

export type Finish = 'asphalt' | 'setts' | 'cobble' | 'slabs' | 'gravel' | 'grass' | 'yard';
export type Level = 'road' | 'raised';

export interface GroundPiece {
  readonly cell: string;
  readonly finish: Finish;
  readonly level: Level;
  readonly tag: string;
  readonly positions: number[]; // runtime frame, flat xyz
  readonly uvs: number[];
  readonly indices: number[];
  /** Absent: the piece is drawn and collides. `visual` pieces are only drawn, `collision` pieces only collide. */
  readonly use?: 'visual' | 'collision';
}

export interface GroundResult {
  readonly pieces: GroundPiece[];
  readonly kerbs: GroundPiece[];
  readonly collisionFloors: GroundCollisionFloor[];
  readonly stats: { polygons: number; skipped: number; triangles: number; kerbQuads: number; byFinish: Record<string, number>; landingTransitions: LandingTransitionStats[] };
}

interface LandingTransitionStats { flight: string; depth: number; status: 'applied' | 'kept-source-grade'; maxLowering: number; maxGradeDegrees: number; maxInnerRiseBefore: number; maxInnerRiseAfter: number }

/** A conservative upper bound for the runtime safety heightfield, whose collider sits below authored ground. */
export interface GroundCollisionFloor { readonly zone: Ring; readonly minHeight: number }

/** A level boundary of an authored surface, joined to the actual surrounding ground mesh after clipping. */
export interface GroundBoundary {
  readonly a: Pt; readonly b: Pt; readonly heightA: number; readonly heightB: number; readonly tag: string;
  /** A narrow authored landing connection outside the surveyed footprint; its outer platform stays unchanged. */
  readonly landing?: { readonly flight: string; readonly direction: Pt; readonly depth: number; readonly maxHeight: number };
}

const GRID = 4;
// Keep a margin below the game's unchanged 50-degree climb limit. A rejected proposal leaves its platform intact.
const LANDING_MAX_GRADE_DEGREES = 48;
const UV_SCALE: Record<Finish, number> = { asphalt: 6, setts: 2, cobble: 2, slabs: 3, gravel: 4, grass: 5, yard: 6 };

function classify(p: Record<string, unknown>): { level: Level; finish: Finish } | null {
  const main = String(p['paatyyppi'] ?? ''), sub = String(p['alatyyppi'] ?? ''), mat = String(p['materiaali'] ?? '').toLowerCase();
  let level: Level;
  if (main === 'Ajorata') level = sub === 'Koroke' ? 'raised' : 'road';
  // The register labels actual bridge decks separately. Their measured footprint
  // and terrain height supply support; generic fallback paving must not fill a canal.
  else if (main === 'Silta') {
    if (sub === 'Ajorata (Silta)' || sub === 'Ajorata, muu (Silta)') level = 'road';
    else if (['Kevyt liikenne (Silta)', 'Jalankulkualue (Silta)', 'Yhdistetty jk ja pp (Silta)', 'Erotettu jalkakäytävä (Silta)', 'Erotettu pyörätie (Silta)', 'Erotusalue (Silta)', 'Koroke (Silta)'].includes(sub)) level = 'raised';
    else return null;
  }
  else if (main === 'Varusteet') { if (sub === 'Pintavesikourut') level = 'road'; else if (sub === 'Tukimuuri' || sub === 'Koristeallas') level = 'raised'; else return null; }
  else if (main === 'Kevyt liikenne' || main === 'Muu rakenneosa' || main === 'Erityiskohteet' || main.startsWith('Nurmikot') || main.startsWith('Kukkakasvit') || main.startsWith('Puut')) level = 'raised';
  else return null;
  let finish: Finish;
  if (main.startsWith('Nurmikot') || main.startsWith('Kukkakasvit') || main.startsWith('Puut') || mat.includes('nurmi')) finish = 'grass';
  else if (mat.includes('nupukivi')) finish = 'setts';
  else if (mat.includes('noppakivi') || mat.includes('kenttäkivi') || mat.includes('mukulakivi')) finish = 'cobble';
  else if (mat.includes('laatta') || mat.includes('betonikivi') || mat.includes('graniitti')) finish = 'slabs';
  else if (mat.includes('sora') || mat.includes('kivituhka') || mat.includes('hiekka')) finish = 'gravel';
  else if (mat.includes('asfaltti')) finish = 'asphalt';
  else finish = level === 'road' ? 'asphalt' : 'slabs';
  return { level, finish };
}

function cellOf(x: number, y: number, cellSize: number): string {
  // runtime z = -y; half-open cells
  const cx = Math.floor(x / cellSize), cz = Math.floor(-y / cellSize);
  const f = (v: number) => (v < 0 ? 'm' : 'p') + String(Math.abs(v)).padStart(2, '0');
  return `c_${f(cx)}_${f(cz)}`;
}

export function buildGround(parts: readonly LocalPolygon[], terrain: TerrainGrid, excludeZones: readonly Ring[], area: { minX: number; maxX: number; minZ: number; maxZ: number }, curb: number, cellSize: number, walls?: Pick<WallsResult, 'cuts' | 'surface'> & Partial<Pick<WallsResult, 'closeGround'>>, boundaries: readonly GroundBoundary[] = []): GroundResult {
  const classified = parts.map(p => ({ poly: p, cls: classify(p.properties) })).filter((e): e is { poly: LocalPolygon; cls: { level: Level; finish: Finish } } => e.cls !== null);
  const roadPolys = classified.filter(e => e.cls.level === 'road').map(e => e.poly);
  const roadGrid = new PolygonGrid(roadPolys, 16);
  const heightAt = walls ? walls.surface : (x: number, y: number) => sampleTerrain(terrain, x, -y);
  /** Raise for a raised-surface vertex: full kerb height at the road edge, fading to zero 2.5 m into the surface. */
  const raiseAt = (x: number, y: number): number => {
    let d = Infinity;
    for (const r of roadGrid.candidates(x, y)) d = Math.min(d, ringDistance([x, y], r.rings[0]!));
    for (const dx of [-16, 16]) for (const dy of [-16, 16]) for (const r of roadGrid.candidates(x + dx, y + dy)) d = Math.min(d, ringDistance([x, y], r.rings[0]!));
    if (!Number.isFinite(d)) return curb * 0.5;
    return curb * Math.min(1, Math.max(0, 1 - (d - 0.5) / 2.0)) + curb * 0.0;
  };
  const pieces: GroundPiece[] = [];
  const kerbs: GroundPiece[] = [];
  const pieceSources = new Map<GroundPiece, LocalPolygon>();
  const byFinish: Record<string, number> = {};
  let triangles = 0, skipped = 0, kerbQuads = 0;
  const zoneGeom = excludeZones.map(z => [z.map(p => [p[0], p[1]] as [number, number])]);
  const cutGeom = (walls?.cuts ?? []).map(z => [z.map(p => [p[0], p[1]] as [number, number])]);
  const holes = [...zoneGeom, ...cutGeom], holeBoxes = [...excludeZones, ...(walls?.cuts ?? [])].map(z => bbox([z]));

  for (const { poly, cls } of classified) {
    const [x0, y0, x1, y1] = poly.bbox;
    if (x1 < area.minX || x0 > area.maxX || -y0 < area.minZ || -y1 > area.maxZ) { skipped++; continue; }
    let geom: [number, number][][][] = [poly.rings.map(r => r.map(p => [p[0], p[1]] as [number, number]))];
    const cutBy = holes.filter((_, i) => { const [a, b, c, d] = holeBoxes[i]!; return a <= x1 && c >= x0 && b <= y1 && d >= y0; });
    if (cutBy.length) {
      try { geom = polygonClipping.difference(geom, ...cutBy) as [number, number][][][]; } catch { skipped++; continue; }
    }
    if (geom.length === 0) { skipped++; continue; }
    // Grid squares are limited to the play area so a street polygon that runs on for hundreds of metres outside
    // the released district does not create pieces in cells that are never published.
    const gx0 = Math.floor(Math.max(x0, area.minX) / GRID) * GRID, gx1 = Math.min(x1, area.maxX);
    const gy0 = Math.floor(Math.max(y0, -area.maxZ) / GRID) * GRID, gy1 = Math.min(y1, -area.minZ);
    for (let gx = gx0; gx < gx1; gx += GRID) for (let gy = gy0; gy < gy1; gy += GRID) {
      const square: [number, number][][][] = [[[[gx, gy], [gx + GRID, gy], [gx + GRID, gy + GRID], [gx, gy + GRID]]]];
      let clipped: [number, number][][][];
      try { clipped = polygonClipping.intersection(geom, square) as [number, number][][][]; } catch { continue; }
      for (const part of clipped) {
        const outer = part[0]!;
        if (!outer || outer.length < 3) continue;
        const flat: number[] = [];
        const holes: number[] = [];
        for (let ri = 0; ri < part.length; ri++) {
          const ring = part[ri]!;
          const pts = ring.length > 1 && ring[0]![0] === ring[ring.length - 1]![0] && ring[0]![1] === ring[ring.length - 1]![1] ? ring.slice(0, -1) : ring;
          if (ri > 0) holes.push(flat.length / 2);
          for (const p of pts) flat.push(p[0], p[1]);
        }
        const tri = earcut(flat, holes.length ? holes : undefined, 2);
        if (tri.length === 0) continue;
        const cx = gx + GRID / 2, cy = gy + GRID / 2;
        const cell = cellOf(cx, cy, cellSize);
        const positions: number[] = [], uvs: number[] = [];
        const scale = UV_SCALE[cls.finish];
        for (let i = 0; i < flat.length; i += 2) {
          const x = flat[i]!, y = flat[i + 1]!;
          const h = heightAt(x, y) + (cls.level === 'raised' ? raiseAt(x, y) : 0);
          positions.push(x, h, -y);
          uvs.push(x / scale, y / scale);
        }
        const piece = { cell, finish: cls.finish, level: cls.level, tag: `${cls.level}:${cls.finish}`, positions, uvs, indices: tri };
        pieces.push(piece);
        if (cls.level === 'raised') pieceSources.set(piece, poly);
        triangles += tri.length / 3;
        byFinish[cls.finish] = (byFinish[cls.finish] ?? 0) + tri.length / 3;
      }
    }
  }
  // Fallback grid: 4 m quads over the play area, 3 cm below the terrain, so gaps between polygons never swallow a wheel.
  // The authored stair/terrace support owns its footprint. Cut that footprint out of collision too: retaining a
  // whole 4 m terrain quad here could put invisible terrain metres above a straight, width-median stair flight.
  const zoneBoxes = excludeZones.map(z => bbox([z])), cutBoxes = (walls?.cuts ?? []).map(z => bbox([z]));
  for (let gx = Math.floor(area.minX / GRID) * GRID; gx < area.maxX; gx += GRID) for (let gz = Math.floor(area.minZ / GRID) * GRID; gz < area.maxZ; gz += GRID) {
    const x0 = gx, x1 = gx + GRID, z0 = gz, z1 = gz + GRID;
    const cell = cellOf(gx + GRID / 2, -(gz + GRID / 2), cellSize);
    const h = (x: number, z: number) => heightAt(x, -z) - 0.03;
    const positions = [x0, h(x0, z0), z0, x1, h(x1, z0), z0, x1, h(x1, z1), z1, x0, h(x0, z1), z1];
    const uvs = [x0 / 6, -z0 / 6, x1 / 6, -z0 / 6, x1 / 6, -z1 / 6, x0 / 6, -z1 / 6];
    const overlaps = ([a, b, c, d]: [number, number, number, number]) => a < x1 && c > x0 && b < -z0 && d > -z1;
    const nearZones = zoneGeom.filter((_, i) => overlaps(zoneBoxes[i]!)), nearCuts = cutGeom.filter((_, i) => overlaps(cutBoxes[i]!));
    const near = [...nearZones, ...nearCuts];
    // CCW seen from above (+Y): (x0,z0) -> (x0,z1) -> (x1,z1) in a Y-up right-handed frame
    if (!near.length) {
      pieces.push({ cell, finish: 'yard', level: 'road', tag: 'raised:yard', positions, uvs, indices: [0, 3, 2, 0, 2, 1] });
      triangles += 2;
      byFinish['yard'] = (byFinish['yard'] ?? 0) + 2;
      continue;
    }
    let rest: [number, number][][][];
    try { rest = polygonClipping.difference([[[[x0, -z0], [x1, -z0], [x1, -z1], [x0, -z1]]]], ...near) as [number, number][][][]; } catch { continue; }
    for (const part of rest) {
      const flat: number[] = [], holes: number[] = [];
      part.forEach((ring, ri) => { if (ri > 0) holes.push(flat.length / 2); for (const p of ring.slice(0, -1)) flat.push(p[0], p[1]); });
      const tri = earcut(flat, holes.length ? holes : undefined, 2);
      if (!tri.length) continue;
      const pos: number[] = [], uv: number[] = [];
      for (let i = 0; i < flat.length; i += 2) { pos.push(flat[i]!, h(flat[i]!, -flat[i + 1]!), -flat[i + 1]!); uv.push(flat[i]! / 6, flat[i + 1]! / 6); }
      pieces.push({ cell, finish: 'yard', level: 'road', tag: 'raised:yard', positions: pos, uvs: uv, indices: tri });
      triangles += tri.length / 3;
      byFinish['yard'] = (byFinish['yard'] ?? 0) + tri.length / 3;
    }
  }
  const surfaceBoundaries: SurfaceBoundary[] = [];
  const collisionFloors: GroundCollisionFloor[] = [];
  const landingTransitions = boundaries.filter(b => b.landing).map(boundary => ({ boundary, stats: { flight: boundary.landing!.flight, depth: boundary.landing!.depth, status: 'applied' as LandingTransitionStats['status'], maxLowering: 0, maxGradeDegrees: 0, maxInnerRiseBefore: 0, maxInnerRiseAfter: 0 } }));
  for (const { boundary, stats } of landingTransitions) {
    const fitted = pieces.map(piece => fitLanding(piece, boundary, stats));
    if (stats.maxGradeDegrees > LANDING_MAX_GRADE_DEGREES) { stats.status = 'kept-source-grade'; stats.maxInnerRiseAfter = stats.maxInnerRiseBefore; continue; }
    for (let i = 0; i < pieces.length; i++) {
      const poly = pieceSources.get(pieces[i]!);
      pieces[i] = fitted[i]!;
      if (poly) pieceSources.set(fitted[i]!, poly);
    }
    if (stats.maxLowering > 1e-8) {
      const { direction, depth, maxHeight } = boundary.landing!;
      collisionFloors.push({ zone: ensureCcw([boundary.a, boundary.b, [boundary.b[0] + direction[0] * depth, boundary.b[1] + direction[1] * depth], [boundary.a[0] + direction[0] * depth, boundary.a[1] + direction[1] * depth]]), minHeight: maxHeight });
    }
  }
  for (let i = 0; i < pieces.length; i++) {
    const original = pieces[i]!, poly = pieceSources.get(original);
    const piece = original;
    if (!poly) continue;
    // Preserve actual fitted boundary heights, rather than resampling source rings for kerb construction.
    for (const [a, b] of boundaryEdges(piece)) {
      const p: Pt = [a[0], -a[2]], q: Pt = [b[0], -b[2]], midpoint: Pt = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      if (!poly.rings.some(r => ringDistance(p, r) < 1e-5 && ringDistance(q, r) < 1e-5 && ringDistance(midpoint, r) < 1e-5)) continue;
      const length = Math.hypot(b[0] - a[0], b[2] - a[2]);
      if (length < 1e-8) continue;
      const outside: Pt = [(b[2] - a[2]) / length, -(b[0] - a[0]) / length];
      if (pointInPolygon([midpoint[0] + outside[0] * 1e-4, midpoint[1] - outside[1] * 1e-4], poly.rings)) { outside[0] *= -1; outside[1] *= -1; }
      surfaceBoundaries.push({ a, b, outside });
    }
  }
  triangles = pieces.reduce((n, p) => n + p.indices.length / 3, 0);
  for (const key of Object.keys(byFinish)) delete byFinish[key];
  for (const piece of pieces) byFinish[piece.finish] = (byFinish[piece.finish] ?? 0) + piece.indices.length / 3;
  for (const kerb of closeSurfaceBoundaries(pieces, surfaceBoundaries, cellSize)) kerbs.push(kerb);
  kerbQuads = kerbs.length;
  const joins = joinGroundBoundaries(pieces, boundaries, cellSize, walls?.cuts ?? []);
  if (walls?.closeGround) for (const join of walls.closeGround(pieces)) joins.push(join);
  for (const join of joins) pieces.push(join);
  triangles += joins.reduce((count, piece) => count + piece.indices.length / 3, 0);
  return { pieces, kerbs, collisionFloors, stats: { polygons: classified.length, skipped, triangles, kerbQuads, byFinish, landingTransitions: landingTransitions.filter(t => t.stats.maxLowering > 1e-8).map(t => t.stats) } };
}

/** Lower only safety-field cells touched by an authored repair. Lower all four corners conservatively so a
 *  bilinear/triangular heightfield cannot bulge through that repair at a polygon or grid boundary. Source terrain
 *  remains untouched and must still be used to construct buildings and the authored surfaces themselves. */
export function lowerTerrainUnderSurfaces(terrain: TerrainGrid, floors: readonly GroundCollisionFloor[]): TerrainGrid {
  const heights = terrain.heights.slice(), r = terrain.resolution;
  for (const { zone, minHeight } of floors) {
    if (!Number.isFinite(minHeight) || zone.length < 3 || zone.some(p => !p.every(Number.isFinite))) throw new Error('invalid authored safety-floor region');
    const [x0, y0, x1, y1] = bbox([zone]);
    const ix0 = Math.max(0, Math.floor((x0 - terrain.x0) / r)), ix1 = Math.min(terrain.nx - 2, Math.floor((x1 - terrain.x0) / r));
    const iz0 = Math.max(0, Math.floor((-y1 - terrain.z0) / r)), iz1 = Math.min(terrain.nz - 2, Math.floor((-y0 - terrain.z0) / r));
    for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) {
      const x = terrain.x0 + ix * r, z = terrain.z0 + iz * r;
      const square: Ring = [[x, -z], [x + r, -z], [x + r, -z - r], [x, -z - r]];
      const intersection = polygonClipping.intersection([[zone]], [[square]]) as [number, number][][][];
      if (!intersection.some(poly => Math.abs(signedArea(poly[0]! as Ring)) > 1e-10)) continue;
      for (const index of [iz * terrain.nx + ix, iz * terrain.nx + ix + 1, (iz + 1) * terrain.nx + ix, (iz + 1) * terrain.nx + ix + 1]) heights[index] = Math.min(heights[index]!, minHeight);
    }
  }
  return { ...terrain, heights };
}

/** Keep the safety heightfield below the actual ground mesh, including terrain peaks missed by its 4 m grid.
 * The runtime translates this field down by 0.4 m. Limiting all four corners of every intersected grid square
 * to the lowest drawn height there plus 0.35 m leaves at least 5 cm of clearance for either diagonal and for
 * bilinear sampling. Source terrain and visual geometry are unchanged. Vertical faces do not define support. */
export function lowerTerrainUnderGround(terrain: TerrainGrid, pieces: readonly GroundPiece[]): TerrainGrid {
  const heights = terrain.heights.slice(), r = terrain.resolution;
  type Vertex = [number, number, number];
  const clip = (vertices: Vertex[], axis: 0 | 2, edge: number, keepAbove: boolean): Vertex[] => {
    const out: Vertex[] = [];
    for (let i = 0; i < vertices.length; i++) {
      const a = vertices[i]!, b = vertices[(i + 1) % vertices.length]!;
      const aInside = keepAbove ? a[axis] >= edge : a[axis] <= edge;
      const bInside = keepAbove ? b[axis] >= edge : b[axis] <= edge;
      if (aInside) out.push(a);
      if (aInside !== bInside) {
        const t = (edge - a[axis]) / (b[axis] - a[axis]);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
      }
    }
    return out;
  };
  for (const piece of pieces) {
    if (piece.use === 'visual') continue;
    for (let i = 0; i < piece.indices.length; i += 3) {
      const vertices = [0, 1, 2].map(k => piece.positions.slice(piece.indices[i + k]! * 3, piece.indices[i + k]! * 3 + 3) as Vertex);
      const [a, b, c] = vertices as [Vertex, Vertex, Vertex];
      if (Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2])) < 1e-10) continue;
      const ix0 = Math.max(0, Math.floor((Math.min(a[0], b[0], c[0]) - terrain.x0) / r));
      const ix1 = Math.min(terrain.nx - 2, Math.floor((Math.max(a[0], b[0], c[0]) - terrain.x0) / r));
      const iz0 = Math.max(0, Math.floor((Math.min(a[2], b[2], c[2]) - terrain.z0) / r));
      const iz1 = Math.min(terrain.nz - 2, Math.floor((Math.max(a[2], b[2], c[2]) - terrain.z0) / r));
      const lowestPossible = Math.min(a[1], b[1], c[1]) + 0.35;
      for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) {
        const indices = [iz * terrain.nx + ix, iz * terrain.nx + ix + 1, (iz + 1) * terrain.nx + ix, (iz + 1) * terrain.nx + ix + 1];
        if (indices.every(k => heights[k]! <= lowestPossible)) continue;
        const x = terrain.x0 + ix * r, z = terrain.z0 + iz * r;
        const intersection = clip(clip(clip(clip(vertices, 0, x, true), 0, x + r, false), 2, z, true), 2, z + r, false);
        if (intersection.length < 3) continue;
        const projectedArea = intersection.reduce((sum, p, k) => { const q = intersection[(k + 1) % intersection.length]!; return sum + p[0] * q[2] - q[0] * p[2]; }, 0);
        if (Math.abs(projectedArea) < 1e-9) continue;
        const ceiling = Math.min(...intersection.map(p => p[1])) + 0.35;
        for (const index of indices) heights[index] = Math.min(heights[index]!, ceiling);
      }
    }
  }
  return { ...terrain, heights };
}

type SurfacePoint = [number, number, number]; // runtime xyz
export type SurfaceBoundary = { a: SurfacePoint; b: SurfacePoint; outside: Pt }; // outside is runtime XZ

/** Fit only the first landing plate. Splitting at its four bounds keeps all triangles outside it unchanged. */
function fitLanding(piece: GroundPiece, boundary: GroundBoundary, stats: LandingTransitionStats): GroundPiece {
  const landing = boundary.landing!, dx = boundary.b[0] - boundary.a[0], dy = boundary.b[1] - boundary.a[1], width = Math.hypot(dx, dy);
  const across: Pt = [dx / width, -dy / width], outward: Pt = [landing.direction[0], -landing.direction[1]];
  const corners = [boundary.a, boundary.b, [boundary.a[0] + landing.direction[0] * landing.depth, boundary.a[1] + landing.direction[1] * landing.depth] as Pt, [boundary.b[0] + landing.direction[0] * landing.depth, boundary.b[1] + landing.direction[1] * landing.depth] as Pt];
  const [x0, y0, x1, y1] = bbox([corners]);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, maxY = -Infinity;
  for (let i = 0; i < piece.positions.length; i += 3) {
    minX = Math.min(minX, piece.positions[i]!); maxX = Math.max(maxX, piece.positions[i]!);
    minZ = Math.min(minZ, piece.positions[i + 2]!); maxZ = Math.max(maxZ, piece.positions[i + 2]!); maxY = Math.max(maxY, piece.positions[i + 1]!);
  }
  if (maxX < x0 || minX > x1 || maxZ < -y1 || minZ > -y0 || maxY <= landing.maxHeight + 1e-8) return piece;
  type Vertex = [number, number, number, number, number];
  const coordinate = (p: Vertex, axis: 0 | 1) => (p[0] - boundary.a[0]) * (axis === 0 ? outward[0] : across[0]) + (p[2] + boundary.a[1]) * (axis === 0 ? outward[1] : across[1]);
  const clip = (input: Vertex[], axis: 0 | 1, value: number, positive: boolean): Vertex[] => {
    const out: Vertex[] = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[i]!, b = input[(i + 1) % input.length]!, va = coordinate(a, axis) - value, vb = coordinate(b, axis) - value;
      const inA = positive ? va >= -1e-10 : va <= 1e-10, inB = positive ? vb >= -1e-10 : vb <= 1e-10;
      if (inA) out.push(a);
      if (inA !== inB) { const t = va / (va - vb); out.push(a.map((v, j) => v + (b[j]! - v) * t) as Vertex); }
    }
    return out;
  };
  const polygons: Vertex[][] = [], sideClosures: Vertex[][] = [];
  let changed = false;
  for (let i = 0; i < piece.indices.length; i += 3) {
    let inside = [0, 1, 2].map(k => { const index = piece.indices[i + k]!; return [...piece.positions.slice(index * 3, index * 3 + 3), ...piece.uvs.slice(index * 2, index * 2 + 2)] as Vertex; });
    for (const [axis, value, positive] of [[0, 0, true], [0, landing.depth, false], [1, 0, true], [1, width, false]] as const) {
      const outside = clip(inside, axis, value, !positive);
      if (outside.length >= 3) polygons.push(outside);
      inside = clip(inside, axis, value, positive);
      if (!inside.length) break;
    }
    if (inside.length < 3) continue;
    let modified = false;
    const fitted = inside.map(p => {
      const t = Math.max(0, Math.min(1, coordinate(p, 0) / landing.depth)), lowering = Math.max(0, p[1] - landing.maxHeight) * (1 - t);
      if (lowering > 1e-8) { changed = true; modified = true; stats.maxLowering = Math.max(stats.maxLowering, lowering); }
      if (t < 1e-6) {
        stats.maxInnerRiseBefore = Math.max(stats.maxInnerRiseBefore, p[1] - boundary.heightA);
        stats.maxInnerRiseAfter = Math.max(stats.maxInnerRiseAfter, p[1] - lowering - boundary.heightA);
      }
      return [p[0], p[1] - lowering, p[2], p[3], p[4]] as Vertex;
    });
    // The width ends keep their original adjacent platform. Close the exposed difference from each actual
    // clipped triangle edge to its fitted edge; these new seams are not source polygon rings or stair cuts.
    for (let j = 0; j < inside.length; j++) {
      const next = (j + 1) % inside.length, p = inside[j]!, q = inside[next]!;
      if ([0, width].some(side => Math.abs(coordinate(p, 1) - side) < 1e-8 && Math.abs(coordinate(q, 1) - side) < 1e-8)) sideClosures.push([p, q, fitted[next]!, fitted[j]!]);
    }
    polygons.push(fitted);
    if (modified) for (let j = 1; j + 1 < fitted.length; j++) {
      const a = fitted[0]!, b = fitted[j]!, c = fitted[j + 1]!, ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (Math.abs(ny) > 1e-10) stats.maxGradeDegrees = Math.max(stats.maxGradeDegrees, Math.atan2(Math.hypot(nx, nz), Math.abs(ny)) * 180 / Math.PI);
    }
  }
  if (!changed) return piece;
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
  for (const polygon of polygons) {
    const offset = positions.length / 3;
    for (const p of polygon) { positions.push(p[0], p[1], p[2]); uvs.push(p[3], p[4]); }
    for (let i = 1; i + 1 < polygon.length; i++) {
      const a = polygon[0]!, b = polygon[i]!, c = polygon[i + 1]!;
      if (Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0])) > 1e-10) indices.push(offset, offset + i, offset + i + 1);
    }
  }
  for (const polygon of sideClosures) {
    const offset = positions.length / 3;
    for (const p of polygon) { positions.push(p[0], p[1], p[2]); uvs.push(p[3], p[4]); }
    for (let i = 1; i + 1 < polygon.length; i++) {
      const a = polygon[0]!, b = polygon[i]!, c = polygon[i + 1]!, ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) > 1e-10) indices.push(offset, offset + i, offset + i + 1, offset, offset + i + 1, offset + i);
    }
  }
  return { ...piece, positions, uvs, indices };
}

/** Boundary edges of the actual triangulation, preserving its interpolated height rather than resampling terrain. */
function boundaryEdges(piece: GroundPiece): [SurfacePoint, SurfacePoint][] {
  const edges = new Map<string, { a: number; b: number; count: number }>();
  for (let i = 0; i < piece.indices.length; i += 3) for (const [a, b] of [[piece.indices[i]!, piece.indices[i + 1]!], [piece.indices[i + 1]!, piece.indices[i + 2]!], [piece.indices[i + 2]!, piece.indices[i]!]]) {
    const key = `${Math.min(a!, b!)}:${Math.max(a!, b!)}`, edge = edges.get(key);
    if (edge) edge.count++; else edges.set(key, { a: a!, b: b!, count: 1 });
  }
  const point = (i: number): SurfacePoint => [piece.positions[i * 3]!, piece.positions[i * 3 + 1]!, piece.positions[i * 3 + 2]!];
  return [...edges.values()].filter(edge => edge.count === 1).map(edge => [point(edge.a), point(edge.b)]);
}

/** Clip a face in 3D at cell planes, so thin wall caps cannot leak into a neighbouring cell. */
function surfaceFace(points: readonly SurfacePoint[], tag: string, cellSize: number): GroundPiece[] {
  const minX = Math.min(...points.map(p => p[0])), maxX = Math.max(...points.map(p => p[0]));
  const minZ = Math.min(...points.map(p => p[2])), maxZ = Math.max(...points.map(p => p[2]));
  const clip = (input: SurfacePoint[], axis: 0 | 2, value: number, above: boolean): SurfacePoint[] => {
    const output: SurfacePoint[] = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[i]!, b = input[(i + 1) % input.length]!, inA = above ? a[axis] >= value - 1e-10 : a[axis] <= value + 1e-10, inB = above ? b[axis] >= value - 1e-10 : b[axis] <= value + 1e-10;
      if (inA) output.push(a);
      if (inA !== inB) { const t = (value - a[axis]) / (b[axis] - a[axis]); output.push(a.map((v, j) => v + (b[j]! - v) * t) as SurfacePoint); }
    }
    return output;
  };
  const out: GroundPiece[] = [];
  for (let cx = Math.floor(minX / cellSize); cx <= Math.floor(maxX / cellSize); cx++) for (let cz = Math.floor(minZ / cellSize); cz <= Math.floor(maxZ / cellSize); cz++) {
    let polygon = [...points];
    for (const [axis, value, above] of [[0, cx * cellSize, true], [0, (cx + 1) * cellSize, false], [2, cz * cellSize, true], [2, (cz + 1) * cellSize, false]] as const) polygon = clip(polygon, axis, value, above);
    if (polygon.length < 3) continue;
    const positions = polygon.flat(), indices: number[] = [];
    for (let i = 1; i + 1 < polygon.length; i++) {
      const a = polygon[0]!, b = polygon[i]!, c = polygon[i + 1]!, ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) > 1e-10) indices.push(0, i, i + 1, 0, i + 1, i);
    }
    if (indices.length) out.push({ cell: cellOf((cx + 0.5) * cellSize, -(cz + 0.5) * cellSize, cellSize), finish: 'slabs', level: 'raised', tag, positions, uvs: polygon.flatMap(p => [p[0] / 3, p[1] / 3]), indices });
  }
  return out;
}

/** Close exposed raised edges to the highest actual exterior triangle, never to a new terrain sample. */
export function closeSurfaceBoundaries(pieces: readonly GroundPiece[], boundaries: readonly SurfaceBoundary[], cellSize: number, joinBothLevels = false): GroundPiece[] {
  type Triangle = { a: SurfacePoint; b: SurfacePoint; c: SurfacePoint; den: number };
  const triangles: Triangle[] = [], buckets = new Map<string, number[]>();
  const keys = (points: readonly SurfacePoint[]): string[] => {
    const xs = points.map(p => p[0]), zs = points.map(p => p[2]), out: string[] = [];
    for (let x = Math.floor(Math.min(...xs) / GRID); x <= Math.floor(Math.max(...xs) / GRID); x++) for (let z = Math.floor(Math.min(...zs) / GRID); z <= Math.floor(Math.max(...zs) / GRID); z++) out.push(`${x}:${z}`);
    return out;
  };
  for (const piece of pieces) for (let i = 0; i < piece.indices.length; i += 3) {
    const [a, b, c] = [0, 1, 2].map(k => piece.positions.slice(piece.indices[i + k]! * 3, piece.indices[i + k]! * 3 + 3) as SurfacePoint) as [SurfacePoint, SurfacePoint, SurfacePoint];
    const den = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
    if (Math.abs(den) < 1e-10) continue;
    const index = triangles.length; triangles.push({ a, b, c, den });
    for (const key of keys([a, b, c])) { const bucket = buckets.get(key) ?? []; bucket.push(index); buckets.set(key, bucket); }
  }
  const out: GroundPiece[] = [], seen = new Set<string>();
  for (const { a, b, outside } of boundaries) {
    const candidates = new Set(keys([a, b]).flatMap(key => buckets.get(key) ?? []));
    const neighbors: { lo: number; hi: number; h0: number; dh: number }[] = [];
    for (const index of candidates) {
      const triangle = triangles[index]!, points = [triangle.a, triangle.b, triangle.c];
      if (Math.max(...points.map(p => (p[0] - a[0]) * outside[0] + (p[2] - a[2]) * outside[1])) <= 1e-7) continue;
      let lo = 0, hi = 1;
      const sign = Math.sign(triangle.den);
      for (let e = 0; e < 3; e++) {
        const p = points[e]!, q = points[(e + 1) % 3]!, dx = q[0] - p[0], dz = q[2] - p[2];
        const side = (r: SurfacePoint) => sign * (dx * (r[2] - p[2]) - dz * (r[0] - p[0]));
        const s0 = side(a), ds = side(b) - s0;
        if (Math.abs(ds) < 1e-12) { if (s0 < -1e-8) { hi = -1; break; } }
        else if (ds > 0) lo = Math.max(lo, -s0 / ds);
        else hi = Math.min(hi, -s0 / ds);
      }
      if (hi - lo < 1e-8) continue;
      const height = (p: SurfacePoint) => {
        const { a, b, c, den } = triangle;
        const u = ((b[2] - c[2]) * (p[0] - c[0]) + (c[0] - b[0]) * (p[2] - c[2])) / den;
        const v = ((c[2] - a[2]) * (p[0] - c[0]) + (a[0] - c[0]) * (p[2] - c[2])) / den;
        return u * a[1] + v * b[1] + (1 - u - v) * c[1];
      };
      const h0 = height(a); neighbors.push({ lo, hi, h0, dh: height(b) - h0 });
    }
    const splits = neighbors.flatMap(n => [n.lo, n.hi]);
    // Neighboring terrain/road/raised triangles can exchange which is highest along an edge.
    for (let i = 0; i < neighbors.length; i++) for (let j = i + 1; j < neighbors.length; j++) {
      const p = neighbors[i]!, q = neighbors[j]!;
      if (Math.abs(p.dh - q.dh) < 1e-12) continue;
      const t = (q.h0 - p.h0) / (p.dh - q.dh);
      if (t > Math.max(p.lo, q.lo) && t < Math.min(p.hi, q.hi)) splits.push(t);
    }
    for (const n of neighbors) {
      const difference = b[1] - a[1] - n.dh;
      if (Math.abs(difference) < 1e-12) continue;
      const t = (n.h0 - a[1]) / difference;
      if (t > n.lo && t < n.hi) splits.push(t);
    }
    splits.sort((a, b) => a - b);
    const at = (t: number, height?: number): SurfacePoint => [a[0] + (b[0] - a[0]) * t, height ?? a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    for (let i = 0; i + 1 < splits.length; i++) {
      const lo = splits[i]!, hi = splits[i + 1]!, mid = (lo + hi) / 2;
      if (hi - lo < 1e-8) continue;
      const neighbor = neighbors.filter(n => mid >= n.lo - 1e-8 && mid <= n.hi + 1e-8).sort((p, q) => q.h0 + q.dh * mid - p.h0 - p.dh * mid)[0];
      if (!neighbor) continue;
      const difference = at(mid)[1] - neighbor.h0 - neighbor.dh * mid;
      if (joinBothLevels ? Math.abs(difference) < 1e-6 : difference < 1e-6) continue;
      const face = [at(lo), at(hi), at(hi, neighbor.h0 + neighbor.dh * hi), at(lo, neighbor.h0 + neighbor.dh * lo)];
      const key = face.flat().map(v => Math.round(v * 1e6)).join(':');
      if (seen.has(key)) continue; seen.add(key);
      out.push(...surfaceFace(face, 'curb', cellSize));
    }
  }
  return out;
}

/** Parameter intervals of a segment inside a polygon, including its boundary. No distance-based gap filling. */
function segmentInsideRing(a: Pt, b: Pt, ring: Ring): [number, number][] {
  const dx = b[0] - a[0], dy = b[1] - a[1], ts = [0, 1];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!, q = ring[(i + 1) % ring.length]!, ex = q[0] - p[0], ey = q[1] - p[1], den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const px = p[0] - a[0], py = p[1] - a[1], t = (px * ey - py * ex) / den, u = (px * dy - py * dx) / den;
    if (t > 0 && t < 1 && u >= -1e-8 && u <= 1 + 1e-8) ts.push(t);
  }
  ts.sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    const lo = ts[i]!, hi = ts[i + 1]!, t = (lo + hi) / 2, p: Pt = [a[0] + dx * t, a[1] + dy * t];
    if (hi - lo > 1e-8 && (pointInRing(p, ring) || ringDistance(p, ring) < 1e-8)) out.push([lo, hi]);
  }
  return out;
}

function joinGroundBoundaries(pieces: readonly GroundPiece[], boundaries: readonly GroundBoundary[], cellSize: number, cuts: readonly Ring[]): GroundPiece[] {
  const out: GroundPiece[] = [], seen = new Set<string>();
  const cutBounds = cuts.map(ring => bbox([ring]));
  const prepared = boundaries.map(boundary => {
    const dx = boundary.b[0] - boundary.a[0], dy = boundary.b[1] - boundary.a[1], length = Math.hypot(dx, dy);
    const spans = cuts.flatMap((ring, cut) => {
      const [x0, y0, x1, y1] = cutBounds[cut]!;
      if (Math.max(boundary.a[0], boundary.b[0]) < x0 || Math.min(boundary.a[0], boundary.b[0]) > x1 || Math.max(boundary.a[1], boundary.b[1]) < y0 || Math.min(boundary.a[1], boundary.b[1]) > y1) return [];
      return segmentInsideRing(boundary.a, boundary.b, ring).map(range => ({ cut, range }));
    });
    return { boundary, dx, dy, length, spans };
  }).filter(b => b.length > 1e-8);
  for (const piece of pieces) for (const [p, q] of boundaryEdges(piece)) {
    const a: Pt = [p[0], -p[2]], b: Pt = [q[0], -q[2]];
    let edgeCuts: Set<number> | undefined;
    for (const { boundary, dx, dy, length, spans } of prepared) {
      const collinear = Math.abs((a[0] - boundary.a[0]) * dy - (a[1] - boundary.a[1]) * dx) <= length * 1e-5 && Math.abs((b[0] - boundary.a[0]) * dy - (b[1] - boundary.a[1]) * dx) <= length * 1e-5;
      if (!collinear && !spans.length) continue;
      // Only a matching cut side may be projected across its narrow width. A perpendicular cross-wall can
      // otherwise project several metres of edge onto a millimetre at the stair endpoint, creating a fin.
      if (!collinear && Math.abs((b[0] - a[0]) * dx + (b[1] - a[1]) * dy) < Math.hypot(b[0] - a[0], b[1] - a[1]) * length * Math.cos(5 * Math.PI / 180)) continue;
      if (!collinear && !edgeCuts) edgeCuts = new Set(cuts.flatMap((ring, index) => {
        const [x0, y0, x1, y1] = cutBounds[index]!;
        if (Math.max(a[0], b[0]) < x0 - 1e-5 || Math.min(a[0], b[0]) > x1 + 1e-5 || Math.max(a[1], b[1]) < y0 - 1e-5 || Math.min(a[1], b[1]) > y1 + 1e-5) return [];
        return ringDistance(a, ring) < 1e-5 && ringDistance(b, ring) < 1e-5 && ringDistance([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], ring) < 1e-5 ? [index] : [];
      }));
      const ranges: readonly (readonly [number, number])[] = collinear ? [[0, 1]] : spans.filter(s => edgeCuts!.has(s.cut)).map(s => s.range);
      if (!ranges.length) continue;
      const project = (point: Pt) => ((point[0] - boundary.a[0]) * dx + (point[1] - boundary.a[1]) * dy) / (length * length);
      const ta = project(a), tb = project(b);
      if (Math.abs(tb - ta) < 1e-10) continue;
      for (const range of ranges) {
        const lo = Math.max(range[0], Math.min(ta, tb)), hi = Math.min(range[1], Math.max(ta, tb));
        if (hi - lo < 1e-8) continue;
        const at = (t: number): SurfacePoint => { const u = (t - ta) / (tb - ta); return p.map((v, i) => v + (q[i]! - v) * u) as SurfacePoint; };
        const p0 = at(lo), p1 = at(hi);
        const top = (t: number, h: number): SurfacePoint => [boundary.a[0] + dx * t, h, -(boundary.a[1] + dy * t)];
        const t0 = top(lo, p0[1]), t1 = top(hi, p1[1]), h0 = boundary.heightA + (boundary.heightB - boundary.heightA) * lo, h1 = boundary.heightA + (boundary.heightB - boundary.heightA) * hi;
        const key = [...p0, ...p1, ...t0, ...t1, h0, h1].map(v => Math.round(v * 1e5)).join(':');
        if (seen.has(key)) continue; seen.add(key);
        // A wall cut may swallow the stair edge. Retain the vertical cheek on the surveyed boundary and cap
        // only the intervening cut, using its actual ground-edge height. A sloped cheek would open triangular
        // slits at every change of tread height; a projected top cap stays continuous across those risers.
        out.push(...surfaceFace([t0, t1, top(hi, h1), top(lo, h0)], boundary.tag, cellSize));
        if (!collinear) out.push(...surfaceFace([p0, p1, t1, t0], boundary.tag, cellSize));
      }
    }
  }
  return out;
}

export interface StairsSpec {
  readonly id: string;
  /** Working-frame polyline of the flight; only its first and last points are used. */
  readonly axis: readonly Pt[];
  readonly width: number;
  readonly steps: number;
}

export interface StairsResult {
  readonly pieces: GroundPiece[];
  /** Footprints: other ground meshes neither draw nor collide inside them. */
  readonly zones: Ring[];
  readonly collisionFloors: GroundCollisionFloor[];
  readonly boundaries: GroundBoundary[];
  readonly flights: { id: string; steps: number; width: number; run: number; rise: number; riser: number; tread: number; bottom: number; top: number }[];
}

/** A working-frame segment split where it crosses a cell edge and into pieces of at most GRID metres, with each
 *  piece's cell. */
function segmentPieces(a: Pt, b: Pt, cellSize: number): [Pt, Pt, string][] {
  const ts = new Set<number>([0, 1]);
  // cell edges: x = k * cellSize, and runtime z = -y = k * cellSize
  for (const [i, sign] of [[0, 1], [1, -1]] as const) {
    const pa = a[i] * sign, pb = b[i] * sign;
    if (pa === pb) continue;
    for (let k = Math.ceil(Math.min(pa, pb) / cellSize); k * cellSize < Math.max(pa, pb); k++) ts.add((k * cellSize - pa) / (pb - pa));
  }
  const sorted = [...ts].filter(t => t >= 0 && t <= 1).sort((p, q) => p - q);
  const at = (t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const out: [Pt, Pt, string][] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const t0 = sorted[i]!, t1 = sorted[i + 1]!, n = Math.max(1, Math.ceil(len * (t1 - t0) / GRID));
    for (let k = 0; k < n; k++) {
      const p = at(t0 + (t1 - t0) * k / n), q = at(t0 + (t1 - t0) * (k + 1) / n);
      out.push([p, q, cellOf((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, cellSize)]);
    }
  }
  return out;
}

/** Flights of steps (plan section 4.2, decision 0005) from OpenStreetMap ways tagged with a width and a step count.
 *  The footprint is the way's chord widened to the tagged width; the rise is the city terrain between the footprint's
 *  lower and upper edges (median across the width); the run is split into the tagged number of treads, tread k flat
 *  at h0 + (k + 0.5) x riser. The same tread/riser meshes collide. Width-median heights can differ substantially
 *  from raw terrain near retaining walls, so that raw terrain must not remain a second collision surface. */
export function buildStairs(specs: readonly StairsSpec[], terrain: TerrainGrid, cellSize: number): StairsResult {
  const heightAt = (p: Pt) => sampleTerrain(terrain, p[0], -p[1]);
  const pieces: GroundPiece[] = [], zones: Ring[] = [], flights: StairsResult['flights'] = [];
  const collisionFloors: GroundCollisionFloor[] = [], boundaries: GroundBoundary[] = [];
  const scale = UV_SCALE.slabs;
  const quad = (p: Pt, q: Pt, cell: string, bot: [number, number], top: [number, number]) => {
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    pieces.push({ cell, finish: 'slabs', level: 'raised', tag: 'stairs',
      positions: [p[0], top[0], -p[1], q[0], top[1], -q[1], q[0], bot[1], -q[1], p[0], bot[0], -p[1]],
      uvs: [0, top[0] / scale, len / scale, top[1] / scale, len / scale, bot[1] / scale, 0, bot[0] / scale],
      // both windings: whether a face is seen from up- or downhill depends on the terrain on its far side
      indices: [0, 2, 1, 0, 3, 2, 0, 1, 2, 0, 2, 3] });
  };
  for (const spec of specs) {
    if (spec.axis.length < 2 || spec.axis.some(p => !p.every(Number.isFinite)) || !(spec.width > 0) || !Number.isFinite(spec.width) || !Number.isInteger(spec.steps) || spec.steps < 1) throw new Error(`invalid stair flight ${spec.id}`);
    let a = spec.axis[0]!, b = spec.axis[spec.axis.length - 1]!;
    if (heightAt(b) < heightAt(a)) [a, b] = [b, a];
    const run = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (run < 1e-4) throw new Error(`stair flight ${spec.id} has no run`);
    const u: Pt = [(b[0] - a[0]) / run, (b[1] - a[1]) / run], v: Pt = [-u[1], u[0]], half = spec.width / 2;
    const at = (s: number, t: number): Pt => [a[0] + u[0] * s + v[0] * t, a[1] + u[1] * s + v[1] * t];
    const across = (s: number) => { const hs: number[] = []; for (let t = -half; t <= half + 1e-9; t += 0.5) hs.push(heightAt(at(s, t))); hs.sort((p, q) => p - q); return hs[Math.floor(hs.length / 2)]!; };
    const h0 = across(0), h1 = across(run), n = spec.steps, riser = (h1 - h0) / n, tread = run / n;
    if (!(riser > 0)) throw new Error(`stair flight ${spec.id} has no positive terrain rise`);
    const H = (k: number) => h0 + (k + 0.5) * riser;
    const zone = ensureCcw([at(0, -half), at(run, -half), at(run, half), at(0, half)]);
    zones.push(zone);
    collisionFloors.push({ zone, minHeight: H(0) });
    for (const t of [-half, half]) for (let k = 0; k < n; k++) boundaries.push({ a: at(k * tread, t), b: at((k + 1) * tread, t), heightA: H(k), heightB: H(k), tag: 'stairs-join' });
    const landingHeight = H(n - 1) + riser;
    boundaries.push({ a: at(0, -half), b: at(0, half), heightA: H(0), heightB: H(0), tag: 'stairs-join' }, { a: at(run, -half), b: at(run, half), heightA: H(n - 1), heightB: H(n - 1), tag: 'stairs-join', landing: { flight: spec.id, direction: u, depth: tread, maxHeight: landingHeight } });
    for (let k = 0; k < n; k++) {
      const rect: [number, number][] = [at(k * tread, -half), at((k + 1) * tread, -half), at((k + 1) * tread, half), at(k * tread, half)];
      const xs = rect.map(p => p[0]), zs = rect.map(p => -p[1]);
      for (let cx = Math.floor(Math.min(...xs) / cellSize); cx * cellSize < Math.max(...xs); cx++) for (let cz = Math.floor(Math.min(...zs) / cellSize); cz * cellSize < Math.max(...zs); cz++) {
        const square: [number, number][] = [[cx * cellSize, -(cz + 1) * cellSize], [(cx + 1) * cellSize, -(cz + 1) * cellSize], [(cx + 1) * cellSize, -cz * cellSize], [cx * cellSize, -cz * cellSize]];
        const cell = cellOf((cx + 0.5) * cellSize, -(cz + 0.5) * cellSize, cellSize);
        for (const part of polygonClipping.intersection([[rect]], [[square]]) as [number, number][][][]) {
          const flat: number[] = [];
          for (const p of part[0]!.slice(0, -1)) flat.push(p[0], p[1]);
          const tri = earcut(flat, undefined, 2);
          if (!tri.length) continue;
          const positions: number[] = [], uvs: number[] = [];
          for (let i = 0; i < flat.length; i += 2) { positions.push(flat[i]!, H(k), -flat[i + 1]!); uvs.push(flat[i]! / scale, flat[i + 1]! / scale); }
          faceUp(positions, tri);
          pieces.push({ cell, finish: 'slabs', level: 'raised', tag: 'stairs', positions, uvs, indices: tri });
        }
      }
    }
    // Risers across the width at every tread edge; the first and last close onto the terrain at the landings.
    for (let k = 0; k <= n; k++) {
      for (const [p, q, cell] of segmentPieces(at(k * tread, -half), at(k * tread, half), cellSize)) {
        const edgeHeight = k === 0 ? H(0) : H(n - 1);
        const lo: [number, number] = k === 0 || k === n ? [Math.min(edgeHeight, heightAt(p)) - 0.3, Math.min(edgeHeight, heightAt(q)) - 0.3] : [H(k - 1), H(k - 1)];
        const hi: [number, number] = k === n ? [H(n - 1), H(n - 1)] : [H(k), H(k)];
        quad(p, q, cell, lo, hi);
      }
    }
    // The stair body stops at its tread. Any higher surrounding ground is joined from its actual clipped edge
    // by buildGround, rather than creating an uncapped raw-terrain wedge above the stair's own top.
    for (const t of [-half, half]) for (let k = 0; k < n; k++) {
      for (const [p, q, cell] of segmentPieces(at(k * tread, t), at((k + 1) * tread, t), cellSize)) {
        quad(p, q, cell, [Math.min(H(k), heightAt(p)) - 0.3, Math.min(H(k), heightAt(q)) - 0.3], [H(k), H(k)]);
      }
    }
    flights.push({ id: spec.id, steps: n, width: spec.width, run, rise: h1 - h0, riser, tread, bottom: h0, top: h1 });
  }
  return { pieces, zones, flights, collisionFloors, boundaries };
}

export interface RegisterStairsOptions {
  /** Street parts that touch within this distance form one flight, in metres. */
  readonly joinDistance: number;
  /** Least terrain slope across a group for it to be drawn as a flight. */
  readonly minSlope: number;
  /** The uphill direction must lie within this angle of a polygon edge's normal, in degrees. */
  readonly maxEdgeAngleDeg: number;
  /** Least share of its oriented bounding rectangle a group must fill to be drawn as a straight flight. */
  readonly minFill: number;
  /** An OSM steps way counts for a group when its chord crosses it within this angle of the uphill direction. */
  readonly maxWayAngleDeg: number;
  /** Riser for groups no crossing OSM way gives a step count, in metres. */
  readonly riser: number;
  /** A flight whose terrain rise per step is lower than this is not drawn (the terrain does not resolve it). */
  readonly minRiser: number;
}

export interface RegisterFlight {
  readonly id: string;
  readonly parts: string[];
  readonly status: 'drawn' | 'flat' | 'no-edge' | 'not-straight' | 'shallow';
  readonly slope: number;
  /** Share of the oriented rectangle the outline fills, and the riser the terrain gives, where they were measured. */
  readonly fill: number | null;
  readonly riser: number | null;
  readonly osmWay: string | null;
  readonly spec: StairsSpec | null;
}

/** Straight flights from the city's street parts typed Portaat (YLRE), the surveyed outline of the public steps
 *  (decision 0006). Touching parts form one group; its treads run along the group's polygon edge whose normal is
 *  nearest the terrain's uphill direction (a plane fitted inside the group), its foot is the group's lowest edge and
 *  its width the group's extent along that edge. An OSM steps way whose chord crosses the group in that direction
 *  gives the step count, and where it also carries a width it gives the run beyond the group: the city outlines only
 *  the public foot of the Cathedral's flights. Otherwise the terrain rise sets the count at about `riser` per step.
 *  A group that is not one straight outline is tried part by part. The result feeds buildStairs; `osmWays` lists the
 *  ways a drawn flight took over. */
export function registerFlights(parts: readonly LocalPolygon[], ways: readonly { id: string; axis: readonly Pt[]; width: number | null; steps: number | null }[], terrain: TerrainGrid, area: { minX: number; maxX: number; minZ: number; maxZ: number }, opts: RegisterStairsOptions): { flights: RegisterFlight[]; osmWays: Set<string> } {
  const heightAt = (p: Pt) => sampleTerrain(terrain, p[0], -p[1]);
  const stairs = parts.filter(p => String(p.properties['alatyyppi'] ?? '') === 'Portaat' && p.bbox[2] >= area.minX && p.bbox[0] <= area.maxX && -p.bbox[1] >= area.minZ && -p.bbox[3] <= area.maxZ);
  // Groups of touching parts (union-find on vertex-to-ring distance).
  const parent = stairs.map((_, i) => i);
  const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]!));
  for (let i = 0; i < stairs.length; i++) for (let j = i + 1; j < stairs.length; j++) {
    const a = stairs[i]!, b = stairs[j]!;
    if (a.bbox[0] > b.bbox[2] + opts.joinDistance || b.bbox[0] > a.bbox[2] + opts.joinDistance || a.bbox[1] > b.bbox[3] + opts.joinDistance || b.bbox[1] > a.bbox[3] + opts.joinDistance) continue;
    if (a.rings[0]!.some(p => ringDistance(p, b.rings[0]!) <= opts.joinDistance) || b.rings[0]!.some(p => ringDistance(p, a.rings[0]!) <= opts.joinDistance)) parent[find(i)] = find(j);
  }
  const groups = new Map<number, LocalPolygon[]>();
  stairs.forEach((p, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), p]));
  const osmWays = new Set<string>();
  const flightFor = (members: readonly LocalPolygon[]): RegisterFlight => {
    const ids = members.map(m => m.id).sort();
    const id = `ylre-${ids.join('+')}`;
    const geoms = members.map(m => [m.rings[0]!.map(p => [p[0], p[1]] as [number, number])]);
    const merged = polygonClipping.union(geoms[0]!, ...geoms.slice(1)) as [number, number][][][];
    const ring: Ring = merged.sort((x, y) => Math.abs(signedArea(y[0]!.slice(0, -1) as Ring)) - Math.abs(signedArea(x[0]!.slice(0, -1) as Ring)))[0]![0]!.slice(0, -1) as Ring;
    const [x0, y0, x1, y1] = bbox([ring]);
    // Plane fit h = a x + b y + c over samples inside the group.
    let n = 0, sx = 0, sy = 0, sh = 0, sxx = 0, syy = 0, sxy = 0, sxh = 0, syh = 0;
    for (let x = x0 + 0.25; x < x1; x += 0.5) for (let y = y0 + 0.25; y < y1; y += 0.5) {
      if (!pointInRing([x, y], ring)) continue;
      const h = heightAt([x, y]), dx = x - x0, dy = y - y0;
      n++; sx += dx; sy += dy; sh += h; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; sxh += dx * h; syh += dy * h;
    }
    const cxx = sxx - sx * sx / n, cyy = syy - sy * sy / n, cxy = sxy - sx * sy / n, cxh = sxh - sx * sh / n, cyh = syh - sy * sh / n, det = cxx * cyy - cxy * cxy;
    const ga = n >= 3 && Math.abs(det) > 1e-9 ? (cxh * cyy - cyh * cxy) / det : 0, gb = n >= 3 && Math.abs(det) > 1e-9 ? (cyh * cxx - cxh * cxy) / det : 0;
    const slope = Math.hypot(ga, gb);
    const base = { id, parts: ids, slope: Math.round(slope * 1000) / 1000, fill: null as number | null, riser: null as number | null, osmWay: null as string | null, spec: null };
    if (merged.length > 1) return { ...base, status: 'not-straight' };
    if (slope < opts.minSlope) return { ...base, status: 'flat' };
    const g: Pt = [ga / slope, gb / slope];
    // The edge normal nearest the uphill direction (edges of at least 1 m).
    let u: Pt | null = null, best = Math.cos(opts.maxEdgeAngleDeg * Math.PI / 180);
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]!, q = ring[(i + 1) % ring.length]!, len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (len < 1) continue;
      let nx = -(q[1] - p[1]) / len, ny = (q[0] - p[0]) / len;
      if (nx * g[0] + ny * g[1] < 0) { nx = -nx; ny = -ny; }
      const c = nx * g[0] + ny * g[1];
      if (c > best) { best = c; u = [nx, ny]; }
    }
    if (!u) return { ...base, status: 'no-edge' };
    const v: Pt = [-u[1], u[0]];
    const S = ring.map(p => p[0] * u![0] + p[1] * u![1]), T = ring.map(p => p[0] * v[0] + p[1] * v[1]);
    const s0 = Math.min(...S), s1 = Math.max(...S), t0 = Math.min(...T), t1 = Math.max(...T);
    const fill = Math.round(Math.abs(signedArea(ring)) / ((s1 - s0) * (t1 - t0)) * 100) / 100;
    if (fill < opts.minFill) return { ...base, fill, status: 'not-straight' };
    // OSM ways whose chord crosses the group, along the uphill direction.
    const cosWay = Math.cos(opts.maxWayAngleDeg * Math.PI / 180);
    const crossing = ways.filter(w => {
      const a = w.axis[0]!, b = w.axis[w.axis.length - 1]!, L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L === 0 || Math.abs(((b[0] - a[0]) * u![0] + (b[1] - a[1]) * u![1]) / L) < cosWay) return false;
      for (let k = 0; k <= 40; k++) if (pointInRing([a[0] + (b[0] - a[0]) * k / 40, a[1] + (b[1] - a[1]) * k / 40], ring)) return true;
      return false;
    }).sort((p, q) => (q.steps ?? 0) - (p.steps ?? 0));
    const way = crossing.find(w => w.steps) ?? null;
    let run = s1 - s0;
    if (way?.width) for (const p of [way.axis[0]!, way.axis[way.axis.length - 1]!]) run = Math.max(run, p[0] * u[0] + p[1] * u[1] - s0);
    const tc = (t0 + t1) / 2, foot: Pt = [u[0] * s0 + v[0] * tc, u[1] * s0 + v[1] * tc], top: Pt = [foot[0] + u[0] * run, foot[1] + u[1] * run];
    const across = (o: Pt) => { const hs: number[] = []; for (let t = t0; t <= t1 + 1e-9; t += 0.5) hs.push(heightAt([o[0] + v[0] * (t - tc), o[1] + v[1] * (t - tc)])); return hs.sort((p, q) => p - q)[hs.length >> 1]!; };
    const rise = across(top) - across(foot);
    const steps = way?.steps ?? Math.max(2, Math.round(rise / opts.riser));
    const riser = Math.round(rise / steps * 1000) / 1000;
    // The terrain must confirm the flight: a riser this low means the terrain does not resolve it.
    if (riser < opts.minRiser) return { ...base, fill, riser, osmWay: way?.id ?? null, status: 'shallow' };
    for (const w of crossing) osmWays.add(w.id);
    return { ...base, fill, riser, osmWay: way?.id ?? null, status: 'drawn', spec: { id, axis: [foot, top], width: t1 - t0, steps } };
  };
  // A group that is not one straight flight is tried part by part.
  const flights: RegisterFlight[] = [];
  for (const members of groups.values()) {
    const whole = flightFor(members);
    if (whole.status === 'not-straight' && members.length > 1) flights.push(...members.map(m => flightFor([m])));
    else flights.push(whole);
  }
  return { flights, osmWays };
}

export interface WallOptions {
  /** The ground on each side of a wall takes the terrain this far out from the wall line, in metres. */
  readonly sideDistance: number;
  /** A segment is a wall where the two sides differ by at least this much (median along it), in metres. */
  readonly minHeight: number;
  /** Width of the cut along the wall line that separates the ground of the two sides, in metres. */
  readonly gap: number;
}

/** Prefer the current surveyed wall footprint when an older, nearby OSM line cuts through a carriageway.
 *  This only reconciles a complete line with one matching register wall: every segment must have a parallel
 *  surveyed edge within 2.5 m. The original OSM/source terrain stay unchanged, and unrelated walls stay exact. */
export function reconcileRegisterWalls(specs: readonly { id: string; line: readonly Pt[] }[], parts: readonly LocalPolygon[], maxDistance = 2.5) {
  const walls = parts.filter(p => p.properties['paatyyppi'] === 'Varusteet' && p.properties['alatyyppi'] === 'Tukimuuri');
  const roads = new PolygonGrid(parts.filter(p => p.properties['paatyyppi'] === 'Ajorata' && p.properties['alatyyppi'] === 'Ajorata'), 16);
  const alignments: { id: string; registerId: string; source: readonly Pt[]; authored: Pt[]; maxDeviation: number }[] = [];
  const adjusted = specs.map(spec => {
    const inRoad = spec.line.some((a, i) => i + 1 < spec.line.length && [0.25, 0.5, 0.75].some(t => {
      const b = spec.line[i + 1]!, p: Pt = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      return roads.candidates(...p).some(r => pointInPolygon(p, r.rings) && ringDistance(p, r.rings[0]!) > 0.1);
    }));
    if (!inRoad) return spec;
    type Edge = { a: Pt; b: Pt; distance: number };
    const candidates = walls.flatMap(wall => {
      const matches = spec.line.slice(0, -1).map((a, i): Edge | undefined => {
        const b = spec.line[i + 1]!, dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
        if (length < 0.1) return undefined;
        const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        return wall.rings.flatMap(ring => ring.flatMap((p, j): Edge[] => {
          const q = ring[(j + 1) % ring.length]!, ex = q[0] - p[0], ey = q[1] - p[1], edgeLength = Math.hypot(ex, ey);
          if (edgeLength < 1 || Math.abs((dx * ex + dy * ey) / (length * edgeLength)) < Math.cos(5 * Math.PI / 180)) return [];
          const distance = segmentDistance(mid, p, q).d;
          if (distance > maxDistance || segmentDistance(a, p, q).d > maxDistance || segmentDistance(b, p, q).d > maxDistance) return [];
          return [{ a: p, b: q, distance }];
        })).sort((p, q) => p.distance - q.distance)[0];
      });
      if (matches.some(m => !m)) return [];
      const edges = matches as Edge[];
      const line = spec.line.map((p, i): Pt => {
        const left = edges[i - 1], right = edges[i];
        if (!left || !right) { const edge = left ?? right!; return segmentDistance(p, edge.a, edge.b).q; }
        const u: Pt = [left.b[0] - left.a[0], left.b[1] - left.a[1]], v: Pt = [right.b[0] - right.a[0], right.b[1] - right.a[1]];
        const cross = u[0] * v[1] - u[1] * v[0];
        if (Math.abs(cross) > Math.hypot(...u) * Math.hypot(...v) * 1e-5) {
          const t = ((right.a[0] - left.a[0]) * v[1] - (right.a[1] - left.a[1]) * v[0]) / cross;
          return [left.a[0] + u[0] * t, left.a[1] + u[1] * t];
        }
        const a = segmentDistance(p, left.a, left.b).q, b = segmentDistance(p, right.a, right.b).q;
        return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      });
      const maxDeviation = Math.max(...line.map((p, i) => Math.hypot(p[0] - spec.line[i]![0], p[1] - spec.line[i]![1])));
      if (maxDeviation > maxDistance || line.some((p, i) => i > 0 && Math.hypot(p[0] - line[i - 1]![0], p[1] - line[i - 1]![1]) < 0.1)) return [];
      return [{ wall, line, maxDeviation, score: edges.reduce((s, e) => s + e.distance, 0) }];
    }).sort((a, b) => a.score - b.score);
    const best = candidates[0];
    if (!best || best.maxDeviation < 0.01) return spec;
    alignments.push({ id: spec.id, registerId: best.wall.id, source: spec.line, authored: best.line, maxDeviation: best.maxDeviation });
    return { ...spec, line: best.line };
  });
  return { specs: adjusted, alignments };
}

export interface WallsResult {
  /** Vertical faces, drawn and colliding. */
  readonly pieces: GroundPiece[];
  /** Thin bands along the wall lines that every ground piece is cut by. */
  readonly cuts: Ring[];
  /** Ground height at a working-frame point: the terrain, except within `sideDistance` of a wall, where it is the
   *  terrain at `sideDistance` out on the same side. */
  readonly surface: (x: number, y: number) => number;
  readonly walls: { id: string; segments: number; length: number; medianHeight: number; maxHeight: number;
    /** Working-frame authored replacements; the source OSM geometry is never modified. */
    stairBoundaryJoins: { source: readonly [Pt, Pt]; authored: readonly [Pt, Pt]; maxDeviation: number; kind: 'stair-cheek' | 'connected-corner' }[] }[];
  readonly collisionFloors: GroundCollisionFloor[];
  /** Seal the thin cut to the actual clipped ground edges, including intermediate height changes and ends. */
  readonly closeGround: (pieces: readonly GroundPiece[]) => GroundPiece[];
}

/** Retaining walls (decision 0005) from OpenStreetMap `barrier=retaining_wall` ways. The city terrain smooths a wall
 *  into a slope a metre or two wide, which the 4 m ground grid drew as a ramp. Along each segment the terrain is read
 *  `sideDistance` out on both sides; a segment whose sides differ by at least `minHeight` is a wall. The ground is cut
 *  along its line, each side keeps its own level up to the line, and a vertical face joins the two levels. Stretches
 *  inside `exclude` (flights of steps, entrance terraces) are left to those. */
export function buildRetainingWalls(specs: readonly { id: string; line: readonly Pt[] }[], terrain: TerrainGrid, exclude: readonly Ring[], opts: WallOptions, cellSize: number, stairOwnership?: { boundaries: readonly GroundBoundary[]; maxDistance: number }): WallsResult {
  const T = (p: Pt) => sampleTerrain(terrain, p[0], -p[1]), D = opts.sideDistance, e = opts.gap / 2;
  const segs: { a: Pt; b: Pt; box: [number, number, number, number]; cut: Ring; cutBounds: [number, number, number, number]; stairOwned: boolean; knots: { t: number; high: number }[] }[] = [], cuts: Ring[] = [], pieces: GroundPiece[] = [], walls: WallsResult['walls'] = [];
  const collisionFloors: GroundCollisionFloor[] = [];
  const scale = UV_SCALE.slabs;
  // Adjacent tread segments share one surveyed straight boundary. It owns the authored cheek when a nearly
  // parallel secondary OSM run falls inside the register's existing join tolerance, not a second folded ribbon.
  const runs: { a: Pt; u: Pt; lo: number; hi: number }[] = [];
  for (const boundary of stairOwnership?.boundaries ?? []) {
    const dx = boundary.b[0] - boundary.a[0], dy = boundary.b[1] - boundary.a[1], length = Math.hypot(dx, dy);
    if (length < 1e-8) continue;
    let run = runs.find(r => {
      if (Math.abs(r.u[0] * dy - r.u[1] * dx) >= length * 1e-7 || Math.abs((boundary.a[0] - r.a[0]) * r.u[1] - (boundary.a[1] - r.a[1]) * r.u[0]) >= 1e-5) return false;
      const ta = (boundary.a[0] - r.a[0]) * r.u[0] + (boundary.a[1] - r.a[1]) * r.u[1], tb = (boundary.b[0] - r.a[0]) * r.u[0] + (boundary.b[1] - r.a[1]) * r.u[1];
      return Math.max(ta, tb) >= r.lo - 1e-5 && Math.min(ta, tb) <= r.hi + 1e-5;
    });
    if (!run) { run = { a: boundary.a, u: [dx / length, dy / length], lo: 0, hi: length }; runs.push(run); }
    const project = (p: Pt) => (p[0] - run.a[0]) * run.u[0] + (p[1] - run.a[1]) * run.u[1];
    run.lo = Math.min(run.lo, project(boundary.a), project(boundary.b)); run.hi = Math.max(run.hi, project(boundary.a), project(boundary.b));
  }
  const onRun = (p: Pt, run: typeof runs[number], tolerance: number): boolean => {
    const t = (p[0] - run.a[0]) * run.u[0] + (p[1] - run.a[1]) * run.u[1];
    return t >= run.lo - 1e-6 && t <= run.hi + 1e-6 && Math.abs((p[0] - run.a[0]) * run.u[1] - (p[1] - run.a[1]) * run.u[0]) <= tolerance;
  };
  for (const spec of specs) {
    const heights: number[] = [];
    let kept = 0, length = 0;
    const line: Pt[] = spec.line.map(p => [p[0], p[1]]), owned = new Set<number>();
    for (let k = 0; k + 1 < spec.line.length; k++) {
      const a = spec.line[k]!, b = spec.line[k + 1]!, len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1e-8) continue;
      const run = runs.filter(r => Math.abs(((b[0] - a[0]) * r.u[0] + (b[1] - a[1]) * r.u[1]) / len) >= Math.cos(5 * Math.PI / 180) && onRun(a, r, stairOwnership!.maxDistance) && onRun(b, r, stairOwnership!.maxDistance))
        .sort((p, q) => segmentDistance(a, p.a, [p.a[0] + p.u[0] * p.hi, p.a[1] + p.u[1] * p.hi]).d - segmentDistance(a, q.a, [q.a[0] + q.u[0] * q.hi, q.a[1] + q.u[1] * q.hi]).d)[0];
      if (!run) continue;
      const project = (p: Pt): Pt => { const t = (p[0] - run.a[0]) * run.u[0] + (p[1] - run.a[1]) * run.u[1]; return [run.a[0] + run.u[0] * t, run.a[1] + run.u[1] * t]; };
      line[k] = project(a); line[k + 1] = project(b); owned.add(k);
    }
    const stairBoundaryJoins = spec.line.flatMap((a, k) => {
      if (k + 1 === spec.line.length) return [];
      const b = spec.line[k + 1]!, pa = line[k]!, pb = line[k + 1]!, deviation = Math.max(Math.hypot(a[0] - pa[0], a[1] - pa[1]), Math.hypot(b[0] - pb[0], b[1] - pb[1]));
      return deviation > 1e-8 ? [{ source: [a, b] as const, authored: [pa, pb] as const, maxDeviation: deviation, kind: owned.has(k) ? 'stair-cheek' as const : 'connected-corner' as const }] : [];
    });
    // The line's segments, with the stretches inside `exclude` cut out (to 0.25 m).
    const pieces0: [Pt, Pt][] = [];
    for (let k = 0; k + 1 < line.length; k++) {
      const a = line[k]!, b = line[k + 1]!, len = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(len / 0.25));
      const at = (i: number): Pt => [a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n];
      let start = -1;
      for (let i = 0; i <= n; i++) {
        const out = !exclude.some(z => pointInRing(at(i), z) && ringDistance(at(i), z) > 1e-6);
        if (out && start < 0) start = i;
        if ((!out || i === n) && start >= 0) { const end = out ? i : i - 1; if (end > start) pieces0.push([at(start), at(end)]); start = -1; }
      }
    }
    for (const [a, b] of pieces0) {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.1) continue;
      const u: Pt = [(b[0] - a[0]) / len, (b[1] - a[1]) / len], n: Pt = [-u[1], u[0]];
      const diffs: number[] = [];
      for (let s = 0.5; s < len; s += 1) { const q: Pt = [a[0] + u[0] * s, a[1] + u[1] * s]; diffs.push(T([q[0] + n[0] * D, q[1] + n[1] * D]) - T([q[0] - n[0] * D, q[1] - n[1] * D])); }
      if (!diffs.length) diffs.push(T([(a[0] + b[0]) / 2 + n[0] * D, (a[1] + b[1]) / 2 + n[1] * D]) - T([(a[0] + b[0]) / 2 - n[0] * D, (a[1] + b[1]) / 2 - n[1] * D]));
      const med = [...diffs].sort((p, q) => p - q)[Math.floor(diffs.length / 2)]!;
      if (Math.abs(med) < opts.minHeight) continue;
      kept++; length += len; heights.push(...diffs.map(Math.abs));
      const box: [number, number, number, number] = [Math.min(a[0], b[0]) - D, Math.min(a[1], b[1]) - D, Math.max(a[0], b[0]) + D, Math.max(a[1], b[1]) + D];
      const cut = ensureCcw([[a[0] - u[0] * e - n[0] * e, a[1] - u[1] * e - n[1] * e], [b[0] + u[0] * e - n[0] * e, b[1] + u[1] * e - n[1] * e], [b[0] + u[0] * e + n[0] * e, b[1] + u[1] * e + n[1] * e], [a[0] - u[0] * e + n[0] * e, a[1] - u[1] * e + n[1] * e]]);
      const segment = { a, b, box, cut, cutBounds:bbox([cut]), stairOwned: runs.some(r => onRun(a, r, 1e-5) && onRun(b, r, 1e-5)), knots: [] as { t: number; high: number }[] };
      segs.push(segment); cuts.push(cut);
      // The safety field must also stay below wall-side surfaces where their authored vertical break replaces
      // the terrain's broad slope. A conservative source-grid minimum cannot intrude through either side.
      let floor = Infinity;
      const ix0 = Math.max(0, Math.floor((box[0] - terrain.x0) / terrain.resolution)), ix1 = Math.min(terrain.nx - 1, Math.ceil((box[2] - terrain.x0) / terrain.resolution));
      const iz0 = Math.max(0, Math.floor((-box[3] - terrain.z0) / terrain.resolution)), iz1 = Math.min(terrain.nz - 1, Math.ceil((-box[1] - terrain.z0) / terrain.resolution));
      for (let z = iz0; z <= iz1; z++) for (let x = ix0; x <= ix1; x++) floor = Math.min(floor, terrain.heights[z * terrain.nx + x]!);
      // OSM wall ways can extend beyond the finite released terrain. There is no safety grid to lower there.
      if (ix0 <= ix1 && iz0 <= iz1) collisionFloors.push({ zone: [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]], minHeight: floor });
      for (const [p, q, cell] of segmentPieces(a, b, cellSize)) {
        const side = (r: Pt, sgn: number) => T([r[0] + n[0] * D * sgn, r[1] + n[1] * D * sgn]);
        const lo = [Math.min(side(p, 1), side(p, -1)) - 0.1, Math.min(side(q, 1), side(q, -1)) - 0.1], hi = [Math.max(side(p, 1), side(p, -1)), Math.max(side(q, 1), side(q, -1))];
        segment.knots.push({ t: segmentDistance(p, a, b).t, high: hi[0]! }, { t: segmentDistance(q, a, b).t, high: hi[1]! });
        if (segment.stairOwned) continue; // buildGround emits one vertical cheek on the surveyed stair edge.
        const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
        pieces.push({ cell, finish: 'slabs', level: 'raised', tag: 'wall',
          positions: [p[0], hi[0]!, -p[1], q[0], hi[1]!, -q[1], q[0], lo[1]!, -q[1], p[0], lo[0]!, -p[1]],
          uvs: [0, hi[0]! / scale, l / scale, hi[1]! / scale, l / scale, lo[1]! / scale, 0, lo[0]! / scale],
          indices: [0, 2, 1, 0, 3, 2, 0, 1, 2, 0, 2, 3] });
      }
    }
    if (!kept) continue;
    heights.sort((p, q) => p - q);
    walls.push({ id: spec.id, segments: kept, length, medianHeight: heights[Math.floor(heights.length / 2)]!, maxHeight: heights[heights.length - 1]!, stairBoundaryJoins });
  }
  const surface = (x: number, y: number): number => {
    let best = D, foot: Pt | null = null;
    for (const sg of segs) {
      if (x < sg.box[0] || x > sg.box[2] || y < sg.box[1] || y > sg.box[3]) continue;
      const r = segmentDistance([x, y], sg.a, sg.b);
      if (r.d < best) { best = r.d; foot = r.q; }
    }
    if (!foot || best < 1e-6) return sampleTerrain(terrain, x, -y);
    const k = D / best;
    return T([foot[0] + (x - foot[0]) * k, foot[1] + (y - foot[1]) * k]);
  };
  for (const segment of segs) segment.knots.sort((a, b) => a.t - b.t);
  const closeGround = (ground: readonly GroundPiece[]): GroundPiece[] => {
    const out: GroundPiece[] = [], seen = new Set<string>();
    for (const piece of ground) for (const [p, q] of boundaryEdges(piece)) for (const segment of segs) {
      if (segment.stairOwned) continue;
      const a: Pt = [p[0], -p[2]], b: Pt = [q[0], -q[2]];
      // A seal needs both endpoints on this cut. Reject distant edges before
      // the ring-distance calculations; larger districts have millions of them.
      const box = segment.cutBounds, tolerance = 2e-5;
      if (a[0] < box[0]-tolerance || a[0] > box[2]+tolerance || a[1] < box[1]-tolerance || a[1] > box[3]+tolerance ||
          b[0] < box[0]-tolerance || b[0] > box[2]+tolerance || b[1] < box[1]-tolerance || b[1] > box[3]+tolerance) continue;
      if (ringDistance(a, segment.cut) > 2e-5 || ringDistance(b, segment.cut) > 2e-5 || ringDistance([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], segment.cut) > 2e-5) continue;
      const pa = segmentDistance(a, segment.a, segment.b), pb = segmentDistance(b, segment.a, segment.b);
      const high = (t: number): number => {
        const knots = segment.knots;
        if (t <= knots[0]!.t) return knots[0]!.high;
        for (let i = 1; i < knots.length; i++) if (t <= knots[i]!.t) {
          const left = knots[i - 1]!, right = knots[i]!, u = right.t === left.t ? 0 : (t - left.t) / (right.t - left.t);
          return left.high + (right.high - left.high) * u;
        }
        return knots[knots.length - 1]!.high;
      };
      const split = [0, 1];
      if (Math.abs(pb.t - pa.t) > 1e-10) for (const knot of segment.knots) { const u = (knot.t - pa.t) / (pb.t - pa.t); if (u > 1e-8 && u < 1 - 1e-8) split.push(u); }
      split.sort((a, b) => a - b);
      const at = (u: number): SurfacePoint => p.map((v, i) => v + (q[i]! - v) * u) as SurfacePoint;
      const center = (point: SurfacePoint): SurfacePoint => { const projection = segmentDistance([point[0], -point[2]], segment.a, segment.b); return [projection.q[0], high(projection.t), -projection.q[1]]; };
      // A finite cross-wall can end on a stair cheek. Its top cap reaches the wall endpoint, while the cheek
      // starts on the cut edge. Join those final vertices vertically too, only within their shared cut.
      for (const boundary of stairOwnership?.boundaries ?? []) {
        const dx = boundary.b[0] - boundary.a[0], dy = boundary.b[1] - boundary.a[1], length = Math.hypot(dx, dy);
        const sx = segment.b[0] - segment.a[0], sy = segment.b[1] - segment.a[1];
        if (length < 1e-8 || Math.abs(sx * dx + sy * dy) >= Math.hypot(sx, sy) * length * Math.cos(5 * Math.PI / 180)) continue;
        const ex = b[0] - a[0], ey = b[1] - a[1], den = ex * dy - ey * dx;
        if (Math.abs(den) < 1e-12) continue;
        const edgeT = ((boundary.a[0] - a[0]) * dy - (boundary.a[1] - a[1]) * dx) / den;
        const project = (point: Pt) => ((point[0] - boundary.a[0]) * dx + (point[1] - boundary.a[1]) * dy) / (length * length);
        const edges: SurfacePoint[] = [];
        if (edgeT >= -1e-8 && edgeT <= 1 + 1e-8) edges.push(at(Math.max(0, Math.min(1, edgeT))));
        else for (const vertex of [p, q]) {
          const point: Pt = [vertex[0], -vertex[2]], t = project(point), projected: Pt = [boundary.a[0] + dx * t, boundary.a[1] + dy * t];
          // At an overlapping authored cheek cut, the final top cap has already projected this actual corner
          // across its half-gap. Use that same corner only when both cut ownership and its physical width agree.
          if (Math.hypot(point[0] - projected[0], point[1] - projected[1]) > e + 2e-5) continue;
          if (!segs.some(other => other.stairOwned && ringDistance(point, other.cut) < 2e-5 &&
            Math.abs((other.a[0] - boundary.a[0]) * dy - (other.a[1] - boundary.a[1]) * dx) <= length * 1e-5 &&
            Math.abs((other.b[0] - boundary.a[0]) * dy - (other.b[1] - boundary.a[1]) * dx) <= length * 1e-5)) continue;
          edges.push([projected[0], vertex[1], -projected[1]]);
        }
        for (const edge of edges) {
          const edgeAlong = project([edge[0], -edge[2]]);
          for (const [end, wallT] of [[segment.a, 0], [segment.b, 1]] as const) {
            if (Math.abs((end[0] - boundary.a[0]) * dy - (end[1] - boundary.a[1]) * dx) > length * 1e-5) continue;
            const endAlong = project(end), lo = Math.max(0, Math.min(edgeAlong, endAlong)), hi = Math.min(1, Math.max(edgeAlong, endAlong));
            if (hi - lo < 1e-8 || !segmentInsideRing(boundary.a, boundary.b, segment.cut).some(([a, b]) => lo >= a - 1e-8 && hi <= b + 1e-8)) continue;
            const top = (t: number): SurfacePoint => [boundary.a[0] + dx * t, high(wallT) + (edge[1] - high(wallT)) * (t - endAlong) / (edgeAlong - endAlong), -(boundary.a[1] + dy * t)];
            const bottom = (t: number): SurfacePoint => [boundary.a[0] + dx * t, boundary.heightA + (boundary.heightB - boundary.heightA) * t, -(boundary.a[1] + dy * t)];
            const ranges = [lo, hi], d0 = top(lo)[1] - bottom(lo)[1], d1 = top(hi)[1] - bottom(hi)[1];
            if (d0 * d1 < 0) ranges.splice(1, 0, lo + (hi - lo) * d0 / (d0 - d1));
            for (let j = 0; j + 1 < ranges.length; j++) {
              const a = ranges[j]!, b = ranges[j + 1]!, points = [top(a), top(b), bottom(b), bottom(a)];
              const key = `end:${points.flat().map(v => Math.round(v * 1e8)).join(':')}`;
              if (seen.has(key)) continue; seen.add(key);
              out.push(...surfaceFace(points, 'wall-join', cellSize));
            }
          }
        }
      }
      for (let i = 0; i + 1 < split.length; i++) {
        if (split[i + 1]! - split[i]! < 1e-8) continue;
        const p0 = at(split[i]!), p1 = at(split[i + 1]!), c0 = center(p0), c1 = center(p1);
        const key = [...p0, ...p1, ...c0, ...c1].map(v => Math.round(v * 1e5)).join(':');
        if (seen.has(key)) continue; seen.add(key);
        // These four corners come from the two meshes being joined. Resampling terrain here would recreate
        // the hole when its intermediate samples depart from the surrounding ground's long triangle chord.
        out.push(...surfaceFace([p0, p1, c1, c0], 'wall-join', cellSize));
      }
    }
    return out;
  };
  return { pieces, cuts, surface, walls, collisionFloors, closeGround };
}

export interface TerraceOptions {
  /** Radius of the flat disk whose morphological opening of the terrain is the smooth ground under a bump. */
  readonly openingRadius: number;
  /** A grid point is part of a bump where the terrain stands this far above the opening. */
  readonly minRise: number;
  /** A bump is an entrance only within this distance of a building footprint and of an OSM steps way. */
  readonly maxFootprintDistance: number;
  readonly maxStepsDistance: number;
  /** Growth of each bump's zone outside footprints, so the skirt below `minRise` is drawn with it, in metres. */
  readonly pad: number;
  /** Height of one terrace level and the mesh spacing the levels are sliced on, in metres. */
  readonly riser: number;
  readonly raster: number;
}

export interface TerraceResult {
  /** Visual treads and faces, plus collision-only terrain quads at the grid's own resolution. */
  readonly pieces: GroundPiece[];
  /** Footprints: the street parts and the fallback grid draw nothing inside them. */
  readonly zones: Ring[];
  readonly terraces: { id: string; steps: string[]; gridPoints: number; area: number; peak: number; levels: number; cells: string[] }[];
}

/** Entrance steps (decision 0005): the city terrain records the granite flights, cheek blocks and landings at
 *  building doors as 1 m bumps, which the 4 m ground grid drew as slab pyramids. A bump is the set of grid points
 *  outside every footprint where the terrain stands more than `minRise` above its flat-disk opening (the opening
 *  keeps planes and slopes and removes features narrower than the disk); a 4-connected bump is an entrance when it
 *  comes within `maxFootprintDistance` of a footprint and within `maxStepsDistance` of an OSM `highway=steps` way.
 *  Its zone (the bump grown by `pad`, as the union of its grid squares with holes filled) is drawn as terraces: the
 *  terrain's rise over the opening, on a `raster` mesh, is rounded to whole `riser` levels by slicing every triangle
 *  along the contours half-way between levels, so treads follow the terrain's own contour lines `level x riser`
 *  above the opening, with risers on the contours. The same tread and riser triangles provide collision; using
 *  the smooth source terrain here would leave feet inside the visible treads or above them. */
export function buildEntranceTerraces(terrain: TerrainGrid, footprints: readonly LocalPolygon[], steps: readonly { id: string; axis: readonly Pt[] }[], exclude: readonly Ring[], area: { minX: number; maxX: number; minZ: number; maxZ: number }, opts: TerraceOptions, cellSize: number): TerraceResult {
  const { nx, nz, resolution: res, heights: H } = terrain;
  const r = Math.round(opts.openingRadius / res), disk: [number, number][] = [];
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dz * dz <= r * r) disk.push([dx, dz]);
  const morph = (src: Float32Array, pick: (a: number, b: number) => number, init: number) => {
    const out = new Float32Array(src.length);
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
      let v = init;
      for (const [dx, dz] of disk) { const xx = x + dx, zz = z + dz; if (xx >= 0 && zz >= 0 && xx < nx && zz < nz) v = pick(v, src[zz * nx + xx]!); }
      out[z * nx + x] = v;
    }
    return out;
  };
  const opened = morph(morph(H, Math.min, Infinity), Math.max, -Infinity);
  const openedGrid: TerrainGrid = { ...terrain, heights: opened };
  const fpGrid = new PolygonGrid(footprints, 32);
  const near = (x: number, y: number, d: number) => { const s = new Set<LocalPolygon>(); for (const dx of [-d, 0, d]) for (const dy of [-d, 0, d]) for (const f of fpGrid.candidates(x + dx, y + dy)) s.add(f); return s; };
  const at = (i: number): Pt => { const x = i % nx; return [terrain.x0 + x * res, -(terrain.z0 + (i - x) / nx * res)]; };
  const bump = new Uint8Array(nx * nz);
  for (let i = 0; i < bump.length; i++) {
    const [x, y] = at(i);
    if (x < area.minX || x > area.maxX || -y < area.minZ || -y > area.maxZ || H[i]! - opened[i]! <= opts.minRise) continue;
    if (fpGrid.containing(x, y).length === 0) bump[i] = 1;
  }
  const pieces: GroundPiece[] = [], zones: Ring[] = [], terraces: TerraceResult['terraces'] = [];
  const seen = new Uint8Array(nx * nz), claimed = new Uint8Array(nx * nz), scale = UV_SCALE.slabs;
  for (let i0 = 0; i0 < bump.length; i0++) {
    if (!bump[i0] || seen[i0]) continue;
    const comp: number[] = [], queue = [i0];
    seen[i0] = 1;
    while (queue.length) {
      const i = queue.pop()!, x = i % nx, z = (i - x) / nx;
      comp.push(i);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const xx = x + dx, zz = z + dz, k = zz * nx + xx;
        if (xx >= 0 && zz >= 0 && xx < nx && zz < nz && bump[k] && !seen[k]) { seen[k] = 1; queue.push(k); }
      }
    }
    const pts = comp.map(at);
    if (pts.some(p => exclude.some(z => pointInRing(p, z)))) continue;
    if (!pts.some(p => [...near(p[0], p[1], opts.maxFootprintDistance)].some(f => ringDistance(p, f.rings[0]!) <= opts.maxFootprintDistance))) continue;
    const stepIds = steps.filter(s => pts.some(p => s.axis.some((a, k) => k + 1 < s.axis.length && segmentDistance(p, a, s.axis[k + 1]!).d <= opts.maxStepsDistance))).map(s => s.id);
    if (!stepIds.length) continue;
    // Zone: the bump grown by `pad` outside footprints, other zones and the excluded areas, so its skirt is drawn too.
    const zone = new Set(comp);
    for (let g = 0; g < Math.round(opts.pad / res); g++) for (const i of [...zone]) {
      const x = i % nx, z = (i - x) / nx;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
        const xx = x + dx, zz = z + dz, k = zz * nx + xx;
        if (xx < 0 || zz < 0 || xx >= nx || zz >= nz || zone.has(k) || claimed[k]) continue;
        const p = at(k);
        if (fpGrid.containing(p[0], p[1]).length || exclude.some(e => pointInRing(p, e))) continue;
        zone.add(k);
      }
    }
    for (const i of zone) claimed[i] = 1;
    const zonePts = [...zone].map(at), h = res / 2;
    const squares = zonePts.map(([x, y]) => [[[x - h, y - h], [x + h, y - h], [x + h, y + h], [x - h, y + h]]] as [number, number][][]);
    const merged = polygonClipping.union(squares[0]!, ...squares.slice(1)) as [number, number][][][];
    const rings = merged.map(poly => ensureCcw(poly[0]!.slice(0, -1).map(p => [p[0], p[1]] as Pt)));
    zones.push(...rings);
    // Vertices of the raster: position, terrain, opening, and the rise over the opening in risers (kept off the
    // level boundaries at half risers so every contour crosses edges, never vertices).
    const [bx0, by0, bx1, by1] = bbox(rings), s = opts.raster;
    const ncx = Math.round((bx1 - bx0) / s), ncy = Math.round((by1 - by0) / s);
    const verts: V[] = [];
    for (let j = 0; j <= ncy; j++) for (let i = 0; i <= ncx; i++) {
      const x = bx0 + i * s, y = by0 + j * s, t = sampleTerrain(terrain, x, -y), o = sampleTerrain(openedGrid, x, -y);
      let u = (t - o) / opts.riser;
      if (Math.abs(u - Math.floor(u) - 0.5) < 1e-4) u += 2e-4;
      verts.push({ x, y, t, o, u });
    }
    const vert = (i: number, j: number) => verts[j * (ncx + 1) + i]!;
    const act = new Uint8Array(ncx * ncy);
    for (let j = 0; j < ncy; j++) for (let i = 0; i < ncx; i++) act[j * ncx + i] = rings.some(rg => pointInRing([bx0 + (i + 0.5) * s, by0 + (j + 0.5) * s], rg)) ? 1 : 0;
    const isAct = (i: number, j: number) => i >= 0 && j >= 0 && i < ncx && j < ncy && act[j * ncx + i] === 1;
    const treads = new Map<string, Buf>(), walls = new Map<string, Buf>();
    const buf = (m: Map<string, Buf>, cell: string) => { let b = m.get(cell); if (!b) m.set(cell, b = { positions: [], uvs: [], indices: [] }); return b; };
    const wall = (cell: string, p: V, q: V, lo: [number, number], hi: [number, number]) => {
      if (hi[0] - lo[0] < 0.005 && hi[1] - lo[1] < 0.005) return;
      const b = buf(walls, cell), o = b.positions.length / 3, len = Math.hypot(q.x - p.x, q.y - p.y);
      b.positions.push(p.x, hi[0], -p.y, q.x, hi[1], -q.y, q.x, lo[1], -q.y, p.x, lo[0], -p.y);
      b.uvs.push(0, hi[0] / scale, len / scale, hi[1] / scale, len / scale, lo[1] / scale, 0, lo[0] / scale);
      // both windings: a riser is seen from below, an outline face from whichever side is lower
      b.indices.push(o, o + 2, o + 1, o, o + 3, o + 2, o, o + 1, o + 2, o, o + 2, o + 3);
    };
    let levels = 0;
    for (let j = 0; j < ncy; j++) for (let i = 0; i < ncx; i++) {
      if (!isAct(i, j)) continue;
      const cell = cellOf(bx0 + (i + 0.5) * s, by0 + (j + 0.5) * s, cellSize);
      for (const tri of [[vert(i, j), vert(i + 1, j), vert(i + 1, j + 1)], [vert(i, j), vert(i + 1, j + 1), vert(i, j + 1)]]) {
        const lo = Math.round(Math.min(...tri.map(v => v.u))), hi = Math.round(Math.max(...tri.map(v => v.u)));
        levels = Math.max(levels, hi);
        for (let k = lo; k <= hi; k++) {
          const poly = clipLevel(clipLevel(tri, k - 0.5, true), k + 0.5, false);
          if (poly.length < 3) continue;
          const b = buf(treads, cell), o = b.positions.length / 3;
          for (const v of poly) { b.positions.push(v.x, v.o + k * opts.riser, -v.y); b.uvs.push(v.x / scale, v.y / scale); }
          for (let f = 1; f + 1 < poly.length; f++) b.indices.push(o, o + f, o + f + 1);
        }
        // Risers where the contour between level k and k + 1 crosses this triangle.
        for (let k = lo; k < hi; k++) {
          const cut: V[] = [];
          for (let e = 0; e < 3; e++) { const a = tri[e]!, c = tri[(e + 1) % 3]!; if ((a.u - k - 0.5) * (c.u - k - 0.5) < 0) cut.push(mix(a, c, (k + 0.5 - a.u) / (c.u - a.u))); }
          if (cut.length === 2) wall(cell, cut[0]!, cut[1]!, [cut[0]!.o + k * opts.riser, cut[1]!.o + k * opts.riser], [cut[0]!.o + (k + 1) * opts.riser, cut[1]!.o + (k + 1) * opts.riser]);
        }
      }
      // Outline: from the tread down (or up) to the terrain that the surrounding ground follows.
      const edges: [boolean, V, V][] = [[!isAct(i - 1, j), vert(i, j), vert(i, j + 1)], [!isAct(i + 1, j), vert(i + 1, j), vert(i + 1, j + 1)], [!isAct(i, j - 1), vert(i, j), vert(i + 1, j)], [!isAct(i, j + 1), vert(i, j + 1), vert(i + 1, j + 1)]];
      for (const [outline, p, q] of edges) {
        if (!outline) continue;
        const tp = p.o + Math.round(p.u) * opts.riser, tq = q.o + Math.round(q.u) * opts.riser;
        wall(cell, p, q, [Math.min(tp, p.t) - 0.05, Math.min(tq, q.t) - 0.05], [Math.max(tp, p.t), Math.max(tq, q.t)]);
      }
    }
    for (const [cell, b] of treads) { faceUp(b.positions, b.indices); pieces.push({ cell, finish: 'slabs', level: 'raised', tag: 'terrace', ...b }); }
    for (const [cell, b] of walls) pieces.push({ cell, finish: 'slabs', level: 'raised', tag: 'terrace', ...b });
    const peak = Math.max(...comp.map(i => H[i]! - opened[i]!));
    const [cx, cz] = [pts.reduce((a, p) => a + p[0], 0) / pts.length, -pts.reduce((a, p) => a + p[1], 0) / pts.length];
    const tag = (v: number) => (v < 0 ? 'm' : 'p') + String(Math.abs(Math.round(v))).padStart(3, '0');
    terraces.push({ id: `terrace-${tag(cx)}-${tag(cz)}`, steps: stepIds, gridPoints: comp.length, area: rings.reduce((a, rg) => a + signedArea(rg), 0), peak, levels, cells: [...new Set([...treads.keys(), ...walls.keys()])].sort() });
  }
  return { pieces, zones, terraces };
}

type Buf = { positions: number[]; uvs: number[]; indices: number[] };
/** A terrace mesh vertex: working-frame position, terrain and opening heights, rise over the opening in risers. */
type V = { x: number; y: number; t: number; o: number; u: number };
const mix = (a: V, b: V, w: number): V => ({ x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w, t: a.t + (b.t - a.t) * w, o: a.o + (b.o - a.o) * w, u: a.u + (b.u - a.u) * w });
/** Clip a convex polygon to the part above (or below) the contour u = level. */
function clipLevel(poly: V[], level: number, keepAbove: boolean): V[] {
  const out: V[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, c = poly[(i + 1) % poly.length]!;
    const inA = keepAbove ? a.u >= level : a.u <= level, inC = keepAbove ? c.u >= level : c.u <= level;
    if (inA) out.push(a);
    if (inA !== inC) out.push(mix(a, c, (level - a.u) / (c.u - a.u)));
  }
  return out;
}

/** Winding check: earcut returns triangles with the ring's orientation; make every ground triangle face +Y. */
export function faceUp(positions: number[], indices: number[]): void {
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3, b = indices[t + 1]! * 3, c = indices[t + 2]! * 3;
    const ux = positions[b]! - positions[a]!, uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!, vz = positions[c + 2]! - positions[a + 2]!;
    // normal y = uz*vx - ux*vz
    if (uz * vx - ux * vz < 0) { const tmp = indices[t + 1]!; indices[t + 1] = indices[t + 2]!; indices[t + 2] = tmp; }
  }
}

export function ringsBbox(r: Ring[]): [number, number, number, number] { return bbox(r); }
