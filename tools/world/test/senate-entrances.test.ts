import assert from 'node:assert/strict';
import test from 'node:test';
import {entranceApron, entranceCells, entranceFlight, entrancePoint, palaceEntrance, retainedBoundaryTriangles, surfaceHeight, universityEntrance, UNIVERSITY_FRAME, UNIVERSITY_FOOT_HEIGHT, UNIVERSITY_LOWER_RISE, UNIVERSITY_UPPER_RISE, type GroundTriangle} from '../lib/senate-entrances.ts';
import {encodeCollisionBundle, parseCollisionBundle} from '../../../packages/world-schema/src/index.ts';
import {patchGroundCollision} from '../lib/ground-region-patch.ts';
import type {GroundPiece} from '../lib/ground.ts';

const floor: GroundTriangle[] = [
  [[-90, 1.1293973522573535, -20], [-60, 1.1293973522573535, 30], [-60, 1.1293973522573535, -20]],
  [[-90, 1.1293973522573535, -20], [-90, 1.1293973522573535, 30], [-60, 1.1293973522573535, 30]],
];
const triangles = (pieces: readonly GroundPiece[]): GroundTriangle[] => pieces.flatMap(p => Array.from({length: p.indices.length / 3}, (_, t) => [0, 1, 2].map(k => p.positions.slice(p.indices[t * 3 + k]! * 3, p.indices[t * 3 + k]! * 3 + 3)) as unknown as GroundTriangle));
const height = (pieces: readonly GroundPiece[], along: number, across = 0) => {
  const p = entrancePoint(UNIVERSITY_FRAME, along, across, 0); return surfaceHeight(triangles(pieces), p[0], p[2]);
};
test('University has eight lower risers, level intermediate landing and two upper stages in three door bays', () => {
  const patch = universityEntrance(floor), pieces = patch.pieces;
  for (let i = 0; i < 8; i++) assert.ok(Math.abs(height(pieces, (i + .5) * .35)! - (UNIVERSITY_FOOT_HEIGHT + UNIVERSITY_LOWER_RISE * (i + 1) / 8)) < 1e-7);
  assert.equal(height(pieces, 3.1), UNIVERSITY_FOOT_HEIGHT + UNIVERSITY_LOWER_RISE);
  assert.equal(height(pieces, 3.9), UNIVERSITY_FOOT_HEIGHT + UNIVERSITY_LOWER_RISE);
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(height(pieces, 4.1 + (i + .5) * .35)! - (UNIVERSITY_FOOT_HEIGHT + UNIVERSITY_LOWER_RISE + UNIVERSITY_UPPER_RISE * (i + 1) / 8)) < 1e-7);
    for (const across of [-3.8, 0, 3.8]) assert.ok(Math.abs(height(pieces, 5.5 + (i + .5) * .35, across)! - (UNIVERSITY_FOOT_HEIGHT + UNIVERSITY_LOWER_RISE + UNIVERSITY_UPPER_RISE * (i + 5) / 8)) < 1e-7);
  }
  // The old single eight-step rectangle has neither this flat landing nor door-bay subdivision.
  const old = entranceFlight(UNIVERSITY_FRAME, 0, 5.258021393774385, 16.9, 8, UNIVERSITY_FOOT_HEIGHT, UNIVERSITY_LOWER_RISE, 'old');
  assert.notEqual(height(old, 3.1), height(old, 3.9));
  assert.ok(height(pieces, 6, 1.9)! > height(pieces, 6, 0)!, 'Column plinth separates the door bays');
});
test('Entrance patch clips exact matching Float32 station heights at the Z=0 cell seam', () => {
  const patch = universityEntrance(floor), pieces = entranceCells([patch]);
  const keys = (cell: string) => new Set(pieces.filter(p => p.cell === cell).flatMap(p => {
    const out: string[] = [];
    for (let i = 0; i < p.positions.length; i += 3) if (p.positions[i + 2] === 0) out.push(`${Math.fround(p.positions[i]!)},${Math.fround(p.positions[i + 1]!)}`);
    return out;
  }));
  const north = keys('c_m01_m01'), south = keys('c_m01_p00');
  assert.ok(north.size > 20); assert.deepEqual(north, south);
  for (const piece of pieces) {
    const [, x, z] = piece.cell.split('_'), cx = Number(x!.slice(1)) * (x![0] === 'm' ? -1 : 1), cz = Number(z!.slice(1)) * (z![0] === 'm' ? -1 : 1);
    for (let i = 0; i < piece.positions.length; i += 3) assert.ok(piece.positions[i]! >= cx * 128 - 1e-7 && piece.positions[i]! <= (cx + 1) * 128 + 1e-7 && piece.positions[i + 2]! >= cz * 128 - 1e-7 && piece.positions[i + 2]! <= (cz + 1) * 128 + 1e-7);
  }
});
test('Apron removes an interior terrain hump while preserving the original boundary support', () => {
  const source: GroundTriangle[] = [
    [[0, 0, 0], [4, 0, 0], [2, 3, 2]], [[4, 0, 0], [4, 0, 4], [2, 3, 2]],
    [[4, 0, 4], [0, 0, 4], [2, 3, 2]], [[0, 0, 4], [0, 0, 0], [2, 3, 2]],
  ];
  const apron = entranceApron(source, [0, 0, 4, 4], () => 0, 1);
  assert.equal(surfaceHeight(source, 2, 2), 3); assert.equal(surfaceHeight(triangles([apron]), 2, 2), 0);
  for (let i = 0; i <= 16; i++) for (const [x, z] of [[i / 4, 0], [i / 4, 4], [0, i / 4], [4, i / 4]]) assert.equal(surfaceHeight(triangles([apron]), x!, z!), surfaceHeight(source, x!, z!));
});
test('The exact authored support triangles also replace collision, while building collider arrays stay untouched', () => {
  const patch = universityEntrance(floor), pieces = entranceCells([patch]).filter(p => p.cell === 'c_m01_p00');
  const ground = {id: 'g:test', group: 'ground' as const, ref: null, positions: Float32Array.from(floor.flat(2)), indices: Uint32Array.from([0, 1, 2, 3, 4, 5]), triangleTags: Uint16Array.from([0, 0])};
  const building = {...ground, id: 'b:test', group: 'buildings' as const, ref: 'building'};
  const bytes = encodeCollisionBundle({originId: 'test', frame: 'X-east,Y-up,Z-south', cell: 'c_m01_p00', surfaceTags: ['old']}, [ground, building]);
  const result = parseCollisionBundle(patchGroundCollision(bytes, patch.region, pieces).bytes);
  assert.deepEqual(result.colliders[1], building);
  const collider = result.colliders[0]!, offset = collider.indices.length - pieces.reduce((n, p) => n + p.indices.length, 0), actual: GroundTriangle[] = [];
  for (let i = offset; i < collider.indices.length; i += 3) actual.push([0, 1, 2].map(k => Array.from(collider.positions.subarray(collider.indices[i + k]! * 3, collider.indices[i + k]! * 3 + 3))) as unknown as GroundTriangle);
  for (const s of [0.175, 1.225, 3.1, 4.625, 6.375, 7.2]) {
    const point = entrancePoint(UNIVERSITY_FRAME, s, -3.8, 0), visual = surfaceHeight(triangles(pieces), point[0], point[2]), physical = surfaceHeight(actual, point[0], point[2]);
    assert.ok(visual !== null && physical !== null && Math.abs(visual - physical) < 1e-5);
  }
});
test('University cheek blocks stop only 20cm above the lower landing and wall UV courses stay horizontal', () => {
  const patch = universityEntrance(floor), cheeks = patch.pieces.filter(p => p.tag === 'entrance:university-cheek');
  assert.equal(cheeks.length, 2);
  for (const piece of cheeks) {
    assert.ok(Math.abs(Math.max(...piece.positions.filter((_, i) => i % 3 === 1)) - (UNIVERSITY_FOOT_HEIGHT + UNIVERSITY_LOWER_RISE + .2)) < 1e-8);
    for (let i = 4; i < piece.positions.length / 3; i += 4) {
      assert.equal(piece.positions[i * 3 + 1], piece.positions[(i + 1) * 3 + 1]);
      assert.ok(Math.abs(piece.uvs[i * 2 + 1]! - piece.uvs[(i + 1) * 2 + 1]!) < 1e-12, 'Equal-height stone wall corners must share V');
    }
  }
});
test('Palace five north and seven south steps rise east to one level terrace, with no central stairs', () => {
  const y = (z: number) => -.78 - .027 * z;
  const source: GroundTriangle[] = [
    [[70, y(-30), -30], [90, y(30), 30], [90, y(-30), -30]], [[70, y(-30), -30], [70, y(30), 30], [90, y(30), 30]],
  ];
  const patch = palaceEntrance(source), rows = patch.pieces;
  assert.equal(rows.filter(p => p.tag === 'entrance:palace-north').length, 5);
  assert.equal(rows.filter(p => p.tag === 'entrance:palace-south').length, 7);
  assert.ok(!rows.some(p => /palace-central/.test(p.tag)));
  for (const tag of ['entrance:palace-north', 'entrance:palace-south']) {
    const flight = rows.filter(p => p.tag === tag), heights = flight.map(p => Math.max(...p.positions.filter((_, i) => i % 3 === 1)));
    assert.ok(heights.every((h, i) => i === 0 || h > heights[i - 1]!));
    const first = flight[0]!, last = flight.at(-1)!;
    assert.ok(last.positions[0]! > first.positions[0]!, 'Ascent must face east, opposite to the rejected terrain-derived flight');
    assert.ok(Math.abs(heights.at(-1)! - (patch.observations.terraceHeight as number)) < 1e-8);
  }
  assert.equal(rows.filter(p => p.tag === 'entrance:palace-grille').length, 3);
  const wall = rows.find(p => p.tag === 'entrance:palace-retaining-terrace')!;
  const top = patch.observations.terraceHeight as number;
  assert.ok(wall.positions.slice(0, 12).filter((_, i) => i % 3 === 1).every(h => h === top));
  for (const tag of ['entrance:palace-north-landing', 'entrance:palace-south-landing']) {
    const landing = rows.find(p => p.tag === tag)!;
    assert.ok(landing.positions.slice(0, 12).filter((_, i) => i % 3 === 1).every(h => h === top));
  }
});
test('Nonplanar boundary stations survive XY-collinear triangulation and close the exterior floor', () => {
  const source: GroundTriangle[] = [
    [[0, 0, 0], [.37, .7, 0], [1, 0, 1]], [[.37, .7, 0], [2, 0, 0], [1, 0, 1]],
    [[2, 0, 0], [2, 0, 2], [1, 0, 1]], [[2, 0, 2], [0, 0, 2], [1, 0, 1]], [[0, 0, 2], [0, 0, 0], [1, 0, 1]],
  ];
  const apron = entranceApron(source, [0, 0, 2, 2], () => 0, .5);
  for (const x of [.1, .2, .37, .6, .9, 1.2, 1.8]) assert.ok(Math.abs(surfaceHeight(triangles([apron]), x, 0)! - surfaceHeight(source, x, 0)!) < 1e-9);
  assert.ok(retainedBoundaryTriangles([[0, 0], [.37, 0], [1, 0], [1, 1], [0, 1]]).includes(1), 'The XY-collinear station must remain referenced');
});
test('Palace perimeter replaces the reported south wedges and has one floor on each side of the surveyed curb', () => {
  const y = (z: number) => -.78 - .027 * z;
  const plain: GroundTriangle[] = [
    [[65, y(-30), -30], [90, y(30), 30], [90, y(-30), -30]], [[65, y(-30), -30], [65, y(30), 30], [90, y(30), 30]],
  ];
  const road = plain.map(triangle => triangle.map(p => [p[0], p[1] - .12, p[2]]) as unknown as GroundTriangle);
  const bad: GroundTriangle[] = [...plain, [[74, .3, 8], [76, .3, 8], [75, .3, 10]]];
  const patch = palaceEntrance(bad, road), floor = triangles(patch.pieces.filter(p => /palace-(?:apron|road)$/.test(p.tag)));
  for (const [x, z] of [[75.2867455, 8.4919174], [74.8387049, 9.0900548]]) {
    assert.ok(surfaceHeight(bad, x!, z!)! > y(z!) + .3, 'Negative control must reproduce a source hump');
    assert.ok(Math.abs(surfaceHeight(floor, x!, z!)! - y(z!)) < 1e-9);
  }
  const z = .3309114, curbX = 72.0137 + (73.2961 - 72.0137) * (z + 19.0312) / (12.7909 + 19.0312);
  assert.ok(Math.abs(surfaceHeight(floor, curbX + .002, z)! - y(z)) < 1e-9);
  assert.ok(Math.abs(surfaceHeight(floor, curbX - .002, z)! - (y(z) - .12)) < 1e-9);
  assert.equal(patch.pieces.filter(p => p.tag === 'entrance:palace-perimeter-ramp').length, 2);
});
