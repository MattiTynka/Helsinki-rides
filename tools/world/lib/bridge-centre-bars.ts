// Offline migration for the exact raised centre bars emitted by the former bridge recipe.
// Reconstruct their source triangles so deletion cannot select another steel rail or road face.
import assert from 'node:assert/strict';
import type {Document} from '@gltf-transform/core';
import {encodeCollisionBundle, parseCollisionBundle} from '../../../packages/world-schema/src/index.ts';
import {bridgeLengths, bridgeSection, bridgeWorldPoint, splitBridgeFaces, type BridgeFace, type ReconstructedBridge} from './bridge-reconstruction.ts';
import {supportNormal, type SupportTriangle, type SupportVertex} from './tram-support-repair.ts';
import type {GroundIndexEdit} from './reuse-ground-glb.ts';

export const centreBarTriangleKey = (points: readonly (readonly number[])[]) => points.map(p => p.map(Math.fround).join(',')).sort().join('|');
export function centreBarKeyCounts(faces: readonly BridgeFace[]): Map<string, number> {
  const keys = new Map<string, number>();
  for (const face of faces) {const key = centreBarTriangleKey(face.points); keys.set(key, (keys.get(key) ?? 0) + 1);}
  return keys;
}
const f32 = (p: readonly number[]): SupportVertex => [Math.fround(p[0]!), Math.fround(p[1]!), Math.fround(p[2]!)];

/** Migration-only reproduction of the removed boxes, including original winding before cell clipping. */
export function legacyBridgeCentreBars(bridge: ReconstructedBridge, coarse = false): BridgeFace[] {
  assert.equal(bridge.kind, 'two-level-composite');
  const faces: BridgeFace[] = [], length = bridgeLengths(bridge).at(-1)!;
  const cuts = new Set([...bridgeLengths(bridge), bridge.architectureStartMetres, bridge.architectureEndMetres]);
  if (bridge.approachMetres) {cuts.add(bridge.approachMetres); cuts.add(length - bridge.approachMetres);}
  for (let s = 0; s < length; s += 1) cuts.add(s); cuts.add(length);
  const steps = [...cuts].sort((a, b) => a - b);
  const quad = (points: SupportVertex[], outward: number[]) => {
    for (let i = 1; i < points.length - 1; i++) {
      let triangle: SupportTriangle = [points[0]!, points[i]!, points[i + 1]!];
      let normal: SupportVertex; try {normal = supportNormal(triangle);} catch {continue;}
      if (normal.reduce((sum, v, k) => sum + v * outward[k]!, 0) < 0) triangle = [triangle[0], triangle[2], triangle[1]];
      const wall = Math.abs(normal[1]) < .6;
      const uvs = triangle.map(p => wall ? [Math.hypot(p[0] - bridge.stations[0]!.x, p[2] - bridge.stations[0]!.z) / 4, p[1] / 2] : [p[0] / 4, p[2] / 4]) as BridgeFace['uvs'];
      faces.push({points: triangle, material: 'steel', role: 'railing', collision: true, uvs});
    }
  };
  for (let i = 0; i < steps.length - 1; i++) {
    const s0 = steps[i]!, s1 = steps[i + 1]!;
    if (s0 < bridge.architectureStartMetres || s1 > bridge.architectureEndMetres) continue;
    const q0 = bridgeSection(bridge, s0), q1 = bridgeSection(bridge, s1), q = bridgeSection(bridge, (s0 + s1) / 2);
    for (const sign of [-1, 1]) {
      const t0 = sign * .45 - .04, t1 = sign * .45 + .04;
      const a = bridgeWorldPoint(bridge, s0, t0, q0.roadY + .5), c = bridgeWorldPoint(bridge, s0, t1, q0.roadY + .5);
      const d = bridgeWorldPoint(bridge, s1, t1, q1.roadY + .5), e = bridgeWorldPoint(bridge, s1, t0, q1.roadY + .5);
      const top = (p: SupportVertex) => f32([p[0], p[1] + .12, p[2]]), A = top(a), C = top(c), D = top(d), E = top(e);
      const continuous = coarse && s1 - s0 > .1;
      quad([A, C, D, E], [0, 1, 0]); quad([e, d, c, a], [0, -1, 0]);
      if (!continuous || s0 === bridge.architectureStartMetres) quad([a, c, C, A], [-q.d[0], 0, -q.d[1]]);
      if (!continuous || s1 === bridge.architectureEndMetres) quad([e, E, D, d], [q.d[0], 0, q.d[1]]);
      quad([a, A, E, e], [-q.n[0], 0, -q.n[1]]); quad([c, d, D, C], [q.n[0], 0, q.n[1]]);
    }
  }
  return faces;
}

export function legacyCentreBarCells(bridge: ReconstructedBridge, coarse = false) {
  return new Map([...splitBridgeFaces(legacyBridgeCentreBars(bridge, coarse))].map(([cell, faces]) => [cell, centreBarKeyCounts(faces)]));
}
function assertExactMatches(expected: ReadonlyMap<string, number>, actual: ReadonlyMap<string, number>): number {
  assert.deepEqual([...actual].sort(), [...expected].sort(), 'Generated centre-bar triangles must match the payload exactly, including duplicates');
  return [...actual.values()].reduce((sum, n) => sum + n, 0);
}

export function planCentreBarVisualRemoval(doc: Document, expected: ReadonlyMap<string, number>, coarse: boolean) {
  const edits: GroundIndexEdit[] = [], found = new Map<string, number>(), primitives: {node: string; primitive: number; removedTriangles: number}[] = [];
  for (const node of doc.getRoot().listNodes()) for (const [index, primitive] of (node.getMesh()?.listPrimitives() ?? []).entries()) {
    const positions = primitive.getAttribute('POSITION'), indices = primitive.getIndices(); if (!positions || !indices) continue;
    const kept: number[] = []; let removed = 0;
    for (let i = 0; i < indices.getCount(); i += 3) {
      const ids = [0, 1, 2].map(k => indices.getScalar(i + k)), key = centreBarTriangleKey(ids.map(id => positions.getElement(id, [])));
      if (expected.has(key)) {found.set(key, (found.get(key) ?? 0) + 1); removed++;} else kept.push(...ids);
    }
    if (!removed) continue;
    assert.equal(primitive.getMode(), 4);
    assert.deepEqual(node.getWorldMatrix(), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    if (!coarse) {assert.ok(node.getName().endsWith('_bridge_architecture_steel')); assert.equal(primitive.getMaterial()?.getName(), 'bridge-original-steel');}
    edits.push({nodeName: node.getName(), primitiveIndex: index, indices: Uint32Array.from(kept)});
    primitives.push({node: node.getName(), primitive: index, removedTriangles: removed});
  }
  const removedTriangles = assertExactMatches(expected, found);
  return {edits, proof: {removedTriangles, distinctTriangleKeys: found.size, primitives, retainedIndicesLiteral: true}};
}

export function countCentreBarVisualTriangles(doc: Document, keys: ReadonlyMap<string, number>): number {
  let count = 0;
  for (const node of doc.getRoot().listNodes()) for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
    const positions = primitive.getAttribute('POSITION'), indices = primitive.getIndices(); if (!positions || !indices) continue;
    for (let i = 0; i < indices.getCount(); i += 3) if (keys.has(centreBarTriangleKey([0, 1, 2].map(k => positions.getElement(indices.getScalar(i + k), []))))) count++;
  }
  return count;
}

export function removeCentreBarCollision(bytes: Uint8Array, expected: ReadonlyMap<string, number>) {
  const source = parseCollisionBundle(bytes), found = new Map<string, number>(), rows: {collider: string; removedTriangles: number}[] = [];
  const colliders = source.colliders.map(c => {
    const indices: number[] = [], tags: number[] = []; let removed = 0;
    for (let t = 0; t < c.indices.length / 3; t++) {
      const ids = Array.from(c.indices.subarray(t * 3, t * 3 + 3)), key = centreBarTriangleKey(ids.map(id => Array.from(c.positions.subarray(id * 3, id * 3 + 3))));
      if (expected.has(key)) {found.set(key, (found.get(key) ?? 0) + 1); removed++;} else {indices.push(...ids); tags.push(c.triangleTags[t]!);}
    }
    if (!removed) return c;
    assert.equal(c.group, 'props'); assert.ok(c.id.startsWith('bridge-reconstruction:'));
    rows.push({collider: c.id, removedTriangles: removed});
    return {...c, indices: Uint32Array.from(indices), triangleTags: Uint16Array.from(tags)};
  });
  const removedTriangles = assertExactMatches(expected, found), result = encodeCollisionBundle(source.header, colliders), after = parseCollisionBundle(result);
  assert.deepEqual(after.header.surfaceTags, source.header.surfaceTags);
  assert.equal(after.colliders.length, source.colliders.length);
  for (const [i, c] of colliders.entries()) assert.deepEqual(after.colliders[i], c, 'Retained collision positions, indices, tags and collider metadata must be literal');
  assert.equal(countCentreBarCollisionTriangles(result, expected), 0, 'Centre-bar collision remains');
  return {bytes: result, proof: {removedTriangles, distinctTriangleKeys: found.size, colliders: rows,
    allPositionArraysLiteral: true, retainedIndicesAndTriangleTagsLiteral: true, unrelatedCollidersLiteral: true}};
}

export function countCentreBarCollisionTriangles(bytes: Uint8Array, keys: ReadonlyMap<string, number>): number {
  let count = 0;
  for (const c of parseCollisionBundle(bytes).colliders) for (let i = 0; i < c.indices.length; i += 3) {
    if (keys.has(centreBarTriangleKey([0, 1, 2].map(k => {const id = c.indices[i + k]!; return Array.from(c.positions.subarray(id * 3, id * 3 + 3));})))) count++;
  }
  return count;
}
