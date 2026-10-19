import { RAPIER, type StaticWorld } from '../../../packages/sim/src/index.ts';
import { createHash } from 'node:crypto';
import type { TerrainGrid, TriMeshCollider } from '../../../packages/world-schema/src/index.ts';
import { exactGroundTriangles, nativeGroundPoint } from './ground-query-precision.ts';

type NativeHit = ReturnType<StaticWorld['groundBelow']>;
interface TerrainSide {
  source: TerrainGrid;
  world: StaticWorld;
  groundColliders: readonly TriMeshCollider[];
  visualHeight: (x: number, z: number) => number | null;
  visualTrianglesNear?: (x: number, z: number, radius: number) => readonly (readonly number[])[];
}
export interface TerrainQueryPreservationOptions {
  before: TerrainSide;
  after: TerrainSide;
  x: number;
  z: number;
  originY: number;
  observedBefore: NativeHit;
  observedAfter: NativeHit;
}

// This is a numerical bound for matching physical queries, not the world's 35 mm support allowance.
const numericalBound = .0002;
const offsets = [-.001, .001].flatMap(dx => [-.001, .001].map(dz => [dx, dz] as const))
  .concat([-.125, .125].flatMap(dx => [-.125, .125].map(dz => [dx, dz] as const)));
const bits = (values: Float32Array, index: number) => new Uint32Array(values.buffer, values.byteOffset, values.length)[index]!;
const terrainHit = (hit: NativeHit) => hit?.surface?.group === 'terrain' && hit.surface.tag === 'terrain' && hit.surface.ref === null && Number.isFinite(hit.y);
const sameSurface = (a: NonNullable<NativeHit>['surface'], b: NonNullable<NativeHit>['surface']) => a !== null && b !== null && a.group === b.group && a.tag === b.tag && a.ref === b.ref;
const supportedHit = (hit: NativeHit) => hit !== null && Number.isFinite(hit.y) && (terrainHit(hit) || hit.surface?.group === 'ground');
const sameHit = (a: NativeHit, b: NativeHit) => a === null ? b === null : b !== null && a.y === b.y &&
  a.surface?.group === b.surface?.group && a.surface?.tag === b.surface?.tag && a.surface?.ref === b.surface?.ref;
interface LocalGroundTriangle { collider: string; triangle: number; tag: number; floor: boolean; vertices: number[][] }

function gridValid(t: TerrainGrid) {
  return t.resolution === 1 && Number.isSafeInteger(t.nx) && t.nx >= 5 && Number.isSafeInteger(t.nz) && t.nz >= 5 &&
    t.heights instanceof Float32Array && t.heights.length === t.nx * t.nz &&
    Number.isFinite(t.x0) && Number.isFinite(t.z0) && Math.fround(t.x0) === t.x0 && Math.fround(t.z0) === t.z0;
}
function sameLayout(a: TerrainGrid, b: TerrainGrid) {
  return a.x0 === b.x0 && a.z0 === b.z0 && a.nx === b.nx && a.nz === b.nz && a.resolution === b.resolution;
}
function vertexIndex(t: TerrainGrid, x: number, z: number) {
  const ix = (x - t.x0) / t.resolution, iz = (z - t.z0) / t.resolution;
  return Number.isInteger(ix) && Number.isInteger(iz) && ix >= 2 && iz >= 2 && ix < t.nx - 2 && iz < t.nz - 2 ? { ix, iz } : null;
}

/** A conservative XZ box intersection includes every contacting floor triangle, plus any triangle
 * whose bounding box overlaps it. Include multiplicity, winding, owner, tag and exact Float32 bits. */
function localGroundTriangles(colliders: readonly TriMeshCollider[], x: number, z: number) {
  const records: string[] = [], triangles: LocalGroundTriangle[] = [];
  for (const piece of colliders) for (let t = 0; t < piece.indices.length; t += 3) {
    const p = piece.positions, a = piece.indices[t]! * 3, b = piece.indices[t + 1]! * 3, c = piece.indices[t + 2]! * 3;
    if (piece.group !== 'ground' || Math.max(p[a]!, p[b]!, p[c]!) < x - .2 || Math.min(p[a]!, p[b]!, p[c]!) > x + .2 ||
        Math.max(p[a + 2]!, p[b + 2]!, p[c + 2]!) < z - .2 || Math.min(p[a + 2]!, p[b + 2]!, p[c + 2]!) > z + .2) continue;
    const determinant = (p[b + 2]! - p[c + 2]!) * (p[a]! - p[c]!) + (p[c]! - p[b]!) * (p[a + 2]! - p[c + 2]!);
    triangles.push({ collider: piece.id, triangle: t / 3, tag: piece.triangleTags[t / 3]!, floor: determinant !== 0, vertices: [a, b, c].map(index => [p[index]!, p[index + 1]!, p[index + 2]!]) });
    records.push(JSON.stringify([piece.id, piece.group, piece.ref, piece.triangleTags[t / 3], ...[a, b, c].flatMap(index => [bits(p, index), bits(p, index + 1), bits(p, index + 2)])]));
  }
  records.sort();
  return { count: records.length, sha256: createHash('sha256').update(JSON.stringify(records)).digest('hex'), records, triangles };
}

/** Euclidean distance stays bounded on steep triangles where Float32 XZ rounding amplifies
 * a vertical-height comparison. Projection and edge segments use the actual finite triangles. */
function closestTrianglePoint(point: readonly number[], vertices: readonly (readonly number[])[]) {
  const [a, b, c] = vertices as [readonly number[], readonly number[], readonly number[]];
  const subtract = (v: readonly number[], w: readonly number[]) => v.map((n, i) => n - w[i]!);
  const dot = (v: readonly number[], w: readonly number[]) => v.reduce((sum, n, i) => sum + n * w[i]!, 0);
  const u = subtract(b, a), v = subtract(c, a), q = subtract(point, a), uu = dot(u, u), uv = dot(u, v), vv = dot(v, v), qu = dot(q, u), qv = dot(q, v), denominator = uu * vv - uv * uv;
  const candidates: number[][] = [];
  if (denominator > 0) {
    const s = (qu * vv - qv * uv) / denominator, t = (qv * uu - qu * uv) / denominator;
    if (s >= 0 && t >= 0 && s + t <= 1) candidates.push(a.map((n, i) => n + s * u[i]! + t * v[i]!));
  }
  for (const [start, end] of [[a, b], [b, c], [c, a]]) {
    const edge = subtract(end!, start!), delta = subtract(point, start!), length = dot(edge, edge), t = length > 0 ? Math.max(0, Math.min(1, dot(delta, edge) / length)) : 0;
    candidates.push(start!.map((n, i) => n + t * edge[i]!));
  }
  const ordered = candidates.map(closest => ({ point: closest, distance: Math.hypot(...closest.map((n, i) => n - point[i]!)) })).sort((p, q) => p.distance - q.distance);
  return ordered[0]!;
}

function matchingTriangle(a: readonly (readonly number[])[], b: readonly (readonly number[])[]) {
  return [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]].some(order => order.every((j, i) => Math.hypot(...a[i]!.map((n, k) => n - b[j]![k]!)) <= 1e-7));
}

function nativeShapeIdentity(world: StaticWorld, collider: RAPIER.Collider, group: string | undefined) {
  if (group === 'terrain' && collider.shapeType() === RAPIER.ShapeType.HeightField) return 'terrain-heightfield';
  if (group !== 'ground' || collider.shapeType() !== RAPIER.ShapeType.TriMesh) return null;
  for (const [cell, handles] of world.cellColliders) {
    const slot = handles.indexOf(collider.handle); if (slot >= 0) return JSON.stringify([cell, slot]);
  }
  return null;
}

/** Qualify only a preserved heightfield-vertex ray hit/miss discrepancy. Actual native heightfield
 * metadata and 5x5 heights must match the input grids. Eight off-grid rays and a centered 1 cm shape
 * must find matching terrain or bit-exact preserved authored floors in both complete worlds.
 * It cannot excuse changed HCOL/terrain, different surfaces, or a finite physical support change. */
export function provePreservedTerrainVertexQuery(options: TerrainQueryPreservationOptions) {
  const { x, z } = nativeGroundPoint(options.x, options.z), failures: string[] = [];
  const proof = {
    pass: false, requested: { x: options.x, z: options.z }, query: { x, z }, originY: options.originY,
    numericalBoundMetres: numericalBound, sphereRadiusMetres: .01, failures,
    raw: { before: options.observedBefore, after: options.observedAfter },
    grids: [] as { side: string; source: object; runtime: object; native: object }[],
    neighborhoods: [] as { x: number; z: number; sourceBits: number; runtimeBits: number }[],
    centers: [] as { side: string; visual: number | null; groundTriangles: number; hit: NativeHit }[],
    localGround: [] as { side: string; radiusMetres: number; count: number; sha256: string; records: string[]; triangles: LocalGroundTriangle[] }[],
    cardinals: [] as { x: number; z: number; before: NativeHit; after: NativeHit }[],
    neighbors: [] as { x: number; z: number; before: NativeHit; after: NativeHit }[],
    shapes: [] as { side: string; height: number; contact: { x: number; y: number; z: number }; surface: ReturnType<StaticWorld['surfaceAt']>; identity: string | null; groundContact: { visual: number | null; triangles: ReturnType<typeof exactGroundTriangles>; support: { collider: string; triangle: number; collision: ReturnType<typeof closestTrianglePoint>; visual: ReturnType<typeof closestTrianglePoint>; collisionVertices: number[][]; visualVertices: number[][] }[] } | null }[],
  };
  if (![options.x, options.z, options.originY].every(Number.isFinite)) { failures.push('nonfinite-query'); return proof; }
  if (options.originY !== Math.fround(options.originY)) { failures.push('origin-not-native-float32'); return proof; }
  if (!((options.observedBefore === null && terrainHit(options.observedAfter)) || (options.observedAfter === null && terrainHit(options.observedBefore)))) {
    failures.push('not-one-null-and-one-terrain'); return proof;
  }
  const sides = [['before', options.before], ['after', options.after]] as const;
  const sourceBefore = options.before.source, sourceAfter = options.after.source;
  for (const [, side] of sides) if (!gridValid(side.source) || !gridValid(side.world.terrain) || !sameLayout(side.source, side.world.terrain)) failures.push('unsupported-grid-layout');
  if (failures.length) return proof;
  if (!Number.isInteger(sourceAfter.x0 - sourceBefore.x0) || !Number.isInteger(sourceAfter.z0 - sourceBefore.z0) ||
      sourceAfter.x0 > sourceBefore.x0 || sourceAfter.z0 > sourceBefore.z0 ||
      sourceAfter.x0 + sourceAfter.nx < sourceBefore.x0 + sourceBefore.nx || sourceAfter.z0 + sourceAfter.nz < sourceBefore.z0 + sourceBefore.nz) failures.push('not-aligned-containing-expansion');
  const indices = sides.map(([, side]) => vertexIndex(side.source, x, z));
  if (indices.some(index => index === null)) failures.push('not-interior-shared-grid-vertex');
  if (failures.length) return proof;
  for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
    const local = sides.map(([, side], s) => {
      const { ix, iz } = indices[s]!, index = (iz + dz) * side.source.nx + ix + dx;
      return { sourceBits: bits(side.source.heights, index), runtimeBits: bits(side.world.terrain.heights, index), finite: Number.isFinite(side.source.heights[index]) && Number.isFinite(side.world.terrain.heights[index]) };
    });
    proof.neighborhoods.push({ x: x + dx, z: z + dz, sourceBits: local[0]!.sourceBits, runtimeBits: local[0]!.runtimeBits });
    if (!local.every(p => p.finite) || local[0]!.sourceBits !== local[1]!.sourceBits || local[0]!.runtimeBits !== local[1]!.runtimeBits) failures.push('changed-5x5-height-bits');
  }
  if (failures.length) return proof;
  for (const [s, [name, side]] of sides.entries()) {
    const t = side.world.terrain, fields: RAPIER.Collider[] = [];
    side.world.physics.forEachCollider(collider => { if (collider.shapeType() === RAPIER.ShapeType.HeightField) fields.push(collider); });
    if (fields.length !== 1) { failures.push('not-one-native-heightfield'); continue; }
    const field = fields[0]!, translation = field.translation(), rotation = field.rotation(), scale = field.heightfieldScale();
    const expected = { x: (t.nx - 1) * t.resolution, y: 1, z: (t.nz - 1) * t.resolution };
    const nrows = field.heightfieldNRows(), ncols = field.heightfieldNCols();
    proof.grids.push({ side: name, source: { x0: side.source.x0, z0: side.source.z0, nx: side.source.nx, nz: side.source.nz, resolution: side.source.resolution }, runtime: { x0: t.x0, z0: t.z0, nx: t.nx, nz: t.nz, resolution: t.resolution }, native: { nrows, ncols, translation, rotation, scale } });
    if (nrows !== t.nz - 1 || ncols !== t.nx - 1 || !scale || scale.x !== expected.x || scale.y !== 1 || scale.z !== expected.z ||
        translation.x !== Math.fround(t.x0 + expected.x / 2) || translation.y !== Math.fround(-.4) || translation.z !== Math.fround(t.z0 + expected.z / 2) ||
        rotation.x !== 0 || rotation.y !== 0 || rotation.z !== 0 || rotation.w !== 1 || !side.world.isStatic(field.handle)) {
      failures.push('native-heightfield-transform-or-layout-changed'); continue;
    }
    const heights = field.heightfieldHeights(), { ix, iz } = indices[s]!;
    if (heights.length !== t.nx * t.nz) failures.push('native-heightfield-count-changed');
    else for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      if (bits(heights, (ix + dx) * t.nz + iz + dz) !== bits(t.heights, (iz + dz) * t.nx + ix + dx)) failures.push('native-heightfield-bits-changed');
    }
    const visual = side.visualHeight(x, z), triangles = exactGroundTriangles(side.groundColliders, x, z);
    const hit = side.world.groundBelow(x, options.originY, z, 30);
    proof.centers.push({ side: name, visual, groundTriangles: triangles.length, hit });
    if (visual !== null || triangles.length) failures.push('center-has-authored-ground');
    if (!sameHit(hit, name === 'before' ? options.observedBefore : options.observedAfter)) failures.push('raw-query-not-reproduced');
  }
  if (failures.length) return proof;
  for (const [name, side] of sides) proof.localGround.push({ side: name, radiusMetres: .2, ...localGroundTriangles(side.groundColliders, x, z) });
  if (proof.localGround[0]!.count !== proof.localGround[1]!.count || proof.localGround[0]!.records.some((record, index) => record !== proof.localGround[1]!.records[index])) failures.push('local-authored-ground-triangles-changed');
  if (failures.length) return proof;
  const query = (px: number, pz: number) => ({ ...nativeGroundPoint(px, pz), before: options.before.world.groundBelow(Math.fround(px), options.originY, Math.fround(pz), 30), after: options.after.world.groundBelow(Math.fround(px), options.originY, Math.fround(pz), 30) });
  for (const [dx, dz] of [[-.001, 0], [.001, 0], [0, -.001], [0, .001]]) proof.cardinals.push(query(x + dx!, z + dz!));
  for (const [dx, dz] of offsets) {
    const row = query(x + dx, z + dz); proof.neighbors.push(row);
    if (!supportedHit(row.before) || !supportedHit(row.after) || !sameSurface(row.before!.surface, row.after!.surface) || Math.abs(row.before!.y - row.after!.y) > numericalBound) failures.push('off-grid-terrain-contact-changed');
  }
  for (const [name, side] of sides) {
    const hit = side.world.physics.castShape({ x, y: options.originY, z }, { x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: -1, z: 0 }, new RAPIER.Ball(.01), 0, 30, true);
    if (!hit) { failures.push('centered-shape-unsupported'); continue; }
    const surface = side.world.surfaceAt(hit.collider.handle, null), contact = hit.witness1;
    const shape = { side: name, height: options.originY - hit.time_of_impact - .01, contact, surface, identity: nativeShapeIdentity(side.world, hit.collider, surface?.group),
      groundContact: surface?.group === 'ground' ? { visual: side.visualHeight(Math.fround(contact.x), Math.fround(contact.z)), triangles: exactGroundTriangles(side.groundColliders, Math.fround(contact.x), Math.fround(contact.z)), support: [] as NonNullable<(typeof proof.shapes)[number]['groundContact']>['support'] } : null };
    proof.shapes.push(shape);
    const index = indices[name === 'before' ? 0 : 1]!, expectedHeight = side.world.terrain.heights[index.iz * side.world.terrain.nx + index.ix]! + Math.fround(-.4);
    if (!shape.identity || !Number.isFinite(shape.height) || !Object.values(shape.contact).every(Number.isFinite) ||
        hit.time_of_impact < 0 || hit.time_of_impact > 30 || shape.contact.y > options.originY || Math.hypot(shape.contact.x - x, shape.contact.z - z) > .011 ||
        Math.abs(Math.hypot(contact.x - x, contact.y - shape.height - .01, contact.z - z) - .01) > numericalBound) failures.push('centered-shape-not-preserved-terrain');
    if (surface?.group === 'terrain') {
      if (Math.abs(shape.height - expectedHeight) > numericalBound) failures.push('centered-shape-not-preserved-terrain');
    } else if (surface?.group === 'ground') {
      const visualTriangles = side.visualTrianglesNear?.(x, z, .2);
      if (!visualTriangles || visualTriangles.some(triangle => triangle.length !== 9 || !triangle.every(Number.isFinite))) failures.push('ground-shape-decoded-visual-triangles-required');
      else for (const triangle of proof.localGround[name === 'before' ? 0 : 1]!.triangles.filter(t => t.floor)) {
        const point = [contact.x, contact.y, contact.z], collision = closestTrianglePoint(point, triangle.vertices);
        if (collision.distance > numericalBound) continue;
        for (const rawVisual of visualTriangles) {
          const vertices = [Array.from(rawVisual.slice(0, 3)), Array.from(rawVisual.slice(3, 6)), Array.from(rawVisual.slice(6, 9))];
          if (!matchingTriangle(triangle.vertices, vertices)) continue;
          const visual = closestTrianglePoint(point, vertices);
          if (visual.distance <= numericalBound) shape.groundContact!.support.push({ collider: triangle.collider, triangle: triangle.triangle, collision, visual, collisionVertices: triangle.vertices, visualVertices: vertices });
        }
      }
      if (!shape.groundContact!.support.length) failures.push('ground-shape-witness-not-visually-supported');
      if (shape.groundContact!.triangles.length && (shape.groundContact!.visual === null ||
          !shape.groundContact!.triangles.some(triangle => Math.abs(triangle.height - shape.groundContact!.visual!) <= numericalBound))) failures.push('ground-witness-visual-and-collision-projections-disagree');
    } else failures.push('centered-shape-not-preserved-terrain');
  }
  if (proof.shapes.length === 2 && (!sameSurface(proof.shapes[0]!.surface, proof.shapes[1]!.surface) || proof.shapes[0]!.identity !== proof.shapes[1]!.identity || Math.abs(proof.shapes[0]!.height - proof.shapes[1]!.height) > numericalBound ||
      Math.hypot(proof.shapes[0]!.contact.x - proof.shapes[1]!.contact.x, proof.shapes[0]!.contact.y - proof.shapes[1]!.contact.y, proof.shapes[0]!.contact.z - proof.shapes[1]!.contact.z) > numericalBound)) failures.push('centered-shape-contact-changed');
  const centerHeight = options.observedBefore?.y ?? options.observedAfter!.y;
  if (proof.shapes.some(shape => shape.surface?.group === 'terrain' && Math.abs(shape.height - centerHeight) > numericalBound)) failures.push('center-ray-and-shape-disagree');
  proof.pass = failures.length === 0;
  return proof;
}
