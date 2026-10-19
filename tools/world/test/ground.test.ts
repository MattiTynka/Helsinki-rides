import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TerrainGrid } from '../../../packages/world-schema/src/index.ts';
import { buildEntranceTerraces, buildGround, buildRetainingWalls, buildStairs, faceUp, lowerTerrainUnderGround, lowerTerrainUnderSurfaces, reconcileRegisterWalls, type GroundPiece } from '../lib/ground.ts';
import { sampleTerrain } from '../../../packages/world-schema/src/index.ts';
import { bbox, ringDistance, type LocalPolygon, type Ring } from '../lib/geometry.ts';

// A 21 x 21 m grid around the origin (runtime frame, y = -z) with heights from a working-frame function.
const grid = (h: (x: number, y: number) => number): TerrainGrid => {
  const heights = new Float32Array(21 * 21);
  for (let z = 0; z < 21; z++) for (let x = 0; x < 21; x++) heights[z * 21 + x] = h(x - 10, -(z - 10));
  return { x0: -10, z0: -10, resolution: 1, nx: 21, nz: 21, heights };
};
const area = { minX: -10, maxX: 10, minZ: -10, maxZ: 10 };
/** Heights of the triangles whose three corners are level, i.e. the treads. */
const treadHeights = (pieces: GroundPiece[]) => {
  const out = new Set<number>();
  for (const p of pieces) for (let t = 0; t < p.indices.length; t += 3) {
    const ys = [0, 1, 2].map(k => p.positions[p.indices[t + k]! * 3 + 1]!);
    if (Math.max(...ys) - Math.min(...ys) < 1e-6) out.add(Math.round(ys[0]! * 1e4) / 1e4);
  }
  return [...out].sort((a, b) => a - b);
};

test('a flight of steps splits the terrain rise into its tagged number of level treads', () => {
  const s = buildStairs([{ id: 'steps', axis: [[0, 0], [4, 0]], width: 2, steps: 4 }], grid(x => 0.15 * x), 128);
  assert.equal(Math.round(s.flights[0]!.rise * 1e4) / 1e4, 0.6);
  assert.deepEqual(treadHeights(s.pieces), [0.075, 0.225, 0.375, 0.525]);
  assert.ok(s.pieces.every(p => p.use === undefined), 'the visible stairs themselves must support the controller');
});

/** Downward-ray support from the actual triangle bytes (vertical faces have no projected area). */
function supportHeights(pieces: readonly GroundPiece[], x: number, z: number): number[] {
  const heights: number[] = [];
  for (const piece of pieces) for (let i = 0; i < piece.indices.length; i += 3) {
    const p = [0, 1, 2].map(k => piece.positions.slice(piece.indices[i + k]! * 3, piece.indices[i + k]! * 3 + 3));
    const a = p[0]!, b = p[1]!, c = p[2]!, den = (b[2]! - c[2]!) * (a[0]! - c[0]!) + (c[0]! - b[0]!) * (a[2]! - c[2]!);
    if (Math.abs(den) < 1e-10) continue;
    const u = ((b[2]! - c[2]!) * (x - c[0]!) + (c[0]! - b[0]!) * (z - c[2]!)) / den;
    const v = ((c[2]! - a[2]!) * (x - c[0]!) + (a[0]! - c[0]!) * (z - c[2]!)) / den;
    if (u >= -1e-8 && v >= -1e-8 && u + v <= 1 + 1e-8) heights.push(u * a[1]! + v * b[1]! + (1 - u - v) * c[1]!);
  }
  return heights;
}

test('a raised raw-terrain cheek cannot become invisible support above an authored tread', () => {
  const terrain = grid((x, y) => 0.15 * x + (Math.abs(y) > 0.8 ? 2 : 0));
  const before = terrain.heights.slice();
  const stairs = buildStairs([{ id: 'wide', axis: [[0, 0], [4, 0]], width: 2, steps: 4 }], terrain, 128);
  const ground = buildGround([], terrain, stairs.zones, area, 0.12, 128, undefined, stairs.boundaries);
  for (const x of [0.3, 1.3, 2.3, 3.3]) {
    const visual = supportHeights(stairs.pieces, x, 0.75);
    const collision = supportHeights([...ground.pieces, ...stairs.pieces].filter(piece => piece.use !== 'visual'), x, 0.75);
    assert.ok(visual.length > 0 && collision.length > 0);
    assert.ok(Math.abs(Math.max(...visual) - Math.max(...collision)) < 1e-8, 'no whole fallback quad may survive inside the flight');
  }
  assert.ok(Math.max(...stairs.pieces.flatMap(piece => piece.positions.filter((_, i) => i % 3 === 1))) <= stairs.flights[0]!.top, 'the stair body has no uncapped raw-terrain wedge above its treads');
  assert.ok(ground.pieces.some(piece => piece.tag === 'stairs-join'), 'higher surrounding ground is joined from its actual mesh boundary');
  const runtime = lowerTerrainUnderSurfaces(terrain, stairs.collisionFloors);
  for (let x = 0.05; x < 4; x += 0.2) for (let z = -0.95; z < 1; z += 0.2) {
    assert.ok(sampleTerrain(runtime, x, z) - 0.4 < Math.min(...supportHeights(stairs.pieces, x, z)), 'the runtime safety field stays under the physical steps, including cell edges');
  }
  assert.deepEqual(terrain.heights, before, 'source terrain remains unchanged');
  assert.equal(sampleTerrain(runtime, 8, 8), sampleTerrain(terrain, 8, 8), 'distant terrain is unchanged');
});

test('a fallback quad partially cut by stairs still supports the remaining outside area', () => {
  const terrain = grid(() => 0);
  const zone: [number, number][] = [[0.5, -0.5], [2.5, -0.5], [2.5, -2.5], [0.5, -2.5]];
  const result = buildGround([], terrain, [zone], { minX: 0, maxX: 4, minZ: 0, maxZ: 4 }, 0.12, 128);
  assert.equal(supportHeights(result.pieces.filter(piece => piece.use !== 'visual'), 1.5, 1.5).length, 0);
  assert.ok(supportHeights(result.pieces.filter(piece => piece.use !== 'visual'), 3.5, 1.5).length > 0);
  assert.ok(supportHeights(result.pieces.filter(piece => piece.use !== 'collision'), 3.5, 1.5).length > 0);
});

test('stair joints and colliders stay within their assigned cells across a boundary', () => {
  const terrain: TerrainGrid = { x0: 120, z0: -8, resolution: 1, nx: 21, nz: 17, heights: new Float32Array(21 * 17).map((_, i) => (i % 21) * 0.15) };
  const stairs = buildStairs([{ id: 'cross-cell', axis: [[126, 0], [132, 0]], width: 3, steps: 6 }], terrain, 128);
  const ground = buildGround([], terrain, stairs.zones, { minX: 124, maxX: 136, minZ: -4, maxZ: 4 }, 0.12, 128, undefined, stairs.boundaries);
  for (const piece of [...stairs.pieces, ...ground.pieces]) {
    const [, sx, nx, sz, nz] = /^c_([mp])(\d+)_([mp])(\d+)$/.exec(piece.cell)!;
    const cx = Number(nx) * (sx === 'm' ? -1 : 1), cz = Number(nz) * (sz === 'm' ? -1 : 1);
    for (let i = 0; i < piece.positions.length; i += 3) {
      assert.ok(piece.positions[i]! >= cx * 128 - 1e-6 && piece.positions[i]! <= (cx + 1) * 128 + 1e-6);
      assert.ok(piece.positions[i + 2]! >= cz * 128 - 1e-6 && piece.positions[i + 2]! <= (cz + 1) * 128 + 1e-6);
    }
  }
});

test('a retaining wall keeps each side level up to its line; a line with no step is no wall', () => {
  const terrain = grid(x => Math.min(1, Math.max(0, (x + 1) / 2)));
  const w = buildRetainingWalls([{ id: 'wall', line: [[0, -5], [0, 5]] }, { id: 'flat', line: [[8, -5], [8, 5]] }], terrain, [], { sideDistance: 2, minHeight: 0.5, gap: 0.02 }, 128);
  assert.deepEqual(w.walls.map(x => x.id), ['wall']);
  assert.equal(w.surface(-0.5, 0), 0);
  assert.equal(w.surface(0.5, 0), 1);
  assert.ok(w.pieces.length > 0 && w.pieces.every(p => p.use === undefined));
});

test('a surveyed retaining wall keeps an old OSM cut out of the carriageway wheel track', () => {
  const terrain = grid(x => Math.min(1.2, Math.max(0, 0.8 - x)));
  const polygon = (id: string, rings: Ring[], properties: Record<string, unknown>): LocalPolygon => ({ id, rings, bbox: bbox(rings), properties });
  const parts = [polygon('carriageway', [[[-8,-8],[-0.2,-8],[-0.2,8],[-8,8]]], { paatyyppi: 'Ajorata', alatyyppi: 'Ajorata', materiaali: 'Asfalttibetoni' }),
    polygon('survey-wall', [[[0,-8],[0.2,-8],[0.2,8],[0,8]]], { paatyyppi: 'Varusteet', alatyyppi: 'Tukimuuri' })];
  const old = [{ id: 'old-wall', line: [[-0.6,-7],[-0.6,7]] as Ring }];
  const opts = { sideDistance: 2, minHeight: 0.5, gap: 0.02 };
  const prior = buildGround(parts, terrain, [], area, 0.12, 128, buildRetainingWalls(old, terrain, [], opts, 128));
  const height = (ground: ReturnType<typeof buildGround>, x: number) => Math.max(...supportHeights(ground.pieces, x, 0.3));
  assert.ok(height(prior,-0.75) - height(prior,-0.5) > 1, 'fixture reproduces the metre-high cut within a quarter metre inside the carriageway');
  const fixed = reconcileRegisterWalls(old, parts);
  assert.equal(fixed.alignments.length, 1); assert.equal(fixed.alignments[0]!.registerId, 'survey-wall');
  assert.deepEqual(fixed.specs[0]!.line, [[0,-7],[0,7]]);
  const walls = buildRetainingWalls(fixed.specs, terrain, [], opts, 128), after = buildGround(parts, terrain, [], area, 0.12, 128, walls);
  for (let x=-3; x<=-0.25; x+=0.25) assert.ok(Math.abs(height(after,x)-1.2)<1e-6, `complete wheel track remains supported at ${x}`);
  assert.equal(walls.surface(1,0),0,'real driveway remains lower on its own side of the wall');
  assert.deepEqual(old[0]!.line,[[-0.6,-7],[-0.6,7]],'OSM source remains unchanged');
  assert.equal(reconcileRegisterWalls(old,parts.filter(p=>p.id!=='carriageway')).alignments.length,0,'no reconciliation without a surveyed carriageway conflict');
  const distant = [{id:'far-wall',line:[[-5,-7],[-5,7]] as Ring}];
  assert.strictEqual(reconcileRegisterWalls(distant,parts).specs[0],distant[0],'distant wall and its line remain exact');
});

/** A point lies on one of the actual triangles, including a vertical face. */
function meshContains(pieces: readonly GroundPiece[], point: number[]): boolean {
  const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
  for (const piece of pieces) for (let i = 0; i < piece.indices.length; i += 3) {
    const [a, b, c] = [0, 1, 2].map(k => piece.positions.slice(piece.indices[i + k]! * 3, piece.indices[i + k]! * 3 + 3));
    const u = b!.map((x, j) => x - a![j]!), v = c!.map((x, j) => x - a![j]!), w = point.map((x, j) => x - a![j]!);
    const uu = dot(u, u), uv = dot(u, v), vv = dot(v, v), wu = dot(w, u), wv = dot(w, v), den = uu * vv - uv * uv;
    if (den < 1e-16) continue;
    const s = (wu * vv - wv * uv) / den, t = (wv * uu - wu * uv) / den;
    if (s < -1e-7 || t < -1e-7 || s + t > 1 + 1e-7) continue;
    const distance = Math.hypot(...w.map((x, j) => x - s * u[j]! - t * v[j]!));
    if (distance < 1e-7) return true;
  }
  return false;
}

/** Intersect the actual triangles along a finite ray, optionally honoring the renderer's front-face culling. */
function rayHit(pieces: readonly GroundPiece[], origin: number[], direction: number[], frontFaceOnly: boolean, maxDistance = 1): boolean {
  const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]!);
  const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i]!, 0);
  const cross = (a: number[], b: number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
  for (const piece of pieces) for (let i = 0; i < piece.indices.length; i += 3) {
    const [a, b, c] = [0, 1, 2].map(k => piece.positions.slice(piece.indices[i + k]! * 3, piece.indices[i + k]! * 3 + 3));
    const e1 = sub(b!, a!), e2 = sub(c!, a!), p = cross(direction, e2), det = dot(e1, p);
    if (frontFaceOnly ? det < 1e-10 : Math.abs(det) < 1e-10) continue;
    const offset = sub(origin, a!), u = dot(offset, p) / det;
    if (u < -1e-8 || u > 1 + 1e-8) continue;
    const q = cross(offset, e1), v = dot(direction, q) / det, distance = dot(e2, q) / det;
    if (v >= -1e-8 && u + v <= 1 + 1e-8 && distance > 1e-6 && distance <= maxDistance) return true;
  }
  return false;
}

test('a wall cut crossing a stair edge has a closed cheek from its tread to the surrounding ground', () => {
  for (const angle of [0, 0.37]) {
    const c = Math.cos(angle), s = Math.sin(angle), at = (along: number, across: number): [number, number] => [along * c - across * s, along * s + across * c];
    // A wide surveyed flight has lower width-median treads than the terrain immediately inside its cheek.
    // The OSM wall is 5 mm outside that cheek, so its 20 mm cut overlaps the authored footprint.
    const terrain = grid((x, y) => { const along = x * c + y * s, across = -x * s + y * c; return 0.15 * along + (across > 0.5 ? 2 : 0) + (across >= 4 ? 3 : 0); });
    const stairs = buildStairs([{ id: 'surveyed', axis: [at(0, 0), at(4, 0)], width: 6, steps: 4 }], terrain, 128);
    const walls = buildRetainingWalls([{ id: 'offset-osm-wall', line: [at(0, 3.005), at(4, 3.005)] }], terrain, stairs.zones, { sideDistance: 2, minHeight: 0.5, gap: 0.02 }, 128);
    assert.equal(walls.walls.length, 1);
    const ground = buildGround([], terrain, stairs.zones, area, 0.12, 128, walls, stairs.boundaries);
    // Match the shared district assembler, including the winding operation after joins have been generated.
    for (const piece of ground.pieces) faceUp(piece.positions, piece.indices);
    const pieces = [...ground.pieces, ...stairs.pieces, ...walls.pieces];
    for (let step = 0; step < 4; step++) for (const dy of [0.2, 0.5, 1]) for (const oblique of [-0.3, 0, 0.3]) {
      const [x, y] = at(step + 0.5, 2.8), h = stairs.flights[0]!.bottom + (step + 0.5) * stairs.flights[0]!.riser;
      const direction = [-s + c * oblique, 0, -(c + s * oblique)], norm = Math.hypot(...direction), ray = direction.map(v => v / norm);
      const origin = [x, h + dy, -y];
      assert.ok(rayHit(pieces, origin, ray, true), `visible side/oblique closure at angle ${angle}, step ${step}, dy ${dy}, oblique ${oblique}`);
      assert.ok(rayHit(pieces.filter(p => p.use !== 'visual'), origin, ray, false), 'the visible cheek is also physical');
    }
  }
});

test('the surveyed cheek owns adjacent approximate walls without a folded ribbon or an access-gap bridge', () => {
  const angle = 0, c = Math.cos(angle), s = Math.sin(angle);
  const at = (along: number, across: number): [number, number] => [along * c - across * s, along * s + across * c];
  const terrain = grid((x, y) => {
    const along = x * c + y * s, across = -x * s + y * c;
    return 0.15 * along + ((along < 2.5 || along > 5.5) ? (across > 0.5 ? 2 : 0) + (across >= 4 ? 3 : 0) : 0);
  });
  const stairs = buildStairs([{ id: 'flight', axis: [at(0, 0), at(8, 0)], width: 6, steps: 8 }], terrain, 128);
  const specs = [{ id: 'before-access', line: [at(0, 3.005), at(2, 3.025)] }, { id: 'after-access', line: [at(6, 3.025), at(8, 3.005)] }];
  const original = JSON.stringify(specs);
  const walls = buildRetainingWalls(specs, terrain, stairs.zones, { sideDistance: 2, minHeight: 0.5, gap: 0.02 }, 128, { boundaries: stairs.boundaries, maxDistance: 0.3 });
  assert.equal(JSON.stringify(specs), original, 'raw OSM inputs remain unchanged');
  assert.equal(walls.walls.length, 2);
  assert.ok(walls.walls.every(w => w.stairBoundaryJoins.length === 1 && w.stairBoundaryJoins[0]!.maxDeviation <= 0.025001), 'authored replacements record their small source deviations');
  assert.equal(walls.pieces.length, 0, 'the shared cheek replaces the secondary wall faces');
  const ground = buildGround([], terrain, stairs.zones, area, 0.12, 128, walls, stairs.boundaries);
  assert.equal(ground.pieces.filter(p => p.tag === 'wall-join').length, 0, 'secondary wall caps cannot overlap the shared cheek');
  let caps = 0;
  for (const piece of ground.pieces.filter(p => p.tag === 'stairs-join')) for (let i = 0; i < piece.indices.length; i += 3) {
    const triangle = [0, 1, 2].map(k => piece.positions.slice(piece.indices[i + k]! * 3, piece.indices[i + k]! * 3 + 3));
    const across = triangle.map(p => -p[0]! * s - p[2]! * c);
    if (Math.min(...across) < 2.999 || Math.max(...across) > 3.011) continue;
    if (Math.max(...across) - Math.min(...across) < 1e-6) {
      assert.ok(across.every(v => Math.abs(v - 3) < 1e-6), 'the vertical cheek stays on its one surveyed plane');
    } else {
      caps++;
      const u = triangle[1]!.map((v, j) => v - triangle[0]![j]!), v = triangle[2]!.map((v, j) => v - triangle[0]![j]!);
      const normal = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
      assert.ok(Math.abs(-normal[0]! * s - normal[2]! * c) < Math.hypot(...normal) * 1e-6, 'a cap stays level across the narrow cut, without folding down to a tread');
    }
  }
  assert.ok(caps > 0, 'the wall cut is covered above the vertical cheek');
  const [x, y] = at(4, 2.8), direction = [-s, 0, -c], origin = [x, 1.2, -y];
  const [outsideX, outsideY] = at(4, 3.2);
  assert.ok(Math.max(...supportHeights(ground.pieces, outsideX, -outsideY)) < 1, 'the access fixture has a low physical floor, not a coarse high terrain chord');
  assert.equal(rayHit([...ground.pieces, ...stairs.pieces, ...walls.pieces], origin, direction, false), false, 'the real gap between wall runs stays open above its level access floor');
});

test('a raised polygon closes to actual exterior triangles when its edge chord differs from terrain samples', () => {
  const part = { id: 'slab', rings: [[[-1.5, -1.5], [6.5, 6.5], [-1.5, 6.5]] as [number, number][]], bbox: [-1.5, -1.5, 6.5, 6.5] as [number, number, number, number], properties: { paatyyppi: 'Kevyt liikenne', materiaali: 'laatta' } };
  const ground = buildGround([part], grid((x, y) => x * y), [], area, 0.12, 128);
  const origin = [1.2, 3, -0.8], direction = [-Math.SQRT1_2, 0, -Math.SQRT1_2];
  assert.ok(rayHit([...ground.pieces, ...ground.kerbs], origin, direction, true), 'the exposed slab chord has a visible vertical face down to its actual neighbor');
  assert.ok(rayHit([...ground.pieces, ...ground.kerbs].filter(p => p.use !== 'visual'), origin, direction, false), 'the same face collides');

  const makePart = (id: string, x0: number, x1: number) => ({ id, rings: [[[x0, -4], [x1, -4], [x1, 0], [x0, 0]] as [number, number][]], bbox: [x0, -4, x1, 0] as [number, number, number, number], properties: part.properties });
  const access = buildGround([makePart('left', 0, 1), makePart('right', 3, 4)], grid(() => 0), [], area, 0.12, 128);
  assert.equal(rayHit([...access.pieces, ...access.kerbs], [2, 0.03, 2], [0, 0, -1], false), false, 'separate platform edges do not bridge their open access corridor');
});

test('a perpendicular cross-wall cannot pull a long pointed cap onto a stair endpoint', () => {
  const terrain = grid((x, y) => 0.15 * x + (y > 0.5 ? 2 : 0) + (y >= 4 ? 3 : 0));
  const stairs = buildStairs([{ id: 'flight', axis: [[0, 0], [4, 0]], width: 6, steps: 4 }], terrain, 128);
  const walls = buildRetainingWalls([{ id: 'corner', line: [[-0.02, 7], [0, 3.005], [4, 3.025]] }], terrain, stairs.zones, { sideDistance: 2, minHeight: 0.5, gap: 0.02 }, 128, { boundaries: stairs.boundaries, maxDistance: 0.3 });
  const ground = buildGround([], terrain, stairs.zones, area, 0.12, 128, walls, stairs.boundaries);
  for (const piece of ground.pieces.filter(p => p.tag === 'stairs-join')) for (let i = 0; i < piece.positions.length; i += 3) {
    assert.ok(ringDistance([piece.positions[i]!, -piece.positions[i + 2]!], stairs.zones[0]!) <= 0.020001, 'offset caps span only the physical wall-cut width, including endpoints');
  }
});

test('finite cross-wall ends return to the actual stair cheek on either end orientation', () => {
  const missing: string[] = [];
  const angle = 0.37, c = Math.cos(angle), s = Math.sin(angle);
  const at = (x: number, y: number): [number, number] => [x * c - y * s, x * s + y * c];
  for (const end of [1.3, 2.7]) {
    const terrain = grid((x, y) => { const along = x * c + y * s, across = -x * s + y * c; return 0.15 * along + (across > 0.5 ? 2 : 0) + (across >= 4 ? 3 : 0); });
    const stairs = buildStairs([{ id: 'flight', axis: [at(0, 0), at(4, 0)], width: 6, steps: 4 }], terrain, 128);
    const line: [number, number][] = end === 1.3 ? [[1.3, 7], [1.3, 3], [2.7, 3]] : [[1.3, 3], [2.7, 3], [2.7, 7]];
    const walls = buildRetainingWalls([{ id: 'corner', line: line.map(p => at(...p)) }], terrain, stairs.zones, { sideDistance: 2, minHeight: 0.1, gap: 0.02 }, 128, { boundaries: stairs.boundaries, maxDistance: 0.3 });
    assert.equal(walls.walls[0]!.segments, 2, 'both the cheek and its retained cross-wall must be present');
    const side = end === 1.3 ? -1 : 1, edge = end + side * 0.01;
    // A real clipped triangle ends on the 10 mm wall-cut side; its flat top is above the adjoining tread.
    const piece: GroundPiece = { cell: 'c_p00_m01', tag: 'platform', finish: 'slabs', level: 'raised', positions: [at(edge, 3), at(edge, 4), at(edge + side, 4)].flatMap(p => [p[0], 2.1, -p[1]]), uvs: [0, 0, 0, 1, 1, 1], indices: [0, 1, 2] };
    const pieces = walls.closeGround([piece]);
    for (const piece of pieces) faceUp(piece.positions, piece.indices);
    const x = end + side * 0.005;
    const [px, py] = at(x, 2.95), origin = [px, 2, -py], direction = [-s, 0, -c];
    if (!rayHit(pieces, origin, direction, true, 0.15)) missing.push(`visible:${end}`);
    if (!rayHit(pieces.filter(p => p.use !== 'visual'), origin, direction, false, 0.15)) missing.push(`collision:${end}`);
  }
  assert.deepEqual(missing, [], 'both finite endpoint orientations close their physical cut width');
});

test('separate collinear flights do not claim a retaining wall across the interval between them', () => {
  const terrain = grid((x, y) => 0.15 * x + (y > 0 ? 2 : 0));
  const stairs = buildStairs([{ id: 'first', axis: [[0, 0], [2, 0]], width: 2, steps: 2 }, { id: 'second', axis: [[6, 0], [8, 0]], width: 2, steps: 2 }], terrain, 128);
  const walls = buildRetainingWalls([{ id: 'between', line: [[2.5, 1.005], [5.5, 1.005]] }], terrain, stairs.zones, { sideDistance: 2, minHeight: 0.5, gap: 0.02 }, 128, { boundaries: stairs.boundaries, maxDistance: 0.3 });
  assert.equal(walls.walls[0]!.stairBoundaryJoins.length, 0, 'ownership requires a continuous surveyed boundary');
  assert.ok(walls.pieces.length > 0, 'the unrelated wall in the interval is retained');
});

test('an oversized landing lip is fitted locally while treads and the outer platform stay unchanged', () => {
  const terrain = grid((x, y) => 0.15 * x + (x >= 4 && y > 0 ? 1.6 : 0)), originalTerrain = terrain.heights.slice();
  const stairs = buildStairs([{ id: 'flight', axis: [[0, 0], [4, 0]], width: 2, steps: 4 }], terrain, 128);
  const before = buildGround([], terrain, stairs.zones, area, 0.12, 128, undefined, stairs.boundaries.map(({ landing: _landing, ...b }) => b));
  const after = buildGround([], terrain, stairs.zones, area, 0.12, 128, undefined, stairs.boundaries);
  const tread = Math.max(...supportHeights(stairs.pieces, 3.8, -0.8));
  const h = (pieces: GroundPiece[], x: number) => Math.max(...supportHeights(pieces, x, -0.8));
  assert.ok(h(before.pieces, 4.00001) - tread > 0.35, `the fixture reproduces the obstructing final lip: ${h(before.pieces, 4.00001)} over ${tread}`);
  assert.ok(h(after.pieces, 4.00001) - tread <= stairs.flights[0]!.riser + 1e-5, 'the immediate landing rise is no larger than a normal riser');
  assert.equal(h(after.pieces, 5.1), h(before.pieces, 5.1), 'the platform beyond one tread depth is unchanged');
  assert.equal(h([...after.pieces, ...stairs.pieces], 3.8), tread, 'the surveyed final tread remains level and unchanged');
  assert.deepEqual(terrain.heights, originalTerrain, 'raw georeferenced terrain is unchanged');
  assert.ok(after.stats.landingTransitions[0]!.maxGradeDegrees < 45, 'the local landing plate has a measured climbable grade');
  const runtime = lowerTerrainUnderSurfaces(terrain, [...stairs.collisionFloors, ...after.collisionFloors]);
  assert.ok(sampleTerrain(runtime, 4.01, -0.8) - 0.4 < h(after.pieces, 4.01), 'the copied safety terrain stays below the fitted landing');
});

test('both fitted landing ends close their height difference to the unchanged adjacent platform', () => {
  const terrain = grid((x, y) => 0.15 * x + (x >= 4 && Math.abs(y) > 0.5 ? 1 : 0));
  const stairs = buildStairs([{ id: 'flight', axis: [[0, 0], [4, 0]], width: 2, steps: 4 }], terrain, 128);
  const platform = { id: 'platform', rings: [[[4, -1.2], [8, -1.2], [8, 1.2], [4, 1.2]] as [number, number][]], bbox: [4, -1.2, 8, 1.2] as [number, number, number, number], properties: { paatyyppi: 'Ajorata' } };
  const ground = buildGround([platform], terrain, stairs.zones, area, 0.12, 128, undefined, stairs.boundaries);
  assert.equal(ground.stats.landingTransitions[0]!.status, 'applied');
  for (const piece of ground.pieces) faceUp(piece.positions, piece.indices);
  const missing: string[] = [];
  for (const side of [-1, 1]) for (const x of [4.1, 4.4, 4.8]) {
    const inner = Math.max(...supportHeights(ground.pieces, x, -side * 0.99999));
    const outer = Math.max(...supportHeights(ground.pieces, x, -side * 1.00001));
    assert.ok(outer - inner > 0.02, `the unchanged platform is measurably above the lowered landing edge: ${side}, ${x}, ${inner}, ${outer}`);
    const origin = [x, (inner + outer) / 2, -side * 0.95], direction = [0, 0, -side];
    if (!rayHit(ground.pieces, origin, direction, true, 0.15)) missing.push(`visible:${side}:${x}`);
    if (!rayHit(ground.pieces.filter(p => p.use !== 'visual'), origin, direction, false, 0.15)) missing.push(`collision:${side}:${x}`);
  }
  assert.deepEqual(missing, [], 'both exposed landing sides are visible and physical');
});

test('nonlinear wall-side ground is sealed to the actual wall mesh, including cut ends', () => {
  const terrain = grid((x, y) => (x > 0 ? 2 : 0) + 0.08 * y * y);
  const walls = buildRetainingWalls([{ id: 'curved-ground', line: [[0, -7.7], [0, 7.2]] }], terrain, [], { sideDistance: 2, minHeight: 0.5, gap: 0.02 }, 128);
  const ground = buildGround([], terrain, [], area, 0.12, 128, walls);
  const joins = ground.pieces.filter(p => p.tag === 'wall-join');
  assert.ok(joins.length > 0 && joins.every(p => p.use === undefined), 'seals are both visible and colliding');
  let samples = 0, curvedChord = false, endSamples = 0;
  for (const piece of ground.pieces.filter(p => p.tag !== 'wall-join')) for (let i = 0; i < piece.indices.length; i += 3) for (let e = 0; e < 3; e++) {
    const p = piece.positions.slice(piece.indices[i + e]! * 3, piece.indices[i + e]! * 3 + 3);
    const q = piece.positions.slice(piece.indices[i + (e + 1) % 3]! * 3, piece.indices[i + (e + 1) % 3]! * 3 + 3);
    const midpoint = p.map((x, j) => (x + q[j]!) / 2);
    const side = Math.abs(Math.abs(p[0]!) - 0.01) < 1e-7 && Math.abs(p[0]! - q[0]!) < 1e-7 && midpoint[2]! > -7.21 && midpoint[2]! < 7.71;
    const end = (Math.abs(p[2]! + 7.21) < 1e-7 || Math.abs(p[2]! - 7.71) < 1e-7) && Math.abs(p[2]! - q[2]!) < 1e-7 && Math.abs(midpoint[0]!) < 0.010001;
    if (!side && !end) continue;
    samples++;
    if (end) endSamples++;
    if (Math.abs(midpoint[1]! - walls.surface(midpoint[0]!, -midpoint[2]!)) > 0.01) curvedChord = true;
    assert.ok(meshContains(joins, midpoint), `cut boundary ${midpoint.join(',')} is sealed at its actual mesh height`);
  }
  assert.ok(samples >= 8 && endSamples >= 2, 'both wall sides and the two finite ends were exercised');
  assert.ok(curvedChord, 'the fixture must expose a difference between a mesh chord and resampled terrain');
  // The seal's inner edge must end on the wall face, rather than on a different resampling of its top.
  for (const join of joins) for (let i = 0; i < join.positions.length; i += 3) if (Math.abs(join.positions[i]!) < 1e-7 && join.positions[i + 2]! >= -7.2 - 1e-7 && join.positions[i + 2]! <= 7.7 + 1e-7) {
    assert.ok(meshContains(walls.pieces, join.positions.slice(i, i + 3)), `the join terminates on the drawn wall: ${join.positions.slice(i, i + 3).join(',')}`);
  }
  const runtime = lowerTerrainUnderSurfaces(terrain, walls.collisionFloors);
  for (let z = -7; z <= 7; z += 0.5) assert.ok(sampleTerrain(runtime, -0.05, z) - 0.4 < Math.max(...supportHeights(ground.pieces, -0.05, z)), 'the safety field cannot intrude through the lowered wall side');
});

test('wall segments wholly outside the finite terrain do not emit an infinite safety floor', () => {
  const terrain = grid((_, y) => y);
  const walls = buildRetainingWalls([{ id: 'outside', line: [[20, -5], [21, 5]] }], terrain, [], { sideDistance: 2, minHeight: 0.1, gap: 0.02 }, 128);
  assert.equal(walls.walls.length, 1, 'the clamped terrain can still resolve a height difference outside its grid');
  assert.equal(walls.collisionFloors.length, 0, 'no released terrain cells overlap this wall');
  assert.deepEqual(lowerTerrainUnderSurfaces(terrain, walls.collisionFloors).heights, terrain.heights);
});

test('a terrain bump at a door next to a steps way becomes terraces at whole risers; without the way it stays terrain', () => {
  const terrain = grid((x, y) => (x >= 2 && x <= 3 && y >= -2 && y <= -1 ? 0.48 : 0));
  const door = { id: 'b', rings: [[[0, 0], [6, 0], [6, 6], [0, 6]] as [number, number][]], bbox: [0, 0, 6, 6] as [number, number, number, number], properties: {} };
  const opts = { openingRadius: 4, minRise: 0.2, maxFootprintDistance: 1, maxStepsDistance: 1.5, pad: 1, riser: 0.16, raster: 0.5 };
  const t = buildEntranceTerraces(terrain, [door], [{ id: 'steps', axis: [[2.5, -3], [2.5, -1]] }], [], area, opts, 128);
  assert.deepEqual(t.terraces.map(x => [x.steps, x.levels]), [[['steps'], 3]]);
  assert.deepEqual(treadHeights(t.pieces), [0, 0.16, 0.32, 0.48]);
  assert.ok(t.pieces.every(p => p.use === undefined), 'the visible terraces supply their own collision');
  const support = lowerTerrainUnderGround(terrain, t.pieces);
  for (let x = 1.51; x < 3.5; x += 0.13) for (let z = 0.51; z < 2.5; z += 0.13) {
    const visible = supportHeights(t.pieces, x, z);
    assert.ok(visible.length > 0);
    assert.ok(sampleTerrain(support, x, z) - 0.4 <= Math.min(...visible) - 0.049999, 'smooth safety support cannot rise through a tread');
  }
  assert.equal(buildEntranceTerraces(terrain, [door], [{ id: 'far', axis: [[-8, -8], [-8, -6]] }], [], area, opts, 128).terraces.length, 0);
});

test('a source terrain peak between coarse ground vertices cannot protrude through the road', () => {
  const terrain = grid((x, y) => x === 2 && y === -2 ? 2 : 0), original = terrain.heights.slice();
  const ground = buildGround([], terrain, [], { minX: 0, maxX: 4, minZ: 0, maxZ: 4 }, 0.12, 128);
  assert.ok(sampleTerrain(terrain, 2, 2) - 0.4 > Math.max(...supportHeights(ground.pieces, 2, 2)) + 1);
  const support = lowerTerrainUnderGround(terrain, ground.pieces);
  for (let x = 0.03; x < 4; x += 0.13) for (let z = 0.03; z < 4; z += 0.13) {
    assert.ok(sampleTerrain(support, x, z) - 0.4 <= Math.min(...supportHeights(ground.pieces, x, z)) - 0.049999);
  }
  assert.deepEqual(terrain.heights, original, 'source terrain is untouched');
  assert.equal(sampleTerrain(support, 8, 8), sampleTerrain(terrain, 8, 8), 'uncovered ground remains untouched');
});

test('support lowering clips a sloped triangle to the terrain cells it actually covers', () => {
  const terrain = grid(() => 5), original = terrain.heights.slice();
  const triangle: GroundPiece = { cell: 'c_p00_p00', finish: 'yard', level: 'road', tag: 'road', positions: [0.25, 1, 0.25, 3.75, 2, 0.25, 0.25, 1, 3.75], uvs: [], indices: [0, 2, 1] };
  const support = lowerTerrainUnderGround(terrain, [triangle]);
  for (let x = 0.27; x < 3.75; x += 0.11) for (let z = 0.27; z < 3.75; z += 0.11) {
    const visible = supportHeights([triangle], x, z);
    if (visible.length) assert.ok(sampleTerrain(support, x, z) - 0.4 <= Math.min(...visible) - 0.049999);
  }
  assert.equal(sampleTerrain(support, 4, 4), 5, 'a corner outside the triangle stays unchanged');
  assert.deepEqual(lowerTerrainUnderGround(terrain, [{ ...triangle, use: 'visual' }]).heights, original, 'decoration alone never lowers safety support');
});
